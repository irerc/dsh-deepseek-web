/** SSE 事件块解析：兼容 {"v":"文字"} 与 {"p":"response/fragments/-1/content","o":"APPEND","v":"..."} 两种增量 */
export function createStreamParser(onDelta) {
  const fragments = [];
  const emitted = new Map(); // key -> 已经下发给客户端的正文/思考
  let responseMessageId = null;
  // response.accumulated_token_usage = 本次网页会话累计消耗的 token（每轮递增，
  // 不是这条回复的上下文大小）。只做诊断日志，绝不能当 usage.prompt_tokens 用，
  // 否则长对话里会报出 40 万+ 让 pi-ai 误判上下文溢出（见 server/usage.mjs）。
  let tokenUsage = 0;
  let lastError = null;
  let seq = 0;

  const emit = (type, text) => {
    if (!text) return;
    if (type === 'THINK') onDelta({ reasoning: text });
    else onDelta({ text });
  };
  // 只有「新增的那部分」才下发，避免快照重复
  const advance = (key, type, full) => {
    const prev = emitted.get(key) || '';
    let delta;
    if (full.startsWith(prev)) delta = full.slice(prev.length);
    else delta = full; // 内容被改写（重连/重生成），整段重发
    emitted.set(key, full);
    emit(type, delta);
  };
  const appendTo = (idx, text) => {
    const frag = fragments[idx];
    if (!frag) return;
    frag.content += text;
    const key = frag.id ?? 'i' + idx;
    emitted.set(key, frag.content);
    emit(frag.type, text);
  };
  const resolveIdx = (raw) => {
    const i = Number(raw);
    if (Number.isNaN(i)) return -1;
    return i < 0 ? fragments.length + i : i;
  };

  return {
    responseMessageId: () => responseMessageId,
    tokenUsage: () => tokenUsage,
    error: () => lastError,
    feed(block) {
      const lines = block.split('\n');
      let data = '';
      for (const line of lines) {
        if (line.startsWith('data:')) data += line.slice(5).trim();
      }
      if (!data || data === '[DONE]') return;
      let obj;
      try { obj = JSON.parse(data); } catch { return; }

      // 站点主动报错（限流、会话失效等）：记下来，交给上层决定是重试还是直接返回错误
      if (obj && obj.type === 'error' && typeof obj.content === 'string') {
        lastError = { message: obj.content, finish: obj.finish_reason || null };
        return;
      }
      if (obj && typeof obj.code === 'number' && obj.data && typeof obj.data.biz_code === 'number' && obj.data.biz_code !== 0) {
        lastError = { message: String(obj.data.biz_msg || 'web error'), finish: null, bizCode: obj.data.biz_code };
        return;
      }

      if (obj.request_message_id !== undefined && obj.response_message_id !== undefined) {
        responseMessageId = obj.response_message_id;
        return;
      }
      const resp = obj?.v?.response;
      if (resp && Array.isArray(resp.fragments)) {
        responseMessageId = resp.message_id ?? responseMessageId;
        if (Number(resp.accumulated_token_usage) > 0) tokenUsage = Number(resp.accumulated_token_usage);
        fragments.length = 0;
        for (const f of resp.fragments) fragments.push({ id: f.id, type: f.type, content: f.content || '' });
        // 快照可能带已有内容：只把「还没下发过」的部分补发出去
        fragments.forEach((f, i) => advance(f.id ?? 'i' + i, f.type, f.content));
        return;
      }
      // 裸增量：只有不带 p 的 {"v":"文字"} 才当作正文/思考追加；
      // 带 p 的（如 response/status = FINISHED）是状态补丁，绝不能当正文。
      if (typeof obj.v === 'string' && obj.p === undefined) {
        const idx = fragments.length - 1;
        if (idx >= 0) appendTo(idx, obj.v);
        return;
      }
      if (typeof obj.p === 'string') {
        // 累计 token 数：整块补丁 {"p":"response","o":"BATCH","v":[{"p":"accumulated_token_usage","v":123}, …]}
        if (obj.p === 'response' && Array.isArray(obj.v)) {
          for (const sub of obj.v) {
            if (sub && sub.p === 'accumulated_token_usage' && Number(sub.v) > 0) tokenUsage = Number(sub.v);
          }
        }
        // 也可能直接给 {"p":"response/accumulated_token_usage","o":"SET","v":123}
        if (obj.p === 'response/accumulated_token_usage' && Number(obj.v) > 0) tokenUsage = Number(obj.v);
        // 整块追加新 fragment：{"p":"response/fragments","o":"APPEND","v":[{type,content,...}]}
        if (obj.p === 'response/fragments' && Array.isArray(obj.v)) {
          for (const f of obj.v) {
            if (!f || typeof f !== 'object') continue;
            const key = f.id ?? 'n' + seq++;
            fragments.push({ id: f.id, type: f.type, content: f.content || '' });
            advance(key, f.type, f.content || '');
          }
          return;
        }
        const m = /^response\/fragments\/(-?\d+)\/content$/.exec(obj.p);
        if (m) {
          const idx = resolveIdx(m[1]);
          // 注意：DeepSeek 的增量补丁经常不带 o 字段，缺省就是 APPEND
          if ((obj.o === 'APPEND' || obj.o === undefined || obj.o === null) && typeof obj.v === 'string') appendTo(idx, obj.v);
          else if (obj.o === 'SET' && typeof obj.v === 'string' && fragments[idx]) {
            fragments[idx].content = obj.v;
            advance(fragments[idx].id ?? 'i' + idx, fragments[idx].type, obj.v);
          }
          return;
        }
        const fm = /^response\/fragments\/(-?\d+)$/.exec(obj.p);
        if (fm && obj.v && typeof obj.v === 'object') {
          const idx = resolveIdx(fm[1]);
          const frag = { id: obj.v.id, type: obj.v.type, content: obj.v.content || '' };
          if (idx < 0 || idx >= fragments.length) fragments.push(frag); else fragments[idx] = frag;
          advance(frag.id ?? 'i' + idx, frag.type, frag.content);
          return;
        }
      }
    },
    text() { return fragments.filter((f) => f.type !== 'THINK').map((f) => f.content).join(''); },
    reasoning() { return fragments.filter((f) => f.type === 'THINK').map((f) => f.content).join(''); },
    fragments,
  };
}
