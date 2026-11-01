// 对话标签：从 messages 里挑一条能代表这个网页会话的文字
// 之前直接取第一条 user 消息，而 DSH 的自动续跑/检查会把每个会话的第一条消息都写成
// 同一句「This is an automatically generated check」，结果所有对话在用量列表里同名。
const BOILER = /automatically generated check|自动生成的检查|自动检查|auto[- ]?continue|continue the task/i;

export function isBoilerplateLabel(text) {
  return BOILER.test(String(text || ''));
}

/**
 * @param {Array} messages OpenAI 形状的 messages
 * @param {(v:any)=>string} toText 把 content（string 或 parts 数组）转成纯文本
 */
export function convLabelOf(messages, toText) {
  const flat = (v) => String((typeof toText === 'function' ? toText(v) : v) || '');
  const clean = (s) => flat(s).replace(/\s+/g, ' ').trim();
  const users = (messages || [])
    .filter((m) => m && m.role === 'user')
    .map((m) => clean(m.content))
    .filter(Boolean);
  // 优先第一条「真正有内容」的用户消息（当话题）；实在没有就退到最后一条
  const meaningful = users.filter((s) => !BOILER.test(s) && s.length >= 6);
  const pick = meaningful[0] || users[users.length - 1] || '';
  return pick.slice(0, 40);
}
