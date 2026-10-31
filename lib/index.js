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
import { loadConfig, saveConfig, resetConfig, STATE_DIR, ensureStateDir } from '../server/config.mjs';
import * as accounts from '../server/accounts.mjs';
import { sendEmailCode, loginWithEmailCode, checkToken, loginWithPassword, sendMfaCode, loginWithMfaCode } from '../server/login.mjs';
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
  // 让手机端系统浏览器直接打开登录页（WebView 常拦截 window.open，这条路更稳）
  const openOnDevice = (url) => {
    try {
      const raw = fs.readFileSync('/root/.dsh/.bridge_headers', 'utf8').trim().split('\n');
      const headers = {};
      for (const line of raw) {
        const i = line.indexOf(':');
        if (i > 0) headers[line.slice(0, i).trim()] = line.slice(i + 1).trim();
      }
      const req = http.get(
        { host: '127.0.0.1', port: 3090, path: '/app/open?url=' + encodeURIComponent(url), headers, timeout: 6000 },
        (r) => r.resume(),
      );
      req.on('error', () => {});
      req.on('timeout', () => req.destroy());
    } catch {}
  };

  const ensureLoginProxy = async () => {
    // 每次点「在插件里登录」都重新加载代理模块，改代理代码不用重启 DSH
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
    log('登录代理已启动 127.0.0.1:' + LOGIN_PORT);
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
          DS_SEND_GAP_MS: String(cfg.sendGapMs),
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
            accounts.updateAccount(a.id, { email: check.user.email, userId: check.user.id || '' });
            log('补账号名：' + a.id + ' → ' + check.user.email);
          }
        } catch {}
        await new Promise((r) => setTimeout(r, 800));
      }
    } catch {}
  };
  setTimeout(backfillEmails, 4000).unref?.();

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
        return send(req, res, 200, {
          engine: alive ? 'running' : child || starting ? 'starting' : 'idle',
          port: GATE_PORT,
          enginePort: ENGINE_PORT,
          config: cfg,
          version: PLUGIN_VERSION,
          accounts: accounts.listAccounts(),
          usage,
          logTail: tailLog(logFile, 40),
        });
      }
      if (req.method === 'POST' && sub === '/config') {
        const patch = await readBody(req);
        return send(req, res, 200, { ok: true, config: saveConfig(patch) });
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
        const url = await ensureLoginProxy();
        openOnDevice(url);
        return send(req, res, 200, { ok: true, url, opened: true });
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

          const profile = process.env.DSHA_STARTUP_PROFILE || 'web';
          const dshHome = path.dirname(path.dirname(STATE_DIR)); // <DSH_HOME>/storages/<id> → <DSH_HOME>
          const pkgDir = path.join(dshHome, 'profiles', profile, 'node_modules', 'dsh-deepseek-web');
          let st = null;
          try { st = fs.lstatSync(pkgDir); } catch {}
          if (!st) return send(req, res, 200, { ok: false, message: '找不到插件安装目录：' + pkgDir + '，请手动安装：' + file });
          if (st.isSymbolicLink()) {
            return send(req, res, 200, { ok: false, message: '当前是 link 安装（开发模式），一键安装会破坏链接。安装包已下好：' + file });
          }

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
        // 邮箱 + 密码登录（不走浏览器；海外账号需要海外网络）
        const { email, password, label } = await readBody(req);
        const out = await loginWithPassword(email, password);
        if (out.ok) {
          const account = accounts.addAccount({ token: out.token, label: label || String(email).split('@')[0], email: email || out.user?.email || '', userId: out.user?.id || '' });
          return send(req, res, 200, { ok: true, account, needCode: false });
        }
        return send(req, res, 200, { ok: false, needCode: Boolean(out.needCode), mfaSessionId: out.mfaSessionId || '', message: out.message });
      }
      if (req.method === 'POST' && sub === '/login/mfa/send') {
        const { mfaSessionId } = await readBody(req);
        return send(req, res, 200, await sendMfaCode(mfaSessionId));
      }
      if (req.method === 'POST' && sub === '/login/mfa/verify') {
        const { mfaSessionId, code, label } = await readBody(req);
        const out = await loginWithMfaCode(mfaSessionId, code);
        if (!out.ok) return send(req, res, 200, out);
        const account = accounts.addAccount({ token: out.token, label: label || out.user?.email || '邮箱账号', email: out.user?.email || '', userId: out.user?.id || '' });
        return send(req, res, 200, { ok: true, account });
      }
      if (req.method === 'POST' && sub === '/login/password/batch') {
        // 批量登录：每行 邮箱----密码（或 备注----邮箱----密码）。只用于批量导入你自己拥有的账号。
        const { text } = await readBody(req);
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
              const account = accounts.addAccount({ token: out.token, label: label || email.split('@')[0], email: email || out.user?.email || '', userId: out.user?.id || '' });
              results.push({ line: i + 1, ok: true, label: account.label, id: account.id });
            } else if (out.needCode && out.mfaSessionId) {
              // 需要邮箱验证码：顺手发一次码，把会话号带回前端排队，用户逐个填码即可
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
              const account = accounts.addAccount({ token, label, cookie, email: check.user?.email || '', userId: check.user?.id || '' });
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
        const { token, label, sid, cookieText, diag, source } = body;
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
        const account = accounts.addAccount({ token, label, cookie, email: check.user?.email || '', userId: check.user?.id || '' });
        log('登录页回传 token（来源 ' + String(source || '未知') + '）：' + account.id + ' ' + account.label);
        return send(req, res, 200, { ok: true, account, user: check.user, source: String(source || ''), cookie: cookie ? 'saved' : 'none' });
      }
      const idMatch = /^\/accounts\/([^/]+)(?:\/(enable|disable|check))?$/.exec(sub);
      if (idMatch) {
        const [, id, action] = idMatch;
        if (req.method === 'DELETE' && !action) {
          return send(req, res, 200, { ok: accounts.removeAccount(decodeURIComponent(id)) });
        }
        if (req.method === 'POST' && action === 'enable') {
          return send(req, res, 200, { ok: true, account: accounts.updateAccount(decodeURIComponent(id), { disabled: false, status: 'ok' }) });
        }
        if (req.method === 'POST' && action === 'disable') {
          return send(req, res, 200, { ok: true, account: accounts.updateAccount(decodeURIComponent(id), { disabled: true }) });
        }
        if (req.method === 'POST' && action === 'check') {
          const token = accounts.getToken(decodeURIComponent(id));
          const check = await checkToken(token);
          if (check.ok) {
            accounts.clearStatus(decodeURIComponent(id));
            // 顺手把账号名（邮箱）补上：老账号只有「浏览器登录」这种名字，失效后根本分不清是谁
            if (check.user?.email) accounts.updateAccount(decodeURIComponent(id), { email: check.user.email, userId: check.user.id || '' });
          } else {
            accounts.markAuthExpired(decodeURIComponent(id));
          }
          return send(req, res, 200, { ok: check.ok, message: check.message, user: check.user });
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
