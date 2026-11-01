// 保存的登录凭证（邮箱 + 密码）：只用本机密钥 AES-256-GCM 加密后落盘。
//
// 说明：
//   - 密钥放在 state 目录的 credentials.key（0600），和 accounts.json 分开；
//     只拷走 accounts.json 是解不开密码的。
//   - 密码永远不返回给前端：接口只回 hasPassword 这种布尔标记。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { STATE_DIR, ensureStateDir } from './config.mjs';

const KEY_FILE = path.join(STATE_DIR, 'credentials.key');

let cachedKey = null;

function key() {
  if (cachedKey) return cachedKey;
  ensureStateDir();
  try {
    const raw = fs.readFileSync(KEY_FILE, 'utf8').trim();
    if (/^[0-9a-f]{64}$/i.test(raw)) {
      cachedKey = Buffer.from(raw, 'hex');
      return cachedKey;
    }
  } catch {}
  const buf = crypto.randomBytes(32);
  try {
    fs.writeFileSync(KEY_FILE, buf.toString('hex'), { mode: 0o600 });
  } catch {}
  cachedKey = buf;
  return cachedKey;
}

/** 加密一段文本；空值返回空串 */
export function encrypt(text) {
  if (text === undefined || text === null || String(text) === '') return '';
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const body = Buffer.concat([cipher.update(String(text), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ['v1', iv.toString('base64'), tag.toString('base64'), body.toString('base64')].join(':');
}

/** 解密；密钥换了/内容坏了都返回空串（当作没保存过密码） */
export function decrypt(payload) {
  if (!payload) return '';
  const parts = String(payload).split(':');
  if (parts.length !== 4 || parts[0] !== 'v1') return '';
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', key(), Buffer.from(parts[1], 'base64'));
    decipher.setAuthTag(Buffer.from(parts[2], 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(parts[3], 'base64')), decipher.final()]).toString('utf8');
  } catch {
    return '';
  }
}
