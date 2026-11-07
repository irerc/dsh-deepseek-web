// 登录后的「热身闲聊」：新账号第一次发消息之前，先像人一样随便聊两句。
//
// 为什么做这件事：一个刚登录就直奔工具调用的账号，在服务端看是「登录→立刻高频结构化请求」；
// 而人的习惯通常是先问声好、聊一两句、再谈正事。两句闲聊改变不了自动化访问的性质，
// 但它让「这个账号的前几条消息」看起来像人，不像脚本的第一次握手。
//
// 边界：
//   - 只在该账号「从未用过」时做一次（记 warmupAt，之后不再触发）；
//   - 走和正常对话完全相同的出站路径与人类节律（间隔、打字时长、每日上限都照算）；
//   - 闲聊内容不落盘、不进会话复用，用一次就丢；
//   - 失败不阻塞真实请求（记日志、标记跳过），避免热身把主流程拖死。
const PHRASES = [
  '你好呀',
  '在吗，随便聊聊',
  '今天有点累，你呢',
  '刚忙完，歇一会儿',
  '最近有什么好玩的事吗',
  '帮我推荐一部适合睡前看的电影吧',
  '晚上吃什么好呢',
  '你平时喜欢做什么',
  '有点无聊，陪我聊两句',
  '今天天气还不错',
  '你最喜欢哪座城市',
  '突然想喝奶茶了',
];

/** 挑 count 句不重复的闲聊（rng 可注入，便于测试） */
export function pickWarmupPhrases(count = 2, rng = Math.random) {
  const n = Math.max(0, Math.min(PHRASES.length, Number(count) || 0));
  const pool = PHRASES.slice();
  const out = [];
  for (let i = 0; i < n; i++) {
    const idx = Math.floor(rng() * pool.length);
    out.push(pool.splice(idx, 1)[0]);
  }
  return out;
}

/** 这个账号要不要热身（用过的不再假装） */
export function warmupNeeded(account, cfg = {}) {
  if (!account) return false;
  if (cfg.warmup === false) return false;
  if (account.warmupAt) return false;
  if (account.muted || account.banned) return false;
  if (account.status && account.status !== 'ok') return false;
  return true;
}
