// 登录用反向代理：把 chat.deepseek.com 镜像到本机独立 origin（默认 127.0.0.1:18090）
//
// 目的：让用户在插件里直接看到真实的 DeepSeek 登录页（含验证码/人机验证），
//       登录成功后由注入的脚本把 localStorage.userToken 自动回传给插件。
//
// 安全：独立端口 = 独立 origin，不会和 DSH 页面共享 localStorage。
import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const STATE_DIR = process.env.DSH_DEEPSEEK_WEB_STATE || path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'state');
const SID_COOKIE = 'dsweb_sid';
function jarFile(sid) {
  return path.join(STATE_DIR, 'jar-' + sid.replace(/[^a-zA-Z0-9_-]/g, '') + '.json');
}
function readJar(sid) {
  try { return JSON.parse(fs.readFileSync(jarFile(sid), 'utf8')); } catch { return {}; }
}
function writeJar(sid, jar) {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.writeFileSync(jarFile(sid), JSON.stringify(jar), { mode: 0o600 });
  } catch {}
}
function cookieHeader(jar) {
  return Object.entries(jar).map(([k, v]) => k + '=' + v).join('; ');
}
export function readCookiesBySid(sid) {
  return cookieHeader(readJar(sid));
}

function logLine(line) {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.appendFileSync(path.join(STATE_DIR, 'proxy.log'), new Date().toISOString() + ' ' + line + '\n');
  } catch {}
}

import { loadConfig } from './config.mjs';

const DEFAULT_SITE = 'chat.deepseek.com';
const REGION_HEADERS = {
  // 国内：中文界面 + 手机号/微信登录
  cn: { 'accept-language': 'zh-CN,zh;q=0.9', 'x-client-locale': 'zh_CN', 'x-client-browser-lang': 'zh-CN' },
  // 海外：英文界面 + 邮箱/Google 登录，可直接注册国外 DeepSeek 账号
  global: { 'accept-language': 'en-US,en;q=0.9', 'x-client-locale': 'en_US', 'x-client-browser-lang': 'en-US' },
};
function siteHost() {
  const host = String(loadConfig().loginHost || '').trim();
  return host || DEFAULT_SITE;
}
const CDN = 'fe-static.deepseek.com';
const CDN_PREFIX = '/chat/';
const UA =
  'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36';

const INJECT = `
<script>
(function () {
  var posted = false;
  var _fetch = window.fetch;
  if (_fetch) {
    window.fetch = function (input, init) {
      var url = typeof input === 'string' ? input : (input && input.url) || '';
      var t0 = Date.now();
      var slow = setTimeout(function () { tip('请求超时 15s 仍未返回：' + url); }, 15000);
      return _fetch.call(this, input, init).then(function (r) {
        clearTimeout(slow);
        if (!r.ok) tip('API ' + r.status + ' ' + url);
        // 登录/注册这类接口：把上游真实原因摊开，方便判断是风控、验证码过期还是字段问题
        if (/\/api\/v0\/users\//.test(url)) {
          try {
            r.clone().text().then(function (t) {
              if (!t) return;
              if (t.indexOf('"code":0') < 0 || /"biz_code":[1-9]/.test(t)) {
                tip('服务端返回（' + url.split('?')[0] + '）：' + String(t).slice(0, 300));
              }
            }, function () {});
          } catch (e) {}
        }
        return r;
      }, function (e) {
        clearTimeout(slow);
        tip('网络失败 ' + url + ' · ' + (e && e.message ? e.message : e));
        throw e;
      });
    };
  }
  var _err = console.error;
  console.error = function () {
    try { tip('console.error: ' + Array.prototype.map.call(arguments, function (a) { return a && a.message ? a.message : String(a); }).join(' ')); } catch (e) {}
    return _err.apply(console, arguments);
  };
  var _open = XMLHttpRequest.prototype.open;
  var _send = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (m, u) { this.__u = u; return _open.apply(this, arguments); };
  XMLHttpRequest.prototype.send = function () {
    var xhr = this;
    xhr.addEventListener('loadend', function () {
      if (xhr.status === 0 || xhr.status >= 400) tip('XHR ' + xhr.status + ' ' + xhr.__u);
    });
    return _send.apply(this, arguments);
  };
  function status() {
    var el = document.getElementById('__dsweb_status');
    if (!el) {
      el = document.createElement('div');
      el.id = '__dsweb_status';
      el.style.cssText = 'position:fixed;left:6px;top:6px;z-index:2147483647;font:11px monospace;background:rgba(0,0,0,.8);color:#7bd88f;padding:6px 8px;border-radius:6px;max-width:92vw;white-space:pre-wrap';
      document.body.appendChild(el);
    }
    var root = document.getElementById('root');
    var scripts = Array.prototype.map.call(document.scripts, function (s) {
      return (s.src ? s.src.split('/').pop() : 'inline').slice(0, 26);
    });
    var rootLen = root ? root.innerHTML.length : -1;
    el.textContent = 'ds-web [__DSW_REGION__] | ' + document.readyState + ' | root子=' + (root ? root.children.length : -1) + ' len=' + rootLen +
      ' | 脚本=' + scripts.length + ' 已载=' + (window.__dsLoaded || 0) + ' 失败=' + (window.__dsErr || 0) +
      (window.__dsErrSrc ? ' [' + String(window.__dsErrSrc).split('/').pop() + ']' : '') + ' | ' + location.pathname;
  }
  // 让浏览器的密码管理器能识别登录表单：补 autocomplete/name，并包成可识别的字段
  function tagLoginForm() {
    var pass = document.querySelector('input[type=password]');
    if (!pass) return;
    if (pass.getAttribute('autocomplete') !== 'current-password') {
      pass.setAttribute('autocomplete', 'current-password');
      pass.setAttribute('name', 'password');
      pass.setAttribute('id', pass.id || 'dsweb-password');
    }
    var scope = pass.closest('form') || document.body;
    var user = scope.querySelector('input[type=email], input[type=tel], input[type=text]');
    if (user && user !== pass && user.getAttribute('autocomplete') !== 'username') {
      user.setAttribute('autocomplete', 'username');
      user.setAttribute('name', 'username');
      user.setAttribute('id', user.id || 'dsweb-username');
    }
  }
  document.addEventListener('DOMContentLoaded', tagLoginForm);
  setInterval(tagLoginForm, 1200);

  document.addEventListener('DOMContentLoaded', status);
  setInterval(status, 1500);
  setTimeout(function () {
    var root = document.getElementById('root');
    var n = root ? root.children.length : -1;
    if (n <= 0) tip('应用还没有渲染（root 子节点=' + n + '）');
  }, 8000);
  function tip(msg) {
    try { console.log('[dsweb]', msg); } catch (e) {}
    var el = document.getElementById('__dsweb_tip');
    if (!el) { el = document.createElement('div'); el.id = '__dsweb_tip'; el.style.cssText = 'position:fixed;left:8px;bottom:8px;right:8px;z-index:99998;font:12px monospace;background:rgba(0,0,0,.82);color:#ffd479;padding:8px;border-radius:8px;max-height:35vh;overflow:auto;white-space:pre-wrap'; document.body.appendChild(el); }
    el.textContent += (el.textContent ? '\\n' : '') + msg;
  }
  window.addEventListener('error', function (e) {
    var t = e && e.target;
    if (t && (t.src || t.href)) tip('资源加载失败: ' + (t.src || t.href));
    else tip('JS 错误: ' + (e.message || '') + (e.filename ? ' @ ' + e.filename + ':' + e.lineno : ''));
  }, true);
  window.addEventListener('unhandledrejection', function (e) {
    tip('Promise 失败: ' + (e.reason && (e.reason.message || e.reason)));
  });
  function report(token) {
    if (posted || !token) return;
    posted = true;
    fetch('__DSH_REPORT__', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        token: token,
        label: '浏览器登录',
        sid: (document.cookie.match(/(?:^|;\s*)dsweb_sid=([^;]+)/) || [])[1] || ''
      })
    }).then(function (r) { return r.json(); }).then(function (d) {
      var el = document.getElementById('__dsweb_tip');
      if (el) el.textContent = d && d.ok ? '已保存到 DSH 插件，可以关闭本页了 ✓' : '保存失败：' + JSON.stringify(d);
      // 登录成功后做一次真实跳转，方便浏览器密码管理器触发“保存密码”提示
      if (d && d.ok) setTimeout(function () { if (location.pathname !== '/') location.href = '/'; }, 1200);
    }).catch(function (e) {
      posted = false;
      var el = document.getElementById('__dsweb_tip');
      if (el) el.textContent = '回传失败：' + e.message;
    });
  }
  function poll() {
    try {
      var raw = localStorage.getItem('userToken');
      if (raw) {
        var token = '';
        try { token = JSON.parse(raw).value || ''; } catch (e) { token = ''; }
        if (token) report(token);
      }
    } catch (e) {}
    setTimeout(poll, 1500);
  }
  poll();
})();
</script>
<div id="__dsweb_tip" style="position:fixed;left:8px;bottom:8px;z-index:99999;font:12px sans-serif;background:rgba(0,0,0,.75);color:#fff;padding:6px 10px;border-radius:8px;pointer-events:none">登录后会自动保存到 DSH，无需复制 token</div>
<div style="position:fixed;right:8px;top:64px;z-index:99999;display:flex;flex-direction:column;gap:6px;align-items:flex-end">
  <a id="__dsweb_signup" href="/sign_up" style="font:12px sans-serif;background:rgba(80,140,255,.22);color:#cfe0ff;border:1px solid rgba(120,170,255,.5);padding:6px 10px;border-radius:8px;text-decoration:none">没有账号？邮箱注册</a>
  <button onclick="(function(){try{localStorage.removeItem('userToken');localStorage.clear();}catch(e){};alert('已退出本页登录（插件里的 token 不受影响）');location.href='/sign_in';})()" style="font:12px sans-serif;background:rgba(255,255,255,.12);color:#fff;border:1px solid rgba(255,255,255,.25);padding:6px 10px;border-radius:8px">退出本页登录</button>
</div>
<script>
(function () {
  var hint = null;
  function syncAuthUi() {
    try {
      var onSignUp = location.pathname.indexOf('/sign_up') === 0;
      var a = document.getElementById('__dsweb_signup');
      if (a) a.style.display = onSignUp ? 'none' : '';
      // 注册页会做人机验证，本地反代域（127.0.0.1）过不了验证时按钮会一直转圈。
      // 这里给一条可用替代路径：登录页用邮箱验证码，首次登录即自动创建账号。
      if (onSignUp && !hint) {
        hint = document.createElement('div');
        hint.style.cssText = 'position:fixed;left:8px;top:64px;right:120px;z-index:99997;font:12px sans-serif;background:rgba(255,180,60,.14);color:#ffd479;border:1px solid rgba(255,180,60,.45);padding:8px 10px;border-radius:8px;line-height:1.6';
        hint.innerHTML = '注册按钮一直转圈？多半是站点人机验证无法在本地反代域名下完成。<br>' +
          '请点「返回登录」，用 <b>邮箱验证码</b> 登录：第一次登录会自动创建账号，效果与注册相同。';
        document.body.appendChild(hint);
      } else if (!onSignUp && hint) {
        hint.remove();
        hint = null;
      }
    } catch (e) {}
  }
  syncAuthUi();
  window.addEventListener('popstate', syncAuthUi);
  setInterval(syncAuthUi, 1200);
})();
</script>
`;

function filterRequestHeaders(headers) {
  const out = {};
  const allow = [
    'accept',
    'accept-language',
    'content-type',
    'cookie',
    'authorization',
    'origin',
    'referer',
    'x-client-platform',
    'x-client-version',
    'x-client-locale',
    'x-client-bundle-id',
    'x-client-timezone-offset',
    'x-request-encryption-key',
    'x-ds-pow-response',
    'x-device-id',
  ];
  for (const [k, v] of Object.entries(headers)) {
    if (allow.includes(k.toLowerCase())) out[k] = v;
  }
  out['user-agent'] = UA;
  // 登录线路：国内 / 海外。站点前端读 x-client-locale 决定语言与可用登录方式，
  // 想用邮箱注册国外账号就必须让这一步呈现英文登录页。
  const region = loadConfig().loginRegion || 'auto';
  const site = siteHost();
  if (region !== 'auto' && REGION_HEADERS[region]) Object.assign(out, REGION_HEADERS[region]);
  // 站点会校验来源：统一伪装成自己的 origin
  out.origin = 'https://' + site;
  out.referer = 'https://' + site + '/';
  return out;
}

function filterResponseHeaders(headers) {
  const out = {};
  for (const [k, v] of Object.entries(headers)) {
    const key = k.toLowerCase();
    if (['content-security-policy', 'content-security-policy-report-only', 'x-frame-options', 'connection', 'transfer-encoding', 'content-encoding', 'content-length'].includes(key)) continue;
    if (key === 'set-cookie') {
      const list = Array.isArray(v) ? v : [v];
      out['set-cookie'] = list.map((c) => String(c).replace(/;\s*Domain=[^;]+/gi, '').replace(/;\s*Secure/gi, ''));
      continue;
    }
    if (key === 'location') {
      out.location = String(v).replace(/^https?:\/\/(?:chat\.deepseek\.com|[^/]+)/i, '');
      continue;
    }
    out[k] = v;
  }
  return out;
}


// ---- 静态资源兜底：CDN 偶发 hangs/断连时，先重试，再退回磁盘缓存，别让登录页白屏 ----
const ASSET_DIR = path.join(STATE_DIR, 'assets');
function assetKey(url) {
  try {
    const u = new URL(url);
    return u.origin + u.pathname; // 丢掉 ?t= 这类缓存破坏参数
  } catch {
    return String(url).split('?')[0];
  }
}
function assetPath(url) {
  const hash = crypto.createHash('sha1').update(assetKey(url)).digest('hex');
  return path.join(ASSET_DIR, hash);
}
/** 缓存目录别无限长：只保留最近 30 个文件 */
function pruneAssets() {
  try {
    const files = fs.readdirSync(ASSET_DIR).map((f) => {
      const full = path.join(ASSET_DIR, f);
      return { full, mtime: fs.statSync(full).mtimeMs };
    });
    files.sort((a, b) => b.mtime - a.mtime);
    for (const f of files.slice(30)) fs.rmSync(f.full, { force: true });
  } catch {}
}
function readAsset(url) {
  try { return fs.readFileSync(assetPath(url)); } catch { return null; }
}
function writeAsset(url, buf) {
  try {
    fs.mkdirSync(ASSET_DIR, { recursive: true });
    fs.writeFileSync(assetPath(url), buf);
  } catch {}
}
function fetchUpstream(target, method, headers, body, attempts = 3, timeoutMs = 12000) {
  let lastError = null;
  const run = (n) =>
    new Promise((resolve) => {
      const req = https.request(target, { method, headers }, (up) => {
        const chunks = [];
        up.on('data', (c) => chunks.push(c));
        up.on('end', () => resolve({ up, buf: Buffer.concat(chunks) }));
        up.on('error', (e) => resolve({ error: e }));
      });
      req.setTimeout(timeoutMs, () => {
        req.destroy(new Error('timeout'));
      });
      req.on('error', (e) => {
        lastError = e;
        req.destroy();
        resolve({ error: e });
      });
      req.end(body && body.length ? body : undefined);
    }).then((r) => {
      if (r.error && n < attempts) {
        logLine('RETRY(' + n + '/' + attempts + ') ' + target + ' ' + r.error.message);
        return run(n + 1);
      }
      return r;
    });
  return run(1).then((r) => (r.error ? { error: lastError || r.error } : r));
}

export function startLoginProxy({ port = 18090, reportUrl }) {
  const server = http.createServer(async (req, res) => {
    const isCdn = req.url.startsWith('/cdn/');
    const upstreamHost = isCdn ? CDN : siteHost();
    const upstreamPath = isCdn ? CDN_PREFIX + req.url.slice('/cdn/'.length) : req.url;
    const target = `https://${upstreamHost}${upstreamPath.startsWith('/') ? upstreamPath : '/' + upstreamPath}`;
    // 先把请求体读完再转发：带 content-length 的定长请求比 chunked 更不容易被 WAF 拒绝
    const bodyChunks = [];
    for await (const chunk of req) bodyChunks.push(chunk);
    const body = Buffer.concat(bodyChunks);
    const headers = filterRequestHeaders(req.headers);
    // 会话 cookie：用我们自己的 dsweb_sid 关联一个 cookie jar，登录时捕获站点下发的 cookie
    const rawCookie = String(req.headers.cookie || '');
    let sid = (rawCookie.match(new RegExp('(?:^|;\\s*)' + SID_COOKIE + '=([^;]+)')) || [])[1] || '';
    if (!sid) sid = Math.random().toString(36).slice(2) + Date.now().toString(36);
    const jar = readJar(sid);
    const upstreamCookie = [rawCookie.split(';').map((x) => x.trim()).filter((x) => x && !x.startsWith(SID_COOKIE + '=')).join('; '), cookieHeader(jar)].filter(Boolean).join('; ');
    if (upstreamCookie) headers.cookie = upstreamCookie;
    if (body.length) headers['content-length'] = String(body.length);

    // 静态资源（/cdn/…）：带重试 + 磁盘缓存，CDN 抽风也不至于白屏
    if (isCdn) {
      // 快速重试（6s × 2）；失败后立刻回缓存，别让用户对着白屏等 30 秒
      const r = await fetchUpstream(target, req.method, headers, body, 2, 6000);
      const ctype0 = r.up ? String(r.up.headers['content-type'] || '') : '';
      const good = r.up && (r.up.statusCode || 0) === 200 && /javascript|text\/css|font|image|octet-stream/.test(ctype0);
      if (!good) {
        const cached = readAsset(target);
        if (cached) {
          logLine('CACHE-HIT ' + req.url);
          const ext = path.extname(new URL(target).pathname).toLowerCase();
          const type = ext === '.js' ? 'application/javascript; charset=utf-8' : ext === '.css' ? 'text/css; charset=utf-8' : 'application/octet-stream';
          res.writeHead(200, { 'content-type': type, 'cache-control': 'public, max-age=600' });
          res.end(cached);
          return;
        }
        logLine('ERROR ' + (req.method || 'GET') + ' ' + req.url + ' ' + ((r.error && r.error.message) || 'unknown'));
        res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('资源加载失败（已重试 3 次）：' + ((r.error && r.error.message) || 'unknown'));
        return;
      }
      const ctype = ctype0;
      let buf = r.buf;
      if (ctype.includes('javascript')) {
        let js = buf.toString('utf8');
        // 让站点认为自己在生产环境（否则用 dev 公钥，登录解密会被服务端拒绝）
        js = js.replace('if(e.match(/(\\d{1,3}\\.){3,3}\\d{1,3}/))return"dev";', 'if(true)return"production";');
        js = js.split('"https://fe-static.deepseek.com/chat/"').join('"/cdn/"');
        buf = Buffer.from(js, 'utf8');
      }
      if (good && buf.length > 1024 && /javascript|text\/css/.test(ctype)) {
        writeAsset(target, buf);
        pruneAssets();
      }
      const outHeaders = filterResponseHeaders(r.up.headers);
      outHeaders['content-length'] = String(buf.length);
      res.writeHead(r.up.statusCode || 200, outHeaders);
      res.end(buf);
      return;
    }

    const send = (attempt) => {
    const upstream = https.request(
      target,
      {
        method: req.method,
        headers,
      },
      (up) => {
        const headers = filterResponseHeaders(up.headers);
        const existing = headers['set-cookie'] || [];
        headers['set-cookie'] = [].concat(existing, SID_COOKIE + '=' + sid + '; Path=/; SameSite=Lax');
        const setCookies = up.headers['set-cookie'] || [];
        if (setCookies.length) {
          for (const c of setCookies) {
            const m = String(c).match(/^([^=;]+)=([^;]*)/);
            if (m && m[1] !== SID_COOKIE) jar[m[1]] = m[2];
          }
          writeJar(sid, jar);
        }
        const isHtml2 = String(up.headers['content-type'] || '').includes('text/html');
        const isJs2 = String(up.headers['content-type'] || '').includes('javascript');
        if (!isCdn && !isJs2 && !isHtml2) {
          const chunks2 = [];
          up.on('data', (c) => chunks2.push(c));
          const origEnd = up.listeners('end');
          up.on('end', () => {
            const text = Buffer.concat(chunks2).toString('utf8').slice(0, 400).replace(/\s+/g, ' ');
            logLine((req.method || 'GET') + ' ' + req.url + ' -> ' + (up.statusCode || 0) + ' reqBody=' + body.length + ' resp=' + text);
          });
        } else if (!isCdn) {
          logLine((req.method || 'GET') + ' ' + req.url + ' -> ' + (up.statusCode || 0) + ' reqBody=' + body.length);
        }
        const isHtml = String(up.headers['content-type'] || '').includes('text/html');
        const isJs = String(up.headers['content-type'] || '').includes('javascript');
        if (isJs) {
          const jsChunks = [];
          up.on('data', (c) => jsChunks.push(c));
          up.on('end', () => {
            let js = Buffer.concat(jsChunks).toString('utf8');
            // 让站点认为自己在生产环境（否则用 dev 公钥，登录解密会被服务端拒绝）
            js = js.replace('if(e.match(/(\\d{1,3}\\.){3,3}\\d{1,3}/))return"dev";', 'if(true)return"production";');
            // 懒加载 chunk 也走代理
            js = js.split('"https://fe-static.deepseek.com/chat/"').join('"/cdn/"');
            res.writeHead(up.statusCode || 200, { ...headers, 'content-type': 'application/javascript; charset=utf-8' });
            res.end(js);
          });
          return;
        }
        if (!isHtml) {
          res.writeHead(up.statusCode || 502, headers);
          up.pipe(res);
          return;
        }
        const chunks = [];
        up.on('data', (c) => chunks.push(c));
        up.on('end', () => {
          let html = Buffer.concat(chunks).toString('utf8');
          // 站点资源改走本代理，避免跨域与 CSP 干扰
          html = html.split('https://fe-static.deepseek.com/chat/').join('/cdn/');
          // 去掉 SRI：我们会改写 main.js（强制生产环境 + chunk 走代理），原哈希必然不匹配
          html = html.replace(/\s+integrity="[^"]*"/g, '').replace(/\s+onerror="_sriCk\(this\)"/g, '');
          var bust = '?t=' + Date.now();
          html = html.replace(/(\/cdn\/[^"']+?\.(?:js|css))(?!\?)/g, '$1' + bust);
          // 给脚本打上加载计数，便于状态面板判断 main.js 是否真的跑起来
          html = html.replace(/<script([^>]*?)src="([^"]+)"/g, function (m, pre, src) {
            return '<script' + pre + ' data-dsweb="' + src.split('/').pop() + '" onload="window.__dsLoaded=(window.__dsLoaded||0)+1" onerror="window.__dsErr=(window.__dsErr||0)+1;window.__dsErrSrc=this.src" src="' + src + '"';
          });
          const regionLabel = (loadConfig().loginRegion === 'global' ? '海外' : loadConfig().loginRegion === 'cn' ? '国内' : '自动') + '·' + siteHost();
          const snippet = INJECT.replace('__DSH_REPORT__', reportUrl).replace('__DSW_REGION__', regionLabel);
          html = html.includes('</body>') ? html.replace('</body>', snippet + '</body>') : html + snippet;
          res.writeHead(up.statusCode || 200, { ...headers, 'content-type': 'text/html; charset=utf-8' });
          res.end(html);
        });
      },
    );
    upstream.setTimeout(8000, () => {
      logLine('TIMEOUT(' + attempt + ') ' + (req.method || 'GET') + ' ' + req.url);
      upstream.destroy(new Error('timeout'));
    });
    upstream.on('error', (error) => {
      // 站点偶尔会抽风（连接被掐断/超时）。GET 请求重试最多 3 次；POST 不重试，避免重复提交登录。
      const canRetry = req.method === 'GET' && attempt < 2 && !res.headersSent;
      if (canRetry) {
        logLine('RETRY(' + attempt + '/3) ' + req.url + ' ' + error.message);
        setTimeout(() => send(attempt + 1), 300);
        return;
      }
      logLine('ERROR ' + (req.method || 'GET') + ' ' + req.url + ' ' + error.message + (process.env.DSW_PROXY_DEBUG ? ' headers=' + JSON.stringify(headers) : ''));
      if (res.headersSent) return res.end();
      res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('代理失败：' + error.message);
    });
    upstream.end(body.length ? body : undefined);
    };
    send(1);
  });
  server.listen(port, '127.0.0.1');
  return server;
}
