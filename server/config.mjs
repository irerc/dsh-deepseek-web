// 运行配置：settings 界面改的就是这一个文件（唯一事实源）
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const STATE_DIR = process.env.DSH_DEEPSEEK_WEB_STATE || path.join(PKG_ROOT, 'state');
export const CONFIG_FILE = path.join(STATE_DIR, 'config.json');

export const DEFAULTS = {
  autoStart: true, // 首次调用时自动拉起引擎
  idleStopMs: 10 * 60 * 1000, // 空闲多久关停引擎
  sendGapMs: 1200, // 同一账号两次请求的最小间隔
  maxConcurrency: 4, // 全局并发上限
  perAccountConcurrency: 2,
  showToolNarration: false, // 调工具的轮次是否显示模型前面的说明文字（大号白字那种「我先看看 XX」）
  defaultAccount: null, // 不指定时按账号池轮询
  port: Number(process.env.DEEPSEEK_BRIDGE_PORT || 18081),
  // 设置页卡片显示顺序（由设置页最下方的「页面设置」修改）
  sectionOrder: ['usage', 'engine', 'accounts', 'addAccount', 'log'],
};

// 可排序的卡片 key（顺序即默认顺序）
export const SECTION_KEYS = ['usage', 'engine', 'accounts', 'addAccount', 'log'];

export function ensureStateDir() {
  fs.mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
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
  clean.idleStopMs = Math.max(60000, Math.min(24 * 3600 * 1000, Number(clean.idleStopMs) || DEFAULTS.idleStopMs));
  clean.maxConcurrency = Math.max(1, Math.min(16, Number(clean.maxConcurrency) || DEFAULTS.maxConcurrency));
  clean.autoStart = clean.autoStart !== false;
  clean.showToolNarration = clean.showToolNarration === true;
  clean.sectionOrder = normalizeSectionOrder(clean.sectionOrder);
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(clean, null, 2), { mode: 0o600 });
  return clean;
}
