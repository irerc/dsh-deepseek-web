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

// ── 每账号独立设备 id ──────────────────────────────────────────────────────
// 为什么：站点把「设备」当成归因维度。一个账号被封，这台设备就被标了记号，
// 同一台设备上登录的其它账号会跟着被连坐（用户实测就是这么炸的）。
// 把设备 id 拆到账号级，等于这台机器在站点眼里是 N 台设备，封一个不会牵连其它。
// 存 state/devices.json：{ "<accountId>": "<uuid>", "__default__": "<uuid>" }
export function devicesFile() {
  return path.join(STATE_DIR, 'devices.json');
}

function readDevices() {
  try {
    const raw = JSON.parse(fs.readFileSync(devicesFile(), 'utf8'));
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  } catch {
    return {};
  }
}

function writeDevices(map) {
  try {
    ensureStateDir();
    fs.writeFileSync(devicesFile(), JSON.stringify(map, null, 2), { mode: 0o600 });
  } catch {}
}

/** 取某个账号的设备 id（没有就生成并落盘）。accountId 为空 = 默认身份（登录页用） */
export function deviceIdFor(accountId = '') {
  if (!accountId) return deviceId(); // 默认身份永远走 device.json，不在 devices.json 里存第二份
  const key = accountId;
  if (cachedFor.has(key)) return cachedFor.get(key);
  const map = readDevices();
  let id = map[key];
  if (!UUID_V4.test(String(id || ''))) {
    // 老用户迁移：默认身份沿用旧 device.json 里的 id，避免已登录的机器突然「换设备」
    id = crypto.randomUUID();
    map[key] = id;
    writeDevices(map);
  }
  cachedFor.set(key, id);
  return id;
}

const cachedFor = new Map();

/** 换掉某个账号（或默认身份）的设备 id，其它账号不受影响 */
export function resetDeviceIdFor(accountId = '') {
  if (!accountId) return resetDeviceId();
  const key = accountId;
  const map = readDevices();
  map[key] = crypto.randomUUID();
  writeDevices(map);
  cachedFor.set(key, map[key]);
  return map[key];
}

/**
 * 一次性迁移：老用户的账号还没有自己的设备 id 时，先**沿用**当前的全局 id。
 * 为什么不一上来就给每个号发新 id：那会让站点看到「同一时刻多台新设备登录」，
 * 反而更容易触发验证/踢下线。想换，就到账号行点「清除设备痕迹」，一次换一个。
 * 迁移之后新登录的账号才自动分配各自的设备 id。
 */
export function migrateAccountDevices(accountIds = []) {
  const map = readDevices();
  if (map.__migrated__) return { migrated: 0, already: true };
  const shared = deviceId();
  let migrated = 0;
  for (const id of accountIds) {
    if (!id || UUID_V4.test(String(map[id] || ''))) continue;
    map[id] = shared;
    cachedFor.set(id, shared);
    migrated += 1;
  }
  map.__migrated__ = true;
  writeDevices(map);
  return { migrated, already: false };
}

/**
 * 把某个账号的设备 id 直接设成给定值（登录页用哪个 id 登的，聊天就用哪个 id）。
 * 只接受合法 UUID v4；不合法的忽略，返回 false。
 */
export function adoptDeviceIdFor(accountId, id) {
  if (!accountId || !UUID_V4.test(String(id || '').trim())) return false;
  const map = readDevices();
  map[accountId] = String(id).trim();
  writeDevices(map);
  cachedFor.set(accountId, map[accountId]);
  return true;
}
