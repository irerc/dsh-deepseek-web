// 对 chat.deepseek.com 的基础 HTTP 调用：统一 UA / 客户端头 / 超时 / 错误分类
import { deviceId, deviceIdFor } from './device.mjs';
import { tzOffsetSeconds } from './timezone.mjs';

export const BASE = 'https://chat.deepseek.com';
export const UA =
  'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36';

export class UpstreamError extends Error {
  constructor(message, { status = 0, code = '', kind = 'upstream' } = {}) {
    super(message);
    this.name = 'UpstreamError';
    this.status = status;
    this.code = code;
    this.kind = kind; // auth | rate | upstream | network
  }
}

export function baseHeaders(token, accountId = '') {
  const headers = {
    'content-type': 'application/json',
    'user-agent': UA,
    origin: BASE,
    referer: BASE + '/',
    'x-client-platform': 'web',
    'x-client-version': '2.7.0',
    'x-client-locale': 'zh_CN',
    'x-client-bundle-id': 'com.deepseek.chat',
    // 容器是 UTC、手机是 +08:00：这个头必须跟真人浏览器一致，否则和 UA/locale 自相矛盾
    'x-client-timezone-offset': String(tzOffsetSeconds()),
    // 站点用 x-device-id 认设备（UUID v4）。以前引擎请求完全不带头，站点会把插件的请求当成
    // 「新设备」；现在和浏览器登录页、密码登录共用同一个 id，账号在站点看来始终是同一台设备。
    // 每个账号一套设备 id：一个号被封，站点只知道「那台设备」，不会顺带把同机其它号一起处理。
    'x-device-id': accountId ? deviceIdFor(accountId) : deviceId(),
    'x-device-model': '',
  };
  if (token) headers.authorization = 'Bearer ' + token;
  return headers;
}

/**
 * Chrome 在页内发 fetch 时会带的一组「浏览器才有」的头。
 * 不是玄学：缺 sec-fetch-* / sec-ch-ua 的 XHR 在服务端日志里一眼就能区别出来。
 * 只用在不走真实浏览器的两条路上（native / node）——浏览器档由 Chrome 自己生成。
 * 版本号与 UA、impersonate 保持一致（Chrome 131 / Android）。
 */
export function humanHeaders() {
  return {
    accept: '*/*',
    'sec-ch-ua': '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"',
    'sec-ch-ua-mobile': '?1',
    'sec-ch-ua-platform': '"Android"',
    'sec-fetch-site': 'same-origin',
    'sec-fetch-mode': 'cors',
    'sec-fetch-dest': 'empty',
    'accept-language': 'zh-CN,zh;q=0.9',
  };
}

// 统一出站钩子：由引擎注入，把 post/get（登录、体检、PoW、建会话……）也交给同一个传输档。
// 不注入时退回 Node 直连 —— 单测/独立工具仍然能用，但生产环境同一账号不会混用两套 TLS 栈。
let upstreamHook = null;
export function setUpstreamHook(fn) {
  upstreamHook = typeof fn === 'function' ? fn : null;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** JSON 请求；返回 { status, json, text } */
export async function post(path, body, { token = null, headers = {}, timeoutMs = 30000, signal = null, _raw = false } = {}) {
  if (upstreamHook && !_raw && !signal) {
    return upstreamHook({ path, method: 'POST', token: token || '', headers, body: JSON.stringify(body ?? {}), timeoutMs });
  }
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(new Error('timeout')), timeoutMs);
  const onAbort = () => ac.abort(signal.reason);
  if (signal) signal.addEventListener('abort', onAbort, { once: true });
  try {
    const res = await fetch(BASE + path, {
      method: 'POST',
      headers: { ...baseHeaders(token), ...headers },
      body: JSON.stringify(body ?? {}),
      signal: ac.signal,
    });
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {}
    return { status: res.status, json, text };
  } catch (error) {
    throw new UpstreamError('网络请求失败：' + (error.message || error), { kind: 'network' });
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onAbort);
  }
}

export async function get(path, { token = null, timeoutMs = 30000, headers = {}, _raw = false } = {}) {
  if (upstreamHook && !_raw) {
    return upstreamHook({ path, method: 'GET', token: token || '', headers, timeoutMs });
  }
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(new Error('timeout')), timeoutMs);
  try {
    const res = await fetch(BASE + path, { headers: baseHeaders(token), signal: ac.signal });
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {}
    return { status: res.status, json, text };
  } catch (error) {
    throw new UpstreamError('网络请求失败：' + (error.message || error), { kind: 'network' });
  } finally {
    clearTimeout(timer);
  }
}

/** 从站点返回体里判断错误类型 */
export function classify(result, what = '上游') {
  const code = result?.json?.code;
  const biz = result?.json?.data?.biz_code;
  const msg = result?.json?.msg || result?.json?.data?.biz_msg || result?.text?.slice(0, 200) || '';
  if (result.status === 401 || code === 40003 || code === 40002) {
    return new UpstreamError(`${what}登录态失效：${msg}`, { status: result.status, code: String(code), kind: 'auth' });
  }
  // 网页版限流不走 HTTP 429：站点用业务码 40029（按 IP 限流）或「操作过于频繁」这类文案回 200。
  // 以前这些都被当成普通 upstream 错误直接抛给上层，既没冷却也没退避，紧接着再发只会再撞一次。
  if (result.status === 429 || code === 40029 || /过于频繁|太频繁|操作频繁|too\s+many\s+requests|rate\s*limit|稍后重试/i.test(msg)) {
    return new UpstreamError(`${what}被限流：${msg}`, { status: result.status || 429, code: String(code || ''), kind: 'rate' });
  }
  // 数美人机验证：站点不报错，只回一个挑战。当成「空回复」处理会让人误以为是插件坏了。
  if (code === 40303 || /CHALLENGE_REQUIRED/i.test(msg)) {
    return new UpstreamError(
      `${what}要求人机验证（数美）：在「登录」页用真实浏览器完成一次空间点选，或等 10~30 分钟冷却，插件会自动恢复。`,
      { status: result.status, code: '40303', kind: 'challenge' },
    );
  }
  if (result.status >= 500) {
    return new UpstreamError(`${what}服务异常（${result.status}）：${msg}`, { status: result.status, kind: 'upstream' });
  }
  return new UpstreamError(`${what}失败（${result.status}）：${msg}`, { status: result.status, code: String(code ?? biz ?? ''), kind: 'upstream' });
}

/** 带退避的重试包装：只对网络/5xx 重试，401/429 交给上层切账号 */
export async function withRetry(fn, { attempts = 3, baseMs = 800 } = {}) {
  let lastError;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn(i);
    } catch (error) {
      lastError = error;
      if (error.kind === 'auth' || error.kind === 'rate') throw error;
      if (i === attempts - 1) throw error;
      await sleep(baseMs * Math.pow(2, i) + Math.floor(Math.random() * 300));
    }
  }
  throw lastError;
}
