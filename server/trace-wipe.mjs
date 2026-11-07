// 「清除设备痕迹」：把本机侧能换的标识全部换掉，让站点侧看起来是一台没用过的新设备。
//
// 能清掉的（本机）：
//   - 设备 id（x-device-id / localStorage 的 device-id 来源）→ 重新生成 UUID v4
//   - 从登录页抄下来的请求头指纹（x-hif-* / x-client-*）→ 清空，下次登录重新采集
//   - 热身标记、人类节律的 24h 发送计数 → 归零（新身份重新计数）
//
// 清不掉的（站点侧，必须说实话）：
//   - 账号本身、它的历史对话、发布过的内容、IP、支付信息、以及站点已经记下的处置记录；
//   - 「换新设备」这个动作本身也可能被当成新设备登录而触发额外验证。
// 所以这个功能治的是「设备关联」，不是「账号历史」。
import { deviceId, deviceIdFor, resetDeviceId, resetDeviceIdFor } from './device.mjs';
import { listAccounts, updateAccount } from './accounts.mjs';
import { resetBudget } from './human-rhythm.mjs';

/**
 * @param {string} accountId 指定账号；不传 = 所有账号一起清（设备 id 是全局的，反正会换）
 * @returns {{ok:boolean, deviceId:string, previousDeviceId:string, accounts:number, cleared:string[]}}
 */
export function wipeDeviceTrace(accountId = '') {
  const all = listAccounts();
  const ids = (accountId ? all.filter((a) => a.id === accountId) : all).map((a) => a.id);
  // 设备 id 是账号级的：只换这一台设备在这个账号上的身份，别的账号不受影响
  // （以前全局换 id，一个号出问题把所有号的设备身份一起换掉，反而制造出「一批新设备」）
  const previousDeviceId = accountId ? deviceIdFor(accountId) : deviceId();
  const nextDeviceId = accountId ? resetDeviceIdFor(accountId) : resetDeviceId();
  for (const id of ids) {
    updateAccount(id, { fingerprint: null, fingerprintAt: null, warmupAt: null, lastUsedAt: null });
  }
  try {
    resetBudget(); // 24h 发送计数：新设备重新开始
  } catch {}
  return {
    ok: true,
    deviceId: nextDeviceId,
    previousDeviceId,
    accounts: ids.length,
    cleared: ['设备 id', '请求头指纹', '热身标记', '发送计数'],
  };
}
