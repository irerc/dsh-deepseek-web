// 浏览器传输层：把上游请求交给**真实 Chromium 页面**发出（TLS/JA4 指纹 = 浏览器），
// PoW 也用官方自己的 wasm 在**页面上下文**里解（Node 里 WebAssembly 解挑战被公开文档
// 列为明确的封号触发条件）。
//
// 设计约束（都是踩过的坑）：
//   1) 找不到浏览器 ⇒ **明确报错**，不静默退回 Node（那样等于这个改动没发生）。
//   2) 页面必须真的「已登录」：cookie 装进浏览器 profile，localStorage.userToken 也要写，
//      否则页面渲染登录页、请求却带合法 Authorization —— 真人身上不会出现这种组合。
//   3) 同一时刻只允许一个页面请求在跑（账号本来就串行），用队列串起来。
//   4) 任何一步超时都要能自己收尸，不留僵尸 chromium。
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { STATE_DIR, loadConfig } from './config.mjs';
import { UA, BASE } from './http.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WASM_FILE = path.join(HERE, 'sha3_wasm_bg.wasm');

/** PATH 里按名字找（不写死 /usr/bin：brew、nix、自编译都可能装在别处） */
function lookPath(names) {
  const out = [];
  const dirs = String(process.env.PATH || '').split(path.delimiter).filter(Boolean);
  for (const n of names) for (const d of dirs) out.push(path.join(d, n));
  return out;
}

// Playwright / Puppeteer 自带的 Chromium：很多人（包括这台机器）的浏览器就在这些缓存里，
// /usr/bin/chromium 常常只是软链到 ms-playwright 缓存 —— 只扫 /usr/bin 会「明明有浏览器却说没检测到」。
function scanBrowserCaches(home) {
  const out = [];
  const pwRoots = [process.env.PLAYWRIGHT_BROWSERS_PATH, path.join(home, '.cache', 'ms-playwright')].filter(Boolean);
  for (const base of pwRoots) {
    let dirs = [];
    try { dirs = fs.readdirSync(base); } catch { continue; }
    for (const d of dirs) {
      if (!/^chromium/i.test(d)) continue;
      const root = path.join(base, d);
      let subs = [];
      try { subs = fs.readdirSync(root); } catch { continue; }
      for (const s of subs) {
        out.push(path.join(root, s, 'chrome'));
        out.push(path.join(root, s, 'chrome-headless-shell'));
        out.push(path.join(root, s, 'headless_shell'));
      }
    }
  }
  const ppRoot = path.join(home, '.cache', 'puppeteer');
  for (const kind of ['chrome', 'chrome-headless-shell']) {
    const base = path.join(ppRoot, kind);
    let vers = [];
    try { vers = fs.readdirSync(base); } catch { continue; }
    for (const v of vers) {
      let subs = [];
      try { subs = fs.readdirSync(path.join(base, v)); } catch { continue; }
      for (const s of subs) {
        out.push(path.join(base, v, s, 'chrome'));
        out.push(path.join(base, v, s, 'chrome-headless-shell'));
        out.push(path.join(base, v, s, 'headless_shell'));
      }
    }
  }
  return out;
}

/** 候选浏览器路径：DSW_BROWSER_PATH > 设置里的自定义路径 > PATH > 发行版常见位置 > Playwright/Puppeteer 缓存 */
export function browserCandidates() {
  const out = [];
  const push = (p) => { if (p) out.push(String(p)); };
  push(process.env.DSW_BROWSER_PATH);
  try {
    const custom = loadConfig().browserPath;
    if (custom) push(custom);
  } catch {}
  const home = os.homedir();
  if (process.platform === 'win32') {
    for (const base of [process.env['PROGRAMFILES'], process.env['PROGRAMFILES(X86)'], process.env.LOCALAPPDATA]) {
      if (!base) continue;
      push(path.join(base, 'Google/Chrome/Application/chrome.exe'));
      push(path.join(base, 'Microsoft/Edge/Application/msedge.exe'));
      push(path.join(base, 'Chromium/Application/chrome.exe'));
    }
  } else if (process.platform === 'darwin') {
    push('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
    push('/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge');
    push('/Applications/Chromium.app/Contents/MacOS/Chromium');
  } else {
    const names = [
      'google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser',
      'microsoft-edge', 'microsoft-edge-stable', 'brave-browser', 'vivaldi-stable',
    ];
    for (const p of lookPath(names)) push(p);
    push('/opt/google/chrome/chrome');
    push('/opt/microsoft/msedge/msedge');
    push('/usr/lib/chromium/chrome');
    push('/usr/lib/chromium-browser/chrome');
    push('/snap/bin/chromium');
    push('/var/lib/flatpak/exports/bin/com.google.Chrome');
    push(path.join(home, '.local/share/flatpak/exports/bin/com.google.Chrome'));
  }
  for (const p of scanBrowserCaches(home)) push(p);
  return [...new Set(out)];
}

function isExecutable(p) {
  try {
    if (!p || !fs.existsSync(p)) return false;
    const st = fs.statSync(p);
    if (!st.isFile()) return false;
    fs.accessSync(p, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** 找一个可执行的浏览器；找不到返回 null（调用方必须明确报错，不许静默回退） */
export function findBrowser() {
  for (const p of browserCandidates()) if (isExecutable(p)) return p;
  return null;
}

/** 读 --version：用来在设置页显示「找到的是哪个浏览器、几版」，而不是只说一句检测不到 */
export function browserVersionOf(bin) {
  return new Promise((resolve) => {
    let out = '';
    let p;
    try {
      p = spawn(bin, ['--version'], { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch {
      return resolve('');
    }
    const timer = setTimeout(() => { try { p.kill('SIGKILL'); } catch {} resolve(out.trim()); }, 5000);
    const acc = (d) => { out += String(d); if (out.length > 4000) out = out.slice(0, 4000); };
    p.stdout.on('data', acc);
    p.stderr.on('data', acc);
    p.on('error', () => { clearTimeout(timer); resolve(''); });
    p.on('exit', () => { clearTimeout(timer); resolve(out.trim().split('\n')[0].slice(0, 120)); });
  });
}

// 冒烟测试：真的起一次 headless，让它 dump 一个页面。起不来的浏览器必须在这里露馅
// （这台机器上的 Chromium 就是活生生的例子：文件在、--version 能打，一开页面就 SIGTRAP）。
function smokeTest(bin) {
  return new Promise((resolve) => {
    let dir = '';
    try { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsw-smoke-')); } catch { dir = ''; }
    const args = ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--no-first-run', '--no-default-browser-check'];
    if (!/headless/i.test(path.basename(bin))) args.unshift('--headless=new');
    if (dir) args.push('--user-data-dir=' + path.join(dir, 'p'));
    args.push('--dump-dom', 'about:blank');
    const t0 = Date.now();
    let out = '';
    let err = '';
    let done = false;
    let p;
    const finish = (r) => {
      if (done) return;
      done = true;
      try { p.kill('SIGKILL'); } catch {}
      if (dir) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} }
      resolve({ ...r, ms: Date.now() - t0 });
    };
    try {
      p = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      return resolve({ ok: false, reason: '无法启动：' + String(e.message || e), ms: Date.now() - t0 });
    }
    const timer = setTimeout(() => finish({ ok: false, reason: '12 秒内没有正常退出（启动卡死）' }), 12000);
    p.stdout.on('data', (d) => { out += String(d); if (out.length > 200000) out = out.slice(0, 200000); });
    p.stderr.on('data', (d) => { err += String(d); if (err.length > 20000) err = err.slice(-20000); });
    p.on('error', (e) => { clearTimeout(timer); finish({ ok: false, reason: '无法启动：' + String(e.message || e) }); });
    p.on('exit', (code, signal) => {
      clearTimeout(timer);
      if (code === 0 && /<html/i.test(out)) return finish({ ok: true, code: 0 });
      const tail = (err || out).split('\n').map((s) => s.trim()).filter(Boolean).slice(-3).join(' | ').slice(0, 500);
      finish({
        ok: false,
        code,
        signal: signal || '',
        reason: signal
          ? '一开页面就崩溃（信号 ' + signal + '，退出码 ' + code + '）'
          : '启动失败（退出码 ' + code + '）',
        tail,
      });
    });
  });
}

const AVAIL_TTL = 5 * 60 * 1000;
let _avail = { at: 0, value: null };

/** 浏览器可用性（带缓存）：找到没有、叫什么版本、**能不能真的启动**。设置页和引擎都读这一份 */
export async function browserAvailability({ force = false, bin = '' } = {}) {
  const now = Date.now();
  if (!force && !bin && _avail.value && now - _avail.at < AVAIL_TTL) return _avail.value;
  const explicit = String(bin || '').trim();
  const pathFound = explicit ? (isExecutable(explicit) ? explicit : '') : findBrowser();
  let value;
  if (!pathFound) {
    value = {
      ok: false,
      found: false,
      path: '',
      version: '',
      reason: explicit
        ? '指定的浏览器路径不存在或不可执行：' + explicit
        : '没找到 Chrome / Edge / Chromium 可执行文件（PATH、/opt、snap、flatpak、Playwright/Puppeteer 缓存都没命中）',
    };
  } else {
    const version = await browserVersionOf(pathFound);
    const s = await smokeTest(pathFound);
    value = {
      ok: Boolean(s.ok),
      found: true,
      path: pathFound,
      version,
      reason: s.ok ? '' : String(s.reason || '启动失败'),
      signal: s.signal || '',
      code: s.code === undefined ? null : s.code,
      tail: s.tail || '',
      ms: s.ms || 0,
    };
  }
  if (!bin) _avail = { at: now, value };
  return value;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** 极简 CDP 客户端（Node 22+ 自带 WebSocket，不引第三方依赖） */
class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.seq = 0;
    this.pending = new Map();
    this.handlers = new Map();
    this.closed = false;
    ws.addEventListener('message', (ev) => {
      let msg;
      try {
        msg = JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data));
      } catch {
        return;
      }
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message || JSON.stringify(msg.error)));
        else resolve(msg.result);
        return;
      }
      if (msg.method) {
        for (const fn of this.handlers.get(msg.method) || []) {
          try { fn(msg.params); } catch {}
        }
      }
    });
    ws.addEventListener('close', () => {
      this.closed = true;
      for (const { reject } of this.pending.values()) reject(new Error('CDP 连接已断开'));
      this.pending.clear();
    });
  }

  static async connect(url, timeoutMs = 10000) {
    const ws = new WebSocket(url);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('CDP 连接超时')), timeoutMs);
      ws.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
      ws.addEventListener('error', () => { clearTimeout(timer); reject(new Error('CDP 连接失败')); }, { once: true });
    });
    return new Cdp(ws);
  }

  send(method, params = {}, timeoutMs = 30000) {
    if (this.closed) return Promise.reject(new Error('CDP 连接已断开'));
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('CDP ' + method + ' 超时'));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  on(method, fn) {
    if (!this.handlers.has(method)) this.handlers.set(method, []);
    this.handlers.get(method).push(fn);
  }

  close() {
    try { this.ws.close(); } catch {}
    this.closed = true;
  }
}

function freePort() {
  // 让 chromium 自己挑端口更稳：先给一个大概率空闲的，再读它打印的端口
  return 9000 + Math.floor(Math.random() * 30000);
}

/** 浏览器传输层（进程内单例；由 engine-http 持有） */
export class BrowserTransport {
  constructor(log = () => {}) {
    this.log = log;
    this.proc = null;
    this.cdp = null;
    this.pageUrl = BASE + '/';
    this.installedToken = '';
    this.queue = Promise.resolve();
    this.bindingReady = false;
    this._streams = new Map();
    this._rid = 0;
  }

  get browserPath() {
    return findBrowser();
  }

  /** 串行执行（同一时刻只让一个页面请求在跑） */
  _serial(fn) {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => {});
    return run;
  }

  /**
   * 接管一台**外部**浏览器（手机上真实的 Chrome / Edge / WebView 调试端口）。
   * 与 _launch 的区别：这里不起进程、不碰本地 Chromium，只是连上去用它的页面。
   */
  setRemote(wsUrl, pageUrl = '') {
    const next = String(wsUrl || '');
    if (next && next !== this.remoteWs) {
      this.remoteWs = next;
      if (pageUrl) this.pageUrl = pageUrl;
      this.bindingReady = false;
      this.cdp = null; // 换了目标就重新连，避免拿着旧会话打新页面
    }
  }

  async attach() {
    if (this.cdp && !this.cdp.closed && this.attachedWs === this.remoteWs) return this.cdp;
    this.cdp = await Cdp.connect(this.remoteWs, 15000);
    this.attachedWs = this.remoteWs;
    this.bindingReady = false;
    this.log('[device] 已接管手机浏览器页面：' + this.remoteWs.slice(0, 90));
    return this.cdp;
  }

  async ensure() {
    if (this.cdp && !this.cdp.closed) return this.cdp;
    if (this.remoteWs) return this.attach();
    await this._launch();
    return this.cdp;
  }

  async _launch() {
    const avail = await browserAvailability();
    const bin = avail.path || this.browserPath;
    if (!bin) {
      throw new Error(
        '浏览器传输需要本机有 Chrome / Edge / Chromium，但没找到可执行文件。' +
          '装一个浏览器，或在「运行设置 → 传输层」里填浏览器路径（也支持 DSW_BROWSER_PATH）；' +
          '也可以到「运行设置 → 传输层」切到 Node 直连（高危）。',
      );
    }
    // 找到了 ≠ 能用：先做一次冒烟启动，起不来就立刻给出真实原因（信号/退出码/最后几行日志），
    // 而不是等到 25 秒超时再报「DevTools 端口未就绪」。
    if (!avail.ok) {
      throw new Error(
        '浏览器找到了但起不来：' + bin + (avail.version ? '（' + avail.version + '）' : '') +
          ' —— ' + (avail.reason || '启动失败') +
          (avail.tail ? '；日志：' + avail.tail.slice(0, 200) : '') +
          '。这是运行环境限制，不是插件配置问题；可到「运行设置 → 传输层」切到 Node 直连（高危），或换一台能跑浏览器的机器。',
      );
    }
    const profile = path.join(STATE_DIR, 'browser-profile');
    fs.mkdirSync(profile, { recursive: true, mode: 0o700 });
    const port = freePort();
    const args = [
      '--headless=new',
      '--remote-debugging-port=' + port,
      '--user-data-dir=' + profile,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-background-networking',
      '--disable-sync',
      '--disable-default-apps',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
      '--disable-gpu',
      '--disable-dev-shm-usage',
      '--window-size=900,1200',
      '--user-agent=' + UA,
      '--lang=zh-CN',
    ];
    if (typeof process.getuid === 'function' && process.getuid() === 0) args.push('--no-sandbox');
    if (process.env.DSW_BROWSER_HEADED === '1') {
      args.splice(0, 1); // 去掉 --headless=new，开可见窗口（过人机验证时用）
    }
    args.push('about:blank');
    this.log('[browser] 启动 ' + bin + ' port=' + port);
    const out = fs.openSync(path.join(STATE_DIR, 'browser.log'), 'a');
    this.proc = spawn(bin, args, { stdio: ['ignore', out, out], detached: false });
    this.proc.on('exit', (code, signal) => {
      this.log('[browser] 退出 code=' + code + ' signal=' + signal);
      this.proc = null;
      if (this.cdp) { this.cdp.close(); this.cdp = null; }
      this.installedToken = '';
      this.bindingReady = false;
    });

    // 等 DevTools 端口的 HTTP 服务起来
    const deadline = Date.now() + 25000;
    let ver = null;
    for (;;) {
      try {
        const r = await fetch('http://127.0.0.1:' + port + '/json/version');
        if (r.ok) { ver = await r.json(); break; }
      } catch {}
      if (this.proc === null) {
        throw new Error('浏览器启动后立刻退出（详见状态目录 browser.log）；浏览器传输不可用。' +
          '可到「运行设置 → 传输层」切到 Node 直连（高危），或换一台能跑浏览器的机器。');
      }
      if (Date.now() > deadline) {
        this.kill();
        throw new Error('浏览器 DevTools 端口 25 秒未就绪；浏览器传输不可用。' +
          '可到「运行设置 → 传输层」切到 Node 直连（高危），或换一台能跑浏览器的机器。');
      }
      await sleep(250);
    }
    this.log('[browser] ' + ver.Browser);

    // 连到页面 target（比 browser target + session 简单，够用）
    let page = null;
    for (;;) {
      try {
        const list = await (await fetch('http://127.0.0.1:' + port + '/json/list')).json();
        page = (list || []).find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      } catch {}
      if (page) break;
      if (Date.now() > deadline) {
        this.kill();
        throw new Error('拿不到可调试的页面 target；浏览器传输不可用。');
      }
      await sleep(250);
    }
    this.cdp = await Cdp.connect(page.webSocketDebuggerUrl);
    await this.cdp.send('Page.enable');
    await this.cdp.send('Runtime.enable');
    await this.cdp.send('Network.enable');
    await this.cdp.send('Runtime.addBinding', { name: '__dswStream' });
    this.bindingReady = true;
    this.cdp.on('Runtime.bindingCalled', (p) => {
      if (!p || p.name !== '__dswStream') return;
      this._onChunk(p.payload);
    });
    await this._navigate(BASE + '/');
    await this.cdp.send('Runtime.evaluate', {
      expression:
        'if (!window.__dswWasm) { window.__dswWasm = ' + JSON.stringify(fs.readFileSync(WASM_FILE).toString('base64')) + '; }',
      returnByValue: true,
    });
  }

  async _navigate(url) {
    const loaded = new Promise((resolve) => {
      const timer = setTimeout(resolve, 15000);
      this.cdp.on('Page.loadEventFired', () => { clearTimeout(timer); resolve(); });
    });
    await this.cdp.send('Page.navigate', { url });
    await loaded;
  }

  /** 把 cookie + localStorage 登录态装进浏览器页面；同一个 token 只装一次 */
  async installSession(token, cookie = '', deviceId = '') {
    await this.ensure();
    if (!token) return;
    if (this.installedToken === token) return;
    if (cookie) {
      for (const part of String(cookie).split(';')) {
        const i = part.indexOf('=');
        if (i <= 0) continue;
        const name = part.slice(0, i).trim();
        const value = part.slice(i + 1).trim();
        if (!name) continue;
        try {
          await this.cdp.send('Network.setCookie', { name, value, domain: '.deepseek.com', path: '/', url: BASE });
        } catch {}
      }
    }
    const script =
      '(() => {' +
      ' localStorage.setItem("userToken", ' + JSON.stringify(token) + ');' +
      (deviceId ? ' localStorage.setItem("deepseek-device-id:chat", ' + JSON.stringify(deviceId) + ');' : '') +
      ' return String(localStorage.getItem("userToken") || "").slice(0, 8);' +
      '})()';
    const r = await this.cdp.send('Runtime.evaluate', { expression: script, returnByValue: true });
    const got = String(r?.result?.value || '');
    if (!got) throw new Error('登录态写不进浏览器页面（localStorage 不可写），浏览器传输不可用');
    // 页面要真的「已登录」：装完 reload 一次，让站点自己的 JS 跑起来（真人页面就是这个状态）
    await this._navigate(BASE + '/');
    this.installedToken = token;
  }

  _onChunk(payload) {
    const s = String(payload || '');
    const i1 = s.indexOf('|');
    const i2 = s.indexOf('|', i1 + 1);
    if (i1 < 0 || i2 < 0) return;
    const rid = s.slice(0, i1);
    const kind = s.slice(i1 + 1, i2);
    const data = s.slice(i2 + 1);
    const st = this._streams.get(rid);
    if (!st) return;
    st.lastAt = Date.now();
    if (kind === 'c') st.onChunk(data);
    else if (kind === 'b') { st.body += data; st.onChunk(data); }
    else if (kind === 'd') { this._streams.delete(rid); st.resolve(Number(data) || 200); }
    else if (kind === 'e') { this._streams.delete(rid); st.reject(new Error('页面请求失败：' + data)); }
  }

  /** 非流式请求：页面里 fetch 完把整段文本带回来 */
  async request({ path: p, method = 'POST', headers = {}, body = null, timeoutMs = 60000 }) {
    return this._serial(async () => {
      await this.ensure();
      const url = BASE + p;
      const script =
        '(async () => {' +
        ' try {' +
        '  const r = await fetch(' + JSON.stringify(url) + ', {' +
        '    method: ' + JSON.stringify(method) + ',' +
        '    headers: ' + JSON.stringify(headers) + ',' +
        (body === null ? '' : '    body: ' + JSON.stringify(body) + ',') +
        '    credentials: "include",' +
        '  });' +
        '  const t = await r.text();' +
        '  return JSON.stringify({ status: r.status, text: t });' +
        ' } catch (e) { return JSON.stringify({ status: 0, error: String((e && e.message) || e) }); }' +
        '})()';
      const r = await this.cdp.send('Runtime.evaluate', { expression: script, awaitPromise: true, returnByValue: true }, timeoutMs);
      const raw = r?.result?.value;
      if (typeof raw !== 'string') throw new Error('页面请求没有返回结果');
      const parsed = JSON.parse(raw);
      if (parsed.status === 0) throw new Error(parsed.error || '页面请求失败');
      return { status: parsed.status, text: parsed.text };
    });
  }

  /** 流式对话：页面里 fetch，分块通过 CDP binding 回传 */
  async stream({ path: p, headers = {}, body, onChunk, idleMs = 0, timeoutMs = 180000 }) {
    return this._serial(async () => {
      await this.ensure();
      const rid = 'r' + ++this._rid + '_' + Date.now().toString(36);
      const url = BASE + p;
      let raw = '';
      const wrapped = (t) => {
        raw += t;
        if (onChunk) onChunk(t);
      };
      const result = new Promise((resolve, reject) => {
        this._streams.set(rid, { onChunk: wrapped, body: '', resolve, reject, lastAt: Date.now(), idleMs });
      });
      const script =
        '(async () => {' +
        ' const send = (s) => __dswStream(s);' +
        ' const rid = ' + JSON.stringify(rid) + ';' +
        ' try {' +
        '  const r = await fetch(' + JSON.stringify(url) + ', {' +
        '    method: "POST",' +
        '    headers: ' + JSON.stringify(headers) + ',' +
        '    body: ' + JSON.stringify(body) + ',' +
        '    credentials: "include",' +
        '  });' +
        '  if (!r.body || !r.body.getReader) {' +
        '    send(rid + "|b|" + (await r.text())); send(rid + "|d|" + r.status); return;' +
        '  }' +
        '  const reader = r.body.getReader(); const dec = new TextDecoder();' +
        '  for (;;) {' +
        '    const { done, value } = await reader.read();' +
        '    if (done) break;' +
        '    send(rid + "|c|" + dec.decode(value, { stream: true }));' +
        '  }' +
        '  send(rid + "|d|" + r.status);' +
        ' } catch (e) { send(rid + "|e|" + String((e && e.message) || e)); }' +
        '})()';
      this.cdp
        .send('Runtime.evaluate', { expression: script, awaitPromise: false, userGesture: true })
        .catch((err) => {
          const st = this._streams.get(rid);
          if (st) { this._streams.delete(rid); st.reject(err); }
        });
      let timer = null;
      let idleTimer = null;
      const guard = new Promise((_, reject) => {
        timer = setTimeout(() => {
          this._streams.delete(rid);
          reject(new Error('页面流式请求超时'));
        }, timeoutMs);
        if (idleMs > 0) {
          idleTimer = setInterval(() => {
            const st = this._streams.get(rid);
            if (!st) { clearInterval(idleTimer); return; }
            if (Date.now() - st.lastAt > idleMs) {
              this._streams.delete(rid);
              clearInterval(idleTimer);
              reject(new Error('页面流式请求空闲超时'));
            }
          }, 5000);
        }
      });
      try {
        const status = await Promise.race([result, guard]);
        return { status, text: raw };
      } finally {
        clearTimeout(timer);
        if (idleTimer) clearInterval(idleTimer);
      }
    });
  }

  /** 在页面上下文里用官方 wasm 解 PoW（绝不在 Node 里 WebAssembly.instantiate） */
  async solvePow(challenge) {
    await this.ensure();
    const script =
      '(async () => {' +
      ' try {' +
      '  const bin = atob(window.__dswWasm);' +
      '  const bytes = new Uint8Array(bin.length);' +
      '  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);' +
      '  const { instance } = await WebAssembly.instantiate(bytes, { wbg: {} });' +
      '  const e = instance.exports;' +
      '  if (typeof e.wasm_solve !== "function" || typeof e.__wbindgen_export_0 !== "function" || !e.memory) throw new Error("PoW wasm 导出缺失");' +
      '  const enc = new TextEncoder();' +
      '  const c = enc.encode(' + JSON.stringify(String(challenge.challenge)) + ');' +
      '  const p = enc.encode(' + JSON.stringify(String(challenge.salt) + '_' + String(challenge.expire_at) + '_') + ');' +
      '  const cp = e.__wbindgen_export_0(c.length, 1) >>> 0;' +
      '  const pp = e.__wbindgen_export_0(p.length, 1) >>> 0;' +
      '  new Uint8Array(e.memory.buffer).set(c, cp);' +
      '  new Uint8Array(e.memory.buffer).set(p, pp);' +
      '  const sp = e.__wbindgen_add_to_stack_pointer(-16);' +
      '  e.wasm_solve(sp, cp, c.length, pp, p.length, Number(' + JSON.stringify(String(challenge.difficulty)) + '));' +
      '  const dv = new DataView(e.memory.buffer);' +
      '  const code = dv.getInt32(sp, true);' +
      '  const answer = dv.getFloat64(sp + 8, true);' +
      '  e.__wbindgen_add_to_stack_pointer(16);' +
      '  if (!code || !Number.isFinite(answer) || answer <= 0) throw new Error("PoW 无解 code=" + code);' +
      '  return JSON.stringify({ ok: true, answer });' +
      ' } catch (err) { return JSON.stringify({ ok: false, error: String((err && err.message) || err) }); }' +
      '})()';
    const r = await this.cdp.send('Runtime.evaluate', { expression: script, awaitPromise: true, returnByValue: true }, 30000);
    const raw = r?.result?.value;
    if (typeof raw !== 'string') throw new Error('页面内 PoW 没有返回结果');
    const parsed = JSON.parse(raw);
    if (!parsed.ok) throw new Error('页面内 PoW 失败：' + parsed.error);
    return Number(parsed.answer);
  }

  /** 生成 x-ds-pow-response：挑战在页面里取、答案在页面里算 */
  async powHeader(token, cookie, targetPath) {
    const res = await this.request({
      path: '/api/v0/chat/create_pow_challenge',
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) },
      body: JSON.stringify({ target_path: targetPath }),
    });
    let json = null;
    try { json = JSON.parse(res.text); } catch {}
    const challenge = json?.data?.biz_data?.challenge;
    if (!challenge) throw new Error('PoW 挑战为空：' + String(res.text || '').slice(0, 180));
    const answer = await this.solvePow(challenge);
    const payload = {
      algorithm: challenge.algorithm,
      challenge: challenge.challenge,
      salt: challenge.salt,
      answer,
      signature: challenge.signature,
      target_path: targetPath,
    };
    return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64');
  }

  kill() {
    try { this.cdp?.close(); } catch {}
    this.cdp = null;
    this.installedToken = '';
    this.bindingReady = false;
    if (this.proc) {
      try { this.proc.kill('SIGKILL'); } catch {}
      this.proc = null;
    }
  }

  close() {
    this.kill();
  }
}
