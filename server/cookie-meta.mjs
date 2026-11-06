// 站点 cookie 的过期形态（只记 name / 是否会话级 / 到期时间，不记 value）
//
// 为什么需要：网页版 cookie 里有几项是**会话级**的（浏览器进程退出就没了），
// 但页面 JS 读到的 document.cookie 里根本看不出这一点。登录代理能直接看到站点下发的
// Set-Cookie 头，顺手把 Max-Age / Expires 记下来，面板才能说清
// 「N 项 cookie 里几项是会话级、最长的那项还剩几天」——这是判断「为什么又要重新登录」的硬证据。
//
// 隐私：value 一律不落盘，只留名字与到期时间；文件权限 0600。
import fs from 'node:fs';
import path from 'node:path';
import { STATE_DIR } from './config.mjs';

const META_FILE = path.join(STATE_DIR, 'cookie-meta.json');
let lastWrite = 0;
let cache = null;
let cacheMtime = -1;

function readAll() {
  // 代理是独立进程：它会写这个文件，本进程必须按 mtime 重新读，否则永远看到空表
  let mtime = -1;
  try { mtime = fs.statSync(META_FILE).mtimeMs; } catch {}
  if (cache && mtime === cacheMtime) return cache;
  cacheMtime = mtime;
  try {
    const parsed = JSON.parse(fs.readFileSync(META_FILE, 'utf8'));
    cache = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    cache = {};
  }
  return cache;
}

function flush(force) {
  const now = Date.now();
  if (!force && now - lastWrite < 2000) return;
  lastWrite = now;
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    const tmp = META_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(cache, null, 0), { mode: 0o600 });
    fs.renameSync(tmp, META_FILE);
  } catch {}
}

/** 解析一条 Set-Cookie 的过期信息（Max-Age 优先于 Expires；<=0 当会话级） */
function parseOne(raw, now) {
  const text = String(raw || '');
  const m = text.match(/^\s*([^=;]+)=/);
  if (!m) return null;
  const name = m[1].trim();
  if (!name || name === 'dsweb_sid') return null;
  let expiresAt = 0;
  const maxAge = text.match(/;\s*max-age=(-?\d+)/i);
  const expires = text.match(/;\s*expires=([^;]+)/i);
  if (maxAge) {
    const sec = Number(maxAge[1]);
    if (Number.isFinite(sec) && sec > 0) expiresAt = now + sec * 1000;
  } else if (expires) {
    const at = Date.parse(expires[1]);
    if (Number.isFinite(at) && at > now) expiresAt = at;
  }
  return { name, session: !expiresAt, expiresAt: expiresAt || 0, updatedAt: now };
}

/** 记录一批站点下发的 cookie（代理收到上游响应时调用） */
export function noteSetCookies(list, now = Date.now()) {
  if (!Array.isArray(list) || !list.length) return;
  const all = readAll();
  let changed = false;
  for (const raw of list) {
    const one = parseOne(raw, now);
    if (!one) continue;
    all[one.name] = one;
    changed = true;
  }
  if (!changed) return;
  // 只保留最近 60 项，别让文件无限长
  const entries = Object.entries(all).sort((a, b) => (b[1].updatedAt || 0) - (a[1].updatedAt || 0)).slice(0, 60);
  cache = Object.fromEntries(entries);
  flush(false);
}

/** 账号 cookie 文本的构成：项数 / 会话级 / 持久级 / 最长的持久项还剩几天 */
export function shapeForCookie(cookieText) {
  const text = String(cookieText || '');
  if (!text) return null;
  const names = text
    .split(';')
    .map((part) => part.split('=')[0].trim())
    .filter(Boolean);
  if (!names.length) return null;
  const all = readAll();
  const now = Date.now();
  let sessionCount = 0;
  let persistentCount = 0;
  let latest = null;
  for (const name of names) {
    const meta = all[name];
    const expiresAt = meta ? Number(meta.expiresAt) : 0;
    if (!meta || meta.session || !(expiresAt > 0)) {
      sessionCount += 1;
      continue;
    }
    persistentCount += 1;
    if (!latest || expiresAt > latest.expiresAt) latest = { name, expiresAt, daysLeft: Math.max(0, Math.round(((expiresAt - now) / 86400000) * 10) / 10) };
  }
  return {
    total: names.length,
    sessionCount,
    persistentCount,
    // 没采到过期信息（老记录 / 手动粘 token）时 latest 为空，界面文案要区分
    known: Boolean(latest) || Object.keys(all).length > 0,
    latest,
  };
}

/** 测试 / 诊断用：当前已知的 cookie 元信息条数 */
export function metaCount() {
  return Object.keys(readAll()).length;
}
