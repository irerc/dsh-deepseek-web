// DSH Host 插件：管理 HTTP 桥接器的生命周期，并提供设置界面的后端路由
//
// 设计：
//   - 本插件启动时只在 127.0.0.1:18081 起一个极轻量的「门」（gate），不拉引擎；
//   - 第一次真正调用网页版模型（或设置里点「启动」）时，才 spawn 真正的网关进程（127.0.0.1:18082）；
//   - 空闲超过 idleStopMs 自动关停子进程，回到只有 gate 的状态；
//   - 设置界面通过 /dsh-deepseek-web/* 路由读取账号、登录、改配置。
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { findBrowser, browserAvailability } from '../server/browser-transport.mjs';
import { loadConfig, saveConfig, resetConfig, STATE_DIR, ensureStateDir } from '../server/config.mjs';
import * as accounts from '../server/accounts.mjs';
import { sendEmailCode, loginWithEmailCode, checkToken, loginWithPassword, sendMfaCode, loginWithMfaCode, loginWithAppleIdToken } from '../server/login.mjs';
import { reloginAccount, reloginExpired } from '../server/relogin.mjs';
import { issueTicket } from '../server/autologin.mjs';
import { probeToken } from '../server/token-check.mjs';
import * as groups from '../server/groups.mjs';
import * as ledger from '../server/ledger.mjs';
// 登录代理按需动态加载，便于改完立即生效（无需重启 DSH）

export const name = 'deepseek-web';
export const inject = ['webServer'];

const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SERVER_ENTRY = path.join(PKG_ROOT, 'server', 'server.mjs');
const GATE_PORT = Number(process.env.DEEPSEEK_BRIDGE_PORT || 18081);
const ENGINE_PORT = Number(process.env.DEEPSEEK_ENGINE_PORT || GATE_PORT + 1);
const ROUTE = '/dsh-deepseek-web';

const PLUGIN_VERSION = (() => {
  try {
    const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    return String(pkg.version || '');
  } catch {
    return '';
  }
})();


// ---- 版本号比较 / 查询最新 release（检查更新与一键安装共用）----
function cmpVersion(a, b) {
  const pa = String(a).split('.').map(Number);
  const pb = String(b).split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0);
  }
  return 0;
}

async function fetchLatestRelease() {
  const resp = await fetch('https://api.github.com/repos/irerc/dsh-deepseek-web/releases/latest', {
    headers: { accept: 'application/vnd.github+json', 'user-agent': 'dsh-deepseek-web/' + PLUGIN_VERSION },
    signal: AbortSignal.timeout(15000),
  });
  const data = await resp.json().catch(() => ({}));
  const latest = String(data.tag_name || '').replace(/^v/, '');
  const asset = (data.assets || []).find((a) => /^dsh-deepseek-web-.*\.tgz$/.test(a.name || ''));
  return {
    latest,
    assetUrl: asset ? asset.browser_download_url : '',
    pageUrl: data.html_url || 'https://github.com/irerc/dsh-deepseek-web/releases',
    publishedAt: data.published_at || '',
  };
}

async function downloadFile(url, dest, timeoutMs = 60000) {
  const resp = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), redirect: 'follow' });
  if (!resp.ok) throw new Error('HTTP ' + resp.status);
  const buf = Buffer.from(await resp.arrayBuffer());
  if (buf.length < 20000) throw new Error('文件太小（' + buf.length + ' B），可能不是安装包');
  fs.writeFileSync(dest, buf);
  return buf.length;
}


// 磁盘上已安装的版本（link 安装时就是源码版本）。和运行中的版本不一致 = 需要重启 DSH。
function installedPluginVersion() {
  try {
    const profile = process.env.DSHA_STARTUP_PROFILE || 'web';
    const dshHome = path.dirname(path.dirname(STATE_DIR));
    const pkgJson = path.join(dshHome, 'profiles', profile, 'node_modules', 'dsh-deepseek-web', 'package.json');
    return String(JSON.parse(fs.readFileSync(pkgJson, 'utf8')).version || '');
  } catch {
    return '';
  }
}

export function apply(ctx, config = {}) {
  ensureStateDir();
  console.log('[deepseek-web] plugin apply, gate port will be', GATE_PORT);
  const logFile = path.join(STATE_DIR, 'engine.log');
  const log = (...args) => {
    const line = new Date().toISOString() + ' ' + args.join(' ');
    ctx.logger?.info?.('[deepseek-web] ' + args.join(' '));
    try {
      fs.appendFileSync(logFile, line + '\n');
    } catch {}
  };

  let child = null;
  let starting = null;
  let lastUsed = Date.now();
  let loginProxy = null;
  const LOGIN_PORT = Number(process.env.DSH_DEEPSEEK_LOGIN_PORT || 18090);
  const guiOrigin = () => {
    try {
      return ctx.webServer.getOrigin();
    } catch {
      return 'http://127.0.0.1:38445';
    }
  };
  // 让手机端系统浏览器直接打开登录页（WebView 常拦截 window.open，这条路更稳）。
  // 返回 Promise<boolean>：true = 已经交给设备/系统浏览器；false = 本机没有 DSH 桥（桌面），调用方自己开新标签页。
  const openOnDevice = (url) =>
    new Promise((resolve) => {
      let settled = false;
      const done = (v) => {
        if (!settled) {
          settled = true;
          resolve(v);
        }
      };
      try {
        const raw = fs.readFileSync('/root/.dsh/.bridge_headers', 'utf8').trim().split('\n');
        const headers = {};
        for (const line of raw) {
          const i = line.indexOf(':');
          if (i > 0) headers[line.slice(0, i).trim()] = line.slice(i + 1).trim();
        }
        const req = http.get(
          { host: '127.0.0.1', port: 3090, path: '/app/open?url=' + encodeURIComponent(url), headers, timeout: 6000 },
          (r) => {
            r.resume();
            done(r.statusCode >= 200 && r.statusCode < 300);
          },
        );
        req.on('error', () => done(false));
        req.on('timeout', () => {
          req.destroy();
          done(false);
        });
      } catch {
        done(false);
      }
    });

  // 站点把禁言状态放在 user.chat 里（is_muted / mute_until 秒）；统一在一处同步到账号池
  const syncMuteFromUser = (accountId, user) => {
    try {
      const chat = user?.chat || {};
      const until = chat.is_muted && chat.mute_until ? Number(chat.mute_until) * 1000 : 0;
      if (until > Date.now()) {
        accounts.markMuted(accountId, until, { reason: '站点禁言' });
        return { muted: true, muteUntil: until };
      }
      accounts.clearMuted(accountId);
    } catch {}
    return { muted: false };
  };

  let loginProxyMtime = 0;
  // 登录会话（jar）的读写都在 proxy.mjs 里，这里按需 import 一份：
  // 这些函数只读磁盘，不依赖登录代理进程是否在跑，所以不需要先 ensureLoginProxy。
  const loadSessionApi = async () => {
    try {
      return await import(new URL('../server/proxy.mjs?t=' + Date.now(), import.meta.url).href);
    } catch (error) {
      log('读取登录会话失败：' + error.message);
      return null;
    }
  };
  const ensureLoginProxy = async () => {
    // 改过 server/proxy.mjs 就重载（改代理代码不用重启 DSH）；没改就复用现有实例。
    // 以前每次点「登录」都关掉重建：这会打断正在加载的 iframe（页面上就是白屏），
    // 也把页面缓存和 keep-alive 连接一起丢掉，风控一来就更容易白屏。
    let mtime = 0;
    try {
      const proxyFile = new URL('../server/proxy.mjs', import.meta.url);
      mtime = fs.statSync(proxyFile).mtimeMs;
    } catch {}
    if (loginProxy && loginProxyMtime === mtime) return `http://127.0.0.1:${LOGIN_PORT}/`;
    try {
      loginProxy?.close();
    } catch {}
    loginProxy = null;
    const mod = await import(new URL('../server/proxy.mjs?t=' + Date.now(), import.meta.url).href);
    loginProxy = mod.startLoginProxy({
      port: LOGIN_PORT,
      reportUrl: guiOrigin() + '/dsh-deepseek-web/login/token',
    });
    loginProxy.on('error', (error) => log('登录代理异常：' + error.message));
    loginProxyMtime = mtime;
    log('登录代理已启动 127.0.0.1:' + LOGIN_PORT);
    // 预热：先替用户把登录页抓一遍。抓成功会进页面缓存，之后哪怕站点风控间歇性 202，
    // 也能把整页发出来；顺带把 TLS 连接建好，移动网络下少一次握手就少一次白屏。
    setTimeout(() => {
      try {
        const warm = http.get({ host: '127.0.0.1', port: LOGIN_PORT, path: '/sign_in', timeout: 12000 }, (res) => res.resume());
        warm.on('timeout', () => warm.destroy());
        warm.on('error', () => {});
      } catch {}
    }, 50).unref?.();
    return `http://127.0.0.1:${LOGIN_PORT}/`;
  };

  const engineAlive = () =>
    new Promise((resolve) => {
      const req = http.get({ host: '127.0.0.1', port: ENGINE_PORT, path: '/health', timeout: 1500 }, (res) => {
        res.resume();
        resolve(res.statusCode === 200);
      });
      req.on('timeout', () => {
        req.destroy();
        resolve(false);
      });
      req.on('error', () => resolve(false));
    });

  const stopEngine = (reason = '') => {
    if (!child) return;
    log('停止引擎', reason);
    try {
      child.kill('SIGTERM');
    } catch {}
    child = null;
  };

  const startEngine = async () => {
    if (child && (await engineAlive())) return true;
    if (starting) return starting;
    starting = (async () => {
      const cfg = loadConfig();
      const out = fs.openSync(logFile, 'a');
      log('拉起引擎 pid=? port=' + ENGINE_PORT);
      child = spawn(process.execPath, [SERVER_ENTRY], {
        env: {
          ...process.env,
          DEEPSEEK_BRIDGE_PORT: String(ENGINE_PORT),
          DSH_DEEPSEEK_WEB_STATE: STATE_DIR,
          DS_MAX_CONCURRENCY: String(cfg.maxConcurrency),
        },
        stdio: ['ignore', out, out],
        detached: false,
      });
      child.on('exit', (code, signal) => {
        log('引擎退出 code=' + code + ' signal=' + signal);
        child = null;
      });
      const deadline = Date.now() + 15000;
      while (Date.now() < deadline) {
        if (await engineAlive()) {
          log('引擎就绪 pid=' + (child ? child.pid : '?'));
          return true;
        }
        await new Promise((r) => setTimeout(r, 250));
      }
      log('引擎启动超时');
      stopEngine('启动超时');
      return false;
    })().finally(() => {
      starting = null;
    });
    return starting;
  };

  // 空闲回收
  const sweeper = setInterval(() => {
    const cfg = loadConfig();
    if (child && Date.now() - lastUsed > cfg.idleStopMs) stopEngine('空闲超时');
  }, 30000);
  sweeper.unref?.();

  // 老账号只有「浏览器登录」这种名字：启动后顺手把邮箱补上（只补缺的，最多 10 个）。
  // 这样某个账号登录失效时，界面能直接告诉用户是哪个账号，而不是一排同样的「浏览器登录」。
  const backfillEmails = async () => {
    try {
      const list = accounts.listAccounts().filter((a) => !a.email).slice(0, 10);
      for (const a of list) {
        try {
          const token = accounts.getToken(a.id);
          if (!token) continue;
          const check = await checkToken(token);
          if (check.ok && check.user?.email) {
            accounts.noteEmail(a.id, { email: check.user.email, userId: check.user.id || '' });
            log('补账号名：' + a.id + ' → ' + check.user.email);
          }
        } catch {}
        await new Promise((r) => setTimeout(r, 800));
      }
    } catch {}
  };
  setTimeout(backfillEmails, 4000).unref?.();

  // token 失效 + 存了密码的账号：启动后补一轮，之后每 2 分钟扫一次（每个账号自带冷却，不会打到风控）
  const sweepRelogin = async (reason) => {
    try {
      const out = await reloginExpired({ limit: 2, reason });
      for (const r of out.results) {
        if (r.ok) log('自动重登成功（' + reason + '）：' + r.label + ' → ' + (r.account?.email || r.id));
        else if (!r.cooled && !r.skipped) log('自动重登未成功（' + reason + '）：' + r.label + ' — ' + (r.message || ''));
      }
    } catch (error) {
      log('自动重登扫描失败：' + (error.message || error));
    }
  };
  setTimeout(() => sweepRelogin('启动'), 9000).unref?.();
  // 10 分钟一次：以前 2 分钟一次，失效账号（尤其被风控的）会被反复撞，反而越撞越死
  const reloginTimer = setInterval(() => sweepRelogin('定时'), 10 * 60 * 1000);
  reloginTimer.unref?.();

  // token 体检：/api/v0/users/current 是只读接口，不消耗对话额度。
  // 以前只有「对话失败」才发现登录失效，用户看到的是整轮失败；现在启动后 + 每 20 分钟各扫一遍，
  // 失效马上在面板上体现出来，存了密码的还能赶在下一次对话之前自动重登。
  // 关键：只有站点明确回 INVALID_TOKEN（401 / 40002 / 40003）才算失效；
  // 网络抖动、WAF 拦截页、限流一律 unknown，只记日志、不动账号状态。
  const tokenSweep = async (reason = '定时') => {
    const out = { checked: 0, invalid: 0, recovered: 0, relogged: 0, skipped: 0 };
    let list = [];
    try {
      list = accounts.listAccounts();
    } catch {
      return out;
    }
    for (const a of list) {
      if (a.disabled) continue;
      const token = accounts.getToken(a.id);
      if (!token) continue;
      let probe;
      try {
        probe = await probeToken(token);
      } catch {
        continue;
      }
      out.checked += 1;
      const who = a.email || a.label || a.id;
      if (probe.state === 'valid') {
        // 以前被误标成失效的好号：自动恢复（这种情况用户会以为「又掉登录了」）
        if (a.status === 'authExpired') {
          accounts.clearStatus(a.id);
          out.recovered += 1;
          log('token 体检：' + who + ' 其实还有效，已恢复为正常');
        }
        if (!a.email && probe.user?.email) {
          accounts.noteEmail(a.id, { email: probe.user.email, userId: probe.user.id || '' });
        }
        continue;
      }
      if (probe.state !== 'invalid') {
        out.skipped += 1;
        log('token 体检跳过（没验出来，不标记失效）：' + who + ' — ' + String(probe.message || '').slice(0, 80));
        continue;
      }
      out.invalid += 1;
      if (a.status !== 'authExpired') {
        accounts.markAuthExpired(a.id);
        log('token 体检：' + who + ' 登录已失效（站点回 ' + (probe.message || 'INVALID_TOKEN') + '）');
      }
      if (a.hasPassword) {
        const r = await reloginAccount(a.id, { reason: 'check' });
        if (r.ok) {
          out.relogged += 1;
          log('token 体检：已用保存的密码自动重登成功 ' + who);
        } else {
          log('token 体检：自动重登未成功 ' + who + ' — ' + String(r.message || '').slice(0, 120));
        }
      }
      await new Promise((r) => setTimeout(r, 600));
    }
    if (reason === '启动' || out.invalid) {
      log('token 体检（' + reason + '）：检查 ' + out.checked + '，失效 ' + out.invalid + '，恢复 ' + out.recovered + '，重登成功 ' + out.relogged + '，未验出 ' + out.skipped);
    }
    return out;
  };
  setTimeout(() => tokenSweep('启动').catch(() => {}), 15000).unref?.();
  // 探活间隔可配（默认 30 分钟，0 = 关闭）；改设置后立刻按新间隔重排
  let tokenTimer = null;
  const scheduleTokenSweep = () => {
    if (tokenTimer) clearInterval(tokenTimer);
    tokenTimer = null;
    const ms = Number(loadConfig().probeIntervalMs || 0);
    if (ms > 0) {
      tokenTimer = setInterval(() => tokenSweep('定时').catch(() => {}), Math.max(60000, ms));
      tokenTimer.unref?.();
    }
  };
  scheduleTokenSweep();

  // ---- 门：始终监听 18081，按需拉起并转发 ----
  const proxyTo = (req, res) => {
    const upstream = http.request(
      { host: '127.0.0.1', port: ENGINE_PORT, path: req.url, method: req.method, headers: { ...req.headers, host: '127.0.0.1:' + ENGINE_PORT } },
      (up) => {
        res.writeHead(up.statusCode || 502, up.headers);
        up.pipe(res);
      },
    );
    upstream.on('error', (error) => {
      if (!res.headersSent) {
        res.writeHead(502, { 'content-type': 'application/json' });
      }
      res.end(JSON.stringify({ error: { message: '桥接器不可用：' + error.message, type: 'upstream_error' } }));
    });
    req.pipe(upstream);
  };

  const gate = http.createServer(async (req, res) => {
    lastUsed = Date.now();
    const url = new URL(req.url, 'http://127.0.0.1');
    if (url.pathname === '/health' && !(await engineAlive())) {
      const cfg = loadConfig();
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(
        JSON.stringify({
          ok: true,
          engine: 'idle',
          autoStart: cfg.autoStart,
          accounts: accounts.listAccounts().map((a) => ({ id: a.id, label: a.label, status: a.status })),
        }),
      );
    }
    if (!(await startEngine())) {
      res.writeHead(503, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ error: { message: '桥接器启动失败，请查看设置里的日志', type: 'engine_start_failed' } }));
    }
    proxyTo(req, res);
  });

  gate.on('error', (error) => log('gate 监听失败：' + error.message));
  try {
    gate.listen(GATE_PORT, '127.0.0.1', () => {
      log('门已监听 127.0.0.1:' + GATE_PORT);
      console.log('[deepseek-web] gate listening on', GATE_PORT);
    });
  } catch (error) {
    log('门监听异常：' + error.message);
  }

  // 批量登录遇到 MFA 时，把密码暂存在内存里（不写日志、不回传前端），等用户填验证码后一起存
  const pendingCredentials = new Map();

  // ---- 设置界面后端路由 ----
  const readBody = (req) =>
    new Promise((resolve, reject) => {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        try {
          resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {});
        } catch (error) {
          reject(error);
        }
      });
      req.on('error', reject);
    });

  // 允许 chat.deepseek.com 的书签脚本直接回填 token（仅这一个 origin，且只读回填）
  const corsFor = (req) => {
    const origin = req.headers.origin;
    const allowed = ['https://chat.deepseek.com', `http://127.0.0.1:${LOGIN_PORT}`, `http://localhost:${LOGIN_PORT}`];
    if (!allowed.includes(origin)) return {};
    return {
      'access-control-allow-origin': origin,
      'access-control-allow-methods': 'POST, OPTIONS',
      'access-control-allow-headers': 'content-type',
      'access-control-allow-private-network': 'true',
      vary: 'origin',
    };
  };

  const send = (req, res, status, data) => {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...corsFor(req) });
    res.end(JSON.stringify(data));
  };

  const route = { kind: 'prefix', path: ROUTE, handler: async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const sub = url.pathname.slice(ROUTE.length) || '/';
    if (req.method === 'OPTIONS') {
      res.writeHead(204, corsFor(req));
      return res.end();
    }
    try {
      if (req.method === 'GET' && sub === '/state') {
        const cfg = loadConfig();
        let usage = null;
        try { usage = JSON.parse(fs.readFileSync(path.join(STATE_DIR, 'usage.json'), 'utf8')); } catch {}
        const alive = await engineAlive();
        const installedVersion = installedPluginVersion();
        // 浏览器可用性：不只是「文件在不在」，还包括「起不起得来」（结果缓存 5 分钟）
        let avail = null;
        try { avail = await browserAvailability(); } catch (e) { avail = { ok: false, found: false, path: '', version: '', reason: String(e.message || e) }; }
        return send(req, res, 200, {
          engine: alive ? 'running' : child || starting ? 'starting' : 'idle',
          transport: {
            mode: cfg.transport,
            // auto 时引擎实际会走哪条路（浏览器起不来就是 node，设置页要显式告诉用户）
            effective: cfg.transport === 'node' ? 'node' : cfg.transport === 'browser' ? 'browser' : avail && avail.ok ? 'browser' : 'node',
            browser: avail && avail.path ? avail.path : (() => { try { return findBrowser() || ''; } catch { return ''; } })(),
            status: avail,
          },
          installedVersion,
          needRestart: Boolean(installedVersion && installedVersion !== PLUGIN_VERSION),
          port: GATE_PORT,
          enginePort: ENGINE_PORT,
          config: cfg,
          version: PLUGIN_VERSION,
          accounts: accounts.listAccounts(),
          groups: groups.readGroups(),
          usage,
          logTail: tailLog(logFile, 40),
        });
      }
      if (req.method === 'POST' && sub === '/config') {
        const patch = await readBody(req);
        const next = saveConfig(patch);
        if (patch && Object.prototype.hasOwnProperty.call(patch, 'probeIntervalMs') && typeof scheduleTokenSweep === 'function') {
          scheduleTokenSweep();
        }
        return send(req, res, 200, { ok: true, config: next });
      }
      if (req.method === 'POST' && sub === '/transport/probe') {
        // 两级检测：① 冒烟启动（找到没有 / 起不起得来 / 什么版本）② 真的起 BrowserTransport 连 CDP、开页面。
        // 只做①就够判断「本机有没有可用浏览器」，②是给能起浏览器的机器验证端到端。
        const started = Date.now();
        const avail = await browserAvailability({ force: true });
        if (!avail.ok) {
          return send(req, res, 200, {
            ok: false,
            found: Boolean(avail.found),
            browser: avail.path || '',
            version: avail.version || '',
            reason: avail.reason || '',
            tail: avail.tail || '',
            error: avail.found
              ? '浏览器找到了但起不来：' + (avail.reason || '') + (avail.tail ? '；' + String(avail.tail).slice(0, 200) : '')
              : avail.reason || '没找到浏览器',
            ms: Date.now() - started,
          });
        }
        const { BrowserTransport } = await import('../server/browser-transport.mjs');
        const bt = new BrowserTransport((m) => log(m));
        try {
          await bt.ensure();
          return send(req, res, 200, {
            ok: true,
            found: true,
            browser: avail.path || bt.browserPath,
            version: avail.version || '',
            ms: Date.now() - started,
          });
        } catch (e) {
          return send(req, res, 200, {
            ok: false,
            found: true,
            browser: avail.path || bt.browserPath,
            version: avail.version || '',
            error: String(e.message || e),
            ms: Date.now() - started,
          });
        } finally {
          bt.close();
        }
      }
      if (req.method === 'GET' && sub === '/ledger') {
        // 调用台账：最近 N 小时的调用数/失败分类/间隔分布（数据来自 server/ledger.mjs）
        try { ledger.pruneLedger(7); } catch {}
        return send(req, res, 200, { ok: true, ...ledger.summarizeLedger(url.searchParams.get('hours') || 24) });
      }
      if (req.method === 'GET' && sub === '/groups') {
        return send(req, res, 200, { ok: true, groups: groups.readGroups() });
      }
      if (req.method === 'POST' && sub === '/groups/create') {
        const { name } = await readBody(req);
        const out = groups.createGroup(name);
        if (!out.ok) return send(req, res, 200, { ok: false, message: out.error, groups: out.list });
        log('新建账号分组：' + out.group.name);
        return send(req, res, 200, { ok: true, group: out.group, groups: out.list, message: '已创建分组「' + out.group.name + '」' });
      }
      if (req.method === 'POST' && sub === '/groups/rename') {
        const { id, name } = await readBody(req);
        const out = groups.renameGroup(String(id || ''), name);
        if (!out.ok) return send(req, res, 200, { ok: false, message: out.error, groups: out.list });
        return send(req, res, 200, { ok: true, group: out.group, groups: out.list, message: '分组已改名为「' + out.group.name + '」' });
      }
      if (req.method === 'POST' && sub === '/groups/delete') {
        const { id } = await readBody(req);
        const out = groups.removeGroup(String(id || ''));
        log('删除账号分组：' + String(id || ''));
        return send(req, res, 200, { ok: true, groups: out.list, message: '分组已删除；组里的账号回到「未分组」（账号本身没动）' });
      }
      if (req.method === 'GET' && sub === '/diagnostics') {
        // 登录状态卡：适配器/凭证来源/PoW wasm/登录代理/站点连通性；?verify=1 时额外验一次 token
        const verify = url.searchParams.get('verify') === '1';
        const list = accounts.listAccounts();
        const activeId = loadConfig().activeAccountId || '';
        const active = list.find((a) => a.id === activeId) || list.find((a) => a.status === 'ok' && !a.muted && !a.banned) || list[0] || null;
        let pow = { ok: false, ms: 0, message: '未检测' };
        try {
          const t = Date.now();
          const mod = await import('../server/pow.mjs');
          const ok = await mod.selfTest();
          pow = { ok: Boolean(ok), ms: Date.now() - t, wasm: fs.existsSync(path.join(PKG_ROOT, 'server', 'sha3_wasm_bg.wasm')) };
        } catch (error) {
          pow = { ok: false, ms: 0, message: String(error && error.message ? error.message : error) };
        }
        let proxy = { ok: false };
        try {
          proxy = await new Promise((resolve) => {
            const started = Date.now();
            const req2 = http.get({ host: '127.0.0.1', port: LOGIN_PORT, path: '/__dsweb/health', timeout: 3000 }, (r2) => {
              const chunks = [];
              r2.on('data', (c) => chunks.push(c));
              r2.on('end', () => {
                let data = null;
                try { data = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch {}
                resolve({ ok: r2.statusCode === 200 && Boolean(data && data.ok), ms: Date.now() - started, health: data });
              });
            });
            req2.on('timeout', () => { req2.destroy(); resolve({ ok: false, message: '登录代理 3 秒没响应' }); });
            req2.on('error', (e2) => resolve({ ok: false, message: String(e2.message || e2) }));
          });
        } catch (error) {
          proxy = { ok: false, message: String(error && error.message ? error.message : error) };
        }
        let site = null;
        let verified = null;
        if (verify) {
          const started = Date.now();
          try {
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), 8000);
            const r3 = await fetch('https://chat.deepseek.com/', { method: 'GET', signal: controller.signal, redirect: 'manual' });
            clearTimeout(timer);
            site = { ok: r3.status < 500, status: r3.status, ms: Date.now() - started };
          } catch (error) {
            site = { ok: false, ms: Date.now() - started, message: String(error && error.message ? error.message : error) };
          }
          if (active) {
            const t = Date.now();
            const token = accounts.getToken(active.id);
            const probe = await probeToken(token);
            verified = {
              accountId: active.id,
              name: active.email || active.label,
              state: probe.state,
              message: probe.message || '',
              user: probe.user || null,
              ms: Date.now() - t,
            };
          }
        }
        return send(req, res, 200, {
          ok: true,
          version: PLUGIN_VERSION,
          installedVersion: installedPluginVersion(),
          engine: (await engineAlive()) ? 'running' : child || starting ? 'starting' : 'idle',
          ports: { gate: GATE_PORT, engine: ENGINE_PORT, login: LOGIN_PORT },
          adapter: { registered: true, provider: 'deepseek-web', models: [{ id: 'deepseek-chat', name: 'DeepSeek-V3(web)', thinking: false }, { id: 'deepseek-reasoner', name: 'DeepSeek-R1(web)', thinking: true }] },
          accounts: {
            total: list.length,
            withFingerprint: list.filter((a) => a.hasFingerprint).length,
            withPassword: list.filter((a) => a.hasPassword).length,
            active: active ? { id: active.id, name: active.email || active.label, status: active.status, loginSource: active.loginSource || '', hasFingerprint: Boolean(active.hasFingerprint), cookieShape: active.cookieShape } : null,
          },
          pow,
          proxy,
          site,
          verified,
        });
      }
      if (req.method === 'GET' && sub === '/accounts/export') {
        // 账号库备份（含 token/cookie，等于可完整登录的凭证）——参考实现的「导出备份」
        return send(req, res, 200, { ok: true, ...accounts.exportAccounts() });
      }
      if (req.method === 'POST' && sub === '/accounts/import') {
        const body = await readBody(req);
        const out = accounts.importAccounts(body?.data ?? body);
        log('导入账号备份：新增 ' + out.added + '，已存在 ' + out.merged + '，共 ' + out.total);
        return send(req, res, 200, { ok: true, ...out, message: '导入完成：新增 ' + out.added + ' 个，合并已存在 ' + out.merged + ' 个' });
      }
      if (req.method === 'POST' && sub === '/usage/reset') {
        // 清空插件累计的 token 用量记录（只删记录，不影响账号/会话）
        const file = path.join(STATE_DIR, 'usage.json');
        try { fs.rmSync(file, { force: true }); } catch (error) { log('清空用量失败：' + error.message); }
        return send(req, res, 200, { ok: true, usage: null });
      }
      if (req.method === 'POST' && sub === '/accounts/purge') {
        // 删除所有已登录账号与 token（危险操作，仅由「重置」窗口里的复选框触发）
        const count = accounts.clearAccounts();
        log('已删除全部账号：' + count + ' 个');
        return send(req, res, 200, { ok: true, removed: count });
      }
      if (req.method === 'POST' && sub === '/factory-reset') {
        // 彻底删除所有账号和数据：账号/token/cookie、用量统计、登录抓取的 cookie 罐、运行配置
        const removed = accounts.clearAccounts();
        const dir = STATE_DIR;
        const targets = ['usage.json', 'config.json'];
        try {
          for (const name of fs.readdirSync(dir)) {
            if (name.startsWith('jar-') && name.endsWith('.json')) targets.push(name);
          }
        } catch {}
        let deleted = 0;
        for (const name of targets) {
          try {
            fs.rmSync(path.join(dir, name), { force: true });
            deleted += 1;
          } catch (error) {
            log('删除 ' + name + ' 失败：' + error.message);
          }
        }
        log('彻底删除：账号 ' + removed + ' 个，文件 ' + deleted + ' 个');
        return send(req, res, 200, { ok: true, removed, deleted });
      }
      if (req.method === 'POST' && sub === '/config/reset') {
        // 恢复默认运行设置与卡片顺序（不删除已登录账号）
        return send(req, res, 200, { ok: true, config: resetConfig() });
      }
      if (req.method === 'POST' && sub === '/engine/start') {
        const ok = await startEngine();
        return send(req, res, ok ? 200 : 503, { ok });
      }
      if (req.method === 'POST' && sub === '/engine/stop') {
        stopEngine('手动停止');
        return send(req, res, 200, { ok: true });
      }
      if (req.method === 'POST' && sub === '/login/browser') {
        // 打开登录页：一定走本机代理（18090）而不是 chat.deepseek.com，
        // 否则登录成功后注入脚本不在页面上，插件根本拿不到 token。
        const body = await readBody(req).catch(() => ({}));
        const id = String((body && body.accountId) || '').trim();
        const base = (await ensureLoginProxy()).replace(/\/$/, '');
        let url = base + '/sign_in';
        if (id) url += '?__dsweb_acct=' + encodeURIComponent(id);
        const opened = await openOnDevice(url);
        return send(req, res, 200, { ok: true, url, opened, accountId: id || '' });
      }
      if (req.method === 'POST' && sub === '/login/embed') {
        // 内嵌登录（实验性）：直接把登录代理地址交给设置页，由设置页用 iframe 显示。
        // 和 /login/browser 的区别：不调用系统浏览器（openOnDevice），不新开标签页。
        // 带上 accountId 时顺带签发自动填充票据，方便失效账号原地重登。
        const body = await readBody(req).catch(() => ({}));
        const base = (await ensureLoginProxy()).replace(/\/$/, '');
        const id = String((body && body.accountId) || '').trim();
        let url = base + '/sign_in';
        let autofillMode = '';
        if (id) {
          // 告诉登录页「这次登录的是哪个账号」：登录成功后原地替换 token，不会多出一个重复账号
          url += '?__dsweb_acct=' + encodeURIComponent(id);
          const target = accounts.listAccounts().find((a) => a.id === id);
          const cred = target ? accounts.getCredential(id) : null;
          const fullEmail = target && target.email && !String(target.email).includes('*') ? target.email : '';
          if (cred && cred.password && cred.email && !String(cred.email).includes('*')) {
            // 存过密码：邮箱+密码都自动填好并自动提交
            url += '&__dsweb_auto=' + issueTicket({ accountId: id, email: cred.email, password: cred.password, reason: 'relogin' });
            autofillMode = 'full';
          } else if (fullEmail) {
            // 只存了完整邮箱：先填邮箱，密码由用户输入（登录成功后密码会自动加密保存）
            url += '&__dsweb_auto=' + issueTicket({ accountId: id, email: fullEmail, password: '', reason: 'relogin' });
            autofillMode = 'email';
          }
        }
        log('内嵌登录窗口：' + (id || '新账号') + (autofillMode === 'full' ? '（账号密码已预填）' : autofillMode === 'email' ? '（邮箱已预填）' : ''));
        return send(req, res, 200, { ok: true, url, accountId: id || '', autofill: Boolean(autofillMode), autofillMode });
      }
      if (req.method === 'GET' && sub === '/apple') {
        // Apple 登录页：和设置页同源，拿去开个小窗口，Apple 授权完成后直接把 id_token 换 token
        try {
          const html = fs.readFileSync(new URL('../server/apple.html', import.meta.url), 'utf8');
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
          return res.end(html);
        } catch (error) {
          return send(req, res, 500, { ok: false, message: 'Apple 登录页读取失败：' + error.message });
        }
      }
      if (req.method === 'POST' && sub === '/login/apple') {
        const body = await readBody(req);
        const out = await loginWithAppleIdToken(body.idToken);
        if (!out.ok) {
          log('Apple 登录失败：' + (out.message || ''));
          return send(req, res, 200, { ok: false, needBindMobile: Boolean(out.needBindMobile), risk: Boolean(out.risk), banned: Boolean(out.banned), message: out.message });
        }
        const account = accounts.addAccount({
          token: out.token,
          label: String(body.label || '').trim() || 'Apple 登录',
          email: out.user?.email || '',
          userId: out.user?.id || '',
        });
        const appleMute = syncMuteFromUser(account.id, out.user);
        if (appleMute.muted) {
          return send(req, res, 200, {
            ok: true,
            account,
            muted: true,
            muteUntil: appleMute.muteUntil,
            message: '已登录，但这个账号被站点禁言至 ' + new Date(appleMute.muteUntil).toLocaleString('zh-CN'),
          });
        }
        log('Apple 登录成功：' + account.id + ' ' + account.email);
        return send(req, res, 200, { ok: true, account });
      }
      if (req.method === 'GET' && sub === '/update/check') {
        // 查 GitHub 最新 release，和当前版本比较（只读，不自动安装）
        try {
          const rel = await fetchLatestRelease();
          return send(req, res, 200, {
            ok: true,
            current: PLUGIN_VERSION,
            latest: rel.latest || PLUGIN_VERSION,
            hasUpdate: rel.latest ? cmpVersion(rel.latest, PLUGIN_VERSION) > 0 : false,
            url: rel.pageUrl,
            assetUrl: rel.assetUrl,
            mirror: rel.assetUrl ? 'https://gh-proxy.com/' + rel.assetUrl : '',
            publishedAt: rel.publishedAt,
          });
        } catch (error) {
          return send(req, res, 200, { ok: false, message: '检查更新失败：' + (error.message || error) });
        }
      }
      if (req.method === 'POST' && sub === '/update/install') {
        // 一键安装：下载最新 tgz → 替换 <DSH_HOME>/profiles/<profile>/node_modules/dsh-deepseek-web
        // 只替换插件自己的目录，先备份旧目录，失败自动回滚；装完需要重启 DSH 生效。
        try {
          const rel = await fetchLatestRelease();
          if (!rel.latest) return send(req, res, 200, { ok: false, message: '获取最新版本失败，请检查网络或稍后重试' });
          if (cmpVersion(rel.latest, PLUGIN_VERSION) <= 0) {
            return send(req, res, 200, { ok: true, upToDate: true, version: PLUGIN_VERSION, message: '当前已是最新版本 v' + PLUGIN_VERSION });
          }
          if (!rel.assetUrl) return send(req, res, 200, { ok: false, message: 'v' + rel.latest + ' 没有发布安装包，请手动安装' });

          const profile = process.env.DSHA_STARTUP_PROFILE || 'web';
          const dshHome = path.dirname(path.dirname(STATE_DIR)); // <DSH_HOME>/storages/<id> → <DSH_HOME>
          const pkgDir = path.join(dshHome, 'profiles', profile, 'node_modules', 'dsh-deepseek-web');
          let st = null;
          try { st = fs.lstatSync(pkgDir); } catch {}
          if (st && st.isSymbolicLink()) {
            return send(req, res, 200, { ok: false, message: '当前是 link 安装（开发模式），一键安装会破坏链接，请手动更新：' + rel.assetUrl });
          }
          if (!st) return send(req, res, 200, { ok: false, message: '找不到插件安装目录：' + pkgDir + '，请手动安装：' + rel.assetUrl });
          const onDisk = (() => {
            try { return JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8')).version || ''; } catch { return ''; }
          })();
          if (onDisk && cmpVersion(onDisk, rel.latest) >= 0) {
            return send(req, res, 200, { ok: true, installed: true, upToDate: true, version: onDisk, needRestart: true, message: '磁盘上已经是 v' + onDisk + ' 了，重启 DSH 即可生效' });
          }

          const cacheDir = path.join(STATE_DIR, 'updates');
          fs.mkdirSync(cacheDir, { recursive: true });
          const file = path.join(cacheDir, 'dsh-deepseek-web-' + rel.latest + '.tgz');
          const sources = ['https://gh-proxy.com/' + rel.assetUrl, rel.assetUrl];
          let size = 0;
          let used = '';
          for (const src of sources) {
            try {
              size = await downloadFile(src, file, 90000);
              used = src;
              break;
            } catch (error) {
              log('下载安装包失败（' + src + '）：' + error.message);
            }
          }
          if (!size) return send(req, res, 200, { ok: false, message: '下载安装包失败，请检查网络（可手动下载：' + rel.assetUrl + '）' });

          const tmpDir = path.join(cacheDir, 'unpack-' + Date.now());
          fs.mkdirSync(tmpDir, { recursive: true });
          execFileSync('tar', ['-xzf', file, '-C', tmpDir], { timeout: 60000 });
          const inner = path.join(tmpDir, 'package');
          const pkg = JSON.parse(fs.readFileSync(path.join(inner, 'package.json'), 'utf8'));
          if (String(pkg.version) !== rel.latest) throw new Error('安装包版本不符：' + pkg.version + ' ≠ ' + rel.latest);

          // 备份旧目录 → 换上新目录；中途失败就回滚
          for (const old of fs.readdirSync(path.dirname(pkgDir)).filter((n) => n.startsWith('dsh-deepseek-web.bak-'))) {
            try { fs.rmSync(path.join(path.dirname(pkgDir), old), { recursive: true, force: true }); } catch {}
          }
          // 换文件前先把引擎子进程停掉，避免它还在跑旧代码
          try { stopEngine('安装新版本'); } catch {}
          const bakDir = pkgDir + '.bak-' + Date.now();
          fs.renameSync(pkgDir, bakDir);
          try {
            fs.renameSync(inner, pkgDir);
          } catch (error) {
            try { fs.renameSync(bakDir, pkgDir); } catch {}
            throw error;
          }
          try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
          log('已安装新版本 v' + pkg.version + '（来源 ' + used + '，旧版本备份在 ' + bakDir + '）');
          return send(req, res, 200, { ok: true, installed: true, version: pkg.version, needRestart: true, message: '已安装 v' + pkg.version + '，重启 DSH 后生效' });
        } catch (error) {
          log('一键安装失败：' + (error.message || error));
          return send(req, res, 200, { ok: false, message: '安装失败：' + (error.message || error) });
        }
      }
      if (req.method === 'POST' && sub === '/login/password') {
        // 邮箱 + 密码登录（不走浏览器；中国大陆网络下也可用，不需要代理）
        const { email, password, label, savePassword } = await readBody(req);
        const out = await loginWithPassword(email, password);
        if (out.ok) {
          const account = accounts.addAccount({
            token: out.token,
            label: label || String(email).split('@')[0],
            email: email || out.user?.email || '',
            userId: out.user?.id || '',
            // 默认保存密码：token 过期/失效后可以自动重新登录
            password: savePassword === false ? '' : password,
            loginEmail: email,
          });
          return send(req, res, 200, { ok: true, account, needCode: false, savedPassword: Boolean(account.hasPassword) });
        }
        return send(req, res, 200, { ok: false, needCode: Boolean(out.needCode), mfaSessionId: out.mfaSessionId || '', message: out.message });
      }
      if (req.method === 'POST' && sub === '/login/mfa/send') {
        const { mfaSessionId } = await readBody(req);
        return send(req, res, 200, await sendMfaCode(mfaSessionId));
      }
      if (req.method === 'POST' && sub === '/login/mfa/verify') {
        const { mfaSessionId, code, label, email, password, savePassword } = await readBody(req);
        const out = await loginWithMfaCode(mfaSessionId, code);
        if (!out.ok) return send(req, res, 200, out);
        // 批量登录时密码不存在前端，这里从内存里取（见 pendingCredentials）
        const pending = pendingCredentials.get(String(mfaSessionId || '')) || {};
        pendingCredentials.delete(String(mfaSessionId || ''));
        const effEmail = email || pending.email || out.user?.email || '';
        const effPassword = password || pending.password || '';
        const account = accounts.addAccount({
          token: out.token,
          label: label || out.user?.email || '邮箱账号',
          email: out.user?.email || effEmail,
          userId: out.user?.id || '',
          password: savePassword === false ? '' : effPassword,
          loginEmail: effEmail,
        });
        return send(req, res, 200, { ok: true, account, savedPassword: Boolean(account.hasPassword) });
      }
      if (req.method === 'POST' && sub === '/login/password/batch') {
        // 批量登录：每行 邮箱----密码（或 备注----邮箱----密码）。只用于批量导入你自己拥有的账号。
        const { text, savePassword } = await readBody(req);
        const lines = String(text || '')
          .split(/\r?\n/)
          .map((l) => l.trim())
          .filter((l) => l && !l.startsWith('#'));
        const results = [];
        for (let i = 0; i < Math.min(lines.length, 20); i++) {
          const parts = lines[i].split(/\s*(?:----|\|)\s*/).filter(Boolean);
          let label = '';
          let email = '';
          let password = '';
          if (parts.length >= 3) {
            [label, email, password] = parts;
          } else if (parts.length === 2) {
            if (parts[0].includes('@')) { email = parts[0]; password = parts[1]; }
            else { label = parts[0]; email = parts[1]; }
          }
          if (!email.includes('@') || !password) {
            results.push({ line: i + 1, ok: false, message: '格式应为 邮箱----密码' });
            continue;
          }
          try {
            const out = await loginWithPassword(email, password);
            if (out.ok) {
              const account = accounts.addAccount({
                token: out.token,
                label: label || email.split('@')[0],
                email: email || out.user?.email || '',
                userId: out.user?.id || '',
                password: savePassword === false ? '' : password,
                loginEmail: email,
              });
              results.push({ line: i + 1, ok: true, label: account.label, id: account.id, savedPassword: Boolean(account.hasPassword) });
            } else if (out.needCode && out.mfaSessionId) {
              // 需要邮箱验证码：顺手发一次码，把会话号带回前端排队，用户逐个填码即可
              if (savePassword !== false) pendingCredentials.set(String(out.mfaSessionId), { email, password });
              const sent = await sendMfaCode(out.mfaSessionId);
              results.push({
                line: i + 1,
                ok: false,
                needCode: true,
                email,
                label: label || email.split('@')[0],
                mfaSessionId: out.mfaSessionId,
                sent: Boolean(sent.ok),
                message: sent.ok ? '验证码已发送' : '需要验证码，但自动发码失败：' + sent.message,
              });
            } else {
              results.push({ line: i + 1, ok: false, message: out.message || '登录失败' });
            }
          } catch (error) {
            results.push({ line: i + 1, ok: false, message: String(error.message || error) });
          }
          await new Promise((r) => setTimeout(r, 800));
        }
        const added = results.filter((r) => r.ok).length;
        return send(req, res, 200, { ok: true, total: lines.length, added, failed: results.length - added, results });
      }
      if (req.method === 'POST' && sub === '/login/email') {
        const { email, label } = await readBody(req);
        return send(req, res, 200, await sendEmailCode(email, label));
      }
      if (req.method === 'POST' && sub === '/login/verify') {
        const { email, code, label, deviceId } = await readBody(req);
        return send(req, res, 200, await loginWithEmailCode(email, code, { label, deviceId }));
      }
      if (req.method === 'POST' && sub === '/login/token/batch') {
        // 批量导入「你已经拥有的账号 token」：每行一个，支持 备注----token----cookie（分隔符也可以是 |）
        const { text } = await readBody(req);
        const lines = String(text || '')
          .split(/\r?\n/)
          .map((l) => l.trim())
          .filter((l) => l && !l.startsWith('#'));
        const results = [];
        for (let i = 0; i < Math.min(lines.length, 50); i++) {
          const parts = lines[i].split(/\s*(?:----|\|)\s*/).filter(Boolean);
          let label = '';
          let token = '';
          let cookie = '';
          if (parts.length >= 3) {
            [label, token, cookie] = parts;
          } else if (parts.length === 2) {
            if (parts[0].length > 40) { token = parts[0]; cookie = parts[1]; }
            else { label = parts[0]; token = parts[1]; }
          } else {
            token = parts[0] || '';
          }
          cookie = String(cookie || '').replace(/^cookie:\s*/i, '').trim();
          try {
            const check = await checkToken(token);
            if (!check.ok) {
              results.push({ line: i + 1, ok: false, message: check.message || 'token 无效' });
            } else {
              // 登录页把用户填的完整邮箱一起回传了（站点接口只给脱敏地址），优先存完整的
        const fullEmail = typeof email === 'string' && email.includes('@') && !email.includes('*') ? email.trim() : '';
        const account = accounts.addAccount({
          token,
          label,
          cookie,
          email: fullEmail || check.user?.email || '',
          userId: check.user?.id || '',
        });
              results.push({ line: i + 1, ok: true, label: account.label, email: account.email, id: account.id });
            }
          } catch (error) {
            results.push({ line: i + 1, ok: false, message: String(error.message || error) });
          }
          await new Promise((r) => setTimeout(r, 300));
        }
        const added = results.filter((r) => r.ok).length;
        return send(req, res, 200, { ok: true, total: lines.length, added, failed: results.length - added, results });
      }
      if (req.method === 'POST' && sub === '/login/token') {
        const body = await readBody(req);
        const { token, label, sid, cookieText, diag, source, email, fingerprint } = body;
        // 登录页抄回来的真实浏览器指纹头（x-hif-* / x-client-*）：存起来，引擎发请求时原样带上
        let fp = {};
        if (fingerprint && typeof fingerprint === 'object') {
          for (const [k, v] of Object.entries(fingerprint)) {
            const key = String(k).toLowerCase();
            if (!/^x-(hif|client|ds)-|^user-agent$/.test(key)) continue;
            if (typeof v !== 'string' || !v || v.length > 400) continue;
            fp[key] = v;
          }
        }
        // 登录页把用户刚敲的密码一起回传了：登录成功就把邮箱+密码加密存到本机，
        // 下次「内嵌登录」能自动填表，token 失效也能自动重登（可在运行设置里关掉）。
        const typedPassword = typeof body.password === 'string' && body.password.length >= 6 && body.password.length <= 200 ? body.password : '';
        const saveCredential = loadConfig().saveLoginCredential !== false && Boolean(typedPassword);
        if (diag && !token) {
          // 页面抓不到 token 时的诊断信息：记下来，方便下次排查（不含敏感值，只有 key 名）
          try {
            fs.writeFileSync(path.join(STATE_DIR, 'login-diag.json'), JSON.stringify({ at: new Date().toISOString(), diag }, null, 2));
          } catch {}
          log('登录页诊断：' + JSON.stringify(diag).slice(0, 1500));
          return send(req, res, 200, { ok: true, diag: true });
        }
        const check = await checkToken(token);
        if (!check.ok) return send(req, res, 400, { ok: false, message: check.message });
        let cookie = '';
        if (sid) {
          try {
            const jar = JSON.parse(fs.readFileSync(path.join(STATE_DIR, 'jar-' + String(sid).replace(/[^a-zA-Z0-9_-]/g, '') + '.json'), 'utf8'));
            cookie = Object.entries(jar).map(([k, v]) => k + '=' + v).join('; ');
          } catch {}
        }
        if (!cookie && cookieText) cookie = String(cookieText).trim().replace(/^cookie:\s*/i, '');
        // 登录页把用户填的完整邮箱一起回传了（站点接口只给脱敏地址），优先存完整的
        const fullEmail = typeof email === 'string' && email.includes('@') && !email.includes('*') ? email.trim() : '';
        // 带 accountId 的是「浏览器登录」补登：原地换 token，不新增账号（否则账号列表会越登越乱）
        const targetId = typeof body.accountId === 'string' ? body.accountId.trim() : '';
        if (targetId) {
          const existing = accounts.listAccounts().find((a) => a.id === targetId);
          if (existing) {
            if (cookie) accounts.updateAccount(targetId, { cookie });
            let account = accounts.replaceToken(targetId, token, check.user || {});
            if (saveCredential) {
              const savedEmail = fullEmail || (check.user?.email && !String(check.user.email).includes('*') ? check.user.email : '');
              account = accounts.setCredential(targetId, { email: savedEmail || '', password: typedPassword }) || account;
            }
            accounts.updateAccount(targetId, {
              loginSource: String(source || '登录页'),
              loginAt: Date.now(),
              ...(Object.keys(fp).length ? { fingerprint: { ...(accounts.getFingerprint(targetId) || {}), ...fp }, fingerprintAt: Date.now() } : {}),
            });
            const sidNow = String(req.headers['x-dsweb-sid'] || '').trim() || String(sid || '').trim();
            if (sidNow) accounts.noteLoginSid(targetId, sidNow);
            syncMuteFromUser(targetId, check.user);
            log('浏览器登录回填 token：' + targetId + ' ' + (account?.email || '') + (saveCredential ? '（已加密保存账号密码）' : ''));
            return send(req, res, 200, { ok: true, account, user: check.user, source: String(source || ''), relogged: true, credentialSaved: saveCredential });
          }
        }
        const account = accounts.addAccount({
          token,
          label,
          cookie,
          email: fullEmail || check.user?.email || '',
          userId: check.user?.id || '',
          password: saveCredential ? typedPassword : '',
          loginEmail: saveCredential ? fullEmail : '',
        });
        accounts.updateAccount(account.id, {
          loginSource: String(source || '登录页'),
          loginAt: Date.now(),
          ...(Object.keys(fp).length ? { fingerprint: fp, fingerprintAt: Date.now() } : {}),
        });
        const sidNow2 = String(req.headers['x-dsweb-sid'] || '').trim() || String(sid || '').trim();
        if (sidNow2) accounts.noteLoginSid(account.id, sidNow2);
        syncMuteFromUser(account.id, check.user);
        log('登录页回传 token（来源 ' + String(source || '未知') + '）：' + account.id + ' ' + account.label + (saveCredential ? '（已加密保存账号密码）' : ''));
        return send(req, res, 200, { ok: true, account, user: check.user, source: String(source || ''), cookie: cookie ? 'saved' : 'none', credentialSaved: saveCredential });
      }
      if (req.method === 'POST' && sub === '/accounts/check-all') {
        const out = await tokenSweep('手动');
        const msg =
          '体检完成：检查 ' + out.checked + ' 个账号，失效 ' + out.invalid + ' 个' +
          (out.recovered ? '，恢复被误标的 ' + out.recovered + ' 个' : '') +
          (out.relogged ? '，自动重登成功 ' + out.relogged + ' 个' : '') +
          (out.skipped ? '，' + out.skipped + ' 个这次没验出来（未改动）' : '');
        return send(req, res, 200, { ok: out.invalid === 0, ...out, message: msg });
      }
      // ---- 账号管理：重复检测 / 合并 / 批量 / 排序 / 单账号导出 ----
      if (req.method === 'GET' && sub === '/accounts/duplicates') {
        return send(req, res, 200, { ok: true, ...accounts.duplicates() });
      }
      if (req.method === 'POST' && sub === '/accounts/duplicates/merge') {
        const activeBefore = loadConfig().activeAccountId || '';
        const out = accounts.mergeDuplicates();
        if (out.removed) {
          // 被合并掉的账号如果正是「当前账号」，把当前账号改成保留者，别留一个指向幽灵账号的指针
          const owner = (out.groups || []).find((g) => (g.removed || []).includes(activeBefore));
          if (owner && owner.kept) saveConfig({ activeAccountId: owner.kept });
          log('合并重复账号：删除 ' + out.removed + ' 个，剩余 ' + out.total);
        }
        return send(req, res, 200, {
          ok: true,
          ...out,
          message: out.removed ? '已合并 ' + out.removed + ' 个重复账号，账号库现有 ' + out.total + ' 个' : '没有发现重复账号',
        });
      }
      if (req.method === 'POST' && sub === '/accounts/bulk') {
        const body = await readBody(req).catch(() => ({}));
        const action = String((body && body.action) || '');
        const activeBefore = loadConfig().activeAccountId || '';
        const out = accounts.bulkAccounts({ ids: body?.ids, action, groupId: body?.groupId });
        if (out.ok && action === 'delete' && out.affected.includes(activeBefore)) {
          saveConfig({ activeAccountId: '' });
        }
        if (out.ok) log('批量' + action + '：' + out.affected.length + ' 个账号');
        return send(req, res, 200, {
          ...out,
          message: out.ok
            ? { enable: '已启用 ', disable: '已禁用 ', delete: '已删除 ', group: '已移动 ' }[action] + out.affected.length + ' 个账号'
            : out.message,
        });
      }
      if (req.method === 'POST' && sub === '/accounts/reorder') {
        const body = await readBody(req).catch(() => ({}));
        return send(req, res, 200, { ok: true, ...accounts.reorderAccounts(body?.ids) });
      }
      // ---- 登录会话：列出本机登录过的会话，支持「恢复上次登录」----
      if (req.method === 'GET' && sub === '/login/sessions') {
        const pm = await loadSessionApi();
        const sessions = pm ? pm.listLoginSessions() : [];
        return send(req, res, 200, { ok: true, sessions, total: sessions.length });
      }
      if (req.method === 'POST' && sub === '/login/restore') {
        const body = await readBody(req).catch(() => ({}));
        const sid = String((body && body.sid) || '').replace(/[^a-zA-Z0-9_-]/g, '');
        const pm2 = await loadSessionApi();
        const known = pm2 ? pm2.listLoginSessions().some((s) => s.sid === sid) : false;
        if (!sid || !known) return send(req, res, 200, { ok: false, message: '这个登录会话已经不在了，重新登一次即可' });
        const base = (await ensureLoginProxy()).replace(/\/$/, '');
        let url = base + '/sign_in?__dsweb_sid=' + encodeURIComponent(sid);
        const accountId = String((body && body.accountId) || '').trim();
        if (accountId) url += '&__dsweb_acct=' + encodeURIComponent(accountId);
        const opened = await openOnDevice(url);
        log('恢复登录会话：' + sid.slice(0, 8) + '…' + (accountId ? ' → ' + accountId : ''));
        return send(req, res, 200, {
          ok: true,
          url,
          opened,
          message: opened
            ? '已用上次的登录会话打开登录页：如果站点还没掉登录，页面会把 token 直接回填，不用输密码'
            : '登录页已生成（系统浏览器没打开，点下面的链接或复制到浏览器）',
        });
      }
      if (req.method === 'POST' && sub === '/login/sessions/forget') {
        const body = await readBody(req).catch(() => ({}));
        const pm3 = await loadSessionApi();
        const removed = pm3 ? pm3.forgetLoginSession(String((body && body.sid) || '')) : false;
        log('清理登录会话：' + (removed ? '已删除' : '不存在'));
        return send(req, res, 200, { ok: removed, message: removed ? '登录会话已清理' : '这个会话已经不在了' });
      }
      const idMatch = /^\/accounts\/([^/]+)(?:\/(enable|disable|check|relogin|credential|reveal|browser-login|active|rename|group|move|export))?$/.exec(sub);
      if (idMatch) {
        const [, rawId, action] = idMatch;
        const id = decodeURIComponent(rawId);
        if (req.method === 'DELETE' && !action) {
          const activeBefore = loadConfig().activeAccountId || '';
          const removed = accounts.removeAccount(id);
          if (removed && activeBefore === id) {
            // 删掉的正是当前账号：清掉指针，下一轮自动挑一个可用账号
            saveConfig({ activeAccountId: '' });
          }
          if (removed) log('删除账号：' + id);
          return send(req, res, 200, { ok: removed, activeCleared: removed && activeBefore === id });
        }
        if (req.method === 'POST' && action === 'move') {
          const body = await readBody(req).catch(() => ({}));
          const dir = String((body && body.dir) || 'up') === 'down' ? 'down' : 'up';
          const out = accounts.moveAccount(id, dir);
          return send(req, res, out.ok ? 200 : 404, { ...out, accounts: accounts.listAccounts() });
        }
        if (req.method === 'GET' && action === 'export') {
          const single = accounts.exportAccount(id);
          if (!single) return send(req, res, 404, { ok: false, message: '账号不存在' });
          return send(req, res, 200, { ok: true, ...single, message: '已导出 1 个账号（含 token/cookie，等于可登录凭证，别外传）' });
        }
        if (req.method === 'POST' && action === 'active') {
          const target = accounts.listAccounts().find((a) => a.id === id);
          if (!target) return send(req, res, 200, { ok: false, message: '账号不存在' });
          const cfg2 = saveConfig({ activeAccountId: id });
          log('当前账号切换为：' + id + ' ' + (target.email || target.label));
          return send(req, res, 200, { ok: true, activeAccountId: cfg2.activeAccountId, message: '已设为当前账号，下一轮请求就用它' });
        }
        if (req.method === 'POST' && action === 'rename') {
          const { label } = await readBody(req);
          const renamed = accounts.renameAccount(id, label);
          if (!renamed) return send(req, res, 200, { ok: false, message: '账号不存在' });
          return send(req, res, 200, { ok: true, account: renamed, message: '备注已更新' });
        }
        if (req.method === 'POST' && action === 'group') {
          const body2 = await readBody(req);
          const groupId = typeof body2.groupId === 'string' ? body2.groupId : '';
          const saved = accounts.setGroup(id, groupId);
          if (!saved) return send(req, res, 200, { ok: false, message: '账号不存在' });
          return send(req, res, 200, { ok: true, account: saved, message: groupId ? '已归入分组' : '已移出分组（回到「未分组」）' });
        }
        if (req.method === 'POST' && action === 'credential') {
          // 给已有账号补存完整邮箱 / 邮箱+密码：存完立刻试着用它换一次 token，验证密码对不对
          const { email, password } = await readBody(req);
          const fullEmail = String(email || '').trim();
          if (fullEmail && accounts.isMaskedEmail(fullEmail)) {
            return send(req, res, 200, { ok: false, message: '邮箱不能是带 * 的脱敏地址，请填完整邮箱（如 name@qq.com）' });
          }
          if (!password && !fullEmail) return send(req, res, 200, { ok: false, message: '请填完整邮箱或密码' });
          if (!password) {
            const saved = accounts.setCredential(id, { email: fullEmail });
            return send(req, res, 200, { ok: Boolean(saved), saved: true, account: saved, message: '已保存完整邮箱，账号列表会显示这个地址' });
          }
          if (String(password).length < 6) return send(req, res, 200, { ok: false, message: '密码至少 6 位' });
          const saved = accounts.setCredential(id, { email: fullEmail, password });
          if (!saved) return send(req, res, 200, { ok: false, message: '账号不存在' });
          const r = await reloginAccount(id, { reason: 'manual' });
          if (r.ok) return send(req, res, 200, { ok: true, account: r.account, verified: true, message: '密码已验证并保存，token 失效时会自动重新登录' });
          return send(req, res, 200, {
            ok: false,
            account: saved,
            saved: true,
            needCode: Boolean(r.needCode),
            needBrowserLogin: Boolean(r.needBrowserLogin),
            message: r.needCode
              ? '密码已保存；这台设备还需要邮箱验证码，请点「重新登录」手动完成一次，之后就会自动重登'
              : r.needBrowserLogin
                ? '密码已保存。但这台设备的脚本登录被站点风控拦住了，点「浏览器登录」在真实网页里登录一次即可（账号密码会自动填好）'
                : '密码已保存，但登录验证没通过：' + (r.message || '未知原因'),
          });
        }
        if (req.method === 'DELETE' && action === 'credential') {
          const account = accounts.clearCredential(id);
          return send(req, res, 200, { ok: Boolean(account), account, message: '已删除保存的密码，之后不会再自动重登' });
        }
        if (req.method === 'POST' && action === 'reveal') {
          // 站点风控挡插件内登录时，让用户把保存的账号密码复制走，去真实浏览器里手动登录
          const target = accounts.listAccounts().find((a) => a.id === id);
          if (!target) return send(req, res, 200, { ok: false, message: '账号不存在' });
          const cred = accounts.getCredential(id);
          if (!cred) return send(req, res, 200, { ok: false, message: '这个账号没有保存密码，先点「存密码」' });
          log('导出保存的账号密码（去浏览器手动登录）：' + id);
          return send(req, res, 200, {
            ok: true,
            email: cred.email || target.email || '',
            emailMasked: !cred.email || String(cred.email).includes('*'),
            password: cred.password,
          });
        }
        if (req.method === 'POST' && action === 'browser-login') {
          // 设备风控把 HTTP 密码登录挡住了：把保存的账号密码做成一次性票据，
          // 在真实网页里自动填表登录（站点自己的 JS 完成风控，能过），token 回来原地替换。
          const list = accounts.listAccounts();
          const target = list.find((a) => a.id === id);
          if (!target) return send(req, res, 200, { ok: false, message: '账号不存在' });
          const cred = accounts.getCredential(id);
          if (!cred || !cred.password) {
            return send(req, res, 200, { ok: false, needCredential: true, message: '这个账号没有保存密码，请先点「存密码」' });
          }
          if (!cred.email || cred.email.includes('*')) {
            return send(req, res, 200, { ok: false, needCredential: true, message: '保存的邮箱是脱敏地址，请点「改密码」填一次完整邮箱和密码' });
          }
          const base = await ensureLoginProxy();
          const ticket = issueTicket({ accountId: id, email: cred.email, password: cred.password, reason: 'relogin' });
          const url = base.replace(/\/$/, '') + '/sign_in?__dsweb_auto=' + ticket;
          log('打开浏览器自动登录：' + id + ' ' + cred.email);
          return send(req, res, 200, { ok: true, url, opened: false, message: '登录页已打开，账号密码会自动填好；需要邮箱验证码时在这一页输入即可' });
        }
        if (req.method === 'POST' && action === 'relogin') {
          const r = await reloginAccount(id, { reason: 'manual' });
          if (r.ok) return send(req, res, 200, { ok: true, account: r.account, message: r.message });
          return send(req, res, 200, {
            ok: false,
            needCode: Boolean(r.needCode),
            needBrowserLogin: Boolean(r.needBrowserLogin),
            noCredential: Boolean(r.noCredential),
            message: r.noCredential ? '这个账号没有保存密码，请先在账号行点「存密码」' : r.message,
          });
        }
        if (req.method === 'POST' && action === 'enable') {
          return send(req, res, 200, { ok: true, account: accounts.updateAccount(id, { disabled: false, status: 'ok' }) });
        }
        if (req.method === 'POST' && action === 'disable') {
          return send(req, res, 200, { ok: true, account: accounts.updateAccount(id, { disabled: true }) });
        }
        if (req.method === 'POST' && action === 'check') {
          const token = accounts.getToken(id);
          const check = await checkToken(token);
          if (check.ok) {
            accounts.clearStatus(id);
            // 顺手把账号名（邮箱）补上：老账号只有「浏览器登录」这种名字，失效后根本分不清是谁
            if (check.user?.email) accounts.noteEmail(id, { email: check.user.email, userId: check.user.id || '' });
            const mute = syncMuteFromUser(id, check.user);
            if (mute.muted) {
              return send(req, res, 200, {
                ok: false,
                muted: true,
                muteUntil: mute.muteUntil,
                user: check.user,
                message: '账号被站点禁言至 ' + new Date(mute.muteUntil).toLocaleString('zh-CN') + '，到期前不会用它发消息',
              });
            }
            return send(req, res, 200, { ok: true, user: check.user });
          }
          if (!check.invalid) {
            // 网络抖动 / 风控页 / 限流：没验出来而已，别把账号标成失效，也别去撞自动重登（会触发风控）
            return send(req, res, 200, { ok: false, message: '这次没验出来（' + (check.message || '未知原因') + '），没有改动账号状态，稍后再试' });
          }
          accounts.markAuthExpired(id);
          // 失效了就先试一次自动重登（保存过密码的话），省得用户手点
          const r = await reloginAccount(id, { reason: 'check' });
          if (r.ok) {
            return send(req, res, 200, { ok: true, relogged: true, account: r.account, message: r.message });
          }
          return send(req, res, 200, {
            ok: false,
            needCode: Boolean(r.needCode),
            needBrowserLogin: Boolean(r.needBrowserLogin),
            message: check.message,
            reloginMessage: r.message,
          });
        }
      }
      return send(req, res, 404, { error: 'unknown route' });
    } catch (error) {
      return send(req, res, 500, { error: String(error.message || error) });
    }
  } };

  ctx.effect(() => ctx.webServer.register(route), 'deepseek-web: 设置路由');

  // 选中模型/发起调用时顺手预热（失败无所谓，门会兜底）
  ctx.effect(
    () =>
      ctx.on('llm/stream', (options, next) => {
        try {
          const provider = options?.provider;
          if (typeof provider === 'string' && provider.includes('deepseek-web')) {
            lastUsed = Date.now();
            startEngine().catch(() => {});
          }
        } catch {}
        return next();
      }),
    'deepseek-web: llm/stream 预热',
  );

  ctx.effect(() => () => {
    clearInterval(sweeper);
    clearInterval(reloginTimer);
    stopEngine('插件卸载');
    try {
      gate.close();
    } catch {}
    try {
      loginProxy?.close();
    } catch {}
  }, 'deepseek-web: 清理');
}

function tailLog(file, lines) {
  try {
    const text = fs.readFileSync(file, 'utf8');
    return text.split('\n').slice(-lines).join('\n');
  } catch {
    return '';
  }
}
