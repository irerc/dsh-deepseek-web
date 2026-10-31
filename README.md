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
https://gh-proxy.com/https://github.com/wsxuyue/dsh-deepseek-web/releases/latest/download/dsh-deepseek-web-1.0.9.tgz
```

**③ 仓库页（镜像浏览）**

```
https://gh-proxy.com/https://github.com/wsxuyue/dsh-deepseek-web
```

> 镜像不可用时，把上面链接里的 `https://gh-proxy.com/` 去掉即可直连 GitHub（官方速度可能较慢）：
>
> - 插件 spec：`https://github.com/wsxuyue/dsh-deepseek-web`
> - 压缩包：`https://github.com/wsxuyue/dsh-deepseek-web/releases/latest/download/dsh-deepseek-web-1.0.9.tgz`

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

## 更新日志

### v1.0.9

- **请求体 100% 是 API JSON**：发出去的整段内容就是
  `{"model":"deepseek-web","messages":[…],"tools":[…],"tool_choice":"auto"}`，
  JSON 外面不再有任何中文包装；「按 assistant JSON 回复」的要求改成 messages 里的一条 system 消息。

### v1.0.8

- **请求体就是真正的 API JSON**：发给网页模型的是标准 OpenAI 请求体
  `{"model":"deepseek-web","messages":[...],"tools":[...]}`（消息里保留 role / content / tool_calls / tool_call_id），后面再附一小段「按 assistant 消息 JSON 回复」的要求。
- 回复解析兼容两种形状：`{"role":"assistant",...}` 与完整响应 `{"choices":[{"message":{...}}]}`。

### v1.0.7

- **空参数的工具调用直接拦下**：模型信息不足时经常甩一个 `{}` 调用（截图里 `输入 {}` → 无障碍服务报 `ACCESSIBILITY_UNAVAILABLE`）。现在参数为空但工具需要参数时判为无效，返回「参数不完整，请补全」提示，不再把坏调用丢给工具层。
- 配合 v1.0.6：工具调用缺 `description` 自动补全，缺其它必填则丢弃并回提示。

### v1.0.6

- **按 API 格式收发**：发给网页模型的是 API 请求体形状的内容（`messages[]` 带 role / tool_calls / tool_call_id，加工具清单），并要求模型按 **OpenAI assistant 消息格式**回复：
  `{"role":"assistant","content":...,"tool_calls":[{"name":...,"arguments":{...}}]}`
  - 桥接器解析后翻译成标准 OpenAI 响应（正文 + tool_calls），解析失败自动退回纯文本，不会把 JSON 漏给用户。
  - 需要旧式「正文 + 标记」协议时：环境变量 `DSW_REPLY_FORMAT=text`。
- **上游报错不再静默**：网页端返回「消息发送过于频繁」等提示时直接回 `429/502` 说明原因，不再空回复重试三次、越retry越被限流。

### v1.0.5

- **一段 DSH 对话只用一条网页对话**：首轮新建，之后一直复用，不再因为历史对不上、重试、压缩就新开。
- **压缩后能认回原会话**：DSH 压缩上下文、首条消息变了时，用「最近几轮回复的指纹」把原来的网页会话找回来，并补最近 8 条继续（日志里是 `adopted existing web session by reply digest` / `continuation+resync`）。
- **超长交给网页端**：不再本地整段重发或新开会话，上下文超过网页端上限时由网页端自行清理。

### v1.0.4

- **行为对齐官方 API**：同一段对话能复用网页会话时只补「网页会话里还没有的那部分」（省 token、命中缓存）；一旦历史对不上（编辑/压缩/换会话），整段重发 —— 效果与无状态 API 一致。
- **工具参数校验与修补**：DSH 的工具会拒收缺必填参数的调用，模型收到报错后会反复重试坏调用（截图里的 `missing required property "description"` 循环）。
  - `description` 缺失时由 `command` 自动推导补全；
  - 其他必填缺失或参数不是合法 JSON 时丢弃该调用，并回一句「参数不完整，请补全重试」，不再把坏调用交给工具层。
- **工具说明标注「必填：…」**，并在协议里强调缺参数会被拒绝。

### v1.0.3

- **修复「满屏 \n」的乱码回复**：模型给出的工具调用块参数过长、被上游截断（没有结束标记）时，旧代码会把整段 JSON 当正文吐出来，用户就看到带 `\n` 转义的乱码。
  - 现在：能解析就照常当工具调用；解析不了只给一句「工具调用内容过长被截断，请拆成更小步骤」，不再把原始 JSON 当正文。
  - 正文里成片出现的 `\n` 转义会自动还原成真实换行。
- **提示词约束**：正文必须用真实换行 / 普通 Markdown，禁止输出 JSON 转义写法；工具参数里的长文本要求分块（单次约 2000 字）。
- 历史里展示工具参数时会把转义还原成可读文本，避免模型跟着模仿。

### v1.0.2

- **上下文不再被截断**：以前 prompt 超过 6 万字符会把工具说明整段丢掉，导致模型「不会用工具、看不到提问功能」。现在按 **token** 预算（默认 96K，可用 `DSW_MAX_PROMPT_TOKENS` 调）分配：
  - 系统设定与工具说明**永远保留**（工具说明放不下时先降级压缩，而不是删除）
  - 只从最旧的历史开始裁剪，并在正文里标注省略了多少条
- **工具结果可见**：最后一条用户消息之后的 `assistant(tool_calls)` 与 `tool` 结果现在会一起发给网页模型，并在历史里标成「（我调用了工具 X）／（X 的返回结果）」，模型不会再重复调用同一个工具。
- **工具调用协议更明确**：提示词要求「整条回复只输出工具块」，并点明需要用户选择时调用 `ask_user_question` 这类提问工具。
- 流式返回补充 `role: assistant` 起始块，兼容更多 OpenAI 客户端。
- 工具说明默认给出更完整的描述与参数（600 字描述 / 2400 字参数），预算不足时自动压缩。
