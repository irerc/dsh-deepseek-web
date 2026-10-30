// 多账号池：存储、选择、冷却与故障转移
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { STATE_DIR, ensureStateDir } from './config.mjs';

const ACCOUNTS_FILE = path.join(STATE_DIR, 'accounts.json');
const DEVICE_FILE = path.join(STATE_DIR, 'device.json');

let rr = 0;

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

export function deviceId() {
  ensureStateDir();
  const saved = readJson(DEVICE_FILE, null);
  if (saved && saved.id) return saved.id;
  const id = crypto.randomBytes(16).toString('hex');
  fs.writeFileSync(DEVICE_FILE, JSON.stringify({ id, createdAt: Date.now() }), { mode: 0o600 });
  return id;
}

export function loadAccounts() {
  ensureStateDir();
  const doc = readJson(ACCOUNTS_FILE, { version: 1, accounts: [] });
  if (!Array.isArray(doc.accounts)) return { version: 1, accounts: [] };
  return doc;
}

function save(doc) {
  ensureStateDir();
  const tmp = ACCOUNTS_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(doc, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, ACCOUNTS_FILE);
}

export function publicAccount(a) {
  const now = Date.now();
  const cooling = a.cooldownUntil && a.cooldownUntil > now;
  return {
    id: a.id,
    label: a.label,
    status: a.disabled ? 'disabled' : a.status === 'authExpired' ? 'authExpired' : cooling ? 'cooling' : 'ok',
    cooldownUntil: cooling ? a.cooldownUntil : null,
    addedAt: a.addedAt || null,
    lastUsedAt: a.lastUsedAt || null,
    failures: a.failures || 0,
  };
}

export function listAccounts() {
  return loadAccounts().accounts.map(publicAccount);
}

export function addAccount({ token, label, cookie = '' }) {
  if (!token || typeof token !== 'string' || token.length < 20) throw new Error('token 无效');
  const doc = loadAccounts();
  const exists = doc.accounts.find((a) => a.token === token);
  if (exists) {
    if (cookie) exists.cookie = cookie;
    save(doc);
    return publicAccount(exists);
  }
  const account = {
    id: crypto.createHash('sha1').update(token).digest('hex').slice(0, 10),
    label: (label || '').trim() || '账号' + (doc.accounts.length + 1),
    token,
    cookie: cookie || '',
    addedAt: Date.now(),
    lastUsedAt: null,
    cooldownUntil: null,
    failures: 0,
    status: 'ok',
    disabled: false,
  };
  doc.accounts.push(account);
  save(doc);
  return publicAccount(account);
}

export function removeAccount(id) {
  const doc = loadAccounts();
  const before = doc.accounts.length;
  doc.accounts = doc.accounts.filter((a) => a.id !== id);
  save(doc);
  return before !== doc.accounts.length;
}

export function clearAccounts() {
  const doc = loadAccounts();
  const count = doc.accounts.length;
  doc.accounts = [];
  save(doc);
  rr = 0;
  return count;
}

export function updateAccount(id, patch) {
  const doc = loadAccounts();
  const account = doc.accounts.find((a) => a.id === id || a.label === id);
  if (!account) return null;
  Object.assign(account, patch);
  save(doc);
  return publicAccount(account);
}

export function getCookie(id) {
  const doc = loadAccounts();
  const account = doc.accounts.find((a) => a.id === id || a.label === id);
  return account ? account.cookie || '' : '';
}

export function getToken(id) {
  const doc = loadAccounts();
  const account = doc.accounts.find((a) => a.id === id || a.label === id);
  return account ? account.token : null;
}

/** 选一个可用账号：默认轮询；可指定 label/id；自动跳过冷却、禁用、失效 */
export function pickAccount({ prefer = null, exclude = new Set() } = {}) {
  const doc = loadAccounts();
  const now = Date.now();
  const usable = doc.accounts.filter(
    (a) => !a.disabled && a.status !== 'authExpired' && !(a.cooldownUntil && a.cooldownUntil > now) && !exclude.has(a.id),
  );
  if (!usable.length) return null;
  if (prefer) {
    const hit = usable.find((a) => a.id === prefer || a.label === prefer);
    if (hit) return hit;
  }
  rr = (rr + 1) % Math.max(1, usable.length);
  return usable[rr % usable.length];
}

export function markUsed(id) {
  return updateAccount(id, { lastUsedAt: Date.now(), failures: 0, cooldownUntil: null, status: 'ok' });
}

export function markCooldown(id, ms) {
  const doc = loadAccounts();
  const account = doc.accounts.find((a) => a.id === id);
  if (!account) return null;
  const failures = (account.failures || 0) + 1;
  const wait = Math.min(ms * Math.pow(2, Math.max(0, failures - 1)), 10 * 60 * 1000);
  account.failures = failures;
  account.cooldownUntil = Date.now() + wait;
  save(doc);
  return { account: publicAccount(account), wait };
}

export function markAuthExpired(id) {
  const doc = loadAccounts();
  const account = doc.accounts.find((a) => a.id === id);
  if (!account) return null;
  account.status = 'authExpired';
  save(doc);
  return publicAccount(account);
}

export function clearStatus(id) {
  return updateAccount(id, { status: 'ok', failures: 0, cooldownUntil: null });
}
