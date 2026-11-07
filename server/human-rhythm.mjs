// 人类节律：把「等距定时器」变成「有作息、要打字、偶尔走神的人」。
//
// 为什么单独一层：TLS 指纹只解决「像不像浏览器」，账号级风控的主判据是行为 ——
// 24 小时均匀发包、长提示词秒发、连续几十轮不停、凌晨三点还在高频活跃，
// 这些统计特征比指纹更容易被一行 SQL 揪出来。
//
// 这一层只做三件可解释的事（不做玄学）：
//   1) 打字时间：间隔随「这次要发多少字」变长（真人不会 2000 字一秒打完）；
//   2) 作息曲线：凌晨的间隔被拉长（真人要睡觉），白天/晚间恢复正常；
//   3) 走神：小概率插入一次长时间停顿（真人会去看别的窗口）。
//   再叠加每日上限：真人有「今天问够了」的边界，机器没有。
import fs from 'node:fs';
import path from 'node:path';
import { STATE_DIR } from './config.mjs';

export const BUDGET_FILE = path.join(STATE_DIR, 'human-budget.json');

// 打字速度：中文输入法 2.5~5 字/秒（含选词、改错）。取 3.4 字/秒为中心。
const CPS_MIN = 2.6;
const CPS_MAX = 4.8;
// 发出去之前的「读一遍再点发送」停顿
const PRE_SEND_MIN = 700;
const PRE_SEND_MAX = 2600;
// 单次打字时间封顶：再长的提示词也不该等几分钟（那是刻意慢，反而假）
const TYPING_CAP = 45000;

/** 本地小时（浮点），tzOffsetMin = 相对 UTC 的分钟偏移（东八区 = 480） */
export function localHour(now = Date.now(), tzOffsetMin = null) {
  const offset = tzOffsetMin === null || tzOffsetMin === undefined ? -new Date(now).getTimezoneOffset() : Number(tzOffsetMin);
  const t = (now + offset * 60000) / 3600000;
  return ((t % 24) + 24) % 24;
}

/**
 * 作息系数：<1 表示「这个点人应该没什么活动」→ 间隔要被放大；>1 表示活跃时段。
 * 用分段线性插值，形状依据常见作息：凌晨 3~5 点最低，上午 9~11、晚间 20~23 最高。
 */
export function circadianFactor(now = Date.now(), tzOffsetMin = null) {
  const h = localHour(now, tzOffsetMin);
  const points = [
    [0, 0.55], [3, 0.34], [5, 0.4], [7, 0.7], [9, 1.15], [11.5, 1.25],
    [13, 0.95], [14.5, 1.0], [17, 0.95], [19, 1.1], [21.5, 1.3], [23, 0.85], [24, 0.55],
  ];
  for (let i = 0; i < points.length - 1; i++) {
    const [h0, v0] = points[i];
    const [h1, v1] = points[i + 1];
    if (h >= h0 && h <= h1) return v0 + ((v1 - v0) * (h - h0)) / (h1 - h0 || 1);
  }
  return 1;
}

/** 深夜静默时段：01:00~06:30 —— 真人基本不在这个点连续提问 */
export function isQuietHour(now = Date.now(), tzOffsetMin = null) {
  const h = localHour(now, tzOffsetMin);
  return h >= 1 && h < 6.5;
}

/** 打这么多字要多久（毫秒）。确定性可测：给出 rng 就是可复现的。 */
export function typingMs(chars, rng = Math.random) {
  const n = Math.max(0, Number(chars) || 0);
  if (n <= 0) return 0;
  const cps = CPS_MIN + rng() * (CPS_MAX - CPS_MIN);
  const pre = PRE_SEND_MIN + rng() * (PRE_SEND_MAX - PRE_SEND_MIN);
  return Math.min(TYPING_CAP, Math.round((n / cps) * 1000 + pre));
}

/** 走神停顿：默认 5% 概率，8~75 秒。 */
export function distractionMs(rng = Math.random, p = 0.05) {
  if (rng() >= p) return 0;
  return Math.round(8000 + rng() * 67000);
}

/**
 * 一次发送前应该等多久。
 * baseGapMs 是「随机区间」那一层的取值（已经保证不是固定值），这里只做人类化叠加：
 *   最终 = baseGap × 作息放大 + 打字时间 + 走神停顿
 * 返回 breakdown 便于在日志/界面上说清「为什么等了这么久」。
 */
export function humanGapPlan({ baseGapMs = 0, promptChars = 0, nightQuiet = true, rng = Math.random, now = Date.now(), tzOffsetMin = null } = {}) {
  const base = Math.max(0, Number(baseGapMs) || 0);
  const factor = circadianFactor(now, tzOffsetMin);
  const quiet = nightQuiet && isQuietHour(now, tzOffsetMin);
  // 作息：间隔按 1/factor 放大；深夜再额外乘一档（人要睡觉，凌晨高频是最刺眼的机器特征）
  const nightMul = quiet ? 2.6 : 1;
  const baseAdj = Math.round(base * (1 / Math.max(0.2, factor)) * nightMul);
  const typing = typingMs(promptChars, rng);
  const distraction = distractionMs(rng);
  return {
    ms: baseAdj + typing + distraction,
    factor: Math.round(factor * 100) / 100,
    quiet,
    base: baseAdj,
    typing,
    distraction,
  };
}

// ---- 每日上限（按账号，跨重启持久化）----
function readBudget() {
  try {
    const doc = JSON.parse(fs.readFileSync(BUDGET_FILE, 'utf8'));
    return doc && typeof doc === 'object' && doc.accounts && typeof doc.accounts === 'object' ? doc : { accounts: {} };
  } catch {
    return { accounts: {} };
  }
}

function writeBudget(doc) {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
    const tmp = BUDGET_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(doc), { mode: 0o600 });
    fs.renameSync(tmp, BUDGET_FILE);
  } catch {}
}

/** 最近 24 小时该账号发了多少条（滑动窗口，不是自然日 —— 跨零点不该清零） */
export function recentSends(accountId, now = Date.now()) {
  const doc = readBudget();
  const list = (doc.accounts[accountId] || []).filter((t) => Number.isFinite(t) && now - t < 24 * 3600 * 1000);
  return list;
}

/**
 * 检查每日上限。limit<=0 = 关闭。
 * 返回 { ok, used, limit, oldest }：ok=false 表示「今天该歇了」。
 */
export function checkDailyBudget(accountId, limit, now = Date.now()) {
  const used = recentSends(accountId, now).length;
  const lim = Math.max(0, Number(limit) || 0);
  if (!lim) return { ok: true, used, limit: 0 };
  return { ok: used < lim, used, limit: lim };
}

/** 记一次发送（在真正发出时调，不是排队时） */
export function recordHumanSend(accountId, now = Date.now()) {
  const doc = readBudget();
  const list = (doc.accounts[accountId] || []).filter((t) => Number.isFinite(t) && now - t < 24 * 3600 * 1000);
  list.push(now);
  // 顺手清掉 24 小时前的记录，文件不会无限长
  doc.accounts[accountId] = list.slice(-500);
  writeBudget(doc);
  return list.length;
}

/** 测试用：清空某账号记录 */
export function resetBudget(accountId) {
  const doc = readBudget();
  if (accountId) delete doc.accounts[accountId];
  else doc.accounts = {};
  writeBudget(doc);
}
