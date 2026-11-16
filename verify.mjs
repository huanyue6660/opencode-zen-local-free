// 自检脚本（不随插件安装）：node verify.mjs
//
// 1. 加载插件，确认只导出一个函数
// 2. 用假 fetch 捕获「发往 Zen 的真实请求」，逐项断言
// 3. 断言回复里的工具名被改回原名
//
// 全程不联网：fetch 被替换成一个记录器。

import assert from "node:assert/strict"
import { ZenFreeLitePlugin } from "./index.mjs"

const captured = []
let reply = () => Response.json({ ok: true })

globalThis.fetch = async (input, init = {}) => {
  const url = typeof input === "string" ? input : String(input?.url ?? input)
  captured.push({ url, init, headers: new Headers(init.headers ?? {}) })
  return reply()
}

const plugin = await ZenFreeLitePlugin({ directory: process.cwd() })
assert.equal(plugin.auth.provider, "zen-free-lite")
assert.equal(typeof plugin.config, "function")
assert.equal(typeof plugin.provider.models, "function")
assert.equal(typeof plugin["chat.headers"], "function")

const getAuth = async () => ({ type: "api", key: "public" })
const { fetch: send, baseURL } = await plugin.auth.loader(getAuth)
assert.equal(baseURL, "https://opencode.ai/inference/v1")

// ── 一次 chat 请求：无 <env>、工具里有被禁的 run_terminal_cmd ──────────
const body = {
  model: "big-pickle",
  stream: true,
  messages: [
    { role: "system", content: "You are a coding agent." },
    { role: "user", content: "list files" },
  ],
  tools: [
    {
      type: "function",
      function: {
        name: "run_terminal_cmd",
        description: "run a command",
        parameters: { type: "object", properties: { command: { type: "string" } } },
      },
    },
    {
      type: "function",
      function: {
        name: "edit",
        description: "Edit an existing UTF-8 text file by replacing literal text.",
        parameters: {
          type: "object",
          properties: {
            file_path: { type: "string" },
            old_string: { type: "string" },
            new_string: { type: "string" },
          },
          required: ["file_path", "old_string", "new_string"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "read",
        description: "Read a UTF-8 text file and return line-numbered content.",
        parameters: {
          type: "object",
          properties: {
            file_path: { type: "string" },
            offset: { type: "number" },
            limit: { type: "number" },
          },
          required: ["file_path"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "skill",
        description:
          "Load the full instructions for a skill. Call it before acting on a task that names or clearly matches a skill in the session skill catalog.",
        parameters: {
          type: "object",
          properties: { name: { type: "string" } },
          required: ["name"],
        },
      },
    },
  ],
}

const request = new Request(`${baseURL}/chat/completions`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
})

const response = await send(request)
assert.equal(captured.length, 1, "应该只有一个上游请求")

const sent = captured[0]
const outBody = JSON.parse(sent.init.body)

// 1) 端点
assert.equal(sent.url, "https://opencode.ai/inference/openai/v1/chat/completions")

// 2) 身份头
const h = (name) => sent.headers.get(name)
assert.equal(h("authorization"), "Bearer public")
assert.match(h("user-agent"), /^opencode\/latest\/[\d.]+\/cli$/)
assert.equal(h("x-opencode-client"), "cli")
assert.match(h("x-opencode-project"), /^[0-9a-f]{40}$/)
assert.match(h("x-opencode-session"), /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/)
assert.equal(h("x-session-affinity"), h("x-opencode-session"))
assert.match(h("traceparent"), /^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/)
assert.match(h("b3"), /^[0-9a-f]{32}-[0-9a-f]{16}-1-[0-9a-f]{16}$/)

// 3) system 里有 <env> 块，且带真实工作目录
const systemText = outBody.messages
  .filter((m) => m.role === "system")
  .map((m) => m.content)
  .join("\n")
assert.match(systemText, /<env>/)
assert.match(systemText, new RegExp(`Working directory: ${process.cwd().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`))
assert.match(systemText, /<\/env>/)
assert.equal(outBody.messages[0].content, "You are a coding agent.", "不要把 env 抢到 agent 提示词前面")

// 4) 五个核心工具都在，且被禁的名字已改名
const names = outBody.tools.map((t) => t.function.name)
for (const core of ["edit", "glob", "grep", "read", "shell"]) assert.ok(names.includes(core), `缺少核心工具 ${core}`)
assert.ok(names.includes("run_console_cmd"), `应改名为 run_console_cmd，实际：${names.join(",")}`)
assert.ok(!names.includes("run_terminal_cmd"), "原名不应再出现")

// 4b) 核心工具用 OpenCode 2 的形状：edit/read 的第一参数是 path，不是 file_path
const coreEdit = outBody.tools.find((tool) => tool.function.name === "edit")
const coreRead = outBody.tools.find((tool) => tool.function.name === "read")
assert.equal(coreEdit?.function.description, "Not available. Never call this tool.")
assert.equal(coreEdit?.function.strict, false)
assert.ok(coreEdit?.function.parameters.properties.path, "核心 edit 应以 path 为参数")
assert.ok(!coreEdit?.function.parameters.properties.file_path, "核心 edit 不应再用 file_path")
assert.ok(coreRead?.function.parameters.properties.path, "核心 read 应以 path 为参数")
assert.ok(!coreRead?.function.parameters.properties.file_path, "核心 read 不应再用 file_path")

// 4c) DSH 的 edit/read 改名，核心 edit/read 仍要补回原名旁边
assert.ok(names.includes("text_replace"), `DSH edit 应改名为 text_replace，实际：${names.join(",")}`)
assert.ok(names.includes("file_view"), `DSH read 应改名为 file_view，实际：${names.join(",")}`)
assert.equal(names.filter((name) => name === "edit").length, 1, "edit 应只剩核心 stand-in")
assert.equal(names.filter((name) => name === "read").length, 1, "read 应只剩核心 stand-in")
const servedEdit = outBody.tools.find((tool) => tool.function.name === "text_replace")
const servedRead = outBody.tools.find((tool) => tool.function.name === "file_view")
assert.equal(servedEdit?.function.description, "Replace an exact piece of text in a UTF-8 file that already exists.")
assert.equal(servedRead?.function.description, "Read a UTF-8 text file. Each line comes back with its number.")
assert.ok(servedEdit?.function.parameters.properties.file_path, "text_replace 应保留 DSH 的 file_path 参数")
assert.ok(servedRead?.function.parameters.properties.file_path, "file_view 应保留 DSH 的 file_path 参数")
const skill = outBody.tools.find((tool) => tool.function.name === "skill")
assert.equal(
  skill?.function.description,
  "Open a skill's whole instructions. Use it first when a task names a skill from the session's skill catalog, or plainly fits one.",
)
assert.ok(
  !outBody.tools.some((tool) => String(tool.function.description).startsWith("Edit an existing UTF-8 text file")),
  "被拒的 edit 描述不应原样发出",
)

// 5) usage 汇总
assert.equal(outBody.stream_options.include_usage, true)

// ── 回复里的工具名要改回原名 ──────────────────────────────────────────
reply = () =>
  new Response(
    [
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"run_console_cmd","arguments":"{\\"command\\":\\"ls\\"}"}}]}}]}',
      "",
      "data: [DONE]",
      "",
    ].join("\n"),
    { headers: { "content-type": "text/event-stream" } },
  )

captured.length = 0
const streamed = await send(
  new Request(`${baseURL}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }),
)
const text = await streamed.text()
assert.match(text, /"name":"run_terminal_cmd"/, "回复里的工具名应改回原名")
assert.ok(!text.includes("run_console_cmd"), "改名后的名字不应漏给 agent")

// ── 非免费模型：本地 404，且不发上游 ────────────────────────────────────
captured.length = 0
const blocked = await send(
  new Request(`${baseURL}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...body, model: "claude-opus-5" }),
  }),
)
assert.equal(blocked.status, 404)
// 本地 404：只会去拉一次模型列表，绝不把这次推理发到上游
assert.ok(
  captured.every((call) => call.url.endsWith("/models")),
  `非免费模型不该走推理端点，实际：${captured.map((c) => c.url).join(", ")}`,
)

console.log("✓ 全部断言通过")
console.log(`  上游 URL      ${sent.url}`)
console.log(`  UA            ${h("user-agent")}`)
console.log(`  project id    ${h("x-opencode-project")}`)
console.log(`  工具名         ${names.join(", ")}`)