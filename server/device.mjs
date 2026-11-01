// 设备身份：站点用 x-device-id（UUID v4）+ localStorage["deepseek-device-id:chat"] 认设备。
//
// 为什么要统一：
//   - 站点把「设备」当作登录态的一部分（还有「登录设备管理」页）。每换一个 device id，
//     就等于多登了一台新设备，容易被判成异常登录、把旧会话踢掉；
//   - 以前插件里出现三种身份：密码登录用 state/device.json 里的 id、浏览器登录页由站点前端自己生成、
//     引擎 HTTP 请求根本不带 x-device-id —— 同一个账号在站点看来是好几台设备。
//   - 而且旧实现生成的是 32 位十六进制，不是站点要求的 UUID v4（前端会判成 INVALID_DEVICE_INFO）。
//
// 现在三者共用这一个 UUID：密码登录请求体、登录页 localStorage、引擎请求头。
// 文件在 state/device.json，权限 0600，只在首次生成/迁移时写一次。
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { STATE_DIR, ensureStateDir } from './config.mjs';

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

let cached = '';

export function deviceFile() {
  return path.join(STATE_DIR, 'device.json');
}

/** 站点要求的 UUID v4；旧版生成的 32 位 hex 会一次性迁移（迁移后就是「同一台新设备」，之后稳定不变） */
export function deviceId() {
  if (cached) return cached;
  try {
    ensureStateDir();
    const saved = JSON.parse(fs.readFileSync(deviceFile(), 'utf8'));
    if (saved && typeof saved.id === 'string' && UUID_V4.test(saved.id)) {
      cached = saved.id;
      return cached;
    }
    // 旧文件是 hex：保留 created 时间，换成 UUID v4（站点只认这个格式）
    const id = crypto.randomUUID();
    fs.writeFileSync(deviceFile(), JSON.stringify({ id, createdAt: saved?.createdAt || Date.now(), migratedAt: Date.now() }), { mode: 0o600 });
    cached = id;
    return cached;
  } catch {
    const id = crypto.randomUUID();
    try {
      ensureStateDir();
      fs.writeFileSync(deviceFile(), JSON.stringify({ id, createdAt: Date.now() }), { mode: 0o600 });
    } catch {}
    cached = id;
    return cached;
  }
}

/** 换一个设备身份（排障用：站点把当前设备拉黑 / 设备列表太乱时） */
export function resetDeviceId() {
  cached = '';
  try {
    fs.rmSync(deviceFile(), { force: true });
  } catch {}
  return deviceId();
}

export function isDeviceId(v) {
  return typeof v === 'string' && UUID_V4.test(v);
}
