# dsh-deepseek-web

[![GitHub stars](https://img.shields.io/github/stars/wsxuyue/dsh-deepseek-web?style=social)](https://github.com/wsxuyue/dsh-deepseek-web/stargazers)
[![Release](https://img.shields.io/github/v/release/wsxuyue/dsh-deepseek-web)](https://github.com/wsxuyue/dsh-deepseek-web/releases/latest)

把 **chat.deepseek.com 网页版** 包成 OpenAI 兼容接口的 DeepSeek Harness 插件。如果它帮你省下了 API 费用，欢迎点个 **Star** ⭐

- **不需要浏览器**：Node 直连网页接口（PoW 用站点自带的 wasm 在本地算），因此在 Android/proot 容器里也能跑。
- **多账号**：轮询 + 429 冷却 + 401 自动切换，设置界面可增删。
- **选模型即启动**：平时只监听一个极轻量的入口，首次调用网页版模型时才拉起引擎，空闲自动休眠。
- **自带设置界面**：DSH 设置 →「DeepSeek 网页版」，可登录、管理账号、调参、看日志。
- **即装即用**：包内自带 `cordis.patch.yml`，安装后由 DSH 自动应用 provider 配置。

## 安装（新设备一条命令/粘贴链接即可用）

中国大陆推荐走 **gh-proxy 镜像**，下面三条任选其一：

**① 粘贴到 DSH「插件 → 安装插件」（镜像）**

```
git+https://gh-proxy.com/https://github.com/wsxuyue/dsh-deepseek-web.git
```

**② 发行版压缩包（镜像，最快）**

```
https://gh-proxy.com/https://github.com/wsxuyue/dsh-deepseek-web/releases/latest/download/dsh-deepseek-web-1.0.1.tgz
```

**③ 仓库页（镜像浏览）**

```
https://gh-proxy.com/https://github.com/wsxuyue/dsh-deepseek-web
```

> 镜像不可用时，把上面链接里的 `https://gh-proxy.com/` 去掉即可直连 GitHub（官方速度可能较慢）：
>
> - 插件 spec：`https://github.com/wsxuyue/dsh-deepseek-web`
> - 压缩包：`https://github.com/wsxuyue/dsh-deepseek-web/releases/latest/download/dsh-deepseek-web-1.0.1.tgz`

**不需要任何 API key**：插件自带 provider 配置与本地网关（`127.0.0.1:18081`），装好即用。

安装后**重启 DSH**，设置里会出现「DeepSeek 网页版」，模型列表会多出两个模型：

- `DeepSeek-V4(网页版·快速)` → `deepseek-chat`
- `DeepSeek-V4(网页版·深度思考)` → `deepseek-reasoner`

首次使用需要在插件设置里登录一次（见下）。

<details>
<summary>开发时用本机路径安装</summary>

```bash
dsh plugin --profile web add link:/root/dsh-deepseek-web
```

或把目录复制到 `~/.dsh/profiles/<profile>/node_modules/dsh-deepseek-web`，并在 `package.json` 的 `dsh.profile.bundles` 里加上 `dsh-deepseek-web`。
</details>

## 登录（需要你在浏览器里完成一次）

1. 在手机或电脑浏览器打开 https://chat.deepseek.com 并登录（人机验证由你完成）。
2. 取 `localStorage.userToken`：
   - 电脑：F12 → Console → `JSON.parse(localStorage.userToken).value` → 复制结果
   - 手机：地址栏输入 `javascript:prompt('token',JSON.parse(localStorage.userToken).value)`（需手动敲入，粘贴会被浏览器去掉 `javascript:` 前缀）
3. 打开 DSH 设置 →「DeepSeek 网页版」→ 粘贴 token → 「校验并保存」。

也可以命令行：

```bash
dsh-deepseek-web login --token <userToken> --label 工作号
dsh-deepseek-web doctor
```

> 邮箱验证码登录在无浏览器环境下通常被人机验证拦住，设置界面里保留入口但多为兜底用。

## 账号与风控

- 每个账号的请求串行、带最小发送间隔（默认 1200ms，可调），失败会退避。
- 429 → 该账号冷却 60s 起指数退避（上限 10min）并切下一个账号。
- 401 → 标记「登录失效」，不会自动重登，需重新粘贴 token。
- 指定账号：模型名写 `deepseek-chat@工作号` 即可固定到某个账号。

## 设置项

| 字段 | 默认 | 说明 |
|---|---|---|
| autoStart | true | 选择/调用网页版模型时自动拉起引擎 |
| idleStopMs | 600000 | 空闲多少毫秒后关停引擎 |
| sendGapMs | 1200 | 同一账号两次请求的最小间隔 |
| maxConcurrency | 4 | 全局并发上限（账号池总和） |
| sectionOrder | usage,engine,accounts,addAccount,log | 设置页卡片顺序，由最下方「页面设置」的 ↑/↓ 调整 |

设置页卡片从上到下默认是：网页版用量 → 运行设置 → 账号管理 → 添加账号 → 引擎日志 → 页面设置（没有账号时「添加账号」会临时置顶）。
「页面设置」（默认收起）可以调整前五块的先后顺序（自动保存，可「恢复默认顺序」）。

最底部是「关于」卡片：作者 irerc · DeepSeek Harness，显示插件名与版本。

最下方独立的「维护」卡片提供两个操作：

- **清空 Token 用量记录**：删除 `state/usage.json`，插件内累计用量归零（不影响账号、会话、登录状态）。
- **重置所有插件设置**：把 config 恢复默认值（自动启动、空闲休眠、发送间隔、并发、卡片顺序），会先弹出确认窗口再执行；窗口里可选勾选「同时删除已登录账号和 token（不可恢复）」，不勾选则保留账号。
  - 确认窗口内还有二级页「删除所有账号和数据」：彻底清空账号/token/cookie、用量统计、cookie 罐与全部设置（`POST /factory-reset`），需再点一次「确认彻底删除」。

## 目录

```
lib/index.js          Host 插件：入口监听、按需拉起引擎、设置界面路由
lib/client.js         客户端设置分区（__ModuleLoader__ 手写 bundle）
server/server.mjs     OpenAI 网关（流式、工具调用、续聊）
server/engine-http.mjs HTTP 引擎（PoW、SSE、账号池）
server/pow.mjs        DeepSeekHashV1 求解（wasm）
server/accounts.mjs   多账号存储与选择
server/config.mjs     运行配置
bin/cli.mjs           login/accounts/start/stop/status/doctor
```

状态目录：`state/`（`accounts.json`、`config.json`、`engine.log`，权限 0600）。

## 排障

- 模型调用报「没有可用账号」→ 设置里没登录或 token 全部失效。
- 报 502 `AUTH_REQUIRED` → token 过期，重新粘贴。
- 引擎起不来 → 看设置页「引擎日志」或 `state/engine.log`。
- 端口冲突：入口固定 `127.0.0.1:18081`，引擎内部用 `18082`。

## 风险提示

直连网页接口属于自动化访问，可能触发站点风控；多账号会放大风险。插件做了串行、节流、真实浏览器请求头与自然提示词，但**不能保证不被限流或封禁**。

MIT License
