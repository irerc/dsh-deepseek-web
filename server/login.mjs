// 登录相关：token 校验、邮箱验证码（尽力而为）、游客挑战（自检用）
import { post, get, classify } from './http.mjs';
import { loadConfig } from './config.mjs';
import { deviceId } from './accounts.mjs';

/** 校验一个 userToken 是否有效，返回 { ok, user?, message? } */
export async function checkToken(token) {
  if (!token || typeof token !== 'string' || token.length < 20) return { ok: false, message: 'token 格式不对' };
  try {
    const res = await get('/api/v0/users/current', { token });
    if (res.status === 200 && res.json?.code === 0) {
      // 这个接口的 biz_data 直接就是 user 对象（不是包在 biz_data.user 里），之前取不到邮箱就是这里错了
      const biz = res.json?.data?.biz_data || {};
      const user = biz.user || (biz.id || biz.email ? biz : null);
      return { ok: true, user };
    }
    return { ok: false, message: res.json?.msg || 'token 已失效，请重新登录后再粘贴' };
  } catch (error) {
    return { ok: false, message: '校验失败：' + (error.message || error) };
  }
}

/**
 * 请求邮箱验证码。
 * 说明：站点对发码接口启用了人机验证（reCAPTCHA/turnstile），无浏览器时通常会被拒绝；
 * 这里如实返回上游原因，引导用户改用「粘贴 token」。
 */
export async function sendEmailCode(email) {
  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return { ok: false, message: '邮箱格式不对' };
  }
  try {
    const res = await post('/api/v0/users/create_email_verification_code', {
      email,
      turnstile_token: null,
      locale: loadConfig().loginRegion === 'global' ? 'en_US' : 'zh_CN',
      shumei_verification: null,
      hcaptcha_token: null,
      device_id: deviceId(),
      scenario: 'register',
    });
    const biz = res.json?.data?.biz_code;
    if (res.status === 200 && res.json?.code === 0 && biz === 0) {
      return { ok: true, message: '验证码已发送，请查收邮箱' };
    }
    const reason = res.json?.data?.biz_msg || res.json?.msg || res.text?.slice(0, 120);
    return {
      ok: false,
      message:
        reason === 'RECAPTCHA_VERIFY_FAILED'
          ? '站点要求人机验证（reCAPTCHA），命令行环境无法完成，请改用「粘贴 token」登录'
          : '发码失败：' + reason,
    };
  } catch (error) {
    return { ok: false, message: '发码失败：' + (error.message || error) };
  }
}

/**
 * 邮箱 + 密码登录（不走浏览器）。
 * 说明：/api/v0/users/login 接受明文 JSON，不需要人机验证；
 * 新设备首次登录会要求邮箱验证码（MFA），此时返回 needCode + mfaSessionId。
 */
export async function loginWithPassword(email, password, opts = {}) {
  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return { ok: false, message: '邮箱格式不对' };
  if (!password || String(password).length < 6) return { ok: false, message: '密码看起来不对（至少 6 位）' };
  try {
    const res = await post('/api/v0/users/login', {
      email,
      password,
      device_id: deviceId(),
      os: 'android',
    });
    const biz = res.json?.data?.biz_data || {};
    const code = res.json?.data?.biz_code;
    const msg = res.json?.data?.biz_msg || res.json?.msg || '';
    if (code === 0 && biz?.user?.token) {
      return { ok: true, token: biz.user.token, user: biz.user };
    }
    if (code === 14 || /MFA/i.test(msg)) {
      return {
        ok: false,
        needCode: true,
        mfaSessionId: biz?.mfa_session_id || biz?.mfaSessionId || '',
        message: '该账号需要邮箱验证码：已发送或请先点「发送验证码」，再填入 6 位码登录',
      };
    }
    return { ok: false, message: '登录失败：' + (msg || '未知原因（' + JSON.stringify(res.json?.data || {}).slice(0, 120) + '）') };
  } catch (error) {
    return { ok: false, message: '登录失败：' + (error.message || error) };
  }
}

/** 触发邮箱验证码（MFA 流程），需要 PoW */
export async function sendMfaCode(mfaSessionId) {
  try {
    const challengeRes = await post('/api/v0/users/create_guest_challenge', { target_path: '/api/v0/users/mfa/create_verification_code' });
    const ch = challengeRes.json?.data?.biz_data?.guest_challenge;
    let pow = null;
    if (ch) {
      const { solvePowHeader } = await import('./pow.mjs');
      pow = await solvePowHeader(ch, '/api/v0/users/mfa/create_verification_code');
    }
    const res = await post(
      '/api/v0/users/mfa/create_verification_code',
      { mfa_session_id: mfaSessionId, device_id: deviceId() },
      pow ? { headers: { 'x-ds-pow-response': pow } } : undefined,
    );
    if (res.json?.data?.biz_code === 0) return { ok: true, message: '验证码已发送，请查收邮箱' };
    return { ok: false, message: '发码失败：' + (res.json?.data?.biz_msg || res.json?.msg || '未知原因') };
  } catch (error) {
    return { ok: false, message: '发码失败：' + (error.message || error) };
  }
}

/** 用邮箱验证码完成 MFA 登录，成功返回 token */
export async function loginWithMfaCode(mfaSessionId, code) {
  if (!mfaSessionId) return { ok: false, message: '缺少 mfa_session_id，请先做一次密码登录' };
  if (!/^\d{4,8}$/.test(String(code || '').trim())) return { ok: false, message: '验证码格式不对' };
  try {
    const res = await post('/api/v0/users/mfa/check_verification_code', {
      mfa_session_id: mfaSessionId,
      code: String(code).trim(),
    });
    const biz = res.json?.data?.biz_data || {};
    if (res.json?.data?.biz_code === 0 && biz?.user?.token) return { ok: true, token: biz.user.token, user: biz.user };
    return { ok: false, message: '验证失败：' + (res.json?.data?.biz_msg || res.json?.msg || '未知原因') };
  } catch (error) {
    return { ok: false, message: '验证失败：' + (error.message || error) };
  }
}

/** 邮箱验证码登录：站点要求加密体 + 人机验证，这里作为兜底返回明确提示 */
export async function loginWithEmailCode() {
  return {
    ok: false,
    message: '邮箱验证码登录需要浏览器完成人机验证，请改用「粘贴 token」：在浏览器登录 chat.deepseek.com 后复制 token',
  };
}

/** 游客 PoW 挑战（doctor 自检用，不创建账号） */
export async function fetchGuestChallenge() {
  const res = await post(
    '/api/v0/users/create_guest_challenge',
    { target_path: '/api/v0/users/register' },
    { timeoutMs: 15000 },
  );
  if (res.json?.data?.biz_code === 0) return res.json.data.biz_data.guest_challenge;
  throw classify(res, '获取游客挑战');
}
