/**
 * token 估算与 OpenAI usage 计算。
 *
 * 这里有一条踩过的坑，务必保留注释：
 * 站点 SSE 里的 `response.accumulated_token_usage` 是「本次网页会话累计消耗的 token」，
 * 每轮都会把上一轮的值继续往上加（engine.log 里从 1527 一路涨到 459441，每轮 +~1.5 万），
 * 它 **不是** 这一轮请求的上下文大小。早期把它当作 prompt_tokens，长对话里就会报出
 * 40 万以上的 prompt；DSH 的 pi-ai 适配器在「成功返回但 usage.input + cacheRead > contextWindow」
 * 时会判定为静默上下文溢出，把已经成功的回复整轮判成 CONTEXT_WINDOW_EXCEEDED 失败。
 *
 * 现在的口径：prompt_tokens = 本次真正发给站点的请求（messages + tools）的估算值，
 * 并再按声明窗口做一次上限保护（成功返回的请求永远不该被自己的 usage 判成溢出）。
 */

/** DeepSeek 网页端分词器近似：中文 ≈1.9 字/token，英文 ≈3.8 字符/token */
export function estimateTokens(text) {
  if (!text) return 0;
  let cjk = 0;
  for (const ch of text) if (/[\u4e00-\u9fff\u3040-\u30ff]/.test(ch)) cjk++;
  return Math.ceil(cjk * 0.52 + (text.length - cjk) / 3.8);
}

/**
 * 由「实际发给站点的请求」计算 OpenAI usage。
 * @param {object} p
 * @param {Array} p.messages 发给站点的 messages（已裁剪）
 * @param {Array} p.tools 发给站点的 tools（已裁剪）
 * @param {string} p.textOut 本次正文
 * @param {string} p.reasoningOut 本次思考
 * @param {number} [p.contextWindow] 声明窗口；给了就做上限钳制
 * @param {(c:any)=>string} [p.contentToText] 多模态内容转文本
 */
export function computeUsage({ messages = [], tools = [], textOut = '', reasoningOut = '', contextWindow = 0, contentToText }) {
  const toText = typeof contentToText === 'function' ? contentToText : (c) => (typeof c === 'string' ? c : '');
  const contextParts = [];
  const tailParts = []; // 最后一条 assistant 之后的内容＝本轮真正新增的部分，不算缓存
  let tailOpen = false;
  for (const m of messages) {
    if (!m || !m.role) continue;
    const t = typeof m.content === 'string' ? m.content : toText(m.content);
    const callsText = Array.isArray(m.tool_calls) ? JSON.stringify(m.tool_calls) : '';
    const line = m.role + ': ' + (t || '') + (callsText ? ' ' + callsText : '');
    contextParts.push(line);
    if (m.role === 'assistant') { tailParts.length = 0; tailOpen = true; }
    else if (tailOpen) tailParts.push(line);
  }
  if (tools.length) contextParts.push('tools: ' + JSON.stringify(tools));
  const hasAssistant = messages.some((m) => m && m.role === 'assistant');

  const completionTokens = estimateTokens(textOut + reasoningOut);
  const estimatedPrompt = estimateTokens(contextParts.join('\n'));
  // 上限保护：声明窗口内成功返回的请求，绝不能因为 usage 自己越界而被判成溢出。
  const cap = Number(contextWindow) > 0 ? Math.max(1, Math.floor(contextWindow) - 1) : 0;
  const promptTokens = cap ? Math.min(Math.max(1, estimatedPrompt), cap) : Math.max(1, estimatedPrompt);

  // 缓存读取：DeepSeek 的上下文缓存是按「前缀」命中的。同一条对话里，
  // 除了最后一条 assistant 之后新追加的内容，其余前缀都视为缓存命中。
  const tailTokens = estimateTokens(tailParts.join('\n'));
  const cachedTokens = hasAssistant ? Math.max(0, Math.min(promptTokens - tailTokens, promptTokens)) : 0;

  return {
    promptTokens,
    completionTokens,
    cachedTokens,
    estimatedPrompt,
    usagePayload: {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: promptTokens + completionTokens,
      prompt_tokens_details: { cached_tokens: cachedTokens },
      prompt_cache_hit_tokens: cachedTokens,
      prompt_cache_miss_tokens: Math.max(0, promptTokens - cachedTokens),
    },
  };
}
