// 「真·手机浏览器」传输：接管手机上已经在跑的 Chrome / Edge / WebView 的调试端口，
// 让聊天请求从**那台真浏览器**里发出去。
//
// 为什么值得单独做一层：前面的 native 档（curl_cffi）能复刻 TLS / HTTP/2 指纹，但复刻不了
// 「这是不是一台真实的 Chromium 在发包」——证书链、扩展协商、HTTP/2 帧节奏、系统 DNS、
// 甚至浏览器自己维护的 cookie 滚动更新，只有真浏览器才有。代价是慢（每次请求都要过 CDP、
// 页面要一直开着、手机耗电），所以做成显式开关，不默认开。
//
// 它能连上的前提（都是 Android 侧的现实约束，不是代码能绕过的）：
//   1) Chrome 必须以 --remote-debugging-port=<端口> 启动，于是监听 127.0.0.1:<端口>；
//      非 root 设备需要先在 chrome://flags 打开「Enable command line on non-rooted devices」，
//      再把参数写进 /data/local/tmp/chrome-command-line，然后彻底退出 Chrome 重开。
//   2) 本容器要能连到那个 127.0.0.1:<端口>（同一网络命名空间）。
//   3) 若 Chrome 只开了 abstract socket（@chrome_devtools_remote）而没开 TCP 端口，
//      SELinux 会拦跨应用 unix socket（实测 EACCES），此时必须改走 TCP 端口。
// 这些都不满足时，这一层不会假装能用——它把确切原因带回界面。
import net from 'node:net';
import fs from 'node:fs';

export const DEFAULT_PORTS = [9222, 9223, 9224, 9333];
const CACHE_MS = 60_000;
let cache = null; // { at, value }
let lastProbe = null;

/** 读一下本进程的 SELinux 上下文，用于把「为什么连不上」说清楚 */
function selinuxContext() {
  try {
    return fs.readFileSync('/proc/self/attr/current', 'utf8').replace(/\0/g, '').trim() || '';
  } catch {
    return '';
  }
}

/** 一次极简 HTTP/1.1 GET（只给 CDP 的 /json/* 用） */
function httpGetJson({ port, path = '/json/version', timeoutMs = 1500 }) {
  return new Promise((resolve) => {
    const sock = net.connect({ host: '127.0.0.1', port });
    let buf = '';
    let done = false;
    const finish = (v) => {
      if (done) return;
      done = true;
      try { sock.destroy(); } catch {}
      resolve(v);
    };
    sock.setTimeout(timeoutMs, () => finish({ ok: false, error: 'timeout' }));
    sock.on('error', (e) => finish({ ok: false, error: e.code || 'error' }));
    sock.on('connect', () => {
      sock.write('GET ' + path + ' HTTP/1.1\r\nHost: 127.0.0.1:' + port + '\r\nConnection: close\r\n\r\n');
    });
    sock.on('data', (d) => {
      buf += d.toString('utf8');
      // chrome 的 /json/* 是短响应，收到完整 body 就收工
      const i = buf.indexOf('\r\n\r\n');
      if (i < 0) return;
      const body = buf.slice(i + 4);
      if (!body.trim()) return;
      try { finish({ ok: true, json: JSON.parse(body) }); } catch { finish({ ok: false, error: 'bad-json' }); }
    });
  });
}

/** abstract unix socket 还在不在（在但连不上 = SELinux/权限，不在 = 没开调试） */
function probeAbstractSocket() {
  return new Promise((resolve) => {
    const sock = net.connect({ path: '\0chrome_devtools_remote' });
    sock.setTimeout(1200, () => { try { sock.destroy(); } catch {} resolve('timeout'); });
    sock.on('connect', () => { try { sock.destroy(); } catch {} resolve('open'); });
    sock.on('error', (e) => resolve(e.code || 'error'));
  });
}

async function probeOnce() {
  const ports = (process.env.DS_DEVICE_CDP_PORTS || '')
    .split(',')
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isInteger(n) && n > 0);
  const list = ports.length ? ports : DEFAULT_PORTS;

  for (const port of list) {
    const v = await httpGetJson({ port, path: '/json/version' });
    if (!v.ok || !v.json) continue;
    const targets = await httpGetJson({ port, path: '/json/list' });
    const pages = (Array.isArray(targets.json) ? targets.json : []).filter((t) => t.type === 'page' && t.webSocketDebuggerUrl);
    const target =
      pages.find((t) => String(t.url || '').startsWith('https://chat.deepseek.com')) ||
      pages[0] ||
      null;
    return {
      ok: true,
      via: 'tcp',
      port,
      browser: String(v.json.Browser || ''),
      wsUrl: target ? target.webSocketDebuggerUrl : '',
      pageUrl: target ? String(target.url || '') : '',
      // 没有可用页面目标时，连上 browser 级 ws 也能开新页，但驱动页面更直接：让上层知道要先开页面
      needPage: !target,
      hint: target ? '' : '调试端口已开，但没有可用的页面目标：先在这台浏览器里打开 https://chat.deepseek.com',
      selinux: selinuxContext(),
    };
  }

  const abs = await probeAbstractSocket();
  let reason;
  if (abs === 'open') {
    reason = '调试只开了 unix abstract socket（@chrome_devtools_remote），没有 TCP 端口：本容器无法直接接管，需要让 Chrome 以 --remote-debugging-port=9222 启动';
  } else if (abs === 'EACCES') {
    reason = '检测到 @chrome_devtools_remote，但本容器被 SELinux 拒绝（EACCES，上下文 ' + selinuxContext() + '）：只能改走 TCP 调试端口';
  } else {
    reason = '没有发现手机浏览器的调试端口（' + list.join('/') + '），浏览器也没有开调试';
  }
  return { ok: false, via: '', reason, ports: list, selinux: selinuxContext() };
}

/**
 * 手机浏览器是否可接管（结果缓存 60s，避免每轮请求都探测）
 * @returns {Promise<{ok:boolean, via?:string, wsUrl?:string, browser?:string, reason?:string, hint?:string}>}
 */
export async function deviceBrowserAvailability({ fresh = false, timeoutMs = 2500 } = {}) {
  if (!fresh && cache && Date.now() - cache.at < CACHE_MS) return cache.value;
  const value = await Promise.race([
    probeOnce(),
    new Promise((r) => setTimeout(() => r({ ok: false, reason: '探测超时（' + timeoutMs + 'ms）', timeout: true }), timeoutMs)),
  ]);
  cache = { at: Date.now(), value };
  lastProbe = value;
  return value;
}

export function deviceBrowserStatus() {
  return lastProbe;
}

export function resetDeviceBrowserCache() {
  cache = null;
}
