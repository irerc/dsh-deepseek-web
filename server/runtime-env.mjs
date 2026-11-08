// 运行环境探测：决定「这台机器该用哪个浏览器内核」
//
// 浏览器内核不是一码事：
//   Windows  → WebView2（系统自带，随 Edge 更新）→ Edge → Chrome → 按需下载 Chrome for Testing
//   Android  → App 内 WebView（系统 Chromium，唯一稳的路；容器里跑 Chromium 会 SIGTRAP）
//   macOS    → Chrome / Chromium（WebKit 没有 CDP，不推荐）
//   Linux    → Chrome / Chromium → 按需下载
//
// 都找不到就给出建议：下载 Chrome for Testing（大陆镜像 / 国际直连，见 browser-engine.mjs）。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** DSH App 的本地桥（Android）：/app/version 能通说明 App 在，能走 App 内 WebView */
const ANDROID_BRIDGE = process.env.DSHA_BRIDGE || 'http://127.0.0.1:3090';

/** 是不是 Android（Termux / proot / 原生 node 都可能报告 linux） */
export function isAndroidHost() {
  if (process.platform === 'android') return true;
  if (process.env.TERMUX_VERSION || /termux/i.test(process.env.PREFIX || '')) return true;
  if (process.platform !== 'linux') return false;
  const probes = ['/system/build.prop', '/system/bin/app_process', '/system/bin/linker64'];
  try {
    if (probes.some((p) => fs.existsSync(p))) return true;
  } catch {}
  try {
    if (/android/i.test(fs.readFileSync('/proc/version', 'utf8'))) return true;
  } catch {}
  return false;
}

function exists(p) {
  try {
    return fs.existsSync(p);
  } catch {
    return false;
  }
}

function versionDirs(root, exe) {
  if (!exists(root)) return [];
  let names = [];
  try {
    names = fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  } catch {
    return [];
  }
  return names
    .map((name) => ({ name, bin: path.join(root, name, exe) }))
    .filter((x) => exists(x.bin))
    .sort((a, b) => cmpVer(b.name, a.name));
}

function cmpVer(a, b) {
  const pa = String(a).split(/[^\d]+/).filter(Boolean).map(Number);
  const pb = String(b).split(/[^\d]+/).filter(Boolean).map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d;
  }
  return 0;
}

/** Windows：WebView2 运行时（嵌入式首选，随 Edge 更新） */
function findWebView2() {
  const pf = process.env['ProgramFiles'] || 'C:\\Program Files';
  const pf86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
  const local = process.env['LOCALAPPDATA'] || '';
  const roots = [
    path.join(pf86, 'Microsoft', 'EdgeWebView', 'Application'),
    path.join(pf, 'Microsoft', 'EdgeWebView', 'Application'),
    local ? path.join(local, 'Microsoft', 'EdgeWebView', 'Application') : '',
  ].filter(Boolean);
  for (const root of roots) {
    const hit = versionDirs(root, 'msedgewebview2.exe')[0];
    if (hit) return { path: hit.bin, version: hit.name };
  }
  return null;
}

/** Windows：Edge 浏览器本体（可当普通 Chromium 用，支持 --remote-debugging-port） */
function findEdge() {
  const pf = process.env['ProgramFiles'] || 'C:\\Program Files';
  const pf86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
  const roots = [
    path.join(pf86, 'Microsoft', 'Edge', 'Application'),
    path.join(pf, 'Microsoft', 'Edge', 'Application'),
  ];
  for (const root of roots) {
    const hit = versionDirs(root, 'msedge.exe')[0];
    if (hit) return { path: hit.bin, version: hit.name };
  }
  return null;
}

/** Windows：Chrome */
function findWindowsChrome() {
  const pf = process.env['ProgramFiles'] || 'C:\\Program Files';
  const pf86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
  const local = process.env['LOCALAPPDATA'] || '';
  const direct = [
    path.join(pf, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(pf86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    local ? path.join(local, 'Google', 'Chrome', 'Application', 'chrome.exe') : '',
  ].filter(Boolean);
  for (const p of direct) if (exists(p)) return { path: p, version: '' };
  return null;
}

/** macOS / Linux：跑一遍 browserCandidates 太重，这里只做「有没有」的轻量判断 */
function findPosixBrowser() {
  const cands =
    process.platform === 'darwin'
      ? [
          '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
          '/Applications/Chromium.app/Contents/MacOS/Chromium',
          '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
        ]
      : ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/microsoft-edge', '/snap/bin/chromium'];
  for (const p of cands) if (exists(p)) return { path: p, version: '' };
  return null;
}

/** Android App 桥是否在线（决定「安卓 WebView 内核」能不能用） */
async function androidBridgeOnline() {
  const url = ANDROID_BRIDGE.replace(/\/+$/, '') + '/app/version';
  try {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), 1200);
    const res = await fetch(url, { signal: ac.signal, headers: { ...(process.env.DSHA_BRIDGE_TOKEN ? { authorization: 'Bearer ' + process.env.DSHA_BRIDGE_TOKEN } : {}) } });
    clearTimeout(t);
    if (!res.ok) return { online: false, status: res.status };
    const j = await res.json().catch(() => ({}));
    return { online: true, version: String(j.version || j.appVersion || ''), status: res.status };
  } catch (e) {
    return { online: false, status: 0, error: String(e.message || e) };
  }
}

function platformLabel() {
  const p = process.platform;
  const arch = process.arch;
  if (p === 'win32') return `Windows (${arch})`;
  if (p === 'darwin') return `macOS (${arch})`;
  if (p === 'linux') return `Linux (${arch})`;
  return `${p} (${arch})`;
}

function memGb() {
  try {
    return Math.round((os.totalmem() / 1073741824) * 10) / 10;
  } catch {
    return 0;
  }
}

/**
 * 探测结果：
 *   kernel.type: webview2 | edge | chrome | android-webview | posix-browser | none
 *   available:   现在就能用吗
 *   recommend:   不可用/次优时建议做什么：'download' | 'app-webview' | 'remote' | ''
 */
export async function detectRuntime() {
  const android = isAndroidHost();
  const platform = process.platform;
  const env = {
    platform,
    isAndroid: android,
    label: android && platform === 'linux' ? `Android 容器 (${process.arch})` : platformLabel(),
    arch: process.arch,
    node: process.version,
    memGb: memGb(),
    cpus: (() => { try { return os.cpus().length; } catch { return 0; } })(),
  };

  let kernel = { type: 'none', path: '', version: '', source: '' };
  let available = false;
  let recommend = '';
  let advice = '';

  if (android) {
    const bridge = await androidBridgeOnline();
    env.androidBridge = bridge;
    kernel = {
      type: 'android-webview',
      path: '',
      version: bridge.online ? 'App 内 WebView（Chromium）' : '',
      source: 'DSH App',
    };
    // 安卓上「插件自己拉 Chromium」跑不起来（proot 里一开页面 SIGTRAP，实测）。
    // 真正能用的是 App 内 WebView，需要 App 侧开 WebContentsDebugging + 暴露 CDP。
    available = bridge.online;
    recommend = bridge.online ? '' : 'app-webview';
    advice = bridge.online
      ? '检测到 DSH App：内核走 App 内 WebView（系统 Chromium）。插件侧 CDP 接入还在做，当前请求仍走 native 档。'
      : '安卓容器里没有可用的浏览器内核：容器内 Chromium 会 SIGTRAP（实测），系统 Chrome 也不允许远程调试。要用真浏览器，需要 App 内 WebView 或远程浏览器隧道。';
  } else if (platform === 'win32') {
    const wv2 = findWebView2();
    const edge = findEdge();
    const chrome = findWindowsChrome();
    env.windows = { webview2: Boolean(wv2), edge: Boolean(edge), chrome: Boolean(chrome) };
    if (wv2) {
      kernel = { type: 'webview2', path: wv2.path, version: wv2.version, source: '系统 WebView2 运行时' };
      available = true;
      advice = '用系统自带的 WebView2 运行时（随 Edge 更新，无需下载内核）。';
    } else if (edge) {
      kernel = { type: 'edge', path: edge.path, version: edge.version, source: '系统 Edge' };
      available = true;
      advice = '用系统 Edge（Chromium 内核，支持 CDP）。';
    } else if (chrome) {
      kernel = { type: 'chrome', path: chrome.path, version: chrome.version, source: '系统 Chrome' };
      available = true;
      advice = '用系统 Chrome。';
    } else {
      recommend = 'download';
      advice = 'Windows 上没找到 WebView2 / Edge / Chrome：建议下载 Chrome for Testing（约 200MB，win64）。';
    }
  } else {
    const posix = findPosixBrowser();
    if (posix) {
      kernel = { type: 'posix-browser', path: posix.path, version: posix.version, source: '系统浏览器' };
      available = true;
      advice = platform === 'darwin' ? '用系统 Chrome（WebKit 没有 CDP，不推荐）。' : '用系统 Chrome/Chromium。';
    } else {
      recommend = 'download';
      advice =
        platform === 'darwin'
          ? '没找到 Chrome：建议下载 Chrome for Testing（mac-arm64 / mac-x64）。'
          : '没找到 Chrome/Chromium：建议下载 Chrome for Testing（linux64 / linux-arm64）。';
    }
  }

  return { ...env, kernel, available, recommend, advice, at: Date.now() };
}

/** 给「按需下载」用的平台键（与 browser-engine 的 platformKey 对齐） */
export function recommendedPlatformKey() {
  if (process.platform === 'win32') return 'win64';
  if (process.platform === 'darwin') return process.arch === 'arm64' ? 'mac-arm64' : 'mac-x64';
  return process.arch === 'arm64' ? 'linux-arm64' : 'linux64';
}
