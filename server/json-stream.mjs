/**
 * 流式 JSON 信封解包：模型按 API 格式回复 `{"content": "...", "tool_calls": [...]}`，
 * 如果等整段 JSON 收完再吐正文，前端就完全看不到流式（首字要等 20 秒）。
 *
 * 这里只做一件事：一边收一边把顶层 "content" 字符串的字符解出来，遇到转义（\n \" \uXXXX）
 * 就等够字符再吐，保证不会吐出半截转义序列。tool_calls 等其它字段一律不碰，留给收尾的整体 JSON.parse。
 */
export function createJsonTextStreamer(onText) {
  let buf = ''; // 已收到、尚未消费的原始字符
  let pos = 0;
  let state = 'seekKey'; // seekKey | inKey | seekValue | inValue | inStr(skip) | done
  let depth = 0;
  let expectKey = false;
  let key = '';
  let emitted = 0;
  let escape = '';
  let inString = false;

  const emit = (s) => {
    if (!s) return;
    emitted += s.length;
    onText(s);
  };

  const flushEscape = () => {
    if (!escape) return;
    const e = escape;
    escape = '';
    if (e === '\\n') emit('\n');
    else if (e === '\\t') emit('\t');
    else if (e === '\\r') emit('\r');
    else if (e === '\\b') emit('\b');
    else if (e === '\\f') emit('\f');
    else if (e === '\\\\') emit('\\');
    else if (e === '\\/') emit('/');
    else if (e === '\\"') emit('"');
    else if (e.startsWith('\\u')) {
      const hex = e.slice(2);
      if (hex.length === 4) {
        const code = parseInt(hex, 16);
        if (Number.isFinite(code)) emit(String.fromCharCode(code));
      }
    }
    // 其它非法转义：丢掉反斜杠，保留字符本身（模型偶尔写坏）
    else if (e.length > 1) emit(e.slice(1));
  };

  function push(chunk) {
    buf += String(chunk || '');
    for (;;) {
      if (state === 'done' || pos >= buf.length) break;
      const ch = buf[pos];

      if (state === 'seekKey' || state === 'seekValue') {
        if (ch === '{') { depth++; expectKey = depth === 1; pos++; continue; }
        if (ch === '}') { depth--; pos++; if (depth <= 0) { state = 'done'; continue; } continue; }
        if (ch === '[' || ch === ']') { pos++; continue; }
        if (ch === ',') { if (depth === 1) expectKey = true; pos++; continue; }
        if (ch === ':') { expectKey = false; pos++; state = 'seekValue'; continue; }
        if (ch === '"') {
          if (state === 'seekKey' || expectKey) { state = 'inKey'; key = ''; inString = true; escape = ''; pos++; continue; }
          // 值字符串：只有 content 才流式解出来，其它跳过
          state = key === 'content' ? 'inValue' : 'skipString';
          inString = true; escape = ''; pos++; continue;
        }
        pos++;
        continue;
      }

      if (state === 'inKey') {
        if (escape) {
          escape += ch; pos++;
          if (escape.length === 2 && escape[1] !== 'u') { key += escape === '\\"' ? '"' : escape === '\\\\' ? '\\' : '_'; escape = ''; }
          else if (escape.length === 6) { key += '_'; escape = ''; }
          continue;
        }
        if (ch === '\\') { escape = '\\'; pos++; continue; }
        if (ch === '"') { inString = false; pos++; state = 'seekValue'; expectKey = false; continue; }
        key += ch; pos++; continue;
      }

      if (state === 'skipString') {
        if (escape) {
          escape = ''; pos++;
          if (ch === 'u') { pos += 4; }
          continue;
        }
        if (ch === '\\') { escape = '\\'; pos++; continue; }
        if (ch === '"') { inString = false; pos++; state = 'seekKey'; continue; }
        pos++; continue;
      }

      if (state === 'inValue') {
        if (escape) {
          escape += ch; pos++;
          if (escape.length === 2 && escape[1] !== 'u') flushEscape();
          else if (escape.length === 6) flushEscape();
          continue;
        }
        if (ch === '\\') { escape = '\\'; pos++; continue; }
        if (ch === '"') { pos++; state = 'seekKey'; continue; }
        // 批量吐：找下一个需要特殊处理的位置，减少函数调用
        const next = (() => {
          const a = buf.indexOf('\\', pos);
          const b = buf.indexOf('"', pos);
          const cands = [a, b].filter((i) => i >= 0);
          return cands.length ? Math.min(...cands) : buf.length;
        })();
        if (next > pos) { emit(buf.slice(pos, next)); pos = next; }
        continue;
      }

      pos++;
    }
    // 已消费的部分丢掉，避免 buffer 无限增长
    if (pos > 4096) { buf = buf.slice(pos); pos = 0; }
  }

  function end() {
    push('');
    if (escape) flushEscape();
    state = 'done';
    return emitted;
  }

  return { push, end, get emitted() { return emitted; } };
}
