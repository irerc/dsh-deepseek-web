// 调用台账：按天滚动的 jsonl，用来回答「节流到底有没有生效」
//
// 定位是**旁路设施**：写失败、读失败一律吞掉，绝不能因为它影响正常对话。
// 记录口径（与参考实现一致）：
//   at   本次调用结束时刻（Date.now）
//   ms   本次调用耗时
//   ok   是否成功
//   code 失败分类码（RATE_LIMIT / AUTH / TRANSPORT / TIMEOUT / ABORTED / UPSTREAM …）
//   accountId 真正上游用的账号；purpose 目前只有 'chat'
import fs from 'node:fs';
import path from 'node:path';
import { STATE_DIR, ensureStateDir } from './config.mjs';

const LEDGER_DIR = path.join(STATE_DIR, 'ledger');
const DAY_LIMIT = 2 * 1024 * 1024; // 单日文件软上限，异常时别把磁盘写爆
export const DEFAULT_KEEP_DAYS = 7;

function dayFile(at) {
  const d = new Date(at);
  const stamp = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  return path.join(LEDGER_DIR, stamp + '.jsonl');
}

function listDayFiles() {
  try {
    return fs.readdirSync(LEDGER_DIR).filter((name) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(name)).sort();
  } catch {
    return [];
  }
}

/** 追加一条记录。永不抛错 */
export function noteCall(entry) {
  try {
    const at = Number(entry?.at) || Date.now();
    ensureStateDir();
    fs.mkdirSync(LEDGER_DIR, { recursive: true, mode: 0o700 });
    const file = dayFile(at);
    try {
      if (fs.statSync(file).size > DAY_LIMIT) return;
    } catch {}
    const row = {
      at,
      ms: Math.max(0, Math.round(Number(entry.ms) || 0)),
      ok: Boolean(entry.ok),
      purpose: entry.purpose === 'chat' ? 'chat' : 'other',
      accountId: entry.accountId ? String(entry.accountId) : '',
      code: entry.code ? String(entry.code).slice(0, 40) : '',
      throttled: Boolean(entry.throttled),
      muted: Boolean(entry.muted),
    };
    fs.appendFileSync(file, JSON.stringify(row) + '\n', 'utf8');
  } catch {}
}

/** 删掉超过保留期的台账文件 */
export function pruneLedger(keepDays = DEFAULT_KEEP_DAYS) {
  const cutoff = Date.now() - Math.max(1, keepDays) * 86400000;
  let removed = 0;
  for (const name of listDayFiles()) {
    const at = Date.parse(name.replace(/\.jsonl$/, '') + 'T00:00:00');
    if (!Number.isFinite(at) || at >= cutoff) continue;
    try {
      fs.rmSync(path.join(LEDGER_DIR, name), { force: true });
      removed += 1;
    } catch {}
  }
  return removed;
}

function readEntries(sinceMs) {
  const out = [];
  for (const name of listDayFiles()) {
    const dayEnd = Date.parse(name.replace(/\.jsonl$/, '') + 'T23:59:59.999');
    if (Number.isFinite(dayEnd) && dayEnd < sinceMs) continue;
    let text = '';
    try {
      text = fs.readFileSync(path.join(LEDGER_DIR, name), 'utf8');
    } catch {
      continue;
    }
    for (const line of text.split('\n')) {
      if (!line) continue;
      try {
        const parsed = JSON.parse(line);
        if (Number.isFinite(parsed?.at) && parsed.at >= sinceMs) out.push(parsed);
      } catch {}
    }
  }
  out.sort((a, b) => a.at - b.at);
  return out;
}

/** 失败分类：语义错误码翻成人话，同类合并 */
export function failureBucket(entry) {
  if (!entry || entry.ok) return '';
  if (entry.muted) return '账号被限制';
  if (entry.throttled || entry.code === 'RATE_LIMIT' || entry.code === 'RATE_LIMITED_NO_SWITCH') return '限流（发太频繁）';
  if (entry.code === 'AUTH' || entry.code === 'AUTH_EXPIRED_NO_SWITCH' || entry.code === 'MISSING_CREDENTIAL') return '登录态问题';
  if (entry.code === 'TRANSPORT' || entry.code === 'TIMEOUT') return '网络 / 超时';
  if (entry.code === 'CONTEXT_WINDOW_EXCEEDED') return '上下文超限';
  if (entry.code === 'ABORTED') return '被取消';
  return entry.code ? '其它（' + entry.code + '）' : '其它';
}

function percentile(sorted, ratio) {
  if (!sorted.length) return 0;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.round((sorted.length - 1) * ratio)))];
}

/**
 * 汇总最近 hours 小时。
 * - 间隔只统计对话类、且按账号分组：跨账号算间隔没有意义；
 * - 本期开始时刻 = at - ms，等待 = 本次开始 - 上次结束（失败的调用也计入）；
 * - hours 取整并夹到 1–72（路由只 clamp 不取整会踩 Array(hours) 的 RangeError）。
 */
export function summarizeLedger(input = 24) {
  const hours = Number.isFinite(Number(input)) ? Math.min(72, Math.max(1, Math.floor(Number(input)))) : 24;
  const now = Date.now();
  const entries = readEntries(now - hours * 3600000).filter((entry) => entry.at <= now && Number.isFinite(entry.ms) && entry.ms >= 0);
  const failures = {};
  const hourly = new Array(hours).fill(0);
  const hourlyFailed = new Array(hours).fill(0);
  let succeeded = 0;
  const byAccountMap = new Map();
  for (const entry of entries) {
    const bucket = Math.floor((now - entry.at) / 3600000);
    if (bucket >= 0 && bucket < hours) {
      hourly[hours - 1 - bucket] += 1;
      if (!entry.ok) hourlyFailed[hours - 1 - bucket] += 1;
    }
    if (entry.ok) succeeded += 1;
    else {
      const key = failureBucket(entry);
      failures[key] = (failures[key] ?? 0) + 1;
    }
    if (entry.purpose === 'chat') {
      const key = entry.accountId || 'unknown';
      const list = byAccountMap.get(key) ?? [];
      list.push(entry);
      byAccountMap.set(key, list);
    }
  }
  const gaps = [];
  for (const list of byAccountMap.values()) {
    list.sort((a, b) => a.at - a.ms - (b.at - b.ms));
    let lastEnd;
    for (const entry of list) {
      if (lastEnd !== undefined) gaps.push(entry.at - entry.ms - lastEnd);
      lastEnd = Math.max(lastEnd ?? entry.at, entry.at);
    }
  }
  gaps.sort((a, b) => a - b);
  let files = 0;
  let bytes = 0;
  for (const name of listDayFiles()) {
    files += 1;
    try {
      bytes += fs.statSync(path.join(LEDGER_DIR, name)).size;
    } catch {}
  }
  return {
    hours,
    calls: entries.length,
    succeeded,
    failed: entries.length - succeeded,
    failures,
    hourly,
    hourlyFailed,
    gaps: gaps.length
      ? { samples: gaps.length, min: gaps[0], p50: percentile(gaps, 0.5), p90: percentile(gaps, 0.9), max: gaps[gaps.length - 1] }
      : null,
    footprint: { files, bytes },
    byAccount: Array.from(byAccountMap.entries()).map(([accountId, list]) => ({
      accountId,
      calls: list.length,
      succeeded: list.filter((entry) => entry.ok).length,
      failed: list.filter((entry) => !entry.ok).length,
    })),
  };
}
