// 浏览器自动登录：一次性票据
//
// 背景：站点对「无浏览器指纹的密码登录」可能直接回 RISK_DEVICE_DETECTED（设备风控），
// 这种情况下唯一可靠的路子是在真实网页里登录一次（站点的 JS 会完成风控签名）。
// 为了不让用户重新手输账号密码，插件先生成一张短时效票据，
// 登录页（走登录代理）凭票据向本机取回邮箱密码、自动填表并提交。
//
// 安全：
//   - 票据只存在内存里，进程重启即失效；
//   - 3 分钟过期，最多读 5 次（页面刷新会再读一次），过期/超次后作废；
//   - 只有走本机登录代理的页面能拿到（代理只监听 127.0.0.1）。
import crypto from 'node:crypto';

const TTL_MS = 3 * 60 * 1000;
const MAX_READS = 5;

const tickets = new Map(); // ticket -> { accountId, email, password, at, reads }

function sweep() {
  const now = Date.now();
  for (const [k, v] of tickets) {
    if (now - v.at > TTL_MS || v.reads >= MAX_READS) tickets.delete(k);
  }
}

/**
 * 生成一张自动登录票据。
 * @param {{accountId?:string,email?:string,password?:string,reason?:string}} info
 * @returns {string} 票据（32 位十六进制）
 */
export function issueTicket({ accountId = '', email = '', password = '', reason = '' } = {}) {
  sweep();
  const ticket = crypto.randomBytes(16).toString('hex');
  tickets.set(ticket, { accountId, email, password, reason, at: Date.now(), reads: 0 });
  return ticket;
}

/** 读票据（可重复读，有次数上限）；无效返回 null */
export function peekTicket(ticket) {
  sweep();
  const v = tickets.get(String(ticket || ''));
  if (!v) return null;
  v.reads += 1;
  if (v.reads >= MAX_READS) tickets.delete(String(ticket));
  return { accountId: v.accountId, email: v.email, password: v.password, reason: v.reason };
}

/** 主动作废（登录成功后调用） */
export function dropTicket(ticket) {
  tickets.delete(String(ticket || ''));
}

/** 只给测试用：当前票据数量 */
export function ticketCount() {
  return tickets.size;
}
