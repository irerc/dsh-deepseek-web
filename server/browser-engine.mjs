// 可选的内置浏览器内核：按需下载 Chrome for Testing 到 state 目录，不塞进插件包（那会多出 200MB）。
//
// 为什么要有两个源：
//   cn   —— 阿里 npmmirror 的二进制镜像（cdn.npmmirror.com），国内直连几十 MB/s，官方源经常 0 B/s；
//   intl —— Google 官方存储（storage.googleapis.com），海外直连更快。
// 两个源的文件完全一致（同一个 zip 的 content-length 都为 203502190 字节），所以下完都要过一遍
// zip 校验 + 真跑一次 `chrome --version`，不靠「下载成功」四个字。
//
// 设计约束：
//   1) 默认不下载。用户点按钮才下（省流量，也避免在别人的机器上偷偷拉 200MB）。
//   2) 下载失败要能重来，不能留下半个 zip 让下次误判「已安装」。
//   3) 只保留一份内核；重装/换版本先清旧的，别把 state 目录撑爆。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import https from 'node:https';
import { spawn, spawnSync } from 'node:child_process';
import { STATE_DIR } from './config.mjs';

/** 固定在两个源都存在的版本；要升级改这里（新版本先确认两个源都有再改） */
export const ENGINE_VERSION = '157.0.8103.38';

export const ENGINE_ROOT = path.join(STATE_DIR, 'browser');
const RECORD_FILE = path.join(ENGINE_ROOT, 'engine.json');

export const SOURCES = {
  cn: {
    key: 'cn',
    label: '大陆镜像（npmmirror）',
    base: 'https://cdn.npmmirror.com/binaries/chrome-for-testing',
    hint: '国内直连，通常比官方快 10 倍以上',
  },
  intl: {
    key: 'intl',
    label: '国际直连（Google 官方）',
    base: 'https://storage.googleapis.com/chrome-for-testing-public',
    hint: '海外/已出海网络更快，国内可能很慢',
  },
};

/** Chrome for Testing 的平台命名 */
export function platformKey() {
  const p = process.platform;
  const a = process.arch;
  if (p === 'linux' && a === 'x64') return 'linux64';
  if (p === 'linux' && a === 'arm64') return 'linux-arm64';
  if (p === 'darwin' && a === 'x64') return 'mac-x64';
  if (p === 'darwin' && a === 'arm64') return 'mac-arm64';
  if (p === 'win32' && a === 'x64') return 'win64';
  return '';
}

function enginePaths(platform = platformKey()) {
  if (!platform) return null;
  const dir = path.join(ENGINE_ROOT, ENGINE_VERSION + '-' + platform);
  const bin =
    platform === 'win64'
      ? path.join(dir, 'chrome-win64', 'chrome.exe')
      : platform.startsWith('mac')
        ? path.join(dir, 'chrome-mac-' + (platform.endsWith('arm64') ? 'arm64' : 'x64'), 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing')
        : path.join(dir, 'chrome-' + platform, 'chrome');
  return { dir, bin };
}

function readRecord() {
  try {
    return JSON.parse(fs.readFileSync(RECORD_FILE, 'utf8'));
  } catch {
    return null;
  }
}

/** 已安装且文件还在时才认；版本/平台对不上就当没装 */
export function engineExecutable() {
  const rec = readRecord();
  if (!rec || !rec.bin || rec.version !== ENGINE_VERSION) return '';
  try {
    if (!fs.statSync(rec.bin).isFile()) return '';
  } catch {
    return '';
  }
  return rec.bin;
}

function dirSize(dir) {
  let total = 0;
  const walk = (d) => {
    let items = [];
    try {
      items = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const it of items) {
      const full = path.join(d, it.name);
      if (it.isDirectory()) walk(full);
      else {
        try {
          total += fs.statSync(full).size;
        } catch {}
      }
    }
  };
  walk(dir);
  return total;
}

// ── 下载状态（内存里，进程重启就清空；进度只给设置页轮询看） ──
const state = {
  busy: false,
  source: '',
  phase: '', // resolving / downloading / verifying / extracting / checking / done / error
  received: 0,
  total: 0,
  percent: 0,
  speedBps: 0,
  error: '',
  startedAt: 0,
  finishedAt: 0,
};

export function engineStatus() {
  const platform = platformKey();
  const rec = readRecord();
  const exe = engineExecutable();
  return {
    version: ENGINE_VERSION,
    platform,
    supported: Boolean(platform),
    installed: Boolean(exe),
    executable: exe,
    bin: exe,
    size: rec && exe ? rec.size || 0 : 0,
    diskSize: exe ? dirSize(ENGINE_ROOT) : 0,
    installedAt: rec && exe ? rec.installedAt || 0 : 0,
    installedSource: rec && exe ? rec.source || '' : '',
    sources: Object.values(SOURCES).map((s) => ({ key: s.key, label: s.label, hint: s.hint })),
    download: { ...state },
  };
}

function setProgress(patch) {
  Object.assign(state, patch);
  if (state.total > 0) state.percent = Math.min(100, Math.round((state.received / state.total) * 100));
}

/** 带重定向的 GET，边下边报进度 */
function download(url, dest, { timeoutMs = 120000 } = {}) {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    let redirects = 0;
    const go = (target) => {
      const req = https.get(
        target,
        { headers: { 'user-agent': 'dsh-deepseek-web-engine/1.0', accept: '*/*' }, timeout: timeoutMs },
        (res) => {
          const code = res.statusCode || 0;
          if (code >= 300 && code < 400 && res.headers.location) {
            res.resume();
            if (++redirects > 6) return reject(new Error('重定向次数过多'));
            return go(new URL(res.headers.location, target).toString());
          }
          if (code !== 200) {
            res.resume();
            return reject(new Error('HTTP ' + code));
          }
          const total = Number(res.headers['content-length'] || 0);
          setProgress({ received: 0, total, speedBps: 0 });
          const out = fs.createWriteStream(dest, { mode: 0o644 });
          let received = 0;
          let lastTick = Date.now();
          let lastBytes = 0;
          res.on('data', (chunk) => {
            received += chunk.length;
            const now = Date.now();
            if (now - lastTick >= 500) {
              setProgress({ received, speedBps: Math.round(((received - lastBytes) * 1000) / (now - lastTick)) });
              lastTick = now;
              lastBytes = received;
            }
          });
          res.pipe(out);
          out.on('error', reject);
          out.on('finish', () => {
            setProgress({ received, speedBps: 0 });
            if (total && received !== total) return reject(new Error('下载不完整：' + received + '/' + total));
            resolve({ bytes: received, ms: Date.now() - startedAt });
          });
        },
      );
      req.on('timeout', () => req.destroy(new Error('下载超时')));
      req.on('error', reject);
    };
    go(url);
  });
}

function run(cmd, args, opts = {}) {
  return spawnSync(cmd, args, { encoding: 'utf8', timeout: opts.timeoutMs || 120000, windowsHide: true });
}

/** zip 完整性 + 解压：优先 unzip，其次 python3 -m zipfile，最后 ditto（macOS 自带） */
function extract(zipFile, outDir) {
  fs.mkdirSync(outDir, { recursive: true });
  const tries = [];
  if (process.platform === 'win32') {
    tries.push(['powershell', ['-NoProfile', '-Command', `Expand-Archive -LiteralPath '${zipFile}' -DestinationPath '${outDir}' -Force`]]);
  } else {
    tries.push(['unzip', ['-q', '-o', zipFile, '-d', outDir]]);
    tries.push(['python3', ['-m', 'zipfile', '-e', zipFile, outDir]]);
    tries.push(['ditto', ['-x', '-k', zipFile, outDir]]);
  }
  let lastErr = '';
  for (const [cmd, args] of tries) {
    const r = run(cmd, args, { timeoutMs: 300000 });
    if (r.error && r.error.code === 'ENOENT') continue;
    if (r.status === 0) return true;
    lastErr = String(r.stderr || r.stdout || r.error || '').slice(0, 300);
  }
  throw new Error('解压失败' + (lastErr ? '：' + lastErr : '（没有可用的解压工具）'));
}

function verifyZip(zipFile) {
  const tries = [
    ['unzip', ['-t', '-q', zipFile]],
    ['python3', ['-c', 'import sys,zipfile; z=zipfile.ZipFile(sys.argv[1]); bad=z.testzip(); sys.exit(1 if bad else 0)', zipFile]],
  ];
  for (const [cmd, args] of tries) {
    const r = run(cmd, args, { timeoutMs: 180000 });
    if (r.error && r.error.code === 'ENOENT') continue;
    if (r.status === 0) return true;
    throw new Error('zip 校验失败：' + String(r.stderr || '').slice(0, 200));
  }
  return true; // 两个工具都没有：跳过校验（后面还会真跑 --version）
}

function chromeVersion(bin) {
  try {
    const r = spawnSync(bin, ['--version'], { encoding: 'utf8', timeout: 20000, windowsHide: true });
    const out = String((r.stdout || '') + (r.stderr || '')).trim();
    return out.split('\n')[0] || '';
  } catch {
    return '';
  }
}

let installing = null;

/**
 * 安装内核。source: 'cn' | 'intl'
 * 返回 { ok, version, bin, source, bytes, ms } 或抛错（错误同时写进 status.download.error）
 */
export function installEngine({ source = 'cn' } = {}) {
  if (installing) return installing;
  const src = SOURCES[source] || SOURCES.cn;
  const platform = platformKey();
  if (!platform) {
    const err = new Error('当前平台不支持自动安装内核（' + process.platform + '/' + process.arch + '），请用系统已装浏览器');
    return Promise.reject(err);
  }
  const paths = enginePaths(platform);
  const zipName = 'chrome-' + platform + '.zip';
  const url = src.base + '/' + ENGINE_VERSION + '/' + platform + '/' + zipName;

  installing = (async () => {
    setProgress({ busy: true, source: src.key, phase: 'downloading', received: 0, total: 0, percent: 0, speedBps: 0, error: '', startedAt: Date.now(), finishedAt: 0 });
    const tmpDir = path.join(ENGINE_ROOT, '.tmp');
    fs.mkdirSync(tmpDir, { recursive: true, mode: 0o700 });
    const zipFile = path.join(tmpDir, zipName);
    try {
      const dl = await download(url, zipFile);
      setProgress({ phase: 'verifying' });
      verifyZip(zipFile);
      setProgress({ phase: 'extracting' });
      // 先解到临时目录，成功后再替换，避免解压失败把旧内核也弄没
      const staging = path.join(tmpDir, 'extract');
      fs.rmSync(staging, { recursive: true, force: true });
      extract(zipFile, staging);
      setProgress({ phase: 'checking' });
      const probe = enginePaths(platform);
      const stagedRel = path.relative(probe.dir, probe.bin);
      const stagedBin = path.join(staging, stagedRel);
      if (!fs.existsSync(stagedBin)) throw new Error('解压后没找到 chrome 可执行文件（' + stagedRel + '）');
      if (process.platform !== 'win32') {
        try {
          fs.chmodSync(stagedBin, 0o755);
        } catch {}
      }
      const ver = chromeVersion(stagedBin);
      if (!ver) throw new Error('内核解压后无法运行（chrome --version 没有输出）');
      // 替换旧内核
      fs.rmSync(paths.dir, { recursive: true, force: true });
      fs.mkdirSync(path.dirname(paths.dir), { recursive: true });
      fs.renameSync(staging, paths.dir);
      const size = dirSize(paths.dir);
      const rec = {
        version: ENGINE_VERSION,
        platform,
        source: src.key,
        url,
        bin: paths.bin,
        size,
        chromeVersion: ver,
        installedAt: Date.now(),
      };
      fs.writeFileSync(RECORD_FILE, JSON.stringify(rec, null, 2) + '\n', { mode: 0o600 });
      fs.rmSync(zipFile, { force: true });
      fs.rmSync(staging, { recursive: true, force: true });
      setProgress({ phase: 'done', busy: false, finishedAt: Date.now(), percent: 100 });
      return { ok: true, version: ENGINE_VERSION, bin: paths.bin, source: src.key, bytes: dl.bytes, ms: Date.now() - state.startedAt, chromeVersion: ver };
    } catch (error) {
      try {
        fs.rmSync(zipFile, { force: true });
      } catch {}
      setProgress({ phase: 'error', busy: false, error: String((error && error.message) || error), finishedAt: Date.now() });
      throw error;
    } finally {
      installing = null;
    }
  })();
  return installing;
}

/** 删掉已安装内核（省空间 / 换源重装前） */
export function removeEngine() {
  const paths = enginePaths();
  if (paths) {
    try {
      fs.rmSync(paths.dir, { recursive: true, force: true });
    } catch {}
  }
  try {
    fs.rmSync(ENGINE_ROOT, { recursive: true, force: true });
  } catch {}
  setProgress({ phase: '', busy: false, received: 0, total: 0, percent: 0, speedBps: 0, error: '' });
  return { ok: true };
}
