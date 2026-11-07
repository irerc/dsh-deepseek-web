// native 传输层：不需要浏览器，也能用浏览器级 TLS 指纹发请求（curl_cffi sidecar）。
//
// 为什么要有这一层：
//   - browser 层（CDP）在桌面端最真，但手机容器里 Chromium 起不来（本机实测 SIGTRAP）；
//   - node 层是 Node/OpenSSL 的 TLS，JA4 是 t13d5212h1_…（HTTP/1.1），一眼脚本；
//   - native 层用 curl_cffi（BoringSSL impersonate chrome131）拿 JA4 t13d1516h2_…、HTTP/2 帧同 Chrome，
//     纯 CPU，不需要显示器 / /dev/shm / 可执行浏览器 —— 任何 DSH 客户端都能跑。
//
// 依赖策略：优先用系统里已装好的 curl_cffi；没有就 pip 装到 <STATE>/native-libs（不污染系统 Python）。
// 装不上就返回明确原因，由引擎按 browser → native → node 的顺序回退，绝不静默。
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { STATE_DIR, loadConfig } from './config.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SIDECAR = path.join(HERE, 'fingerprint-sidecar.py');
const LIBS_DIR = path.join(STATE_DIR, 'native-libs');

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function envWithLibs() {
  const extra = [LIBS_DIR, process.env.DSW_NATIVE_LIBS || ''].filter(Boolean).join(path.delimiter);
  const env = { ...process.env };
  env.PYTHONPATH = extra + (env.PYTHONPATH ? path.delimiter + env.PYTHONPATH : '');
  env.PYTHONUNBUFFERED = '1';
  return env;
}

/** 候选 Python 解释器：设置 > 环境变量 > PATH 里常见的几个 */
export function pythonCandidates() {
  const out = [];
  const push = (p) => { if (p) out.push(String(p)); };
  try { push(loadConfig().nativePython); } catch {}
  push(process.env.DSW_PYTHON);
  if (process.platform === 'win32') {
    push('python');
    push('py');
  } else {
    push('python3');
    push('python');
    for (const p of ['/usr/bin/python3', '/usr/local/bin/python3', '/usr/bin/python']) {
      if (fs.existsSync(p)) push(p);
    }
  }
  return [...new Set(out)];
}

function run(py, args, { timeout = 20000, env = envWithLibs() } = {}) {
  const r = spawnSync(py, args, { encoding: 'utf8', timeout, env });
  return {
    code: r.status,
    out: String(r.stdout || '').trim(),
    err: String(r.stderr || '').trim(),
    signal: r.signal || '',
    error: r.error ? String(r.error.message || r.error) : '',
  };
}

/** 这个解释器能不能 import curl_cffi（带 <STATE>/native-libs 的 PYTHONPATH） */
export function probePython(py) {
  const r = run(py, ['-c', 'import curl_cffi, sys; print(curl_cffi.__version__)'], { timeout: 15000 });
  if (r.code !== 0) {
    return { ok: false, version: '', reason: (r.err || r.error || 'import curl_cffi 失败').split('\n').slice(-1)[0].slice(0, 200) };
  }
  return { ok: true, version: r.out.split('\n').pop() || '', reason: '' };
}

let _installTried = false;
const VENV_DIR = path.join(STATE_DIR, 'native-venv');

function pipArgs() {
  const index = process.env.DSW_PIP_INDEX || '';
  const base = ['-m', 'pip', 'install', '--disable-pip-version-check', '--no-cache-dir', '--target', LIBS_DIR, 'curl_cffi'];
  if (!index) return base;
  return [...base, '--index-url', index, '--trusted-host', String(index).replace(/^https?:\/\//, '').split('/')[0]];
}

/** 没有 pip 的环境：建一个只装 pip 的 venv（不动系统 Python，也不触发 PEP668） */
async function ensurePipVenv(py) {
  const vp = process.platform === 'win32' ? path.join(VENV_DIR, 'Scripts', 'python.exe') : path.join(VENV_DIR, 'bin', 'python3');
  if (!fs.existsSync(vp)) {
    run(py, ['-m', 'venv', '--without-pip', VENV_DIR], { timeout: 180000 });
    if (!fs.existsSync(vp)) return '';
  }
  const pipFile = path.join(STATE_DIR, 'get-pip.py');
  if (!fs.existsSync(pipFile)) {
    try {
      const r = await fetch('https://bootstrap.pypa.io/get-pip.py');
      if (!r.ok) return '';
      fs.writeFileSync(pipFile, Buffer.from(await r.arrayBuffer()));
    } catch {
      return '';
    }
  }
  const r = run(vp, [pipFile], { timeout: 300000 });
  return r.code === 0 ? vp : '';
}

/** 把 curl_cffi 装到 <STATE>/native-libs（不污染系统 Python）。返回实际可用的解释器 */
export async function installCurlCffi(py, { index = process.env.DSW_PIP_INDEX || '' } = {}) {
  fs.mkdirSync(LIBS_DIR, { recursive: true });
  let r = run(py, pipArgs(), { timeout: 300000 });
  if (r.code === 0) return { ok: true, python: py, reason: '' };
  // Debian/Ubuntu 精简 rootfs 常见：没有 pip。先 ensurepip，再退化到「自建 venv + get-pip」
  run(py, ['-m', 'ensurepip', '--upgrade'], { timeout: 120000 });
  r = run(py, pipArgs(), { timeout: 300000 });
  if (r.code === 0) return { ok: true, python: py, reason: '' };
  const vp = await ensurePipVenv(py);
  if (vp) {
    r = run(vp, pipArgs(), { timeout: 300000 });
    if (r.code === 0) return { ok: true, python: vp, reason: '' };
  }
  const msg = (r.err || r.out || r.error || '').split('\n').filter(Boolean).slice(-2).join(' ').slice(0, 300);
  return { ok: false, python: py, reason: msg || 'pip install 失败' };
}

const AVAIL_TTL = 5 * 60 * 1000;
let _avail = { at: 0, value: null };

/**
 * native 层可用性：
 *   ok       = 找到解释器 且 能 import curl_cffi
 *   installed= 这次调用里自动装成功了
 * autoInstall=false 时只检测不安装。
 */
export async function nativeAvailability({ force = false, autoInstall = true } = {}) {
  const now = Date.now();
  if (!force && _avail.value && now - _avail.at < AVAIL_TTL) return _avail.value;
  const pys = pythonCandidates();
  let found = null;
  let lastReason = '本机没有 python3 / python 解释器';
  for (const py of pys) {
    const probe = probePython(py);
    if (probe.ok) {
      const value = { ok: true, python: py, version: probe.version, reason: '', installed: false, dirs: LIBS_DIR };
      _avail = { at: now, value };
      return value;
    }
    found = found || { python: py, reason: probe.reason };
    lastReason = probe.reason || lastReason;
  }
  let installed = false;
  if (found && autoInstall && !_installTried) {
    _installTried = true;
    const r = await installCurlCffi(found.python);
    if (r.ok) {
      const probe = probePython(r.python);
      if (probe.ok) {
        const value = { ok: true, python: r.python, version: probe.version, reason: '', installed: true, dirs: LIBS_DIR };
        _avail = { at: now, value };
        return value;
      }
      lastReason = probe.reason || lastReason;
    } else {
      lastReason = r.reason;
    }
    installed = false;
  }
  const value = {
    ok: false,
    python: found ? found.python : '',
    version: '',
    reason:
      '本地伪装传输需要 python3 + curl_cffi：' + lastReason +
      '（可在设置里填 Python 解释器路径，或手动执行 python3 -m pip install --target ' + LIBS_DIR + ' curl_cffi）',
    installed,
  };
  _avail = { at: now, value };
  return value;
}

export class NativeTransport {
  constructor(log = () => {}) {
    this.log = log;
    this.proc = null;
    this.port = 0;
    this.python = '';
  }

  async ensure() {
    if (this.proc && this.port) return this.port;
    const avail = await nativeAvailability();
    if (!avail.ok) throw new Error(avail.reason || 'native 传输不可用');
    this.python = avail.python;
    if (!fs.existsSync(SIDECAR)) throw new Error('缺少 server/fingerprint-sidecar.py，插件包不完整');
    this.log('[native] 启动 ' + this.python + ' fingerprint-sidecar.py');
    const child = spawn(this.python, ['-u', SIDECAR], {
      cwd: HERE,
      env: { ...envWithLibs(), DSW_IMPERSONATE: process.env.DSW_IMPERSONATE || 'chrome131' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.proc = child;
    let stderr = '';
    child.stderr.on('data', (d) => { stderr += String(d); if (stderr.length > 8000) stderr = stderr.slice(-8000); });
    const first = await new Promise((resolve) => {
      let buf = '';
      const timer = setTimeout(() => resolve({ line: '', timeout: true }), 15000);
      child.stdout.on('data', (d) => {
        buf += String(d);
        const i = buf.indexOf('\n');
        if (i >= 0) {
          clearTimeout(timer);
          resolve({ line: buf.slice(0, i), timeout: false });
        }
      });
      child.on('error', (e) => { clearTimeout(timer); resolve({ line: '', error: String(e.message || e) }); });
      child.on('exit', (code, signal) => {
        clearTimeout(timer);
        resolve({ line: '', exit: { code, signal } });
      });
    });
    if (!first.line) {
      this.close();
      const why = first.error ? '无法启动 Python：' + first.error
        : first.timeout ? 'sidecar 15 秒内没有就绪'
        : 'sidecar 立刻退出（code=' + (first.exit && first.exit.code) + ' signal=' + (first.exit && first.exit.signal) + '）：' + stderr.trim().split('\n').slice(-1)[0];
      throw new Error('本地伪装传输不可用：' + why);
    }
    let info = null;
    try { info = JSON.parse(first.line); } catch {}
    if (!info || !info.port) {
      this.close();
      throw new Error('sidecar 就绪信息不合法：' + first.line.slice(0, 200) + (stderr ? '（' + stderr.slice(-200) + '）' : ''));
    }
    this.port = info.port;
    child.on('exit', () => { this.proc = null; this.port = 0; });
    this.log('[native] sidecar ready port=' + this.port + ' impersonate=' + (info.impersonate || ''));
    return this.port;
  }

  /** 把一次上游请求交给 sidecar，拿回 fetch 的 Response（body 是流，SSE 直通不缓冲） */
  async request({ path: reqPath, headers = {}, body = '', timeout = 120 }) {
    const port = await this.ensure();
    const res = await fetch('http://127.0.0.1:' + port + '/__fetch', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: reqPath, headers, body, timeout }),
    });
    if (!res.ok) {
      let text = '';
      try { text = await res.text(); } catch {}
      let msg = text.slice(0, 300);
      try { msg = JSON.parse(text).error || msg; } catch {}
      throw new Error('sidecar 请求失败（' + res.status + '）：' + msg);
    }
    return res;
  }

  /** 一次性取回文本（PoW 挑战、建会话这类小 JSON） */
  async call({ path: reqPath, headers = {}, body = '', timeout = 60 }) {
    const res = await this.request({ path: reqPath, headers, body, timeout });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch {}
    return { status: res.status, text, json };
  }

  close() {
    const p = this.proc;
    this.proc = null;
    this.port = 0;
    if (!p) return;
    try { p.kill('SIGKILL'); } catch {}
  }
}
