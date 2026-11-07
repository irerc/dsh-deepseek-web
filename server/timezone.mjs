// 站点时区：容器（Android 上的 Ubuntu 侧）常年是 UTC，但手机和真人都在 +08:00。
//
// 为什么必须修：这个时区同时出现在两个地方——
//   1. x-client-timezone-offset 请求头（发给站点的指纹之一）
//   2. 人类节律的「深夜静默」判断（01:00~06:30 要放大间隔）
// 用错时区，会让「下午两点」被当成「凌晨」去放大等待，同时把 +08:00 的设备头写成 +00:00，
// 前后自相矛盾——比不做还糟。
import fs from 'node:fs';

const CANDIDATES = ['/system/etc/timezone', '/etc/timezone', '/etc/localtime.name'];

let cached = '';

/** IANA 名字是否可用（能被 Intl 认出来） */
function validIana(name) {
  if (!name || typeof name !== 'string') return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: name });
    return true;
  } catch {
    return false;
  }
}

/** 纯 UTC 不算「设备时区」：手机不会永远停在零时区，容器才会 */
function isUtcLike(name) {
  return !name || /^(Etc\/)?(UTC|GMT|GMT\+0|GMT-0|Universal|Zulu)$/i.test(name.trim());
}

/** 从文件/环境变量里猜：环境变量 > 系统文件 > Intl 默认 */
export function deviceTimeZone() {
  if (cached) return cached;
  const fromEnv = process.env.DSH_TZ || process.env.TZ;
  if (validIana(fromEnv) && !isUtcLike(fromEnv)) return (cached = fromEnv);
  for (const f of CANDIDATES) {
    try {
      const name = fs.readFileSync(f, 'utf8').trim();
      if (validIana(name) && !isUtcLike(name)) return (cached = name);
    } catch {}
  }
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    // 容器里通常是 UTC/Etc/UTC：手机几乎不可能是纯 UTC，此时按站点主场 +08:00 兜底
    if (validIana(tz) && !isUtcLike(tz)) return (cached = tz);
  } catch {}
  return (cached = 'Asia/Shanghai');
}

/** 当前时刻在该时区的偏移（秒，东八区 = 28800），和浏览器 `-getTimezoneOffset()*60` 同口径 */
export function tzOffsetSeconds(now = Date.now()) {
  const tz = deviceTimeZone();
  try {
    const dtf = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hour12: false,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
    const p = {};
    for (const { type, value } of dtf.formatToParts(new Date(now))) p[type] = value;
    const asUTC = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second);
    return Math.round((asUTC - Math.floor(now / 1000) * 1000) / 1000);
  } catch {
    return 8 * 3600;
  }
}

/** 该时区的小时（带小数），给作息曲线/深夜判断用 */
export function tzOffsetMinutes(now = Date.now()) {
  return tzOffsetSeconds(now) / 60;
}
