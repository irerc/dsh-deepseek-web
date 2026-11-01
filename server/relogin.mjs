// token 失效后用保存的账号密码自动重新登录。
//
// 关键点：
//   - device_id 是持久化在 state 目录的，同一台设备上的第二次密码登录通常不再要邮箱验证码；
//   - 需要验证码时不硬撞上游（记下 needCode，界面提示用户手动完成一次，之后设备被信任，自动重登就顺了）；
//   - 站点可能对「没有浏览器指纹的密码登录」直接回 RISK_DEVICE_DETECTED（设备风控）。
//     这时 HTTP 密码登录这条路是死的，只能走「浏览器登录」：真实网页里由站点自己的 JS 完成风控，
//     插件把保存的邮箱密码带过去自动填表（见 server/autologin.mjs + inject.html）。
//     这种情况长时间冷却（6 小时）并标记 needBrowserLogin，后台扫描也不再空撞，免得越撞越黑。
//   - 每个账号一个冷却，避免失效 token 每几秒重试一次把账号打到风控。
import { loginWithPassword } from './login.mjs';
import { loadConfig } from './config.mjs';
import { getCredential, replaceToken, markReloginFailed, listAccounts } from './accounts.mjs';

const cooldownUntil = new Map(); // accountId -> timestamp

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 上游的「设备风控 / 不要用脚本登」类错误 */
function isRiskError(message) {
  const m = String(message || '');
  // RISK_*：设备风控；WAF/202/403：站点前置拦截；40029：按 IP 限流。这几种脚本登录都走不通。
  return /RISK_DEVICE_DETECTED|DEVICE_DETECTED|_RISK_|风控|WAF|HTTP 202|HTTP 403/i.test(m);
}
/** 限流：歇一会儿再试，别当风控处理 */
function isRateError(message) {
  return /TOO_MANY_REQUESTS|429|40029|被限流|IP 限流/i.test(String(message || ''));
}

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
  if (!cred || !cred.password) {
    return { ok: false, noCredential: true, message: '这个账号没有保存密码' };
  }
  if (!cred.email || cred.email.includes('*')) {
    // 存的是脱敏地址（站点返回的 262*****77@qq.com），拿去登录必然失败，别再空跑
    markReloginFailed(id, '保存的是脱敏邮箱');
    return { ok: false, noCredential: true, message: '保存的邮箱是脱敏地址（含 *），请在账号行点「改密码」重新填一次完整邮箱和密码' };
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
  if (isRiskError(out.message)) {
    // 设备风控：HTTP 密码登录这条路会被一直拒绝，只能让真实浏览器完成一次登录。
    // 冷却拉长到 6 小时，且后台扫描不再碰这个账号（reloginBlocked=needBrowserLogin）。
    cooldownUntil.set(id, Date.now() + 6 * 60 * 60 * 1000);
    markReloginFailed(id, out.message, { needBrowserLogin: true });
    return {
      ok: false,
      needBrowserLogin: true,
      message:
        '站点判定本机设备存在风控（' + String(out.message || '').slice(0, 80) + '），密码登录被拒。' +
        '请点「浏览器登录」，账号密码会自动填好，在真实网页里登一次即可恢复（网页登录不受这个限制）。',
    };
  }
  if (isRateError(out.message)) {
    cooldownUntil.set(id, Date.now() + 10 * 60 * 1000);
    markReloginFailed(id, out.message);
    return { ok: false, message: '登录被限流，10 分钟后再试：' + (out.message || '') };
  }
  // 密码错/网络问题：退避 5 分钟后再试
  cooldownUntil.set(id, Date.now() + 5 * 60 * 1000);
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
    .filter(
      (a) =>
        a.status === 'authExpired' &&
        a.hasPassword &&
        !a.disabled &&
        // 需要用户参与的两种状态：验证码、浏览器登录。后台别去撞，否则越撞风控越死
        a.reloginBlocked !== 'needCode' &&
        a.reloginBlocked !== 'needBrowserLogin',
    )
    .slice(0, Math.max(1, limit));
  const results = [];
  for (const a of targets) {
    const r = await reloginAccount(a.id, { reason });
    results.push({ id: a.id, label: a.label, ...r, account: r.account });
    if (targets.length > 1) await sleep(1500);
  }
  return { tried: targets.length, ok: results.filter((r) => r.ok).length, results };
}
