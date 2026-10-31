// OpenAI-compatible gateway in front of chat.deepseek.com (browser-backed).
import http from 'node:http';
import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { DeepSeekHttp } from './engine-http.mjs';
import { createStreamParser } from './stream-parser.mjs';
import { loadConfig, STATE_DIR } from './config.mjs';
import * as accountStore from './accounts.mjs';

const USAGE_FILE = path.join(STATE_DIR, 'usage.json');
function readUsage() {
  try {
    return JSON.parse(fs.readFileSync(USAGE_FILE, 'utf8'));
  } catch {
    return { total: { prompt: 0, completion: 0, cached: 0, turns: 0 }, conversations: {} };
  }
}
function addUsage(convKey, prompt, completion, cached) {
  const doc = readUsage();
  doc.total.prompt += prompt;
  doc.total.completion += completion;
  doc.total.cached += cached;
  doc.total.turns += 1;
  const conv = (doc.conversations[convKey] = doc.conversations[convKey] || { prompt: 0, completion: 0, cached: 0, turns: 0, updatedAt: 0 });
  conv.prompt += prompt;
  conv.completion += completion;
  conv.cached += cached;
  conv.turns += 1;
  conv.updatedAt = Date.now();
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.writeFileSync(USAGE_FILE, JSON.stringify(doc, null, 2), { mode: 0o600 });
  } catch {}
  return doc;
}

const HOST = '127.0.0.1';
const PORT = Number(process.env.DEEPSEEK_BRIDGE_PORT || 18081);
const LOG_FILE = process.env.DEEPSEEK_BRIDGE_LOG || '/tmp/deepseek-bridge.log';

const log = (...a) => {
  const line = new Date().toISOString() + ' ' + a.join(' ');
  console.log(line);
};

const browser = new DeepSeekHttp(log);

// 模型：网页版只有「深度思考」这个开关，对应 chat / reasoner
const MODELS = [
  { id: 'deepseek-chat', name: 'DeepSeek-V3(web)', thinking: false },
  { id: 'deepseek-reasoner', name: 'DeepSeek-R1(web)', thinking: true },
];
const modelFor = (id) => MODELS.find((m) => m.id === id) || MODELS[0];

// ---------------------------------------------------------------- translation

// 网页版上下文 128K tokens：给回复留 ~32K，其余留给上下文。
// 注意：工具说明（DSH 有 60+ 个工具）必须完整保留，否则模型不会调用工具。
const MAX_PROMPT_TOKENS = Number(process.env.DSW_MAX_PROMPT_TOKENS || 96000);
const MAX_PROMPT_CHARS = Number(process.env.DSW_MAX_PROMPT_CHARS || 260000);

function sanitizePrompt(text) {
  return String(text || '')
    .replace(/<acp[^>]*>[\s\S]*?<\/acp>/g, '')
    .replace(/<acp[^>]*\/>/g, '')
    .replace(/^\[model changed:[^\]]*\]\s*$/gm, '')
    // 不要把本机网关/DSH 的地址带进对话里（用户明确要求：消息里不要出现地址）
    .replace(/https?:\/\/(?:127\.0\.0\.1|localhost)[^\s)]*/gi, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function contentToText(content) {
  if (Array.isArray(content)) return content.map((c) => (typeof c === 'string' ? c : c?.text ?? '')).filter(Boolean).join('\n');
  if (content && typeof content === 'object') return content.text ?? '';
  return '';
}

// 新会话首条消息：不用任何 "API 中转" 痕迹的字样（[Instruction]/[API request]/[User] 等），
// 而是写成「一个人把设定和问题贴给 DeepSeek」的自然格式，避免被判定成反代而封号。
const LEAD_INS = [
  '按下面的设定回答我的问题。',
  '先看这些背景，再回答我最后的问题。',
  '这是我的工作设定，照它来答。',
];

// 历史里可能残留上一版桥接器漏出来的工具标记（DSML / @@TOOL@@），
// 官方 API 的上下文里不会有这种东西，发回网页前统一清掉。
function cleanHistoryText(t) {
  if (!t) return t;
  let out = t;
  const before = out.length;
  out = out.replace(/@@TOOL@@[\s\S]*?@@END@@/g, ' ');
  out = out.replace(/<\s*[|｜][\s\S]{0,40}?>/g, ' ');
  out = out.replace(/[|｜]{2}\s*DSML\s*[|｜]{2}[^\s>]*/gi, ' ');
  out = out.replace(/<\s*\/?\s*(?:calls|invoke|parameter)\b[^>]*>/gi, ' ');
  out = out.replace(/[ \t]{2,}/g, ' ');
  out = out.replace(/\n{3,}/g, '\n\n').trim();
  if (out.length !== before) log('[clean] history text -' + (before - out.length) + ' chars');
  return out;
}

/** 参数串在提示词里保持可读：把 \n、\" 这类 JSON 转义还原成真实字符，避免模型模仿转义写法。 */
function readableArgs(text) {
  return String(text || '')
    .replace(/\\r\\n/g, ' ')
    .replace(/\\n/g, ' ')
    .replace(/\\t/g, ' ')
    .replace(/\\"/g, '"')
    .replace(/\\{2}/g, '\\')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 把 assistant 消息里的 tool_calls 变成一行可读文本，供历史/续聊提示使用。 */
function describeToolCalls(m) {
  if (!m || !Array.isArray(m.tool_calls) || !m.tool_calls.length) return '';
  return m.tool_calls
    .map((tc) => {
      const f = tc.function || {};
      let args = f.arguments;
      if (typeof args === 'string') {
        try { args = JSON.parse(args); } catch {}
      }
      const shown = typeof args === 'string' ? args : JSON.stringify(args || {});
      return '（我调用了工具 ' + (f.name || '?') + '，参数 ' + readableArgs(shown).slice(0, 300) + '）';
    })
    .join('\n');
}

function buildNewChatPrompt(messages, tools) {
  const pick = (v) => sanitizePrompt(cleanHistoryText(typeof v === 'string' ? v : contentToText(v)));
  const list = (messages || []).filter((m) => m && m.role);
  const sys = list
    .filter((m) => m.role === 'system' || m.role === 'developer')
    .map((m) => pick(m.content))
    .filter(Boolean)
    .join('\n\n');
  const callNames = new Map();
  for (const m of list) {
    if (Array.isArray(m.tool_calls)) {
      for (const tc of m.tool_calls) if (tc && tc.id) callNames.set(tc.id, tc.function?.name || '工具');
    }
  }
  const convo = list
    .filter((m) => m.role === 'user' || m.role === 'assistant' || m.role === 'tool')
    .map((m) => {
      let text = pick(m.content);
      if (m.role === 'assistant') text = [describeToolCalls(m), text].filter(Boolean).join('\n');
      if (m.role === 'tool' && m.tool_call_id && callNames.has(m.tool_call_id)) {
        text = '（' + callNames.get(m.tool_call_id) + ' 的返回结果）\n' + text;
      }
      return { role: m.role, text };
    })
    .filter((m) => m.text);

  const lastUser = [...convo].reverse().find((m) => m.role === 'user');
  if (!lastUser) return sys || '';
  // 关键：最后一条 user 之后的 assistant/tool 消息（工具调用与工具结果）必须跟在后面一起发，
  // 否则模型看不到工具结果，会重复调用同一个工具。
  const lastIdx = convo.lastIndexOf(lastUser);
  const tail = lastUser.text;
  const after = convo.slice(lastIdx + 1);
  const prior = convo.slice(0, lastIdx);
  const lead = LEAD_INS[Math.floor(Math.random() * LEAD_INS.length)];

  const lastIsToolResult = after.length > 0 && after[after.length - 1].role === 'tool';
  const toolResultHint = lastIsToolResult
    ? '（末尾是工具的真实返回结果。够回答就直接给最终答案，不要重复调用同一个工具；确实还需要别的工具时才继续调用。）'
    : '';

  const relabel = (slice) =>
    slice
      .map((m) => (m.role === 'user' ? '我：' : m.role === 'tool' ? '（工具结果）' : '你：') + m.text)
      .join('\n\n');

  /** 组装完整 prompt：系统设定 + 工具说明 + 历史 + 最后一条用户消息。 */
  const compose = (priorSlice, note, toolDoc) => {
    const parts = [];
    if (sys) parts.push(sys);
    if (toolDoc) parts.push(toolDoc.trim());
    if (note) parts.push(note);
    if (priorSlice.length) parts.push('（接着之前聊的内容继续，前面大概是：）\n' + relabel(priorSlice));
    if (toolResultHint) parts.push(toolResultHint);
    const head = parts.length ? lead + '\n\n' + parts.join('\n\n') + '\n\n' : '';
    let outTail = tail;
    for (const m of after) {
      if (m.role === 'tool') outTail += '\n\n工具执行完了，结果如下：\n' + m.text;
      else if (m.role === 'assistant') outTail += '\n\n' + m.text;
      else outTail += '\n\n我：' + m.text;
    }
    return head + outTail;
  };

  // 1) 先按完整工具说明试；2) 仍超预算就压工具说明；3) 再超才丢最旧的历史。
  // 关键：工具说明和系统设定永远保留 —— 丢了它们模型就用不了工具、也看不懂提问格式。
  let toolDoc = renderTools(tools, 'full');
  let slice = prior;
  let note = '';
  let out = compose(slice, note, toolDoc);
  if (estimateTokens(out) > MAX_PROMPT_TOKENS) {
    toolDoc = renderTools(tools, 'compact');
    out = compose(slice, note, toolDoc);
  }
  let dropped = 0;
  while (estimateTokens(out) > MAX_PROMPT_TOKENS && slice.length > 0) {
    const drop = Math.max(1, Math.ceil(slice.length * 0.3));
    slice = slice.slice(drop);
    dropped += drop;
    note = '（更早的对话太长，已省略 ' + dropped + ' 条历史消息）';
    out = compose(slice, note, toolDoc);
  }
  if (estimateTokens(out) > MAX_PROMPT_TOKENS) {
    toolDoc = renderTools(tools, 'names');
    out = compose(slice, note, toolDoc);
  }
  if (dropped) log('[prompt] dropped ' + dropped + ' old message(s) to fit tool docs');
  log('[prompt] size=' + out.length + ' chars ~' + estimateTokens(out) + ' tok sys=' + sys.length + ' tools=' + toolDoc.length + ' history=' + slice.length);
  return out;
}

// ------------------------------------------------------------------ tool use
// 网页模型没有原生 function calling，这里用「纯文本工具协议」：
// 让模型把工具调用写成 <<<TOOL>>> {json} <<<END>>> 块，桥接器再翻译成 OpenAI 的 tool_calls。
const TOOL_OPEN = '@@TOOL@@';
const TOOL_CLOSE = '@@END@@';

function renderTools(tools, mode = 'full') {
  if (!Array.isArray(tools) || !tools.length) return '';
  // full 给足细节（工具描述里有使用规则时不能截太狠）；预算不够时自动降级到 compact/names
  const perDesc = mode === 'full' ? 600 : 200;
  const perParams = mode === 'full' ? 2400 : mode === 'compact' ? 500 : 0;
  const lines = [];
  for (const t of tools) {
    const f = t.function || t;
    if (!f?.name) continue;
    const desc = String(f.description || '').replace(/\s+/g, ' ').slice(0, perDesc);
    let params = '';
    if (perParams > 0 && f.parameters) {
      let raw = '';
      try { raw = JSON.stringify(f.parameters); } catch { raw = ''; }
      if (raw.length > perParams) {
        // 参数结构太大：退化成「属性名 + 必填」列表，模型仍能拼出合法参数
        const props = f.parameters.properties && typeof f.parameters.properties === 'object' ? Object.keys(f.parameters.properties) : [];
        const required = Array.isArray(f.parameters.required) ? f.parameters.required : [];
        params = '｜参数 ' + props.map((k) => k + (required.includes(k) ? '*' : '')).join(', ');
      } else {
        params = '｜参数 ' + raw;
      }
    } else if (mode === 'names' && f.parameters && f.parameters.properties) {
      const props = Object.keys(f.parameters.properties);
      params = '｜参数 ' + props.join(', ');
    }
    const req = Array.isArray(f?.parameters?.required) ? f.parameters.required : [];
    const reqLine = req.length ? '｜必填：' + req.join(', ') : '';
    lines.push('- ' + f.name + '：' + desc + reqLine + params);
  }
  if (!lines.length) return '';
  const hint =
    mode === 'names'
      ? '\n\n【可用工具】以下工具可以调用，参数用常规 JSON：\n'
      : '\n\n【可用工具】需要读写文件、执行命令、搜索、提问确认时，必须真的调用工具，而不是在正文里描述。\n' +
        '规则：整条回复只输出下面这一个块，块外不要写任何文字；块内是合法 JSON；一次只调一个。\n' +
        TOOL_OPEN + '\n{"name":"工具名","arguments":{"参数名":"值"}}\n' + TOOL_CLOSE + '\n' +
        '工具执行完我会把结果贴回给你（以「工具执行完了」开头），你据此继续。不需要工具时正常回答。\n' +
        '需要用户做选择/补充信息时，调用提问类工具（如 ask_user_question），不要只在正文里问。\n' +
        '正文请使用真实换行和普通 Markdown，不要输出 JSON 转义写法（例如不要在正文里写 \\n）。\n' +
        '工具参数里的长文本要分块：单次写入控制在 2000 字左右，不要一次传入超长内容（会被上游截断）。\n' +
        '参数必须写全每个「必填」字段（例如 bash 需要 command 与 description），缺参数会被工具层直接拒绝。\n';
  return hint + lines.join('\n');
}

// 把模型输出里的工具块切出来；返回 { text, calls }
function extractToolCalls(text) {
  const calls = [];
  let out = '';
  let rest = text;
  for (;;) {
    const i = rest.indexOf(TOOL_OPEN);
    if (i < 0) { out += rest; break; }
    out += rest.slice(0, i);
    const j = rest.indexOf(TOOL_CLOSE, i + TOOL_OPEN.length);
    if (j < 0) { out += rest.slice(i); break; }
    const body = rest.slice(i + TOOL_OPEN.length, j).trim();
    rest = rest.slice(j + TOOL_CLOSE.length);
    const parsed = parseToolJson(body);
    if (parsed) calls.push(parsed);
    else out += body;
  }
  return { text: stripSentinels(out), calls };
}

function parseToolJson(body) {
  if (!body) return null;
  const cleaned = body.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  try {
    const obj = JSON.parse(cleaned);
    const name = obj.name || obj.tool || obj.function?.name;
    let args = obj.arguments ?? obj.args ?? obj.parameters ?? obj.function?.arguments ?? {};
    if (typeof args === 'string') { try { args = JSON.parse(args); } catch {} }
    if (!name) return null;
    return { name: String(name), arguments: typeof args === 'string' ? args : JSON.stringify(args ?? {}) };
  } catch {
    return null;
  }
}

// DeepSeek 网页模型有时会吐原生 DSML 标记（<|DSML|...>），直接抹掉，别让它们出现在正文里

// 兜底：模型可能绕过自定义协议，直接吐 DeepSeek 原生的 DSML 工具标记
function parseDsmlToolCalls(raw) {
  if (!raw) return null;
  const nm = /invoke\s+name\s*=\s*["']?([A-Za-z0-9_.\-]+)/i.exec(raw);
  if (!nm) return null;
  const args = {};
  const re = /parameter\s+name\s*=\s*["']?([A-Za-z0-9_.\-]+)[^>]*>([\s\S]*?)(?:<\s*\/?[^>]*parameter\s*>|$)/gi;
  let m;
  while ((m = re.exec(raw))) {
    const val = m[2].replace(/<[^>]*>/g, '').trim();
    args[m[1]] = val;
  }
  return { name: nm[1], arguments: JSON.stringify(args) };
}

function stripSentinels(t) {
  if (!t) return t;
  return t
    .replace(/<[|｜]+\s*DSML\s*[|｜][^>]*>/gi, '')
    .replace(/<[|｜]+\s*\/\s*DSML\s*[|｜][^>]*>/gi, '')
    .replace(/[|｜]{2}DSML[|｜]{2}[^\s>]*/gi, '')
    .replace(/<\s*calls>/gi, '')
    .replace(/<\s*invoke\b[^>]*>/gi, '')
    .replace(/<\s*\/\s*invoke>/gi, '')
    .replace(/<\s*parameter\b[^>]*>/gi, '')
    .replace(/<\s*\/\s*parameter>/gi, '');
}

function normText(t) {
  return String(t || '').replace(/\s+/g, ' ').trim();
}

function estimateTokens(text) {
  if (!text) return 0;
  let cjk = 0;
  for (const ch of text) if (/[\u4e00-\u9fff\u3040-\u30ff]/.test(ch)) cjk++;
  return Math.ceil(cjk * 0.7 + (text.length - cjk) / 3.6);
}

// ------------------------------------------------------------- conversation map

const CHAT_MAP_FILE = process.env.BRIDGE_STATE_DIR
  ? path.join(process.env.BRIDGE_STATE_DIR, 'deepseek-chat-map.json')
  : path.join(STATE_DIR, 'chat-map.json');
let chatMap = {};
try { chatMap = JSON.parse(fs.readFileSync(CHAT_MAP_FILE, 'utf8')); } catch { chatMap = {}; }
function saveChatMap() {
  try { fs.writeFileSync(CHAT_MAP_FILE, JSON.stringify(chatMap)); } catch {}
}
function conversationKey(messages) {
  const first = messages.find((m) => m.role === 'user');
  const seed = first ? String(first.content).slice(0, 4000) : JSON.stringify(messages.slice(0, 2));
  return crypto.createHash('sha1').update(seed).digest('hex');
}

// ---------------------------------------------------------------------- server

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${HOST}:${PORT}`);
  try {
    if (req.method === 'GET' && url.pathname === '/health') {
      if (url.searchParams.get('deep') !== '1') {
        return json(res, 200, {
          ok: true,
          busy: browser.pending > 0,
          queued: browser.pending,
          uptime: Math.round(process.uptime()),
          engine: 'http',
          accounts: accountStore.listAccounts(),
        });
      }
      const st = await browser.exclusive(() => browser.state());
      return json(res, 200, { ok: true, loggedIn: !!st.loggedIn, engine: 'http', accounts: accountStore.listAccounts(), detail: st });
    }
    if (req.method === 'GET' && url.pathname === '/admin/state') {
      return json(res, 200, await browser.exclusive(() => browser.state()));
    }
    if (req.method === 'GET' && url.pathname === '/admin/screenshot') {
      return json(res, 501, { error: { message: 'HTTP 引擎没有浏览器截图', type: 'not_implemented' } });
    }
    if (req.method === 'GET' && url.pathname === '/admin/usage') {
      return json(res, 200, readUsage());
    }
    if (req.method === 'GET' && url.pathname === '/admin/sessions') {
      return json(res, 200, await browser.exclusive(() => browser.listSessions()));
    }
    if (req.method === 'POST' && url.pathname === '/admin/sessions/purge') {
      return json(res, 200, await browser.exclusive(() => browser.purgeTraceSessions()));
    }
    if (req.method === 'GET' && url.pathname === '/v1/models') {
      return json(res, 200, {
        object: 'list',
        data: MODELS.map((m) => ({ id: m.id, object: 'model', created: 1700000000, owned_by: 'deepseek-web' })),
      });
    }
    if (req.method === 'POST' && (url.pathname === '/v1/chat/completions' || url.pathname === '/chat/completions')) {
      return await handleChat(req, res);
    }
    json(res, 404, { error: { message: 'not found', type: 'invalid_request_error' } });
  } catch (e) {
    log('request error:', e.stack || e.message);
    if (!res.headersSent) json(res, 500, { error: { message: String(e.message || e), type: 'server_error' } });
    else res.end();
  }
});

async function handleChat(req, res) {
  const body = await readJson(req);
  const rawModel = String(body.model || 'deepseek-chat');
  // 支持 `deepseek-chat@账号标签` 指定账号；不写则由账号池轮询
  const [modelId, accountLabel] = rawModel.split('@');
  const model = modelFor(modelId);
  const stream = body.stream !== false;
  const messages = body.messages || [];
  const tools = body.tools || [];

  let convKey = conversationKey(messages);
  let prev = chatMap[convKey];

  // ---- 上下文同步：像官方 API 一样，保证网页会话拿到的历史与 messages[] 完全一致 ----
  // transcript = 去掉 system 后的逻辑历史（system 每轮含时间会变，不参与指纹）
  const transcript = [];
  for (const m of messages) {
    if (!m || (m.role !== 'user' && m.role !== 'assistant' && m.role !== 'tool')) continue;
    const text = cleanHistoryText(typeof m.content === 'string' ? m.content : contentToText(m.content));
    const calls = describeToolCalls(m);
    const line = [calls, text].filter(Boolean).join('\n');
    if (line) transcript.push({ role: m.role, text: line });
  }
  const digest = crypto.createHash('sha1').update(JSON.stringify(transcript)).digest('hex');

  const lastUser = [...messages].reverse().find((m) => m.role === 'user');
  const toolDoc = renderTools(tools);

  // 网页会话「一条对话用到底」：只要这段 DSH 对话有一轮跑过，后面就一直复用同一个网页会话。
  // 历史被 DSH 压缩/编辑导致首条消息变了时，用上一轮回复的指纹把会话找回来。
  if (!prev) {
    for (const [k, v] of Object.entries(chatMap)) {
      if (!v || !v.sessionId || !v.replyDigest) continue;
      const known = new Set([v.replyDigest, ...(Array.isArray(v.recentReplies) ? v.recentReplies : [])].filter(Boolean));
      const hit = transcript.some(
        (m) => m.role === 'assistant' && known.has(crypto.createHash('sha1').update(normText(m.text)).digest('hex')),
      );
      if (hit) {
        prev = v;
        convKey = k;
        log('[ctx] adopted existing web session by reply digest');
        break;
      }
    }
  }

  let continuing = Boolean(prev?.sessionId);
  let reason = continuing ? 'continuation' : 'new';
  let from = Number(prev?.msgCount || 0);
  if (continuing) {
    const known = from;
    const prefixOk =
      known > 0 &&
      known <= transcript.length &&
      prev.digestPrefix === crypto.createHash('sha1').update(JSON.stringify(transcript.slice(0, known))).digest('hex');
    if (!prefixOk || transcript.length <= known) {
      // 历史对不上（被压缩/编辑/重试同一轮）：不新开会话，继续用这一个，把最近几条重述一遍。
      from = Math.max(0, transcript.length - 8);
      reason = 'continuation+resync';
      log('[ctx] history moved (known=' + known + ' now=' + transcript.length + ') → keep the same web session, resend last few');
    }
  }

  let prompt;
  if (continuing) {
    // 只发网页会话里还没有的部分；assistant 是模型自己的输出，不必复述
    const tail = transcript.slice(from).filter((m) => m.role !== 'assistant');
    const lastTool = [...tail].reverse().find((m) => m.role === 'tool');
    const parts = [];
    if (tail.length > 1) parts.push('（接着上面继续，期间还有这些内容）');
    for (const m of tail) {
      if (m.role === 'tool') parts.push('工具执行完了，结果如下（接着上面的活儿干，别重复调用同一个工具；够回答就直接给结论）：\n' + m.text);
      else parts.push(m.text);
    }
    if (!parts.length) {
      const fb = lastUser ? cleanHistoryText(typeof lastUser.content === 'string' ? lastUser.content : contentToText(lastUser.content)) : '';
      parts.push(fb);
    }
    reason = lastTool ? reason + '+tool' : reason;
    let body = parts.join('\n\n');
    // 续聊也要守住 token 预算，但工具说明必须完整带上（否则模型这一轮不会调用工具）
    let doc = toolDoc || '';
    let budget = MAX_PROMPT_TOKENS - estimateTokens(doc) - 1200;
    if (estimateTokens(body) > budget) {
      doc = renderTools(tools, 'compact');
      budget = MAX_PROMPT_TOKENS - estimateTokens(doc) - 1200;
    }
    if (estimateTokens(body) > budget) {
      const before = estimateTokens(body);
      while (estimateTokens(body) > budget && body.length > 4000) {
        body = body.slice(Math.max(2000, Math.ceil(body.length * 0.3)));
      }
      log('[prompt] continuation trimmed ~' + before + ' → ~' + estimateTokens(body) + ' tok');
    }
    prompt = body + doc;
  } else {
    prompt = buildNewChatPrompt(messages, tools);
  }
  log('[ctx] conv=' + convKey.slice(0, 8) + ' mode=' + reason + ' sent=' + transcript.length + ' prompt=' + prompt.length + ' session=' + (continuing ? String(prev.sessionId).slice(0, 8) : 'new'));
  if (prompt.length > MAX_PROMPT_CHARS) log('[prompt] WARNING oversize ' + prompt.length);
  if (process.env.DSW_DUMP_PROMPT) {
    try { fs.writeFileSync(process.env.DSW_DUMP_PROMPT, prompt); } catch (e) { log('[prompt] dump failed: ' + e.message); }
  }

  const id = 'chatcmpl-' + Math.random().toString(36).slice(2, 12);
  const created = Math.floor(Date.now() / 1000);
  let textOut = '';
  let reasoningOut = '';
  let headersSent = false;
  const calls = [];

  const sendChunk = (delta, finish = null) => {
    if (!stream) return;
    if (!headersSent) {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      headersSent = true;
    }
    res.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model: modelId, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`);
  };

  let rawText = '';
  // 网页模型偶尔整段输出 JSON 转义（正文里写 \n），这里做保守还原：
  // 仅当这段文字几乎没有真实换行、却有多个 \n 时才转换，否则原样保留。
  let heldBackslash = '';
  const normalizeDelta = (t) => {
    let out = heldBackslash + t;
    heldBackslash = '';
    if (out.endsWith('\\')) {
      heldBackslash = '\\';
      out = out.slice(0, -1);
    }
    const esc = (out.match(/\\n/g) || []).length;
    const real = (out.match(/\n/g) || []).length;
    if (esc >= 3 && esc > real * 3) {
      out = out.replace(/\\r\\n/g, '\n').replace(/\\n/g, '\n').replace(/\\t/g, ' ').replace(/\\"/g, '"');
    }
    return out;
  };
  const emitText = (t) => {
    if (!t) return;
    const clean = stripSentinels(normalizeDelta(t));
    if (!clean) return;
    textOut += clean;
    if (!stream) return;
    if (!headersSent) sendChunk({ role: 'assistant', content: '' });
    sendChunk({ content: clean });
  };

  // 正文过滤器：@@TOOL@@ 自定义块 与 DeepSeek 原生 DSML 标记 都从正文里摘掉。
  // DSML 按「整块吞掉」处理，块内容只拿去解析成 tool_calls —— 官方 API 不会把这种标记吐给客户端。
  let buf = '';
  let mode = 'text'; // text | tool | dsml
  let dsmlBuf = '';
  const HOLD = 24;
  const DSML_START = /<\s*[|｜]\s*[|｜]?\s*(?:DSML|\/\s*DSML)/i;
  const DSML_END = /<\s*\/\s*[|｜][^>]*calls\s*>/i;

  const pump = () => {
    for (;;) {
      if (mode === 'text') {
        const iTool = buf.indexOf(TOOL_OPEN);
        const mDsml = DSML_START.exec(buf);
        const iDsml = mDsml ? mDsml.index : -1;
        let i = -1;
        let kind = null;
        if (iTool >= 0 && (iDsml < 0 || iTool < iDsml)) { i = iTool; kind = 'tool'; }
        else if (iDsml >= 0) { i = iDsml; kind = 'dsml'; }
        if (i >= 0) {
          if (i > 0) emitText(buf.slice(0, i));
          if (kind === 'tool') { buf = buf.slice(i + TOOL_OPEN.length); mode = 'tool'; }
          else { buf = buf.slice(i); mode = 'dsml'; dsmlBuf = ''; }
          continue;
        }
        if (buf.length > HOLD) {
          const cut = buf.length - HOLD;
          emitText(buf.slice(0, cut));
          buf = buf.slice(cut);
        }
        return;
      }
      if (mode === 'tool') {
        const j = buf.indexOf(TOOL_CLOSE);
        if (j < 0) return;
        const bodyText = buf.slice(0, j);
        buf = buf.slice(j + TOOL_CLOSE.length);
        mode = 'text';
        const parsed = parseToolJson(bodyText);
        if (parsed) calls.push(parsed);
        else emitText(bodyText);
        continue;
      }
      // dsml：整块吞掉
      const mEnd = DSML_END.exec(buf);
      if (!mEnd) { dsmlBuf += buf; buf = ''; return; }
      const endIdx = mEnd.index + mEnd[0].length;
      dsmlBuf += buf.slice(0, endIdx);
      buf = buf.slice(endIdx);
      mode = 'text';
      rawText += dsmlBuf;
      const c = parseDsmlToolCalls(dsmlBuf);
      if (c) calls.push(c);
      else log('[chat] dsml block without tool call, dropped');
      dsmlBuf = '';
      continue;
    }
  };
  const endTools = () => {
    if (mode === 'tool') {
      // 工具块没等到 @@END@@（多数是参数太长被上游截断）。此时绝不能把原始 JSON 当正文吐出去，
      // 否则用户会看到满屏的 \n 转义。能解析就收下，解析不了就给一句简短说明。
      const parsed = parseToolJson(buf);
      buf = '';
      mode = 'text';
      if (parsed) {
        calls.push(parsed);
        log('[tool] recovered unclosed tool block: ' + parsed.name);
      } else {
        log('[tool] dropped unclosed tool block');
        emitText('\n\n（本轮工具调用内容过长被截断，已忽略；请拆成更小的步骤后重试。）');
      }
      return;
    }
    if (mode === 'dsml') {
      dsmlBuf += buf;
      buf = '';
      rawText += dsmlBuf;
      const c = parseDsmlToolCalls(dsmlBuf);
      if (c) calls.push(c);
      else log('[chat] trailing dsml block without tool call, dropped');
      dsmlBuf = '';
      mode = 'text';
      return;
    }
    if (buf) { emitText(buf); buf = ''; }
    if (heldBackslash) { emitText(heldBackslash); heldBackslash = ''; }
  };

  try {
    const t0 = Date.now();
    log('[chat] send model=' + modelId + ' msgs=' + messages.length + ' tools=' + tools.length + ' conv=' + convKey.slice(0, 8) + ' session=' + (prev?.sessionId ? prev.sessionId.slice(0, 8) : 'new') + ' thinking=' + model.thinking);
    const parser = createStreamParser((d) => {
      if (d.text) flushToolsFrom(d.text);
      else if (d.reasoning) {
        reasoningOut += d.reasoning;
        if (stream) {
          if (!headersSent) sendChunk({ role: 'assistant', content: '' });
          sendChunk({ reasoning_content: d.reasoning });
        }
      }
    });
    function flushToolsFrom(t) { buf += t; pump(); }

    // 上游偶尔会「200 但正文和工具调用都是空」——DSH 把它当成 EMPTY_RESPONSE，
    // 整轮直接失败。这里等 10 秒换新会话重试，最多 3 次。
    let out = null;
    const MAX_ATTEMPTS = 3;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const useSession = attempt === 1 ? (prev?.sessionId || null) : null;
      const useParent = attempt === 1 ? (prev?.parentId || null) : null;
      out = await browser.exclusive(() =>
        withTimeout(
          browser.chat({
            prompt,
            thinking: model.thinking,
            sessionId: useSession,
            parentId: useParent,
            preferAccount: accountLabel || null,
            onDelta: (block) => parser.feed(block),
            idleMs: 180000,
          }),
          300000,
          'chat',
        ),
      );
      endTools();
      if (textOut || calls.length) break;
      log('[chat] empty reply (attempt ' + attempt + '/' + MAX_ATTEMPTS + ')');
      if (attempt < MAX_ATTEMPTS) {
        log('[chat] waiting 10s, then retrying as a new chat');
        await new Promise((r) => setTimeout(r, 10000));
        delete chatMap[convKey];
        saveChatMap();
        prompt = buildNewChatPrompt(messages, tools);
        buf = ''; mode = 'text'; dsmlBuf = ''; textOut = ''; reasoningOut = '';
      }
    }


    const replyDigest = crypto.createHash('sha1').update(normText(textOut)).digest('hex');
    const recent = [replyDigest, ...(Array.isArray(prev?.recentReplies) ? prev.recentReplies : prev?.replyDigest ? [prev.replyDigest] : [])];
    const next = {
      sessionId: out.sessionId || prev?.sessionId,
      parentId: parser.responseMessageId() ?? prev?.parentId ?? null,
      msgCount: transcript.length,
      digestPrefix: digest,
      replyDigest,
      // 历史被压缩后首条消息会变，靠「最近几轮回复的指纹」把这段对话认回来
      recentReplies: Array.from(new Set(recent)).slice(0, 12),
    };
    if (next.sessionId) { chatMap[convKey] = next; saveChatMap(); }
    log('[chat] done in ' + (Date.now() - t0) + 'ms chars=' + textOut.length + ' reasoning=' + reasoningOut.length + ' calls=' + calls.length + ' msgId=' + next.parentId);
  } catch (e) {
    log('[chat] error: ' + (e.message || e));
    if (!headersSent) return json(res, 502, { error: { message: String(e.message || e), type: 'upstream_error' } });
  }

  // 兜底：有些情况下工具块是最后才完整出现的
  if (!calls.length) {
    const dsml = parseDsmlToolCalls(rawText);
    if (dsml) {
      log('[chat] recovered tool call from DSML markup: ' + dsml.name);
      calls.push(dsml);
    }
  }
  if (!calls.length && textOut.includes(TOOL_OPEN)) {
    const { text, calls: late } = extractToolCalls(textOut);
    textOut = text;
    calls.push(...late);
  }


  // usage 要按「这次请求真实喂进去的上下文」算，否则 GUI 的上下文仪表会显示成 0%
  const contextParts = [];
  for (const m of messages) {
    if (!m || !m.role) continue;
    const t = typeof m.content === 'string' ? m.content : contentToText(m.content);
    const callsText = Array.isArray(m.tool_calls) ? JSON.stringify(m.tool_calls) : '';
    contextParts.push(m.role + ': ' + (t || '') + (callsText ? ' ' + callsText : ''));
  }
  if (tools.length) contextParts.push('tools: ' + JSON.stringify(tools));

  const promptTokens = estimateTokens(contextParts.join('\n'));
  const completionTokens = estimateTokens(textOut + reasoningOut);
  // 网页接口不返回 usage / 缓存字段，这里做保守估算：
  // 续聊且历史前缀没变时，上一轮已经发过的部分视为「缓存命中」，与官方 API 的语义对齐。
  const prevPromptTokens = Number(prev?.promptTokens || 0);
  if (chatMap[convKey]) { chatMap[convKey].promptTokens = promptTokens; saveChatMap(); }
  const reused = continuing && prevPromptTokens > 0 ? Math.min(prevPromptTokens, promptTokens) : 0;
  const cachedTokens = Math.max(0, Math.min(reused, promptTokens));
  const usagePayload = {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: promptTokens + completionTokens,
    prompt_tokens_details: { cached_tokens: cachedTokens },
    prompt_cache_hit_tokens: cachedTokens,
    prompt_cache_miss_tokens: Math.max(0, promptTokens - cachedTokens),
  };
  try { addUsage(convKey.slice(0, 12), promptTokens, completionTokens, cachedTokens); } catch {}
  // 去重：模型有时会同时吐 DSML 和 @@TOOL@@ 两种格式，会得到完全相同的两个调用
  const seenCalls = new Set();
  const uniqCalls = calls.filter((c) => {
    const k = c.name + '\u0000' + c.arguments;
    if (seenCalls.has(k)) return false;
    seenCalls.add(k);
    return true;
  });
  if (uniqCalls.length !== calls.length) log('[chat] dropped ' + (calls.length - uniqCalls.length) + ' duplicate tool call(s)');

  // 参数校验：DSH 的工具会拒收缺少必填参数的调用，模型收到报错后会反复重试同一个坏调用。
  // 这里先做能做的修补（description 可由 command 推导），修不好就丢掉，并给用户一句说明。
  const schemas = new Map();
  for (const t of tools) {
    const f = t?.function || t;
    if (f?.name) schemas.set(f.name, f.parameters || {});
  }
  const safeCalls = [];
  const droppedCalls = [];
  for (const c of uniqCalls) {
    const r = repairToolArgs(c, schemas);
    if (r.ok) safeCalls.push({ name: c.name, arguments: JSON.stringify(r.args) });
    else {
      droppedCalls.push(c.name + '（' + r.reason + '）');
      log('[tool] invalid call dropped: ' + c.name + ' — ' + r.reason);
    }
  }
  if (droppedCalls.length && !textOut.trim()) {
    textOut = '（这一轮的工具调用参数不完整，已忽略：' + droppedCalls.join('；') + '。请补全参数后重试。）';
    if (stream) {
      if (!headersSent) sendChunk({ role: 'assistant', content: '' });
      sendChunk({ content: textOut });
    }
  }
  const toolCalls = safeCalls.map((c, i) => ({ id: 'call_' + id.slice(8, 18) + i, type: 'function', function: { name: c.name, arguments: c.arguments } }));

  if (stream) {
    if (toolCalls.length) {
      if (!headersSent) sendChunk({ role: 'assistant', content: '' });
      sendChunk({ tool_calls: toolCalls.map((tc, i) => ({ index: i, id: tc.id, type: 'function', function: tc.function })) });
      sendChunk({}, 'tool_calls');
    } else {
      sendChunk({}, 'stop');
    }
    res.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model: modelId, choices: [], usage: usagePayload })}\n\n`);
    res.write('data: [DONE]\n\n');
    return res.end();
  }
  json(res, 200, {
    id,
    object: 'chat.completion',
    created,
    model: modelId,
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: textOut || (toolCalls.length ? null : ''),
          ...(reasoningOut ? { reasoning_content: reasoningOut } : {}),
          ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
        },
        finish_reason: toolCalls.length ? 'tool_calls' : 'stop',
      },
    ],
    usage: usagePayload,
  });
}

// --------------------------------------------------------------------- helpers

/** 按工具 schema 校验/修补参数：缺 description 时用 command 推导，其余缺必填则判为无效。 */
function repairToolArgs(call, schemas) {
  const schema = schemas.get(call.name);
  let args;
  try {
    args = JSON.parse(call.arguments || '{}');
  } catch {
    return { ok: false, reason: '参数不是合法 JSON' };
  }
  if (!args || typeof args !== 'object') return { ok: false, reason: '参数不是对象' };
  if (!schema) return { ok: true, args };
  const required = Array.isArray(schema.required) ? schema.required : [];
  const miss = () => required.filter((k) => args[k] === undefined || args[k] === null || args[k] === '');
  for (const k of miss()) {
    if (k === 'description' && typeof args.command === 'string' && args.command.trim()) {
      args.description = args.command.trim().slice(0, 80);
    }
  }
  const still = miss();
  if (still.length) return { ok: false, reason: '缺少必填参数 ' + still.join(', ') };
  return { ok: true, args };
}

function withTimeout(promise, ms, tag) {
  return Promise.race([promise, new Promise((_, rej) => setTimeout(() => rej(new Error(tag + ' timeout after ' + ms + 'ms')), ms))]);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > 20 * 1024 * 1024) reject(new Error('body too large'));
    });
    req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}

function json(res, status, obj) {
  const buf = Buffer.from(JSON.stringify(obj));
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': buf.length });
  res.end(buf);
}

// 自检：DSW_SELFTEST_PROMPT=<json 文件> 时只构造 prompt 并打印统计，不监听端口。
if (process.env.DSW_SELFTEST_PROMPT) {
  const spec = JSON.parse(fs.readFileSync(process.env.DSW_SELFTEST_PROMPT, 'utf8'));
  if (spec.repair) {
    const schemas = new Map();
    for (const t of spec.tools || []) { const f = t.function || t; if (f?.name) schemas.set(f.name, f.parameters || {}); }
    for (const c of spec.repair) console.log(JSON.stringify(c, null, 0), '→', JSON.stringify(repairToolArgs(c, schemas)));
    process.exit(0);
  }
  const prompt = buildNewChatPrompt(spec.messages || [], spec.tools || []);
  const doc = renderTools(spec.tools || [], 'full');
  console.log(JSON.stringify({
    chars: prompt.length,
    tokens: estimateTokens(prompt),
    toolDocChars: doc.length,
    toolDocInPrompt: prompt.includes(doc.slice(0, 80)),
    tailInPrompt: prompt.includes(String((spec.messages || []).filter((m) => m.role === 'user').pop()?.content || '').slice(0, 60)),
    head: prompt.slice(0, 120),
  }, null, 2));
  process.exit(0);
}

server.listen(PORT, HOST, () => log(`deepseek-web-bridge listening on http://${HOST}:${PORT}`));

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => { log('shutting down'); await browser.close(); process.exit(0); });
}
