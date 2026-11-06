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
    hint: '提示词最前面插入一段「使用规范」（违法违规 / 攻击性内容礼貌拒绝），工具描述压到 200 字、历史预算约 48k；同账号严格串行、发送间隔至少 4 秒。更不容易触发站点风控与禁言。',
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

/** 同一账号两次请求的间隔；保险模式有 4 秒下限，抖动也更长（更像真人） */
export function gapFor(baseMs, mode) {
  const safe = isSafe(mode);
  const base = Math.max(0, Number(baseMs) || 0);
  const gap = Math.max(base, safe ? 4000 : 0);
  const jitter = safe ? 1 + Math.random() * 0.6 : 0.8 + Math.random() * 0.4;
  // 只做「间隔抖动」，不额外插随机长停顿：长尾节奏交给滚动窗口限速和连续轮次长休
  // （那两处是真正对付账号级限流的地方，也不会让每次回复莫名多等几秒）。
  return Math.round(gap * jitter);
}

/**
 * 滚动窗口限速（参考 dsh-deepseek-web-login 的做法）：
 * 小间隔洗不掉「十分钟发了二十次」这种计数，账号级静默限流多半就是撞在这上面。
 * 超出窗口就等下一次空位，宁可用户多等几秒，也别把账号打进冷却。
 */
export function rateWindowFor(mode) {
  return isSafe(mode) ? { windowMs: 10 * 60 * 1000, max: 8 } : { windowMs: 10 * 60 * 1000, max: 16 };
}

/** 连续请求多少轮后插一次长休；长休区间（毫秒） */
export const LONG_RUN_THRESHOLD = 10;
export function longRestFor() {
  return { min: 25000, max: 70000 };
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
    ? '回复以 JSON 对象承载：content 写正文（或 null），tool_calls 写工具调用及其 arguments。调用工具时 arguments 要含全部必填参数，类型按 tools 的 schema（数字/布尔用裸值）；不需要工具就不写 tool_calls。不要代码块，不要额外说明。'
    : '你是 OpenAI 兼容服务端。正常回答直接给正文；需要调用工具时只输出：@@TOOL@@\n{"name":"工具名","arguments":{}}\n@@END@@';
  return {
    role: 'system',
    content: isSafe(mode) ? base + '输出前先自检：内容不得违反上面的使用规范。' : base,
  };
}
