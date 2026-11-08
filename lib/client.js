// 客户端设置分区：设置 → DeepSeek 网页版
//
// 手写的 __ModuleLoader__ 模块（无构建链）：只依赖宿主提供的 react。
// 所有数据都通过同源接口 /dsh-deepseek-web/* 读写（由 Host 插件注册）。
window.__ModuleLoader__.load({
  // 客户端模块 id 必须等于包名（scoped 也要带 scope），否则宿主按包名找不到这个模块，
  // 启动时直接判 LOADER_OR_BROWSER_FAILED。
  id: '@irerc/dsh-deepseek-web',
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


    // Android WebView 里 window.prompt / window.confirm 经常被宿主直接掐掉（返回 null/false 且不弹窗），
    // 结果就是设置面板里一半按钮「点了没反应」。这里自己画一个同源弹层，不依赖宿主原生对话框。

    // 宿主（Android WebView）不一定实现 window.open：点了没反应，用户以为按钮坏了。
    // 这里统一走一条路：能开就开，开不了就把地址显示出来让人复制，绝不给「点了没反应」。
    function openExternal(url) {
      if (!url) return false;
      try {
        const w = window.open(url, '_blank');
        if (w) {
          try { w.opener = null; } catch {}
          return true;
        }
      } catch {}
      try {
        const a = document.createElement('a');
        a.href = url;
        a.target = '_blank';
        a.rel = 'noopener';
        document.body.appendChild(a);
        a.click();
        a.remove();
        return true;
      } catch {}
      return false;
    }

    function showUrl(url, hint) {
      return uiLayer((box, done) => {
        const p = document.createElement('div');
        p.textContent = hint || '宿主没让自动打开，复制这个地址到浏览器：';
        p.style.cssText = 'margin-bottom:10px';
        const ta = document.createElement('textarea');
        ta.value = url;
        ta.readOnly = true;
        ta.rows = 3;
        ta.style.cssText =
          'width:100%;box-sizing:border-box;background:#131318;color:#e8e8ea;border:1px solid rgba(255,255,255,.16);' +
          'border-radius:9px;padding:9px 10px;font-size:12px;word-break:break-all';
        const row = document.createElement('div');
        row.style.cssText = 'display:flex;gap:10px;justify-content:flex-end;margin-top:12px';
        const mk = (text, onClick, primary) => {
          const b = document.createElement('button');
          b.textContent = text;
          b.style.cssText =
            'padding:8px 16px;border-radius:9px;font-size:13px;cursor:pointer;border:1px solid rgba(255,255,255,.16);' +
            (primary ? 'background:#4d6bfe;color:#fff;border-color:#4d6bfe' : 'background:transparent;color:#c9c9cf');
          b.onclick = onClick;
          return b;
        };
        row.appendChild(mk('复制', async () => { await copyText(url); b0.textContent = '已复制'; }, false));
        row.appendChild(mk('关闭', () => done(true), true));
        const b0 = row.firstChild;
        box.appendChild(p);
        box.appendChild(ta);
        box.appendChild(row);
        setTimeout(() => { try { ta.focus(); ta.select(); } catch {} }, 30);
      });
    }

    function uiLayer(build) {
      return new Promise((resolve) => {
        let done = false;
        const finish = (v) => {
          if (done) return;
          done = true;
          try { layer.remove(); } catch {}
          resolve(v);
        };
        const layer = document.createElement('div');
        layer.style.cssText =
          'position:fixed;inset:0;z-index:2147483000;display:flex;align-items:center;justify-content:center;' +
          'background:rgba(0,0,0,.55);padding:18px;backdrop-filter:blur(2px)';
        const box = document.createElement('div');
        box.style.cssText =
          'max-width:420px;width:100%;background:#1e1f24;color:#e8e8ea;border:1px solid rgba(255,255,255,.14);' +
          'border-radius:14px;padding:16px;font-size:14px;line-height:1.6;box-shadow:0 18px 50px rgba(0,0,0,.55)';
        layer.appendChild(box);
        layer.addEventListener('click', (e) => { if (e.target === layer) finish(null); });
        const onKey = (e) => {
          if (e.key === 'Escape') { e.stopPropagation(); finish(null); }
          if (e.key === 'Enter') { e.stopPropagation(); const btn = box.querySelector('[data-ok="1"]'); if (btn) btn.click(); }
        };
        document.addEventListener('keydown', onKey, true);
        const cleanup = () => document.removeEventListener('keydown', onKey, true);
        build(box, (v) => { cleanup(); finish(v); });
        document.body.appendChild(layer);
      });
    }

    function uiConfirm(message) {
      return uiLayer((box, done) => {
        const p = document.createElement('div');
        p.textContent = message;
        p.style.cssText = 'white-space:pre-wrap;margin-bottom:16px';
        const row = document.createElement('div');
        row.style.cssText = 'display:flex;gap:10px;justify-content:flex-end';
        const mk = (text, value, primary) => {
          const b = document.createElement('button');
          b.textContent = text;
          if (primary) b.setAttribute('data-ok', '1');
          b.style.cssText =
            'padding:8px 16px;border-radius:9px;font-size:13px;cursor:pointer;border:1px solid rgba(255,255,255,.16);' +
            (primary ? 'background:#4d6bfe;color:#fff;border-color:#4d6bfe' : 'background:transparent;color:#c9c9cf');
          b.onclick = () => done(value);
          return b;
        };
        row.appendChild(mk('取消', false, false));
        row.appendChild(mk('确定', true, true));
        box.appendChild(p);
        box.appendChild(row);
      });
    }

    function uiPrompt(message, defaultValue = '') {
      return uiLayer((box, done) => {
        const p = document.createElement('div');
        p.textContent = message;
        p.style.cssText = 'margin-bottom:10px';
        const ta = document.createElement('textarea');
        ta.value = defaultValue == null ? '' : String(defaultValue);
        ta.rows = 2;
        ta.style.cssText =
          'width:100%;box-sizing:border-box;resize:vertical;background:#131318;color:#e8e8ea;' +
          'border:1px solid rgba(255,255,255,.16);border-radius:9px;padding:9px 10px;font-size:13px';
        const row = document.createElement('div');
        row.style.cssText = 'display:flex;gap:10px;justify-content:flex-end;margin-top:12px';
        const mk = (text, value, primary) => {
          const b = document.createElement('button');
          b.textContent = text;
          if (primary) b.setAttribute('data-ok', '1');
          b.style.cssText =
            'padding:8px 16px;border-radius:9px;font-size:13px;cursor:pointer;border:1px solid rgba(255,255,255,.16);' +
            (primary ? 'background:#4d6bfe;color:#fff;border-color:#4d6bfe' : 'background:transparent;color:#c9c9cf');
          b.onclick = () => done(value === '__ok__' ? ta.value : null);
          return b;
        };
        row.appendChild(mk('取消', null, false));
        row.appendChild(mk('确定', '__ok__', true));
        box.appendChild(p);
        box.appendChild(ta);
        box.appendChild(row);
        setTimeout(() => { try { ta.focus(); ta.select(); } catch {} }, 30);
      });
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
      wrap: { display: 'flex', flexDirection: 'column', gap: 14, padding: '4px 2px 8px', fontSize: 13 },
      card: {
        border: '1px solid var(--dsw-alias-border-l4, var(--border-color, rgba(128,128,128,.22)))',
        background:
          'linear-gradient(180deg, rgba(255,255,255,.035), rgba(255,255,255,0) 42%), var(--dsw-alias-settings-card-fill, transparent)',
        borderRadius: 14,
        padding: 16,
        display: 'flex',
        flexDirection: 'column',
        gap: 12,
        boxShadow: '0 1px 2px rgba(0,0,0,.10), 0 8px 24px -18px rgba(0,0,0,.55)',
      },
      row: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' },
      title: { fontSize: 14, fontWeight: 650, margin: 0, letterSpacing: '.2px' },
      hint: { color: 'var(--dsw-alias-label-caption, var(--text-secondary, #8a8f98))', fontSize: 12, lineHeight: 1.6, margin: 0 },
      // 灰色说明文字统一收进「?」按钮：按钮本体 + 点击展开的浮层
      helpWrap: { position: 'relative', display: 'inline-flex', flex: '0 0 auto', marginLeft: 4, verticalAlign: 'middle' },
      helpDot: {
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: 16,
        height: 16,
        borderRadius: '50%',
        border: '1px solid var(--dsw-alias-border-l3, #4a4f57)',
        color: 'var(--dsw-alias-label-caption, #8a8f98)',
        fontSize: 11,
        lineHeight: 1,
        cursor: 'pointer',
        userSelect: 'none',
        flex: '0 0 auto',
      },
      helpDotOn: {
        color: 'var(--dsw-alias-label-primary, #fff)',
        borderColor: 'var(--dsw-alias-label-primary, #fff)',
        background: 'rgba(128,128,128,.18)',
      },
      helpPop: {
        position: 'absolute',
        top: 'calc(100% + 6px)',
        left: 0,
        zIndex: 60,
        width: 'max-content',
        maxWidth: 320,
        padding: '8px 10px',
        borderRadius: 8,
        border: '1px solid var(--dsw-alias-border-l4, rgba(128,128,128,.35))',
        background: 'var(--dsw-alias-bg-layer-1, #1f2228)',
        color: 'var(--dsw-alias-label-caption, #a7abb3)',
        fontSize: 12,
        lineHeight: 1.6,
        boxShadow: '0 8px 24px rgba(0,0,0,.35)',
        whiteSpace: 'normal',
        textAlign: 'left',
        cursor: 'default',
      },
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
        padding: '3px 9px',
        borderRadius: 999,
        fontSize: 11,
        fontWeight: 600,
        letterSpacing: '.2px',
        background: ok ? 'rgba(70,167,88,.18)' : 'rgba(140,140,140,.22)',
        color: ok ? '#46a758' : 'var(--dsw-alias-label-primary, inherit)',
        border: '1px solid ' + (ok ? 'rgba(70,167,88,.35)' : 'var(--dsw-alias-border-l4, rgba(150,150,150,.35))'),
      }),
      log: { maxHeight: 160, overflow: 'auto', fontSize: 11, fontFamily: 'monospace', background: 'var(--dsw-alias-bg-layer-3, rgba(128,128,128,.08))', borderRadius: 8, padding: 8, whiteSpace: 'pre-wrap', margin: 0 },
      // ---- v1.0.52：分组 / 台账 / 登录状态卡 ----
      select: {
        padding: '5px 24px 5px 9px',
        borderRadius: 8,
        border: '1px solid var(--dsw-alias-border-l4, var(--border-color, rgba(128,128,128,.35)))',
        background: 'var(--dsw-alias-bg-layer-3, rgba(128,128,128,.10))',
        color: 'var(--dsw-alias-label-primary, inherit)',
        fontSize: 12.5,
        cursor: 'pointer',
      },
      groupHead: {
        display: 'flex',
        alignItems: 'center',
        gap: 7,
        marginTop: 4,
        padding: '4px 2px 2px',
      },
      groupToggle: {
        width: 20, height: 20, padding: 0, borderRadius: 6, border: '1px solid transparent',
        background: 'transparent', color: 'var(--dsw-alias-label-caption, #8a8f98)', cursor: 'pointer',
        fontSize: 11, lineHeight: 1,
      },
      groupName: { fontSize: 12.5, fontWeight: 600, letterSpacing: '.2px' },
      groupCount: { fontSize: 11.5, color: 'var(--dsw-alias-label-caption, #8a8f98)' },
      groupMini: {
        padding: '2px 8px', borderRadius: 6, border: '1px solid transparent', background: 'transparent',
        color: 'var(--dsw-alias-label-caption, #8a8f98)', fontSize: 11.5, cursor: 'pointer',
      },
      stats: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(82px,1fr))', gap: 8 },
      statBox: {
        display: 'flex', flexDirection: 'column', gap: 2, padding: '8px 10px', borderRadius: 10,
        background: 'var(--dsw-alias-bg-layer-3, rgba(128,128,128,.08))',
        border: '1px solid var(--dsw-alias-border-l4, rgba(128,128,128,.14))',
      },
      statNum: { fontSize: 17, fontWeight: 650, lineHeight: 1.2, fontVariantNumeric: 'tabular-nums' },
      statLabel: { fontSize: 11, color: 'var(--dsw-alias-label-caption, #8a8f98)', letterSpacing: '.2px' },
      spark: { fontFamily: 'ui-monospace,SFMono-Regular,Menlo,monospace', fontSize: 14, letterSpacing: 1, color: '#6aa2ff', lineHeight: 1 },
      failChip: {
        padding: '2px 8px', borderRadius: 999, fontSize: 11.5,
        background: 'rgba(255,150,50,.12)', border: '1px solid rgba(255,150,50,.32)', color: '#ffb056',
      },
    };


      const UI_CSS = [
        '.dswx-app button{transition:transform .12s ease, background .15s ease, border-color .15s ease, box-shadow .15s ease, opacity .12s ease}',
        '.dswx-app button:hover:not(:disabled){background:rgba(128,128,128,.20);border-color:rgba(128,128,128,.45)}',
        '.dswx-app button:active:not(:disabled){transform:translateY(1px) scale(.99)}',
        '.dswx-app button:disabled{opacity:.55;cursor:default}',
        '.dswx-app input,.dswx-app textarea{transition:border-color .15s ease, box-shadow .15s ease}',
        '.dswx-app input:focus,.dswx-app textarea:focus{outline:none;border-color:#6aa2ff;box-shadow:0 0 0 3px rgba(106,162,255,.18)}',
        '.dswx-app h3{letter-spacing:.2px}',
        '.dswx-app code{background:rgba(128,128,128,.16);padding:1px 5px;border-radius:5px;font-size:11.5px}',
        '.dswx-app ::selection{background:rgba(106,162,255,.35)}',
        // v1.0.52 现代化：统一字号/数字对齐、标题前加细渐变条、下拉箭头自绘、键盘焦点环
        '.dswx-app{font-feature-settings:"tnum" 1;-webkit-font-smoothing:antialiased}',
        '.dswx-app h3{display:flex;align-items:center;gap:8px;font-size:14px;font-weight:650;letter-spacing:.2px;margin:0}',
        '.dswx-app h3::before{content:"";width:3px;height:14px;border-radius:2px;background:linear-gradient(180deg,#6aa2ff,#8b6cff);flex:0 0 auto}',
        '.dswx-app select{appearance:none;-webkit-appearance:none;background-image:linear-gradient(45deg,transparent 50%,currentColor 50%),linear-gradient(135deg,currentColor 50%,transparent 50%);background-position:calc(100% - 13px) 54%,calc(100% - 8px) 54%;background-size:5px 5px,5px 5px;background-repeat:no-repeat;padding-right:24px}',
        '.dswx-app select:hover{border-color:rgba(128,128,128,.55)}',
        '.dswx-app button:focus-visible,.dswx-app select:focus-visible,.dswx-app input:focus-visible,.dswx-app textarea:focus-visible{outline:2px solid rgba(106,162,255,.55);outline-offset:1px}',
        '.dswx-app .dswx-select option{background:#1f2228;color:#e6e8ec}',
        '.dswx-app ::-webkit-scrollbar{width:8px;height:8px}',
        '.dswx-app ::-webkit-scrollbar-thumb{background:rgba(128,128,128,.28);border-radius:99px}',
        '@media (prefers-color-scheme:light){.dswx-app .dswx-select option{background:#fff;color:#111}}',
      ].join('\n');

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
      const [probe, setProbe] = useState(null); // 浏览器传输自检结果
      const ORDER_KEY = 'dsh-deepseek-web:sectionOrder';
      const rememberOrder = (arr) => {
        try {
          if (window.localStorage) {
            if (arr && arr.length) window.localStorage.setItem(ORDER_KEY, JSON.stringify(arr));
            else window.localStorage.removeItem(ORDER_KEY);
          }
        } catch {}
      };
      // v1.0.54：页面切换条 —— 卡片按用途分组，一次只显示一页（学 dsh-deepseek-web-login 的分页设置）
      const TAB_KEY = 'dsh-deepseek-web:tab';
      const LOGIN_KEY = 'dsh-deepseek-web:loginMethod';
      const TABS = [
        { key: 'accounts', label: '账号', sections: ['accounts', 'addAccount'] },
        { key: 'login', label: '登录', sections: ['sessions', 'diagnostics'] },
        { key: 'usage', label: '用量', sections: ['usage', 'ledger'] },
        { key: 'system', label: '运行', sections: ['engine', 'pageSettings', 'maint'] },
      ];
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
      const [helpOpen, setHelpOpen] = useState(''); // 当前展开的「?」说明（同一时间只开一个）
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
      // 内嵌登录窗口（实验性）：{ url, accountId, autofill, key }。null = 没打开。
      // 登录页跑在同一台机器的独立端口（默认 127.0.0.1:18090），所以能直接塞进 iframe。
      const [embed, setEmbed] = useState(null);
      const [embedNote, setEmbedNote] = useState('');
      // v1.0.52：调用台账 / 登录状态卡 / 分组折叠
      const [ledgerData, setLedgerData] = useState(null);
      const [ledgerHours, setLedgerHours] = useState(24);
      const [ledgerBusy, setLedgerBusy] = useState(false);
      const [diag, setDiag] = useState(null);
      const [diagBusy, setDiagBusy] = useState(false);
      const [collapsedGroups, setCollapsedGroups] = useState({});
      // v1.0.53：登录会话（jar）/ 重复账号 / 批量选择
      const [sessions, setSessions] = useState([]);
      const [sessionsBusy, setSessionsBusy] = useState(false);
      const [dupInfo, setDupInfo] = useState(null);
      const [selectMode, setSelectMode] = useState(false);
      const [selected, setSelected] = useState({});
      const [localOrder, setLocalOrder] = useState(() => {
        // 本机记住顺序：即使宿主未重启（旧 config 模块会丢弃 sectionOrder），刷新后顺序也不丢
        try {
          const raw = window.localStorage && window.localStorage.getItem(ORDER_KEY);
          const arr = raw ? JSON.parse(raw) : null;
          return Array.isArray(arr) && arr.length ? arr : null;
        } catch {}
        return null;
      });

      // 当前页（切换条）：本机记住，刷新不跳回第一页
      const [activeTab, setActiveTab] = useState(() => {
        try {
          const v = window.localStorage && window.localStorage.getItem(TAB_KEY);
          return TABS.some((t) => t.key === v) ? v : 'accounts';
        } catch {}
        return 'accounts';
      });
      const pickTab = (k) => {
        setActiveTab(k);
        try { window.localStorage && window.localStorage.setItem(TAB_KEY, k); } catch {}
      };
      // 账号操作精简：默认只留 检查 / 登录 / 设为当前，其余收进「更多」
      const [moreAccts, setMoreAccts] = useState({});
      const [acctMore, setAcctMore] = useState(false);
      // 登录方式（学参考实现）：内嵌窗口 / 系统浏览器 / 手动 token / 邮箱密码，一次只显示一种
      const [loginMethod, setLoginMethod] = useState(() => {
        try {
          const v = window.localStorage && window.localStorage.getItem(LOGIN_KEY);
          return ['embed', 'browser', 'manual', 'email'].indexOf(v) >= 0 ? v : 'embed';
        } catch {}
        return 'embed';
      });
      const pickLogin = (m) => {
        setLoginMethod(m);
        setShowManual(m === 'manual');
        setShowEmail(m === 'email');
        try { window.localStorage && window.localStorage.setItem(LOGIN_KEY, m); } catch {}
      };

      const refresh = useCallback(async () => {
        try {
          const data = await api('/state');
          setState(data);
          setError('');
        } catch (e) {
          setError(String(e.message || e));
        }
      }, []);

      const loadLedger = useCallback(async (hours) => {
        const hh = Number(hours || 24);
        setLedgerBusy(true);
        try {
          const data = await api('/ledger?hours=' + hh);
          setLedgerData(data);
        } catch (e) {
          setNotice('台账读取失败：' + String(e.message || e));
        } finally {
          setLedgerBusy(false);
        }
      }, []);
      const loadDiag = useCallback(async (verify) => {
        setDiagBusy(true);
        try {
          const data = await api('/diagnostics' + (verify ? '?verify=1' : ''));
          setDiag(data);
        } catch (e) {
          setNotice('登录状态检测失败：' + String(e.message || e));
        } finally {
          setDiagBusy(false);
        }
      }, []);

      const loadSessions = useCallback(async () => {
        setSessionsBusy(true);
        try {
          const data = await api('/login/sessions');
          setSessions(Array.isArray(data.sessions) ? data.sessions : []);
        } catch (e) {
          setNotice('登录会话读取失败：' + String(e.message || e));
        } finally {
          setSessionsBusy(false);
        }
      }, []);
      const checkDup = useCallback(async () => {
        try {
          const data = await api('/accounts/duplicates');
          setDupInfo(data);
          if (!data.groups || !data.groups.length) setNotice('没有发现重复账号：账号库是干净的');
          return data;
        } catch (e) {
          setNotice('重复检测失败：' + String(e.message || e));
          return null;
        }
      }, []);
      const idsOfSelected = () => Object.keys(selected).filter((k) => selected[k]);

      useEffect(() => {
        refresh();
        const timer = setInterval(refresh, 4000);
        // 台账 60 秒刷新一次；登录状态卡只在点「重新检测」时刷（它要打网络）
        loadLedger(24);
        loadSessions();
        const lt = setInterval(() => loadLedger(), 60000);
        loadDiag(false);
        return () => {
          clearInterval(timer);
          clearInterval(lt);
        };
      }, [refresh, loadLedger, loadDiag]);

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

      // 内置浏览器内核（可选下载）：只改状态，进度跟着 /state 的 4s 轮询走
      const be = (state && state.browserEngine) || {};
      const beDl = be.download || {};
      const beBusy = Boolean(beDl.busy);
      const mb = (n) => (Number(n || 0) / 1048576).toFixed(1) + ' MB';
      const engineInstall = (source) =>
        run('engine-' + source, async () => {
          const out = await api('/browser/engine/install', { method: 'POST', body: JSON.stringify({ source, threads: Number(cfg.engineThreads) || 0 }) });
          if (out && out.ok === false) return out;
          return { ok: true, message: '已开始从' + (source === 'intl' ? '国际直连' : '大陆镜像') + '下载（约 200MB），进度在下面实时更新' };
        });
      const engineRemove = () => run('engine-remove', () => api('/browser/engine/remove', { method: 'POST', body: '{}' }));

      // 运行环境：Windows 优先 WebView2 → Edge → Chrome；安卓走 App 内 WebView；都没有就建议下载
      const rt = (state && state.runtime) || {};
      const rtKernel = rt.kernel || {};
      const KERNEL_LABEL = {
        webview2: 'WebView2（系统自带）',
        edge: 'Edge（系统）',
        chrome: 'Chrome（系统）',
        'posix-browser': '系统 Chrome/Chromium',
        'android-webview': '安卓 WebView（App 内）',
        none: '未找到可用内核',
      };
      const rtAge = rt.at ? Math.max(0, Math.round((Date.now() - rt.at) / 1000)) : 0;

      // 灰色说明文字统一收进「?」按钮：默认只占一个 16px 圆点，点一下才展开浮层，
      // 不再用一整行小字挤占设置面板。title 属性兜底桌面端悬停。
      const helpTip = (id, text, title) =>
        h(
          'span',
          { key: 'help-' + id, style: S.helpWrap },
          h(
            'span',
            {
              role: 'button',
              tabIndex: 0,
              'data-help': id,
              'aria-label': '说明',
              'aria-expanded': helpOpen === id ? 'true' : 'false',
              title: title || '点击查看说明',
              onClick: (e) => {
                e.preventDefault();
                e.stopPropagation();
                setHelpOpen((v) => (v === id ? '' : id));
              },
              style: { ...S.helpDot, ...(helpOpen === id ? S.helpDotOn : {}) },
            },
            '?',
          ),
          helpOpen === id ? h('span', { role: 'note', style: S.helpPop }, text) : null,
        );

      // 内嵌登录开关：默认开（配置项缺省也按开处理，老宿主/旧配置同样能内嵌）。
      // 关掉 = 完全回到 v1.0.41 的「新标签页打开登录页」行为，即内嵌方案的回滚开关。
      const embedOn = cfg.embedLogin !== false;

      // 所有登录动作的默认入口：先拉真实浏览器（cookie 干净、不会被 WebView 拦），
      // 只有浏览器那条打不开时才退回内嵌窗口。以前默认内嵌，手机 WebView 里经常白屏。
      const openLogin = async (accountId) => {
        try {
          const out = await api('/login/browser', { method: 'POST', body: JSON.stringify({ accountId: accountId || '' }) });
          if (out && out.ok !== false) {
            if (!out.opened && out.url && !openExternal(out.url)) {
              await showUrl(out.url, '宿主拦了自动打开，用系统浏览器打开这个地址完成登录：');
            }
            return { ok: true, mode: 'browser', message: out.message || '已打开浏览器登录页' };
          }
        } catch {}
        const r = await openEmbed(accountId || '');
        return r.ok ? { ok: true, mode: 'embed', message: '浏览器没打开，已改用内嵌登录窗口' } : { ok: false, message: r.message };
      };

      const openEmbed = async (accountId) => {
        setEmbedNote('');
        try {
          const out = await api('/login/embed', { method: 'POST', body: JSON.stringify({ accountId: accountId || '' }) });
          if (!out || !out.url) throw new Error((out && out.message) || '内嵌登录窗口打开失败');
          const mode = out.autofillMode === 'full' || out.autofillMode === 'email' ? out.autofillMode : out.autofill ? 'full' : '';
          setEmbed({ url: out.url, accountId: out.accountId || accountId || '', autofillMode: mode, autofill: Boolean(mode), key: Date.now() });
          return { ok: true, autofill: Boolean(mode), mode };
        } catch (e) {
          const message = String(e.message || e);
          // 旧宿主没有 /login/embed（404）时明确提示，不偷偷换成新窗口
          setEmbedNote(/重启 DSH|404|not found/i.test(message) ? '内嵌登录需要新版本后台：请重启 DSH 后再试（或用浏览器登录）' : '内嵌登录窗口打开失败：' + message);
          return { ok: false, message };
        }
      };
      const closeEmbed = () => {
        setEmbed(null);
        setEmbedNote('');
      };

      // 系统浏览器线路（保留的旧实现）：由宿主的 openOnDevice 直接把登录页交给手机/电脑的系统浏览器。
      // 内嵌窗口白屏、被站点风控挡住、或要走 Apple 授权时用这条；内嵌开关关掉后它也是「在插件里登录」的默认行为。
      const openSystemBrowser = () =>
        run('sysbrowser', async () => {
          const out = await api('/login/browser', { method: 'POST' });
          if (!out || !out.opened) {
            if (out && out.url) {
              if (!openExternal(out.url)) await showUrl(out.url);
              return { ok: true, message: '登录页已在新标签页打开：登录成功后 token 会自动回填（回到这里刷新即可看到账号）' };
            }
            throw new Error((out && out.message) || '打开系统浏览器失败');
          }
          return { ok: true, message: '已用系统浏览器打开登录页：登录成功后 token 会自动回填（回到这里刷新即可看到账号）' };
        });

      // 内嵌窗口里的登录页登录成功后 postMessage 过来（独立 origin，父页面校验来源）
      useEffect(() => {
        if (typeof window === 'undefined' || !window.addEventListener) return;
        const onMessage = (event) => {
          const data = event && event.data;
          if (!data || typeof data !== 'object' || typeof data.type !== 'string' || data.type.indexOf('dsweb:') !== 0) return;
          const origin = String((event && event.origin) || '');
          if (!/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(origin)) return;
          if (data.type === 'dsweb:login-ok') {
            const who = data.email || data.accountId || '';
            setNotice('登录成功，token 已回填到插件' + (who ? '（' + who + '）' : '') + (data.credentialSaved ? '，账号密码已加密保存在本机' : ''));
            setEmbed(null);
            refresh();
          }
        };
        window.addEventListener('message', onMessage);
        return () => window.removeEventListener('message', onMessage);
      }, [refresh]);

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
        ledger: '调用台账',
        engine: '运行设置（引擎状态）',
        accounts: '账号管理',
        addAccount: '添加账号',
        sessions: '登录会话',
        diagnostics: '登录状态',
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
        // 「页面设置 / 维护」两张卡不属于可排序列表，固定排在最后
        if (k === 'pageSettings') return DEFAULT_ORDER.length;
        if (k === 'maint') return DEFAULT_ORDER.length + 1;
        const i = displayOrder.indexOf(k);
        return i < 0 ? DEFAULT_ORDER.length : i;
      };
      // 切换条：不在当前页的卡片直接 display:none（保留 DOM 状态，切回来不用重新拉数据）
      const tabOfSection = (k) => {
        for (const t of TABS) if (t.sections.indexOf(k) >= 0) return t.key;
        return 'accounts';
      };
      const cardStyle = (k) => ({
        ...S.card,
        order: orderOf(k),
        ...(tabOfSection(k) === activeTab ? null : { display: 'none' }),
      });
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

      // ---- v1.0.52：账号分组（只影响显示；当前账号所在的组置顶、未分组垫底）----
      const groupDefs = Array.isArray(state && state.groups) ? state.groups : [];
      const activeAccount = list.find((a) => a.active) || null;
      // 账号排序：当前 → 可用 → 不可用；不可用的里面的按「恢复时间」从短到长
      // （禁言按到期时间，登录失效最靠前——它一登录就能用；停用/手动禁用没有结束时间，排最后）
      const recoveryAt = (a) => {
        if (a.muted && a.muteUntil) return Number(a.muteUntil) || 0;
        if (a.banned || a.disabled || a.status === 'disabled') return Number.MAX_SAFE_INTEGER;
        return 0;
      };
      const accountRank = (a) => {
        if (a.active) return 0;
        const broken = a.banned || a.muted || a.disabled || a.status === 'disabled' || a.status === 'authExpired' || a.needBrowserLogin;
        return broken ? 2 : 1;
      };
      const sortedList = list
        .map((a, i) => ({ a, i }))
        .sort((x, y) => {
          const r = accountRank(x.a) - accountRank(y.a);
          if (r) return r;
          const t = recoveryAt(x.a) - recoveryAt(y.a);
          if (t) return t;
          return x.i - y.i;
        })
        .map((x) => x.a);
      const accountSections = (() => {
        if (!list.length) return [];
        if (!groupDefs.length) return [{ key: '__all__', name: '', groupId: null, accounts: sortedList }];
        const buckets = new Map(groupDefs.map((g) => [g.id, []]));
        const ungrouped = [];
        for (const a of sortedList) {
          if (a.groupId && buckets.has(a.groupId)) buckets.get(a.groupId).push(a);
          else ungrouped.push(a);
        }
        const pinned = activeAccount && activeAccount.groupId && buckets.has(activeAccount.groupId) ? activeAccount.groupId : '';
        const ordered = pinned
          ? [groupDefs.find((g) => g.id === pinned), ...groupDefs.filter((g) => g.id !== pinned)]
          : groupDefs.slice();
        const out = ordered.map((g) => ({ key: g.id, name: g.name, groupId: g.id, accounts: buckets.get(g.id) || [] }));
        if (ungrouped.length) out.push({ key: '__ungrouped__', name: '未分组', groupId: null, accounts: ungrouped });
        return out;
      })();
      const groupAction = (name, fn) => run(name, fn);
      const createGroup = async () => {
        let v = null;
        try { v = await uiPrompt('新建分组名（只影响显示，不影响切号）', ''); } catch { v = null; }
        if (!v || !String(v).trim()) return;
        groupAction('group-create', async () => {
          const out = await api('/groups/create', { method: 'POST', body: JSON.stringify({ name: String(v) }) });
          if (!out || out.ok === false) throw new Error((out && out.message) || '创建分组失败');
          return { ok: true, message: out.message || '分组已创建' };
        });
      };
      const renameGroupAt = async (group) => {
        let v = null;
        try { v = await uiPrompt('分组新名字（只影响显示）', group.name); } catch { v = null; }
        if (v === null || v === undefined) return;
        groupAction('group-rename-' + group.id, async () => {
          const out = await api('/groups/rename', { method: 'POST', body: JSON.stringify({ id: group.groupId, name: String(v) }) });
          if (!out || out.ok === false) throw new Error((out && out.message) || '改名失败');
          return { ok: true, message: out.message || '分组已改名' };
        });
      };
      const deleteGroupAt = async (group) => {
        if (!(await uiConfirm('删除分组「' + group.name + '」？\n组里的账号会回到「未分组」，账号与凭证都不动。'))) return;
        groupAction('group-delete-' + group.id, async () => {
          const out = await api('/groups/delete', { method: 'POST', body: JSON.stringify({ id: group.groupId }) });
          if (!out || out.ok === false) throw new Error((out && out.message) || '删除失败');
          return { ok: true, message: out.message || '分组已删除' };
        });
      };
      const assignGroup = (account, groupId) =>
        groupAction('group-assign-' + account.id, async () => {
          const out = await api('/accounts/' + account.id + '/group', { method: 'POST', body: JSON.stringify({ groupId: String(groupId || '') }) });
          if (!out || out.ok === false) throw new Error((out && out.message) || '归组失败');
          return { ok: true, message: out.message || '已归组' };
        });
      const groupHead = (section) => {
        if (!section.name) return null;
        const collapsed = Boolean(collapsedGroups[section.key]);
        return h(
          'div',
          { key: 'gh-' + section.key, style: S.groupHead },
          h(
            'button',
            {
              style: S.groupToggle,
              title: collapsed ? '展开这个分组' : '收起这个分组',
              onClick: () => setCollapsedGroups((v) => ({ ...v, [section.key]: !v[section.key] })),
            },
            collapsed ? '▸' : '▾',
          ),
          h('span', { style: S.groupName }, section.name),
          h('span', { style: S.groupCount }, section.accounts.length + ' 个'),
          h('span', { style: { flex: '1 1 auto' } }),
          section.groupId
            ? h('button', { style: S.groupMini, title: '只改分组名，账号不动', onClick: () => renameGroupAt(section) }, '改名')
            : null,
          section.groupId
            ? h('button', { style: { ...S.groupMini, ...S.danger }, title: '只删分组本身；组里的账号回到「未分组」', onClick: () => deleteGroupAt(section) }, '删组')
            : null,
        );
      };

      const fmtMs = (v) => (v == null || !Number.isFinite(Number(v)) ? '—' : Number(v) < 1000 ? Math.round(Number(v)) + 'ms' : Math.round(Number(v) / 100) / 10 + 's');
      const dot = (state2) =>
        h('span', {
          style: {
            width: 7, height: 7, borderRadius: '50%', flex: '0 0 auto', marginTop: 7,
            background: state2 === true ? '#46a758' : state2 === false ? '#e5484d' : '#8a8f98',
            boxShadow: state2 === true ? '0 0 0 3px rgba(70,167,88,.16)' : state2 === false ? '0 0 0 3px rgba(229,72,77,.14)' : 'none',
          },
        });
      const diagRow = (label, okState, text) =>
        h(
          'div',
          { style: { display: 'flex', alignItems: 'flex-start', gap: 8, fontSize: 12.5, lineHeight: 1.6 } },
          dot(okState),
          h('span', { style: { color: 'var(--dsw-alias-label-caption, #8a8f98)', flex: '0 0 84px' } }, label),
          h('span', { style: { flex: '1 1 auto', wordBreak: 'break-word', minWidth: 0 } }, text),
        );

      return h(
        'div',
        { className: 'dswx-app', style: S.wrap },
        h('style', { key: 'dswx-css' }, UI_CSS),
        // 操作结果统一显示在最上方，不塞进某张卡片里（之前「检查更新」的结果跑到运行设置中间去了）
        notice
          ? h(
              'div',
              {
                style: {
                  display: 'flex',
                  alignItems: 'flex-start',
                  gap: 8,
                  padding: '10px 14px',
                  borderRadius: 10,
                  background: 'rgba(30,32,40,.96)',
                  border: '1px solid rgba(120,170,255,.45)',
                  fontSize: 13,
                  lineHeight: 1.6,
                  wordBreak: 'break-all',
                  whiteSpace: 'pre-wrap',
                  color: '#e8e8ea',
                  // 固定在视口底部：以前横幅在最上面，滚到账号卡片时根本看不见，点了就像没反应
                  position: 'fixed',
                  left: '50%',
                  transform: 'translateX(-50%)',
                  bottom: 'calc(env(safe-area-inset-bottom, 0px) + 86px)',
                  maxWidth: 'min(92vw, 560px)',
                  zIndex: 2147483001,
                  boxShadow: '0 12px 34px rgba(0,0,0,.5)',
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
        // ── v1.0.54 页面切换条：账号 / 登录 / 用量 / 运行，一次只显示一页 ──
        h(
          'div',
          {
            key: 'dswx-tabs',
            style: {
              position: 'sticky',
              top: 0,
              zIndex: 6,
              display: 'flex',
              gap: 4,
              padding: 4,
              borderRadius: 10,
              background: 'var(--dsw-alias-bg-l1, rgba(125,135,160,.14))',
              border: '1px solid var(--dsw-alias-border-l4, rgba(128,128,128,.22))',
            },
          },
          ...TABS.map((t) => {
            const on = t.key === activeTab;
            const extra = t.key === 'accounts' && list.length ? String(list.length) : '';
            const tip =
              t.key === 'accounts' ? '账号库、分组与添加账号'
                : t.key === 'login' ? '登录会话（cookie 罐）与登录状态自检'
                  : t.key === 'usage' ? '网页版用量与调用台账'
                    : '引擎运行设置、页面设置与维护';
            return h(
              'button',
              {
                key: t.key,
                title: tip,
                style: {
                  flex: '1 1 0',
                  padding: '7px 8px',
                  fontFamily: 'inherit',
                  fontSize: 13,
                  cursor: 'pointer',
                  whiteSpace: 'nowrap',
                  borderRadius: 8,
                  border: '1px solid transparent',
                  background: on ? 'var(--dsw-alias-bg-l3, rgba(190,200,255,.22))' : 'transparent',
                  color: on ? 'var(--dsw-alias-label-primary, #fff)' : 'var(--dsw-alias-label-caption, #8a8f98)',
                  fontWeight: on ? 700 : 500,
                },
                onClick: () => pickTab(t.key),
              },
              t.label + (extra ? ' ' + extra : ''),
            );
          }),
        ),
        h(
          'div',
          { style: cardStyle('runtime') },
          h('h3', { style: S.title }, '运行环境与内核选择'),
          h(
            'div',
            { style: S.row },
            h('span', { style: S.badge(Boolean(rt.available)) }, rt.available ? '内核查到' : '内核不可用'),
            h('span', { style: { fontSize: 12.5, color: 'var(--dsw-alias-label-caption, #8a8f98)' } }, rt.label || '探测中…'),
            h('span', { style: S.badge(Boolean(rtKernel.type && rtKernel.type !== 'none')) }, KERNEL_LABEL[rtKernel.type] || rtKernel.type || '—'),
            rtAge > 0
              ? h('span', { style: { fontSize: 11.5, color: 'var(--dsw-alias-label-caption, #8a8f98)' } }, rtAge + ' 秒前检测')
              : null,
            h(
              'button',
              {
                style: S.groupMini,
                title: '重新探测（平台、内核、App 桥状态）',
                onClick: () => run('runtime', () => api('/runtime').then(() => refresh())),
              },
              '重新检测',
            ),
          ),
          h('div', { style: { ...S.hint, marginTop: 6 } }, rt.advice || '正在探测运行环境…'),
          rtKernel.path
            ? h('div', { style: { ...S.hint, marginTop: 2, fontFamily: 'monospace', fontSize: 11.5, wordBreak: 'break-all' } }, rtKernel.path + (rtKernel.version ? '  ·  ' + rtKernel.version : ''))
            : null,
          rt.recommend === 'download' && !be.installed
            ? h(
                'div',
                { style: { ...S.row, marginTop: 8 } },
                h('span', { style: { fontSize: 12, color: 'var(--dsw-alias-label-caption, #8a8f98)' } }, '没有可用内核，建议下载：'),
                h('button', { style: S.button, disabled: beBusy || busy === 'engine-cn', onClick: () => engineInstall('cn') }, '下载（大陆镜像）'),
                h('button', { style: S.button, disabled: beBusy || busy === 'engine-intl', onClick: () => engineInstall('intl') }, '下载（国际直连）'),
              )
            : null,
          rt.recommend === 'app-webview'
            ? h('div', { style: { ...S.hint, marginTop: 6 } }, '安卓上唯一的真实浏览器方案是 App 内 WebView（系统 Chromium）+ CDP；在 DSH App 内打开本设置页时桥已在（127.0.0.1:3090），插件侧 CDP 接入待完成前，请求继续走 native 档。')
            : null,
        ),
        h(
          'div',
          { style: cardStyle('engine') },
          h('h3', { style: S.title }, '浏览器内核（可选下载）'),
          h(
            'div',
            { style: { ...S.hint, marginBottom: 8 } },
            '不装也能用：默认走 node / native 两档（TLS 指纹已是 Chrome）。点下面任一源下载一份 Chrome for Testing（约 200MB），浏览器档才能真正由 Chrome 页面发出请求。两个源是同一个文件，只是线路不同。',
          ),
          h(
            'div',
            { style: S.row },
            h('span', { style: S.badge(Boolean(be.installed)) }, be.installed ? '已安装' : be.supported === false ? '当前平台不支持' : '未安装'),
            be.installed
              ? h(
                  'span',
                  { style: { fontSize: 13 } },
                  'v' + (be.version || '') + ' · ' + (be.installedSource === 'intl' ? '国际直连下载' : be.installedSource === 'cn' ? '大陆镜像下载' : '来源未知') + ' · ' + mb(be.diskSize) + (be.download && be.download.phase === 'done' ? '' : ''),
                )
              : h('span', { style: { fontSize: 13, color: 'var(--dsw-alias-label-caption, #8a8f98)' } }, be.supported === false ? '当前平台没有官方内核包（' + (be.platform || '') + '），请用系统已装浏览器' : '点右侧按钮下载到本机 state 目录，不会打进插件包'),
            h('span', { style: { marginLeft: 'auto' } }),
            h(
              'button',
              { style: S.button, disabled: beBusy || busy === 'engine-cn' || be.supported === false, onClick: () => engineInstall('cn') },
              '下载（大陆镜像）',
            ),
            h(
              'button',
              { style: S.button, disabled: beBusy || busy === 'engine-intl' || be.supported === false, onClick: () => engineInstall('intl') },
              '下载（国际直连）',
            ),
            be.installed
              ? h('button', { style: S.button, disabled: beBusy || busy === 'engine-remove', onClick: engineRemove }, '删除内核')
              : null,
          ),
          h(
            'div',
            { style: { ...S.row, marginTop: 4 } },
            h('span', { style: { ...S.hint, minWidth: 210 } }, '并发下载线程数'),
            h('input', {
              type: 'number',
              min: 0,
              max: 16,
              step: 1,
              style: { ...S.input, width: 70 },
              value: Number(cfg.engineThreads) || 0,
              onChange: (e) => saveCfg({ engineThreads: Math.max(0, Math.min(16, Number(e.target.value) || 0)) }),
            }),
            h('span', { style: { fontSize: 12, color: 'var(--dsw-alias-label-caption, #8a8f98)' } }, '0 = 自动测速（默认）；1 = 单流；2~16 = 强制分片并发'),
            helpTip('engineThreads', '并发不是越大约好：出口带宽打满时多线程反而更慢。默认 0 会先拉 1MB 测单流速度，够快（≥4MB/s）就走单流，慢才切到 6 并发。国内访问 Google 存储常见单流 200KB/s，这时候并发提升明显。'),
          ),
          beBusy
            ? h(
                'div',
                { style: { ...S.row, marginTop: 6, gap: 10 } },
                h('span', { style: { fontSize: 12 } }, (beDl.phase === 'downloading' ? '下载中' : beDl.phase === 'verifying' ? '校验中' : beDl.phase === 'extracting' ? '解压中' : beDl.phase === 'checking' ? '试运行中' : '处理中') + ' ' + (beDl.percent || 0) + '%'),
                h(
                  'span',
                  { style: { flex: 1, height: 6, borderRadius: 3, background: 'rgba(255,255,255,.12)', overflow: 'hidden' } },
                  h('span', { style: { display: 'block', height: '100%', width: (beDl.percent || 0) + '%', background: 'var(--dsw-alias-bg-accent, #6b8cff)' } }),
                ),
                beDl.speedBps ? h('span', { style: { fontSize: 12 } }, mb(beDl.speedBps) + '/s') : null,
              )
            : null,
          !beBusy && beDl && beDl.phase === 'error' && beDl.error
            ? h(
                'div',
                { style: { ...S.row, marginTop: 6, color: '#ff9632', fontSize: 12 } },
                '上次失败：' + String(beDl.error).slice(0, 200),
                h('button', { style: { ...S.button, marginLeft: 8 }, onClick: () => engineInstall(beDl.source === 'intl' ? 'intl' : 'cn') }, '重试'),
              )
            : null,
          h(
            'div',
            { style: { ...S.hint, marginTop: 6 } },
            '国内推荐「大陆镜像」（npmmirror 的 chrome-for-testing 镜像，和官方是同一个 zip）；海外或已出海的网络推荐「国际直连」（Google 官方存储）。',
          ),
        ),
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
            helpTip('narration', '模型在动手前常会先写一句说明，比如「我先看一下目录结构」。开启：这句说明会显示在对话里；关闭：只保留命令执行记录和最终回答，界面更清爽。两种情况都不影响模型的思考内容和最终回答。'),
          ),
          h(
            'label',
            { style: S.row },
            h('input', {
              type: 'checkbox',
              checked: cfg.autoRelogin !== false,
              onChange: (e) => saveCfg({ autoRelogin: e.target.checked }),
            }),
            h('span', null, 'token 失效时用保存的密码自动重新登录'),
            helpTip('relogin', '密码用 AES-256-GCM 加密后只存在本机 state 目录，不会上传到任何服务器；token 失效或被踢下线时用它在后台重新登录。'),
          ),
          h(
            'label',
            { style: S.row },
            h('input', {
              type: 'checkbox',
              checked: cfg.saveLoginCredential !== false,
              onChange: (e) => saveCfg({ saveLoginCredential: e.target.checked }),
            }),
            h('span', null, '登录时自动保存账号密码到本机'),
            helpTip('saveCred', '内嵌 / 浏览器登录成功后，把登录表单里的邮箱密码加密保存到本机，下次自动填表；关掉则不保存（已保存的可在账号行里删除）。'),
          ),
          (function () {
            const ms = Number(cfg.probeIntervalMs || 0);
            const label = ms === 0 ? '登录态探活：已关闭' : '登录态探活：每 ' + Math.round(ms / 60000) + ' 分钟一次（0 = 关闭）';
            return h(
              'label',
              { style: S.row },
              h('span', { style: { ...S.hint, minWidth: 210 } }, label),
              h('input', {
                type: 'number',
                min: 0,
                max: 1440,
                step: 5,
                style: { ...S.input, width: 90 },
                value: Math.round(ms / 60000),
                onChange: (e) => {
                  const min = Math.max(0, Math.min(1440, Number(e.target.value) || 0));
                  saveCfg({ probeIntervalMs: min * 60000 });
                },
              }),
              helpTip('probe', '启动后 15 秒先扫一遍，之后按这个间隔用只读接口 users/current 复查每个账号（不消耗对话额度）。发现失效会立刻标出来，存了密码的号自动重登。设 0 = 关闭定时探活，只靠「全部体检」手动查。'),
            );
          })(),
          h(
            'label',
            { style: S.row },
            h('input', {
              type: 'checkbox',
              checked: cfg.embedLogin !== false,
              onChange: (e) => saveCfg({ embedLogin: e.target.checked }),
            }),
            h('span', null, '在设置页里内嵌登录窗口（实验）'),
            helpTip('embedGate', '关掉 = 回到「新标签页打开登录页」的旧方式。这是内嵌方案的临时回滚开关：内嵌窗口白屏 / 被站点风控拦住时关掉它，系统浏览器线路一直保留。'),
          ),
          (function () {
            const mode = cfg.requestMode === 'safe' ? 'safe' : 'raw';
            return h(
              'div',
              { style: { display: 'flex', flexDirection: 'column', gap: 4, marginTop: 2 } },
              h(
                'div',
                { style: S.row },
                h('span', null, '请求模式'),
                ...[['raw', '原始模式'], ['safe', '保险模式']].map(([k, label]) =>
                  h(
                    'button',
                    {
                      key: k,
                      style: {
                        ...S.button,
                        ...(mode === k ? { borderColor: 'var(--dsw-alias-label-primary, #fff)', fontWeight: 600 } : {}),
                      },
                      onClick: () => saveCfg({ requestMode: k }),
                    },
                    label,
                  ),
                ),
                helpTip(
                  'requestMode',
                  (mode === 'safe'
                    ? '提示词最前面会插入一段「使用规范」：违法违规、攻击性、诈骗勒索类内容会被礼貌拒绝并给合规替代；其它问题照常回答。同时工具描述压到 200 字、历史预算约 48k，同账号严格串行、发送间隔改为 5~8 秒随机区间 —— 更不容易触发风控和禁言。'
                    : '提示词就是你原本的 API 请求：messages 原样、工具 schema 完整，不加任何额外说明（只在末尾保留一行回复格式约定），历史预算约 118k。最接近真实网页提问，模型发挥最完整；内容风险由你承担。') +
                    ' 已封禁 / 被禁言的账号在两种模式下都会被自动跳过。',
                ),
              ),
            );
          })(),

          h(
            'div',
            { style: S.row },
            h('span', null, '提示词形态'),
            ...[['human', '人类对话'], ['api', 'API 原样']].map(([k, label]) =>
              h(
                'button',
                {
                  key: k,
                  style: {
                    ...S.button,
                    ...((cfg.promptStyle || 'human') === k ? { borderColor: 'var(--dsw-alias-label-primary, #fff)', fontWeight: 600 } : {}),
                  },
                  title: k === 'human' ? '把请求写成真人聊天的样子（推荐）' : '旧行为：整段 API 请求体 JSON',
                  onClick: () => saveCfg({ promptStyle: k }),
                },
                label,
              ),
            ),
            helpTip(
              'promptStyle',
              '人类对话（默认）：把对话写成「我：… 你：… （我按你的意思跑了 bash）结果：…」这样的人话，工具约定只用一行 JSON 说明，长输出自动截断。' +
                'API 原样：整段 OpenAI 请求体 JSON 当一条消息发出去——功能一样，但在站点眼里就是「这是 API 代理」，更容易被风控盯上。' +
                '注意：这只改变「发出去的文字长相」，不改变「用网页版跑工具」这件事本身。',
            ),
          ),

          (function () {
            const ts = (state && state.transport) || {};
            const mode = ['device', 'browser', 'native', 'node'].indexOf(cfg.transport) >= 0 ? cfg.transport : 'auto';
            const st = ts.status || null;
            const nat = ts.native || null;
            const bin = ts.browser || (st && st.path) || '';
            const eff = ts.effective || (mode === 'node' ? 'node' : 'browser');
            const ver = st && st.version ? String(st.version).replace(/^Google /, '') : '';
            const dev = ts.device || null;
            const devOn = Boolean(dev && dev.ok);
            const viaDevice = Boolean(ts.deviceActive && devOn);
            const label = viaDevice ? '手机浏览器' : eff === 'native' ? '本地伪装' : eff === 'browser' ? '真实浏览器' : 'Node 直连';
            const detail = viaDevice
              ? (dev.browser ? String(dev.browser).replace(/^Google /, '') : '真机 CDP') + ' · 端口 ' + dev.port + '（请求从手机上那台浏览器发出）'
              : eff === 'browser'
                ? (bin || '没找到浏览器') + (ver ? '（' + ver + '）' : '')
                : eff === 'native'
                  ? (nat && nat.ok
                      ? String(nat.python || 'python') + (nat.version ? ' · curl_cffi ' + nat.version : '')
                      : String((nat && nat.reason) || '不可用').slice(0, 90))
                  : 'TLS 指纹可直接被识破';
            const bad = eff === 'node';
            return h(
              'div',
              { style: { display: 'flex', flexDirection: 'column', gap: 4, marginTop: 2 } },
              h(
                'div',
                { style: S.row },
                h('span', null, '传输层'),
                h(
                  'button',
                  { style: { ...S.button, ...(mode === 'auto' ? { borderColor: 'var(--dsw-alias-label-primary, #fff)', fontWeight: 600 } : {}) }, onClick: () => saveCfg({ transport: 'auto' }) },
                  '自动',
                ),
                h(
                  'button',
                  { style: { ...S.button, ...(mode === 'device' ? { borderColor: 'var(--dsw-alias-label-primary, #fff)', fontWeight: 600 } : {}) }, onClick: () => saveCfg({ transport: 'device' }) },
                  '手机浏览器',
                ),
                h(
                  'button',
                  {
                    style: { ...S.button, ...(mode === 'browser' ? { borderColor: 'var(--dsw-alias-label-primary, #fff)', fontWeight: 600 } : {}), ...(st && st.ok === false ? { opacity: 0.6 } : {}) },
                    title: st && st.ok === false ? '本机的 Chromium 在这台机器上起不来（缺 dbus / 共享内存），这一档选了也用不了；要用真浏览器请选「手机浏览器」' : '只允许本机真实浏览器',
                    onClick: () => saveCfg({ transport: 'browser' }),
                  },
                  st && st.ok === false ? '浏览器（本机不可用）' : '浏览器',
                ),
                helpTip(
                  'transport',
                  '手机浏览器（最真，最慢）：接管手机上已经在跑的 Chrome / Edge 的调试端口，请求由那台真浏览器自己发出 —— 真进程、真证书链、真 HTTP/2 帧、真 cookie。代价是要一直开着页面、每次请求多几十毫秒到几百毫秒，手机更耗电。' +
                    '要求：Chrome 以 --remote-debugging-port=9222 启动，且本机能连到该端口；用不了时会明确报错，绝不静默降级。' +
                    '自动（推荐）：先试手机浏览器，不行再试本机浏览器，再不行用本地伪装（curl_cffi，JA4 = Chrome），最后才 Node 直连并亮红字。' +
                    '浏览器：只允许本机真实浏览器。' +
                    '所有出站（对话、PoW、建会话、体检、登录）都走同一个档位，不会混用两套 TLS 栈。',
                ),
              ),
              h(
                'div',
                { style: S.row },
                h(
                  'button',
                  {
                    style: S.button,
                    onClick: () =>
                      run('probe', async () => {
                        const r = eff === 'browser' ? await api('/transport/probe', { method: 'POST' }) : await api('/transport/probe-native', { method: 'POST' });
                        setProbe({ ...r, kind: eff });
                        if (r && r.ok === false) setNotice(r.error || r.reason || '检测未通过');
                      }),
                  },
                  busy === 'probe' ? '检测中…' : '检测连接',
                ),
                h(
                  'span',
                  { style: { ...S.hint, color: bad ? '#e5484d' : undefined } },
                  '当前：' + label + ' · ' + detail +
                    (eff === 'browser' && st && st.ok === false ? '（这一档在本机起不来：「自动」会跳过它落到本地伪装）' : ''),
                ),
                probe && probe.kind
                  ? h(
                      'span',
                      { style: { ...S.hint, color: probe.ok ? '#3fb950' : '#e5484d' } },
                      probe.ok
                        ? '✅ ' + (probe.ja4 || '可用') + (probe.httpVersion ? ' · ' + probe.httpVersion : '') + '（' + probe.ms + 'ms）'
                        : '❌ ' + String(probe.error || probe.reason || '').slice(0, 140),
                    )
                  : null,
              ),
              bad
                ? h(
                    'p',
                    { style: { ...S.hint, color: '#e5484d', margin: 0 } },
                    mode === 'auto'
                      ? '⚠ 自动选路已回退 Node 直连：TLS 指纹可被识破，封号风险更高。装 python3 后点「检测连接」会自动装 curl_cffi 并切到本地伪装；或在高级选项里指定 Python / 浏览器路径。'
                      : '⚠ 已强制 Node 直连：TLS 层就能被判成「不是浏览器」，风险更高。',
                  )
                : null,
              mode === 'device' && dev && !devOn
                ? h(
                    'div',
                    { style: { padding: '6px 8px', borderRadius: 6, background: 'rgba(229,72,77,.08)', border: '1px solid rgba(229,72,77,.35)' } },
                    h('p', { style: { ...S.hint, color: '#e5484d', margin: 0 } }, '⚠ 手机浏览器不可用：' + String(dev.reason || '没检测到调试端口')),
                    h('p', { style: { ...S.hint, margin: '4px 0 0' } }, '要做的事（一次性）：① 手机 Chrome 打开 chrome://flags ，开启「Enable command line on non-rooted devices」；② 用 Shizuku/文件管理器把一行参数写进 /data/local/tmp/chrome-command-line：chrome --remote-debugging-port=9222 ；③ 彻底退出 Chrome（划掉全部标签/后台）再打开；④ 在 Chrome 里访问一次 chat.deepseek.com；⑤ 回来点「检测连接」。'),
                  )
                : null,
              mode === 'browser' && st && st.ok === false
                ? h(
                    'div',
                    { style: { padding: '6px 8px', borderRadius: 6, background: 'rgba(229,72,77,.08)', border: '1px solid rgba(229,72,77,.35)', display: 'flex', flexDirection: 'column', gap: 4 } },
                    h('p', { style: { ...S.hint, color: '#e5484d', margin: 0 } }, '⚠ 这台机器上起不来：' + String(st.reason || '').split('。')[0].slice(0, 120)),
                    h('p', { style: { ...S.hint, margin: 0 } }, '容器里缺 dbus / 共享内存，Chromium 一开页面就 SIGTRAP，不是路径问题，也不是插件 bug。三个走法：'),
                    h(
                      'div',
                      { style: { display: 'flex', gap: 6, flexWrap: 'wrap' } },
                      h('button', { style: { ...S.button, padding: '5px 8px', fontSize: 12 }, title: '用 curl_cffi 的 Chrome 指纹走 TLS+HTTP2，不需要浏览器', onClick: () => saveCfg({ transport: 'native' }) }, '用本地伪装'),
                      h('button', { style: { ...S.button, padding: '5px 8px', fontSize: 12 }, title: '请求从手机上真实的 Chrome 发出（最不容易被判定为自动化），需要一次性开调试端口', onClick: () => saveCfg({ transport: 'device' }) }, '用手机浏览器'),
                      h('button', { style: { ...S.button, padding: '5px 8px', fontSize: 12 }, onClick: () => saveCfg({ transport: 'auto' }) }, '自动选（推荐）'),
                    ),
                    h(
                      'details',
                      { style: { marginTop: 2 } },
                      h('summary', { style: { ...S.hint, cursor: 'pointer' } }, '为什么起不来（日志）'),
                      h('p', { style: { ...S.hint, margin: '4px 0 0', whiteSpace: 'pre-wrap', fontSize: 11.5, opacity: 0.85 } }, String(st.tail || st.reason || '没有更多日志')),
                    ),
                  )
                : null,
              h(
                'details',
                { style: { marginTop: 2 } },
                h('summary', { style: { ...S.hint, cursor: 'pointer', color: '#e5484d' } }, '高级选项（高危，默认关闭）'),
                h(
                  'div',
                  { style: { display: 'flex', flexDirection: 'column', gap: 6, marginTop: 6, paddingLeft: 10, borderLeft: '2px solid #e5484d' } },
                  h('p', { style: { ...S.hint, margin: 0 } }, '下面是旧实现 / 机器特征明显的开关，默认关闭。参考实现实测：几分钟内换号继续发是极强的机器行为特征，多号交替反而更容易被判成「同一人的多开小号」，处置可能波及全部关联账号。'),
                  h(
                    'div',
                    { style: S.row },
                    h('span', { style: S.hint }, '传输层原始档位'),
                    h(
                      'button',
                      { style: { ...S.button, ...(mode === 'node' ? { borderColor: '#e5484d', color: '#e5484d', fontWeight: 600 } : {}) }, onClick: () => saveCfg({ transport: 'node' }) },
                      'Node 直连',
                    ),
                    helpTip('nodeMode', '旧实现：请求走 Node 的 undici，在 TLS 层就能被判成「不是浏览器」，这项调参修不了。只在没有 Python、也没有浏览器的机器上临时用。'),
                  ),
                  h(
                    'div',
                    { style: S.row },
                    h('span', { style: { ...S.hint } }, '浏览器路径'),
                    h('input', {
                      style: { ...S.input, minWidth: 220 },
                      placeholder: '留空 = 自动探测',
                      defaultValue: cfg.browserPath || '',
                      onBlur: (e) => {
                        const v = String((e.target && e.target.value) || '').trim();
                        if (v !== (cfg.browserPath || '')) saveCfg({ browserPath: v });
                      },
                    }),
                    helpTip(
                      'browserPath',
                      '自动探测会找 PATH、/opt/google/chrome、/usr/lib/chromium、snap/flatpak，以及 Playwright（~/.cache/ms-playwright）和 Puppeteer（~/.cache/puppeteer）缓存。都不中就在这里写死可执行文件路径；等价环境变量 DSW_BROWSER_PATH。',
                    ),
                  ),
                  h(
                    'div',
                    { style: S.row },
                    h('span', { style: { ...S.hint } }, 'Python 路径'),
                    h('input', {
                      style: { ...S.input, minWidth: 220 },
                      placeholder: '留空 = 自动探测（python3）',
                      defaultValue: cfg.nativePython || '',
                      onBlur: (e) => {
                        const v = String((e.target && e.target.value) || '').trim();
                        if (v !== (cfg.nativePython || '')) saveCfg({ nativePython: v });
                      },
                    }),
                    helpTip('nativePython', '本地伪装用哪个解释器。留空按 DSW_PYTHON 环境变量、python3、python、py 顺序探测。没有 pip 时插件会自建 venv 装依赖，不污染系统 Python。'),
                  ),
                  h(
                    'label',
                    { style: S.row },
                    h('input', {
                      type: 'checkbox',
                      checked: cfg.autoSwitch === true,
                      onChange: (e) => saveCfg({ autoSwitch: e.target.checked }),
                    }),
                    h('span', { style: { color: '#e5484d' } }, '账号失效 / 被限流时自动换下一个账号（高危，默认关）'),
                    helpTip('autoSwitch', '开着 = 旧行为：某个号失效或被限流时本轮自动换号接着跑。关掉 = 直接报错停住，等你处理（更不容易被判定成多开小号轮换）。'),
                  ),
                ),
              ),
            );
          })(),
          h(
            'div',
            { style: S.row },
            h('span', null, '无浏览器直连 chat.deepseek.com'),
            helpTip('bridgeIntro', '不需要装浏览器插件、也不用连官方 API：插件在本机起一个 OpenAI 兼容网关，用你的网页版账号把提问转发给 chat.deepseek.com。token 与保存的密码只在本机；同一账号的请求串行并节流，降低风控概率。'),
          ),
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
            h('span', null, '同账号间隔（ms，随机）'),
            h('input', {
              style: { ...S.input, flex: '0 0 84px' },
              type: 'number',
              min: 0,
              step: 100,
              value: cfg.sendGapMs || 2500,
              onChange: (e) => saveCfg({ sendGapMs: Math.max(0, Number(e.target.value)) }),
            }),
            h('span', null, '~'),
            h('input', {
              style: { ...S.input, flex: '0 0 84px' },
              type: 'number',
              min: 0,
              step: 100,
              value: cfg.sendGapMaxMs || 4500,
              onChange: (e) => saveCfg({ sendGapMaxMs: Math.max(0, Number(e.target.value)) }),
            }),
            helpTip('sendGap', '两次请求之间的间隔在「下限~上限」里随机取，不是固定值 —— 固定间隔方差≈0，统计上就是定时器特征。参考实现默认 2000~4000ms。间隔从上一次请求*结束*起算。'),
            h('span', null, '窗口限速'),
            h('input', {
              style: { ...S.input, flex: '0 0 70px' },
              type: 'number',
              min: 1,
              step: 1,
              value: Math.round((cfg.rateWindowMs || 1800000) / 60000),
              onChange: (e) => saveCfg({ rateWindowMs: Math.max(1, Number(e.target.value)) * 60000 }),
            }),
            h('span', null, '分钟内 ≤'),
            h('input', {
              style: { ...S.input, flex: '0 0 70px' },
              type: 'number',
              min: 0,
              step: 1,
              value: cfg.rateMaxInWindow || 20,
              onChange: (e) => saveCfg({ rateMaxInWindow: Math.max(0, Number(e.target.value)) }),
            }),
            h('span', null, '次'),
          ),
          h(
            'div',
            { style: S.row },
            h('label', { style: S.row },
              h('input', {
                type: 'checkbox',
                checked: cfg.humanRhythm !== false,
                onChange: (e) => saveCfg({ humanRhythm: e.target.checked }),
              }),
              h('span', null, '人类节律'),
            ),
            h('span', { style: S.hint }, '每日上限'),
            h('input', {
              style: { ...S.input, flex: '0 0 72px' },
              type: 'number',
              min: 0,
              step: 10,
              value: cfg.dailyMsgs === 0 ? 0 : cfg.dailyMsgs || 240,
              onChange: (e) => saveCfg({ dailyMsgs: Math.max(0, Number(e.target.value)) }),
            }),
            h('span', { style: S.hint }, '条/24h（0=不限）'),
            helpTip(
              'humanRhythm',
              '开着 = 学真人：间隔按「这条消息有多少字」自动加打字时间（真人不会 2000 字一秒打完）；深夜 01:00~06:30 自动把间隔放大；每轮 5% 概率插入 8~75 秒走神停顿；每个账号 24 小时滑动窗口内有条数上限（默认 240）。' +
                '这些都是站点风控最常用的统计特征（频率、体量、作息），比 TLS 指纹更难洗。关掉 = 回到纯随机间隔。',
            ),
          ),
          h(
            'div',
            { style: S.row },
            h('label', { style: S.row },
              h('input', {
                type: 'checkbox',
                checked: cfg.warmup !== false,
                onChange: (e) => saveCfg({ warmup: e.target.checked }),
              }),
              h('span', null, '登录后先闲聊'),
            ),
            h('span', { style: S.hint }, '每个账号首次使用前，像人一样随便聊'),
            h('input', {
              style: { ...S.input, flex: '0 0 56px' },
              type: 'number',
              min: 0,
              max: 4,
              step: 1,
              value: Number(cfg.warmupMsgs) || 0,
              onChange: (e) => saveCfg({ warmupMsgs: Math.max(0, Math.min(4, Number(e.target.value))) }),
            }),
            h('span', { style: S.hint }, '句'),
            helpTip(
              'warmup',
              '新账号第一次发消息之前，先走正常出站路径、按人类节律随便聊 1~2 句（内容从内置短句里随机挑，比如「你好呀」「今天有点累」）。' +
                '原因：登录后立刻上工具调用，在服务端看就是「登录 → 高频结构化请求」；人一般是先打个招呼。' +
                '只做一次（记 warmupAt），失败不阻塞真实请求。它改变不了自动化访问的性质，只让账号的前几条消息更像人。',
            ),
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
                        { style: { display: 'flex', flexDirection: 'column', gap: 6, marginTop: 2 } },
                        h(
                          'span',
                          { style: { ...S.hint, fontSize: 11.5, opacity: 0.75 } },
                          '按网页会话统计：同一个网页会话续聊会累计到一起，所以「轮次」比对话条数多。',
                        ),
                        ...convs.map(([id, c]) => {
                          // 老记录里存的是一句自动检查的套话（每个会话都一样），显示成「自动检查会话」，靠 id + 时间区分
                          const BOILER = /automatically generated check|自动生成的检查|自动检查|auto[- ]?continue/i;
                          const title = !c.label
                            ? '（无标题会话）'
                            : BOILER.test(c.label)
                              ? '自动检查 / 续跑会话'
                              : c.label;
                          const when = c.updatedAt
                            ? new Date(c.updatedAt).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
                            : '';
                          return h(
                            'div',
                            { key: id, style: { display: 'flex', flexWrap: 'wrap', alignItems: 'baseline', gap: '2px 8px' } },
                            h(
                              'span',
                              {
                                style: { fontSize: 12.5, color: 'var(--dsw-alias-label-primary, #dfe3ea)', wordBreak: 'break-all' },
                                title: title,
                              },
                              title,
                            ),
                            h(
                              'span',
                              { style: { ...S.hint, fontSize: 11.5, color: 'var(--dsw-alias-label-tertiary, #6b7280)' }, title: '网页会话 id（排查时用）' },
                              '#' + String(id).slice(0, 8) + (when ? ' · ' + when : ''),
                            ),
                            h(
                              'span',
                              { style: { ...S.hint, marginLeft: 'auto' }, title: (Number(c.prompt) || 0).toLocaleString() + ' 输入 / ' + (Number(c.completion) || 0).toLocaleString() + ' 输出' },
                              fmtTokens((c.prompt || 0) + (c.completion || 0)) + ' tok · 缓存 ' + fmtTokens(c.cached || 0) + ' · ' + c.turns + ' 轮',
                            ),
                          );
                        }),
                      )
                    : null,
                )
              : null,
          );
        })(),

        h(
          'div',
          { style: cardStyle('ledger') },
          h(
            'div',
            { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' } },
            h('h3', { style: S.title }, '调用台账'),
            h(
              'div',
              { style: { display: 'flex', gap: 6, alignItems: 'center' } },
              h(
                'select',
                {
                  className: 'dswx-select',
                  style: S.select,
                  value: ledgerHours,
                  onChange: (e) => {
                    const vv = Number(e.target.value);
                    setLedgerHours(vv);
                    loadLedger(vv);
                  },
                },
                [1, 6, 24, 72].map((hh) => h('option', { key: hh, value: hh }, '最近 ' + hh + ' 小时')),
              ),
              h(
                'button',
                { style: { ...S.button, padding: '6px 10px', fontSize: 12.5 }, disabled: ledgerBusy, onClick: () => loadLedger(ledgerHours) },
                ledgerBusy ? '读取中…' : '刷新台账',
              ),
            ),
          ),
          !ledgerData
            ? h('p', { style: S.hint }, '读取中…')
            : (() => {
                const L = ledgerData;
                const failures = Object.entries(L.failures || {}).sort((a, b) => b[1] - a[1]);
                const gaps = L.gaps;
                const hours = L.hourly || [];
                const hmax = Math.max(1, ...hours);
                const blocks = '▁▂▃▄▅▆▇█';
                const spark = hours.map((v) => blocks[Math.min(7, Math.round((v / hmax) * 7))]).join('');
                return h(
                  'div',
                  { style: { display: 'flex', flexDirection: 'column', gap: 10 } },
                  h(
                    'div',
                    { style: S.stats },
                    h('div', { style: S.statBox }, h('span', { style: S.statNum }, L.calls), h('span', { style: S.statLabel }, '调用')),
                    h('div', { style: S.statBox }, h('span', { style: { ...S.statNum, color: '#46a758' } }, L.succeeded), h('span', { style: S.statLabel }, '成功')),
                    h('div', { style: S.statBox }, h('span', { style: { ...S.statNum, color: L.failed ? '#ff9632' : undefined } }, L.failed), h('span', { style: S.statLabel }, '失败')),
                    h('div', { style: S.statBox }, h('span', { style: S.statNum }, gaps ? fmtMs(gaps.p50) : '—'), h('span', { style: S.statLabel }, '间隔中位')),
                    h('div', { style: S.statBox }, h('span', { style: S.statNum }, gaps ? fmtMs(gaps.p90) : '—'), h('span', { style: S.statLabel }, '间隔 p90')),
                  ),
                  h(
                    'div',
                    { style: { display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' } },
                    h('span', { style: S.spark, title: '每小时调用量（相对高度）' }, spark || '—'),
                    h('span', { style: S.hint }, '最近 ' + L.hours + ' 小时的每小时调用量'),
                  ),
                  failures.length
                    ? h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 6 } }, ...failures.map(([k, n]) => h('span', { key: k, style: S.failChip }, k + ' × ' + n)))
                    : h('p', { style: S.hint }, '这段时间没有失败调用。'),
                  h(
                    'div',
                    { style: { display: 'flex', flexWrap: 'wrap', gap: '2px 12px' } },
                    h('span', { style: S.hint }, '台账占用 ' + (L.footprint?.files || 0) + ' 个文件 · ' + Math.round((L.footprint?.bytes || 0) / 1024) + ' KB（保留 7 天）'),
                    gaps ? h('span', { style: S.hint }, '样本 ' + gaps.samples + ' · 最短 ' + fmtMs(gaps.min) + ' · 最长 ' + fmtMs(gaps.max)) : null,
                  ),
                );
              })(),
        ),

        h(
          'div',
          { style: cardStyle('sessions') },
          h(
            'div',
            { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' } },
            h('h3', { style: S.title }, '登录会话'),
            h(
              'button',
              { style: { ...S.button, padding: '6px 10px', fontSize: 12.5 }, disabled: sessionsBusy, title: '重新扫一遍本机的登录会话（cookie 罐）', onClick: () => loadSessions() },
              sessionsBusy ? '刷新中…' : '刷新',
            ),
          ),
          h('p', { style: { ...S.hint, margin: '0 0 4px' } },
            '每次登录都会在本机留下一个会话（cookie 罐）。站点还没掉登录时，用同一个会话重开登录页就能直接把 token 抓回来——不用密码、不用验证码。',
          ),
          sessions.length === 0
            ? h('p', { style: S.hint }, '本机还没有登录会话：登录一次之后这里会出现记录。')
            : h(
                'div',
                { style: { display: 'flex', flexDirection: 'column', gap: 6 } },
                ...sessions.slice(0, 8).map((ss) => {
                  const owner = list.find((a) => a.id === ss.accountId) || null;
                  const when = ss.at ? new Date(ss.at).toLocaleString('zh-CN') : '未知时间';
                  const stale = Date.now() - (ss.at || 0) > 7 * 24 * 3600 * 1000;
                  return h(
                    'div',
                    { key: ss.sid, style: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8, borderTop: '1px solid var(--dsw-alias-border-l4, rgba(128,128,128,.15))', paddingTop: 6 } },
                    h('code', { style: { fontSize: 11.5, opacity: 0.8 } }, ss.sid.slice(0, 8) + '…'),
                    h('span', { style: S.hint }, when + ' · ' + ss.cookies + ' 个 cookie' + (ss.hits ? ' · 回传 ' + ss.hits + ' 次' : '')),
                    owner ? h('span', { style: S.badge(true) }, owner.label) : h('span', { style: S.hint }, '未关联账号'),
                    ss.source ? h('span', { style: S.hint }, ss.source) : null,
                    stale ? h('span', { style: { ...S.hint, color: '#ff9632' } }, '可能已过期') : null,
                    h('button', {
                      style: { ...S.button, padding: '4px 9px', fontSize: 12 },
                      disabled: busy === 'rsess' + ss.sid,
                      title: '用这个会话重开登录页（不输密码，登录页会把 token 回填）',
                      onClick: () => run('rsess' + ss.sid, async () => {
                        const out = await api('/login/restore', { method: 'POST', body: JSON.stringify({ sid: ss.sid, accountId: owner ? owner.id : '' }) });
                        if (!out || out.ok === false) throw new Error((out && out.message) || '恢复失败');
                        if (out.url && !out.opened) {
                          if (!openExternal(out.url)) await showUrl(out.url);
                        }
                        return { ok: true, message: out.message };
                      }),
                    }, busy === 'rsess' + ss.sid ? '打开中…' : '用这次会话登录'),
                    h('button', {
                      style: { ...S.button, padding: '4px 9px', fontSize: 12 },
                      disabled: busy === 'fsess' + ss.sid,
                      title: '删掉这个会话的 cookie 罐（账号本身不受影响）',
                      onClick: async () => {
                        if (!(await uiConfirm('删掉这个登录会话的 cookie 罐？账号本身不会被删除。'))) return;
                        run('fsess' + ss.sid, async () => {
                          const out = await api('/login/sessions/forget', { method: 'POST', body: JSON.stringify({ sid: ss.sid }) });
                          if (!out || out.ok === false) throw new Error((out && out.message) || '清理失败');
                          await loadSessions();
                          return { ok: true, message: out.message };
                        });
                      },
                    }, '清理'),
                  );
                }),
              ),
        ),
        h(
          'div',
          { style: cardStyle('diagnostics') },
          h(
            'div',
            { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' } },
            h('h3', { style: S.title }, '登录状态'),
            h(
              'button',
              { style: { ...S.button, padding: '6px 10px', fontSize: 12.5 }, disabled: diagBusy, title: '额外验证一次当前账号的 token，并测试站点连通性（会发两次只读请求）', onClick: () => loadDiag(true) },
              diagBusy ? '检测中…' : '重新检测',
            ),
          ),
          !diag
            ? h('p', { style: S.hint }, '正在读取…')
            : (() => {
                const d = diag;
                const session = d.proxy?.health || null;
                const active = d.accounts?.active || null;
                const shape = active?.cookieShape;
                return h(
                  'div',
                  { style: { display: 'flex', flexDirection: 'column', gap: 6 } },
                  diagRow('插件版本', true, 'v' + d.version + (d.installedVersion && d.installedVersion !== d.version ? '（磁盘已装 v' + d.installedVersion + '，重启 DSH 后生效）' : '')),
                  diagRow('引擎', d.engine === 'running', d.engine === 'running' ? '运行中 · 端口 ' + d.ports?.engine : d.engine === 'starting' ? '启动中' : '空闲（首次调用自动拉起）'),
                  diagRow('适配器', Boolean(d.adapter?.registered), d.adapter?.registered ? 'deepseek-web 已注册 · ' + (d.adapter.models || []).map((m) => m.id).join(' / ') : '未注册'),
                  diagRow('PoW 求解', Boolean(d.pow?.ok), d.pow?.ok ? 'DeepSeekHashV1 wasm 自检通过（' + d.pow.ms + 'ms）' : '自检失败：' + (d.pow?.message || '未知原因') + '（PoW 失效会导致每次发消息都被拒）'),
                  diagRow('登录代理', Boolean(d.proxy?.ok), d.proxy?.ok ? '127.0.0.1:' + d.ports?.login + ' · 已缓存资源 ' + (session?.cachedAssets ?? '?') + ' 个' + (session?.pageCached ? ' · 登录页已缓存' : ' · 登录页缓存为空') : '未响应：' + (d.proxy?.message || '可能还没启动过登录页')),
                  diagRow('账号池', (d.accounts?.total || 0) > 0, '共 ' + (d.accounts?.total || 0) + ' 个 · 已采集指纹 ' + (d.accounts?.withFingerprint || 0) + ' 个 · 存了密码 ' + (d.accounts?.withPassword || 0) + ' 个'),
                  active
                    ? diagRow('当前账号', active.status === 'ok', active.name + ' · ' + active.status + (active.loginSource ? ' · 来源 ' + active.loginSource : '') + (active.hasFingerprint ? ' · 指纹已采集' : ' · 未采集指纹'))
                    : diagRow('当前账号', false, '账号池为空，先在「添加账号」里登录一个'),
                  shape
                    ? diagRow('cookie 构成', true, active.name + '：' + shape.total + ' 项 · ' + shape.sessionCount + ' 会话级' + (shape.persistentCount ? ' · ' + shape.persistentCount + ' 持久级' + (shape.latest ? '（' + shape.latest.name + ' 还剩 ' + shape.latest.daysLeft + ' 天）' : '') : '') + (shape.sessionCount ? ' —— 会话级 cookie 宿主进程一退出就没了，这是「又要重登」的常见原因' : ''))
                    : null,
                  d.site ? diagRow('站点连通', Boolean(d.site.ok), d.site.ok ? 'chat.deepseek.com 可达（HTTP ' + d.site.status + ' · ' + d.site.ms + 'ms）' : '不可达：' + (d.site.message || 'HTTP ' + d.site.status)) : null,
                  d.verified ? diagRow('凭证校验', d.verified.state === 'valid', d.verified.state === 'valid' ? d.verified.name + ' 的 token 有效（' + d.verified.ms + 'ms）' : d.verified.state === 'invalid' ? d.verified.name + ' 的 token 已失效，需要重新登录' : '没验出来：' + (d.verified.message || '网络/风控原因，账号状态未改动')) : null,
                  !d.site && !d.verified ? h('p', { style: S.hint }, '点「重新检测」会额外测一次站点连通性和当前账号 token（只读，不消耗对话额度）。') : null,
                );
              })(),
        ),

        h(
          'div',
          { style: cardStyle('accounts') },
          h(
            'div',
            { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' } },
            h('h3', { style: S.title }, '账号管理（' + list.length + '）'),
            list.length > 0
              ? h(
                  'div',
                  { style: { display: 'flex', gap: 6, flexWrap: 'wrap' } },
                  h(
                    'button',
                    {
                      style: { ...S.button, padding: '6px 10px', fontSize: 12.5, whiteSpace: 'nowrap' },
                      title: '新建一个分组：只影响面板显示方式，不影响切号、会话复用与凭证',
                      onClick: createGroup,
                    },
                    '新建分组',
                  ),
                  h(
                    'button',
                    {
                      style: { ...S.button, padding: '6px 10px', fontSize: 12.5, whiteSpace: 'nowrap' },
                      disabled: busy === 'checkall',
                      title: '用一个只读接口把每个账号的登录态验一遍：能立刻看出哪个号掉登录了，不会消耗对话额度',
                      onClick: () => run('checkall', () => api('/accounts/check-all', { method: 'POST' })),
                    },
                    busy === 'checkall' ? '体检中…' : '全部体检',
                  ),
                  // v1.0.54：把 导出/导入/查重复/多选 收进「更多」，默认只留 新建分组 / 全部体检 / 更多
                  h(
                    'button',
                    {
                      style: { ...S.button, padding: '6px 10px', fontSize: 12.5, whiteSpace: 'nowrap' },
                      title: acctMore ? '收起次要操作' : '导出备份 / 导入备份 / 查重复 / 多选',
                      onClick: () => setAcctMore(!acctMore),
                    },
                    acctMore ? '收起' : '更多',
                  ),
                  acctMore
                    ? h(
                    'div',
                    { style: { display: 'flex', gap: 6, flexWrap: 'wrap' } },
                  h(
                    'button',
                    {
                      style: { ...S.button, padding: '6px 10px', fontSize: 12.5, whiteSpace: 'nowrap' },
                      title: '把账号库导出成 JSON 备份（含 token/cookie，等于可登录的凭证，别外传）',
                      onClick: () => run('export', async () => {
                        const out = await api('/accounts/export');
                        const text = JSON.stringify({ version: out.version, exportedAt: out.exportedAt, accounts: out.accounts }, null, 2);
                        const name = 'deepseek-accounts-' + new Date().toISOString().slice(0, 10) + '.json';
                        try {
                          const blob = new Blob([text], { type: 'application/json' });
                          const url = URL.createObjectURL(blob);
                          const a = document.createElement('a');
                          a.href = url;
                          a.download = name;
                          document.body.appendChild(a);
                          a.click();
                          a.remove();
                          setTimeout(() => URL.revokeObjectURL(url), 4000);
                        } catch (error) {
                          throw new Error('导出失败：' + (error.message || error));
                        }
                        return { ok: true, message: '已导出 ' + (out.accounts || []).length + ' 个账号到 ' + name + '（含 token，注意保管）' };
                      }),
                    },
                    busy === 'export' ? '导出中…' : '导出备份',
                  ),
                  h(
                    'button',
                    {
                      style: { ...S.button, padding: '6px 10px', fontSize: 12.5, whiteSpace: 'nowrap' },
                      title: '从导出的 JSON 备份导入账号（按 token 去重，已存在的只补 cookie/邮箱）',
                      onClick: () => {
                        const input = document.createElement('input');
                        input.type = 'file';
                        input.accept = 'application/json,.json';
                        input.onchange = () => {
                          const file = input.files && input.files[0];
                          if (!file) return;
                          const reader = new FileReader();
                          reader.onload = () => {
                            run('import', async () => {
                              let data = null;
                              try { data = JSON.parse(String(reader.result || '{}')); } catch { throw new Error('文件不是合法的 JSON'); }
                              const out = await api('/accounts/import', { method: 'POST', body: JSON.stringify({ data }) });
                              if (!out || out.ok === false) throw new Error((out && out.message) || '导入失败');
                              return { ok: true, message: out.message || ('导入完成：新增 ' + out.added + ' 个') };
                            });
                          };
                          reader.readAsText(file);
                        };
                        input.click();
                      },
                    },
                    busy === 'import' ? '导入中…' : '导入备份',
                  ),
                  h(
                    'button',
                    {
                      style: { ...S.button, padding: '6px 10px', fontSize: 12.5, whiteSpace: 'nowrap' },
                      disabled: busy === 'dup',
                      title: '按 DeepSeek 账号（user_id / 完整邮箱）查重：同一个号重复登过几次会列出来，一键合并成一个',
                      onClick: () => run('dup', async () => {
                        const data = await checkDup();
                        if (!data) return { ok: false, message: '重复检测失败' };
                        return {
                          ok: true,
                          message: data.groups && data.groups.length
                            ? '发现 ' + data.groups.length + ' 组重复账号（共 ' + data.total + ' 个），下面可以一键合并'
                            : '没有发现重复账号',
                        };
                      }),
                    },
                    busy === 'dup' ? '检测中…' : '查重复',
                  ),
                  h(
                    'button',
                    {
                      style: { ...S.button, padding: '6px 10px', fontSize: 12.5, whiteSpace: 'nowrap' },
                      title: '多选：勾上几个账号，一次启用 / 禁用 / 移组 / 删除',
                      onClick: () => {
                        if (selectMode) setSelected({});
                        setSelectMode(!selectMode);
                      },
                    },
                    selectMode ? '结束多选' : '多选',
                  ),
                    )
                  : null,
                )
              : null,
          ),
          h(
            'p',
            { style: { ...S.hint, margin: 0, fontSize: 11.5 }, title: '这三个开关决定「像不像人」：节律（间隔 / 打字 / 作息 / 每日上限）、登录后先闲聊、出站走哪条路（传输层）' },
            '像人一样：' +
              (cfg.humanRhythm !== false ? '节律开' : '节律关') +
              ' · ' +
              (cfg.warmup !== false ? '闲聊 ' + (Number(cfg.warmupMsgs) || 2) + ' 句' : '不闲聊') +
              ' · ' +
              (cfg.transport === 'device' ? '手机浏览器' : cfg.transport === 'browser' ? '本机浏览器' : cfg.transport === 'native' ? '本地伪装' : '自动选路'),
          ),
          dupInfo && dupInfo.groups && dupInfo.groups.length
            ? h(
                'div',
                { style: { ...S.row, gap: 8, alignItems: 'center', flexWrap: 'wrap', border: '1px dashed rgba(255,150,50,.55)', borderRadius: 8, padding: '8px 10px' } },
                h('span', { style: { ...S.hint, color: '#ff9632' } },
                  '发现 ' + dupInfo.groups.length + ' 组重复账号：' + dupInfo.groups.map((g) => (g.accounts[0].email || g.accounts[0].label) + ' × ' + g.accounts.length).join('、'),
                ),
                h('button', {
                  style: { ...S.button, padding: '5px 10px', fontSize: 12.5 },
                  disabled: busy === 'merge',
                  title: '每组只留一个（优先保留「存了密码 + 采集过指纹 + 最近用过」的那个），把其他的 cookie/密码/分组并过去后删除',
                  onClick: () => run('merge', async () => {
                    const out = await api('/accounts/duplicates/merge', { method: 'POST' });
                    if (!out || out.ok === false) throw new Error((out && out.message) || '合并失败');
                    setDupInfo(null);
                    return { ok: true, message: out.message };
                  }),
                }, busy === 'merge' ? '合并中…' : '一键合并'),
                h('button', { style: { ...S.button, padding: '5px 10px', fontSize: 12.5 }, onClick: () => setDupInfo(null) }, '忽略'),
              )
            : null,
          selectMode
            ? (() => {
                const ids = idsOfSelected();
                return h(
                  'div',
                  { style: { ...S.row, gap: 8, alignItems: 'center', flexWrap: 'wrap', background: 'rgba(90,169,255,.10)', border: '1px solid rgba(90,169,255,.35)', borderRadius: 8, padding: '8px 10px' } },
                  h('strong', { style: { fontSize: 13 } }, '已选 ' + ids.length + ' 个'),
                  h('button', {
                    style: { ...S.button, padding: '5px 10px', fontSize: 12.5 },
                    disabled: !ids.length || busy === 'bulk',
                    onClick: () => run('bulk', async () => {
                      const out = await api('/accounts/bulk', { method: 'POST', body: JSON.stringify({ ids, action: 'enable' }) });
                      if (!out || out.ok === false) throw new Error((out && out.message) || '批量启用失败');
                      setSelected({});
                      return { ok: true, message: out.message };
                    }),
                  }, '启用'),
                  h('button', {
                    style: { ...S.button, padding: '5px 10px', fontSize: 12.5 },
                    disabled: !ids.length || busy === 'bulk',
                    title: '禁用后这个账号不参与调度（凭证和会话都保留，随时能再启用）',
                    onClick: () => run('bulk', async () => {
                      const out = await api('/accounts/bulk', { method: 'POST', body: JSON.stringify({ ids, action: 'disable' }) });
                      if (!out || out.ok === false) throw new Error((out && out.message) || '批量禁用失败');
                      setSelected({});
                      return { ok: true, message: out.message };
                    }),
                  }, '禁用'),
                  groupDefs.length
                    ? h('select', {
                        className: 'dswx-select',
                        style: { ...S.select, minWidth: 120 },
                        value: '',
                        disabled: !ids.length || busy === 'bulk',
                        title: '把选中的账号批量移到某个分组',
                        onChange: (e) => {
                          const gid = e.target.value;
                          if (!gid && gid !== '') return;
                          run('bulk', async () => {
                            const out = await api('/accounts/bulk', { method: 'POST', body: JSON.stringify({ ids, action: 'group', groupId: gid === '__ungrouped__' ? '' : gid }) });
                            if (!out || out.ok === false) throw new Error((out && out.message) || '批量移组失败');
                            setSelected({});
                            return { ok: true, message: out.message };
                          });
                        },
                      }, h('option', { value: '' }, '移到分组…'), h('option', { value: '__ungrouped__' }, '未分组'), ...groupDefs.map((g) => h('option', { key: g.id, value: g.id }, g.name)))
                    : null,
                  h('button', {
                    style: { ...S.button, ...S.danger, padding: '5px 10px', fontSize: 12.5 },
                    disabled: !ids.length || busy === 'bulk',
                    title: '删除选中的账号（本地 token / cookie / 保存的密码都会删掉）',
                    onClick: async () => {
                      if (!(await uiConfirm('删除选中的 ' + ids.length + ' 个账号？本地凭证会一起删掉。'))) return;
                      run('bulk', async () => {
                        const out = await api('/accounts/bulk', { method: 'POST', body: JSON.stringify({ ids, action: 'delete' }) });
                        if (!out || out.ok === false) throw new Error((out && out.message) || '批量删除失败');
                        setSelected({});
                        return { ok: true, message: out.message };
                      });
                    },
                  }, '删除'),
                  h('button', { style: { ...S.button, padding: '5px 10px', fontSize: 12.5 }, onClick: () => setSelected({}) }, '清空选择'),
                );
              })()
            : null,
          list.length === 0 ? h('p', { style: S.hint }, noAccount ? '还没有账号，请在上方「添加账号」里登录。' : '还没有账号，请在下面添加。') : null,
          ...accountSections.flatMap((section) => [
            groupHead(section),
            ...(collapsedGroups[section.key]
              ? []
              : section.accounts.map((a) => {
            // 按钮统一样式：紧凑、不换行显示文字（之前 5~7 个按钮挤在一行，最后一个会被挤到下一行）
            const btn = { ...S.button, padding: '6px 10px', fontSize: 12.5, whiteSpace: 'nowrap' };
            const mini = { ...S.button, padding: '5px 6px', fontSize: 11.5, whiteSpace: 'nowrap' };
            // 账号名：自定义名字优先；只有「浏览器登录 / 账号N」这种占位名时，直接用邮箱当名字。
            // 这样某个号登录失效时，一眼就知道失效的是哪个账号。
            const placeholder = !a.label || a.label === '浏览器登录' || /^账号\d+$/.test(a.label) || a.label === '邮箱账号';
            const name = a.email || (placeholder ? '账号 ' + a.id : a.label);
            const sub = a.email && !placeholder ? a.email : '';
            // 失效时的说明：存了密码就告诉用户会自动重登，没存就明确要手动登录
            const left = (ts) => {
              const ms = Number(ts) - Date.now();
              if (!(ms > 0)) return '已到期';
              const hh = Math.floor(ms / 3600000);
              const mm = Math.floor((ms % 3600000) / 60000);
              return hh > 0 ? '还剩 ' + hh + ' 小时 ' + mm + ' 分' : '还剩 ' + mm + ' 分';
            };
            const muteText = a.muted
              ? '站点禁言至 ' + new Date(a.mutedUntil).toLocaleString('zh-CN') + '（' + left(a.mutedUntil) + '），到期前不会用它发消息' +
                (a.muteReason ? '。站点原文：' + String(a.muteReason).slice(0, 140) : '') +
                (a.hasPassword ? '；想现在登网页版，点「复制账号密码」去 Chrome 手动登录' : '')
              : a.banned
                ? '账号已被站点封禁' +
                  (a.hasPassword ? '；点「复制账号密码」去 Chrome 手动登录可自己确认状态（插件内登录会被风控拦），确认后建议删除换号' : '，请删除后换号')
                : '';
            const expiry = a.banned || a.muted
              ? muteText
              : a.needBrowserLogin
              ? '站点设备风控拦住了脚本密码登录（RISK_DEVICE_DETECTED），点「浏览器登录」在真实网页里自动登一次即可'
              : a.status === 'authExpired'
                ? a.emailMasked && a.hasPassword
                  ? '登录已失效；保存的邮箱是脱敏地址，请点「改密码」填一次完整邮箱，之后才能自动重登'
                  : a.hasPassword
                    ? '登录已失效，正在用保存的密码自动重登' + (a.email ? '（' + a.email + '）' : '')
                    : '登录已失效，需要重新登录' + (a.email ? '（' + a.email + '）' : '') +
                      '：点「存账号密码」填一次完整邮箱+密码，之后「内嵌登录」会自动填表，token 再失效也能自动重登；不想存密码就点「内嵌登录」自己输一次'
                : a.reloginBlocked === 'needCode'
                  ? '自动重登需要邮箱验证码，点「重新登录」手动完成一次'
                  : '';
            return h(
              'div',
              { key: a.id, style: { display: 'flex', flexDirection: 'column', gap: 6, borderTop: '1px solid var(--dsw-alias-border-l4, rgba(128,128,128,.15))', paddingTop: 8 } },
              h(
                'div',
                { style: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 6, minWidth: 0 } },
                selectMode
                  ? h('input', {
                      type: 'checkbox',
                      checked: Boolean(selected[a.id]),
                      style: { margin: 0, cursor: 'pointer' },
                      title: '勾选后可以在上面的批量操作里一次处理',
                      onChange: (e) => setSelected((prev) => ({ ...prev, [a.id]: e.target.checked })),
                    })
                  : null,
                h('strong', { style: { wordBreak: 'break-all', maxWidth: '100%' } }, name),
                sub ? h('span', { style: S.hint }, sub) : null,
                a.emailMasked
                  ? h('span', { style: { ...S.hint, color: '#ff9632' }, title: '站点接口只返回脱敏邮箱（带 *）。点「填邮箱」补一次完整地址，之后这里就显示完整的' }, '（脱敏）')
                  : null,
                a.active
                  ? h('span', { style: { ...S.badge(true), color: '#7bd88f', borderColor: 'rgba(123,216,143,.45)' }, title: '当前账号：下一轮请求优先用它' }, '当前')
                  : null,
                a.hasPassword
                  ? h('span', { style: { ...S.badge(true), color: '#5aa9ff', borderColor: 'rgba(90,169,255,.45)' }, title: '已保存账号密码：token 失效时会自动重新登录' }, '已存密码')
                  : null,
                h('span', { style: S.badge(a.status === 'ok' && !a.muted && !a.banned) }, a.banned ? '已封禁' : a.muted ? '禁言中' : a.status === 'ok' ? '正常' : a.status === 'cooling' ? '冷却中' : a.status === 'authExpired' ? '登录失效' : '已禁用'),
                expiry
                  ? null
                  : h('span', { style: S.hint }, a.lastUsedAt ? '最后使用 ' + new Date(a.lastUsedAt).toLocaleTimeString() : '从未使用'),
              ),
              expiry ? h('p', { style: { ...S.hint, color: '#ff9632', margin: 0 } }, expiry) : null,
              (() => {
                // 默认不显示（省空间）：展开「更多」时才给来源 / 登录时间 / cookie 规模。
                if (!moreAccts[a.id]) return null;
                const bits = [];
                if (a.loginSource) bits.push('来源：' + a.loginSource);
                if (a.loginAt) bits.push('登录于 ' + new Date(a.loginAt).toLocaleString('zh-CN'));
                if (a.cookieShape && a.cookieShape.total) bits.push('cookie ' + a.cookieShape.total + ' 项');
                if (!bits.length) return null;
                return h('p', { style: { ...S.hint, margin: 0, opacity: 0.8 } }, bits.join(' · '));
              })(),
              groupDefs.length
                ? h(
                    'div',
                    { style: { display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' } },
                    h('span', { style: { ...S.hint, fontSize: 11.5 } }, '分组'),
                    h(
                      'select',
                      {
                        className: 'dswx-select',
                        style: S.select,
                        value: a.groupId || '',
                        title: '把账号放进某个分组（只影响显示，不影响切号与会话复用）',
                        onChange: (e) => assignGroup(a, e.target.value),
                      },
                      h('option', { value: '' }, '未分组'),
                      ...groupDefs.map((g) => h('option', { key: g.id, value: g.id }, g.name)),
                    ),
                  )
                : null,
              // ── v1.0.63 精简：默认只显示 检查 / 更多；登录、设为当前、改名、删除全在「更多」里 ──
              h(
                'div',
                { style: { display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' } },
                // 登录失效的账号，把「重新登录」直接摆出来：藏在「更多」里等于让人自己去猜。
                // 这里是**手动**重新登录——打开真实登录页让人自己点，不依赖保存的密码
                // （脱敏邮箱 / 站点风控都会让自动重登失败，手动这条路永远可用）。
                a.status === 'authExpired' || a.needBrowserLogin
                  ? h('button', {
                      style: { ...btn, background: '#4d6bfe', borderColor: '#4d6bfe', color: '#fff' },
                      disabled: busy === 'mlogin' + a.id,
                      title: '打开真实登录页，手动登录一次；成功后 token 原地回填到这个账号（不新增重复账号）',
                      onClick: () => run('mlogin' + a.id, async () => {
                        // 默认走「浏览器登录」：真实浏览器打开登录页，人手动登一次，cookie/token 更干净，
                        // 也避开内嵌 WebView 白屏。只有浏览器那条打不开时才退回内嵌窗口。
                        try {
                          const out = await api('/login/browser', { method: 'POST', body: JSON.stringify({ accountId: a.id }) });
                          if (out && out.ok !== false) {
                            if (!out.opened && out.url && !openExternal(out.url)) await showUrl(out.url, '宿主拦了自动打开，用系统浏览器打开这个地址完成登录：');
                            return { ok: true, message: '已打开浏览器登录页：登录成功后 token 自动回填到这个账号' };
                          }
                        } catch (e) {
                          // 继续尝试内嵌
                        }
                        const r = await openEmbed(a.id);
                        if (r.ok) return { ok: true, message: '浏览器登录没打开，已改用内嵌登录窗口：登录成功后 token 自动回填到这个账号' };
                        throw new Error(r.message || '打开登录页失败');
                      }),
                    }, busy === 'mlogin' + a.id ? '打开中…' : '重新登录')
                  : null,
                h('button', {
                      style: btn,
                      disabled: busy === 'chk' + a.id,
                      title: '验证这个账号的登录态（只读接口，不消耗对话额度）；登录 / 设为当前 / 改名 / 删除都在「更多」里',
                      onClick: () => run('chk' + a.id, () => api('/accounts/' + a.id + '/check', { method: 'POST' })),
                    }, busy === 'chk' + a.id ? '检查中…' : '检查'),
                h('button', {
                  style: btn,
                  title: moreAccts[a.id] ? '收起次要操作' : '展开其余操作：改名 / 重新登录 / 浏览器登录 / 复制账号密码 / 改密码 / 禁用 / 排序 / 导出 / 恢复登录 / 删除',
                  onClick: () => setMoreAccts((v) => ({ ...v, [a.id]: !v[a.id] })),
                }, moreAccts[a.id] ? '收起' : '更多'),
              ),
              moreAccts[a.id]
                ? h(
                'div',
                { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(88px, 1fr))', gap: 6 } },
                h('button', {
                  style: mini,
                  title: '只改显示用的备注名，不动任何凭证',
                  onClick: async () => {
                    let v = null;
                    try { v = await uiPrompt('给这个账号起个备注名（只影响显示）', a.label || ''); } catch { v = null; }
                    if (v === null || v === undefined) return;
                    run('ren' + a.id, async () => {
                      const out = await api('/accounts/' + a.id + '/rename', { method: 'POST', body: JSON.stringify({ label: String(v) }) });
                      if (!out || out.ok === false) throw new Error((out && out.message) || '改名失败');
                      return { ok: true, message: '备注已更新' };
                    });
                  },
                }, '改名'),
                h('button', {
                  style: { ...mini, borderColor: 'rgba(229,72,77,.45)', color: '#e5484d' },
                  title: '把这个账号在本机的设备身份整个换掉：新设备 id、清指纹、删登录 cookie、重置热身与发送计数。站点上的账号历史不会消失。',
                  onClick: async () => {
                    let yes = false;
                    try {
                      yes = await uiConfirm('按「全新设备」重置这个账号？\n\n会换新：设备 id（新 UUID）、请求头指纹、登录 cookie、热身标记、24h 发送计数。\n\n不会消失：站点上的账号历史、对话内容、IP、处置记录——想更彻底就把网络也换掉（手机流量/另一条宽带）。\n\n注意：新设备首次登录可能被要求额外验证一次。确定继续？');
                    } catch { yes = false; }
                    if (!yes) return;
                    run('wipe' + a.id, async () => {
                      const out = await api('/accounts/' + a.id + '/reset-trace', { method: 'POST' });
                      if (!out || out.ok === false) throw new Error((out && out.message) || '重置失败');
                      return { ok: true, message: out.message || '已按新设备重置' };
                    });
                  },
                }, busy === 'wipe' + a.id ? '重置中…' : '按新设备重置'),
                a.active
                  ? null
                  : h('button', {
                      style: mini,
                      disabled: busy === 'act' + a.id,
                      title: '把这个账号设为当前账号：下一轮请求优先用它（不发任何请求，立即生效）',
                      onClick: () => run('act' + a.id, () => api('/accounts/' + a.id + '/active', { method: 'POST' })),
                    }, busy === 'act' + a.id ? '切换中…' : '设为当前'),
                !a.hasPassword && (a.status === 'authExpired' || a.banned || a.muted || a.needBrowserLogin || a.status === 'disabled')
                  ? h('button', {
                      style: mini,
                      disabled: busy === 'openpage' + a.id,
                      title: '这个账号没存密码：打开登录页手动登录一次，成功后 token 自动回填',
                      onClick: () => run('openpage' + a.id, async () => {
                        const out = await api('/login/browser', { method: 'POST', body: JSON.stringify({ accountId: a.id }) });
                        if (!out || out.ok === false) throw new Error((out && out.message) || '打开登录页失败');
                        if (!out.opened && out.url) {
                          if (!openExternal(out.url)) await showUrl(out.url);
                        }
                        return { ok: true, message: '登录页已打开（走本机代理）：登录成功后 token 自动回填到这个账号' };
                      }),
                    }, busy === 'openpage' + a.id ? '打开中…' : '打开登录页')
                  : null,
                a.hasPassword
                  ? h('button', {
                      style: mini,
                      disabled: busy === 'relogin' + a.id,
                      onClick: () => run('relogin' + a.id, async () => {
                        const out = await api('/accounts/' + a.id + '/relogin', { method: 'POST' });
                        if (!out || out.ok === false) throw new Error((out && out.message) || '重新登录失败');
                        return { ok: true, message: out.message || '已重新登录' };
                      }),
                    }, busy === 'relogin' + a.id ? '重登中…' : '自动重登（用存密码）')
                  : null,
                a.hasPassword
                  ? h('button', {
                      style: mini,
                      disabled: busy === 'bl' + a.id,
                      title: '用真实浏览器打开登录页手动登录一次（打不开时才退回内嵌窗口），成功后 token 原地回填',
                      onClick: () => run('bl' + a.id, async () => {
                        const r = await openLogin(a.id);
                        if (!r.ok) throw new Error(r.message);
                        return { ok: true, message: r.mode === 'embed' ? r.message : '已打开浏览器登录页：登录成功后 token 自动回填到这个账号' };
                      }),
                    }, busy === 'bl' + a.id ? '打开中…' : '登录（浏览器）')
                  : null,
                // 系统浏览器线路（一直保留）：内嵌白屏 / 被站点点名拦 / 手机 WebView 拦 window.open 时用它
                a.hasPassword
                  ? h('button', {
                      style: mini,
                      disabled: busy === 'sb' + a.id,
                      title: '在新标签页/系统浏览器里用保存的账号密码自动登录（内嵌窗口打不开时用这个）',
                      onClick: () => run('sb' + a.id, async () => {
                        // 先同步开窗，避免 await 之后被浏览器当成弹窗拦掉
                        let win = null;
                        try { win = window.open('about:blank', '_blank'); } catch {}
                        try {
                          const out = await api('/accounts/' + a.id + '/browser-login', { method: 'POST' });
                          if (!out || out.ok === false) throw new Error((out && out.message) || '打开登录页失败');
                          if (out.url) {
                            if (win && !win.closed) win.location.href = out.url;
                            else if (!openExternal(out.url)) await showUrl(out.url, '宿主拦了自动打开，用系统浏览器打开这个地址（账号密码会自动填好，登录成功 token 自动回填）：');
                          }
                          return { ok: true, message: out.message || '登录页已打开：账号密码会自动填好，登录成功后 token 会自动回填' };
                        } catch (error) {
                          try { if (win && !win.closed) win.close(); } catch {}
                          if (state && state.needRestart) {
                            throw new Error('正在运行的后台还是旧版本，先重启 DSH（设置页顶部有提醒），重启后再点「浏览器登录」');
                          }
                          throw error;
                        }
                      }),
                    }, busy === 'sb' + a.id ? '打开中…' : '浏览器登录')
                  : null,
                // 没存密码的异常账号也能重新登录：默认拉起浏览器，登录成功后 token 原地替换（不新增重复账号）
                !a.hasPassword && (a.status === 'authExpired' || a.banned || a.muted || a.needBrowserLogin || a.status === 'disabled')
                  ? h('button', {
                      style: mini,
                      disabled: busy === 'bl' + a.id,
                      title: '用真实浏览器打开登录页手动登录一次（打不开时才退回内嵌窗口），token 原地更新这个账号',
                      onClick: () => run('bl' + a.id, async () => {
                        const r = await openLogin(a.id);
                        if (!r.ok) throw new Error(r.message);
                        return { ok: true, message: r.mode === 'embed' ? r.message : '已打开浏览器登录页：登录成功后这个账号的 token 会原地更新' };
                      }),
                    }, busy === 'bl' + a.id ? '打开中…' : '登录（浏览器）')
                  : null,
                a.hasPassword
                  ? h('button', {
                      style: mini,
                      disabled: busy === 'cp' + a.id,
                      title: '把保存的账号密码复制到剪贴板，去 Chrome 里手动登录（插件内登录常被站点风控拦住）',
                      onClick: () => run('cp' + a.id, async () => {
                        const out = await api('/accounts/' + a.id + '/reveal', { method: 'POST' });
                        if (!out || !out.ok) throw new Error((out && out.message) || '读取保存的密码失败');
                        const text = '账号：' + (out.email || a.email || '') + '\n密码：' + out.password;
                        const done = await copyText(text);
                        if (!done) {
                          // WebView 里 execCommand 也可能被拦：别只报错，直接把内容摊出来让人手动复制
                          await showUrl(text, '剪贴板被宿主拦了，长按下面内容手动复制：');
                          return { ok: true, message: '已显示账号密码，长按手动复制' };
                        }
                        return { ok: true, message: '账号密码已复制。用 Chrome 打开 chat.deepseek.com 登录，成功后把 token 贴到「手动添加」里回填（插件内登录容易被风控拦）' };
                      }),
                    }, busy === 'cp' + a.id ? '复制中…' : '复制账号密码')
                  : null,
                a.banned || a.muted || a.needBrowserLogin || a.status === 'authExpired' || a.status === 'disabled'
                  ? h('button', {
                      style: mini,
                      disabled: busy === 'openpage' + a.id,
                      title: '用系统浏览器/新标签页打开本机镜像的登录页；登录成功后 token 会自动回填（直接打开 chat.deepseek.com 是拿不到 token 的）',
                      onClick: () => run('openpage' + a.id, async () => {
                        const out = await api('/login/browser', { method: 'POST', body: JSON.stringify({ accountId: a.id }) });
                        if (!out || out.ok === false) throw new Error((out && out.message) || '打开登录页失败');
                        if (!out.opened && out.url) {
                          if (!openExternal(out.url)) await showUrl(out.url, '宿主拦了自动打开，用系统浏览器打开这个地址（登录成功后 token 会自动回填）：');
                          return { ok: true, message: '登录页已在新标签页打开（走本机代理，登录成功后 token 会自动回填到这个账号）' };
                        }
                        return { ok: true, message: '登录页已在系统浏览器打开（走本机代理，登录成功后 token 会自动回填到这个账号；回到这里就能看到状态更新）' };
                      }),
                    }, busy === 'openpage' + a.id ? '打开中…' : '打开登录页')
                  : null,
                h('button', {
                  style: mini,
                  onClick: () => {
                    setPwdFor(pwdFor === a.id ? '' : a.id);
                    // 脱敏地址没有意义，输入框留空，由用户填完整邮箱
                    setPwdEmail(a.emailMasked ? '' : a.email || '');
                    setPwdPass('');
                  },
                }, a.hasPassword
                  ? '改密码'
                  : a.emailMasked
                    ? '填邮箱'
                    : a.banned || a.muted || a.needBrowserLogin || a.status === 'authExpired' || a.status === 'disabled'
                      ? '存账号密码'
                      : '存密码'),
                h('button', {
                  style: mini,
                  onClick: () => run('tg' + a.id, () => api('/accounts/' + a.id + '/' + (a.status === 'disabled' ? 'enable' : 'disable'), { method: 'POST' })),
                }, a.status === 'disabled' ? '启用' : '禁用'),
                h('button', {
                  style: mini,
                  disabled: busy === 'exit' + a.id,
                  title: '把这个账号从账号库移除，并打开登录页去登另一个号（等于「退出并登录其它账号」）',
                  onClick: async () => {
                    if (!(await uiConfirm('退出「' + name + '」并打开登录页登录其它账号？\n（本地 token / cookie / 保存的密码会一起删掉）'))) return;
                    run('exit' + a.id, async () => {
                      await api('/accounts/' + a.id, { method: 'DELETE' });
                      const out = await api('/login/browser', { method: 'POST', body: JSON.stringify({}) });
                      if (out && out.url && !out.opened) {
                        if (!openExternal(out.url)) await showUrl(out.url);
                      }
                      return { ok: true, message: '已退出该账号，登录页已打开：登另一个号即可' };
                    });
                  },
                }, busy === 'exit' + a.id ? '处理中…' : '退出并登录其它'),
                h('button', {
                  style: mini,
                  disabled: busy === 'up' + a.id,
                  title: '在账号列表里上移一位（只改显示顺序，不影响调度与凭证）',
                  onClick: () => run('up' + a.id, async () => {
                    const out = await api('/accounts/' + a.id + '/move', { method: 'POST', body: JSON.stringify({ dir: 'up' }) });
                    if (!out || out.ok === false) throw new Error((out && out.message) || '上移失败');
                    return { ok: true, message: out.message };
                  }),
                }, '↑'),
                h('button', {
                  style: mini,
                  disabled: busy === 'down' + a.id,
                  title: '在账号列表里下移一位',
                  onClick: () => run('down' + a.id, async () => {
                    const out = await api('/accounts/' + a.id + '/move', { method: 'POST', body: JSON.stringify({ dir: 'down' }) });
                    if (!out || out.ok === false) throw new Error((out && out.message) || '下移失败');
                    return { ok: true, message: out.message };
                  }),
                }, '↓'),
                h('button', {
                  style: mini,
                  disabled: busy === 'one' + a.id,
                  title: '只把这一个账号导出成 JSON（含 token/cookie，方便换设备或单独备份）',
                  onClick: () => run('one' + a.id, async () => {
                    const out = await api('/accounts/' + a.id + '/export');
                    if (!out || out.ok === false) throw new Error((out && out.message) || '导出失败');
                    const text = JSON.stringify({ version: out.version, exportedAt: out.exportedAt, accounts: out.accounts }, null, 2);
                    const done = await copyText(text);
                    if (!done) {
                      await showUrl(text, '剪贴板被拦了，长按下面内容手动复制（含 token/cookie，别外传）：');
                      return { ok: true, message: '已显示导出内容，长按手动复制' };
                    }
                    return { ok: true, message: '已复制这个账号的 JSON（含 token/cookie，别外传）' };
                  }),
                }, busy === 'one' + a.id ? '导出中…' : '导出'),
                a.loginSid
                  ? h('button', {
                      style: mini,
                      disabled: busy === 'rs' + a.id,
                      title: '用这个账号上次登录的那个会话（cookie 罐）重开登录页：站点若还没掉登录，token 会自动回填，不用输密码',
                      onClick: () => run('rs' + a.id, async () => {
                        const out = await api('/login/restore', { method: 'POST', body: JSON.stringify({ sid: a.loginSid, accountId: a.id }) });
                        if (!out || out.ok === false) throw new Error((out && out.message) || '恢复登录失败');
                        if (out.url && !out.opened) {
                          if (!openExternal(out.url)) await showUrl(out.url);
                        }
                        return { ok: true, message: out.message };
                      }),
                    }, busy === 'rs' + a.id ? '打开中…' : '恢复上次登录')
                  : null,
                h('button', { style: { ...mini, ...S.danger }, onClick: () => run('del' + a.id, () => api('/accounts/' + a.id, { method: 'DELETE' })) }, '删除'),
              )
                : null,
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
                      placeholder: '密码（存下来用于自动填入/失效自动重登）',
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
                            if (!(await uiConfirm('删除 ' + name + ' 保存的密码？之后 token 失效不会自动重登。'))) return;
                            const out = await api('/accounts/' + a.id + '/credential', { method: 'DELETE' });
                            setPwdFor('');
                            return { ok: Boolean(out && out.ok), message: '已删除保存的密码' };
                          }),
                        }, '删除已存密码')
                      : null,
                  )
                : null,
            );
              })),
          ]),
        ),

        h(
          'details',
          { style: cardStyle('addAccount'), open: list.length === 0 ? true : undefined },
          h(
            'summary',
            { style: { cursor: 'pointer', outline: 'none' } },
            h('h3', { style: { ...S.title, display: 'inline', marginRight: 8 } }, '登录新账号'),
            h('span', { style: S.hint }, '点开：登录线路 · 登录方式 · 内嵌窗口 / 系统浏览器 · 邮箱 + 密码'),
          ),
          h('p', { style: S.hint }, '登录成功后 token 自动回填；账号密码可以加密保存在本机，之后 token 失效会自动重登。'),
          h(
            'button',
            {
              style: { ...S.button, background: '#4d6bfe', borderColor: '#4d6bfe', color: '#fff', padding: '10px 18px', fontSize: 14, fontWeight: 600 },
              disabled: busy === 'embed',
              onClick: () => run('embed', async () => {
                // 默认拉起真实浏览器登录；浏览器那条打不开才退回内嵌窗口
                const r = await openLogin('');
                if (!r.ok) throw new Error(r.message);
                return { ok: true, message: r.mode === 'embed' ? r.message : '已打开浏览器登录页：登录成功后 token 会自动回填' };
              }),
            },
            busy === 'embed' ? '正在打开…' : '登录（打开浏览器）',
          ),
          h('p', { style: S.hint }, '手机号 / 微信 / 邮箱都能登。浏览器打不开时点「用系统浏览器打开」；接不到浏览器就展开下面的方式。'),
          h(
            'details',
            { style: { marginTop: 2 } },
            h(
              'summary',
              { style: { cursor: 'pointer', fontSize: 13, color: 'var(--text-secondary, #8a8f98)', outline: 'none' } },
              '更多登录方式（内嵌窗口 / 粘贴 token / 邮箱密码 / Apple）',
            ),
            h(
              'div',
              { style: S.row },
              h('button', { style: S.button, disabled: busy === 'sysbrowser', title: '用系统浏览器打开真实登录页', onClick: () => openSystemBrowser() }, '用系统浏览器打开'),
              helpTip('loginFlow', '在插件里打开真实登录页（本机代理镜像），账号密码与验证码都在窗口里完成，登录成功后 token 自动回填。浏览器打不开时用内嵌窗口，白屏或被风控挡住时用系统浏览器。'),
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
            'div',
            { style: S.row },
            helpTip('loginRegion', '国内线路：中文登录页（手机号 / 微信 / 邮箱都能登）。邮箱线路：英文登录页，邮箱或 Google 注册的账号用它 —— 中国大陆网络同样可用，不需要 VPN。'),
          ),
          // v1.0.54 学参考实现：登录方式做成切换条，一次只显示一种，界面不再堆一屏按钮
          h(
            'div',
            { style: { ...S.row, gap: 6, flexWrap: 'wrap' } },
            h('span', { style: { ...S.hint, minWidth: 56 } }, '登录方式'),
            ...[
              ['embed', '内嵌窗口', '在设置页里内嵌真实登录页（推荐：登录成功后 token 自动回填）'],
              ['browser', '系统浏览器', '用系统浏览器打开登录页（内嵌白屏 / 被风控挡住时用）'],
              ['manual', '粘贴 token', '手动粘贴 userToken 或批量导入，完全不依赖浏览器'],
              ['email', '邮箱密码', '直接用邮箱 + 密码登录，不开浏览器；新设备可能要一次邮箱验证码'],
            ].map(([k, label, tip]) =>
              h(
                'button',
                {
                  key: k,
                  title: tip,
                  style: {
                    ...S.button,
                    padding: '5px 10px',
                    fontSize: 12.5,
                    ...(loginMethod === k ? { borderColor: 'var(--dsw-alias-label-primary, #fff)', fontWeight: 700 } : {}),
                  },
                  onClick: () => pickLogin(k),
                },
                label,
              ),
            ),
          ),
          ),
          embed
            ? h(
                'div',
                { style: { display: 'flex', flexDirection: 'column', gap: 6, marginTop: 8 } },
                h(
                  'div',
                  { style: { ...S.row, flexWrap: 'wrap' } },
                  h('span', { style: { ...S.badge(true), background: 'rgba(90,169,255,.22)', color: '#5aa9ff' } }, '内嵌登录（实验）'),
                  h('span', { style: S.hint }, embed.autofillMode === 'full' ? '账号密码已自动填好并提交' : embed.autofillMode === 'email' ? '邮箱已自动填好，密码输一次' : '登录成功后自动回填 token'),
                  helpTip('embedFrame', '这是真实的 DeepSeek 登录页（本机独立端口镜像，cookie 只存在本机）。手机号 / 微信 / 邮箱都能登。登录成功后账号密码会加密保存在本机，下次「内嵌登录」自动填表；若白屏、被站点风控拦住或要走 Apple 授权，点「用系统浏览器打开」。'),
                  h('span', { style: { marginLeft: 'auto' } }),
                  h('button', { style: S.button, onClick: () => setEmbed({ ...embed, key: Date.now() }) }, '重新加载'),
                  h('button', { style: S.button, onClick: () => openSystemBrowser() }, '用系统浏览器打开'),
                  h('button', { style: S.button, onClick: closeEmbed }, '关闭'),
                ),
                h(
                  'div',
                  { style: { ...S.hint, lineHeight: 1.6 } },
                  '白屏说明：登录页要走站点风控，偶尔会被拦。代理这边已经自带重试 + 整页缓存，多数情况会自动恢复；还是白就先点「重新加载」，再不行用「用系统浏览器打开」——登录成功后 token 一样自动回填到这个账号。',
                ),
                h('iframe', {
                  key: 'embed-' + embed.key,
                  src: embed.url,
                  title: 'DeepSeek 登录',
                  style: {
                    width: '100%',
                    height: 560,
                    border: '1px solid var(--dsw-alias-border-l4, rgba(128,128,128,.25))',
                    borderRadius: 10,
                    background: '#fff',
                  },
                  allow: 'clipboard-write',
                  referrerPolicy: 'no-referrer',
                }),

              )
            : null,
          embedNote ? h('p', { style: { ...S.hint, color: '#ff9632' } }, embedNote) : null,
          h(
            'div',
            { style: { ...S.row, marginTop: 6 } },
            h('button', {
              style: S.button,
              disabled: !!(state && state.needRestart),
              onClick: async () => { const u = BASE + '/apple'; if (!openExternal(u)) await showUrl(u); },
            }, 'Apple 账号登录（实验）'),
            helpTip('apple', '实验功能，优先级低：Apple ID 登录只能走外部窗口（Apple 授权页禁止被内嵌），成功后 token 直接存进账号池；授权页白屏时改用 Chrome 打开该页。没有 Apple 账号可以完全忽略这条线路。'),
          ),
          h(
            'div',
            { style: { ...S.row, marginTop: 6, cursor: 'pointer', userSelect: 'none' }, onClick: () => pickLogin(loginMethod === 'manual' ? 'embed' : 'manual') },
            h('span', { style: { width: 10, color: 'var(--text-secondary, #8a8f98)', fontSize: 11 } }, loginMethod === 'manual' ? '▼' : '▶'),
            h('span', { style: S.badge(false) }, '手动添加 / 批量导入'),
            h('span', { style: S.hint }, loginMethod === 'manual' ? '单个粘贴 token，或一次导入多个账号' : '不推荐 · 点击切换到这一种'),
          ),
          loginMethod === 'manual'
            ? h(
                'div',
                { style: { display: 'flex', flexDirection: 'column', gap: 8 } },
                h(
                  'div',
                  { style: S.row },
                  h('button', { style: S.button, onClick: async () => { const u = 'https://chat.deepseek.com'; if (!openExternal(u)) await showUrl(u); } }, '① 打开 DeepSeek 登录页'),
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
            { style: { ...S.row, alignItems: 'baseline', gap: 6, cursor: 'pointer', userSelect: 'none' }, onClick: () => pickLogin(loginMethod === 'email' ? 'embed' : 'email') },
            h('span', { style: { width: 10, color: 'var(--text-secondary, #8a8f98)', fontSize: 11 } }, loginMethod === 'email' ? '▼' : '▶'),
            h('span', { style: { fontWeight: 600 } }, '邮箱 + 密码登录'),
            h('span', { style: { ...S.badge(false), color: '#5aa9ff', borderColor: 'rgba(90,169,255,.5)' } }, '国内网络可用'),
            loginMethod === 'email' ? null : h('span', { style: S.hint }, '不依赖浏览器 · 点击切换到这一种'),
          ),
          loginMethod === 'email'
            ? h(
                'div',
                { style: { display: 'flex', flexDirection: 'column', gap: 8 } },
                h('div', { style: S.row }, helpTip('emailLogin', '邮箱 + 密码登录在中国大陆网络下直接可用，不需要 VPN。邮箱 / Google 注册的账号把「登录线路」选成「邮箱（英文页）」，国内手机号注册的账号用「国内」线路。直接用邮箱密码登录，不需要打开浏览器；新设备首次登录通常只会要求一次邮箱验证码（或直接通过），之后 token 失效可以靠保存的密码自动重登。')),
                h(
                  'label',
                  { style: { ...S.row, alignItems: 'center', gap: 8, cursor: 'pointer' } },
                  h('input', { type: 'checkbox', checked: savePassword, onChange: (e) => setSavePassword(e.target.checked) }),
                  h('span', null, '保存账号密码'),
                  helpTip('savePwd', '本地加密保存（AES-256-GCM，只在本机）；token 过期或被踢下线时自动重新登录，不用再手动点。'),
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
          { style: cardStyle('pageSettings') },
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
          { style: cardStyle('maint') },
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
              onClick: async () => {
                if (!(await uiConfirm('清空插件累计的 token 用量记录？账号和登录状态不受影响。'))) return;
                run('usage-reset', () => api('/usage/reset', { method: 'POST' }));
              },
            }, '清空 Token 用量记录'),
            h('button', {
              style: { ...S.button, ...S.danger },
              disabled: busy === 'config-reset',
              onClick: () => setConfirmReset('config'),
            }, '重置所有插件设置'),
          ),
          h('div', { style: S.row }, helpTip('maintenance', '「清空用量」只删除统计记录；「重置设置」只恢复默认参数与卡片顺序（确认窗口里还可选择删除账号，或彻底删除全部账号和数据）。')),
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
                onClick: async () => { const u = REPO_URL + '/stargazers'; if (!openExternal(u)) await showUrl(u); },
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
                    h('li', null, '同账号发送间隔：2500~4500 ms（随机）'),
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
