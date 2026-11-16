# magpie-opencode-zen-local-free

给 magpie 用的 OpenCode Zen 免费模型供应商插件。格式照 [`magpie-community/plugins`](https://github.com/magpie-community/plugins) 的包约定写：一个 `package.json`、一个入口文件、入口只导出一个插件函数。

> 这是本地插件，没有发布到 npm，也不需要发。用 `magpie plugin add <本地目录>` 安装即可。

## 它为什么能过 Zen 的校验

Zen 的免费层会拒绝"不是 OpenCode 发的"请求（`403 FreeTierError` / `429 FreeUsageLimitError`）。本插件把每个请求改写成 OpenCode 自己发出的形状：

| 改写项 | 具体内容 |
|---|---|
| 凭据 | `Authorization: Bearer public`（OpenCode 未登录时内置的凭据；`anthropic` 走 `x-api-key: public`） |
| 客户端头 | `user-agent: opencode/latest/2.3.0/cli`、`x-opencode-client: cli` |
| 项目/会话头 | `x-opencode-project`（`sha1("git-remote:"+host/path)` 或 `sha1("directory:"+目录)`）、`x-opencode-session` / `-session-id` / `x-session-affinity` / `x-session-id`（OpenCode 的 `ses_` + 12 位 hex 时间戳 + 14 位 base62，同一对话稳定） |
| 追踪头 | `b3`、`traceparent`，同一会话稳定 |
| system 消息 | 没有 `<env>` 块就补一个，含真实 `Working directory:`、`Platform:` 等 |
| tools | 没有 tools 就补 OpenCode 2 的 5 个核心工具（`edit/glob/grep/read/shell`；`edit/read` 用 `path` 参数，不是 1.x 的 `file_path`），已有的不覆盖 |
| 工具名 | 名字含 `terminal` → `console`、含 `run_code` → `exec_program`；`ReportFindings`/`ScheduleWakeup`/`subagent_fork`/`read_image` 改成安全名；`edit`/`read` 带 DSH 的 `file_path` 参数时改成 `text_replace`/`file_view`，回复里再改回原名 |
| 工具描述 | DSH 的 `edit`/`read`/`skill` 被 Zen 拒绝的描述换成同义短句（名字不改也一样拒） |
| usage | `chat` 补 `stream_options.include_usage` |

源码出处：`packages/core/src/session/model-request.ts`（身份头）、`packages/core/src/instructions/builtins.ts`（`<env>` 块）、`packages/core/src/plugin/provider/opencode.ts`（`apiKey: "public"`），均按 v2.3.0 tag 核对。

## 安装

```sh
magpie plugin add <这个目录的绝对路径>
magpie plugin login opencode-zen-local-free   # key 一栏填 public
```

然后在 magpie 的 Agents 页给 agent 选模型：

```
opencode-zen-local-free/big-pickle
opencode-zen-local-free/deepseek-v4.1-flash-free
opencode-zen-local-free/glm-5.3-flash-free
opencode-zen-local-free/minimax-m3.1-flash-free
opencode-zen-local-free/longcat-2.5-free
opencode-zen-local-free/nemotron-3-ultra-free
```

没装 magpie 也能先自检（不联网）：

```sh
node verify.mjs
```

它会用假 fetch 捕获真正要发出去的请求，断言头、OpenCode 形状的会话 id、`<env>` 块、5 个核心工具（`path` 参数）、DSH `edit`/`read` 的改名与描述改写、工具名改名与还原、非免费模型的本地 404。

## 包结构（契约对照）

| 约定 | 本包 |
|---|---|
| `"type": "module"`、`main`/`exports` 指向入口 | ✅ `./index.mjs` |
| 入口只导出一个插件函数 | ✅ `OpenCodeZenLocalFreePlugin` |
| `license: "MIT"` | ✅ |
| 图标两处一致 | `auth.icon` 与 `package.json` 的 `magpie.icon` 同一份 data URI |
| `magpie.maxConcurrency` | ✅ 2 |
| 钩子：`config` / `auth.methods[].authorize` / `auth.loader` / `auth.usage` / `provider.models` / `chat.headers` | ✅ 全部实现 |
| `config.models` 未登录也有内容 | ✅ 静态表兜底 |
| `authorize()` 立刻返回 | ✅ 返回 `{type:"success", key:"public"}` |
| 登录方式 | `type: "api"` + `keyless: true`（无 key 也能启用） |

## 已知限制（按真实需要再补）

1. **只支持三种协议**：chat / responses / anthropic。Zen 的 SystemOne 模型（`jev-1.13-free` 等）不是聊天模型，未提供。
2. **上下文窗口是文档值**，`/models` 只返回 id，元数据取静态表；Zen 改了窗口要手动更新 `BOOTSTRAP`。
3. **`OPENCODE_VERSION = "2.3.0"`** 是写死的。Zen 一旦按版本号收紧（历史上发生过：1.19.0 的 UA 被 429），把它改成当前发布版本。
4. **流被 Zen 掐断（缺 `[DONE]`）时不做修复**，会原样交给 agent；需要的话可移植 zen-free 的 `stream.mjs` 逻辑。
5. **模型列表拉取失败**时沿用上次列表（首次是静态表），不会让 agent 看到"0 models"。
6. `fetch` 只接受 magpie 拼出的 `${baseURL}${PATHS[...]}` 形式，带 query 的 URL 不识别。

## 风险

这套做法的实质是让非 OpenCode 客户端通过 Zen 的客户端校验，绕过了它明示的"免费层只在 OpenCode 内可用"。被 Zen 改规则、被风控、或违反其条款的后果由使用者承担；长期使用建议改用付费模型 / Go 订阅，或同源模型的官方免费渠道。
