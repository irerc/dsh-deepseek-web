// OpenAI-compatible gateway in front of chat.deepseek.com (browser-backed).
import http from 'node:http';
import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { DeepSeekHttp } from './engine-http.mjs';
import { createStreamParser } from './stream-parser.mjs';
import { loadConfig, STATE_DIR } from './config.mjs';
import { currentMode, modeLimits, guardMessage, contractFor, GUARD_MARK } from './request-mode.mjs';
import { convLabelOf } from './conv-label.mjs';
import { estimateTokens, computeUsage } from './usage.mjs';
import { noteCall } from './ledger.mjs';
import * as accountStore from './accounts.mjs';

const USAGE_FILE = path.join(STATE_DIR, 'usage.json');
function readUsage() {
  try {
    return JSON.parse(fs.readFileSync(USAGE_FILE, 'utf8'));
  } catch {
    return { total: { prompt: 0, completion: 0, cached: 0, turns: 0 }, conversations: {} };
  }
}
function addUsage(convKey, prompt, completion, cached, label) {
  const doc = readUsage();
  doc.total.prompt += prompt;
  doc.total.completion += completion;
  doc.total.cached += cached;
  doc.total.turns += 1;
  const conv = (doc.conversations[convKey] = doc.conversations[convKey] || { prompt: 0, completion: 0, cached: 0, turns: 0, updatedAt: 0 });
  if (label) conv.label = String(label).slice(0, 60);
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
const MAX_PROMPT_TOKENS = Number(process.env.DSW_MAX_PROMPT_TOKENS || 118000);
const MAX_PROMPT_CHARS = Number(process.env.DSW_MAX_PROMPT_CHARS || 330000);
// 与 cordis.patch.yml 里声明的 131072 保持一致：上报的 prompt_tokens 不能超过它，
// 否则 pi-ai 会把「成功返回」误判成上下文溢出（见 server/usage.mjs 顶部注释）。
const CONTEXT_WINDOW = Number(process.env.DSW_CONTEXT_WINDOW || 131072);

// ------------------------------------------------------------ 提示词瘦身
// 参考实现 2.3.8/2.3.9 的结论：DSH 每轮把整份技能目录塞进 system-reminder，45 条 ≈ 11k 字符，
// 是首屏提示词里最大的一块。技能目录只是「发现入口」，模型真正加载靠 skill 工具 ——
// 所以只留名字即可（省 90%+），不必逐条发摘要。
//   DSW_WEB_STRIP_SKILLS=names（默认）| off（原样）| all（整块删掉）
const STRIP_SKILLS = String(process.env.DSW_WEB_STRIP_SKILLS || 'names').toLowerCase();
// 工具描述上限：宿主给的单个工具描述能到两千字符（shell 那个把沙箱规则全写进去），
// 逐字照发既费 token 也稀释格式指令。DSW_WEB_COMPACT_TOOLS=0 回到逐字照发。
const COMPACT_TOOLS = process.env.DSW_WEB_COMPACT_TOOLS !== '0';
const TOOL_DESC_CAP = Number(process.env.DSW_WEB_TOOL_DESC_CHARS || 220);

function compressSkillsCatalog(text) {
  if (!text || STRIP_SKILLS === 'off') return text;
  const re = /<available_skills>([\s\S]*?)<\/available_skills>/g;
  if (!re.test(text)) return text;
  re.lastIndex = 0;
  return text.replace(re, (_m, inner) => {
    if (STRIP_SKILLS === 'all') return '';
    const names = [];
    for (const line of String(inner).split('\n')) {
      const m = /^\s*[-*]\s*`([^`]+)`/.exec(line);
      if (m) names.push(m[1].trim());
    }
    if (!names.length) return inner.trim();
    return (
      'Skills (names only — call the `skill` tool with one exact name to load it): ' +
      names.join(', ')
    );
  });
}

function sanitizePrompt(text) {
  return compressSkillsCatalog(String(text || ''))
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

/** API 请求里 assistant 的 tool_calls 原样呈现（名字 + 参数），和官方请求体一致。 */
function describeToolCalls(m) {
  if (!m || !Array.isArray(m.tool_calls) || !m.tool_calls.length) return '';
  return JSON.stringify(
    m.tool_calls.map((tc) => {
      const f = tc.function || {};
      let args = f.arguments ?? tc.arguments ?? {};
      if (typeof args === 'string') {
        try { args = JSON.parse(args); } catch {}
      }
      return { name: f.name || tc.name, arguments: args };
    }),
  );
}

// 要求模型「按 API 的 assistant 消息格式」回复，桥接器再翻译成 OpenAI 的响应体。
// 万一 JSON 回复在某类账号上不稳，可以用 DSW_REPLY_FORMAT=text 切回「正文 + @@TOOL@@ 标记」协议
const REPLY_JSON = process.env.DSW_REPLY_FORMAT !== 'text';
/** 把 messages[] 渲染成 API 请求体的样子（role / tool_calls / tool_call_id 都保留）。 */
function renderApiMessages(list, pick) {
  const out = [];
  const names = new Map();
  for (const m of list) {
    if (Array.isArray(m.tool_calls)) for (const tc of m.tool_calls) if (tc?.id) names.set(tc.id, tc.function?.name || '工具');
  }
  for (const m of list) {
    if (!m || !m.role) continue;
    let head = '[' + m.role + ']';
    if (m.role === 'tool' && m.tool_call_id) head += ' tool_call_id=' + m.tool_call_id + (names.has(m.tool_call_id) ? ' (=' + names.get(m.tool_call_id) + ')' : '');
    out.push(head);
    const calls = describeToolCalls(m);
    if (calls) out.push('tool_calls: ' + calls);
    const text = pick(m.content);
    if (text) out.push(text);
  }
  return out.join('\n');
}

/**
 * 组装发给网页模型的「API 请求」：
 *   system 设定 + messages[]（API 形状）+ 工具清单 + 回复格式要求。
 * opts.resume 表示只发新增消息（网页会话里已有更早的内容）。
 */
function buildApiPrompt(list, tools, opts = {}) {
  // 提示词形态由「请求模式」决定：raw 原样，safe 在前面插一段使用规范、工具描述更短
  const reqMode = opts.mode || currentMode();
  const lim = modeLimits(reqMode);
  const pick = (v) => sanitizePrompt(cleanHistoryText(typeof v === 'string' ? v : contentToText(v)));
  const all = (list || []).filter((m) => m && m.role);
  const sys = all
    .filter((m) => m.role === 'system' || m.role === 'developer')
    .map((m) => ({ role: 'system', content: pick(m.content) }))
    .filter((m) => m.content);
  const convo = all.filter((m) => m.role === 'user' || m.role === 'assistant' || m.role === 'tool');

  /** 还原成 OpenAI 请求体里的那条消息（role / content / tool_calls / tool_call_id）。 */
  const toApiMessage = (m) => {
    const out = { role: m.role, content: pick(m.content) };
    if (Array.isArray(m.tool_calls) && m.tool_calls.length) {
      out.tool_calls = m.tool_calls.map((tc) => {
        const f = tc.function || {};
        let args = f.arguments ?? tc.arguments ?? {};
        if (typeof args !== 'string') args = JSON.stringify(args);
        return {
          id: tc.id || 'call_' + Math.random().toString(36).slice(2, 10),
          type: 'function',
          function: { name: f.name || tc.name, arguments: args },
        };
      });
      if (!out.content) out.content = null;
    }
    if (m.role === 'tool' && m.tool_call_id) out.tool_call_id = m.tool_call_id;
    return out;
  };

  // 工具描述上限：compact 开启时不再逐字照发（full 也从 3200 压到 220），
  // 参数说明也不再逐行发 —— 名字 + 类型 + `?` 在签名里已经有了。
  const descCap = (mode) => {
    if (!COMPACT_TOOLS) return mode === 'full' ? 3200 : mode === 'compact' ? 300 : 120;
    return mode === 'full' ? TOOL_DESC_CAP : mode === 'compact' ? 160 : 80;
  };
  const shrink = (desc, mode) => String(desc || '').replace(/\s+/g, ' ').slice(0, descCap(mode));
  // 参数 schema 瘦身：只压「说明文字」，属性名/类型/必填一个不少（否则模型拼不出合法参数）。
  // sandbox_permissions / justification 只在被拒后才用，描述每个约 120 字符 —— 直接不留描述。
  const META_ARGS = new Set(['sandbox_permissions', 'justification']);
  const trimSchema = (schema, cap) => {
    if (!schema || typeof schema !== 'object' || !schema.properties) return schema;
    const props = {};
    for (const [k, v] of Object.entries(schema.properties)) {
      const one = v && typeof v === 'object' ? { ...v } : { type: typeof v === 'string' ? v : 'string' };
      if (META_ARGS.has(k)) delete one.description;
      else if (typeof one.description === 'string') one.description = one.description.replace(/\s+/g, ' ').slice(0, cap);
      props[k] = one;
    }
    return { ...schema, properties: props };
  };
  const buildTools = (mode) =>
    (tools || [])
      .map((t) => {
        const f = t.function || t;
        if (!f?.name) return null;
        const schema = f.parameters && typeof f.parameters === 'object' ? f.parameters : { type: 'object', properties: {} };
        const params =
          mode === 'names'
            ? {
                type: 'object',
                properties: Object.fromEntries(Object.keys(schema.properties || {}).map((k) => [k, { type: 'string' }])),
                required: Array.isArray(schema.required) ? schema.required : [],
              }
            : COMPACT_TOOLS
              ? trimSchema(schema, mode === 'compact' ? 40 : 60)
              : schema;
        return { type: 'function', function: { name: f.name, description: shrink(f.description, mode), parameters: params } };
      })
      .filter(Boolean);

  // 请求体保持「纯 API JSON」：任何说明都作为一条 system 消息放进 messages 里，
  // 不要在 JSON 外面加中文包装。
  const replyContract = () => contractFor(reqMode, REPLY_JSON);

  const build = (part, mode) => {
    const messages = [];
    const withSystem = !opts.skipSystem;
    if (withSystem && reqMode === 'safe') messages.push(guardMessage());
    if (sys.length && withSystem) messages.push(...sys);
    for (const m of part) messages.push(toApiMessage(m));
    messages.push(replyContract());
    const body = { model: 'deepseek-web', messages };
    const toolsJson = buildTools(mode);
    if (toolsJson.length) {
      body.tools = toolsJson;
      body.tool_choice = 'auto';
    }
    return JSON.stringify(body);
  };

  let slice = convo;
  let mode = lim.toolMode;
  let out = build(slice, mode);
  if (estimateTokens(out) > lim.maxPromptTokens) {
    mode = 'compact';
    out = build(slice, mode);
  }
  let dropped = 0;
  while (estimateTokens(out) > lim.maxPromptTokens && slice.length > 2) {
    const cut = Math.max(1, Math.ceil(slice.length * 0.3));
    slice = slice.slice(cut);
    dropped += cut;
    out = build(slice, mode);
  }
  if (estimateTokens(out) > lim.maxPromptTokens) {
    mode = 'names';
    out = build(slice, mode);
  }
  if (dropped) log('[prompt] dropped ' + dropped + ' old message(s) to fit budget');
  log('[prompt] size=' + out.length + ' chars ~' + estimateTokens(out) + ' tok tools=' + mode + ' msgs=' + slice.length + ' mode=' + reqMode);
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
      ? '\n【工具清单】\n'
      : '\n【工具清单】（下面的工具可直接通过 tool_calls 调用）\n';
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

// 工具调用对象里可能出现的「元字段」——其余键都当作参数（模型常把参数平铺在调用对象上，
// 例如 {"name":"bash","description":"...","command":"pwd"}，以前只认 arguments 就丢了 command）。
const CALL_META_KEYS = new Set([
  'name', 'tool', 'type', 'id', 'function', 'arguments', 'args', 'parameters', 'input', 'content', 'role',
]);

function argsFromCallObject(tc) {
  if (!tc || typeof tc !== 'object') return {};
  const fn = tc.function && typeof tc.function === 'object' ? tc.function : null;
  const raw = fn?.arguments ?? tc.arguments ?? tc.args ?? tc.parameters ?? tc.input ?? null;
  if (typeof raw === 'string') {
    const t = raw.trim();
    if (!t) return {};
    try { const o = JSON.parse(t); return o && typeof o === 'object' ? o : {}; } catch { return {}; }
  }
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw;
  const extra = {};
  for (const [k, v] of Object.entries(tc)) if (!CALL_META_KEYS.has(k) && v !== undefined) extra[k] = v;
  return extra;
}

function callFromObject(tc) {
  if (!tc || typeof tc !== 'object') return null;
  const fn = tc.function && typeof tc.function === 'object' ? tc.function : null;
  const name = fn?.name || tc.name || tc.tool;
  if (!name) return null;
  const args = argsFromCallObject(tc);
  return { name: String(name), arguments: JSON.stringify(args || {}) };
}

function parseToolJson(body) {
  if (!body) return null;
  const cleaned = body.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  try {
    const obj = JSON.parse(cleaned);
    // 允许整段是 {"content":null,"tool_calls":[...]} 信封
    const list = Array.isArray(obj?.tool_calls) ? obj.tool_calls : Array.isArray(obj?.toolCalls) ? obj.toolCalls : null;
    if (list && list.length) return callFromObject(list[0]) || null;
    return callFromObject(obj);
  } catch {
    return null;
  }
}

// DeepSeek 网页模型有时会吐原生 DSML 标记（<|DSML|...>），直接抹掉，别让它们出现在正文里

// 兜底：模型可能绕过自定义协议，直接吐 DeepSeek 原生的 DSML 工具标记
function inferToolName(args, schemas) {
  const keys = Object.keys(args || {});
  if (!keys.length || !schemas) return null;
  const hits = [];
  for (const [name, schema] of schemas) {
    const props = schema && schema.properties ? Object.keys(schema.properties) : [];
    const required = Array.isArray(schema && schema.required) ? schema.required : [];
    if (!props.length) continue;
    if (!keys.every((k) => props.includes(k))) continue;
    if (!required.every((k) => keys.includes(k))) continue;
    hits.push(name);
  }
  return hits.length === 1 ? hits[0] : null;
}

// 解析 DSML 工具块。网页模型偶尔会把标记写歪（`<DSML||parameter ...>`、全角竖线 ｜、
// 甚至整个 `<invoke name="x">` 都不写），所以这里按「宽松匹配 + 按 schema 反推工具名」处理，
// 目标只有一个：把调用解析出来，绝不把这种标记漏进用户可见的正文。
function parseDsmlToolCalls(raw, schemas) {
  if (!raw) return null;
  const args = {};
  const re = /<\s*\/?\s*(?:DSML|[|｜])*[^>]*?parameter\s+name\s*=\s*["']?([A-Za-z0-9_.\-]+)["']?([^>]*)>([\s\S]*?)(?=<\s*\/?\s*(?:DSML|[|｜])|$)/gi;
  let m;
  while ((m = re.exec(raw))) {
    const key = m[1];
    const attrs = m[2] || '';
    let val = m[3].replace(/<[^>]*>/g, '').trim();
    if (!/string\s*=\s*["']?true/i.test(attrs)) {
      if (/^-?\d+(\.\d+)?$/.test(val)) val = Number(val);
      else if (/^(true|false)$/i.test(val)) val = /^true$/i.test(val);
      else { try { val = JSON.parse(val); } catch {} }
    }
    args[key] = val;
  }
  let name = null;
  const nm = /invoke\s+name\s*=\s*["']?([A-Za-z0-9_.\-]+)/i.exec(raw);
  if (nm) name = nm[1];
  if (!name) name = inferToolName(args, schemas);
  if (!name || !Object.keys(args).length) return null;
  return { name, arguments: JSON.stringify(args) };
}

/**
 * 剥掉站点注入的安全分类块。
 * 真机实测：回复正文里会冒出 `<ds_safety>…[判定]…[规则无</ds_safety>Safe` —— 网页端的安全
 * 分类被当正文吐出来，那一轮既没有工具调用也没有回答（界面看着「停下来了」）。
 * 顺序很关键：这块里**没有 "DSML" 字样**，所以必须在任何「不是 DSML 就早退」之前剥掉。
 */
function stripSiteSafetyBlocks(t) {
  if (!t || !/<\/?\s*ds_[a-z_]/i.test(t)) return t;
  let out = t
    .replace(/<ds_[a-z0-9_]*>[\s\S]*?<\/ds_[a-z0-9_]*>/gi, '')
    .replace(/<ds_[a-z0-9_]*>[\s\S]*$/i, '')
    .replace(/<\/?\s*ds_[a-z0-9_]*[^>]*>/gi, '');
  // 半截残片（收尾那几个字）与紧跟的安全标记尾巴
  out = out.replace(/\[?规则无\]?\s*$/g, '').replace(/\s*\bSafe\b\s*$/g, '');
  return out;
}

function stripSentinels(t) {
  if (!t) return t;
  t = stripSiteSafetyBlocks(t);
  const hadDsml = /DSML/i.test(t) || /[|｜]{2}\s*(?:calls|invoke|parameter)\b/i.test(t);
  let out = t
    .replace(/<[|｜]+\s*\/?\s*DSML\s*[|｜][^>]*>/gi, '')
    .replace(/[|｜]{2}DSML[|｜]{2}[^\s>]*/gi, '')
    .replace(/[|｜]{1,2}\s*DSML\s*[|｜]{1,2}/gi, '');
  if (hadDsml) {
    // 确认是 DSML 才做激进清理，避免误伤正文里的普通尖括号
    out = out
      .replace(/<\s*\/?\s*DSML\b[^>]*>/gi, '')
      .replace(/<\s*\/?\s*(?:calls|invoke|parameter)\b[^>]*>/gi, '')
      .replace(/<\s*\/?\s*[|｜]{1,2}\s*(?:calls|invoke|parameter)?\s*[|｜]{0,2}\s*>/gi, '');
  }
  return out
    .replace(/<\s*calls>/gi, '')
    .replace(/<\s*invoke\b[^>]*>/gi, '')
    .replace(/<\s*\/\s*invoke>/gi, '')
    .replace(/<\s*parameter\b[^>]*>/gi, '')
    .replace(/<\s*\/\s*parameter>/gi, '')
    .replace(/<\s*\/?\s*(?:tool_calls|args)\b[^>]*>/gi, '');
}

function normText(t) {
  return String(t || '').replace(/\s+/g, ' ').trim();
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
  // 工具 schema 表：参数校验与 DSML 解析都要用，提前建好
  const toolSchemas = new Map();
  for (const t of tools) {
    const f = t?.function || t;
    if (f?.name) toolSchemas.set(f.name, f.parameters || {});
  }

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
    // 续聊：把「网页会话里还没有的新消息」按 API 的 messages 形状发过去
    const delta = transcript.slice(from).filter((m) => m.role !== 'assistant');
    const lastTool = [...delta].reverse().find((m) => m.role === 'tool');
    if (lastTool) reason = reason + '+tool';
    const deltaMsgs = delta.map((m) => ({ role: m.role, content: m.text }));
    if (!deltaMsgs.length && lastUser) {
      const fb = cleanHistoryText(typeof lastUser.content === 'string' ? lastUser.content : contentToText(lastUser.content));
      deltaMsgs.push({ role: 'user', content: fb });
    }
    prompt = buildApiPrompt(deltaMsgs, tools, { resume: true, skipSystem: true });
  } else {
    prompt = buildApiPrompt(messages, tools);
  }
  log('[ctx] conv=' + convKey.slice(0, 8) + ' mode=' + reason + ' sent=' + transcript.length + ' prompt=' + prompt.length + ' session=' + (continuing ? String(prev.sessionId).slice(0, 8) : 'new'));
  if (prompt.length > modeLimits(currentMode()).maxPromptChars) log('[prompt] WARNING oversize ' + prompt.length);
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
  // 模型按「API 格式」回复时，整条回复是一个 JSON 对象（content + tool_calls）。
  // 看到开头是 { 就先缓冲，等收完再解析；解析不了就退回当纯文本。
  let jsonMode = false;
  let jsonBuf = '';
  // 模型按 API 格式回复时，开头可能是 {、[，也可能裹在 ```json 里（先到的第一段只有 ```，
  // 以前只看首字符不是 { 就直接当正文流出去，用户就看到了整段 {"tool_calls":...}）。
  const looksLikeEnvelopeStart = (t) => {
    const s = String(t || '').trimStart();
    if (!s) return false;
    if (/^```(?:json)?\s*$/.test(s)) return true;
    if (/^```(?:json)?\s*[\[{]/.test(s)) return true;
    return s.startsWith('{') || s.startsWith('[');
  };
  const emitText = (t) => {
    if (!t) return;
    const clean = stripSentinels(normalizeDelta(t));
    if (!clean) return;
    if (jsonMode) {
      jsonBuf += clean;
      return;
    }
    if (REPLY_JSON && !textOut && looksLikeEnvelopeStart(clean)) {
      jsonMode = true;
      jsonBuf = clean;
      return;
    }
    textOut += clean;
    if (!stream) return;
    if (!headersSent) sendChunk({ role: 'assistant', content: '' });
    sendChunk({ content: clean });
  };

  const finishJsonMode = () => {
    if (!jsonMode) return;
    jsonMode = false;
    const raw = jsonBuf;
    jsonBuf = '';
    const parsed = parseApiReply(raw, toolSchemas);
    if (process.env.DSW_DEBUG_JSON) log('[json] raw=' + raw.length + ' ' + JSON.stringify(raw.slice(0, 160)) + ' parsed=' + Boolean(parsed));
    if (!parsed) {
      // 像「回复信封」但解析不了：绝不能把原始 JSON 当正文吐给用户（那就是满屏 {"role":...}）。
      // 直接丢弃，让上层当作空回复重试。
      if (/^\s*\{\s*"(?:role|content|tool_calls|choices)"/.test(raw) || /"tool_calls"\s*:/.test(raw)) {
        log('[json] envelope unparseable, dropped (' + raw.length + ' chars)');
        return;
      }
      // 不是信封（比如用户真的想要一段 JSON）：当普通文本处理
      textOut += raw;
      if (stream) {
        if (!headersSent) sendChunk({ role: 'assistant', content: '' });
        sendChunk({ content: raw });
      }
      return;
    }
    if (!parsed.content && !parsed.tool_calls.length) {
      // 解析出来是个普通 JSON（用户就是要一段 JSON）：当正文返回
      textOut += raw;
      if (stream) {
        if (!headersSent) sendChunk({ role: 'assistant', content: '' });
        sendChunk({ content: raw });
      }
      return;
    }
    // 调工具的轮次里，模型常先写一句「我先看看 XX / 继续排查 YY」再调工具。
    // 这是执行过程中的思考输出，设置里可以关掉（默认关），关掉后只留工具调用本身。
    const narrationOff = parsed.tool_calls.length > 0 && loadConfig().showToolNarration !== true;
    if (parsed.content && narrationOff) {
      log('[json] hidden process narration before tool call (' + parsed.content.trim().length + ' chars)');
    } else if (parsed.content) {
      const safeContent = stripSiteSafetyBlocks(parsed.content);
      parsed.content = safeContent;
      textOut += safeContent;
      if (stream) {
        if (!headersSent) sendChunk({ role: 'assistant', content: '' });
        sendChunk({ content: parsed.content });
      }
    }
    for (const c of parsed.tool_calls) calls.push(c);
  };

  // 正文过滤器：@@TOOL@@ 自定义块 与 DeepSeek 原生 DSML 标记 都从正文里摘掉。
  // DSML 按「整块吞掉」处理，块内容只拿去解析成 tool_calls —— 官方 API 不会把这种标记吐给客户端。
  let buf = '';
  let mode = 'text'; // text | tool | dsml
  let dsmlBuf = '';
  const HOLD = 24;
  const DSML_START = /<\s*\/?\s*(?:DSML\b|[|｜]{1,2}\s*DSML)/i;
  const DSML_END = /<\s*\/\s*[^>]*\bcalls\b[^>]*>/i;
  // 模型有时写成 `<DSML||calls>` 这种没有标准闭合标签的歪格式：
  // 一旦见到就整块吞到流结束，再统一解析，避免把半截标记漏给用户。
  let dsmlToEnd = false;

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
          else {
            buf = buf.slice(i);
            mode = 'dsml';
            dsmlBuf = '';
            dsmlToEnd = /^<\s*DSML\b/i.test(buf);
          }
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
      if (dsmlToEnd) { dsmlBuf += buf; buf = ''; return; }
      const mEnd = DSML_END.exec(buf);
      if (!mEnd) { dsmlBuf += buf; buf = ''; return; }
      const endIdx = mEnd.index + mEnd[0].length;
      dsmlBuf += buf.slice(0, endIdx);
      buf = buf.slice(endIdx);
      mode = 'text';
      rawText += dsmlBuf;
      const c = parseDsmlToolCalls(dsmlBuf, toolSchemas);
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
      const c = parseDsmlToolCalls(dsmlBuf, toolSchemas);
      if (c) calls.push(c);
      else log('[chat] trailing dsml block without tool call, dropped');
      dsmlBuf = '';
      mode = 'text';
      return;
    }
    if (buf) { emitText(buf); buf = ''; }
    if (heldBackslash) { emitText(heldBackslash); heldBackslash = ''; }
  };

  let parser = null; // 用量统计（真实 token 数）在 try 之外读，这里提前声明
  // 台账：只记「一次对话」的结束时刻/耗时/结果，写失败一律吞掉，绝不影响对话
  const t0 = Date.now();
  let out = null;
  const noteChat = (ok, code = '') => {
    try {
      noteCall({
        at: Date.now(),
        ms: Date.now() - t0,
        ok,
        purpose: 'chat',
        accountId: (out && out.accountId) || (prev && prev.accountId) || '',
        code,
        throttled: /RATE|rate_limit|频繁|429/.test(String(code)),
        muted: /MUTED|is_muted/i.test(String(code)),
      });
    } catch {}
  };
  try {
    log('[chat] send model=' + modelId + ' msgs=' + messages.length + ' tools=' + tools.length + ' conv=' + convKey.slice(0, 8) + ' session=' + (prev?.sessionId ? prev.sessionId.slice(0, 8) : 'new') + ' thinking=' + model.thinking);
    parser = createStreamParser((d) => {
      if (process.env.DSW_DEBUG_STREAM) log('[stream] ' + (d.text ? 'text(' + d.text.length + '):' + JSON.stringify(d.text.slice(0, 80)) : 'reasoning(' + String(d.reasoning || '').length + ')'));
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
    const MAX_ATTEMPTS = 3;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const useSession = attempt === 1 ? (prev?.sessionId || null) : null;
      const useParent = attempt === 1 ? (prev?.parentId || null) : null;
      out = await withTimeout(
        browser.chat({
          prompt,
          // 只把「最后一条用户消息」的字数算进打字时间：整段 prompt 是完整历史，
          // 真人每轮只输入最后那句话，按历史长度算会慢到不真实。
          typedChars: (() => {
            for (let i = messages.length - 1; i >= 0; i--) {
              const m = messages[i];
              if (m && m.role === 'user') return String(m.content || '').length;
            }
            return Math.min(400, String(prompt || '').length);
          })(),
          thinking: model.thinking,
          sessionId: useSession,
          parentId: useParent,
          // 网页会话属于某个账号，续聊时必须回到同一个账号，否则上游会报 invalid chat session id
          preferAccount: accountLabel || prev?.accountId || null,
          onDelta: (block) => {
            if (process.env.DSW_DEBUG_RAW) log('[raw] ' + JSON.stringify(String(block).slice(0, 300)));
            parser.feed(block);
          },
          idleMs: 180000,
        }),
        300000,
        'chat',
      );
      endTools();
      finishJsonMode();
      if (textOut || calls.length) break;
      const upstreamError = parser.error();
      if (upstreamError) {
        // 网页会话在别的账号/已被站点回收：换新会话、用完整上下文再来一次，别把错误甩给用户
        const sessionGone = /invalid chat session|session.*(not found|expired)/i.test(String(upstreamError.message || ''));
        if (sessionGone && attempt < MAX_ATTEMPTS) {
          log('[chat] web session unusable (' + upstreamError.message + '), retrying with a fresh session');
          delete chatMap[convKey];
          saveChatMap();
          prev = null;
          continuing = false;
          prompt = buildApiPrompt(messages, tools);
          buf = ''; mode = 'text'; dsmlBuf = ''; textOut = ''; reasoningOut = ''; dsmlToEnd = false;
          continue;
        }
        // 站点明确报错（限流/会话失效）：不要再盲重重试，直接把原因回给客户端
        log('[chat] upstream error: ' + JSON.stringify(upstreamError));
        const rate = /频繁|rate limit/i.test(upstreamError.message) || upstreamError.finish === 'rate_limit_reached';
        noteChat(false, rate ? 'RATE_LIMIT' : 'UPSTREAM');
        if (!headersSent) {
          json(res, rate ? 429 : 502, {
            error: { message: '网页版返回错误：' + upstreamError.message, type: rate ? 'rate_limit' : 'upstream_error' },
          });
        } else {
          res.end();
        }
        return;
      }
      log('[chat] empty reply (attempt ' + attempt + '/' + MAX_ATTEMPTS + ')');
      if (attempt < MAX_ATTEMPTS) {
        log('[chat] waiting 10s, then retrying as a new chat');
        await new Promise((r) => setTimeout(r, 10000));
        delete chatMap[convKey];
        saveChatMap();
        prev = null;
        continuing = false;
        prompt = buildApiPrompt(messages, tools);
        buf = ''; mode = 'text'; dsmlBuf = ''; textOut = ''; reasoningOut = ''; dsmlToEnd = false;
      }
    }


    const replyDigest = crypto.createHash('sha1').update(normText(textOut)).digest('hex');
    const recent = [replyDigest, ...(Array.isArray(prev?.recentReplies) ? prev.recentReplies : prev?.replyDigest ? [prev.replyDigest] : [])];
    const next = {
      sessionId: out.sessionId || prev?.sessionId,
      accountId: out.accountId || prev?.accountId || null,
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
    const msg = String(e && e.message ? e.message : e);
    noteChat(
      false,
      /timeout|超时/i.test(msg) ? 'TIMEOUT' : /abort/i.test(msg) ? 'ABORTED' : /频繁|rate limit|429/i.test(msg) ? 'RATE_LIMIT' : 'TRANSPORT',
    );
    if (!headersSent) return json(res, 502, { error: { message: String(e.message || e), type: 'upstream_error' } });
  }

  // 兜底：有些情况下工具块是最后才完整出现的
  if (!calls.length) {
    const dsml = parseDsmlToolCalls(rawText, toolSchemas);
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
  // 最后一道兜底：正文里如果混进了 {"content":..., "tool_calls":[...]} 这种 API 信封
  // （常见于模型先写一句说明再贴 JSON，导致流式缓冲没从头开始），把它切出去当工具调用，
  // 绝不能让这段 JSON 出现在用户可见的正文里。
  if (!calls.length && /"tool_calls"\s*:/.test(textOut)) {
    const env = parseApiReply(textOut, toolSchemas);
    if (env && env.tool_calls.length) {
      calls.push(...env.tool_calls);
      textOut = env.content || '';
      log('[json] recovered tool calls from reply text: ' + env.tool_calls.length);
    }
  }


  // usage 按「这次真正发给站点的请求」算，并做窗口上限保护（见 server/usage.mjs）。
  // 站点流里的 accumulated_token_usage 是会话累计消耗（每轮递增），绝不能当本轮 prompt 用：
  // 长对话里它会到 40 万+，pi-ai 会据此把已成功的回复误判成 CONTEXT_WINDOW_EXCEEDED。
  const upstreamTotal = parser && parser.tokenUsage ? parser.tokenUsage() : 0;
  const usage = computeUsage({
    messages,
    tools,
    textOut,
    reasoningOut,
    contextWindow: CONTEXT_WINDOW,
    contentToText,
  });
  const { promptTokens, completionTokens, cachedTokens } = usage;
  if (chatMap[convKey]) { chatMap[convKey].promptTokens = promptTokens; saveChatMap(); }
  const usagePayload = usage.usagePayload;
  log(
    '[usage] prompt=' + promptTokens + '(est) completion=' + completionTokens + ' cached=' + cachedTokens +
      ' hit=' + (promptTokens ? Math.round((cachedTokens / promptTokens) * 1000) / 10 : 0) + '%' +
      // 会话累计值只做诊断，不参与 usage
      (upstreamTotal ? ' accumulated=' + upstreamTotal : ''),
  );
  // 对话标签：交给 conv-label.mjs（跳过「自动检查/续跑」套话，取第一条有内容的用户消息）
  const convLabel = convLabelOf(messages, contentToText);
  try { addUsage(convKey.slice(0, 12), promptTokens, completionTokens, cachedTokens, convLabel); } catch {}
  // 去重：模型有时会同时吐 DSML 和 @@TOOL@@ 两种格式，会得到完全相同的两个调用
  const seenCalls = new Set();
  const uniqCalls = calls.filter((c) => {
    const k = c.name + '\u0000' + c.arguments;
    if (seenCalls.has(k)) return false;
    seenCalls.add(k);
    return true;
  });
  if (uniqCalls.length !== calls.length) log('[chat] dropped ' + (calls.length - uniqCalls.length) + ' duplicate tool call(s)');

  // 参数修补：类型按 schema 纠正、description 可由 command 推导。
  // 修不好也照样把调用透传给宿主——和官方 API 一样，由工具层报错、模型在同一轮里自己改；
  // 以前是直接丢掉并往正文里塞一句「参数不完整，已忽略」，用户只会看到一句莫名其妙的话，还得手动说「继续」。
  const schemas = toolSchemas;
  const safeCalls = [];
  for (const c of uniqCalls) {
    const r = repairToolArgs(c, schemas);
    if (r.ok) safeCalls.push({ name: c.name, arguments: JSON.stringify(r.args) });
    else {
      log('[tool] invalid call passed through (tool layer will reject): ' + c.name + ' — ' + r.reason);
      safeCalls.push({ name: c.name, arguments: c.arguments });
    }
  }
  const toolCalls = safeCalls.map((c, i) => ({ id: 'call_' + id.slice(8, 18) + i, type: 'function', function: { name: c.name, arguments: c.arguments } }));

  noteChat(true);
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

/** 解析「API 格式」回复：{"role":"assistant","content":...,"tool_calls":[...]}。 */
/** 把 JSON 里漏转义的控制字符（换行/制表符）补回来——网页模型写长脚本时经常这样写坏。 */
function repairJsonText(raw) {
  let out = '';
  let inStr = false;
  let esc = false;
  for (const ch of String(raw)) {
    if (inStr) {
      if (esc) { out += ch; esc = false; continue; }
      if (ch === '\\') { out += ch; esc = true; continue; }
      if (ch === '"') { out += ch; inStr = false; continue; }
      if (ch === '\n') { out += '\\n'; continue; }
      if (ch === '\r') { out += '\\r'; continue; }
      if (ch === '\t') { out += '\\t'; continue; }
      out += ch;
      continue;
    }
    if (ch === '"') inStr = true;
    out += ch;
  }
  return out;
}

/** 从一个位置开始截一段平衡的 JSON 对象/字符串，容忍里面写坏的转义。 */
function sliceJsonValue(s) {
  if (!s) return null;
  if (s[0] === '"') {
    let esc = false;
    for (let i = 1; i < s.length; i++) {
      const ch = s[i];
      if (esc) { esc = false; continue; }
      if (ch === '\\') { esc = true; continue; }
      if (ch === '"') return s.slice(0, i + 1);
    }
    return null;
  }
  if (s[0] !== '{') return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inStr) {
      if (esc) { esc = false; continue; }
      if (ch === '\\') { esc = true; continue; }
      if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth === 0) return s.slice(0, i + 1); }
  }
  return null;
}

/** JSON 整体解析失败时的兜底：按 "name"/"arguments" 逐字段抠出工具调用。 */
function scanToolCallsLoose(raw) {
  const out = [];
  const re = /"name"\s*:\s*"([A-Za-z0-9_.\-]+)"/g;
  let m;
  while ((m = re.exec(raw))) {
    const after = raw.slice(m.index);
    const am = /"arguments"\s*:\s*/i.exec(after);
    if (!am) continue;
    const val = sliceJsonValue(after.slice(am.index + am[0].length));
    if (!val) continue;
    out.push({ name: m[1], arguments: val[0] === '"' ? JSON.parse(val) : val });
    if (out.length >= 24) break;
  }
  return out;
}

function parseApiReply(raw, schemas) {
  if (!raw) return null;
  let text = String(raw).trim();
  text = text.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  // 模型直接回一个调用数组：[{"name":"bash","command":"pwd"}]（没有外层对象）
  if (text.startsWith('[')) {
    const end = text.lastIndexOf(']');
    if (end > 0) {
      try {
        const arr = JSON.parse(repairJsonText(text.slice(0, end + 1)));
        if (Array.isArray(arr)) {
          const calls = arr.map((tc) => (typeof tc === 'string' ? (() => { try { return callFromObject(JSON.parse(tc)); } catch { return null; } })() : callFromObject(tc))).filter(Boolean);
          if (schemas && schemas.size) return { content: '', tool_calls: calls.filter((c) => schemas.has(c.name)) };
          return { content: '', tool_calls: calls };
        }
      } catch {}
    }
  }
  const i = text.indexOf('{');
  const j = text.lastIndexOf('}');
  if (i < 0 || j <= i) return null;
  const body = text.slice(i, j + 1);
  let obj;
  try {
    obj = JSON.parse(body);
  } catch {
    try {
      obj = JSON.parse(repairJsonText(body));
    } catch {
      // 二次兜底：整段 JSON 写坏了，就按字段把 tool_calls / content 抠出来
      const loose = scanToolCallsLoose(text);
      const mc = /"content"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(text);
      let content = '';
      if (mc) {
        try { content = JSON.parse('"' + mc[1] + '"'); } catch { content = mc[1]; }
      }
      if (!loose.length && !content) return null;
      return { content: content || '', tool_calls: loose };
    }
  }
  if (!obj || typeof obj !== 'object') return null;
  // 兼容模型直接回「完整 API 响应体」：{"choices":[{"message":{...}}]}
  if (Array.isArray(obj.choices) && obj.choices[0] && obj.choices[0].message && typeof obj.choices[0].message === 'object') {
    obj = obj.choices[0].message;
  }
  // 兼容模型直接回一个「工具调用数组」：[{"name":"bash","command":"pwd"}]
  if (Array.isArray(obj)) return { content: '', tool_calls: obj.map(callFromObject).filter(Boolean) };
  const content = typeof obj.content === 'string' ? obj.content : '';
  const list = Array.isArray(obj.tool_calls) ? obj.tool_calls : Array.isArray(obj.toolCalls) ? obj.toolCalls : [];
  let tool_calls = list
    .map((tc) => (typeof tc === 'string' ? (() => { try { return callFromObject(JSON.parse(tc)); } catch { return null; } })() : callFromObject(tc)))
    .filter(Boolean);
  // 只保留真实存在的工具，避免模型瞎编工具名把整轮搞成未知工具错误
  if (schemas && schemas.size) {
    // 只保留本轮真正发给模型的工具；模型瞎编的工具名不往下传，免得上层报「未知工具」
    tool_calls = tool_calls.filter((c) => schemas.has(c.name));
  }
  return { content, tool_calls };
}

/**
 * 按 JSON Schema 的 type 纠正值的类型（网页模型没有约束解码，常把 60000 写成 "60000"）。
 * 返回 { ok, value, changed } 或 { ok:false, reason }。
 */
function coerceValue(value, schema, path) {
  if (!schema || typeof schema !== 'object') return { ok: true, value, changed: false };
  const types = Array.isArray(schema.type) ? schema.type : schema.type ? [schema.type] : [];
  const where = path || '参数';
  const asType = (t) => {
    switch (t) {
      case 'integer':
      case 'number': {
        if (typeof value === 'number' && Number.isFinite(value)) return { ok: true, value };
        if (typeof value === 'string') {
          const s = value.trim().replace(/[,_\s]/g, '');
          if (s !== '' && /^-?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(s)) {
            const n = Number(s);
            if (Number.isFinite(n) && (t !== 'integer' || Number.isInteger(n))) return { ok: true, value: n };
          }
        }
        if (typeof value === 'boolean') return { ok: true, value: value ? 1 : 0 };
        return { ok: false, reason: where + ' 应为 ' + t + '，收到 ' + JSON.stringify(value).slice(0, 40) };
      }
      case 'boolean': {
        if (typeof value === 'boolean') return { ok: true, value };
        if (typeof value === 'string') {
          const s = value.trim().toLowerCase();
          if (['true', 'yes', '1', 'on'].includes(s)) return { ok: true, value: true };
          if (['false', 'no', '0', 'off'].includes(s)) return { ok: true, value: false };
        }
        if (value === 0 || value === 1) return { ok: true, value: !!value };
        return { ok: false, reason: where + ' 应为 boolean，收到 ' + JSON.stringify(value).slice(0, 40) };
      }
      case 'string': {
        if (typeof value === 'string') return { ok: true, value };
        if (typeof value === 'number' || typeof value === 'boolean') return { ok: true, value: String(value) };
        return { ok: false, reason: where + ' 应为 string，收到 ' + JSON.stringify(value).slice(0, 40) };
      }
      case 'array': {
        let v = value;
        if (typeof v === 'string') {
          const s = v.trim();
          if (!s.startsWith('[')) return { ok: false, reason: where + ' 应为 array，收到字符串' };
          try { v = JSON.parse(s); } catch { return { ok: false, reason: where + ' 的 array 字符串不是合法 JSON' }; }
        }
        if (!Array.isArray(v)) return { ok: false, reason: where + ' 应为 array，收到 ' + JSON.stringify(value).slice(0, 40) };
        const items = [];
        let changed = v !== value;
        for (let i = 0; i < v.length; i++) {
          const r = coerceValue(v[i], schema.items, where + '[' + i + ']');
          if (!r.ok) return r;
          if (r.changed) changed = true;
          items.push(r.value);
        }
        return { ok: true, value: items, changed };
      }
      case 'object': {
        let v = value;
        if (typeof v === 'string') {
          const s = v.trim();
          if (!s.startsWith('{')) return { ok: false, reason: where + ' 应为 object，收到字符串' };
          try { v = JSON.parse(s); } catch { return { ok: false, reason: where + ' 的 object 字符串不是合法 JSON' }; }
        }
        if (!v || typeof v !== 'object' || Array.isArray(v)) {
          return { ok: false, reason: where + ' 应为 object，收到 ' + JSON.stringify(value).slice(0, 40) };
        }
        let changed = v !== value;
        for (const [k, sub] of Object.entries(schema.properties || {})) {
          if (v[k] === undefined) continue;
          const r = coerceValue(v[k], sub, where + '.' + k);
          if (!r.ok) return r;
          if (r.changed) changed = true;
          v[k] = r.value;
        }
        return { ok: true, value: v, changed };
      }
      default:
        return { ok: true, value, changed: false };
    }
  };
  // 没写 type：按 nullable/枚举/组合器兜底判断，能过就过
  if (!types.length) {
    if (Array.isArray(schema.enum) && !schema.enum.includes(value)) {
      const hit = schema.enum.find((e) => typeof e === 'string' && typeof value === 'string' && e.toLowerCase() === value.toLowerCase());
      if (hit !== undefined) return { ok: true, value: hit, changed: true };
    }
    if (schema.properties) {
      let changed = false;
      const obj = { ...value };
      for (const [k, sub] of Object.entries(schema.properties)) {
        if (obj[k] === undefined) continue;
        const r = coerceValue(obj[k], sub, where + '.' + k);
        if (!r.ok) return r;
        if (r.changed) changed = true;
        obj[k] = r.value;
      }
      return { ok: true, value: obj, changed };
    }
    return { ok: true, value, changed: false };
  }
  // type: ["string","null"] 之类：值已经匹配其中一种就不要再改
  const matches = types.find((t) => {
    if (t === 'null') return value === null;
    if (t === 'integer') return typeof value === 'number' && Number.isInteger(value);
    if (t === 'number') return typeof value === 'number';
    if (t === 'array') return Array.isArray(value);
    if (t === 'object') return value && typeof value === 'object' && !Array.isArray(value);
    return typeof value === t;
  });
  if (matches) {
    // 值类型已经对了，但如果 object 内部还有错类型的字段，仍要往下修
    const deep = types.find((t) => t === 'object' || t === 'array');
    if (!deep) return { ok: true, value, changed: false };
    const asDeep = asType(deep);
    return asDeep.ok ? asDeep : { ok: true, value, changed: false };
  }
  if (value === null && types.includes('null')) return { ok: true, value, changed: false };
  for (const t of types) {
    if (t === 'null') continue;
    const r = asType(t);
    if (r.ok) return { ok: true, value: r.value, changed: true };
  }
  return asType(types[0]);
}

/** 按工具 schema 校验/修补参数：类型按 schema 纠正，缺 description 时用 command 推导，其余缺必填则判为无效。 */
function repairToolArgs(call, schemas) {
  const schema = schemas.get(call.name);
  let args;
  const rawArgs = call.arguments || '{}';
  try {
    args = JSON.parse(rawArgs);
  } catch {
    try {
      args = JSON.parse(repairJsonText(rawArgs));
      log('[tool] repaired broken JSON in arguments of ' + call.name);
    } catch {
      return { ok: false, reason: '参数不是合法 JSON' };
    }
  }
  if (!args || typeof args !== 'object') return { ok: false, reason: '参数不是对象' };
  if (!schema) return { ok: true, args };
  const required = Array.isArray(schema.required) ? schema.required : [];
  const props = schema.properties && typeof schema.properties === 'object' ? Object.keys(schema.properties) : [];
  // 参数整个是空的，但工具明明需要参数：判为无效（模型常常在信息不足时直接甩一个 {}）
  if (Object.keys(args).length === 0 && props.length > 0) {
    return { ok: false, reason: '参数为空，需要 ' + props.slice(0, 6).join(', ') };
  }
  // 类型纠正：网页模型没有约束解码，容易把数字/布尔写成字符串，或把数组对象写成 JSON 字符串
  const fixed = [];
  for (const [k, sub] of Object.entries(schema.properties || {})) {
    if (args[k] === undefined) continue;
    const r = coerceValue(args[k], sub, k);
    if (!r.ok) return { ok: false, reason: r.reason };
    if (r.changed) {
      fixed.push(k + ': ' + JSON.stringify(args[k]).slice(0, 30) + ' → ' + JSON.stringify(r.value).slice(0, 30));
      args[k] = r.value;
    }
  }
  if (fixed.length) log('[tool] coerced args ' + call.name + ': ' + fixed.join('; '));
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
  if (spec.reply !== undefined) {
    const schemas = new Map();
    for (const t of spec.tools || []) { const f = t.function || t; if (f?.name) schemas.set(f.name, f.parameters || {}); }
    const parsed = parseApiReply(spec.reply, schemas.size ? schemas : undefined);
    console.log('parsed:', JSON.stringify(parsed));
    process.exit(0);
  }
  if (spec.dsml) {
    const schemas = new Map();
    for (const t of spec.tools || []) { const f = t.function || t; if (f?.name) schemas.set(f.name, f.parameters || {}); }
    const parsed = parseDsmlToolCalls(spec.dsml, schemas);
    console.log('parsed:', JSON.stringify(parsed));
    console.log('stripped:', JSON.stringify(stripSentinels(spec.dsml)));
    process.exit(0);
  }
  if (spec.safety !== undefined) {
    console.log('stripped:', JSON.stringify(stripSentinels(spec.safety)));
    process.exit(0);
  }
  const prompt = buildApiPrompt(spec.messages || [], spec.tools || [], spec.mode ? { mode: spec.mode } : {});
  if (spec.dump) { try { fs.writeFileSync(spec.dump, prompt); } catch {} }
  const doc = renderTools(spec.tools || [], 'full');
  console.log(JSON.stringify({
    mode: spec.mode || currentMode(),
    guardInPrompt: prompt.includes(GUARD_MARK),
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
