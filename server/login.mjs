// 登录相关：token 校验、邮箱验证码（尽力而为）、游客挑战（自检用）
import { post, get, classify } from './http.mjs';
import { loadConfig } from './config.mjs';
import { deviceId } from './accounts.mjs';
import { probeToken } from './token-check.mjs';

/**
 * 校验一个 userToken 是否有效，返回 { ok, invalid, user?, message? }
 * invalid=true 表示站点明确说这个 token 死了（401 / 40002 / 40003）；
 * 网络抖动、WAF 拦截页、限流只会让 invalid=false + ok=false，调用方不要因此改账号状态。
 */
export async function checkToken(token) {
  if (!token || typeof token !== 'string' || token.length < 20) return { ok: false, invalid: true, message: 'token 格式不对' };
  const probe = await probeToken(token);
  if (probe.state === 'valid') return { ok: true, invalid: false, user: probe.user };
  if (probe.state === 'invalid') return { ok: false, invalid: true, message: probe.message || 'token 已失效，请重新登录后再粘贴' };
  // unknown：没验出来，不代表失效
  return { ok: false, invalid: false, message: '校验失败：' + (probe.message || '未知原因') };
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
  const devId = opts.deviceId || deviceId();
  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return { ok: false, message: '邮箱格式不对' };
  if (!password || String(password).length < 6) return { ok: false, message: '密码看起来不对（至少 6 位）' };
  try {
    // 字段和站点前端保持一致（多了 mobile/area_code 空串、os=web）：
    // 少字段的请求更容易被风控当成脚本，见 RISK_DEVICE_DETECTED
    const res = await post('/api/v0/users/login', {
      email,
      mobile: '',
      area_code: '',
      password,
      device_id: devId,
      os: 'web',
    });
    const biz = res.json?.data?.biz_data || {};
    const code = res.json?.data?.biz_code;
    const msg = res.json?.data?.biz_msg || res.json?.msg || '';
    if (code === 0 && biz?.user?.token) {
      return { ok: true, token: biz.user.token, user: biz.user };
    }
    // 站点前置的 WAF：不返回 JSON，直接 202 challenge（或 403 Request Blocked / 40029 限 IP）。
    // 这条路脚本走不通，只能让真实浏览器去登，别当成「密码错」。
    if (!res.json || res.status === 202 || res.status === 403) {
      return { ok: false, waf: true, message: '站点前置风控拦截（HTTP ' + res.status + '），密码登录这条路走不通，请用「浏览器登录」' };
    }
    if (res.json?.code === 40029) {
      return { ok: false, waf: true, message: '站点按 IP 限流（40029），过一会儿或用「浏览器登录」' };
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

/**
 * 用 Apple 登录拿到的 id_token 换取 DeepSeek 登录态（对应站点 /oauth/apple/login）。
 * 站点前端是：AppleID.auth.signIn() → id_token → 这里换 token。
 */
export async function loginWithAppleIdToken(idToken) {
  if (!idToken || String(idToken).length < 20) return { ok: false, message: 'Apple 没有返回有效凭证' };
  const APPLE_CODE = {
    1: { needBindMobile: true, message: '这个 Apple 账号还没绑定手机号：站点要求先绑一个手机号，请在浏览器登录页用 Apple 登录并按提示绑定一次' },
    2: { message: 'Apple 凭证校验失败（TOKEN_VERIFY_FAILED），请重新登录 Apple' },
    3: { banned: true, message: '这个账号已被站点封禁（ACCOUNT_BANNED）' },
    8: { message: '该邮箱已经绑定过另一个 Apple 账号' },
    9: { message: '这个 Apple 账号已经绑定了别的邮箱' },
    10: { banned: true, message: '这个账号已被站点停用（USER_IS_BANNED）' },
    11: { risk: true, message: '站点判定本机设备存在风控（RISK_DEVICE_DETECTED），请改用「浏览器登录」' },
  };
  try {
    const res = await post('/api/v0/users/oauth/apple/login', {
      device_id: deviceId(),
      id_token: String(idToken),
      os: 'web',
      sms_verification_code: '',
      area_code: '',
      mobile_number: '',
    });
    const biz = res.json?.data?.biz_data || {};
    const code = res.json?.data?.biz_code;
    const msg = res.json?.data?.biz_msg || res.json?.msg || '';
    if (code === 0 && biz?.user?.token) return { ok: true, token: biz.user.token, user: biz.user };
    if (!res.json || res.status === 202 || res.status === 403) {
      return { ok: false, waf: true, message: '站点前置风控拦截（HTTP ' + res.status + '），请用「浏览器登录」' };
    }
    const mapped = APPLE_CODE[code];
    if (mapped) return { ok: false, code, ...mapped };
    return { ok: false, code, message: 'Apple 登录失败：' + (msg || '未知原因（' + String(res.status) + '）') };
  } catch (error) {
    return { ok: false, message: 'Apple 登录失败：' + (error.message || error) };
  }
}
