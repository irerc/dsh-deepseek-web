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

// 配置版本：用于一次性迁移（v1 = 1.0.56 及以前，transport 默认 browser；v2 = 1.0.57 起默认 auto）
export const CONFIG_VERSION = 2;

export const DEFAULTS = {
  configVersion: CONFIG_VERSION,
  autoStart: true, // 首次调用时自动拉起引擎
  idleStopMs: 10 * 60 * 1000, // 空闲多久关停引擎
  // 同一账号两次请求的间隔：**随机区间**（min~max）。固定间隔方差≈0，统计上就是「定时器特征」，
  // 真人打字不是等距的 —— 参考实现用 2000~4000ms 随机区间（cuckoo-code 从未被风控）。
  sendGapMs: 2500,
  sendGapMaxMs: 4500,
  // 请求模式：raw 原始（提示词原样、不加额外说明）| safe 保险（提示词里插使用规范 + 更慢更保守）
  requestMode: 'raw',
  // 传输层：browser 走真实 Chromium 页面发请求（TLS/JA4 指纹 = 浏览器，PoW 也在页面里解）
  //         node 直连（旧实现，Node 的 TLS 指纹能被判成非浏览器；B 站/风控侧更易识别）
  // 参考实现 0.7.0 起把浏览器列为**破坏性变更的默认**：auto = 优先真实浏览器，起不来才退回 Node（并在设置页亮红字）。
  // 想强制「没浏览器就报错、不许回退」选 browser；想彻底用旧实现选 node。
  transport: 'auto',
  // 自定义浏览器可执行文件路径（自动探测找不到、或想指定某个版本时填）。空 = 自动探测。
  browserPath: '',
  // native 传输用的 Python 解释器路径（空 = 自动找 python3；依赖装在 <STATE>/native-libs，不动系统 Python）
  nativePython: '',
  maxConcurrency: 4, // 全局并发上限
  // 同一账号并发：强制 1。参考实现实测「双窗口并发 6 分钟内被限流 1 天」——
  // 这是所有封号原因里最硬的一条，不给用户调大的口子。
  perAccountConcurrency: 1,
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
  // 滚动窗口限速：这段时间内最多发这么多次，超了就长休（小间隙洗不掉这个计数）。
  // 参考实现默认「30 分钟最多 20 次」—— 实测被吊销那晚是 22:31→22:53 共 49 次、间隔 8~12 秒。
  rateWindowMs: 30 * 60 * 1000,
  rateMaxInWindow: 20,
  // 人类节律（默认开）：间隔按「这次要打多少字」加打字时间、按本地作息放大深夜间隔、
  // 小概率插入走神停顿，并对每个账号做 24 小时滑动的每日上限。
  // 风控的主判据本来就是频率/体量/作息这些统计特征 —— 比 TLS 指纹更难洗。
  humanRhythm: process.env.DS_HUMAN_RHYTHM !== '0',
  dailyMsgs: Math.max(0, Number(process.env.DS_DAILY_MSGS || 240)), // 每账号 24h 上限，0 = 关闭
  nightQuiet: process.env.DS_NIGHT_QUIET !== '0',
  // 登录后先闲聊：新账号第一次发消息前，像人一样随便聊 warmupMsgs 句（默认 2）。
  // 改变不了自动化访问的性质，只让「账号的前几条消息」看起来像人。
  warmup: process.env.DS_WARMUP !== '0',
  warmupMsgs: Math.max(0, Math.min(4, Number(process.env.DS_WARMUP_MSGS || 2))),
  // 失效 / 被限流时自动换号。**默认关**（参考实现：几分钟内换号继续发是极强的机器行为特征，
  // 多号交替活跃反而更容易被判定成「多开小号」）。想恢复旧行为去「高级选项（高危）」里打开。
  autoSwitch: false,
  // 定时换号间隔（分钟，0 = 关闭）
  switchIntervalMin: 0,
  defaultAccount: null, // 不指定时按账号池轮询
  port: Number(process.env.DEEPSEEK_BRIDGE_PORT || 18081),
  // 设置页卡片显示顺序（由设置页最下方的「页面设置」修改）
  sectionOrder: ['usage', 'ledger', 'engine', 'accounts', 'addAccount', 'sessions', 'diagnostics'],
};

// 可排序的卡片 key（顺序即默认顺序）
export const SECTION_KEYS = ['usage', 'ledger', 'engine', 'accounts', 'addAccount', 'sessions', 'diagnostics'];

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
  // 迁移：1.0.56 及以前 transport 的默认值就是 'browser'，没法区分「用户主动选的」还是「默认值」。
  // 统一迁到 auto（优先浏览器、起不来才回退 Node 并亮红字）——用户仍可在设置页一键改回强制 browser。
  if (saved.configVersion === undefined) {
    if (cfg.transport === 'browser') cfg.transport = 'auto';
    cfg.configVersion = CONFIG_VERSION;
    try {
      const merged = { ...DEFAULTS, ...saved, transport: cfg.transport, configVersion: CONFIG_VERSION };
      fs.writeFileSync(CONFIG_FILE, JSON.stringify(merged, null, 2), { mode: 0o600 });
    } catch {}
  }
  cfg.sectionOrder = normalizeSectionOrder(cfg.sectionOrder);
  if (process.env.DS_SEND_GAP_MS) cfg.sendGapMs = Number(process.env.DS_SEND_GAP_MS);
  if (process.env.DS_SEND_GAP_MAX_MS) cfg.sendGapMaxMs = Number(process.env.DS_SEND_GAP_MAX_MS);
  if (process.env.DS_RATE_WINDOW_MIN) cfg.rateWindowMs = Number(process.env.DS_RATE_WINDOW_MIN) * 60000;
  if (process.env.DS_RATE_MAX_IN_WINDOW) cfg.rateMaxInWindow = Number(process.env.DS_RATE_MAX_IN_WINDOW);
  if (process.env.DS_MAX_CONCURRENCY) cfg.maxConcurrency = Number(process.env.DS_MAX_CONCURRENCY);
  if (process.env.DS_REQUEST_MODE) cfg.requestMode = String(process.env.DS_REQUEST_MODE);
  if (process.env.DS_NETWORK_TRANSPORT) cfg.transport = String(process.env.DS_NETWORK_TRANSPORT);
  if (process.env.DS_BROWSER_PATH) cfg.browserPath = String(process.env.DS_BROWSER_PATH);
  if (process.env.DS_AUTO_SWITCH === '1') cfg.autoSwitch = true;
  if (process.env.DS_AUTO_SWITCH === '0') cfg.autoSwitch = false;
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
  clean.sendGapMaxMs = Math.max(0, Math.min(120000, Number(clean.sendGapMaxMs) || 0));
  if (clean.sendGapMaxMs < clean.sendGapMs) clean.sendGapMaxMs = clean.sendGapMs;
  clean.rateWindowMs = Math.max(60000, Math.min(12 * 3600 * 1000, Number(clean.rateWindowMs) || DEFAULTS.rateWindowMs));
  clean.rateMaxInWindow = Math.max(0, Math.min(600, Number(clean.rateMaxInWindow) || 0));
  clean.humanRhythm = clean.humanRhythm !== false;
  clean.dailyMsgs = Math.max(0, Math.min(5000, Number(clean.dailyMsgs) || 0));
  clean.nightQuiet = clean.nightQuiet !== false;
  clean.warmup = clean.warmup !== false;
  clean.warmupMsgs = Math.max(0, Math.min(4, Number(clean.warmupMsgs) || 0));
  clean.requestMode = ['raw', 'safe'].includes(clean.requestMode) ? clean.requestMode : 'raw';
  clean.transport = ['auto', 'device', 'browser', 'native', 'node'].includes(clean.transport) ? clean.transport : 'auto';
  clean.browserPath = String(clean.browserPath || '').trim().slice(0, 300);
  clean.nativePython = String(clean.nativePython || '').trim().slice(0, 300);
  clean.idleStopMs = Math.max(60000, Math.min(24 * 3600 * 1000, Number(clean.idleStopMs) || DEFAULTS.idleStopMs));
  clean.maxConcurrency = Math.max(1, Math.min(16, Number(clean.maxConcurrency) || DEFAULTS.maxConcurrency));
  clean.perAccountConcurrency = 1;
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
