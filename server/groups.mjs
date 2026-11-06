// 账号分组：只影响面板显示，不参与切号/会话调度
//
// 为什么单拆一个文件：分组是纯展示层的数据，读写只有 groups.json 一个口子，
// 与 accounts.mjs（凭证/冷却/轮询）完全解耦 —— 删组绝不碰账号，账号里的 groupId
// 变成悬挂指针时按「未分组」处理即可。
//
// 分工：groups.json 存组的定义（id / name / order），账号记录里只存一个 groupId。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { STATE_DIR, ensureStateDir } from './config.mjs';

const GROUPS_FILE = path.join(STATE_DIR, 'groups.json');
const MAX_GROUPS = 12;
export const UNGROUPED_KEY = '__ungrouped__';

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

/** 规整组名：去控制字符/换行、压缩连续空白、截到 20 字（会进 title/option 文本节点） */
export function normalizeGroupName(raw) {
  if (typeof raw !== 'string') return '';
  return raw
    .replace(/[\u0000-\u001f\u007f\u200b-\u200f\ufeff]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 20);
}

/** 读盘容错：坏条目丢掉，不让一条脏数据把整个分组表读不出来 */
export function normalizeGroupList(raw) {
  if (!Array.isArray(raw)) return [];
  const seen = new Set();
  const out = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const id = typeof item.id === 'string' ? item.id.trim() : '';
    const name = normalizeGroupName(item.name);
    if (!id || !name || seen.has(id)) continue;
    const order = Number.isFinite(Number(item.order)) ? Number(item.order) : out.length;
    seen.add(id);
    out.push({ id, name, order });
  }
  out.sort((a, b) => a.order - b.order || a.name.localeCompare(b.name));
  return out.slice(0, MAX_GROUPS).map((group, index) => ({ ...group, order: index }));
}

export function readGroups() {
  return normalizeGroupList(readJson(GROUPS_FILE, []));
}

function writeGroups(list) {
  ensureStateDir();
  const tmp = GROUPS_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(normalizeGroupList(list), null, 2), { mode: 0o600 });
  fs.renameSync(tmp, GROUPS_FILE);
}

function newGroupId(taken) {
  const used = new Set(taken);
  for (let i = 0; i < 32; i += 1) {
    const id = 'g_' + crypto.randomBytes(4).toString('hex');
    if (!used.has(id)) return id;
  }
  return 'g_' + crypto.randomBytes(6).toString('hex');
}

/** 新建组：空名 / 重名 / 超上限时返回 error（不改动现有列表） */
export function createGroup(rawName) {
  const current = readGroups();
  const name = normalizeGroupName(rawName);
  if (!name) return { ok: false, error: '组名不能为空', list: current };
  if (current.length >= MAX_GROUPS) return { ok: false, error: '最多 ' + MAX_GROUPS + ' 个组', list: current };
  if (current.some((group) => group.name === name)) return { ok: false, error: '已经有一个叫「' + name + '」的组了', list: current };
  const group = { id: newGroupId(current.map((item) => item.id)), name, order: current.length };
  const list = [...current, group];
  writeGroups(list);
  return { ok: true, group, list };
}

export function renameGroup(id, rawName) {
  const current = readGroups();
  const name = normalizeGroupName(rawName);
  if (!name) return { ok: false, error: '组名不能为空', list: current };
  if (!current.some((group) => group.id === id)) return { ok: false, error: '组不存在', list: current };
  if (current.some((group) => group.id !== id && group.name === name)) return { ok: false, error: '已经有一个叫「' + name + '」的组了', list: current };
  const list = current.map((group) => (group.id === id ? { ...group, name } : group));
  writeGroups(list);
  return { ok: true, list, group: list.find((group) => group.id === id) };
}

/** 只删组定义、不删账号：账号里的 groupId 会变成悬挂指针，分区时归入「未分组」 */
export function removeGroup(id) {
  const list = readGroups()
    .filter((group) => group.id !== id)
    .map((group, index) => ({ ...group, order: index }));
  writeGroups(list);
  return { ok: true, list };
}

/** 把账号按组切成若干分区：当前账号所在的组置顶 → 其余按 order → 未分组垫底 */
export function partitionByGroup(accounts, groups, activeId) {
  const normalized = normalizeGroupList(groups);
  const known = new Set(normalized.map((group) => group.id));
  const buckets = new Map();
  const ungrouped = [];
  for (const account of accounts) {
    const gid = account.groupId && known.has(account.groupId) ? account.groupId : '';
    if (!gid) {
      ungrouped.push(account);
      continue;
    }
    const bucket = buckets.get(gid);
    if (bucket) bucket.push(account);
    else buckets.set(gid, [account]);
  }
  const activeGroupId = accounts.find((account) => account.id === activeId)?.groupId ?? '';
  const pinned = activeGroupId && known.has(activeGroupId) ? activeGroupId : '';
  const ordered = pinned
    ? [...normalized.filter((group) => group.id === pinned), ...normalized.filter((group) => group.id !== pinned)]
    : normalized;
  const sections = ordered.map((group) => ({
    key: group.id,
    name: group.name,
    groupId: group.id,
    accounts: buckets.get(group.id) ?? [],
  }));
  // 空组照样返回（建完立刻可见）；未分组为空时不返回
  if (ungrouped.length) sections.push({ key: UNGROUPED_KEY, name: '未分组', groupId: null, accounts: ungrouped });
  return sections;
}
