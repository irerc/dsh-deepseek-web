// token 失效后用保存的账号密码自动重新登录。
//
// 关键点：
//   - device_id 是持久化在 state 目录的，同一台设备上的第二次密码登录通常不再要邮箱验证码；
//   - 需要验证码时不硬撞上游（记下 needCode，界面提示用户手动完成一次，之后设备被信任，自动重登就顺了）；
//   - 每个账号一个冷却，避免失效 token 每几秒重试一次把账号打到风控。
import { loginWithPassword } from './login.mjs';
import { loadConfig } from './config.mjs';
import { getCredential, replaceToken, markReloginFailed, listAccounts } from './accounts.mjs';

const cooldownUntil = new Map(); // accountId -> timestamp

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 用保存的密码给某个账号换一个新 token。
 * @param {string} id 账号 id（或 label）
 * @param {object} opts { reason: 'chat' | 'check' | 'manual' | 'sweep', quiet }
 * @returns {Promise<{ok:boolean, message?:string, account?:object, needCode?:boolean, noCredential?:boolean, skipped?:boolean}>}
 */
export async function reloginAccount(id, { reason = 'chat' } = {}) {
  const cfg = loadConfig();
  if (cfg.autoRelogin === false && reason !== 'manual') {
    return { ok: false, skipped: true, message: '自动重新登录已关闭' };
  }
  const cred = getCredential(id);
  if (!cred || !cred.email || !cred.password) {
    return { ok: false, noCredential: true, message: '这个账号没有保存密码' };
  }
  if (reason !== 'manual') {
    const until = cooldownUntil.get(id) || 0;
    if (until > Date.now()) {
      return { ok: false, cooled: true, message: '自动重新登录冷却中（' + Math.ceil((until - Date.now()) / 1000) + 's）' };
    }
  }
  let out;
  try {
    out = await loginWithPassword(cred.email, cred.password);
  } catch (error) {
    out = { ok: false, message: String(error.message || error) };
  }
  if (out.ok) {
    cooldownUntil.delete(id);
    const account = replaceToken(id, out.token, out.user || {});
    return {
      ok: true,
      account,
      message: '已用保存的密码自动重新登录（' + (cred.email || '') + '）',
    };
  }
  if (out.needCode) {
    // 需要邮箱验证码：交给用户手动完成一次，别反复发码
    cooldownUntil.set(id, Date.now() + 30 * 60 * 1000);
    markReloginFailed(id, '需要邮箱验证码', { needCode: true });
    return {
      ok: false,
      needCode: true,
      message: '自动重新登录需要邮箱验证码（新设备首次登录常见），请在账号行点「重新登录」手动完成一次，之后就会自动了',
    };
  }
  // 密码错/网络问题：退避 2 分钟后再试
  cooldownUntil.set(id, Date.now() + 2 * 60 * 1000);
  markReloginFailed(id, out.message);
  return { ok: false, message: '自动重新登录失败：' + (out.message || '未知原因') };
}

/**
 * 把当前所有「登录失效 + 存了密码」的账号扫一遍（启动后、后台定时用）。
 * @param {object} opts { limit, reason }
 */
export async function reloginExpired({ limit = 3, reason = 'sweep' } = {}) {
  const cfg = loadConfig();
  if (cfg.autoRelogin === false) return { tried: 0, ok: 0, results: [] };
  const targets = listAccounts()
    .filter((a) => a.status === 'authExpired' && a.hasPassword && !a.disabled)
    .slice(0, Math.max(1, limit));
  const results = [];
  for (const a of targets) {
    const r = await reloginAccount(a.id, { reason });
    results.push({ id: a.id, label: a.label, ...r, account: r.account });
    if (targets.length > 1) await sleep(1500);
  }
  return { tried: targets.length, ok: results.filter((r) => r.ok).length, results };
}
