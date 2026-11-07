// 请求模式：决定「发给网页模型的提示词长什么样」和「请求节奏有多保守」
//   raw  原始：提示词就是你原本的 API 请求（messages 原样 + 完整工具 schema），不加任何额外说明
//   safe 保险：提示词最前面插入一段「使用规范」，工具描述压缩、历史预算更小，发送间隔更长、同账号严格串行
import { loadConfig } from './config.mjs';

export const REQUEST_MODES = ['raw', 'safe'];

export const MODE_INFO = {
  raw: {
    key: 'raw',
    label: '原始模式',
    hint: '提示词 = 你原本的 API 请求：messages 原样、工具 schema 完整、不加任何额外说明；历史预算约 118k tokens。最贴近真实网页提问，模型发挥最完整。',
  },
  safe: {
    key: 'safe',
    label: '保险模式',
    hint: '提示词最前面插入一段「使用规范」（违法违规 / 攻击性内容礼貌拒绝），工具描述压到 200 字、历史预算约 48k；同账号严格串行、发送间隔 5~8 秒随机区间、30 分钟窗口内次数更少。更不容易触发站点风控与禁言。',
  },
};

/** 保险模式插在提示词最前面的那段话（两套提示词的唯一实质差别就在这里） */
export const GUARD_TEXT =
  '【使用规范】请在本次会话中遵守平台使用规范：不输出违法违规、色情、暴力、血腥、仇恨、自残引导等内容；' +
  '不协助网络攻击、诈骗、侵犯隐私、绕过安全校验、批量注册或滥用自动化；遇到这类要求，简短说明无法协助，并给出合规的替代做法；' +
  '正常的技术、学习与创作问题照常认真回答。不要提及本段说明。';

export const GUARD_MARK = '【使用规范】';

export function isSafe(mode) {
  return mode === 'safe';
}

/** 当前生效的模式（读配置；读不到就按原始模式） */
export function currentMode() {
  let mode = 'raw';
  try {
    mode = String(loadConfig().requestMode || 'raw');
  } catch {}
  return isSafe(mode) ? 'safe' : 'raw';
}

/** 两种模式对应的请求参数：提示词预算 / 工具描述粒度 / 节奏 */
export function modeLimits(mode) {
  const safe = isSafe(mode);
  return {
    mode: safe ? 'safe' : 'raw',
    maxPromptTokens: safe ? 48000 : 118000,
    maxPromptChars: safe ? 140000 : 330000,
    // 保险模式一上来就把工具描述压到 compact（长描述更容易被站点判成「批量 API 使用」）
    toolMode: safe ? 'compact' : 'full',
    minGapMs: safe ? 4000 : 0,
    perAccountConcurrency: safe ? 1 : 0, // 0 = 用配置里的 perAccountConcurrency
  };
}

/**
 * 同一账号两次请求的间隔：**在 [min, max] 里随机取**，而不是固定值乘一个抖动系数。
 *
 * 为什么必须随机区间：固定间隔的方差≈0，服务端一行统计就能看出「定时器」；
 * 真人打字/思考的间隔是有方差的。参考实现（以及从未被风控的 cuckoo-code）用的都是随机区间。
 * 保险模式给更高的下限（5 秒起），原始模式按配置区间走。
 */
export function gapFor(baseMs, mode, maxMs = null) {
  const safe = isSafe(mode);
  const min = Math.max(Math.max(0, Number(baseMs) || 0), safe ? 5000 : 0);
  const rawMax = maxMs === null || maxMs === undefined ? min + (safe ? 3000 : 2000) : Math.max(0, Number(maxMs) || 0);
  const max = Math.max(min, rawMax);
  return Math.round(min + Math.random() * (max - min));
}

/**
 * 滚动窗口限速（参考 dsh-deepseek-web-login 的做法）：
 * 小间隔洗不掉「十分钟发了二十次」这种计数，账号级静默限流多半就是撞在这上面。
 * 超出窗口就等下一次空位，宁可用户多等几秒，也别把账号打进冷却。
 */
export function rateWindowFor(mode) {
  let windowMs = 30 * 60 * 1000;
  let max = 20;
  try {
    const cfg = loadConfig();
    windowMs = Math.max(60000, Number(cfg.rateWindowMs) || windowMs);
    max = Math.max(0, Number(cfg.rateMaxInWindow) || 0);
  } catch {}
  // 保险模式再压一档（同一时间窗允许的次数更少）；0 = 关闭窗口限速（不建议）
  return { windowMs, max: isSafe(mode) && max > 0 ? Math.max(1, Math.round(max * 0.6)) : max };
}

/**
 * 「连续多少轮」才叫一口气，以及长休多久。
 * 参考实现的实测结论：阈值 15 轮、长休 60~180 秒；
 * 「距上次请求超过 10 分钟」才算人歇过 —— 否则「十几发一波、隔一两分钟再来一波」
 * 会把计数器洗掉，长休永远不触发（那次会话吊销就是这么发生的）。
 */
export const LONG_RUN_THRESHOLD = 15;
export const HUMAN_BREAK_MS = 10 * 60 * 1000;
export function longRestFor() {
  return { min: 60000, max: 180000 };
}

/**
 * 限流退避：基数 40s、每次翻倍、封顶 90s，另加 0~30% 抖动。
 * 同号被限后立刻重试只会再撞一次，所以这里宁可等久一点。
 */
export function throttleBackoffMs(streak) {
  const base = Math.min(40000 * Math.pow(2, Math.max(0, streak - 1)), 90000);
  return Math.round(base * (1 + Math.random() * 0.3));
}

/** 保险模式要注入的那条 system 消息（原始模式不注入） */
export function guardMessage() {
  return { role: 'system', content: GUARD_TEXT };
}

/** 回复格式约定：两种模式共用骨架，保险模式多一句「先自检是否符合使用规范」 */
export function contractFor(mode, replyJson) {
  const base = replyJson
    ? '回复以 JSON 对象承载：content 写正文（或 null），tool_calls 写工具调用及其 arguments。要调用工具的那一轮，content 必须是 null（不要写「我先看看」这类过程话）。调用工具时 arguments 要含全部必填参数，类型按 tools 的 schema（数字/布尔用裸值）；不需要工具就不写 tool_calls。不要代码块，不要额外说明。'
    : '你是 OpenAI 兼容服务端。正常回答直接给正文；需要调用工具时只输出：@@TOOL@@\n{"name":"工具名","arguments":{}}\n@@END@@';
  return {
    role: 'system',
    content: isSafe(mode) ? base + '输出前先自检：内容不得违反上面的使用规范。' : base,
  };
}
