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
      const [showManual, setShowManual] = useState(false);
      const [showEmail, setShowEmail] = useState(false);
      const [showLog, setShowLog] = useState(false);
      const [showPageSettings, setShowPageSettings] = useState(false);
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
      const SECTION_LABELS = {
        usage: '网页版用量',
        engine: '运行设置（引擎状态）',
        accounts: '账号管理',
        addAccount: '添加账号',
        log: '引擎日志',
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
          ),
          h('p', { style: S.hint }, '模型在动手前常会先写一句说明，比如「我先看一下目录结构」。'),
          h(
            'p',
            { style: S.hint },
            '开启：这句说明会显示在对话里。关闭：只保留命令执行记录和最终回答，界面更清爽。两种情况都不影响模型的思考内容和最终回答。',
          ),
          h('p', { style: S.hint }, '无浏览器直连 chat.deepseek.com。token 只保存在本机；同一账号的请求串行并节流，降低风控概率。'),
          error ? h('p', { style: { ...S.hint, color: '#e5484d' } }, '读取状态失败：' + error) : null,
          notice ? h('p', { style: S.hint }, notice) : null,
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
              h('span', null, '总 tokens：' + ((total.prompt + total.completion) || 0).toLocaleString()),
              h('span', null, '输入：' + total.prompt.toLocaleString()),
              h('span', null, '输出：' + total.completion.toLocaleString()),
              h('span', null, '轮次：' + total.turns),
            ),
            convs.length
              ? h(
                  'div',
                  { style: { ...S.row, flexDirection: 'column', alignItems: 'flex-start', gap: 4 } },
                  h('span', { style: S.hint }, '最近对话：'),
                  ...convs.map(([id, c]) =>
                    h('span', { key: id, style: S.hint },
                      id + ' · ' + (c.prompt + c.completion).toLocaleString() + ' tok · ' + c.turns + ' 轮'),
                  ),
                )
              : null,
          );
        })(),

        h(
          'div',
          { style: cardStyle('accounts') },
          h('h3', { style: S.title }, '账号管理（' + list.length + '）'),
          list.length === 0 ? h('p', { style: S.hint }, noAccount ? '还没有账号，请在上方「添加账号」里登录。' : '还没有账号，请在下面添加。') : null,
          ...list.map((a) =>
            h(
              'div',
              { key: a.id, style: { ...S.row, borderTop: '1px solid var(--dsw-alias-border-l4, rgba(128,128,128,.15))', paddingTop: 8 } },
              h('strong', null, a.label),
              h('span', { style: S.badge(a.status === 'ok') }, a.status === 'ok' ? '正常' : a.status === 'cooling' ? '冷却中' : a.status === 'authExpired' ? '登录失效' : '已禁用'),
              h('span', { style: S.hint }, a.lastUsedAt ? '最后使用 ' + new Date(a.lastUsedAt).toLocaleTimeString() : '从未使用'),
              h('span', { style: { marginLeft: 'auto' } }),
              h('button', { style: S.button, onClick: () => run('chk' + a.id, () => api('/accounts/' + a.id + '/check', { method: 'POST' })) }, '检查'),
              h('button', {
                style: S.button,
                onClick: () => run('tg' + a.id, () => api('/accounts/' + a.id + '/' + (a.status === 'disabled' ? 'enable' : 'disable'), { method: 'POST' })),
              }, a.status === 'disabled' ? '启用' : '禁用'),
              h('button', { style: { ...S.button, ...S.danger }, onClick: () => run('del' + a.id, () => api('/accounts/' + a.id, { method: 'DELETE' })) }, '删除'),
            ),
          ),
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
            h('span', { style: S.badge(false) }, '手动添加 cookies'),
            h('span', { style: S.hint }, showManual ? '自己登录后粘贴 token（可选再粘贴 cookie）' : '不推荐 · 点击展开'),
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
            h('span', { style: { fontWeight: 600 } }, '邮箱验证码登录'),
            h('span', { style: { fontSize: 12, color: '#e5a23c' } }, '实验性 · 极少情况下可用'),
            showEmail ? null : h('span', { style: S.hint }, '不推荐 · 点击展开'),
          ),
          showEmail
            ? h(
                'div',
                { style: { display: 'flex', flexDirection: 'column', gap: 8 } },
                h('p', { style: S.hint }, '说明：站点发码接口通常强制人机验证，无浏览器环境绝大多数情况会失败；此入口仅作为极端情况下的兜底，正常请用上面的「在插件里登录」或粘贴 token。'),
                h(
                  'div',
                  { style: S.row },
                  h('input', { style: S.input, placeholder: '邮箱', value: email, onChange: (e) => setEmail(e.target.value) }),
                  h('button', { style: S.button, disabled: !email || busy === 'email', onClick: () => run('email', () => api('/login/email', { method: 'POST', body: JSON.stringify({ email }) })) }, '发送验证码'),
                ),
                h(
                  'div',
                  { style: S.row },
                  h('input', { style: S.input, placeholder: '6 位验证码', value: code, onChange: (e) => setCode(e.target.value) }),
                  h('button', { style: S.button, disabled: !code || busy === 'verify', onClick: () => run('verify', () => api('/login/verify', { method: 'POST', body: JSON.stringify({ email, code }) })) }, '登录'),
                ),
              )
            : null,
        ),

        h(
          'div',
          { style: cardStyle('log') },
          h(
            'div',
            { style: { ...S.row, cursor: 'pointer', userSelect: 'none' }, onClick: () => setShowLog(!showLog) },
            h('span', { style: { width: 10, color: 'var(--text-secondary, #8a8f98)', fontSize: 11 } }, showLog ? '▼' : '▶'),
            h('h3', { style: S.title }, '引擎日志（最近 40 行）'),
            h('span', { style: S.hint }, showLog ? '点击收起' : state && state.logTail ? '点击展开' : '暂无日志'),
          ),
          showLog ? h('pre', { style: S.log }, (state && state.logTail) || '（暂无日志）') : null,
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
