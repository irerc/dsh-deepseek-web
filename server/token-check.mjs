// token 体检：区分「真的失效」和「临时故障」
//
// 为什么单独拆出来：
//   - 站点对失效 token 的回应是确定的：HTTP 401 或 code=40002/40003（INVALID_TOKEN）；
//   - 但网络抖动、WAF 拦截页（HTTP 202 一段 HTML）、限流（429）看起来也是「不是 200」。
//     以前这些都被当成「登录失效」，账号被标成失效，用户以为被登出了，只能重新登一次，
//     实际上 token 一直是好的 —— 这就是「经常登录失效」里很大的一部分假警报。
//   - 现在任何地方要判断 token 是否真的失效，都先过这里：state = valid | invalid | unknown，
//     只有 invalid 才允许改账号状态，unknown 只记日志、不动账号。
import { get } from './http.mjs';

/**
 * 体检一个 token（只读，不消耗对话额度）
 * @param {string} token
 * @returns {Promise<{state:'valid'|'invalid'|'unknown', user?:object, message?:string, code?:string}>}
 */
export async function probeToken(token) {
  if (!token || typeof token !== 'string' || token.length < 20) {
    return { state: 'invalid', message: '没有可用的 token' };
  }
  try {
    const res = await get('/api/v0/users/current', { token, timeoutMs: 20000 });
    const code = res.json?.code;
    if (res.status === 200 && code === 0) {
      // 这个接口的 biz_data 直接就是 user 对象（不是包在 biz_data.user 里）
      const biz = res.json?.data?.biz_data || {};
      const user = biz.user || (biz.id || biz.email ? biz : null);
      return { state: 'valid', user };
    }
    if (res.status === 401 || code === 40002 || code === 40003) {
      return { state: 'invalid', message: res.json?.msg || 'INVALID_TOKEN', code: String(code ?? '') };
    }
    // 剩下的（429 限流、202/403 风控页、5xx、非 JSON）都只能算「没验出来」
    return {
      state: 'unknown',
      message: 'HTTP ' + res.status + (res.json?.msg ? '：' + res.json.msg : ''),
      code: String(code ?? ''),
    };
  } catch (error) {
    return { state: 'unknown', message: '网络请求失败：' + (error.message || error) };
  }
}
