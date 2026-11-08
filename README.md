# dsh-deepseek-web

[![GitHub stars](https://img.shields.io/github/stars/irerc/dsh-deepseek-web?style=social)](https://github.com/irerc/dsh-deepseek-web/stargazers)
[![Release](https://img.shields.io/github/v/release/irerc/dsh-deepseek-web)](https://github.com/irerc/dsh-deepseek-web/releases/latest)

把 **chat.deepseek.com 网页版** 接成 OpenAI 兼容接口的 DeepSeek Harness 插件：不需要 API key，不需要浏览器常驻。

## 能做什么

| 能力 | 说明 |
|---|---|
| OpenAI 兼容 | `/v1/chat/completions`，支持流式；模型列表自动生成 |
| 无浏览器直连 | Node 直连网页接口，PoW 在本地算，Android / 容器里也能跑 |
| 多账号池 | 轮换 + 429 冷却 + 401 自动切换；禁言 / 封号 / 失效账号自动避让 |
| 登录与续期 | 系统浏览器登录页回填 token，或用保存的密码自动重登；账号级设备身份隔离 |
| 自带设置界面 | DSH 设置 →「DeepSeek 网页版」：账号 / 登录 / 用量 / 运行 四页 |
| 即装即用 | 包内自带 `cordis.patch.yml`，安装后 DSH 自动注册 provider 与本地网关 |

## 安装

任选一条，粘到 DSH「插件 → 安装插件」：

```text
# ① npm（最省事）
dsh plugin add @irerc/dsh-deepseek-web

# ② 仓库（中国大陆推荐走 gh-proxy 镜像）
git+https://gh-proxy.com/https://github.com/irerc/dsh-deepseek-web.git

# ③ 发行版压缩包（镜像）
https://gh-proxy.com/https://github.com/irerc/dsh-deepseek-web/releases/latest/download/dsh-deepseek-web.tgz
```

镜像打不开就把 `https://gh-proxy.com/` 去掉直连 GitHub。

安装后**重启 DSH**，模型列表会多出两个：

| 模型 | 用途 |
|---|---|
| `DeepSeek-V4(网页版·快速)` | 日常对话 |
| `DeepSeek-V4(网页版·深度思考)` | 需要推理的长任务 |

## 第一次用

1. 设置 →「DeepSeek 网页版」→「登录」页 → 点 **登录（打开浏览器）**（浏览器打不开就展开「更多登录方式」用内嵌窗口 / 粘贴 token / 邮箱密码）；
2. 登录成功后 token 自动回填，账号出现在「账号」页；
3. 回对话页选 `DeepSeek-V4(网页版·快速)` 开始用。

本地网关默认 `127.0.0.1:18081`，只监听回环，不对外暴露。

## 常见问题

| 问题 | 处理 |
|---|---|
| 登录失效 | 账号行点「重新登录」；存了密码会尝试自动重登 |
| 被禁言 / 封号 | 站点侧处置，插件只能避让：换账号或等解封；「更多 → 按新设备重置」换设备身份 |
| 被当成新设备验证 | 换网络（流量 / 另一条宽带）后重新登录；连续换设备会更容易被要求验证 |
| 模型列表里没有「DeepSeek 网页版」 | 你自己的 profile 里如果也写了 `llm-pi-ai.config.providers`，用户层会整段覆盖插件的配置：把 `deepseek-web` 那一段一起写进你自己的 `cordis.patch.yml` 即可（片段见 [docs/DETAILS.md](docs/DETAILS.md)） |
| 想要更像正常 API | 「运行」页把请求模式设成「原始模式」，关掉额外包装 |
| 想少触发风控 | 使用「保险模式」并放慢发送节奏；提示词别太模板化 |

更多细节（设备身份、请求模式、传输层、排障、风控原理）见 [docs/DETAILS.md](docs/DETAILS.md)；版本历史见 [CHANGELOG.md](CHANGELOG.md)。

## 风险提示

走的是网页版，受站点自身风控与接口变化影响；插件不保证不被封号，也不对站点侧处置负责。请遵守站点条款。

## 许可

MIT
