# 在任意设备上「内嵌浏览器发请求」的可行性研究

> 目标：让插件的请求由**真实浏览器内核**发出（真 TLS/JA3/JA4、真 HTTP/2 帧序、真 JS 运行时指纹），
> 且不要求用户自己在机器上装 Chrome。
>
> 结论先放：**没有一个内核能塞进 npm 包解决所有平台**；可行的是「按平台选宿主 + 一个统一 CDP 接口 + 一条远程兜底通道」。
> 全文的实测数字都来自本机（Android 上的 Ubuntu proot 容器）。

## 0. 为什么「换个内核」只能解决一半问题

| 层 | 由谁决定 | 换内核能改吗 |
|---|---|---|
| TLS 指纹（JA3/JA4、扩展顺序、ALPN） | 客户端 TLS 栈 | ✅ 真浏览器；curl_cffi 模拟也已接近 |
| HTTP/2 帧序、头部优先级、SETTINGS | 客户端 HTTP 栈 | ✅ 真浏览器 |
| JS 指纹（canvas、WebGL、AudioContext、字体、时区、`navigator`） | 页面 JS 运行时 | ✅ **只有真浏览器** |
| 行为指纹（鼠标轨迹、打字节奏、滚动、页面停留） | 用户/自动化 | ✅ 真浏览器 + 拟人化 |
| PoW / 风控挑战的求解环境 | 页面 wasm | ✅ 官方 wasm 在页面里解才「像人」 |
| 出口 IP、账号历史、提示词形状 | 网络与账号 | ❌ 内核无关 |

所以「内嵌内核」的收益集中在第 3、5 行；第 6 行仍然要靠设备身份 + 网络 + 提示词形态，别指望装了内核就隐身。

## 1. 各平台能用的宿主

| 平台 | 可用内核 | 分发方式 | 自动化通道 | 可行性 |
|---|---|---|---|---|
| Windows 10/11 | Edge WebView2（系统自带，Evergreen 运行时） | 零下载 | CDP（`WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9222`）+ 自带 WebView2Loader | ★★★★★ 最佳：几乎人人都有 |
| Windows / macOS / Linux 桌面 | Chrome / Edge / Chromium 已装 | 复用 | `--remote-debugging-port` + CDP over WebSocket | ★★★★★ 已在插件里实现（`browser-transport.mjs`） |
| 桌面（用户没装浏览器） | Chrome for Testing | 按需下载 200MB | 同上 | ★★★★☆ v1.0.83 已实现，两个源 |
| macOS | 系统 WKWebView | 零下载 | **没有 CDP**：只能走 `safaridriver` 或注入 JS 的 host 进程 | ★★☆☆☆ 指纹是 WebKit 而非 Chrome，反而更「不像」 |
| Linux 容器 / proot（本机） | Chrome for Testing（linux64 / linux-arm64） | 按需下载 | CDP | ★★☆☆☆ **能下能解压能 `--version`，一开页面 SIGTRAP**（本机实测） |
| Android | **App 内 WebView**（Chromium） | 零下载（App 自带） | `WebView.setWebContentsDebuggingEnabled(true)` + `adb forward tcp:9222 localabstract:webview_devtools_remote_<pid>` → 同一套 CDP | ★★★★★ 设备上唯一稳的路 |
| Android | 系统 Chrome | 零下载 | 正式版 Chrome 不允许 `--remote-debugging`（需 root / debuggable build） | ★☆☆☆☆ |
| Android（无 App 改动的兜底） | Chrome 标签页 + 脚本中继 | 零下载 | 用户打开 `chat.deepseek.com`，油猴脚本/书签把请求转给插件（插件 ↔ 页面用 WebSocket） | ★★★☆☆ 可行但要用户配合一次 |
| iOS | App 内 WKWebView | 零下载 | 无 CDP，只能 App 注入 JS bridge | ★★☆☆☆ 指纹 WebKit |
| 任意设备 + 有网络 | **远程浏览器**（另一台机器上的 Chrome） | 插件只跑客户端 | CDP over WSS 隧道 | ★★★★☆ 通用兜底，但多一跳延迟 |

## 2. 三种落地形态（按代价从低到高）

### A. 复用宿主浏览器（已上线）

`browser-transport.mjs` 已经在做：找 Chrome/Edge/Chromium → `--remote-debugging-port` 起独立 profile → 极简 CDP 客户端 → 页面里 fetch + 页面里解 PoW → 请求串行排队。
v1.0.83 补的是「用户没装浏览器时按需下一份」。

### B. 平台原生 WebView 宿主（补 Android / Windows 的空缺）

思路统一：**插件只讲 CDP，宿主只负责提供一个「能加载 chat.deepseek.com 的页面」**。

- **Android**：DSH App 里加一个隐藏 `WebView`（`setWebContentsDebuggingEnabled(true)`），暴露 `localabstract` 调试 socket；插件侧 `adb forward` 后按 `ws://127.0.0.1:9222/devtools/page/<id>` 连上去，和桌面走完全相同的代码路径。
  - 好处：内核是系统 Chromium，指纹与真机 Chrome 一致；省 200MB；不需要 root。
  - 代价：要改 App（新增权限/生命周期管理），并且 WebView 的 UA/`navigator` 与 Chrome 应用有细微差别（可在 `webSettings.setUserAgentString` 校准）。
- **Windows**：同理用 WebView2（`CoreWebView2` 的 CDP 端口），不需要用户装 Chrome；内核随 Edge 更新。
- **macOS/iOS**：WebKit 没有 CDP，只能自写 bridge（`evaluateJavaScript` + `WKScriptMessageHandler`），收益有限，**建议不做**，直接用系统 Chrome / WebKit 各自最优路径。

### C. 远程浏览器隧道（「任意设备」的终极兜底）

- 一台常开的机器（家用小主机 / NAS / 云主机）跑 Chrome + `--remote-debugging-port`，插件把 CDP 包成 WSS 隧道（或直接 `ssh -L`）。
- 插件只加一个 `browser.remoteEndpoint` 配置；连接逻辑与本地完全一致（同一个 Cdp 类）。
- 适合：设备本身跑不起内核（如本机 proot）、或想让多台设备共用同一浏览器环境。
- 风险：出口 IP 变成那台机器的；延迟多一跳（实测页面请求本身 1–3 秒，多 50–200ms 可接受）。

## 3. 本机实测记录（Android proot 容器）

| 项 | 结果 |
|---|---|
| 下载 Chrome for Testing linux-arm64 | ✅ 203MB / 24.8s（大陆镜像，峰值 22MB/s） |
| 解压 + `chrome --version` | ✅ `Google Chrome for Testing 157.0.8103.38` |
| `--headless=new --dump-dom about:blank` | ❌ 无输出、退出 0 或 SIGTRAP |
| CDP 起页面 | ❌ `一开页面就崩溃（信号 SIGTRAP）` —— proot 缺 seccomp/命名空间支持 |
| 结论 | 容器里**不可用**；设备上要真浏览器，只能走 App 内 WebView 或远程隧道 |

## 4. 多线程下载：实测与设计

下载器现在支持 Range 分片并发；关键是**并发不是越大越好**，实测（本机，50MB 样本）：

| 源 | 单连接 | 8 连接 |
|---|---|---|
| npmmirror（cn） | **12.3 MB/s** | 8.2 MB/s（更慢：出口打满） |
| Google 存储（intl） | 3.3 MB/s | 1.7 MB/s（本机出口同样打满） |

所以在国内宽带上跑「8 线程下 Google 存储」的常见收益（单流 200KB/s → 2MB/s）**在这里观察不到**，因为瓶颈是自己的上行/出口。
设计因此改成**自适应**：

1. 先 `Range: bytes=0-0` 探测服务端是否支持 206；
2. 支持则拉 1MB 做单流测速；
3. ≥4MB/s → 单流（不抢带宽）；< 4MB/s → 6 并发；
4. 用户可在界面上强制 1~16 线程（`engineThreads`，0 = 自动）；
5. 服务端不支持 206 → 自动退回单流，功能不受影响。

## 5. 建议的落地顺序

| 顺序 | 事项 | 代价 | 收益 |
|---|---|---|---|
| 1 | ✅ 已完成：桌面复用系统浏览器 + 按需下载内核 + 自适应多线程 | — | 桌面全平台可用 |
| 2 | Android：App 内 WebView 宿主（CDP） | 中（App 侧改动） | 手机上第一次真正做到「页面发请求」 |
| 3 | 远程浏览器隧道（`browser.remoteEndpoint`） | 小（复用现有 Cdp） | 任何跑不起内核的设备也能用真浏览器 |
| 4 | Windows：WebView2 宿主 | 中 | 免下载、内核随 Edge 更新 |
| 5 | 不做 macOS/iOS WebKit 桥 | — | 收益低，指纹反而不像 Chrome |

## 6. 风险与边界（必须写进文档）

- 内核只解决**客户端侧**指纹；出口 IP、账号历史、提示词形状仍是主因，换内核不等于「不会被封」。
- 远程隧道多一跳延迟，且那台机器的 IP 会变成你的出口；别在同一出口上频繁切换设备身份。
- App 内 WebView 的 UA / `navigator.webdriver` / 字体列表要和手机 Chrome 对齐，否则「声称是手机 Chrome、实际是 WebView」本身就是异常组合。
- headless 与有头浏览器在 `navigator.plugins`、`WebGL` 渲染器上仍有差异；有条件优先有头（`--headless=new` 已接近，但不是完全一致）。
