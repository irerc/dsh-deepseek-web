// 运行配置：settings 界面改的就是这一个文件（唯一事实源）
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// 状态目录放在 DSH 用户目录下，而不是插件包内：升级/重装插件包时数据不会跟着被替换掉。
const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
export const STATE_DIR =
  process.env.DSH_DEEPSEEK_WEB_STATE || path.join(DSH_HOME, 'storages', 'dsh-deepseek-web');
// 老版本把状态放在插件包内（<pkg>/state），首次启动时迁移过来，避免升级后「数据全没了」
const LEGACY_STATE_DIR = path.join(PKG_ROOT, 'state');
export const CONFIG_FILE = path.join(STATE_DIR, 'config.json');

export const DEFAULTS = {
  autoStart: true, // 首次调用时自动拉起引擎
  idleStopMs: 10 * 60 * 1000, // 空闲多久关停引擎
  sendGapMs: 1200, // 同一账号两次请求的最小间隔
  // 请求模式：raw 原始（提示词原样、不加额外说明）| safe 保险（提示词里插使用规范 + 更慢更保守）
  requestMode: 'raw',
  maxConcurrency: 4, // 全局并发上限
  perAccountConcurrency: 2,
  showToolNarration: false, // 调工具的轮次是否显示模型前面的说明文字（大号白字那种「我先看看 XX」）
  // token 失效时，用保存的邮箱+密码自动重新登录（密码在本地加密保存，见 server/credentials.mjs）
  autoRelogin: true,
  // 登录线路：auto 跟随浏览器；cn 国内（中文登录页，手机号/微信/邮箱都可）；global 英文登录页（邮箱/Google 账号用，大陆网络同样可用）
  loginRegion: 'auto',
  loginHost: '', // 可选：登录页上游域名（默认 chat.deepseek.com，海外可填镜像域名）
  // 设置页里内嵌登录窗口（实验性）：关掉就回到「新标签页打开登录页」的旧行为。
  // 这是内嵌方案的回滚开关，改完立即生效，不需要降级插件版本。
  embedLogin: process.env.DS_EMBED_LOGIN !== '0',
  // 登录页登录成功时，把表单里的邮箱+密码加密保存到本机（下次自动填表 / token 失效自动重登用）
  saveLoginCredential: process.env.DS_SAVE_LOGIN_CREDENTIAL !== '0',
  // 登录态主动探活间隔（毫秒），0 = 关闭。参考 dsh-deepseek-web-login 的 probeIntervalMs
  probeIntervalMs: 30 * 60 * 1000,
  // 当前账号：下一轮请求优先用它（账号库里的「设为当前账号」）
  activeAccountId: '',
  // 失效 / 被限流时自动换号。保持原来的行为（开着）；想学参考插件那样更保守可以关掉
  autoSwitch: true,
  // 定时换号间隔（分钟，0 = 关闭）
  switchIntervalMin: 0,
  defaultAccount: null, // 不指定时按账号池轮询
  port: Number(process.env.DEEPSEEK_BRIDGE_PORT || 18081),
  // 设置页卡片显示顺序（由设置页最下方的「页面设置」修改）
  sectionOrder: ['usage', 'engine', 'accounts', 'addAccount'],
};

// 可排序的卡片 key（顺序即默认顺序）
export const SECTION_KEYS = ['usage', 'engine', 'accounts', 'addAccount'];

export function ensureStateDir() {
  fs.mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
  migrateLegacyState();
}

let migrated = false;
/** 把老版本放在插件包里的 state/ 复制到新的用户目录（只做一次，不覆盖已有数据） */
function migrateLegacyState() {
  if (migrated) return;
  migrated = true;
  try {
    if (!fs.existsSync(LEGACY_STATE_DIR)) return;
    const already = fs.readdirSync(STATE_DIR).filter((f) => f !== 'assets');
    if (already.length > 0) return;
    for (const name of fs.readdirSync(LEGACY_STATE_DIR)) {
      if (name === 'assets') continue;
      const from = path.join(LEGACY_STATE_DIR, name);
      const to = path.join(STATE_DIR, name);
      if (!fs.existsSync(to)) fs.copyFileSync(from, to);
    }
  } catch {}
}

export function normalizeSectionOrder(input) {
  const out = [];
  if (Array.isArray(input)) {
    for (const k of input) {
      if (typeof k === 'string' && SECTION_KEYS.includes(k) && !out.includes(k)) out.push(k);
    }
  }
  for (const k of SECTION_KEYS) if (!out.includes(k)) out.push(k);
  return out;
}

export function loadConfig() {
  ensureStateDir();
  let saved = {};
  try {
    saved = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  } catch {}
  const cfg = { ...DEFAULTS, ...saved };
  cfg.sectionOrder = normalizeSectionOrder(cfg.sectionOrder);
  if (process.env.DS_SEND_GAP_MS) cfg.sendGapMs = Number(process.env.DS_SEND_GAP_MS);
  if (process.env.DS_MAX_CONCURRENCY) cfg.maxConcurrency = Number(process.env.DS_MAX_CONCURRENCY);
  if (process.env.DS_REQUEST_MODE) cfg.requestMode = String(process.env.DS_REQUEST_MODE);
  return cfg;
}

// 恢复出厂设置：写回 DEFAULTS（不触碰账号/token）
export function resetConfig() {
  ensureStateDir();
  const clean = { ...DEFAULTS };
  clean.sectionOrder = normalizeSectionOrder(DEFAULTS.sectionOrder);
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(clean, null, 2), { mode: 0o600 });
  return clean;
}

export function saveConfig(patch) {
  ensureStateDir();
  const next = { ...loadConfig(), ...patch };
  // 只接受已知字段，避免被写入奇怪内容
  const clean = {};
  for (const key of Object.keys(DEFAULTS)) {
    if (next[key] !== undefined) clean[key] = next[key];
  }
  clean.sendGapMs = Math.max(0, Math.min(60000, Number(clean.sendGapMs) || 0));
  clean.requestMode = ['raw', 'safe'].includes(clean.requestMode) ? clean.requestMode : 'raw';
  clean.idleStopMs = Math.max(60000, Math.min(24 * 3600 * 1000, Number(clean.idleStopMs) || DEFAULTS.idleStopMs));
  clean.maxConcurrency = Math.max(1, Math.min(16, Number(clean.maxConcurrency) || DEFAULTS.maxConcurrency));
  clean.autoStart = clean.autoStart !== false;
  clean.showToolNarration = clean.showToolNarration === true;
  clean.autoRelogin = clean.autoRelogin !== false;
  clean.autoSwitch = clean.autoSwitch === true;
  clean.probeIntervalMs = Math.max(0, Math.min(24 * 3600 * 1000, Number(clean.probeIntervalMs) || 0));
  clean.switchIntervalMin = Math.max(0, Math.min(1440, Number(clean.switchIntervalMin) || 0));
  clean.activeAccountId = typeof clean.activeAccountId === 'string' ? clean.activeAccountId.trim().slice(0, 40) : '';
  clean.loginRegion = ['auto', 'cn', 'global'].includes(clean.loginRegion) ? clean.loginRegion : 'auto';
  clean.loginHost = String(clean.loginHost || '').trim().slice(0, 120);
  clean.embedLogin = clean.embedLogin !== false;
  clean.saveLoginCredential = clean.saveLoginCredential !== false;
  clean.sectionOrder = normalizeSectionOrder(clean.sectionOrder);
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(clean, null, 2), { mode: 0o600 });
  return clean;
}
