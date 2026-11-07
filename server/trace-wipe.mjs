// 「按新设备重新开始」：把本机侧能换的标识全部换掉，让站点侧看起来是一台没用过的新设备。
//
// 一次清到底（站点能看到的几条线索都在这里）：
//   - 设备 id（x-device-id / localStorage 的 device-id 来源）→ 重新生成 UUID v4
//   - 从登录页抄下来的请求头指纹（x-hif-* / x-client-*）→ 清空，下次登录重新采集
//   - 登录代理留下的 cookie（jar-*.json / cookie-meta.json）→ 删掉，下次登录是全新会话
//   - 热身标记、最近使用时间、24h 发送计数 → 归零（新身份重新计数）
//   - 登录代理的会话表（login-sessions.json）→ 清空
//
// 清不掉的（站点侧，必须说实话）：
//   - 账号本身、它的历史对话、发布过的内容、IP、支付信息、以及站点已经记下的处置记录；
//   - 「换新设备」这个动作本身也可能被当成新设备登录而触发额外验证。
// 所以这个功能治的是「设备关联」，不是「账号历史」。想彻底像新设备，IP 也得换（用流量/换网络）。
import fs from 'node:fs';
import path from 'node:path';

import { deviceId, deviceIdFor, resetDeviceId, resetDeviceIdFor } from './device.mjs';
import { listAccounts, updateAccount } from './accounts.mjs';
import { resetBudget } from './human-rhythm.mjs';
import { STATE_DIR } from './config.mjs';

function dropFile(name) {
  try {
    fs.rmSync(path.join(STATE_DIR, name), { force: true });
    return true;
  } catch {
    return false;
  }
}

/** 删除登录代理的 cookie 罐（jar-*.json）；返回删掉的个数 */
function dropJars() {
  let n = 0;
  try {
    for (const f of fs.readdirSync(STATE_DIR)) {
      if (f.startsWith('jar-') && f.endsWith('.json')) {
        if (dropFile(f)) n += 1;
      }
    }
  } catch {}
  return n;
}

/**
 * @param {string} accountId 指定账号；不传 = 所有账号一起清
 * @returns {{ok:boolean, deviceId:string, previousDeviceId:string, accounts:number, cleared:string[], jars:number}}
 */
export function wipeDeviceTrace(accountId = '') {
  const all = listAccounts();
  const ids = (accountId ? all.filter((a) => a.id === accountId) : all).map((a) => a.id);
  // 设备 id 是账号级的：只换这台设备在这个账号上的身份，别的账号不受影响
  // （以前全局换 id，一个号出问题把所有号的设备身份一起换掉，反而制造出「一批新设备」）
  const previousDeviceId = accountId ? deviceIdFor(accountId) : deviceId();
  const nextDeviceId = accountId ? resetDeviceIdFor(accountId) : resetDeviceId();
  for (const id of ids) {
    updateAccount(id, { fingerprint: null, fingerprintAt: null, warmupAt: null, lastUsedAt: null });
    try {
      resetBudget(id); // 24h 发送计数按账号清，别的号不受影响
    } catch {}
  }
  // 登录代理侧：cookie 罐 + 会话表一起清，下次登录是全新浏览器会话（保留账号密码/token 本身）
  const jars = dropJars();
  dropFile('cookie-meta.json');
  dropFile('login-sessions.json');
  const cleared = ['设备 id', '请求头指纹', '热身标记', '发送计数'];
  if (jars) cleared.push('登录 cookie（' + jars + ' 份）');
  return {
    ok: true,
    deviceId: nextDeviceId,
    previousDeviceId,
    accounts: ids.length,
    jars,
    cleared,
  };
}
