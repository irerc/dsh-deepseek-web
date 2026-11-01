// 多账号池：存储、选择、冷却与故障转移
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { STATE_DIR, ensureStateDir } from './config.mjs';
import { encrypt, decrypt } from './credentials.mjs';

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
    email: a.email || '',
    userId: a.userId || '',
    status: a.disabled ? 'disabled' : a.status === 'authExpired' ? 'authExpired' : cooling ? 'cooling' : 'ok',
    cooldownUntil: cooling ? a.cooldownUntil : null,
    addedAt: a.addedAt || null,
    lastUsedAt: a.lastUsedAt || null,
    failures: a.failures || 0,
    // 是否保存了账号密码（只给前端一个布尔值，密码本身永远不出后端）
    hasPassword: Boolean(a.loginPassword),
    lastReloginAt: a.lastReloginAt || null,
    reloginBlocked: a.reloginBlocked === 'needCode' ? 'needCode' : '',
  };
}

export function listAccounts() {
  return loadAccounts().accounts.map(publicAccount);
}

export function addAccount({ token, label, cookie = '', email = '', userId = '', password = '', loginEmail = '' }) {
  if (!token || typeof token !== 'string' || token.length < 20) throw new Error('token 无效');
  const doc = loadAccounts();
  const exists = doc.accounts.find((a) => a.token === token);
  if (exists) {
    if (cookie) exists.cookie = cookie;
    if (email) exists.email = email;
    if (userId) exists.userId = userId;
    if (label) exists.label = label;
    if (password) {
      exists.loginPassword = encrypt(password);
      exists.loginEmail = loginEmail || email || exists.email || '';
      exists.loginSavedAt = Date.now();
      exists.reloginBlocked = '';
    }
    save(doc);
    return publicAccount(exists);
  }
  const account = {
    id: crypto.createHash('sha1').update(token).digest('hex').slice(0, 10),
    label: (label || '').trim() || '账号' + (doc.accounts.length + 1),
    token,
    cookie: cookie || '',
    email: email || '',
    userId: userId || '',
    // 保存的登录凭证（加密后存这里，见 credentials.mjs）
    loginEmail: password ? loginEmail || email || '' : '',
    loginPassword: password ? encrypt(password) : '',
    loginSavedAt: password ? Date.now() : 0,
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

// ---- 保存的登录凭证（token 失效时自动重新登录用）----

/** 保存/更新某个账号的邮箱 + 密码（密码加密落盘，不回传前端） */
export function setCredential(id, { email = '', password = '' } = {}) {
  const doc = loadAccounts();
  const account = doc.accounts.find((a) => a.id === id || a.label === id);
  if (!account) return null;
  if (password) account.loginPassword = encrypt(String(password));
  if (email) account.loginEmail = String(email).trim();
  if (!account.loginEmail && account.email) account.loginEmail = account.email;
  account.loginSavedAt = Date.now();
  account.reloginBlocked = '';
  save(doc);
  return publicAccount(account);
}

/** 读出可用的登录凭证 { email, password }；没保存过则返回 null */
export function getCredential(id) {
  const doc = loadAccounts();
  const account = doc.accounts.find((a) => a.id === id || a.label === id);
  if (!account || !account.loginPassword) return null;
  const password = decrypt(account.loginPassword);
  if (!password) return null;
  return { email: account.loginEmail || account.email || '', password };
}

/** 忘记保存的密码 */
export function clearCredential(id) {
  const doc = loadAccounts();
  const account = doc.accounts.find((a) => a.id === id || a.label === id);
  if (!account) return null;
  delete account.loginPassword;
  delete account.loginEmail;
  delete account.loginSavedAt;
  account.reloginBlocked = '';
  save(doc);
  return publicAccount(account);
}

/** 重新登录成功后原地换 token（账号 id 不变，会话/用量都还对得上） */
export function replaceToken(id, token, user = {}) {
  const doc = loadAccounts();
  const account = doc.accounts.find((a) => a.id === id || a.label === id);
  if (!account) return null;
  account.token = token;
  account.status = 'ok';
  account.failures = 0;
  account.cooldownUntil = null;
  account.lastReloginAt = Date.now();
  account.reloginFailures = 0;
  account.reloginBlocked = '';
  if (user?.email) account.email = user.email;
  if (user?.id) account.userId = user.id;
  save(doc);
  return publicAccount(account);
}

/** 自动重登失败：记下原因（needCode 时界面会提示去手动补验证码） */
export function markReloginFailed(id, message = '', { needCode = false } = {}) {
  const doc = loadAccounts();
  const account = doc.accounts.find((a) => a.id === id || a.label === id);
  if (!account) return null;
  account.reloginFailures = (account.reloginFailures || 0) + 1;
  account.lastReloginFailAt = Date.now();
  account.reloginBlocked = needCode ? 'needCode' : String(message || '').slice(0, 200);
  save(doc);
  return publicAccount(account);
}
