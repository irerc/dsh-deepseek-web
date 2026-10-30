// HTTP 引擎：不依赖浏览器，直接用 chat.deepseek.com 的网页接口
import { BASE, UA, post, get, classify, UpstreamError, baseHeaders } from './http.mjs';
import { solvePowHeader } from './pow.mjs';
import { loadConfig } from './config.mjs';
import { pickAccount, markUsed, markCooldown, markAuthExpired, listAccounts, getToken, getCookie } from './accounts.mjs';
import { createStreamParser } from './stream-parser.mjs';

const lastSentAt = new Map(); // accountId -> timestamp

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

export class DeepSeekHttp {
  constructor(log = () => {}) {
    this.log = log;
    this.busy = Promise.resolve();
    this._depth = 0;
    this.closed = false;
    this.lastError = null;
  }

  get pending() {
    return this._depth;
  }

  /** 串行化：同一时刻只跑一个上游请求，避免触发风控 */
  exclusive(fn) {
    this._depth += 1;
    const wrapped = () => fn().finally(() => {
      this._depth = Math.max(0, this._depth - 1);
    });
    const run = this.busy.then(wrapped, wrapped);
    this.busy = run.catch(() => {});
    return run;
  }

  async close() {
    this.closed = true;
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

  /** 等一个账号的发送间隔，保证不紧贴着打上游 */
  async pace(accountId) {
    const { sendGapMs } = loadConfig();
    const gap = Math.max(0, sendGapMs) * (0.8 + Math.random() * 0.4);
    const last = lastSentAt.get(accountId) || 0;
    const wait = last + gap - Date.now();
    if (wait > 0) await sleep(wait);
    lastSentAt.set(accountId, Date.now());
  }

  /** 取 PoW 挑战并求解 */
  async powHeader(token, targetPath, cookie = '') {
    const res = await post('/api/v0/chat/create_pow_challenge', { target_path: targetPath }, { token, headers: cookie ? { cookie } : {} });
    if (res.status !== 200 || res.json?.code !== 0) throw classify(res, '获取 PoW 挑战');
    const challenge = res.json?.data?.biz_data?.challenge;
    if (!challenge) throw new UpstreamError('PoW 挑战为空：' + res.text.slice(0, 200), { kind: 'upstream' });
    return solvePowHeader(challenge, targetPath);
  }

  async createSession(token, cookie = '') {
    const res = await post('/api/v0/chat_session/create', {}, { token, headers: cookie ? { cookie } : {} });
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

    for (let attempt = 0; attempt < Math.max(1, Math.min(4, listAccounts().length || 1)); attempt++) {
      const account = pickAccount({ prefer: preferAccount, exclude: tried });
      if (!account) break;
      tried.add(account.id);
      const token = getToken(account.id);
      if (!token) continue;
      try {
        await this.pace(account.id);
        const out = await this._chatOnce({ token, cookie: getCookie(account.id), prompt, thinking, sessionId, parentId, onDelta, idleMs });
        markUsed(account.id);
        return { ...out, accountId: account.id };
      } catch (error) {
        lastError = error;
        this.lastError = error;
        if (error.kind === 'auth') {
          markAuthExpired(account.id);
          this.log(`[chat] 账号 ${account.label} 登录态失效，切换下一个`);
          continue;
        }
        if (error.kind === 'rate') {
          const out = markCooldown(account.id, 60000);
          this.log(`[chat] 账号 ${account.label} 被限流，冷却 ${Math.round((out?.wait || 0) / 1000)}s`);
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

  async _chatOnce({ token, cookie = '', prompt, thinking, sessionId, parentId, onDelta, idleMs }) {
    const targetPath = '/api/v0/chat/completion';
    const pow = await this.powHeader(token, targetPath, cookie);
    const sid = sessionId || (await this.createSession(token, cookie));

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
        headers: { ...baseHeaders(token), ...(cookie ? { cookie } : {}), 'x-ds-pow-response': pow },
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
