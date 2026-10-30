// 对 chat.deepseek.com 的基础 HTTP 调用：统一 UA / 客户端头 / 超时 / 错误分类
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

export function baseHeaders(token) {
  const headers = {
    'content-type': 'application/json',
    'user-agent': UA,
    origin: BASE,
    referer: BASE + '/',
    'x-client-platform': 'web',
    'x-client-version': '2.7.0',
    'x-client-locale': 'zh_CN',
    'x-client-bundle-id': 'com.deepseek.chat',
    'x-client-timezone-offset': String(-new Date().getTimezoneOffset() * 60),
  };
  if (token) headers.authorization = 'Bearer ' + token;
  return headers;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** JSON 请求；返回 { status, json, text } */
export async function post(path, body, { token = null, headers = {}, timeoutMs = 30000, signal = null } = {}) {
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

export async function get(path, { token = null, timeoutMs = 30000 } = {}) {
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
  if (result.status === 429) {
    return new UpstreamError(`${what}被限流：${msg}`, { status: 429, kind: 'rate' });
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
