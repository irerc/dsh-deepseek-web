#!/usr/bin/env node
// dsh-deepseek-web 命令行：登录 / 账号 / 启停 / 自检
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadConfig, STATE_DIR, ensureStateDir } from '../server/config.mjs';
import * as accounts from '../server/accounts.mjs';
import { checkToken, sendEmailCode } from '../server/login.mjs';
import { solvePow } from '../server/pow.mjs';
import { fetchGuestChallenge } from '../server/login.mjs';

const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SERVER = path.join(PKG_ROOT, 'server', 'server.mjs');
const PID_FILE = path.join(STATE_DIR, 'engine.pid');
const PORT = Number(process.env.DEEPSEEK_BRIDGE_PORT || 18081);
const args = process.argv.slice(2);
const cmd = args[0] || 'help';
const flag = (name, fallback = null) => {
  const i = args.indexOf('--' + name);
  return i >= 0 ? args[i + 1] : fallback;
};

const probe = () =>
  new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port: PORT, path: '/health', timeout: 2000 }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ ok: res.statusCode === 200, body }));
    });
    req.on('timeout', () => {
      req.destroy();
      resolve({ ok: false, body: '' });
    });
    req.on('error', () => resolve({ ok: false, body: '' }));
  });

async function login() {
  const token = flag('token');
  const email = flag('email');
  const label = flag('label') || undefined;
  if (token) {
    const check = await checkToken(token);
    if (!check.ok) {
      console.error('登录失败：' + check.message);
      process.exit(1);
    }
    const account = accounts.addAccount({ token, label });
    console.log('已登录并保存账号：' + account.label + ' (' + account.id + ')');
    return;
  }
  if (email) {
    const out = await sendEmailCode(email);
    console.log(out.message);
    if (!out.ok) process.exit(2);
    console.log('把收到的 6 位验证码作为 --code 传进来（该流程需要浏览器人机验证时可能不可用）');
    return;
  }
  console.log(`登录方式二选一：
  1) dsh-deepseek-web login --token <userToken> [--label 工作号]
     在浏览器登录 https://chat.deepseek.com 后，控制台执行：
       JSON.parse(localStorage.userToken).value
     复制结果粘贴到命令里。
  2) dsh-deepseek-web login --email <邮箱>     # 站点可能要求人机验证`);
}

function status() {
  return probe().then(async ({ ok, body }) => {
    console.log(ok ? '桥接器在线 ' + body : '桥接器未运行');
    const list = accounts.listAccounts();
    if (!list.length) console.log('（还没有登录任何账号）');
    for (const a of list) console.log(`  - ${a.label} [${a.status}] 最后使用 ${a.lastUsedAt ? new Date(a.lastUsedAt).toLocaleString() : '从未'}`);
  });
}

async function start() {
  const { ok } = await probe();
  if (ok) {
    console.log('已在运行');
    return;
  }
  ensureStateDir();
  const out = fs.openSync(path.join(STATE_DIR, 'engine.log'), 'a');
  const cfg = loadConfig();
  const child = spawn(process.execPath, [SERVER], {
    env: { ...process.env, DEEPSEEK_BRIDGE_PORT: String(PORT), DS_SEND_GAP_MS: String(cfg.sendGapMs) },
    stdio: ['ignore', out, out],
    detached: true,
  });
  child.unref();
  fs.writeFileSync(PID_FILE, String(child.pid));
  console.log('启动中 pid=' + child.pid + '，日志 ' + path.join(STATE_DIR, 'engine.log'));
}

function stop() {
  try {
    const pid = Number(fs.readFileSync(PID_FILE, 'utf8'));
    process.kill(pid, 'SIGTERM');
    fs.unlinkSync(PID_FILE);
    console.log('已停止 pid=' + pid);
  } catch {
    console.log('没有找到 pid 文件（可能未由 CLI 启动）');
  }
}

async function doctor() {
  console.log('node      ', process.version, process.arch);
  console.log('状态目录  ', STATE_DIR);
  try {
    const challenge = await fetchGuestChallenge();
    const t0 = Date.now();
    const answer = await solvePow(challenge);
    console.log('pow       ', 'OK', Date.now() - t0 + 'ms', 'answer=' + answer.answer);
  } catch (error) {
    console.log('pow       ', 'FAIL', error.message);
  }
  const list = accounts.listAccounts();
  console.log('账号      ', list.length ? list.map((a) => a.label + ':' + a.status).join(', ') : '无');
  if (list.length) {
    const token = accounts.getToken(list[0].id);
    const check = await checkToken(token);
    console.log('token     ', check.ok ? '有效' : '无效：' + check.message);
  }
  const { ok } = await probe();
  console.log('端口      ', '127.0.0.1:' + PORT, ok ? '在线' : '未运行');
}

const commands = { login, status, start, stop, doctor };
if (cmd === 'accounts') {
  const sub = args[1] || 'list';
  if (sub === 'list') {
    const list = accounts.listAccounts();
    if (!list.length) console.log('还没有账号');
    for (const a of list) console.log(`${a.id}  ${a.label}  [${a.status}]`);
  } else if (sub === 'remove') {
    console.log(accounts.removeAccount(args[2]) ? '已删除' : '没找到');
  } else {
    console.log('用法：dsh-deepseek-web accounts [list|remove <id>]');
  }
  process.exit(0);
}
if (commands[cmd]) {
  await commands[cmd]();
} else {
  console.log(`用法：dsh-deepseek-web <login|accounts|start|stop|status|doctor>

  login --token <token> [--label 名称]   粘贴浏览器 userToken 登录
  login --email <邮箱>                    请求邮箱验证码（可能需要人机验证）
  accounts [list|remove <id>]             查看/删除账号
  start / stop / status                   启停桥接器
  doctor                                  自检（PoW、账号、端口）`);
}
