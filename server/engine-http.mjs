// HTTP 引擎：不依赖浏览器，直接用 chat.deepseek.com 的网页接口
import { BASE, UA, post, get, classify, UpstreamError, baseHeaders } from './http.mjs';
import { solvePowHeader } from './pow.mjs';
import { loadConfig } from './config.mjs';
import { currentMode, modeLimits, gapFor, rateWindowFor, LONG_RUN_THRESHOLD, HUMAN_BREAK_MS, longRestFor, throttleBackoffMs } from './request-mode.mjs';
import { pickAccount, markUsed, markCooldown, setCooldown, markAuthExpired, markMuted, listAccounts, getToken, getCookie, getFingerprint } from './accounts.mjs';
import { reloginAccount } from './relogin.mjs';
import { createStreamParser } from './stream-parser.mjs';
import { BrowserTransport, browserAvailability } from './browser-transport.mjs';
import { deviceId } from './device.mjs';
import { probeToken } from './token-check.mjs';

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
  if (env === 'node' || env === 'browser' || env === 'auto') return env;
  try {
    const v = loadConfig().transport;
    return ['node', 'browser', 'auto'].includes(v) ? v : 'auto';
  } catch {
    return 'auto';
  }
}

let _resolved = '';
let _lastWarnAt = 0;

/** 同步读：auto 还没判定过时先按 browser（第一次请求会 await resolveTransport 再定） */
export function transportMode() {
  const c = configuredTransport();
  if (c === 'node' || c === 'browser') return c;
  return _resolved === 'node' ? 'node' : 'browser';
}

/** 真正决定这次请求走哪条路：auto 会先做一次浏览器冒烟检测（结果有 5 分钟缓存） */
export async function resolveTransport() {
  const c = configuredTransport();
  if (c === 'node' || c === 'browser') {
    _resolved = c;
    return c;
  }
  const avail = await browserAvailability();
  _resolved = avail.ok ? 'browser' : 'node';
  if (!avail.ok && Date.now() - _lastWarnAt > 60000) {
    _lastWarnAt = Date.now();
    console.warn(
      '[transport] auto 已回退 Node 直连：' + (avail.reason || '浏览器不可用') +
        (avail.path ? '（' + avail.path + '）' : ''),
    );
  }
  return _resolved;
}

const lastSentAt = new Map(); // accountId -> 上一次请求「开始」时间
const lastDoneAt = new Map(); // accountId -> 上一次请求「结束」时间（间隔要按结束算，长回答之后不必白等，但必须等满）

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** 从上游返回块里认出「禁言 / 封号」：50006 MUTED、40012 USER_IS_BANNED（站点错误码） */
export function muteErrorFrom(text) {
  if (!/"code"\s*:\s*50006|"biz_code"\s*:\s*50006/.test(text) && !/"code"\s*:\s*40012|"biz_code"\s*:\s*40012/.test(text)) return null;
  const banned = /"code"\s*:\s*40012|"biz_code"\s*:\s*40012/.test(text);
  const m = /"end_at"\s*:\s*(\d{9,13})/.exec(text) || /"mute_until"\s*:\s*(\d{9,13})/.exec(text);
  let untilMs = 0;
  if (m) {
    const n = Number(m[1]);
    untilMs = n > 1e12 ? n : n * 1000;
  }
  return { banned, untilMs };
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
  }

  /** 传输层自检：能不能用（设置页会显示结果，不静默降级） */
  async transportStatus() {
    const configured = configuredTransport();
    const avail = await browserAvailability();
    const mode = configured === 'node' ? 'node' : configured === 'browser' ? 'browser' : avail.ok ? 'browser' : 'node';
    return {
      configured,
      mode,
      ok: mode === 'node' ? true : avail.ok,
      browser: avail.path || '',
      version: avail.version || '',
      reason: avail.reason || '',
      fallback: configured === 'auto' && !avail.ok,
      note:
        mode === 'node'
          ? configured === 'auto'
            ? 'Node 直连（auto 回退：浏览器起不来，TLS 指纹可被识破，风险更高）'
            : 'Node 直连（高级选项，TLS 指纹可被识破）'
          : '浏览器传输（请求与 PoW 都在真实页面里）',
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
      const res = await get('/api/v0/users/current', { token });
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
   * 等一个账号的发送间隔，保证不紧贴着打上游。
   * 三层节奏（从轻到重）：随机间隔 → 滚动窗口限速 → 连续多轮后长休。
   */
  async pace(accountId) {
    const { sendGapMs, sendGapMaxMs } = loadConfig();
    const mode = currentMode();
    // 间隔是「区间内随机」而不是固定值：固定间隔方差≈0，统计上就是定时器特征
    const gap = gapFor(sendGapMs, mode, sendGapMaxMs);
    // 间隔按「上一次请求结束」起算：长回答（几十秒）之后不该再白等，
    // 但也不能「开始时算一次就够」—— 那样长回答等于把间隔吃掉了，密集感又回来了。
    const last = Math.max(lastSentAt.get(accountId) || 0, lastDoneAt.get(accountId) || 0);
    // 距上一次请求超过 10 分钟 = 人歇过了，连续计数清零（否则长休可能永远触发不到）
    if (last > 0 && Date.now() - last > HUMAN_BREAK_MS) this._consecutive = 0;
    let wait = last + gap - Date.now();
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
  }

  /** 取 PoW 挑战并求解 */
  async powHeader(token, targetPath, cookie = '', fp = {}) {
    if (transportMode() === 'browser') return this.browser.powHeader(token, cookie, targetPath);
    const res = await post('/api/v0/chat/create_pow_challenge', { target_path: targetPath }, { token, headers: { ...(cookie ? { cookie } : {}), ...fp } });
    if (res.status !== 200 || res.json?.code !== 0) throw classify(res, '获取 PoW 挑战');
    const challenge = res.json?.data?.biz_data?.challenge;
    if (!challenge) throw new UpstreamError('PoW 挑战为空：' + res.text.slice(0, 200), { kind: 'upstream' });
    return solvePowHeader(challenge, targetPath);
  }

  async createSession(token, cookie = '', fp = {}) {
    if (transportMode() === 'browser') {
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
    const res = await post('/api/v0/chat_session/create', {}, { token, headers: { ...(cookie ? { cookie } : {}), ...fp } });
    if (res.status !== 200 || res.json?.code !== 0) throw classify(res, '创建会话');
    const id = res.json?.data?.biz_data?.chat_session?.id;
    if (!id) throw new UpstreamError('创建会话返回为空：' + res.text.slice(0, 200), { kind: 'upstream' });
    return id;
  }

  /**
   * 一次完整对话：选号 → PoW → 建会话（可选）→ SSE 流式读取
   * @returns {Promise<{sessionId: string, accountId: string}>}
   */
  async chat({ prompt, thinking = false, sessionId = null, parentId = null, onDelta, idleMs = 180000, preferAccount = null }) {
    const cfg = loadConfig();
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
        await this.pace(account.id);
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
          const probe = await probeToken(token);
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
          markMuted(account.id, until, { banned: error.kind === 'banned', reason: error.message });
          const when = until ? new Date(until).toLocaleString('zh-CN') : '（站点未给到期时间）';
          this.log(`[chat] 账号 ${account.label} ${error.kind === 'banned' ? '已被停用' : '被禁言'}：${when}，切换下一个`);
          continue;
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

  async _chatOnce(args) {
    if ((await resolveTransport()) === 'browser') return this._chatOnceBrowser(args);
    return this._chatOnceNode(args);
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
        headers: { ...baseHeaders(token), ...(cookie ? { cookie } : {}), ...fp, 'x-ds-pow-response': pow },
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
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        last = Date.now();
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
            throw new UpstreamError(muted.banned ? '账号已被站点停用' : '账号被站点禁言', {
              kind: muted.banned ? 'banned' : 'mute',
              code: muted.banned ? '40012' : '50006',
              untilMs: muted.untilMs,
            });
          }
          if (block.trim() && onDelta) onDelta(block);
        }
      }
      if (buf.trim() && onDelta) onDelta(buf);
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
