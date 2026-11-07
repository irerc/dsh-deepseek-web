// HTTP 引擎：不依赖浏览器，直接用 chat.deepseek.com 的网页接口
import { BASE, UA, post, get, classify, UpstreamError, baseHeaders, humanHeaders, setUpstreamHook } from './http.mjs';
import { solvePowHeader } from './pow.mjs';
import { loadConfig } from './config.mjs';
import { tzOffsetMinutes } from './timezone.mjs';
import { currentMode, modeLimits, gapFor, rateWindowFor, LONG_RUN_THRESHOLD, HUMAN_BREAK_MS, longRestFor, throttleBackoffMs } from './request-mode.mjs';
import { pickAccount, markUsed, markCooldown, setCooldown, markAuthExpired, markMuted, listAccounts, getToken, getCookie, getFingerprint, updateAccount } from './accounts.mjs';
import { humanGapPlan, checkDailyBudget, recordHumanSend } from './human-rhythm.mjs';
import { reloginAccount } from './relogin.mjs';
import { createStreamParser } from './stream-parser.mjs';
import { BrowserTransport, browserAvailability } from './browser-transport.mjs';
import { NativeTransport, nativeAvailability } from './native-transport.mjs';
import { deviceId } from './device.mjs';
import { probeToken } from './token-check.mjs';
import { deviceBrowserAvailability } from './device-browser.mjs';
import { pickWarmupPhrases, warmupNeeded } from './warmup.mjs';

/**
 * 传输层三档：
 *   auto（默认）  优先真实浏览器（TLS/JA4 = 浏览器，PoW 在页面里解）；**起不来才退回 Node**，并在设置页亮红字。
 *   browser       强制浏览器：起不来就明确报错，绝不静默降级（要的就是这个「不许骗我」）。
 *   node          Node 直连（旧实现，高危）。
 * 之所以保留 auto：手机上/受限容器里很多 Chromium 根本起不来（例如 SIGTRAP），
 * 强制 browser 会让插件在那种环境下**完全不能用**——那不是我该替用户做的选择。
 */
export function configuredTransport() {
  const env = String(process.env.DS_NETWORK_TRANSPORT || '').toLowerCase();
  if (['node', 'browser', 'native', 'device', 'auto'].includes(env)) return env;
  try {
    const v = loadConfig().transport;
    return ['node', 'browser', 'native', 'device', 'auto'].includes(v) ? v : 'auto';
  } catch {
    return 'auto';
  }
}

let _resolved = '';
let _lastWarnAt = 0;

/** 同步读：auto 还没判定过时先按 browser（第一次请求会 await resolveTransport 再定） */
export function transportMode() {
  const c = configuredTransport();
  if (c === 'device') return 'browser'; // 真·手机浏览器在实现上就是「浏览器档 + 远端 CDP」
  if (c !== 'auto') return c;
  return _resolved || 'browser';
}

/**
 * 真正决定这次请求走哪条路：
 *   auto = browser（桌面端最真）→ native（浏览器起不来时的通用解：curl_cffi 浏览器级 TLS）→ node（兜底）
 * 三次探测结果都有 5 分钟缓存，不会每条消息都去起一遍。
 */
let _resolvedVia = '';
export function resolvedVia() {
  return _resolvedVia;
}

export async function resolveTransport() {
  const c = configuredTransport();
  if (c === 'device') {
    const dev = await deviceBrowserAvailability();
    if (!dev.ok || dev.needPage) {
      throw new UpstreamError('手机浏览器不可用：' + (dev.needPage ? dev.hint : dev.reason), { kind: 'transport' });
    }
    _resolvedVia = 'device';
    _resolved = 'browser';
    return 'browser';
  }
  if (c !== 'auto') {
    _resolvedVia = '';
    _resolved = c;
    return c;
  }
  // auto：真浏览器优先（本机 Chrome 接管）→ 本地 Chromium → native 伪装
  const dev = await deviceBrowserAvailability();
  if (dev.ok && !dev.needPage) {
    _resolvedVia = 'device';
    _resolved = 'browser';
    return 'browser';
  }
  const browser = await browserAvailability();
  if (browser.ok) {
    _resolved = 'browser';
    return _resolved;
  }
  const native = await nativeAvailability();
  _resolved = native.ok ? 'native' : 'node';
  if (Date.now() - _lastWarnAt > 60000) {
    _lastWarnAt = Date.now();
    console.warn(
      '[transport] auto 选路：浏览器不可用（' + (browser.reason || '未知') + '）→ ' +
        (_resolved === 'native' ? 'native 本地伪装（curl_cffi，JA4 = Chrome）' : '回退 Node 直连（TLS 指纹可被识破，风险更高）') +
        (native.ok ? '' : '（native 也不可用：' + (native.reason || '') + '）'),
    );
  }
  return _resolved;
}

// 距上一次请求超过这么久 = 人离开了会儿，回来接着说第一句不需要再等「输出间隔」。
// 以前不管隔了多久都照 30s+ 的间隔摆着等，代价是「重启后第一条消息特别慢」——真人没这个行为。
const FIRST_MSG_FREE_MS = 90_000;

const lastSentAt = new Map(); // accountId -> 上一次请求「开始」时间
const lastDoneAt = new Map(); // accountId -> 上一次请求「结束」时间（间隔要按结束算，长回答之后不必白等，但必须等满）

function safeJson(text) {
  try { return JSON.parse(String(text)); } catch { return null; }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** 把 JSON 字符串里的 \\uXXXX 还原成中文（站点有时会转义） */
function decodeJsonEscapes(text) {
  return String(text || '').replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
}

/** 站点中文文案里的到期时间：「禁言至 2027 年 11 月 2 日 09:15」 */
function untilFromChineseDate(text) {
  const m = /(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日\s*(\d{1,2})\s*[:：]\s*(\d{1,2})/.exec(text);
  if (!m) return 0;
  // 站点文案里的时间是北京时间（UTC+8），不能按本机时区解释：
  // 容器里 TZ=UTC 时直接 new Date(y,m,d,...) 会把「09:15」当成 09:15Z，比真实到期晚 8 小时。
  const t = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), 0, 0) - 8 * 3600 * 1000;
  return Number.isFinite(t) ? t : 0;
}

/**
 * 从上游返回块里认出「禁言 / 封号」：50006 MUTED、40012 USER_IS_BANNED（站点错误码）。
 * 同时把站点**原文**和中文日期里的到期时间捞出来 —— 只显示「账号被禁言」：
 * 用户既不知道封了多久、也不知道为什么，只会反复重试把账号越推越深。
 */
export function muteErrorFrom(text) {
  const raw = String(text || '');
  if (!/"code"\s*:\s*50006|"biz_code"\s*:\s*50006/.test(raw) && !/"code"\s*:\s*40012|"biz_code"\s*:\s*40012/.test(raw)) return null;
  const banned = /"code"\s*:\s*40012|"biz_code"\s*:\s*40012/.test(raw);
  const decoded = decodeJsonEscapes(raw);
  const m = /"end_at"\s*:\s*(\d{9,13})/.exec(raw) || /"mute_until"\s*:\s*(\d{9,13})/.exec(raw);
  let untilMs = 0;
  if (m) {
    const n = Number(m[1]);
    untilMs = n > 1e12 ? n : n * 1000;
  }
  if (!untilMs) untilMs = untilFromChineseDate(decoded);
  // 站点原文：优先取 JSON 里的 msg/message 字段，取不到就找含「禁言/封禁/停用/违反」的那句中文
  let message = '';
  const field = /"(?:msg|message|error_msg)"\s*:\s*"([^"]{4,300})"/.exec(decoded);
  if (field) message = field[1];
  if (!message) {
    const sent = /[^\n{}"]{0,60}(?:违反[^\n{}"]{0,40}禁言|已被禁言|已被封禁|账号已被停用)[^\n{}"]{0,120}/.exec(decoded);
    if (sent) message = sent[0];
  }
  message = message.replace(/\\n/g, ' ').trim().slice(0, 200);
  return { banned, untilMs, message };
}

/** 从 SSE 块里认出「被限流」：业务码 40029 或站点那句「操作过于频繁」 */
export function rateLimitErrorFrom(text) {
  const t = String(text || '');
  if (/"code"\s*:\s*(?:40029|429)\b|"biz_code"\s*:\s*(?:40029|429)\b/.test(t)) return true;
  // 只认「错误信封」里的文案：模型正文里出现「操作频繁」这种词也很正常，不能当成限流
  if (!/"code"\s*:\s*[1-9]/.test(t)) return false;
  return /过于频繁|太频繁|操作频繁|too\s+many\s+requests|rate\s*limit|稍后重试/i.test(t);
}

/**
 * 限流计数：连续被限流就退避更久（40s → 80s → 90s 封顶 + 抖动），
 * 5 分钟内没再被限流就清零。参考 dsh-deepseek-web-login 的 throttleStreak。
 */
let throttleStreak = 0;
let lastThrottleAt = 0;
export function noteThrottled(now = Date.now()) {
  if (now - lastThrottleAt > 5 * 60 * 1000) throttleStreak = 0;
  throttleStreak += 1;
  lastThrottleAt = now;
  return throttleBackoffMs(throttleStreak);
}

export class DeepSeekHttp {
  constructor(log = () => {}) {
    this.log = log;
    // 所有 chat.deepseek.com 出站（对话 / 体检 / 登录 / PoW / 建会话）都走同一传输档：
    // 真实浏览器只有一个 TLS 栈，混用 Node 的 h1.1 是「反代」最直接的证据。
    setUpstreamHook((o) => this.upstreamJson(o));
    this.busy = Promise.resolve();
    this._depth = 0;
    this._active = 0;
    this._accActive = new Map();
    this.closed = false;
    this.lastError = null;
    // 滚动窗口 + 连续请求计数：别让同一出口 IP 短时间高频打同一站点
    this._recentStarts = [];
    this._consecutive = 0;
    this._lastDoneAt = 0;
    this.browser = new BrowserTransport(log);
    this.native = new NativeTransport(log);
  }

  get pending() {
    return this._active;
  }

  /** 串行化（只用于账号状态、会话列表这类轻量管理操作） */
  exclusive(fn) {
    this._depth += 1;
    const wrapped = () => fn().finally(() => {
      this._depth = Math.max(0, this._depth - 1);
    });
    const run = this.busy.then(wrapped, wrapped);
    this.busy = run.catch(() => {});
    return run;
  }

  /**
   * 真正跑一次上游对话：全局并发上限 maxConcurrency，同一账号仍然串行。
   * 不同对话（不同 web 会话）可以并行，不再像以前那样全局只允许一个请求，
   * 否则同时开两个对话时第二个会被卡住。
   */
  async _runChat(accountId, fn) {
    const cfg = loadConfig();
    const lim = modeLimits(currentMode());
    const totalLimit = Math.max(1, Number(cfg.maxConcurrency) || 4);
    // 保险模式：同账号严格串行（并发 1），避免短时间内多次打同一账号
    const perAccount = Math.max(1, lim.perAccountConcurrency || Number(cfg.perAccountConcurrency) || 1);
    for (;;) {
      const cur = this._accActive.get(accountId) || 0;
      if (cur < perAccount && this._active < totalLimit) {
        this._accActive.set(accountId, cur + 1);
        this._active += 1;
        break;
      }
      await sleep(50);
    }
    try {
      return await fn();
    } finally {
      this._accActive.set(accountId, Math.max(0, (this._accActive.get(accountId) || 1) - 1));
      this._active = Math.max(0, this._active - 1);
    }
  }

  async close() {
    this.closed = true;
    try { this.browser.close(); } catch {}
    try { this.native.close(); } catch {}
  }

  /** 传输层自检：能不能用（设置页会显示结果，不静默降级） */
  async transportStatus() {
    const configured = configuredTransport();
    const device = await deviceBrowserAvailability();
    const browser = await browserAvailability();
    const native = await nativeAvailability({ autoInstall: false });
    let mode = configured;
    if (configured === 'auto') mode = device.ok && !device.needPage ? 'browser' : browser.ok ? 'browser' : native.ok ? 'native' : 'node';
    if (configured === 'device') mode = device.ok && !device.needPage ? 'browser' : 'device';
    return {
      configured,
      mode,
      ok: mode === 'node' ? true : mode === 'native' ? native.ok : browser.ok,
      browser: browser.path || '',
      version: browser.version || '',
      reason: mode === 'browser' ? browser.reason || '' : mode === 'native' ? '' : configured === 'auto' ? browser.reason || '' : '',
      native: { ok: native.ok, python: native.python || '', version: native.version || '', reason: native.reason || '' },
      device: {
        ok: Boolean(device.ok && !device.needPage),
        via: device.via || '',
        port: device.port || 0,
        browser: device.browser || '',
        reason: device.reason || device.hint || '',
        selinux: device.selinux || '',
      },
      deviceActive: resolvedVia() === 'device',
      fallback: configured === 'auto' && mode !== 'browser',
      note:
        mode === 'browser'
          ? '浏览器传输（请求与 PoW 都在真实页面里）'
          : mode === 'native'
            ? '本地伪装传输（curl_cffi，TLS/JA4 = Chrome，HTTP/2 同浏览器）'
            : configured === 'auto'
              ? 'Node 直连（auto 兜底：浏览器与本地伪装都不可用，TLS 指纹可被识破，风险更高）'
              : 'Node 直连（高级选项，TLS 指纹可被识破）',
    };
  }

  async screenshot() {
    return null;
  }

  /** 账号池状态 */
  accounts() {
    return listAccounts();
  }

  /** 登录态检查：拿一个账号的 token 打 /users/current */
  async state() {
    const accounts = listAccounts();
    if (!accounts.length) {
      return { ok: true, loggedIn: false, engine: 'http', accounts: [], url: BASE };
    }
    const active = accounts.find((a) => a.status === 'ok') || accounts[0];
    const token = getToken(active.id);
    try {
      const res = await this.upstreamJson({ path: '/api/v0/users/current', token });
      if (res.status === 200 && res.json?.code === 0) {
        return {
          ok: true,
          loggedIn: true,
          engine: 'http',
          active: active.id,
          accounts,
          user: res.json?.data?.biz_data?.user || null,
        };
      }
      return { ok: true, loggedIn: false, engine: 'http', accounts, error: res.text?.slice(0, 200) };
    } catch (error) {
      return { ok: false, loggedIn: false, engine: 'http', accounts, error: String(error.message || error) };
    }
  }

  /**
   * 出站前把传输档准备好：如果解析结果是「真·手机浏览器」，就把目标页面的 CDP 地址交给
   * BrowserTransport（它只在真正用到时才连，避免空转）。
   */
  async _prepareTransport() {
    const mode = await resolveTransport();
    if (resolvedVia() === 'device') {
      const dev = await deviceBrowserAvailability();
      if (!dev.ok || dev.needPage) {
        throw new UpstreamError('手机浏览器不可用：' + (dev.needPage ? dev.hint : dev.reason), { kind: 'transport' });
      }
      this.browser.setRemote(dev.wsUrl, dev.pageUrl || BASE + '/');
    }
    return mode;
  }

  /**
   * 统一出站：同一个账号的**所有** chat.deepseek.com 请求都走同一个传输档。
   *
   * 为什么必须统一：真实浏览器只有一个 TLS/HTTP 栈。插件以前把「对话」交给 native（curl_cffi，
   * JA4 = Chrome、h2），却把「token 体检」交给 Node 的 undici（h1.1、JA4 完全不同）——
   * 同一账号、同一 IP、同一时间窗里出现两套指纹，比任何单个指纹细节都更像「有人在中间转」。
   * 真实浏览器不会这样，所以这里要么全程 chrome 级，要么（只有它不可用时）全程 node。
   */
  async upstreamJson({ path, token = '', headers = {}, timeoutMs = 20000, method = 'GET', body = undefined }) {
    const h = { ...baseHeaders(token), ...humanHeaders(), ...headers };
    let mode = 'node';
    try {
      mode = await this._prepareTransport();
    } catch {}
    if (mode === 'browser') {
      try {
        const r = await this.browser.request({ path, method, headers: h, body: method === 'GET' ? null : String(body ?? '{}'), timeoutMs });
        return { status: r.status, text: r.text || '', json: safeJson(r.text) };
      } catch (e) {
        this.log('[transport] 统一出站走浏览器失败，降级 native：' + String(e.message || e).slice(0, 120));
      }
    }
    if (mode === 'browser' || mode === 'native') {
      try {
        const r = await this.native.call({
          path,
          headers: h,
          method,
          body: method === 'GET' ? '' : String(body ?? '{}'),
          timeout: Math.max(5, Math.ceil(timeoutMs / 1000)),
        });
        return r;
      } catch (e) {
        this.log('[transport] 统一出站走 native 失败，降级 node（会出现混合指纹）：' + String(e.message || e).slice(0, 120));
      }
    }
    if (method === 'GET') return get(path, { token, headers, timeoutMs, _raw: true });
    // 回退到 Node 时 body 已经是 JSON 字符串：不能再 stringify 一次，否则变成了「JSON 的字符串」
    const parsed = typeof body === 'string' ? safeJson(body) : body;
    return post(path, parsed ?? {}, { token, headers, timeoutMs, _raw: true });
  }

  /**
   * 等一个账号的发送间隔，保证不紧贴着打上游。
   * 三层节奏（从轻到重）：随机间隔 → 滚动窗口限速 → 连续多轮后长休。
   */
  async pace(accountId, typedChars = 0) {
    const cfg0 = loadConfig();
    const { sendGapMs, sendGapMaxMs } = cfg0;
    const mode = currentMode();
    // 人类节律（默认开）：每日上限 + 打字时间 + 作息曲线 + 走神停顿
    const human = cfg0.humanRhythm !== false;
    if (human) {
      const budget = checkDailyBudget(accountId, cfg0.dailyMsgs);
      if (!budget.ok) {
        // 不换号、不硬闯：换号恰好是最像「多开小号轮换」的行为
        throw new UpstreamError(
          '该账号最近 24 小时已发 ' + budget.used + ' 条（人类节律上限 ' + budget.limit + ' 条/24h），已暂停发送以免触发账号级风控；可在运行设置里调高上限或关掉人类节律。',
          { kind: 'budget', code: 'HUMAN_DAILY_BUDGET' },
        );
      }
    }
    // 间隔是「区间内随机」而不是固定值：固定间隔方差≈0，统计上就是定时器特征
    const gap = gapFor(sendGapMs, mode, sendGapMaxMs);
    let planned = gap;
    let planNote = '';
    if (human) {
      const plan = humanGapPlan({
        baseGapMs: gap,
        promptChars: typedChars,
        nightQuiet: cfg0.nightQuiet !== false,
        tzOffsetMin: tzOffsetMinutes(),
      });
      planned = plan.ms;
      planNote =
        '（基数 ' + plan.base + 'ms + 打字 ' + plan.typing + 'ms' +
        (plan.distraction ? ' + 走神 ' + plan.distraction + 'ms' : '') + (plan.quiet ? '；深夜时段已放大' : '') + '）';
    }
    // 间隔按「上一次请求结束」起算：长回答（几十秒）之后不该再白等，
    // 但也不能「开始时算一次就够」—— 那样长回答等于把间隔吃掉了，密集感又回来了。
    const last = Math.max(lastSentAt.get(accountId) || 0, lastDoneAt.get(accountId) || 0);
    // 距上一次请求超过 10 分钟 = 人歇过了，连续计数清零（否则长休可能永远触发不到）
    if (last > 0 && Date.now() - last > HUMAN_BREAK_MS) this._consecutive = 0;
    let wait = last + planned - Date.now();
    // 第一次说话、或上一句已经过去一阵子：真人不会先发会儿呆再开口，直接说不等
    if (!last || Date.now() - last > FIRST_MSG_FREE_MS) {
      if (wait > 0) this.log('[pace] 首轮/间歇后，跳过 ' + Math.round(wait / 1000) + 's 间隔');
      wait = 0;
    } else if (wait > 0 && human) {
      this.log('[pace] 人类节律：等 ' + Math.round(wait / 1000) + 's' + planNote);
    }
    // 一、连续跑了十几轮：插一次长休。真人不会一口气几十条，机器味也是账号级限流的诱因
    if (this._consecutive >= LONG_RUN_THRESHOLD && this._lastDoneAt > 0) {
      const rest = longRestFor();
      const ms = Math.round(rest.min + Math.random() * (rest.max - rest.min));
      wait = Math.max(wait, this._lastDoneAt + ms - Date.now());
      this.log(`[pace] 已连续 ${this._consecutive} 轮，长休 ${Math.round(ms / 1000)}s 再发（防账号级限流）`);
      this._consecutive = 0;
    }
    // 二、滚动窗口：十分钟内最多 N 次，超了就等最老那次滑出去
    const win = rateWindowFor(mode);
    const now = Date.now();
    this._recentStarts = this._recentStarts.filter((t) => now - t < win.windowMs);
    if (this._recentStarts.length >= win.max) {
      const freeAt = this._recentStarts[this._recentStarts.length - win.max] + win.windowMs;
      const ms = freeAt - now;
      if (ms > wait) {
        this.log(`[pace] 近 ${Math.round(win.windowMs / 60000)} 分钟已发 ${this._recentStarts.length} 次（上限 ${win.max}），等 ${Math.round(ms / 1000)}s 再发（滚动窗口限速）`);
        wait = ms;
      }
    }
    if (wait > 0) await sleep(wait);
    const at = Date.now();
    lastSentAt.set(accountId, at);
    this._recentStarts.push(at);
    if (human) recordHumanSend(accountId, at);
  }

  /** 取 PoW 挑战并求解 */
  async powHeader(token, targetPath, cookie = '', fp = {}, mode = '') {
    const m = mode || transportMode();
    if (m === 'browser') return this.browser.powHeader(token, cookie, targetPath);
    if (m === 'native') {
      const r = await this.native.call({
        path: '/api/v0/chat/create_pow_challenge',
        headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token, ...(cookie ? { cookie } : {}), ...fp, ...humanHeaders() },
        body: JSON.stringify({ target_path: targetPath }),
      });
      if (r.status !== 200 || r.json?.code !== 0) throw classify({ status: r.status, text: r.text }, '获取 PoW 挑战');
      const challenge = r.json?.data?.biz_data?.challenge;
      if (!challenge) throw new UpstreamError('PoW 挑战为空：' + String(r.text).slice(0, 200), { kind: 'upstream' });
      return solvePowHeader(challenge, targetPath);
    }
    const res = await post('/api/v0/chat/create_pow_challenge', { target_path: targetPath }, { token, headers: { ...(cookie ? { cookie } : {}), ...fp, ...humanHeaders() } });
    if (res.status !== 200 || res.json?.code !== 0) throw classify(res, '获取 PoW 挑战');
    const challenge = res.json?.data?.biz_data?.challenge;
    if (!challenge) throw new UpstreamError('PoW 挑战为空：' + res.text.slice(0, 200), { kind: 'upstream' });
    return solvePowHeader(challenge, targetPath);
  }

  async createSession(token, cookie = '', fp = {}, mode = '') {
    const m = mode || transportMode();
    if (m === 'native') {
      const r = await this.native.call({
        path: '/api/v0/chat_session/create',
        headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token, ...(cookie ? { cookie } : {}), ...fp, ...humanHeaders() },
        body: '{}',
      });
      let j = null;
      try { j = JSON.parse(r.text); } catch {}
      const id = j?.data?.biz_data?.chat_session?.id;
      if (r.status !== 200 || j?.code !== 0 || !id) throw classify({ status: r.status, text: r.text }, '创建会话');
      return id;
    }
    if (m === 'browser') {
      const r = await this.browser.request({
        path: '/api/v0/chat_session/create',
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token, ...fp },
        body: '{}',
      });
      let j = null;
      try { j = JSON.parse(r.text); } catch {}
      const id = j?.data?.biz_data?.chat_session?.id;
      if (!id) throw classify({ status: r.status, text: r.text }, '创建会话');
      return id;
    }
    const res = await post('/api/v0/chat_session/create', {}, { token, headers: { ...(cookie ? { cookie } : {}), ...fp, ...humanHeaders() } });
    if (res.status !== 200 || res.json?.code !== 0) throw classify(res, '创建会话');
    const id = res.json?.data?.biz_data?.chat_session?.id;
    if (!id) throw new UpstreamError('创建会话返回为空：' + res.text.slice(0, 200), { kind: 'upstream' });
    return id;
  }

  /**
   * 一次完整对话：选号 → PoW → 建会话（可选）→ SSE 流式读取
   * @returns {Promise<{sessionId: string, accountId: string}>}
   */
  async chat({ prompt, thinking = false, sessionId = null, parentId = null, onDelta, idleMs = 180000, preferAccount = null, typedChars = 0 }) {
    const cfg = loadConfig();
    // 新账号的「先闲聊两句」从关键路径移走：以前是 await，第一条消息要等两句闲聊 + 节律，
    // 重启后第一条能慢到一分钟。现在改成空闲后台补，用户那句永远先发出去。
    if (cfg.warmup) this._warmupWhenIdle(preferAccount);
    const tried = new Set();
    let lastError = null;
    let prefer = preferAccount;
    let reloginTried = false;
    const transientRetried = new Set(); // 已因「复检有效」原地重试过的账号，避免原地打转
    const accountCount = Math.max(1, listAccounts().length || 1);

    // 多留一次机会：token 失效时可能靠「保存的密码自动重登」原地救回来，不需要换账号
    for (let attempt = 0; attempt < Math.max(1, Math.min(4, accountCount)) + 1; attempt++) {
      const account = pickAccount({ prefer, exclude: tried });
      if (!account) break;
      tried.add(account.id);
      const token = getToken(account.id);
      if (!token) continue;
      try {
        await this.pace(account.id, typedChars);
        const out = await this._runChat(account.id, () =>
          this._chatOnce({ token, cookie: getCookie(account.id), prompt, thinking, sessionId, parentId, onDelta, idleMs, accountId: account.id }),
        );
        markUsed(account.id);
        this._consecutive += 1;
        this._lastDoneAt = Date.now();
        lastDoneAt.set(account.id, this._lastDoneAt);
        return { ...out, accountId: account.id };
      } catch (error) {
        lastError = error;
        this.lastError = error;
        if (error.kind === 'auth') {
          const who = account.label + (account.email ? '（' + account.email + '）' : '') + ' ' + account.id;
          // 「登录态失效」不一定是真的：WAF 拦截页（202 HTML）、限流、网络抖动同样不是 200。
          // 复检一次 token：只有站点明确回 INVALID_TOKEN 才敢动账号状态，否则按临时故障处理，
          // 免得把好号标成失效（用户看到「经常登录失效」，很多是这种假警报）。
          const probe = await probeToken(token, { requester: (o) => this.upstreamJson(o) });
          if (probe.state === 'valid') {
            if (!transientRetried.has(account.id)) {
              transientRetried.add(account.id);
              this.log('[chat] 账号 ' + who + ' 报登录态失效，但 token 复检有效（' + String(error.message || '').slice(0, 60) + '）→ 按临时故障原地重试');
              tried.delete(account.id);
              prefer = account.id;
              continue;
            }
            this.log('[chat] 账号 ' + who + ' 复检有效但仍失败，跳过本轮：' + String(error.message || '').slice(0, 80));
            // token 明确有效就不该标成失效，也不该去撞自动重登（反而可能触发风控）
            continue;
          } else if (probe.state === 'unknown') {
            // 没验出来（网络/风控页/限流）：不标记失效、也不去撞自动重登，直接换下一个账号
            this.log('[chat] 账号 ' + who + ' token 复检没验出来（' + String(probe.message || '').slice(0, 80) + '），按临时故障换号，不标记失效');
            continue;
          }
          // 先试「保存的密码自动重登」：成功后原地换 token，用同一个账号再跑一次
          if (!reloginTried) {
            reloginTried = true;
            const r = await reloginAccount(account.id, { reason: 'chat' });
            if (r.ok) {
              this.log(`[chat] 账号 ${account.label} token 失效，已用保存的密码自动重新登录`);
              tried.delete(account.id);
              prefer = account.id;
              continue;
            }
            if (r.needCode) this.log(`[chat] 账号 ${account.label} 自动重登需要邮箱验证码，请到设置里手动登录一次`);
          }
          markAuthExpired(account.id);
          // 自动换号可以关（学 dsh-deepseek-web-login：几分钟内频繁换号是极强的机器特征）。
          // 关掉时明确报错，而不是悄悄拿别的号接着跑。
          if (!loadConfig().autoSwitch) {
            throw new UpstreamError('账号 ' + who + ' 登录态已失效；自动换号已关闭，请重新登录或在设置里打开「失效自动换号」', {
              kind: 'auth',
              code: 'AUTH_EXPIRED_NO_SWITCH',
            });
          }
          this.log(`[chat] 账号 ${who} 登录态失效，切换下一个`);
          continue;
        }
        if (error.kind === 'rate') {
          // 退避按「连续被限流次数」翻倍（40s → 80s → 90s 封顶 + 抖动）：限流是「发太快了」的反馈，
          // 同号冷却完立刻再撞只会把账号推给站点风控。冷却结束后上层重试会换下一个账号。
          const backoff = noteThrottled();
          const out = setCooldown(account.id, backoff);
          this.log(`[chat] 账号 ${account.label} 被限流，冷却 ${Math.round((out?.wait || backoff) / 1000)}s（连续第 ${throttleStreak} 次）`);
          if (!loadConfig().autoSwitch) {
            throw new UpstreamError('账号 ' + account.label + ' 被站点限流，冷却 ' + Math.round((out?.wait || backoff) / 1000) + 's；自动换号已关闭', {
              kind: 'rate',
              code: 'RATE_LIMITED_NO_SWITCH',
            });
          }
          continue;
        }
        if (error.kind === 'mute' || error.kind === 'banned') {
          // 站点禁言/封号：账号本身还登着，但不能发消息。记下来，到期前不再用它，换下一个账号。
          const until = error.untilMs || 0;
          markMuted(account.id, until, { banned: error.kind === 'banned', reason: error.reason || error.message });
          const when = until ? new Date(until).toLocaleString('zh-CN') : '（站点未给到期时间）';
          this.log(`[chat] 账号 ${account.label} ${error.kind === 'banned' ? '已被停用' : '被禁言'}：${when}，切换下一个`);
          continue;
        }
        if (error.kind === 'budget') {
          // 人类节律上限：换号 = 典型多开特征，直接停住等用户决定
          this.log('[chat] 人类节律上限：' + String(error.message || ''));
          throw error;
        }
        // 其它错误：交给网关的上层重试策略（空回复重试、换会话重试）
        throw error;
      }
    }
    throw lastError || new UpstreamError('没有可用账号，请先在设置里登录 DeepSeek 账号', {
      kind: 'auth',
      code: 'AUTH_REQUIRED',
    });
  }

  /**
   * 登录后的热身：只对「还没用过」的账号做一次，闲聊 1~2 句，然后打上 warmupAt。
   * 失败不阻塞真实请求（记日志、标记跳过），避免热身把主流程拖死。
   */
  /** 空闲时补 warmup：有请求在跑就往后让，绝不和用户的消息抢同一个账号 */
  _warmupWhenIdle(prefer = null) {
    if (this._warmingDone || this._warmupTimer) return;
    const cfg = loadConfig();
    if (!cfg.warmup) return;
    this._warmupTimer = setTimeout(() => {
      this._warmupTimer = null;
      if (this._active > 0) {
        this._warmupWhenIdle(prefer);
        return;
      }
      this._maybeWarmup(prefer).catch((e) => this.log('[warmup] 跳过：' + String((e && e.message) || e).slice(0, 120)));
    }, 25000);
    if (this._warmupTimer.unref) this._warmupTimer.unref();
  }

  async _maybeWarmup(prefer = null) {
    if (this._warmingDone) return null;
    const cfg = loadConfig();
    const count = Math.max(0, Math.min(4, Number(cfg.warmupMsgs) || 0));
    if (!count) return null;
    const accounts = listAccounts().filter((a) => a.status === 'ok' && !a.muted && !a.banned);
    const account = prefer ? accounts.find((a) => a.id === prefer) : accounts[0];
    if (!account || !warmupNeeded(account, cfg)) return null;
    // 用过就不假装：给个标记免得每次请求都判断
    if (account.lastUsedAt) {
      updateAccount(account.id, { warmupAt: Date.now() });
      return null;
    }
    const token = getToken(account.id);
    if (!token) return null;
    this.log('[warmup] 账号「' + (account.label || account.email || account.id) + '」首次使用，先闲聊 ' + count + ' 句');
    const phrases = pickWarmupPhrases(count);
    for (const phrase of phrases) {
      try {
        await this.pace(account.id, phrase.length);
        await this._runChat(account.id, () =>
          this._chatOnce({
            token,
            cookie: getCookie(account.id),
            prompt: phrase,
            thinking: false,
            onDelta: () => {},
            accountId: account.id,
          }),
        );
        markUsed(account.id);
        this.log('[warmup] 说了：' + phrase);
      } catch (error) {
        if (error && (error.kind === 'mute' || error.kind === 'banned')) {
          markMuted(account.id, error.untilMs || 0, { banned: error.kind === 'banned', reason: error.reason || error.message || '' });
        }
        this.log('[warmup] 中断：' + String((error && error.message) || error).slice(0, 120));
        break;
      }
    }
    updateAccount(account.id, { warmupAt: Date.now() });
    return null;
  }

  async _chatOnce(args) {
    const mode = await this._prepareTransport();
    if (mode === 'browser') return this._chatOnceBrowser(args);
    if (mode === 'native') return this._chatOnceNative(args);
    return this._chatOnceNode(args);
  }

  /** 会话流解析：node / native 两条路共用（SSE 按空行切块，认限流与禁言） */
  async _readChatStream(res, onDelta, touch = () => {}) {
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      touch();
      buf += dec.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        if (rateLimitErrorFrom(block)) {
          throw new UpstreamError('账号被站点限流：' + String(block).slice(0, 160), { kind: 'rate', code: '40029' });
        }
        const muted = muteErrorFrom(block);
        if (muted) {
          throw new UpstreamError(
            (muted.banned ? '账号已被站点停用' : '账号被站点禁言') + (muted.message ? '：' + muted.message : ''),
            {
              kind: muted.banned ? 'banned' : 'mute',
              code: muted.banned ? '40012' : '50006',
              untilMs: muted.untilMs,
              reason: muted.message || '',
            },
          );
        }
        if (block.trim() && onDelta) onDelta(block);
      }
    }
    if (buf.trim() && onDelta) onDelta(buf);
  }

  /** native 传输：请求由 curl_cffi（Chrome 级 TLS/H2）发出，PoW 仍用官方 wasm 本地算 */
  async _chatOnceNative({ token, cookie = '', prompt, thinking, sessionId, parentId, onDelta, idleMs, accountId = '' }) {
    const targetPath = '/api/v0/chat/completion';
    const fp = accountId ? getFingerprint(accountId) : {};
    const pow = await this.powHeader(token, targetPath, cookie, fp, 'native');
    const sid = sessionId || (await this.createSession(token, cookie, fp, 'native'));
    const body = JSON.stringify({
      chat_session_id: sid,
      parent_message_id: parentId || null,
      model_type: 'default',
      prompt,
      ref_file_ids: [],
      thinking_enabled: !!thinking,
      search_enabled: false,
      action: null,
      preempt: false,
    });
    let res;
    try {
      res = await this.native.request({
        path: targetPath,
        headers: { ...baseHeaders(token), ...(cookie ? { cookie } : {}), ...fp, ...humanHeaders(), 'x-ds-pow-response': pow },
        body,
        timeout: Math.max(60, Math.ceil(idleMs / 1000) + 30),
      });
    } catch (e) {
      throw new UpstreamError('本地伪装传输失败：' + String(e.message || e), { kind: 'upstream', code: 'NATIVE_FAILED' });
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw classify({ status: res.status, text }, '对话请求');
    }
    await this._readChatStream(res, onDelta);
    return { sessionId: sid };
  }

  /** 浏览器传输：请求由真实页面发出（TLS 指纹 = 浏览器），PoW 在页面里解 */
  async _chatOnceBrowser({ token, cookie = '', prompt, thinking, sessionId, parentId, onDelta, idleMs, accountId = '' }) {
    const targetPath = '/api/v0/chat/completion';
    const fp = accountId ? getFingerprint(accountId) : {};
    try {
      await this.browser.installSession(token, cookie, deviceId());
    } catch (e) {
      throw new UpstreamError(
        '浏览器传输不可用：' + String(e.message || e) + '（去「运行设置 → 传输层」切到 Node 直连（高危），或装一个能跑的 Chrome / Edge）',
        { kind: 'upstream', code: 'BROWSER_UNAVAILABLE' },
      );
    }
    let pow;
    try {
      pow = await this.browser.powHeader(token, cookie, targetPath);
    } catch (e) {
      throw new UpstreamError(
        '浏览器传输不可用（PoW 没解出来）：' + String(e.message || e) + '（去「运行设置 → 传输层」切到 Node 直连（高危））',
        { kind: 'upstream', code: 'BROWSER_POW_FAILED' },
      );
    }
    const sid = sessionId || (await this.createSession(token, cookie, fp));
    const headers = {
      'content-type': 'application/json',
      authorization: 'Bearer ' + token,
      ...fp,
      'x-ds-pow-response': pow,
    };
    const payload = JSON.stringify({
      chat_session_id: sid,
      parent_message_id: parentId || null,
      model_type: 'default',
      prompt,
      ref_file_ids: [],
      thinking_enabled: !!thinking,
      search_enabled: false,
      action: null,
      preempt: false,
    });
    let buf = '';
    let streamError = null;
    const onChunk = (chunk) => {
      if (streamError) return;
      buf += chunk;
      let idx;
      while ((idx = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        try {
          if (rateLimitErrorFrom(block)) throw new UpstreamError('账号被站点限流：' + String(block).slice(0, 160), { kind: 'rate', code: '40029' });
          const muted = muteErrorFrom(block);
          if (muted) {
            throw new UpstreamError(muted.banned ? '账号已被站点停用' : '账号被站点禁言', {
              kind: muted.banned ? 'banned' : 'mute',
              code: muted.banned ? '40012' : '50006',
              untilMs: muted.untilMs,
            });
          }
        } catch (e) {
          streamError = e;
          return;
        }
        if (block.trim() && onDelta) onDelta(block);
      }
    };
    const out = await this.browser.stream({ path: targetPath, headers, body: payload, onChunk, idleMs: idleMs || 0 });
    if (streamError) throw streamError;
    if (out.status !== 200) throw classify({ status: out.status, text: out.text }, '对话请求');
    if (buf.trim() && onDelta) onDelta(buf);
    return { sessionId: sid };
  }

  /** Node 直连（旧实现，高级选项；仍保留全部逻辑，可随时切回） */
  async _chatOnceNode({ token, cookie = '', prompt, thinking, sessionId, parentId, onDelta, idleMs, accountId = '' }) {
    const targetPath = '/api/v0/chat/completion';
    // 登录页采集到的真实浏览器指纹头：有就带上，让请求和真人页面发出的长得一样
    const fp = accountId ? getFingerprint(accountId) : {};
    const pow = await this.powHeader(token, targetPath, cookie, fp);
    const sid = sessionId || (await this.createSession(token, cookie, fp));

    const ac = new AbortController();
    let last = Date.now();
    const watchdog = setInterval(() => {
      if (Date.now() - last > idleMs) {
        this.log('[chat] 流空闲超时，主动断开');
        ac.abort(new Error('idle timeout'));
      }
    }, 5000);

    try {
      const res = await fetch(BASE + targetPath, {
        method: 'POST',
        headers: { ...baseHeaders(token), ...(cookie ? { cookie } : {}), ...fp, ...humanHeaders(), 'x-ds-pow-response': pow },
        body: JSON.stringify({
          chat_session_id: sid,
          parent_message_id: parentId || null,
          model_type: 'default',
          prompt,
          ref_file_ids: [],
          thinking_enabled: !!thinking,
          search_enabled: false,
          action: null,
          preempt: false,
        }),
        signal: ac.signal,
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw classify({ status: res.status, text }, '对话请求');
      }
      await this._readChatStream(res, onDelta, () => { last = Date.now(); });
      return { sessionId: sid };
    } finally {
      clearInterval(watchdog);
    }
  }

  async listSessions() {
    const account = pickAccount({});
    if (!account) return { total: 0, rows: [], error: '未登录' };
    const token = getToken(account.id);
    const res = await get('/api/v0/chat_session/fetch_page?count=100&lte_seq_id=9999999999', { token });
    const list = res.json?.data?.biz_data?.chat_sessions || [];
    return { total: list.length, rows: list.map((s) => ({ id: s.id, title: s.title || '' })) };
  }

  async purgeTraceSessions() {
    const account = pickAccount({});
    if (!account) return { deleted: 0, error: '未登录' };
    const token = getToken(account.id);
    const res = await get('/api/v0/chat_session/fetch_page?count=100&lte_seq_id=9999999999', { token });
    const list = res.json?.data?.biz_data?.chat_sessions || [];
    let deleted = 0;
    for (const s of list) {
      if (!/\[Instruction\]|\[API request\]|\[User\]|\[Assistant\]/.test(s.title || '')) continue;
      const r = await post('/api/v0/chat_session/delete', { chat_session_id: s.id }, { token });
      if (r.status === 200) deleted += 1;
    }
    return { scanned: list.length, deleted };
  }
}

/** 供 doctor 用：只检查能不能拿到挑战（需要有效 token） */
export async function probeUpstream(token) {
  const res = await get('/api/v0/users/current', { token });
  return { status: res.status, body: res.text.slice(0, 200) };
}
