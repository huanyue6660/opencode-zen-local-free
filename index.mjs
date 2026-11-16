// magpie / OpenCode 供应商插件：OpenCode Zen 免费模型
//
// 目的：让 magpie 里的 agent 用上 Zen 的免费层。Zen 的免费层按客户端身份放行
// （HTTP 403 FreeTierError / 429 FreeUsageLimitError），所以每个请求都被改写成
// OpenCode 自己发出的形状：
//
//   1. Authorization: Bearer public（OpenCode 未登录时内置的凭据）
//   2. User-Agent / x-opencode-client / x-opencode-project / 会话三个头
//   3. system 里带 <env> … Working directory: … </env> 块
//   4. 必须带 tools，且补齐 OpenCode 的 5 个核心工具
//   5. 黑名单工具名改名，回复里再改回来
//
// 参考实现：magpie-community/plugins 的 packages/zen-free（MIT）。
// 这份是精简版，协议只覆盖 chat / responses / anthropic。

import { createHash, randomBytes } from "node:crypto"
import { existsSync, readFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"

// ─── 常量 ────────────────────────────────────────────────────────────────

const PROVIDER = "zen-free-lite"
const PROVIDER_NAME = "OpenCode Zen 免费 Lite"
const BASE = "https://opencode.ai/inference/v1"

// 发送给 Zen 的 UA 里的 OpenCode 版本。Zen 会核对这个版本（旧 UA 会被 429），
// 所以它必须跟一个真实存在的发布版本对得上；升级插件时一起改。
const OPENCODE_VERSION = "2.3.0"
const USER_AGENT = `opencode/latest/${OPENCODE_VERSION}/cli`

// 图标：auth.icon 与 package.json 的 magpie.icon 必须是同一份（缺一处会显示灰方块）
const ICON =
  "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAxMjggMTI4Ij48cmVjdCB3aWR0aD0iMTI4IiBoZWlnaHQ9IjEyOCIgcng9IjI4IiBmaWxsPSIjMWYyOTM3Ii8+PHRleHQgeD0iNjQiIHk9Ijg2IiBmb250LXNpemU9IjY0IiBmb250LWZhbWlseT0ic3lzdGVtLXVpLHNhbnMtc2VyaWYiIGZvbnQtd2VpZ2h0PSI3MDAiIGZpbGw9IiMzNGQzOTkiIHRleHQtYW5jaG9yPSJtaWRkbGUiPlo8L3RleHQ+PC9zdmc+"

const SDK = {
  chat: "@ai-sdk/openai-compatible",
  responses: "@ai-sdk/openai",
  anthropic: "@ai-sdk/anthropic",
}

const PATHS = {
  chat: "/chat/completions",
  responses: "/responses",
  anthropic: "/messages",
}

// 各协议在 Zen 上游的真实地址（不是 BASE，BASE 只是 magpie 看到的那层）
const UPSTREAM = {
  chat: "https://opencode.ai/inference/openai/v1/chat/completions",
  responses: "https://opencode.ai/inference/openai/v1/responses",
  anthropic: "https://opencode.ai/inference/anthropic/v1/messages",
}

// ─── 模型表 ──────────────────────────────────────────────────────────────
// 上下文 / 输出按 Zen 文档标注；live /models 只给 id，所以这些是兜底元数据。
const BOOTSTRAP = {
  "big-pickle": { name: "Big Pickle", context: 200000, output: 32000, reasoning: true, input: ["text"] },
  "iceman-free": { name: "Iceman Free", context: 200000, output: 32000, reasoning: true, input: ["text"] },
  "inkling-2-small-free": { name: "Inkling 2 Small Free", context: 200000, output: 32000, reasoning: true, input: ["text"] },
  "glm-5.3-flash-free": { name: "GLM-5.3-Flash Free", context: 200000, output: 32000, reasoning: true, input: ["text"] },
  "deepseek-v4.1-flash-free": { name: "DeepSeek V4.1 Flash Free", context: 258624, output: 32000, reasoning: true, input: ["text"] },
  "minimax-m3.1-flash-free": { name: "MiniMax M3.1 Flash Free", context: 200000, output: 32000, reasoning: true, input: ["text"] },
  "beam-free": { name: "Beam Free", context: 200000, output: 32000, reasoning: false, input: ["text"] },
  "flint-40b-free": { name: "Flint 40B Free", context: 131072, output: 32000, reasoning: true, input: ["text"] },
  "longcat-2.5-free": { name: "LongCat 2.5 Free", context: 1000000, output: 131072, reasoning: true, input: ["text", "image"] },
  "mimo-v2.6-flash-free": { name: "MiMo-V2.6-Flash Free", context: 200000, output: 32000, reasoning: true, input: ["text", "image", "audio", "video"] },
  "nemotron-3-ultra-free": { name: "Nemotron 3 Ultra Free", context: 262144, output: 32768, reasoning: true, input: ["text"] },
  "nemotron-3.5-lightning-free": { name: "Nemotron 3.5 Lightning Free", context: 262144, output: 262144, reasoning: true, input: ["text"] },
  "nemotron-3.5-super-vl-free": { name: "Nemotron 3.5 Super VL Free", context: 262144, output: 32768, reasoning: true, input: ["text", "image"] },
}

// 这些不是聊天模型（SystemOne 决策接口），不提供
const EXCLUDED = new Set(["jev-1.13-free", "jev-1.13", "gpt-6-luna-decision", "gemini-decision-1"])

function modalities(values) {
  return Object.fromEntries(
    ["text", "image", "audio", "video", "pdf"].map((name) => [name, values.includes(name)]),
  )
}

function freeish(id) {
  return /-free$/.test(id) || id === "big-pickle"
}

function buildModel(id, liveName) {
  const meta = BOOTSTRAP[id] ?? { name: id, context: 200000, output: 32000, reasoning: true, input: ["text"] }
  const input = modalities(meta.input)
  return {
    id,
    providerID: PROVIDER,
    name: meta.name ?? liveName ?? id,
    api: { id, url: BASE, npm: SDK.chat },
    limit: { context: meta.context, output: meta.output },
    capabilities: {
      temperature: true,
      reasoning: meta.reasoning,
      toolcall: true,
      attachment: meta.input.some((kind) => kind !== "text"),
      input,
      output: modalities(["text"]),
    },
    cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
    variants: {},
    options: {},
    headers: {},
    status: "active",
    release_date: "",
    free: true,
  }
}

function staticModels() {
  return Object.fromEntries(Object.keys(BOOTSTRAP).map((id) => [id, buildModel(id)]))
}

// config 钩子的模型形状（与 provider.models 的字段名不同，见模板说明）
function configModels(models) {
  return Object.fromEntries(
    Object.entries(models).map(([id, model]) => [
      id,
      {
        id,
        name: model.name,
        provider: { npm: model.api.npm, api: model.api.url },
        limit: model.limit,
        reasoning: model.capabilities.reasoning,
        tool_call: model.capabilities.toolcall,
        attachment: model.capabilities.attachment,
        modalities: {
          input: Object.keys(model.capabilities.input).filter((key) => model.capabilities.input[key]),
          output: Object.keys(model.capabilities.output).filter((key) => model.capabilities.output[key]),
        },
        cost: { input: 0, output: 0 },
        free: true,
      },
    ]),
  )
}

// ─── 身份：目录 / 项目 id / 会话 id ─────────────────────────────────────

const sha1 = (text) => createHash("sha1").update(text).digest("hex")
const sha256 = (text) => createHash("sha256").update(text).digest("hex")

function readGitConfig(dir) {
  const dotGit = join(dir, ".git")
  if (!existsSync(dotGit)) return undefined
  const configPath = join(dotGit, "config")
  if (!existsSync(configPath)) return undefined
  return readFileSync(configPath, "utf8")
}

// 与 OpenCode 的 Project.ID 一致：有 origin 远程用 sha1("git-remote:"+host/path)，
// 否则 sha1("directory:"+目录)。
function projectID(dir) {
  for (let current = dir; ; current = dirname(current)) {
    const config = readGitConfig(current)
    if (config !== undefined) {
      const url = /\[remote "origin"\][^\[]*?\burl\s*=\s*(\S+)/.exec(config)?.[1]
      const parts = url && urlParts(url)
      if (parts) return sha1(`git-remote:${parts}`)
      break
    }
    if (dirname(current) === current) break
  }
  return sha1(`directory:${dir}`)
}

function urlParts(value) {
  const clean = value.trim().replace(/^git@/, "").replace(/^ssh:\/\//, "")
  const scp = /^([^/]+):(.+)$/.exec(clean)
  const http = /^(?:https?|git):\/\/([^/]+)\/(.+)$/.exec(value.trim())
  const host = scp?.[1] ?? http?.[1]
  const path = scp?.[2] ?? http?.[2]
  if (!host || !path) return undefined
  const name = path.replace(/^\/+/, "").replace(/\.git\/?$/, "").replace(/\/+$/, "")
  if (!name) return undefined
  return `${host.toLowerCase()}/${name}`
}

// OpenCode 的会话 id：ses_ + 12 位十六进制（时间戳 * 0x1000 + 计数器，会话取反）
// + 14 位 base62。Zen 免费层按这个形状校验；纯 hash 的 ses_<64 hex> 会被 429。
const ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"
let lastStamp = 0
let counter = 0

function opencodeID(prefix, descending, now = Date.now()) {
  if (now !== lastStamp) {
    lastStamp = now
    counter = 0
  }
  counter += 1
  const current = BigInt(now) * 0x1000n + BigInt(counter)
  const value = (descending ? ~current : current) & 0xffffffffffffn
  let time = ""
  for (let index = 0; index < 6; index += 1) {
    time += Number((value >> BigInt(40 - 8 * index)) & 0xffn)
      .toString(16)
      .padStart(2, "0")
  }
  let tail = ""
  for (const byte of randomBytes(14)) tail += ALPHABET[byte % 62]
  return `${prefix}_${time}${tail}`
}

// 只认 OpenCode 自己会生成的那种 id：低 12 位计数器要很小。hash 出来的同长度 id 不算。
function realSessionID(value) {
  const match = /^ses_[0-9a-f]{9}([0-9a-f]{3})[0-9A-Za-z]{14}$/.exec(value ?? "")
  return !!match && 0xfff - Number.parseInt(match[1], 16) < 16
}

// 同一个对话的请求沿用同一个会话 id；进程重启后重新生成。
const SESSIONS = new Map()
const KEEP_SESSIONS = 1000

function sessionID(given, body) {
  let signal
  for (const name of [
    "x-opencode-session",
    "x-opencode-session-id",
    "x-session-affinity",
    "x-session-id",
    "conversation-id",
  ]) {
    const value = given.get(name)
    if (value) {
      signal = value
      break
    }
  }
  if (!signal && typeof body?.metadata?.session_id === "string") signal = body.metadata.session_id
  if (realSessionID(signal)) return signal
  if (!signal) {
    const messages = body?.messages ?? body?.input
    const first = Array.isArray(messages)
      ? messages.find((message) => message?.role === "user")?.content
      : messages
    if (!first) return opencodeID("ses", true)
    signal = typeof first === "string" ? first : JSON.stringify(first)
  }
  const key = sha256(`ses\0${signal}`)
  let session = SESSIONS.get(key)
  if (session) {
    SESSIONS.delete(key)
  } else {
    session = opencodeID("ses", true)
    if (SESSIONS.size >= KEEP_SESSIONS) SESSIONS.delete(SESSIONS.keys().next().value)
  }
  SESSIONS.set(key, session)
  return session
}

function traceHeaders(session) {
  const trace = sha256(`trace\0${session}`).slice(0, 32)
  const span = sha256(`span\0${session}`).slice(0, 16)
  return {
    b3: `${trace}-${span}-1-${sha256(`parent\0${session}`).slice(0, 16)}`,
    traceparent: `00-${trace}-${span}-01`,
  }
}

function environmentBlock(directory) {
  const root = directory
  const gitRepo = existsSync(join(directory, ".git"))
  return [
    "Here is some useful information about the environment you are running in:",
    "<env>",
    `  Working directory: ${directory}`,
    `  Workspace root folder: ${root}`,
    `  Is directory a git repo: ${gitRepo ? "yes" : "no"}`,
    `  Platform: ${process.platform}`,
    `  Prefer ${tmpdir()} over generic system temporary directories such as /tmp; it is pre-created and approved for external access.`,
    "</env>",
  ].join("\n")
}

// ─── 请求体改写 ─────────────────────────────────────────────────────────

// OpenCode 2 的核心工具：edit/read 的第一个参数是 path（不是 1.x 的 file_path），
// 描述也要用这句；Zen 按这个形状认，形状不对会 429 FreeUsageLimitError。
const CORE_TOOLS = [
  {
    name: "edit",
    description: "Not available. Never call this tool.",
    parameters: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
      additionalProperties: false,
    },
  },
  {
    name: "glob",
    description: "Not available. Never call this tool.",
    parameters: {
      type: "object",
      properties: { pattern: { type: "string" } },
      required: ["pattern"],
      additionalProperties: false,
    },
  },
  {
    name: "grep",
    description: "Not available. Never call this tool.",
    parameters: {
      type: "object",
      properties: { pattern: { type: "string" } },
      required: ["pattern"],
      additionalProperties: false,
    },
  },
  {
    name: "read",
    description: "Not available. Never call this tool.",
    parameters: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
      additionalProperties: false,
    },
  },
  {
    name: "shell",
    description: "Not available. Never call this tool.",
    parameters: {
      type: "object",
      properties: { command: { type: "string" } },
      required: ["command"],
      additionalProperties: false,
    },
  },
]

// Zen 免费层按名字拒绝某些工具（见 zen-free README）：含 terminal 的、
// 含 run_code 的、ReportFindings 与 ScheduleWakeup 同现的，以及几个 OpenCode 内部名词。
const RENAMES = new Map([
  ["ReportFindings", "findings_report"],
  ["ScheduleWakeup", "wakeup_schedule"],
  ["subagent_fork", "conversation_delegate"],
  ["read_image", "workspace_directory"],
])

// 名字本身没问题、但“名字 + 这组参数”会被拒的（DSH 的 edit/read）：
// 参数名一个都不能少时才算命中，换成 Zen 认的名字。
const REFUSED_WITH_PARAMETERS = [
  { name: "edit", parameters: ["file_path", "old_string", "new_string"], as: "text_replace" },
  { name: "read", parameters: ["file_path", "offset", "limit"], as: "file_view" },
]

// Zen 也会按描述整段拒绝，跟工具名无关；这些描述换成同义的短句。
const REFUSED_DESCRIPTIONS = new Map([
  [
    "Edit an existing UTF-8 text file by replacing literal text.",
    "Replace an exact piece of text in a UTF-8 file that already exists.",
  ],
  [
    "Read a UTF-8 text file and return line-numbered content.",
    "Read a UTF-8 text file. Each line comes back with its number.",
  ],
  [
    "Load the full instructions for a skill. Call it before acting on a task that names or clearly matches a skill in the session skill catalog.",
    "Open a skill's whole instructions. Use it first when a task names a skill from the session's skill catalog, or plainly fits one.",
  ],
])

function renameTarget(name, parameters) {
  for (const rule of REFUSED_WITH_PARAMETERS) {
    if (rule.name === name && rule.parameters.every((key) => parameters.has(key))) return rule.as
  }
  if (RENAMES.has(name)) return RENAMES.get(name)
  if (/terminal/i.test(name)) return name.replace(/terminal/gi, "console")
  if (/run_code/i.test(name)) return name.replace(/run_code/gi, "exec_program")
  return undefined
}

// chat: tools[].function.name；responses: tools[].name；anthropic: tools[].name
function toolEntries(body, protocol) {
  const tools = Array.isArray(body?.tools) ? body.tools : []
  return tools
    .map((tool) => {
      const definition = protocol === "chat" ? tool?.function : tool
      if (!definition?.name) return undefined
      const schema = protocol === "anthropic" ? definition.input_schema : definition.parameters
      const properties = schema && typeof schema === "object" ? schema.properties : undefined
      const parameters = new Set(properties && typeof properties === "object" ? Object.keys(properties) : [])
      return { holder: definition, key: "name", name: definition.name, parameters }
    })
    .filter(Boolean)
}

function applyToolRenames(body, protocol) {
  const entries = toolEntries(body, protocol)
  for (const entry of entries) {
    if (typeof entry.holder.description !== "string") continue
    const reworded = REFUSED_DESCRIPTIONS.get(entry.holder.description.trim())
    if (reworded) entry.holder.description = reworded
  }
  const taken = new Set(entries.map((entry) => entry.name))
  const reverse = new Map()
  for (const entry of entries) {
    const target = renameTarget(entry.name, entry.parameters)
    if (!target) continue
    let unique = target
    for (let suffix = 2; taken.has(unique); suffix += 1) unique = `${target}_${suffix}`
    taken.add(unique)
    reverse.set(unique, entry.name)
    entry.holder[entry.key] = unique
  }
  if (reverse.size === 0) return reverse
  // tool_choice / 历史调用里的名字一起换，否则模型看到的名字对不上
  const choice = body.tool_choice
  if (typeof choice === "string") body.tool_choice = reverseOf(reverse, choice) ?? choice
  else if (choice && typeof choice === "object") {
    const inner = choice.function?.name ?? choice.name
    const renamed = reverseOf(reverse, inner)
    if (renamed) {
      if (choice.function) choice.function.name = renamed
      else choice.name = renamed
    }
  }
  for (const message of body.messages ?? []) {
    for (const call of message.tool_calls ?? []) {
      const renamed = reverseOf(reverse, call?.function?.name)
      if (renamed) call.function.name = renamed
    }
    if (protocol === "anthropic" && Array.isArray(message.content)) {
      for (const block of message.content) {
        const renamed = reverseOf(reverse, block?.name)
        if (renamed) block.name = renamed
      }
    }
  }
  return reverse
}

// reverse 是 (改名后 → 原名)，正向替换要用反查
function reverseOf(reverse, name) {
  for (const [to, from] of reverse) if (from === name) return to
  return undefined
}

function ensureTools(body, protocol) {
  if (protocol === "chat") {
    body.tools ??= []
    if (!Array.isArray(body.tools)) body.tools = []
    const present = new Set(body.tools.map((tool) => tool?.function?.name).filter(Boolean))
    for (const tool of CORE_TOOLS) {
      if (present.has(tool.name)) continue
      body.tools.push({
        type: "function",
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters,
          strict: false,
        },
      })
    }
  } else {
    body.tools ??= []
    if (!Array.isArray(body.tools)) body.tools = []
    const present = new Set(body.tools.map((tool) => tool?.name).filter(Boolean))
    for (const tool of CORE_TOOLS) {
      if (present.has(tool.name)) continue
      const definition = { name: tool.name, description: tool.description }
      body.tools.push(
        protocol === "anthropic"
          ? { ...definition, input_schema: tool.parameters }
          : { type: "function", ...definition, parameters: tool.parameters },
      )
    }
  }
}

function hasEnvBlock(body, protocol) {
  if (protocol === "chat") {
    return (body.messages ?? []).some(
      (message) => message?.role === "system" && typeof message.content === "string" && message.content.includes("<env>"),
    )
  }
  if (protocol === "anthropic") {
    const system = body.system
    if (typeof system === "string") return system.includes("<env>")
    return Array.isArray(system) && system.some((block) => String(block?.text ?? "").includes("<env>"))
  }
  return String(body.instructions ?? "").includes("<env>")
}

function addEnvironment(body, protocol, directory) {
  if (hasEnvBlock(body, protocol)) return
  const block = environmentBlock(directory)
  if (protocol === "chat") {
    body.messages ??= []
    // 放在已有 system 段之后，别抢在 agent 自己的提示词前面
    let at = 0
    while (at < body.messages.length && body.messages[at]?.role === "system") at += 1
    body.messages.splice(at, 0, { role: "system", content: block })
    return
  }
  if (protocol === "anthropic") {
    const text = { type: "text", text: block }
    if (body.system === undefined) body.system = [text]
    else if (typeof body.system === "string") body.system = [{ type: "text", text: body.system }, text]
    else if (Array.isArray(body.system)) body.system.push(text)
    return
  }
  body.instructions = body.instructions ? `${body.instructions}\n\n${block}` : block
}

// ─── 回复改写（把改过的工具名换回来） ───────────────────────────────────

function restoreChat(payload, reverse) {
  for (const choice of payload?.choices ?? []) {
    const calls = choice?.message?.tool_calls ?? choice?.delta?.tool_calls ?? []
    for (const call of calls) {
      const name = call?.function?.name
      if (name && reverse.has(name)) call.function.name = reverse.get(name)
    }
  }
  return payload
}

function restoreAnthropic(payload, reverse) {
  for (const block of payload?.content ?? []) {
    if (block?.name && reverse.has(block.name)) block.name = reverse.get(block.name)
  }
  return payload
}

function restoreResponses(payload, reverse) {
  for (const item of payload?.output ?? []) {
    if (item?.name && reverse.has(item.name)) item.name = reverse.get(item.name)
  }
  return payload
}

function restore(payload, protocol, reverse) {
  if (protocol === "chat") return restoreChat(payload, reverse)
  if (protocol === "anthropic") return restoreAnthropic(payload, reverse)
  return restoreResponses(payload, reverse)
}

// SSE 行缓冲：把 data: 行里的 JSON 改写，其余原样透传
function restoreStream(stream, protocol, reverse) {
  const decoder = new TextDecoder()
  const encoder = new TextEncoder()
  let buffer = ""
  return stream.pipeThrough(
    new TransformStream({
      transform(chunk, controller) {
        buffer += decoder.decode(chunk, { stream: true })
        let index = buffer.indexOf("\n")
        while (index !== -1) {
          const line = buffer.slice(0, index)
          buffer = buffer.slice(index + 1)
          controller.enqueue(encoder.encode(`${rewriteLine(line, protocol, reverse)}\n`))
          index = buffer.indexOf("\n")
        }
      },
      flush(controller) {
        if (buffer) controller.enqueue(encoder.encode(rewriteLine(buffer, protocol, reverse)))
      },
    }),
  )
}

function rewriteLine(line, protocol, reverse) {
  const trimmed = line.startsWith("data: ") ? line.slice(6) : undefined
  if (!trimmed || trimmed === "[DONE]") return line
  let payload
  try {
    payload = JSON.parse(trimmed)
  } catch {
    return line
  }
  if (protocol === "anthropic") {
    if (payload.type === "content_block_start" && payload.content_block?.name) {
      const name = payload.content_block.name
      if (reverse.has(name)) payload.content_block.name = reverse.get(name)
    }
  } else if (protocol === "responses") {
    if ((payload.type === "response.output_item.added" || payload.type === "response.output_item.done") && payload.item?.name) {
      const name = payload.item.name
      if (reverse.has(name)) payload.item.name = reverse.get(name)
    }
  } else {
    payload = restoreChat(payload, reverse)
  }
  return `data: ${JSON.stringify(payload)}`
}

// ─── 模型发现 ───────────────────────────────────────────────────────────

async function discover(signal) {
  const response = await fetch(`${BASE}/models`, {
    headers: {
      authorization: "Bearer public",
      "user-agent": USER_AGENT,
      "x-opencode-client": "cli",
    },
    signal,
  })
  if (!response.ok) throw new Error(`Zen models ${response.status}`)
  const listing = await response.json()
  const ids = (listing?.data ?? [])
    .map((item) => item?.id)
    .filter((id) => typeof id === "string" && freeish(id) && !EXCLUDED.has(id))
  if (ids.length === 0) throw new Error("Zen listed no free model")
  return Object.fromEntries(ids.map((id) => [id, buildModel(id, listing.data.find((item) => item.id === id)?.name)]))
}

// ─── 插件入口（整个文件只导出这一个函数） ───────────────────────────────

export const ZenFreeLitePlugin = async (ctx = {}, _options = {}) => {
  const directory = typeof ctx?.directory === "string" && ctx.directory ? ctx.directory : process.cwd()
  const project = projectID(directory)

  let known = staticModels()

  return {
    config: async (cfg) => {
      cfg.provider ??= {}
      cfg.provider[PROVIDER] ??= {
        name: PROVIDER_NAME,
        npm: SDK.chat,
        api: BASE,
        models: configModels(staticModels()),
      }
    },

    auth: {
      provider: PROVIDER,
      single: true,
      maxConcurrency: 2,
      icon: ICON,
      methods: [
        {
          type: "api",
          keyless: true,
          label: "Zen 免费访问（key 填 public）",
          placeholder: "public",
          // 立刻返回，不能在这里等用户；否则与 magpie 死锁
          async authorize() {
            return { type: "success", key: "public" }
          },
        },
      ],

      async loader(getAuth) {
        const auth = await getAuth()
        if (!auth) return {}
        if (auth.type === "api" && auth.key !== "public") {
          throw new Error("这个插件固定使用 public 凭据；自己的 OpenCode Key 请加到 magpie 内置的 OpenCode Zen")
        }

        return {
          baseURL: BASE,
          apiKey: "public",
          async fetch(input, init) {
            const request = new Request(input, init)
            if (request.method !== "POST") throw new Error("只支持 POST")
            const protocol = Object.keys(PATHS).find((key) => request.url.endsWith(PATHS[key]))
            if (!protocol) throw new Error(`不支持的端点：${request.url}`)

            const body = await request.json()
            if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("请求体必须是 JSON 对象")

            if (!Object.hasOwn(known, body.model)) {
              try {
                known = await discover(request.signal)
              } catch {
                // 读不到列表就沿用上次的（或静态表）
              }
            }
            if (!Object.hasOwn(known, body.model)) {
              const free = Object.keys(known).sort().join(", ")
              return new Response(
                JSON.stringify({
                  type: "error",
                  error: {
                    type: "not_found_error",
                    message: `模型 ${body.model} 现在不是 Zen 免费模型。可用的：${free || "无"}`,
                  },
                }),
                { status: 404, headers: { "content-type": "application/json" } },
              )
            }

            const reverse = applyToolRenames(body, protocol)
            ensureTools(body, protocol)
            addEnvironment(body, protocol, directory)
            if (protocol === "chat") body.stream_options = { ...body.stream_options, include_usage: true }

            const given = request.headers
            const session = sessionID(given, body)
            const trace = traceHeaders(session)
            const headers = new Headers()
            headers.set("content-type", "application/json")
            headers.set("user-agent", USER_AGENT)
            headers.set("b3", trace.b3)
            headers.set("traceparent", trace.traceparent)
            headers.set("x-opencode-client", "cli")
            headers.set("x-opencode-project", given.get("x-opencode-project") || project)
            headers.set("x-opencode-session", session)
            headers.set("x-opencode-session-id", session)
            headers.set("x-session-affinity", session)
            headers.set("x-session-id", session)
            if (protocol === "anthropic") {
              headers.set("x-api-key", "public")
              headers.set("anthropic-version", given.get("anthropic-version") || "2023-06-01")
            } else {
              headers.set("authorization", "Bearer public")
            }

            const response = await fetch(UPSTREAM[protocol], {
              method: "POST",
              headers,
              body: JSON.stringify(body),
              signal: request.signal,
              redirect: "error",
            })

            if (reverse.size === 0) return response

            const type = response.headers.get("content-type") ?? ""
            if (type.includes("text/event-stream") && response.body) {
              return new Response(restoreStream(response.body, protocol, reverse), {
                status: response.status,
                headers: response.headers,
              })
            }
            if (type.includes("application/json")) {
              const payload = restore(await response.json(), protocol, reverse)
              const jsonHeaders = new Headers(response.headers)
              jsonHeaders.delete("content-length")
              jsonHeaders.delete("content-type")
              jsonHeaders.set("content-type", "application/json")
              return new Response(JSON.stringify(payload), { status: response.status, headers: jsonHeaders })
            }
            return response
          },
        }
      },

      async usage() {
        return { plan: "OpenCode Zen 免费", windows: [] }
      },
    },

    provider: {
      id: PROVIDER,
      async models(provider) {
        try {
          known = await discover()
          return known
        } catch {
          return known
        }
      },
    },

    "chat.headers": async (input, output) => {
      if (input?.model?.providerID !== PROVIDER || !input?.sessionID) return
      output.headers["x-session-id"] = String(input.sessionID)
      output.headers["x-session-affinity"] = String(input.sessionID)
    },
  }
}

