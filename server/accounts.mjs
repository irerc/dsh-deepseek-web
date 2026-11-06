// 多账号池：存储、选择、冷却与故障转移
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { STATE_DIR, ensureStateDir, loadConfig } from './config.mjs';
import { encrypt, decrypt } from './credentials.mjs';
import { deviceId } from './device.mjs';

const ACCOUNTS_FILE = path.join(STATE_DIR, 'accounts.json');

let rr = 0;

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

// 设备身份统一在 server/device.mjs（UUID v4，登录页/密码登录/引擎共用同一个）
export { deviceId };

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

/** 站点返回的邮箱是脱敏的（如 262*****77@qq.com）：判断一下，别把脱敏地址当账号名用 */
export function isMaskedEmail(value) {
  return typeof value === 'string' && value.includes('*');
}

/** 这个账号能拿到的完整邮箱（优先用户自己填过的） */
function fullEmailOf(a) {
  for (const v of [a.emailFull, a.loginEmail, a.email]) {
    if (v && !isMaskedEmail(v)) return v;
  }
  return '';
}

export function publicAccount(a) {
  const now = Date.now();
  const cooling = a.cooldownUntil && a.cooldownUntil > now;
  return {
    id: a.id,
    label: a.label,
    // email 优先给完整地址；只有脱敏地址时也返回，但标记 emailMasked，界面提示用户补全
    email: fullEmailOf(a) || a.email || '',
    emailMasked: !fullEmailOf(a) && isMaskedEmail(a.email),
    userId: a.userId || '',
    status: a.disabled ? 'disabled' : a.status === 'authExpired' ? 'authExpired' : cooling ? 'cooling' : 'ok',
    cooldownUntil: cooling ? a.cooldownUntil : null,
    addedAt: a.addedAt || null,
    lastUsedAt: a.lastUsedAt || null,
    failures: a.failures || 0,
    // 是否保存了账号密码（只给前端一个布尔值，密码本身永远不出后端）
    hasPassword: Boolean(a.loginPassword),
    lastReloginAt: a.lastReloginAt || null,
    // needCode：要邮箱验证码；needBrowserLogin：HTTP 密码登录被设备风控拦了，得走真实网页登录
    reloginBlocked: a.reloginBlocked === 'needCode' || a.reloginBlocked === 'needBrowserLogin' ? a.reloginBlocked : '',
    needBrowserLogin: a.reloginBlocked === 'needBrowserLogin',
    reloginFailures: a.reloginFailures || 0,
    // 站点禁言（chat.is_muted / 错误码 50006）：到期前不要拿去发消息
    mutedUntil: a.mutedUntil && a.mutedUntil > now ? a.mutedUntil : null,
    muted: Boolean(a.mutedUntil && a.mutedUntil > now),
    banned: Boolean(a.banned),
    // 凭证来源 / 最近一次登录成功时间（界面「登录状态」用，参考 dsh-deepseek-web-login 的信息卡）
    loginSource: a.loginSource || '',
    // 登录时从真实页面抄下来的请求头指纹（x-hif-* / x-client-*），引擎发请求时会原样带上
    hasFingerprint: Boolean(a.fingerprint && Object.keys(a.fingerprint).length),
    fingerprintAt: a.fingerprintAt || null,
    loginAt: a.loginAt || a.addedAt || null,
    active: false,
  };
}

export function listAccounts() {
  let activeId = '';
  try { activeId = loadConfig().activeAccountId || ''; } catch {}
  return loadAccounts().accounts.map((a) => {
    const out = publicAccount(a);
    out.active = Boolean(activeId) && activeId === a.id;
    return out;
  });
}

export function addAccount({ token, label, cookie = '', email = '', userId = '', password = '', loginEmail = '' }) {
  if (!token || typeof token !== 'string' || token.length < 20) throw new Error('token 无效');
  const doc = loadAccounts();
  const exists = doc.accounts.find((a) => a.token === token);
  if (exists) {
    if (cookie) exists.cookie = cookie;
    if (email && !isMaskedEmail(email)) exists.emailFull = email;
    if (email && !exists.email) exists.email = email;
    if (userId) exists.userId = userId;
    if (label) exists.label = label;
    if (password) {
      exists.loginPassword = encrypt(password);
      const credEmail = [loginEmail, email, exists.emailFull, exists.email].find((v) => v && !isMaskedEmail(v));
      exists.loginEmail = credEmail || '';
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
    emailFull: email && !isMaskedEmail(email) ? email : '',
    userId: userId || '',
    // 保存的登录凭证（加密后存这里，见 credentials.mjs）
    loginEmail: password ? [loginEmail, email].find((v) => v && !isMaskedEmail(v)) || '' : '',
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
    (a) =>
      !a.disabled &&
      !a.banned &&
      a.status !== 'authExpired' &&
      !(a.cooldownUntil && a.cooldownUntil > now) &&
      !(a.mutedUntil && a.mutedUntil > now) &&
      !exclude.has(a.id),
  );
  if (!usable.length) return null;
  if (prefer) {
    const hit = usable.find((a) => a.id === prefer || a.label === prefer);
    if (hit) return hit;
  }
  // 账号库里手动「设为当前账号」的号优先；不可用时自动落回轮询
  try {
    const activeId = loadConfig().activeAccountId || '';
    const hit = activeId ? usable.find((a) => a.id === activeId) : null;
    if (hit) return hit;
  } catch {}
  rr = (rr + 1) % Math.max(1, usable.length);
  return usable[rr % usable.length];
}

/** 取某账号采集到的指纹头（没有就返回空对象） */
export function getFingerprint(id) {
  const account = loadAccounts().accounts.find((a) => a.id === id);
  if (!account || !account.fingerprint || typeof account.fingerprint !== 'object') return {};
  const out = {};
  for (const [k, v] of Object.entries(account.fingerprint)) {
    const key = String(k).toLowerCase();
    if (!/^x-(hif|client|ds)-|^user-agent$/.test(key)) continue;
    if (typeof v === 'string' && v.length <= 400) out[key] = v;
  }
  return out;
}

/** 改备注（只改名字，不影响任何凭证） */
export function renameAccount(id, label) {
  const doc = loadAccounts();
  const account = doc.accounts.find((a) => a.id === id);
  if (!account) return null;
  const clean = String(label || '').trim().slice(0, 40);
  account.label = clean || account.label;
  save(doc);
  return publicAccount(account);
}

/**
 * 导出账号库备份（等价于可完整登录的凭证，参考实现里的「导出备份」）。
 * 不导出明文密码，只导 token / cookie / 备注 / 邮箱，换环境后仍能直接用。
 */
export function exportAccounts() {
  const doc = loadAccounts();
  return {
    version: 1,
    exportedAt: new Date().toISOString(),
    accounts: doc.accounts.map((a) => ({
      label: a.label,
      token: a.token,
      cookie: a.cookie || '',
      email: a.email || '',
      emailFull: a.emailFull || '',
      userId: a.userId || '',
      addedAt: a.addedAt || null,
      loginSource: a.loginSource || '',
    })),
  };
}

/** 导入账号库备份：按 token 去重，已存在的只补 cookie/邮箱，不覆盖当前状态 */
export function importAccounts(data) {
  const list = Array.isArray(data) ? data : data && Array.isArray(data.accounts) ? data.accounts : [];
  const doc = loadAccounts();
  let added = 0;
  let merged = 0;
  for (const item of list) {
    const token = typeof item?.token === 'string' ? item.token.trim() : '';
    if (token.length < 20) continue;
    const exists = doc.accounts.find((a) => a.token === token);
    if (exists) {
      if (item.cookie && !exists.cookie) exists.cookie = item.cookie;
      if (item.emailFull && !isMaskedEmail(item.emailFull) && !exists.emailFull) exists.emailFull = item.emailFull;
      merged += 1;
      continue;
    }
    doc.accounts.push({
      id: crypto.createHash('sha1').update(token).digest('hex').slice(0, 10),
      label: String(item.label || '').trim() || '账号' + (doc.accounts.length + 1),
      token,
      cookie: item.cookie || '',
      email: item.email || '',
      emailFull: item.emailFull && !isMaskedEmail(item.emailFull) ? item.emailFull : '',
      userId: item.userId || '',
      loginEmail: '',
      loginPassword: '',
      loginSavedAt: 0,
      addedAt: item.addedAt || Date.now(),
      lastUsedAt: null,
      cooldownUntil: null,
      failures: 0,
      status: 'ok',
      disabled: false,
      loginSource: '导入备份',
    });
    added += 1;
  }
  save(doc);
  return { added, merged, total: doc.accounts.length };
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

/** 精确设定冷却时间（限流退避已经算好具体毫秒时用，不再按失败次数翻倍） */
export function setCooldown(id, ms) {
  const doc = loadAccounts();
  const account = doc.accounts.find((a) => a.id === id);
  if (!account) return null;
  account.failures = (account.failures || 0) + 1;
  account.cooldownUntil = Date.now() + Math.max(0, Math.round(ms));
  save(doc);
  return { account: publicAccount(account), wait: Math.max(0, Math.round(ms)) };
}

export function markAuthExpired(id) {
  const doc = loadAccounts();
  const account = doc.accounts.find((a) => a.id === id);
  if (!account) return null;
  account.status = 'authExpired';
  save(doc);
  return publicAccount(account);
}

/**
 * 站点禁言/封禁：记下到期时间，账号池在到期前不会再拿它发消息。
 * @param {string} id
 * @param {number} untilMs 到期时间戳（毫秒）；0/空表示未知，按 24 小时处理
 * @param {{banned?:boolean, reason?:string}} opts
 */
export function markMuted(id, untilMs = 0, { banned = false, reason = '' } = {}) {
  const doc = loadAccounts();
  const account = doc.accounts.find((a) => a.id === id || a.label === id);
  if (!account) return null;
  const until = Number(untilMs) > Date.now() ? Number(untilMs) : Date.now() + 24 * 60 * 60 * 1000;
  account.mutedUntil = until;
  account.muteReason = String(reason || '').slice(0, 200);
  if (banned) {
    account.banned = true;
    account.disabled = true;
  }
  save(doc);
  return publicAccount(account);
}

export function clearMuted(id) {
  const doc = loadAccounts();
  const account = doc.accounts.find((a) => a.id === id || a.label === id);
  if (!account) return null;
  delete account.mutedUntil;
  delete account.muteReason;
  delete account.banned;
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
  const trimmed = String(email || '').trim();
  if (trimmed && !isMaskedEmail(trimmed)) {
    account.loginEmail = trimmed;
    account.emailFull = trimmed;
  }
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
  return { email: fullEmailOf(account) || account.loginEmail || '', password };
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

/** 用上游返回的用户信息补账号名（上游邮箱是脱敏的，绝不会覆盖已知的完整地址） */
export function noteEmail(id, { email = '', userId = '' } = {}) {
  const doc = loadAccounts();
  const account = doc.accounts.find((a) => a.id === id || a.label === id);
  if (!account) return null;
  if (email && !isMaskedEmail(email)) account.emailFull = email;
  else if (email && !fullEmailOf(account)) account.email = email;
  if (userId) account.userId = userId;
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
  delete account.mutedUntil;
  delete account.muteReason;
  delete account.banned;
  if (user?.email) {
    if (!isMaskedEmail(user.email)) account.emailFull = user.email;
    else if (!fullEmailOf(account)) account.email = user.email;
  }
  if (user?.id) account.userId = user.id;
  save(doc);
  return publicAccount(account);
}

/** 自动重登失败：记下原因（needCode / needBrowserLogin 时界面会给对应的手动入口） */
export function markReloginFailed(id, message = '', { needCode = false, needBrowserLogin = false } = {}) {
  const doc = loadAccounts();
  const account = doc.accounts.find((a) => a.id === id || a.label === id);
  if (!account) return null;
  account.reloginFailures = (account.reloginFailures || 0) + 1;
  account.lastReloginFailAt = Date.now();
  account.reloginBlocked = needCode ? 'needCode' : needBrowserLogin ? 'needBrowserLogin' : String(message || '').slice(0, 200);
  save(doc);
  return publicAccount(account);
}
