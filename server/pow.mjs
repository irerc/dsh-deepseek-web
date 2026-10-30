// PoW 求解：DeepSeekHashV1
//
// 站点用 Rust 编译的 wasm 算工作量证明。前端胶水揭示的约定：
//   prefix = `${salt}_${expire_at}_`
//   wasm_solve(retptr, challengePtr, challengeLen, prefixPtr, prefixLen, difficulty)
//   结果：retptr+0 为 int32 状态（0 = 没解），retptr+8 为 f64 答案
// 注意：challenge 过期（expire_at 在过去）会直接返回 0，所以必须用服务端刚下发的挑战。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WASM_FILE = path.join(HERE, 'sha3_wasm_bg.wasm');

let runtime = null;

async function load() {
  if (runtime) return runtime;
  const bytes = fs.readFileSync(WASM_FILE);
  const { instance } = await WebAssembly.instantiate(bytes, {});
  const ex = instance.exports;
  const pushString = (text) => {
    const buf = Buffer.from(text, 'utf8');
    const ptr = ex.__wbindgen_export_0(buf.length, 1) >>> 0;
    new Uint8Array(ex.memory.buffer, ptr, buf.length).set(buf);
    return { ptr, len: buf.length };
  };
  runtime = { ex, pushString };
  return runtime;
}

/** 求解一个挑战，返回可放进 x-ds-pow-response 的对象 */
export async function solvePow(challenge) {
  if (!challenge || challenge.algorithm !== 'DeepSeekHashV1') {
    throw new Error('不支持的 PoW 算法：' + (challenge && challenge.algorithm));
  }
  const rt = await load();
  const prefix = `${challenge.salt}_${challenge.expire_at}_`;
  const stack = rt.ex.__wbindgen_add_to_stack_pointer(-16);
  const a = rt.pushString(String(challenge.challenge));
  const b = rt.pushString(prefix);
  try {
    rt.ex.wasm_solve(stack, a.ptr, a.len, b.ptr, b.len, Number(challenge.difficulty));
    const view = new DataView(rt.ex.memory.buffer);
    const status = view.getInt32(stack, true);
    const answer = view.getFloat64(stack + 8, true);
    if (!status || !Number.isFinite(answer)) {
      const expired = Number(challenge.expire_at) < Date.now();
      throw new Error(expired ? 'PoW 挑战已过期' : 'PoW 无解（difficulty=' + challenge.difficulty + '）');
    }
    return {
      algorithm: challenge.algorithm,
      challenge: challenge.challenge,
      salt: challenge.salt,
      answer,
      signature: challenge.signature,
    };
  } finally {
    rt.ex.__wbindgen_add_to_stack_pointer(16);
  }
}

/** 生成 x-ds-pow-response 头的值（base64 JSON，带 target_path） */
export async function solvePowHeader(challenge, targetPath) {
  const answer = await solvePow(challenge);
  return Buffer.from(JSON.stringify({ ...answer, target_path: targetPath }), 'utf8').toString('base64');
}

/** doctor 自检：用未过期的合成挑战验证 wasm 可跑通 */
export async function selfTest() {
  const out = await solvePow({
    algorithm: 'DeepSeekHashV1',
    challenge: '0'.repeat(64),
    salt: '0'.repeat(20),
    difficulty: 1000,
    expire_at: Date.now() + 300000,
    signature: 'self-test',
  });
  return Number.isFinite(out.answer);
}
