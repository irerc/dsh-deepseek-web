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
      return { ok: true, user: res.json?.data?.biz_data?.user || null };
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
