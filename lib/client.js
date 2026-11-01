// 客户端设置分区：设置 → DeepSeek 网页版
//
// 手写的 __ModuleLoader__ 模块（无构建链）：只依赖宿主提供的 react。
// 所有数据都通过同源接口 /dsh-deepseek-web/* 读写（由 Host 插件注册）。
window.__ModuleLoader__.load({
  id: 'dsh-deepseek-web',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });
    const React = require('react');
    const h = React.createElement;
    const { useState, useEffect, useCallback } = React;

    const BASE = '/dsh-deepseek-web';
    const REPO_URL = 'https://github.com/irerc/dsh-deepseek-web';

    // 复制文本：WebView 里 navigator.clipboard 有时不可用，退回到临时 textarea + execCommand
    async function copyText(text) {
      try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          await navigator.clipboard.writeText(text);
          return true;
        }
      } catch {}
      try {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.cssText = 'position:fixed;left:-9999px;top:0';
        document.body.appendChild(ta);
        ta.select();
        const ok = document.execCommand('copy');
        ta.remove();
        return ok;
      } catch {
        return false;
      }
    }

    async function api(path, options) {
      const res = await fetch(BASE + path, {
        ...options,
        headers: { 'content-type': 'application/json', ...((options && options.headers) || {}) },
      });
      const text = await res.text();
      let data = null;
      try {
        data = JSON.parse(text);
      } catch {}
      if (!res.ok && data && data.error) throw new Error(typeof data.error === 'string' ? data.error : JSON.stringify(data.error));
      if (!res.ok && !data) throw new Error('HTTP ' + res.status + '（' + path + '）' + (res.status === 404 ? '：该功能需要重启 DSH 后才会加载' : ''));
      return data;
    }

    const S = {
      wrap: { display: 'flex', flexDirection: 'column', gap: 16, padding: '4px 2px', fontSize: 13 },
      card: {
        border: '1px solid var(--dsw-alias-border-l4, var(--border-color, rgba(128,128,128,.25)))',
        background: 'var(--dsw-alias-settings-card-fill, transparent)',
        borderRadius: 10,
        padding: 14,
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
      },
      row: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' },
      title: { fontSize: 13, fontWeight: 600, margin: 0 },
      hint: { color: 'var(--dsw-alias-label-caption, var(--text-secondary, #8a8f98))', fontSize: 12, lineHeight: 1.6, margin: 0 },
      input: {
        flex: '1 1 200px',
        minWidth: 0,
        padding: '7px 9px',
        borderRadius: 7,
        border: '1px solid var(--dsw-alias-border-l4, var(--border-color, rgba(128,128,128,.35)))',
        background: 'transparent',
        color: 'var(--dsw-alias-label-primary, inherit)',
        fontSize: 13,
      },
      textarea: {
        width: '100%',
        minHeight: 64,
        padding: '7px 9px',
        borderRadius: 7,
        border: '1px solid var(--dsw-alias-border-l4, var(--border-color, rgba(128,128,128,.35)))',
        background: 'transparent',
        color: 'var(--dsw-alias-label-primary, inherit)',
        fontSize: 12,
        fontFamily: 'monospace',
      },
      button: {
        padding: '7px 12px',
        borderRadius: 7,
        border: '1px solid var(--dsw-alias-border-l4, var(--border-color, rgba(128,128,128,.35)))',
        background: 'var(--dsw-alias-bg-layer-3, var(--button-bg, rgba(128,128,128,.12)))',
        color: 'var(--dsw-alias-label-primary, inherit)',
        cursor: 'pointer',
        fontSize: 13,
      },
      danger: { color: '#e5484d' },
      primary: { background: 'rgba(70,167,88,.22)', borderColor: 'rgba(70,167,88,.55)', color: '#3ddc6a', fontWeight: 600 },
      badge: (ok) => ({
        padding: '2px 8px',
        borderRadius: 999,
        fontSize: 11,
        background: ok ? 'rgba(70,167,88,.18)' : 'rgba(140,140,140,.22)',
        color: ok ? '#46a758' : 'var(--dsw-alias-label-primary, inherit)',
        border: '1px solid ' + (ok ? 'rgba(70,167,88,.35)' : 'var(--dsw-alias-border-l4, rgba(150,150,150,.35))'),
      }),
      log: { maxHeight: 160, overflow: 'auto', fontSize: 11, fontFamily: 'monospace', background: 'var(--dsw-alias-bg-layer-3, rgba(128,128,128,.08))', borderRadius: 8, padding: 8, whiteSpace: 'pre-wrap', margin: 0 },
    };

    function buildBookmarklet(origin) {
      const url = origin + BASE + '/login/token';
      return (
        'javascript:fetch(' + JSON.stringify(url) +
        ',{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({token:JSON.parse(localStorage.userToken).value,label:"浏览器"})})' +
        '.then(r=>r.json()).then(d=>alert(d.ok?"已保存到 DSH 插件":"保存失败："+JSON.stringify(d)))'
      );
    }

    function DeepSeekWebSection() {
      const [state, setState] = useState(null);
      const [error, setError] = useState('');
      const [busy, setBusy] = useState('');
      const ORDER_KEY = 'dsh-deepseek-web:sectionOrder';
      const rememberOrder = (arr) => {
        try {
          if (window.localStorage) {
            if (arr && arr.length) window.localStorage.setItem(ORDER_KEY, JSON.stringify(arr));
            else window.localStorage.removeItem(ORDER_KEY);
          }
        } catch {}
      };
      const [token, setToken] = useState('');
      const [cookieText, setCookieText] = useState('');
      const [label, setLabel] = useState('');
      const [email, setEmail] = useState('');
      const [code, setCode] = useState('');
      const [notice, setNotice] = useState('');
      const [updateInfo, setUpdateInfo] = useState('');
      const [upd, setUpd] = useState(null); // 最近一次检查更新的结果：{ current, latest, hasUpdate, installed }
      const [showManual, setShowManual] = useState(false);
      const [showEmail, setShowEmail] = useState(false);
      const [showLog, setShowLog] = useState(false);
      const [showPageSettings, setShowPageSettings] = useState(false);
      const [showNarrationHelp, setShowNarrationHelp] = useState(false);
      const [showUsageDetail, setShowUsageDetail] = useState(false);
      const [batchText, setBatchText] = useState('');
      const [password, setPassword] = useState('');
      const [mfaSessionId, setMfaSessionId] = useState('');
      const [batchPwdText, setBatchPwdText] = useState('');
      const [pendingMfa, setPendingMfa] = useState([]);
      const [pendingCodes, setPendingCodes] = useState({});
      const [savePassword, setSavePassword] = useState(true);
      const [pwdFor, setPwdFor] = useState('');
      const [pwdEmail, setPwdEmail] = useState('');
      const [pwdPass, setPwdPass] = useState('');
      const [confirmReset, setConfirmReset] = useState('');
      const [purgeAccounts, setPurgeAccounts] = useState(false);
      const [localOrder, setLocalOrder] = useState(() => {
        // 本机记住顺序：即使宿主未重启（旧 config 模块会丢弃 sectionOrder），刷新后顺序也不丢
        try {
          const raw = window.localStorage && window.localStorage.getItem(ORDER_KEY);
          const arr = raw ? JSON.parse(raw) : null;
          return Array.isArray(arr) && arr.length ? arr : null;
        } catch {}
        return null;
      });

      const refresh = useCallback(async () => {
        try {
          const data = await api('/state');
          setState(data);
          setError('');
        } catch (e) {
          setError(String(e.message || e));
        }
      }, []);

      useEffect(() => {
        refresh();
        const timer = setInterval(refresh, 4000);
        return () => clearInterval(timer);
      }, [refresh]);

      // 结果横幅留一会儿就自动消失，别一直挂在最上面
      useEffect(() => {
        if (!notice) return;
        const timer = setTimeout(() => setNotice(''), 15000);
        return () => clearTimeout(timer);
      }, [notice]);

      const run = async (name, fn) => {
        setBusy(name);
        setNotice('');
        try {
          const out = await fn();
          if (out && out.ok === false) setNotice(out.message || '操作失败');
          else if (out && out.message) setNotice(out.message);
          await refresh();
        } catch (e) {
          setNotice(String(e.message || e));
        } finally {
          setBusy('');
        }
      };

      const cfg = (state && state.config) || {};
      const list = (state && state.accounts) || [];
      const engineState = (state && state.engine) || 'unknown';
      const running = engineState === 'running';

      const saveCfg = (patch) => run('cfg', () => api('/config', { method: 'POST', body: JSON.stringify({ ...cfg, ...patch }) }));

      // 卡片顺序：由插件最下方的「页面设置」维护，存到 config.sectionOrder
      // token 数格式化：过万用 K，百万用 M，十亿用 B（Web 版的累计用量很容易到百万级）
      const fmtTokens = (n) => {
        const v = Number(n) || 0;
        const trim = (x) => String(x).replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');
        if (v >= 1e9) return trim((v / 1e9).toFixed(2)) + 'B';
        if (v >= 1e6) return trim((v / 1e6).toFixed(2)) + 'M';
        if (v >= 1e4) return trim((v / 1e3).toFixed(1)) + 'K';
        return v.toLocaleString();
      };

      const SECTION_LABELS = {
        usage: '网页版用量',
        engine: '运行设置（引擎状态）',
        accounts: '账号管理',
        addAccount: '添加账号',
      };
      const DEFAULT_ORDER = Object.keys(SECTION_LABELS);
      const serverOrder = Array.isArray(cfg.sectionOrder) ? cfg.sectionOrder.filter((k) => DEFAULT_ORDER.includes(k)) : [];
      for (const k of DEFAULT_ORDER) if (!serverOrder.includes(k)) serverOrder.push(k);
      // 本地顺序优先：即使宿主还没重启（旧 config 模块会丢弃 sectionOrder），界面也能即时生效
      const order = (localOrder || serverOrder).slice();
      // 还没有任何账号时，把「添加账号」临时置顶，省得用户往下找
      const noAccount = list.length === 0;
      const displayOrder = noAccount ? ['addAccount'] : [];
      for (const k of order) if (!displayOrder.includes(k)) displayOrder.push(k);
      const orderOf = (k) => {
        const i = displayOrder.indexOf(k);
        return i < 0 ? DEFAULT_ORDER.length : i;
      };
      const cardStyle = (k) => ({ ...S.card, order: orderOf(k) });
      const moveSection = (k, dir) => {
        const arr = order.slice();
        const i = arr.indexOf(k);
        const j = i + dir;
        if (i < 0 || j < 0 || j >= arr.length) return;
        const tmp = arr[i];
        arr[i] = arr[j];
        arr[j] = tmp;
        setLocalOrder(arr);
        rememberOrder(arr);
        saveCfg({ sectionOrder: arr });
      };

      return h(
        'div',
        { style: S.wrap },
        // 操作结果统一显示在最上方，不塞进某张卡片里（之前「检查更新」的结果跑到运行设置中间去了）
        notice
          ? h(
              'div',
              {
                style: {
                  display: 'flex',
                  alignItems: 'flex-start',
                  gap: 8,
                  padding: '8px 12px',
                  borderRadius: 8,
                  background: 'rgba(80,140,255,.12)',
                  border: '1px solid rgba(120,170,255,.35)',
                  fontSize: 13,
                  lineHeight: 1.6,
                  wordBreak: 'break-all',
                  whiteSpace: 'pre-wrap',
                },
              },
              h('span', { style: { flex: '1 1 auto' } }, notice),
              h(
                'button',
                {
                  style: { ...S.button, padding: '2px 8px', flex: '0 0 auto' },
                  onClick: () => setNotice(''),
                },
                '×',
              ),
            )
          : null,
        // 磁盘上装的是新版本、进程里还是旧版本：明确提示「要重启」，否则用户会以为没生效
        state && state.needRestart
          ? h(
              'div',
              {
                style: {
                  padding: '10px 12px',
                  borderRadius: 8,
                  background: 'rgba(255,150,40,.14)',
                  border: '1px solid rgba(255,150,40,.5)',
                  color: '#ffb056',
                  fontSize: 13,
                  lineHeight: 1.7,
                },
              },
              h('strong', null, '已安装 v' + (state.installedVersion || '') + '，需要重启 DSH 后生效'),
              h(
                'div',
                { style: { ...S.hint, color: '#ffb056', marginTop: 2 } },
                '当前运行的还是 v' + (state.version || '') + '。重启方法：完全关掉 DeepSeek Harness 应用（或设备上的 dsh web 进程）再打开，插件会自动以新版本启动。',
              ),
            )
          : null,
        h(
          'div',
          { style: cardStyle('engine') },
          h('h3', { style: S.title }, '运行设置'),
          h(
            'label',
            { style: S.row },
            h('input', { type: 'checkbox', checked: cfg.autoStart !== false, onChange: (e) => saveCfg({ autoStart: e.target.checked }) }),
            h('span', null, '选择模型后自动启动引擎'),
          ),
          h(
            'div',
            { style: S.row },
            h('span', { style: S.badge(false) }, '手动启动'),
            h('span', { style: { fontWeight: 600 } }, 'DeepSeek 网页版'),
            h(
              'span',
              {
                style:
                  cfg.autoStart === false && !running && engineState !== 'starting'
                    ? { ...S.badge(false), color: '#ff9632', background: 'rgba(255,150,40,.18)' }
                    : S.badge(running),
              },
              running ? '引擎运行中' : engineState === 'starting' ? '启动中' : cfg.autoStart !== false ? '待命（首次调用自动启动）' : '未启动（需手动点启动）',
            ),
            h('span', { style: { marginLeft: 'auto' } }),
            h('button', { style: S.button, disabled: busy === 'start', onClick: () => run('start', () => api('/engine/start', { method: 'POST' })) }, '启动'),
            h('button', { style: S.button, disabled: busy === 'stop', onClick: () => run('stop', () => api('/engine/stop', { method: 'POST' })) }, '停止'),
          ),
          h(
            'label',
            { style: S.row },
            h('input', {
              type: 'checkbox',
              checked: cfg.showToolNarration === true,
              onChange: (e) => saveCfg({ showToolNarration: e.target.checked }),
            }),
            h('span', null, '显示任务执行中的说明文字'),
            h(
              'span',
              {
                role: 'button',
                'aria-label': '说明',
                title: '模型在动手前常会先写一句说明，比如「我先看一下目录结构」。开启：这句说明会显示在对话里；关闭：只保留命令执行记录和最终回答，界面更清爽。两种情况都不影响模型的思考内容和最终回答。',
                onClick: (e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  setShowNarrationHelp((v) => !v);
                },
                style: {
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  width: 16,
                  height: 16,
                  marginLeft: 4,
                  borderRadius: '50%',
                  border: '1px solid var(--dsw-alias-border-l3, #4a4f57)',
                  color: 'var(--dsw-alias-label-caption, #8a8f98)',
                  fontSize: 11,
                  lineHeight: 1,
                  cursor: 'pointer',
                  userSelect: 'none',
                  flex: '0 0 auto',
                },
              },
              '?',
            ),
          ),
          showNarrationHelp
            ? h(
                'p',
                {
                  style: {
                    ...S.hint,
                    margin: '2px 0 0 26px',
                    padding: '6px 10px',
                    borderLeft: '2px solid var(--dsw-alias-border-l3, #4a4f57)',
                  },
                },
                '模型在动手前常会先写一句说明，比如「我先看一下目录结构」。开启：这句说明会显示在对话里；关闭：只保留命令执行记录和最终回答，界面更清爽。两种情况都不影响模型的思考内容和最终回答。',
              )
            : null,
          h(
            'label',
            { style: S.row },
            h('input', {
              type: 'checkbox',
              checked: cfg.autoRelogin !== false,
              onChange: (e) => saveCfg({ autoRelogin: e.target.checked }),
            }),
            h('span', null, 'token 失效时用保存的密码自动重新登录'),
            h('span', { style: S.hint }, '密码在本地加密保存，不会上传'),
          ),
          h('p', { style: S.hint }, '无浏览器直连 chat.deepseek.com。token 与保存的密码只在本机；同一账号的请求串行并节流，降低风控概率。'),
          error ? h('p', { style: { ...S.hint, color: '#e5484d' } }, '读取状态失败：' + error) : null,
          h(
            'div',
            { style: S.row },
            h('span', null, '空闲休眠（分钟）'),
            h('input', {
              style: { ...S.input, flex: '0 0 90px' },
              type: 'number',
              min: 1,
              value: Math.round((cfg.idleStopMs || 600000) / 60000),
              onChange: (e) => saveCfg({ idleStopMs: Math.max(1, Number(e.target.value)) * 60000 }),
            }),
            h('span', null, '同账号发送间隔（ms）'),
            h('input', {
              style: { ...S.input, flex: '0 0 100px' },
              type: 'number',
              min: 0,
              step: 100,
              value: cfg.sendGapMs || 1200,
              onChange: (e) => saveCfg({ sendGapMs: Math.max(0, Number(e.target.value)) }),
            }),
          ),
        ),

        (function () {
          const u = state && state.usage;
          if (!u || !u.total) return null;
          const total = u.total;
          const convs = Object.entries(u.conversations || {})
            .sort((a, b) => (b[1].updatedAt || 0) - (a[1].updatedAt || 0))
            .slice(0, 5);
          return h(
            'div',
            { style: cardStyle('usage') },
            h('h3', { style: S.title }, '网页版用量（插件累计）'),
            h(
              'div',
              { style: S.row },
              h('span', { title: ((total.prompt + total.completion) || 0).toLocaleString() }, '总 tokens：' + fmtTokens(total.prompt + total.completion)),
              h('span', { title: total.prompt.toLocaleString() }, '输入：' + fmtTokens(total.prompt)),
              h('span', { title: total.completion.toLocaleString() }, '输出：' + fmtTokens(total.completion)),
              h(
                'span',
                { title: (Number(total.cached) || 0).toLocaleString() },
                '缓存读取：' + fmtTokens(total.cached || 0) +
                  (total.prompt ? '（' + (Math.round(((total.cached || 0) / total.prompt) * 1000) / 10) + '%）' : ''),
              ),
              h('span', null, '轮次：' + total.turns),
            ),
            convs.length
              ? h(
                  'div',
                  { style: { display: 'flex', flexDirection: 'column', gap: 4 } },
                  h(
                    'span',
                    {
                      role: 'button',
                      onClick: () => setShowUsageDetail((v) => !v),
                      style: { ...S.hint, cursor: 'pointer', userSelect: 'none' },
                    },
                    (showUsageDetail ? '▾ ' : '▸ ') + '各对话详情（' + convs.length + '）',
                  ),
                  showUsageDetail
                    ? h(
                        'div',
                        { style: { display: 'flex', flexDirection: 'column', gap: 4, marginTop: 2 } },
                        ...convs.map(([id, c]) =>
                          h('span', { key: id, style: S.hint },
                            (c.label || '未命名对话 ' + String(id).slice(0, 8)) + ' · ' + fmtTokens(c.prompt + c.completion) + ' tok · 缓存 ' +
                              fmtTokens(c.cached || 0) + ' · ' + c.turns + ' 轮'),
                        ),
                      )
                    : null,
                )
              : null,
          );
        })(),

        h(
          'div',
          { style: cardStyle('accounts') },
          h('h3', { style: S.title }, '账号管理（' + list.length + '）'),
          list.length === 0 ? h('p', { style: S.hint }, noAccount ? '还没有账号，请在上方「添加账号」里登录。' : '还没有账号，请在下面添加。') : null,
          ...list.map((a) => {
            // 账号名：自定义名字优先；只有「浏览器登录 / 账号N」这种占位名时，直接用邮箱当名字。
            // 这样某个号登录失效时，一眼就知道失效的是哪个账号。
            const placeholder = !a.label || a.label === '浏览器登录' || /^账号\d+$/.test(a.label) || a.label === '邮箱账号';
            const name = a.email || (placeholder ? '账号 ' + a.id : a.label);
            const sub = a.email && !placeholder ? a.email : '';
            // 失效时的说明：存了密码就告诉用户会自动重登，没存就明确要手动登录
            const expiry = a.needBrowserLogin
              ? '站点设备风控拦住了脚本密码登录（RISK_DEVICE_DETECTED），点「浏览器登录」在真实网页里自动登一次即可'
              : a.status === 'authExpired'
                ? a.emailMasked && a.hasPassword
                  ? '登录已失效；保存的邮箱是脱敏地址，请点「改密码」填一次完整邮箱，之后才能自动重登'
                  : a.hasPassword
                    ? '登录已失效，正在用保存的密码自动重登' + (a.email ? '（' + a.email + '）' : '')
                    : '登录已失效，需要重新登录' + (a.email ? '（' + a.email + '）' : '')
                : a.reloginBlocked === 'needCode'
                  ? '自动重登需要邮箱验证码，点「重新登录」手动完成一次'
                  : '';
            return h(
              'div',
              { key: a.id, style: { display: 'flex', flexDirection: 'column', gap: 6, borderTop: '1px solid var(--dsw-alias-border-l4, rgba(128,128,128,.15))', paddingTop: 8 } },
              h(
                'div',
                { style: S.row },
                h('strong', null, name),
                sub ? h('span', { style: S.hint }, sub) : null,
                a.emailMasked
                  ? h('span', { style: { ...S.hint, color: '#ff9632' }, title: '站点接口只返回脱敏邮箱（带 *）。点「填邮箱」补一次完整地址，之后这里就显示完整的' }, '（脱敏）')
                  : null,
                a.hasPassword
                  ? h('span', { style: { ...S.badge(true), color: '#5aa9ff', borderColor: 'rgba(90,169,255,.45)' }, title: '已保存账号密码：token 失效时会自动重新登录' }, '已存密码')
                  : null,
                h('span', { style: S.badge(a.status === 'ok') }, a.status === 'ok' ? '正常' : a.status === 'cooling' ? '冷却中' : a.status === 'authExpired' ? '登录失效' : '已禁用'),
                h('span', { style: expiry ? { ...S.hint, color: '#ff9632' } : S.hint }, expiry || (a.lastUsedAt ? '最后使用 ' + new Date(a.lastUsedAt).toLocaleTimeString() : '从未使用')),
                h('span', { style: { marginLeft: 'auto' } }),
                h('button', { style: S.button, onClick: () => run('chk' + a.id, () => api('/accounts/' + a.id + '/check', { method: 'POST' })) }, '检查'),
                a.hasPassword
                  ? h('button', {
                      style: S.button,
                      disabled: busy === 'relogin' + a.id,
                      onClick: () => run('relogin' + a.id, async () => {
                        const out = await api('/accounts/' + a.id + '/relogin', { method: 'POST' });
                        if (!out || out.ok === false) throw new Error((out && out.message) || '重新登录失败');
                        return { ok: true, message: out.message || '已重新登录' };
                      }),
                    }, busy === 'relogin' + a.id ? '重登中…' : '重新登录')
                  : null,
                a.hasPassword
                  ? h('button', {
                      style: S.button,
                      disabled: busy === 'bl' + a.id,
                      title: '在真实网页里用保存的账号密码自动登录（站点风控拦截脚本登录时用这个）',
                      onClick: () => run('bl' + a.id, async () => {
                        // 先同步开窗，避免 await 之后被浏览器当成弹窗拦掉
                        const win = window.open('about:blank', '_blank');
                        try {
                          const out = await api('/accounts/' + a.id + '/browser-login', { method: 'POST' });
                          if (!out || out.ok === false) throw new Error((out && out.message) || '打开登录页失败');
                          if (out.url) {
                            if (win && !win.closed) win.location.href = out.url;
                            else window.open(out.url, '_blank', 'noopener');
                          }
                          return { ok: true, message: out.message || '登录页已打开：账号密码会自动填好，登录成功后 token 会自动回填' };
                        } catch (error) {
                          try { if (win && !win.closed) win.close(); } catch {}
                          throw error;
                        }
                      }),
                    }, busy === 'bl' + a.id ? '打开中…' : '浏览器登录')
                  : null,
                h('button', {
                  style: S.button,
                  onClick: () => {
                    setPwdFor(pwdFor === a.id ? '' : a.id);
                    // 脱敏地址没有意义，输入框留空，由用户填完整邮箱
                    setPwdEmail(a.emailMasked ? '' : a.email || '');
                    setPwdPass('');
                  },
                }, a.hasPassword ? '改密码' : a.emailMasked ? '填邮箱' : '存密码'),
                h('button', {
                  style: S.button,
                  onClick: () => run('tg' + a.id, () => api('/accounts/' + a.id + '/' + (a.status === 'disabled' ? 'enable' : 'disable'), { method: 'POST' })),
                }, a.status === 'disabled' ? '启用' : '禁用'),
                h('button', { style: { ...S.button, ...S.danger }, onClick: () => run('del' + a.id, () => api('/accounts/' + a.id, { method: 'DELETE' })) }, '删除'),
              ),
              pwdFor === a.id
                ? h(
                    'div',
                    { style: { ...S.row, paddingLeft: 4 } },
                    h('input', {
                      style: { ...S.input, flex: '1 1 160px' },
                      placeholder: a.email && !a.emailMasked ? '完整邮箱（默认 ' + a.email + '）' : '完整邮箱，如 name@qq.com',
                      value: pwdEmail,
                      onChange: (e) => setPwdEmail(e.target.value.trim()),
                    }),
                    h('input', {
                      style: { ...S.input, flex: '1 1 140px' },
                      type: 'password',
                      placeholder: '密码',
                      value: pwdPass,
                      onChange: (e) => setPwdPass(e.target.value),
                    }),
                    h('button', {
                      style: S.button,
                      disabled: (!pwdPass && !pwdEmail) || busy === 'pwd-save' + a.id,
                      onClick: () => run('pwd-save' + a.id, async () => {
                        const out = await api('/accounts/' + a.id + '/credential', {
                          method: 'POST',
                          body: JSON.stringify({ email: pwdEmail || a.email || '', password: pwdPass }),
                        });
                        if (out && out.saved) {
                          setPwdFor('');
                          setPwdPass('');
                          return { ok: Boolean(out.ok), message: out.message || '已保存' };
                        }
                        if (!out || out.ok === false) throw new Error((out && out.message) || '保存失败');
                        setPwdFor('');
                        setPwdPass('');
                        return { ok: true, message: out.message || '密码已保存并验证通过' };
                      }),
                    }, busy === 'pwd-save' + a.id ? '保存中…' : pwdPass ? '保存并验证' : '保存邮箱'),
                    a.hasPassword
                      ? h('button', {
                          style: { ...S.button, ...S.danger },
                          onClick: () => run('pwd-del' + a.id, async () => {
                            if (!window.confirm('删除 ' + name + ' 保存的密码？之后 token 失效不会自动重登。')) return;
                            const out = await api('/accounts/' + a.id + '/credential', { method: 'DELETE' });
                            setPwdFor('');
                            return { ok: Boolean(out && out.ok), message: '已删除保存的密码' };
                          }),
                        }, '删除已存密码')
                      : null,
                  )
                : null,
            );
          }),
        ),

        h(
          'div',
          { style: cardStyle('addAccount') },
          h('h3', { style: S.title }, '添加账号'),
          h(
            'div',
            { style: S.row },
            h('span', { style: { ...S.badge(true), background: 'rgba(255,150,40,.22)', color: '#ff9632' } }, '自动'),
            h('span', { style: { ...S.badge(true), background: 'rgba(70,167,88,.35)', color: '#3ddc6a', fontWeight: 600 } }, '推荐'),
            h('span', { style: S.hint }, '在插件里打开真实登录页，账号密码与验证码都在窗口里完成，token 自动回填'),
          ),
          h(
            'div',
            { style: S.row },
            h('span', { style: S.hint }, '登录线路'),
            ...['auto', 'cn', 'global'].map((k) =>
              h(
                'button',
                {
                  key: k,
                  style: {
                    ...S.button,
                    ...(cfg.loginRegion === k || (!cfg.loginRegion && k === 'auto')
                      ? { borderColor: 'var(--dsw-alias-label-primary, #fff)', fontWeight: 600 }
                      : {}),
                  },
                  onClick: () => saveCfg({ loginRegion: k }),
                },
                k === 'auto' ? '自动' : k === 'cn' ? '国内' : '邮箱（英文页）',
              ),
            ),
          ),
          h(
            'p',
            { style: S.hint },
            '国内线路：中文登录页（手机号 / 微信 / 邮箱都能登）。邮箱线路：英文登录页，邮箱或 Google 注册的账号用它 —— 中国大陆网络同样可用，不需要 VPN。',
          ),
          h(
            'div',
            { style: S.row },
            h('button', {
              style: S.button,
              onClick: () =>
                run('browser', async () => {
                  const out = await api('/login/browser', { method: 'POST' });
                  if (!out || !out.opened) {
                    if (out && out.url) window.open(out.url, '_blank', 'noopener');
                  }
                  return { ok: true, message: '登录页已在浏览器打开：输入账号密码、过人机验证，成功后 token 会自动回填（回到这里刷新即可看到账号）' };
                }),
            }, '在插件里登录'),
          ),
          h(
            'div',
            { style: { ...S.row, marginTop: 6, cursor: 'pointer', userSelect: 'none' }, onClick: () => setShowManual(!showManual) },
            h('span', { style: { width: 10, color: 'var(--text-secondary, #8a8f98)', fontSize: 11 } }, showManual ? '▼' : '▶'),
            h('span', { style: S.badge(false) }, '手动添加 / 批量导入'),
            h('span', { style: S.hint }, showManual ? '单个粘贴 token，或一次导入多个账号' : '不推荐 · 点击展开'),
          ),
          showManual
            ? h(
                'div',
                { style: { display: 'flex', flexDirection: 'column', gap: 8 } },
                h(
                  'div',
                  { style: S.row },
                  h('button', { style: S.button, onClick: () => window.open('https://chat.deepseek.com', '_blank', 'noopener') }, '① 打开 DeepSeek 登录页'),
                  h('span', { style: S.hint }, '登录完成后回到这里粘贴 token'),
                ),
                h('p', { style: S.hint }, '取 token：电脑 F12 → Console → 输入 JSON.parse(localStorage.userToken).value 回车；手机可在地址栏手敲 javascript:prompt("token",JSON.parse(localStorage.userToken).value)。'),
                h(
                  'div',
                  { style: { display: 'flex', flexDirection: 'column', gap: 6, marginTop: 4, paddingTop: 8, borderTop: '1px solid var(--dsw-alias-border-l4, rgba(128,128,128,.15))' } },
                  h('span', { style: { fontWeight: 600 } }, '批量导入（每个账号一行）'),
                  h('span', { style: S.hint }, '格式：`备注----token` 或 `备注----token----cookie`，也可以只写 `token`。一次最多 50 行，逐行校验后加入账号池。'),
                  h('textarea', {
                    style: { ...S.textarea, minHeight: 96 },
                    placeholder: '工作号----PulijPjF…\n备用号----AbCdEf…----ds_session_id=…',
                    value: batchText,
                    onChange: (e) => setBatchText(e.target.value),
                  }),
                  h(
                    'div',
                    { style: S.row },
                    h('button', {
                      style: S.button,
                      disabled: !batchText.trim() || busy === 'batch',
                      onClick: () => run('batch', async () => {
                        const out = await api('/login/token/batch', { method: 'POST', body: JSON.stringify({ text: batchText }) });
                        if (!out || out.ok === false) throw new Error((out && out.message) || '导入失败');
                        if (out.added) setBatchText('');
                        return { ok: true, message: '批量导入：成功 ' + out.added + ' 个，失败 ' + out.failed + ' 个' };
                      }),
                    }, busy === 'batch' ? '导入中…' : '批量导入'),
                    h('span', { style: S.hint }, '需要每个账号对应的 token'),
                  ),
                ),
                h(
                  'div',
                  { style: S.row },
                  h('button', {
                    style: S.button,
                    onClick: () => {
                      const js = buildBookmarklet(window.location.origin);
                      if (navigator.clipboard) navigator.clipboard.writeText(js);
                      setNotice('自动回填脚本已复制：到 DeepSeek 页面地址栏手敲 javascript: 再粘贴后半段回车，token 会自动保存到插件。');
                    },
                  }, '② 复制自动回填脚本'),
                  h('span', { style: S.hint }, '登录后在该页面地址栏执行，可免手动复制 token'),
                ),
                h('textarea', { style: S.textarea, placeholder: 'userToken…', value: token, onChange: (e) => setToken(e.target.value.trim()) }),
                h(
                  'div',
                  { style: S.row },
                  h('span', { style: S.hint }, 'cookie（可选，多账号隔离更稳）：浏览器 F12 → Network → 任意请求 → 复制 Cookie 请求头的整段内容粘贴到下面'),
                ),
                h('textarea', { style: { ...S.textarea, minHeight: 48 }, placeholder: 'cookie（可选，如：intercom-device-id-…=…; ds_session_id=…）', value: cookieText, onChange: (e) => setCookieText(e.target.value) }),
                h(
                  'div',
                  { style: S.row },
                  h('input', { style: S.input, placeholder: '备注名（可选，如：工作号）', value: label, onChange: (e) => setLabel(e.target.value) }),
                  h('button', {
                    style: S.button,
                    disabled: !token || busy === 'token',
                    onClick: () =>
                      run('token', async () => {
                        const out = await api('/login/token', { method: 'POST', body: JSON.stringify({ token, label, cookieText }) });
                        if (out && out.ok) {
                          setToken('');
                          setLabel('');
                          setCookieText('');
                          return { ok: true, message: '账号已添加：' + out.account.label };
                        }
                        return out;
                      }),
                  }, '校验并保存'),
                ),
              )
            : null,
          h('div', { style: { height: 1, background: 'var(--dsw-alias-border-l4, rgba(128,128,128,.25))', margin: '12px 0 8px' } }),
          h(
            'div',
            { style: { ...S.row, alignItems: 'baseline', gap: 6, cursor: 'pointer', userSelect: 'none' }, onClick: () => setShowEmail(!showEmail) },
            h('span', { style: { width: 10, color: 'var(--text-secondary, #8a8f98)', fontSize: 11 } }, showEmail ? '▼' : '▶'),
            h('span', { style: { fontWeight: 600 } }, '邮箱 + 密码登录'),
            h('span', { style: { ...S.badge(false), color: '#5aa9ff', borderColor: 'rgba(90,169,255,.5)' } }, '国内网络可用'),
            showEmail ? null : h('span', { style: S.hint }, '不依赖浏览器 · 点击展开'),
          ),
          showEmail
            ? h(
                'div',
                { style: { display: 'flex', flexDirection: 'column', gap: 8 } },
                h('p', { style: { ...S.hint, color: '#5aa9ff' } }, '邮箱 + 密码登录在中国大陆网络下直接可用，不需要 VPN。邮箱 / Google 注册的账号把「登录线路」选成「邮箱（英文页）」，国内手机号注册的账号用「国内」线路。'),
                h('p', { style: S.hint }, '直接用邮箱密码登录，不需要打开浏览器。新设备首次登录通常只会要求一次邮箱验证码（或直接通过），之后 token 失效可以靠保存的密码自动重登。'),
                h(
                  'label',
                  { style: { ...S.row, alignItems: 'center', gap: 8, cursor: 'pointer' } },
                  h('input', { type: 'checkbox', checked: savePassword, onChange: (e) => setSavePassword(e.target.checked) }),
                  h('span', null, '保存账号密码'),
                  h('span', { style: S.hint }, '本地加密保存；token 过期或被踢下线时自动重新登录，不用再手动点'),
                ),
                h(
                  'div',
                  { style: S.row },
                  h('input', { style: S.input, placeholder: '邮箱', value: email, onChange: (e) => setEmail(e.target.value.trim()) }),
                  h('input', { style: S.input, type: 'password', placeholder: '密码', value: password, onChange: (e) => setPassword(e.target.value) }),
                  h('button', {
                    style: S.button,
                    disabled: !email || !password || busy === 'pwd',
                    onClick: () => run('pwd', async () => {
                      const out = await api('/login/password', { method: 'POST', body: JSON.stringify({ email, password, label, savePassword }) });
                      if (!out) throw new Error('服务端没有返回：可能是宿主插件未重启');
                      if (out.ok) {
                        setPassword('');
                        setMfaSessionId('');
                        return { ok: true, message: '登录成功，账号已加入账号池' };
                      }
                      if (out.needCode) {
                        setMfaSessionId(out.mfaSessionId || '');
                        return { ok: false, message: (out.message || '需要邮箱验证码') + '（下面点「发送验证码」）' };
                      }
                      throw new Error(out.message || '登录失败');
                    }),
                  }, busy === 'pwd' ? '登录中…' : '登录'),
                ),
                mfaSessionId
                  ? h(
                      'div',
                      { style: S.row },
                      h('input', { style: S.input, placeholder: '邮箱里收到的 6 位验证码', value: code, onChange: (e) => setCode(e.target.value.trim()) }),
                      h('button', {
                        style: S.button,
                        disabled: busy === 'mfa-send',
                        onClick: () => run('mfa-send', async () => {
                          const out = await api('/login/mfa/send', { method: 'POST', body: JSON.stringify({ mfaSessionId }) });
                          if (!out || out.ok === false) throw new Error((out && out.message) || '发码失败');
                          return { ok: true, message: out.message || '验证码已发送' };
                        }),
                      }, '发送验证码'),
                      h('button', {
                        style: S.button,
                        disabled: !code || busy === 'mfa-verify',
                        onClick: () => run('mfa-verify', async () => {
                          const out = await api('/login/mfa/verify', { method: 'POST', body: JSON.stringify({ mfaSessionId, code, label, email, password, savePassword }) });
                          if (!out || out.ok === false) throw new Error((out && out.message) || '验证失败');
                          setCode('');
                          setMfaSessionId('');
                          return { ok: true, message: '登录成功，账号已加入账号池' };
                        }),
                      }, '完成登录'),
                    )
                  : null,
                h(
                  'div',
                  { style: { display: 'flex', flexDirection: 'column', gap: 6, marginTop: 4, paddingTop: 8, borderTop: '1px solid var(--dsw-alias-border-l4, rgba(128,128,128,.15))' } },
                  h('span', { style: { fontWeight: 600 } }, '批量登录（每个账号一行）'),
                  h('span', { style: S.hint }, '格式：`邮箱----密码` 或 `备注----邮箱----密码`。一次最多 20 个，逐个登录后加入账号池；需要验证码的账号会自动发码并列到下面。'),
                  h('textarea', {
                    style: { ...S.textarea, minHeight: 84 },
                    placeholder: 'a@example.com----password123\n工作号----b@example.com----password456',
                    value: batchPwdText,
                    onChange: (e) => setBatchPwdText(e.target.value),
                  }),
                  h(
                    'div',
                    { style: S.row },
                    h('button', {
                      style: S.button,
                      disabled: !batchPwdText.trim() || busy === 'batchpwd',
                      onClick: () => run('batchpwd', async () => {
                        const out = await api('/login/password/batch', { method: 'POST', body: JSON.stringify({ text: batchPwdText, savePassword }) });
                        if (!out || out.ok === false) throw new Error((out && out.message) || '批量登录失败');
                        const need = (out.results || []).filter((r) => r.needCode);
                        setPendingMfa(need);
                        setPendingCodes({});
                        setNotice('批量登录：成功 ' + out.added + ' 个，待验证码 ' + need.length + ' 个，失败 ' + (out.failed - need.length) + ' 个');
                        if (out.added) setBatchPwdText('');
                        return { ok: true, message: '批量登录完成：成功 ' + out.added + '，待验证码 ' + need.length };
                      }),
                    }, busy === 'batchpwd' ? '登录中…' : '批量登录'),
                    h('span', { style: S.hint }, '只用于你自己拥有的账号'),
                  ),
                  pendingMfa.length
                    ? h(
                        'div',
                        { style: { display: 'flex', flexDirection: 'column', gap: 6, paddingTop: 8, borderTop: '1px solid var(--dsw-alias-border-l4, rgba(128,128,128,.15))' } },
                        h('span', { style: { fontWeight: 600 } }, '待填验证码（' + pendingMfa.length + '）'),
                        ...pendingMfa.map((p, idx) =>
                          h(
                            'div',
                            { key: (p.mfaSessionId || p.email || String(idx)).slice(0, 60), style: S.row },
                            h('span', { style: { minWidth: 110, ...S.hint } }, p.label || p.email),
                            h('input', {
                              style: { ...S.input, flex: '0 0 110px' },
                              placeholder: '6 位验证码',
                              value: pendingCodes[p.mfaSessionId] || '',
                              onChange: (e) => setPendingCodes((prev) => ({ ...prev, [p.mfaSessionId]: e.target.value.replace(/\D/g, '') })),
                            }),
                            h('button', {
                              style: S.button,
                              disabled: busy === 'pm-' + idx || !(pendingCodes[p.mfaSessionId] || ''),
                              onClick: () => run('pm-' + idx, async () => {
                                const out = await api('/login/mfa/verify', {
                                  method: 'POST',
                                  body: JSON.stringify({ mfaSessionId: p.mfaSessionId, code: pendingCodes[p.mfaSessionId], label: p.label, email: p.email, savePassword }),
                                });
                                if (!out || out.ok === false) throw new Error((out && out.message) || '验证失败');
                                setPendingMfa((prev) => prev.filter((x) => x.mfaSessionId !== p.mfaSessionId));
                                return { ok: true, message: (p.label || p.email) + ' 已登录并加入账号池' };
                              }),
                            }, '完成登录'),
                          ),
                        ),
                      )
                    : null,
                ),
              )
            : null,
        ),

        h(
          'div',
          { style: { ...S.card, order: DEFAULT_ORDER.length } },
          h(
            'div',
            { style: { ...S.row, alignItems: 'baseline', gap: 6, cursor: 'pointer', userSelect: 'none' }, onClick: () => setShowPageSettings(!showPageSettings) },
            h('span', { style: { width: 10, color: 'var(--text-secondary, #8a8f98)', fontSize: 11 } }, showPageSettings ? '▼' : '▶'),
            h('h3', { style: S.title }, '页面设置'),
            h('span', { style: S.hint }, showPageSettings ? '点击收起' : '调整上方卡片的显示顺序 · 点击展开'),
          ),
          showPageSettings
            ? h(
                'div',
                { style: { display: 'flex', flexDirection: 'column', gap: 8 } },
                noAccount
                  ? h('span', { style: S.hint }, '当前没有账号，「添加账号」已临时置顶；添加成功后按下面的顺序显示。')
                  : null,
                ...order.map((k, i) =>
                  h(
                    'div',
                    { key: k, style: { ...S.row, borderTop: '1px solid var(--dsw-alias-border-l4, rgba(128,128,128,.15))', paddingTop: 8 } },
                    h('span', { style: { width: 18, color: 'var(--text-secondary, #8a8f98)', fontSize: 12 } }, String(i + 1) + '.'),
                    h('span', null, SECTION_LABELS[k]),
                    h('span', { style: { marginLeft: 'auto' } }),
                    h('button', { style: S.button, disabled: i === 0 || busy === 'order', onClick: () => moveSection(k, -1) }, '↑'),
                    h('button', { style: S.button, disabled: i === order.length - 1 || busy === 'order', onClick: () => moveSection(k, 1) }, '↓'),
                  ),
                ),
                h(
                  'div',
                  { style: S.row },
                  h('button', {
                    style: S.button,
                    disabled: busy === 'order',
                    onClick: () => {
                      setLocalOrder(null);
                      rememberOrder(null);
                      saveCfg({ sectionOrder: DEFAULT_ORDER.slice() });
                    },
                  }, '恢复默认顺序'),
                ),
              )
            : null,
        ),

        h(
          'div',
          { style: { ...S.card, order: DEFAULT_ORDER.length + 1 } },
          h('h3', { style: S.title }, '维护'),
          // ── 版本更新 ──
          h('div', { style: { ...S.row, gap: 8 } }, h('strong', { style: { fontSize: 12, minWidth: 64 } }, '版本更新')),
          h(
            'div',
            { style: S.row },
            h('button', {
              style: S.button,
              disabled: busy === 'update',
              onClick: () => run('update', async () => {
                const out = await api('/update/check');
                if (!out || out.ok === false) throw new Error((out && out.message) || '检查更新失败');
                setUpd({ ...out, installed: false });
                if (!out.hasUpdate) {
                  const msg = '当前已是最新版本 v' + out.current + '（无需更新）';
                  setUpdateInfo(msg);
                  return { ok: true, message: msg };
                }
                const msg = '发现新版本 v' + out.latest + '（当前 v' + out.current + '），点「安装 v' + out.latest + '」可直接升级';
                setUpdateInfo(msg);
                return { ok: true, message: msg };
              }),
            }, busy === 'update' ? '检查中…' : '检查更新'),
            upd && upd.hasUpdate && !upd.installed
              ? h('button', {
                  style: S.button,
                  onClick: async () => {
                    const url = upd.mirror || upd.assetUrl || upd.url || '';
                    const ok = await copyText(url);
                    setUpdateInfo(ok ? '已复制安装链接：' + url : '复制失败，请手动选中：' + url);
                  },
                }, '复制链接')
              : null,
            upd && upd.hasUpdate && !upd.installed
              ? h('button', {
                  style: { ...S.button, ...S.primary },
                  disabled: busy === 'install',
                  onClick: () => run('install', async () => {
                    const out = await api('/update/install', { method: 'POST' });
                    if (!out || out.ok === false) throw new Error((out && out.message) || '安装失败');
                    setUpd({ ...upd, installed: true });
                    const msg = out.upToDate ? '当前已是最新版本 v' + out.version : '已安装 v' + out.version + '，重启 DSH 后生效';
                    setUpdateInfo(msg);
                    return { ok: true, message: msg };
                  }),
                }, busy === 'install' ? '安装中…' : '安装 v' + upd.latest)
              : null,
          ),
          h(
            'p',
            { style: { ...S.hint, margin: '4px 0 0', ...(upd && upd.installed ? { color: '#3ddc6a' } : {}) } },
            upd && upd.installed
              ? '已安装 v' + (upd.latest || '') + '，重启 DSH 后生效（旧版本已备份，出问题可回滚）'
              : updateInfo || '当前版本 v' + ((state && state.version) || '?'),
          ),

          // ── 分隔线：更新 / 还原 各管各的，别混在一排按钮里 ──
          h('div', {
            style: {
              borderTop: '1px solid var(--dsw-alias-border-l4, rgba(128,128,128,.18))',
              margin: '12px 0 10px',
            },
          }),

          // ── 数据与还原 ──
          h('div', { style: { ...S.row, gap: 8 } }, h('strong', { style: { fontSize: 12, minWidth: 64 } }, '数据与还原')),
          h(
            'div',
            { style: S.row },
            h('button', {
              style: S.button,
              disabled: busy === 'usage-reset',
              onClick: () => {
                if (!window.confirm('清空插件累计的 token 用量记录？账号和登录状态不受影响。')) return;
                run('usage-reset', () => api('/usage/reset', { method: 'POST' }));
              },
            }, '清空 Token 用量记录'),
            h('button', {
              style: { ...S.button, ...S.danger },
              disabled: busy === 'config-reset',
              onClick: () => setConfirmReset('config'),
            }, '重置所有插件设置'),
          ),
          h('span', { style: S.hint }, '「清空用量」只删除统计记录；「重置设置」只恢复默认参数与卡片顺序（确认窗口里还可选择删除账号，或彻底删除全部账号和数据）。'),
          h(
            'div',
            {
              style: { ...S.row, cursor: 'pointer', userSelect: 'none', borderTop: '1px solid var(--dsw-alias-border-l4, rgba(128,128,128,.15))', paddingTop: 8 },
              onClick: () => setShowLog(!showLog),
            },
            h('span', { style: { width: 10, color: 'var(--text-secondary, #8a8f98)', fontSize: 11 } }, showLog ? '▼' : '▶'),
            h('span', null, '引擎日志（最近 40 行）'),
            h('span', { style: S.hint }, showLog ? '点击收起' : state && state.logTail ? '点击展开' : '暂无日志'),
          ),
          showLog ? h('pre', { style: S.log }, (state && state.logTail) || '（暂无日志）') : null,
        ),

        h(
          'div',
          { style: { ...S.card, order: DEFAULT_ORDER.length + 2 } },
          h('h3', { style: S.title }, '关于'),
          h(
            'div',
            { style: { ...S.row, gap: 6 } },
            h('span', null, '作者：'),
            h('strong', null, 'irerc'),
            h('span', { style: S.hint }, '·'),
            h('strong', null, 'DeepSeek Harness'),
          ),
          h('span', { style: S.hint }, 'dsh-deepseek-web' + (state && state.version ? ' v' + state.version : '') + ' · 把 chat.deepseek.com 网页版封装为 OpenAI 兼容接口的 DSH 插件'),
          h(
            'div',
            { style: { ...S.row, gap: 6, flexWrap: 'wrap' } },
            h('span', { style: S.hint }, '仓库：'),
            h(
              'a',
              {
                href: REPO_URL,
                target: '_blank',
                rel: 'noopener noreferrer',
                style: { color: 'var(--dsw-alias-label-primary-bluish, #4d6bfe)', fontSize: 12, wordBreak: 'break-all' },
              },
              REPO_URL,
            ),
            h(
              'button',
              {
                style: { ...S.button, padding: '3px 10px', fontSize: 12 },
                onClick: async () => setNotice((await copyText(REPO_URL)) ? '已复制仓库链接：' + REPO_URL : '复制失败：' + REPO_URL),
              },
              '复制链接',
            ),
            h(
              'button',
              {
                style: { ...S.button, padding: '3px 10px', fontSize: 12 },
                onClick: () => window.open(REPO_URL + '/stargazers', '_blank', 'noopener'),
              },
              '⭐ 点个 Star',
            ),
          ),
        ),

        confirmReset
          ? h(
              'div',
              {
                style: {
                  position: 'fixed',
                  inset: 0,
                  zIndex: 1000,
                  background: 'rgba(0,0,0,.45)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  padding: 16,
                },
              },
              h(
                'div',
                {
                  style: {
                    width: 'min(440px, 100%)',
                    maxHeight: '85vh',
                    overflow: 'auto',
                    background: 'var(--dsw-alias-bg-layer-2, var(--background-color, #fff))',
                    color: 'var(--dsw-alias-label-primary, inherit)',
                    border: '1px solid var(--dsw-alias-border-l3, var(--border-color, rgba(128,128,128,.35)))',
                    borderRadius: 12,
                    padding: 18,
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 10,
                    boxShadow: '0 12px 40px rgba(0,0,0,.35)',
                  },
                },
                confirmReset === 'factory' ? h(
                  'div',
                  { style: { display: 'flex', flexDirection: 'column', gap: 10 } },
                  h('h3', { style: { ...S.title, fontSize: 14, color: '#e5484d' } }, '确认删除所有账号和数据？'),
                  h('p', { style: S.hint }, '将彻底清空以下内容，回到刚安装插件的状态：'),
                  h(
                    'ul',
                    { style: { ...S.hint, margin: 0, paddingLeft: 18 } },
                    h('li', null, '全部已登录账号（' + list.length + ' 个）及其 token、cookie'),
                    h('li', null, '网页版 Token 用量统计记录'),
                    h('li', null, '登录代理抓取的 cookie 罐'),
                    h('li', null, '全部运行设置与卡片顺序（恢复默认）'),
                  ),
                  h('p', { style: { ...S.hint, color: '#e5484d' } }, '此操作不可撤销，之后需要重新登录添加账号。'),
                  h(
                    'div',
                    { style: { ...S.row, justifyContent: 'flex-end', marginTop: 4 } },
                    h('button', { style: S.button, onClick: () => setConfirmReset('config') }, '返回'),
                    h(
                      'button',
                      {
                        style: { ...S.button, ...S.danger },
                        disabled: busy === 'factory-reset',
                        onClick: () => {
                          setConfirmReset('');
                          setPurgeAccounts(false);
                          setLocalOrder(null);
                          rememberOrder(null);
                          run('factory-reset', () => api('/factory-reset', { method: 'POST' }));
                        },
                      },
                      '确认彻底删除',
                    ),
                  ),
                ) : h(
                  'div',
                  { style: { display: 'flex', flexDirection: 'column', gap: 10 } },
                  h('h3', { style: { ...S.title, fontSize: 14 } }, '确认重置所有插件设置？'),
                  h('p', { style: S.hint }, '将恢复为出厂默认值：'),
                  h(
                    'ul',
                    { style: { ...S.hint, margin: 0, paddingLeft: 18 } },
                    h('li', null, '自动启动：开'),
                    h('li', null, '空闲休眠：10 分钟'),
                    h('li', null, '同账号发送间隔：1200 ms'),
                    h('li', null, '并发上限：4'),
                    h('li', null, '卡片顺序：恢复默认（网页版用量置顶）'),
                  ),
                  h(
                    'label',
                    { style: { ...S.row, alignItems: 'center', gap: 8, cursor: 'pointer', marginTop: 2 } },
                    h('input', {
                      type: 'checkbox',
                      checked: purgeAccounts,
                      onChange: (e) => setPurgeAccounts(e.target.checked),
                    }),
                    h('span', { style: { ...S.hint, color: '#e5484d' } }, '同时删除已登录账号和 token（不可恢复）'),
                  ),
                  h(
                    'p',
                    { style: S.hint },
                    purgeAccounts
                      ? '注意：将同时清空账号列表（含所有 token 与 cookie），之后需要重新登录才能使用。'
                      : '不勾选时不会删除已登录账号和 token。此操作不可撤销。',
                  ),
                  h(
                    'div',
                    { style: { ...S.row, justifyContent: 'flex-end', marginTop: 4 } },
                    h('button', { style: S.button, onClick: () => { setConfirmReset(''); setPurgeAccounts(false); } }, '取消'),
                    h(
                      'button',
                      {
                        style: { ...S.button, ...S.danger },
                        onClick: () => {
                          const alsoAccounts = purgeAccounts;
                          setConfirmReset('');
                          setPurgeAccounts(false);
                          setLocalOrder(null);
                          rememberOrder(null);
                          run('config-reset', async () => {
                            if (alsoAccounts) await api('/accounts/purge', { method: 'POST' });
                            return api('/config/reset', { method: 'POST' });
                          });
                        },
                      },
                      purgeAccounts ? '确认重置并删除账号' : '确认重置',
                    ),
                  ),
                  h('div', { style: { height: 1, background: 'var(--dsw-alias-border-l4, rgba(128,128,128,.25))', margin: '4px 0' } }),
                  h(
                    'div',
                    { style: { ...S.row, justifyContent: 'space-between', alignItems: 'center' } },
                    h(
                      'div',
                      { style: { display: 'flex', flexDirection: 'column', gap: 2 } },
                      h('span', { style: { fontSize: 12, fontWeight: 600, color: '#e5484d' } }, '删除所有账号和数据'),
                      h('span', { style: S.hint }, '账号、用量统计、cookie 罐、全部设置一并清空'),
                    ),
                    h(
                      'button',
                      { style: { ...S.button, ...S.danger }, onClick: () => setConfirmReset('factory') },
                      '进入彻底删除',
                    ),
                  ),
                ),
              ),
            )
          : null,
      );
    }

    function apply(ctx) {
      ctx.slots.inject('settings.section', () =>
        ctx.slots.register(
          {
            name: 'settings.section',
            id: 'deepseek-web',
            order: 40,
            label: () => 'DeepSeek 网页版',
          },
          DeepSeekWebSection,
        ),
      );
    }

    exports.apply = apply;
    exports.inject = ['slots'];
    return module.exports;
  },
});
