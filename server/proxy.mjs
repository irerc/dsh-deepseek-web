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

import { loadConfig, STATE_DIR } from './config.mjs';
import { peekTicket, dropTicket } from './autologin.mjs';
import { deviceId, deviceIdFor } from './device.mjs';
import { noteSetCookies } from './cookie-meta.mjs';
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

/* --------------------------- 登录会话（jar） --------------------------- *
 * 每次登录浏览器都会拿到一个 dsweb_sid，服务端 cookie 存在 jar-<sid>.json。
 * 「恢复上次登录」就是把这些 jar 列出来，重开同一个 sid：
 * 站点看到会话 cookie，可能直接就是登录态，页面里的 token 扫描会把 token 再回传一次
 * —— 不需要密码，也不需要再输一次验证码。
 * 这里只记元信息（哪个账号用过、什么时候），cookie 值永远不出这个文件。
 * ------------------------------------------------------------------ */
const SESSIONS_FILE = path.join(STATE_DIR, 'login-sessions.json');

function readSessions() {
  try {
    const doc = JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8'));
    return doc && typeof doc === 'object' ? doc : {};
  } catch {
    return {};
  }
}

function writeSessions(doc) {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.writeFileSync(SESSIONS_FILE, JSON.stringify(doc, null, 2), { mode: 0o600 });
  } catch {}
}

/** 记一笔：这个 sid 上发生过登录回传（token 本身不存这里，只存归属与时间） */
export function noteLoginSession(sid, { accountId = '', email = '', source = '' } = {}) {
  if (!sid) return;
  const doc = readSessions();
  const prev = doc[sid] || {};
  doc[sid] = {
    sid,
    at: Date.now(),
    accountId: accountId || prev.accountId || '',
    email: email || prev.email || '',
    source: source || prev.source || '',
    hits: (prev.hits || 0) + 1,
  };
  // 只保留最近 40 条记录，避免无限增长
  const keys = Object.keys(doc).sort((a, b) => (doc[b].at || 0) - (doc[a].at || 0));
  for (const k of keys.slice(40)) delete doc[k];
  writeSessions(doc);
}

/** 列出本机所有登录会话（有 cookie 的 jar），最近的在前 */
export function listLoginSessions() {
  const doc = readSessions();
  const out = [];
  let files = [];
  try {
    files = fs.readdirSync(STATE_DIR).filter((f) => f.startsWith('jar-') && f.endsWith('.json'));
  } catch {
    files = [];
  }
  for (const file of files) {
    const sid = file.slice(4, -5);
    const full = path.join(STATE_DIR, file);
    let jar = {};
    let mtime = 0;
    let bytes = 0;
    try {
      jar = JSON.parse(fs.readFileSync(full, 'utf8')) || {};
      const st = fs.statSync(full);
      mtime = st.mtimeMs;
      bytes = st.size;
    } catch {
      continue;
    }
    const names = Object.keys(jar);
    if (!names.length) continue;
    const meta = doc[sid] || {};
    out.push({
      sid,
      cookies: names.length,
      // 站点会话 cookie 的名字（不含值），让用户能判断「这是不是还活着的那次」
      names: names.slice(0, 8),
      updatedAt: Math.round(mtime),
      at: meta.at || Math.round(mtime),
      accountId: meta.accountId || '',
      email: meta.email || '',
      source: meta.source || '',
      hits: meta.hits || 0,
      bytes,
    });
  }
  out.sort((a, b) => (b.at || 0) - (a.at || 0));
  return out;
}

/** 删掉一个登录会话（jar + 记录），恢复列表里清理没用的那次 */
export function forgetLoginSession(sid) {
  const clean = String(sid || '').replace(/[^a-zA-Z0-9_-]/g, '');
  if (!clean) return false;
  let removed = false;
  const file = jarFile(clean);
  try {
    if (fs.existsSync(file)) {
      fs.rmSync(file, { force: true });
      removed = true;
    }
  } catch {}
  const doc = readSessions();
  if (doc[clean]) {
    delete doc[clean];
    writeSessions(doc);
    removed = true;
  }
  return removed;
}

function logLine(line) {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.appendFileSync(path.join(STATE_DIR, 'proxy.log'), new Date().toISOString() + ' ' + line + '\n');
  } catch {}
}


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

// 注入脚本放在独立文件里：写正则时不用考虑模板字符串的转义问题
// （曾经因为在模板字符串里写 /users\/(login|mfa)/ 被吃掉反斜杠，整段注入脚本语法错误 → 完全抓不到 token）
const INJECT = fs.readFileSync(new URL('./inject.html', import.meta.url), 'utf8');

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
    // 当前登录链路实际发的是 guest 版 PoW 头（手机号/短信登录）与 challenge 头；
    // 以前白名单里只有旧名，登录请求转发时把这两个头丢了，站点直接 40300 Missing Header。
    'x-ds-guest-pow-response',
    'x-ds-challenge-response',
    'x-device-id',
    'x-device-model',
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
/** 站点 JS 的本地化改写（生产环境标记 + 资源路径走代理） */
function rewriteAsset(target, ctype, buf) {
  if (!String(ctype || '').includes('javascript')) return buf;
  let js = buf.toString('utf8');
  // 让站点认为自己在生产环境（否则用 dev 公钥，登录解密会被服务端拒绝）
  js = js.replace('if(e.match(/(\\d{1,3}\\.){3,3}\\d{1,3}/))return"dev";', 'if(true)return"production";');
  js = js.split('"https://fe-static.deepseek.com/chat/"').join('"/cdn/"');
  return Buffer.from(js, 'utf8');
}

// 后台刷新：同一资源 6 小时内只刷一次，避免每个请求都去撞上游
const assetRefreshAt = new Map();
const assetRefreshing = new Set();
function refreshAssetInBackground(target, headers) {
  const key = assetKey(target);
  const last = assetRefreshAt.get(key) || 0;
  if (Date.now() - last < 6 * 3600 * 1000) return;
  if (assetRefreshing.has(key)) return;
  assetRefreshing.add(key);
  assetRefreshAt.set(key, Date.now());
  fetchUpstream(target, 'GET', headers, Buffer.alloc(0), 1, 4000)
    .then((r) => {
      const ctype = r.up ? String(r.up.headers['content-type'] || '') : '';
      if (!r.up || r.up.statusCode !== 200 || !/javascript|text\/css|font|image|octet-stream|wasm/.test(ctype)) return;
      const buf = rewriteAsset(target, ctype, r.buf);
      if (buf.length > 1024) writeAsset(target, buf);
    })
    .catch(() => {})
    .finally(() => {
      assetRefreshing.delete(key);
      try { pruneAssets(); } catch {}
    });
}

/** 上游彻底失败（连不上 / 一直 202）时给一张能看的页面，而不是空白 iframe 或一行纯文本 */
function retryPage(reason) {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>登录页没加载出来</title><style>body{background:#111;color:#eee;font:14px/1.7 system-ui,sans-serif;padding:24px;max-width:640px;margin:0 auto}
h2{font-size:17px}code{background:#222;padding:1px 5px;border-radius:4px}a{color:#6cf}p{color:#bbb}ul{padding-left:20px}</style></head><body>
<h2>登录页没加载出来</h2>
<p>本机代理连站点这一步失败了：<code>${String(reason || '未知原因').slice(0, 160)}</code></p>
<p>常见原因和办法：</p>
<ul>
<li>网络抖动 / 代理（VPN）不稳定 → 点下面「重试」；</li>
<li>站点风控（WAF 人机验证）间歇性拦截 → 等 20 秒再点「重试」，插件已经会自动重试几次；</li>
<li>还是一直这样 → 关掉这个内嵌窗口，用<b>「用系统浏览器打开」</b>（真实浏览器里站点不会为难你），登录成功后 token 一样会自动回填。</li>
</ul>
<p><a href="javascript:location.reload()" style="display:inline-block;margin-top:8px;padding:8px 14px;border:1px solid #4a7;border-radius:8px;text-decoration:none;color:#9e9">重试</a></p>
</body></html>`;
}

function challengePage() {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>站点风控拦截</title><style>body{background:#111;color:#eee;font:14px/1.7 system-ui,sans-serif;padding:24px;max-width:640px;margin:0 auto}
h2{font-size:17px}code{background:#222;padding:1px 5px;border-radius:4px}a{color:#6cf}p{color:#bbb}</style></head><body>
<h2>这一步被 DeepSeek 的风控拦住了</h2>
<p>返回的是 AWS WAF 的人机验证页（202 challenge），不是你操作错了。常见于短时间反复刷新。</p>
<p>处理办法：</p>
<ul>
<li>等 30 秒，点下面的按钮重试；</li>
<li>还不行就关掉本页，回插件里用 <b>邮箱 + 密码登录</b>（这条路不经过浏览器，不受这里影响）。</li>
</ul>
<p><a href="/" style="display:inline-block;margin-top:8px;padding:8px 14px;border:1px solid #4a7;border-radius:8px;text-decoration:none;color:#9e9">等 30 秒后重试</a></p>
<script>setTimeout(function(){location.href='/';},30000);</script>
</body></html>`;
}

// 到站点的连接复用：每次页面/资源都重新握手，在移动网络 + 代理环境里最容易出现
// 「Client network socket disconnected before secure TLS connection was established」，
// 表现出来就是内嵌登录框一片白。keepAlive 能把这类失败压下去一大半。
const upstreamAgent = new https.Agent({ keepAlive: true, keepAliveMsecs: 30000, maxSockets: 16, maxFreeSockets: 8 });

// 登录页 HTML 缓存：WAF 是间歇性的（同一分钟里 200 / 202 交替），
// 只要成功拿到过一次完整页面，接下来 30 分钟即使上游又被 202 挡住，也能把页面发出来，
// 不至于让用户对着空白 iframe 发呆。
const PAGE_TTL_MS = 30 * 60 * 1000;
function pageKey(target) {
  // 页面 HTML 与查询串无关（__dsweb_acct / __dsweb_auto 都是前端运行时读的），
  // 统一按 path 缓存：不同账号的登录链接共用同一份页面，命中率更高、更抗风控。
  try {
    const u = new URL(target);
    return 'page::' + u.origin + u.pathname;
  } catch {
    return 'page::' + String(target).split('?')[0];
  }
}
function readPage(target) {
  try {
    const file = assetPath(pageKey(target));
    const st = fs.statSync(file);
    if (Date.now() - st.mtimeMs > PAGE_TTL_MS) return null;
    return fs.readFileSync(file);
  } catch {
    return null;
  }
}
const pageRefreshing = new Set();
function writePage(target, buf) {
  try {
    writeAsset(pageKey(target), buf);
  } catch {}
}

function fetchUpstream(target, method, headers, body, attempts = 3, timeoutMs = 12000) {
  let lastError = null;
  const run = (n) =>
    new Promise((resolve) => {
      const req = https.request(target, { method, headers, agent: upstreamAgent }, (up) => {
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
    // ---- 本机专用接口：登录页凭票据取回要自动填写的账号密码（不转发给站点）----
    // 页面与这里同源（都是 127.0.0.1:18090），所以不需要 CORS。
    if (req.method === 'GET' && req.url.startsWith('/__dsweb/prefill')) {
      let ticket = '';
      try { ticket = new URL(req.url, 'http://127.0.0.1').searchParams.get('t') || ''; } catch {}
      const info = peekTicket(ticket);
      logLine('AUTOFILL ' + (info ? 'ok' : 'miss') + (info?.accountId ? ' account=' + info.accountId : ''));
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      res.end(
        JSON.stringify(
          info
            ? { ok: true, email: info.email || '', password: info.password || '', accountId: info.accountId || '', ticket }
            : { ok: false, message: '自动登录票据已过期，请回到插件设置页再点一次「浏览器登录」' },
        ),
      );
      return;
    }
    // ---- 诊断：登录页打不开时先看这里，能分清「缓存有没有」「代理活没活」----
    if (req.method === 'GET' && req.url.startsWith('/__dsweb/health')) {
      let assetsCount = 0;
      let pagesCount = 0;
      try {
        for (const f of fs.readdirSync(ASSET_DIR)) {
          const full = path.join(ASSET_DIR, f);
          try {
            const size = fs.statSync(full).size;
            if (size > 1024) assetsCount += 1;
          } catch {}
        }
      } catch {}
      try {
        const pageFile = assetPath(pageKey('https://' + siteHost() + '/sign_in'));
        const st = fs.statSync(pageFile);
        pagesCount = Date.now() - st.mtimeMs < PAGE_TTL_MS ? 1 : 0;
      } catch {}
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      res.end(JSON.stringify({ ok: true, port, uptimeSec: Math.round(process.uptime()), cachedAssets: assetsCount, pageCached: Boolean(pagesCount), site: siteHost() }));
      return;
    }

    // ---- token 回传：页面 POST 到同源的 /__dsweb/report，这里再转发给插件 ----
    // 以前页面直接 POST 到 http://127.0.0.1:38445/...（跨 origin），浏览器会先发 OPTIONS 预检；
    // 预检一旦被网关/系统浏览器拦掉，页面就只看到「网络失败 … Failed to fetch」，
    // token 明明抓到了却存不进去 —— 内嵌登录「用不了」多半就是这一步。
    // 改成同源转发后不再有跨域预检，也不依赖网关的 CORS 配置。
    if (req.method === 'POST' && req.url.startsWith('/__dsweb/report')) {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const payload = Buffer.concat(chunks);
      const reply = (status, text, type) => {
        res.writeHead(status, { 'content-type': type || 'application/json; charset=utf-8', 'cache-control': 'no-store' });
        res.end(text);
      };
      let target = null;
      try { target = new URL(reportUrl); } catch {}
      if (!target) return reply(200, '{"ok":false,"message":"插件没配置回传地址"}');
      const bodyText = payload.toString('utf8');
      let brief = '';
      try { brief = bodyText.slice(0, 120).replace(/\s+/g, ' '); } catch {}
      // 记一份「这次登录发生在哪个会话上」：恢复上次登录靠它，比让用户自己猜强
      try {
        const sidNow = (String(req.headers.cookie || '').match(new RegExp('(?:^|;\\s*)' + SID_COOKIE + '=([^;]+)')) || [])[1] || '';
        let parsed = {};
        try { parsed = JSON.parse(bodyText) || {}; } catch {}
        const data = parsed.data || parsed || {};
        noteLoginSession(sidNow, {
          accountId: String(data.accountId || parsed.accountId || ''),
          email: String(data.email || parsed.email || ''),
          source: String(data.source || parsed.source || ''),
        });
      } catch {}
      logLine('REPORT ' + payload.length + 'B -> ' + target.origin + target.pathname + ' ' + brief);
      const upstream = http.request(
        {
          host: target.hostname,
          port: target.port || 80,
          path: target.pathname + target.search,
          method: 'POST',
          headers: { 'content-type': 'application/json; charset=utf-8', 'content-length': payload.length, host: target.host, 'x-dsweb-sid': String((String(req.headers.cookie || '').match(new RegExp('(?:^|;\\s*)' + SID_COOKIE + '=([^;]+)')) || [])[1] || '') },
          timeout: 15000,
        },
        (up) => {
          const out = [];
          up.on('data', (c) => out.push(c));
          up.on('end', () => {
            const text = Buffer.concat(out).toString('utf8');
            logLine('REPORT <- ' + up.statusCode + ' ' + text.slice(0, 200));
            reply(up.statusCode || 200, text || '{"ok":false,"message":"插件没有返回内容"}');
          });
        },
      );
      upstream.on('timeout', () => {
        logLine('REPORT TIMEOUT ' + target.origin);
        upstream.destroy();
      });
      upstream.on('error', (error) => {
        logLine('REPORT ERROR ' + error.message);
        try {
          reply(200, JSON.stringify({ ok: false, message: '回传到插件失败：' + error.message + '（DSH 是否已关闭？）' }));
        } catch {}
      });
      upstream.end(payload);
      return;
    }
    if (req.method === 'POST' && req.url.startsWith('/__dsweb/done')) {
      let ticket = '';
      try { ticket = new URL(req.url, 'http://127.0.0.1').searchParams.get('t') || ''; } catch {}
      dropTicket(ticket);
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      res.end('{"ok":true}');
      return;
    }
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
    // 显式复用某个登录会话：?__dsweb_sid=xxx（「恢复上次登录」和指定账号重登都走这条）
    // 只在浏览器没带 dsweb_sid 时生效，绝不会覆盖用户当前正在用的会话。
    if (!sid) {
      try {
        const forced = (new URL(req.url, 'http://127.0.0.1').searchParams.get('__dsweb_sid') || '').replace(/[^a-zA-Z0-9_-]/g, '');
        if (forced.length >= 8) {
          sid = forced;
          logLine('SESSION reuse ' + sid.slice(0, 8) + '… ' + req.url.slice(0, 60));
        }
      } catch {}
    }
    if (!sid) sid = Math.random().toString(36).slice(2) + Date.now().toString(36);
    const jar = readJar(sid);
    const upstreamCookie = [rawCookie.split(';').map((x) => x.trim()).filter((x) => x && !x.startsWith(SID_COOKIE + '=')).join('; '), cookieHeader(jar)].filter(Boolean).join('; ');
    if (upstreamCookie) headers.cookie = upstreamCookie;
    if (body.length) headers['content-length'] = String(body.length);

    // 静态资源（/cdn/…）：缓存优先，后台刷新。
    // 上游这会儿很慢 / 被墙（实测 main.js 要 47 秒才回来），以前是「先等上游、失败才回缓存」，
    // 浏览器早就白屏了。现在只要磁盘里有缓存就直接毫秒级发出去，再顺手在后台更新一份。
    if (isCdn) {
      const ext = path.extname(new URL(target).pathname).toLowerCase();
      const type = ext === '.js' ? 'application/javascript; charset=utf-8' : ext === '.css' ? 'text/css; charset=utf-8' : ext === '.svg' ? 'image/svg+xml' : ext === '.woff2' || ext === '.woff' ? 'font/woff2' : ext === '.wasm' ? 'application/wasm' : 'application/octet-stream';
      const sendCached = (buf, label) => {
        logLine(label + ' ' + req.url);
        res.writeHead(200, { 'content-type': type, 'cache-control': 'public, max-age=3600' });
        res.end(buf);
      };
      const cached = readAsset(target);
      if (cached && cached.length > 1024) {
        sendCached(cached, 'CACHE-FIRST');
        refreshAssetInBackground(target, headers);
        return;
      }
      // 没缓存才走上游：快速重试（6s × 2），失败就报错
      const r = await fetchUpstream(target, req.method, headers, body, 2, 6000);
      const ctype0 = r.up ? String(r.up.headers['content-type'] || '') : '';
      const good = r.up && (r.up.statusCode || 0) === 200 && /javascript|text\/css|font|image|octet-stream|wasm/.test(ctype0);
      if (!good) {
        logLine('ERROR ' + (req.method || 'GET') + ' ' + req.url + ' ' + ((r.error && r.error.message) || 'unknown'));
        res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('资源加载失败（已重试 2 次）：' + ((r.error && r.error.message) || 'unknown'));
        return;
      }
      const buf = rewriteAsset(target, ctype0, r.buf);
      if (buf.length > 1024 && /javascript|text\/css/.test(ctype0)) {
        writeAsset(target, buf);
        pruneAssets();
      }
      const outHeaders = filterResponseHeaders(r.up.headers);
      outHeaders['content-length'] = String(buf.length);
      res.writeHead(r.up.statusCode || 200, outHeaders);
      res.end(buf);
      return;
    }

    // 登录页 HTML 也缓存优先：上游抓一次要 12s×3 重试（风控/网络差时更久），
    // 页面内容 30 分钟内却几乎不变。有缓存就直接发；超过 5 分钟就在后台用「自我请求」刷新一份，
    // 用户永远不用对着白屏等上游。
    if (
      (req.method === 'GET' || req.method === 'HEAD') &&
      String(req.headers.accept || '').includes('text/html') &&
      !req.headers['x-dsweb-refresh']
    ) {
      const cachedPage = readPage(target);
      if (cachedPage) {
        let age = 0;
        try { age = Date.now() - fs.statSync(assetPath(pageKey(target))).mtimeMs; } catch {}
        logLine('PAGE-CACHE-FIRST ' + req.url + ' age=' + Math.round(age / 1000) + 's');
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'x-dsweb-cache': 'hit' });
        res.end(req.method === 'HEAD' ? undefined : cachedPage);
        if (age > 5 * 60 * 1000 && !pageRefreshing.has(pageKey(target))) {
          pageRefreshing.add(pageKey(target));
          const port2 = (server.address() && server.address().port) || port;
          const bg = http.get(
            { host: '127.0.0.1', port: port2, path: req.url, headers: { ...req.headers, 'x-dsweb-refresh': '1' }, timeout: 60000 },
            (up) => up.resume(),
          );
          bg.on('error', () => {});
          bg.on('close', () => pageRefreshing.delete(pageKey(target)));
        }
        return;
      }
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
          // 顺手记下名字/到期形态（不存 value），面板的「cookie 构成」用它
          try { noteSetCookies(setCookies); } catch {}
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
          const wafChallenge = up.statusCode === 202 || Boolean(up.headers['x-amzn-waf-action']);
          if (wafChallenge) {
            // 站点风控要求「人机验证」：等一会儿重试。实测同一分钟内 200/202 会交替出现，
            // 多试几次（1.2s / 2.5s）比只试两次成功率高得多。
            if (attempt < 3) {
              logLine('WAF_CHALLENGE(' + attempt + '/3) ' + req.url + ' 稍后重试');
              setTimeout(() => send(attempt + 1), attempt === 1 ? 1200 : 2500);
              return;
            }
            // 上游一直拦：优先把之前成功抓到过的整页发出去（页面本身不依赖上游实时响应）
            const cachedPage = readPage(target);
            if (cachedPage) {
              logLine('PAGE-CACHE-HIT ' + req.url);
              res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'x-dsweb-cache': 'hit' });
              res.end(cachedPage);
              return;
            }
            logLine('WAF_BLOCKED ' + req.url);
            res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
            res.end(challengePage());
            return;
          }
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
          // 每个登录会话一套设备 id：登录页看到的设备 = 这个账号之后聊天用的设备，
          // 换一次登录就是一台全新设备（不同会话之间不会互相牵连）。
          const DEVICE_ID = deviceIdFor('login:' + sid);
          const snippet = INJECT
            .split('__DSW_REGION__')
            .join(regionLabel)
            .split('__DSW_DEVICE_ID__')
            .join(DEVICE_ID);
          // 在站点自己的脚本之前把设备身份固定成插件的 device id：
          // 站点前端读 localStorage["deepseek-device-id:chat"]，读不到就随机生成一个 —— 那样每换一次
          // 浏览器就多出一台「新设备」，同一个账号被当成多设备登录，很容易被风控踢下线。
          const headSnippet =
            '<script>(function(){try{localStorage.setItem("deepseek-device-id:chat",' +
            JSON.stringify(DEVICE_ID) +
            ');}catch(e){}})();</script>';
          html = /<head[^>]*>/i.test(html) ? html.replace(/<head([^>]*)>/i, '<head$1>' + headSnippet) : headSnippet + html;
          html = html.includes('</body>') ? html.replace('</body>', snippet + '</body>') : html + snippet;
          // 注入之后整页只有一个版本，缓存它：下次被 WAF 挡时可以直接发这一份
          writePage(target, Buffer.from(html, 'utf8'));
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
      // 站点偶尔会抽风（连接被掐断/超时，移动网络下很常见）。GET 请求多试几次；POST 不重试，避免重复提交登录。
      const canRetry = req.method === 'GET' && attempt < 3 && !res.headersSent;
      if (canRetry) {
        logLine('RETRY(' + attempt + '/3) ' + req.url + ' ' + error.message);
        setTimeout(() => send(attempt + 1), attempt === 1 ? 300 : 900);
        return;
      }
      logLine('ERROR ' + (req.method || 'GET') + ' ' + req.url + ' ' + error.message + (process.env.DSW_PROXY_DEBUG ? ' headers=' + JSON.stringify(headers) : ''));
      if (res.headersSent) return res.end();
      const cachedPage = req.method === 'GET' ? readPage(target) : null;
      if (cachedPage) {
        logLine('PAGE-CACHE-HIT ' + req.url);
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'x-dsweb-cache': 'hit' });
        res.end(cachedPage);
        return;
      }
      // 别再给空白 iframe / 一行纯文本：给一张能看懂、能重试的页面
      res.writeHead(502, { 'content-type': 'text/html; charset=utf-8' });
      res.end(retryPage(error.message));
    });
    upstream.end(body.length ? body : undefined);
    };
    send(1);
  });
  server.listen(port, '127.0.0.1');
  return server;
}
