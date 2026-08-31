/**
 * dsh-qq-autoreply host half: DeepSeek Harness ↔ QQ AutoReply integration.
 *
 * Two directions:
 *   A) DSH session → AutoReply: registers model tools (qq_autoreply_*) that
 *      read/write AutoReply's REST API — status, config (DSH model / persona /
 *      engine rules), sessions, messages, reply logs, and a DSH model test-call.
 *   B) AutoReply → DSH: exposes /dsh-qq/health, /dsh-qq/execute and /dsh-qq/llm;
 *      DSH runtime is the only reply-generation path.
 */

export const name = 'dsh-qq-autoreply'
export const inject = ['webServer', 'tools', 'systemPrompt', 'llm', 'sessions', 'agents', 'agentPresets']

const DEFAULT_URL = process.env.AUTOREPLY_URL || 'http://127.0.0.1:8001'
const AUTOREPLY_KEY = process.env.AUTOREPLY_TOKEN || '' // Bearer token if AutoReply requires one (empty = open)

// ---- tiny JSON client for AutoReply REST ----
// 用 node:http 直连：DSH 进程环境带 ALL_PROXY=socks://127.0.0.1:7897（代理常未运行），
// 原生 fetch 会继承该代理导致 localhost 调用挂起；node:http 不读代理环境，直连可靠。
import { request as httpRequest } from 'node:http'
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'


function makeMessage(input) {
  return { ...input, id: crypto.randomUUID() }
}

const AUTOREPLY_DIR = process.env.AUTOREPLY_DIR || ' /home/user/Data/AutoReply'
const START_SCRIPT = process.env.AUTOREPLY_START_SCRIPT || `${AUTOREPLY_DIR}/scripts/start.sh`

// 一键服务控制：AutoReply 自带 scripts/start.sh 负责 NapCat(容器) + 后端(uvicorn)
// 的启动/停止，这里只负责调用脚本并等待后端就绪，然后打开/关闭总开关。
function runScript(args, timeoutMs) {
  return new Promise((resolve, reject) => {
    if (!existsSync(START_SCRIPT)) {
      return reject(new Error(`找不到 AutoReply 启动脚本: ${START_SCRIPT}`))
    }
    const child = spawn('bash', [START_SCRIPT, ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let out = ''
    let err = ''
    child.stdout.on('data', (d) => { out += d })
    child.stderr.on('data', (d) => { err += d })
    const timer = setTimeout(() => {
      child.kill()
      reject(new Error(`AutoReply 服务脚本超时(>${Math.round(timeoutMs / 1000)}s): ${(err || out).trim().slice(0, 400)}`))
    }, timeoutMs)
    child.on('error', (e) => {
      clearTimeout(timer)
      reject(new Error(`无法执行 AutoReply 服务脚本: ${e.message}`))
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (code === 0) {
        resolve(out.trim())
      } else {
        reject(new Error(`AutoReply 服务脚本退出码 ${code}: ${(err || out).trim().slice(0, 400)}`))
      }
    })
  })
}

async function waitForBackend(timeoutMs) {
  const deadline = Date.now() + timeoutMs
  let lastErr = ''
  while (Date.now() < deadline) {
    try {
      const st = await ar('GET', '/api/status')
      if (st && typeof st === 'object' && st.onebot_connected !== undefined) return st
    } catch (e) {
      lastErr = e && e.message || String(e)
    }
    await new Promise((r) => setTimeout(r, 2000))
  }
  throw new Error(`等待 AutoReply 后端就绪超时: ${lastErr || 'unknown'}`)
}

async function runServiceControl(args) {
  const action = (args && args.action) || 'start'
  if (action !== 'start' && action !== 'stop' && action !== 'restart') {
    throw new Error('action 需要是 start、stop 或 restart')
  }

  if (action === 'start') {
    let backendUp = false
    try {
      const st = await ar('GET', '/api/status')
      backendUp = !!(st && st.onebot_connected !== undefined)
    } catch { /* 后端未运行，走启动脚本 */ }

    if (!backendUp) {
      await runScript(['--bg'], 120_000)
    }
    const st = await waitForBackend(60_000)
    await ar('POST', '/api/config', { path: 'engine.master_switch', value: true })
    const after = await ar('GET', '/api/status')
    return {
      action,
      started_backend: !backendUp,
      master_switch: true,
      note: backendUp
        ? 'AutoReply 后端已在运行，总开关已打开'
        : 'NapCat 与 AutoReply 后端已启动，总开关已打开',
      status: after,
    }
  }

  if (action === 'restart') {
    try {
      await ar('POST', '/api/config', { path: 'engine.master_switch', value: false })
    } catch { /* 后端可能已停止，继续 */ }
    try {
      await runScript(['--stop'], 30_000)
    } catch { /* 停止失败不阻断重启 */ }
    await runScript(['--bg'], 120_000)
    await waitForBackend(60_000)
    await ar('POST', '/api/config', { path: 'engine.master_switch', value: true })
    const after = await ar('GET', '/api/status')
    return {
      action,
      master_switch: true,
      backend_stopped: false,
      note: 'AutoReply 后端已重启，总开关已打开',
      status: after,
    }
  }

  try {
    await ar('POST', '/api/config', { path: 'engine.master_switch', value: false })
  } catch { /* 后端可能已停止，继续 */ }
  try {
    await runScript(['--stop'], 30_000)
    return {
      action: 'stop',
      master_switch: false,
      backend_stopped: true,
      note: '自动回复已停止（NapCat 容器保持运行，登录态不丢）',
      status: null,
    }
  } catch (e) {
    return {
      action: 'stop',
      master_switch: false,
      backend_stopped: false,
      note: `总开关已关闭，但停止后端失败: ${e.message}`,
      status: null,
    }
  }
}

function ar(method, path, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(DEFAULT_URL + path)
    const headers = { 'Content-Type': 'application/json' }
    if (AUTOREPLY_KEY) headers.Authorization = 'Bearer ' + AUTOREPLY_KEY
    if (body !== undefined) headers['Content-Length'] = Buffer.byteLength(JSON.stringify(body))
    const req = httpRequest(
      {
        hostname: url.hostname,
        port: url.port || 80,
        path: url.pathname + url.search,
        method,
        headers,
        timeout: 6000,
      },
      (res) => {
        let data = ''
        res.on('data', (c) => { data += c })
        res.on('end', () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            try { resolve(JSON.parse(data || '{}')) } catch { resolve({}) }
          } else {
            reject(new Error(`AutoReply ${method} ${path} -> HTTP ${res.statusCode}: ${data.slice(0, 200)}`))
          }
        })
      },
    )
    req.on('timeout', () => req.destroy(new Error('AutoReply 请求超时')))
    req.on('error', (e) => reject(new Error(`AutoReply 不可达: ${e.message}`)))
    if (body !== undefined) req.write(JSON.stringify(body))
    req.end()
  })
}

// ---- route handlers ----
async function handleHealth() {
  // 轻量探测：不递归调用 AutoReply（AutoReply 的 /api/status 又 probe 本端点，
  // 若这里 await AutoReply 会形成 3s+ 的环路延迟）。只做 TCP 级探测（可选），
  // 默认即返回在线。
  try {
    return { ok: true, autoreply: true, plugin: 'dsh-qq-autoreply' }
  } catch (e) {
    return { ok: false, autoreply: false, error: String(e && e.message || e) }
  }
}

async function handleExecute(body) {
  const tool = body && body.tool
  const args = (body && body.args) || {}
  if (!tool) return { ok: false, error: 'missing tool' }
  try {
    const result = await runTool(tool, args)
    return { ok: true, tool, result }
  } catch (e) {
    return { ok: false, tool, error: String(e && e.message || e) }
  }
}

async function handlePersona() {
  try {
    const cfg = await ar('GET', '/api/config')
    const p = (cfg.config && cfg.config.persona) || {}
    return { ok: true, persona: { name: p.name || '', system_prompt: p.system_prompt || '' } }
  } catch (e) {
    return { ok: false, error: String(e && e.message || e) }
  }
}
async function handleDshLlm(ctx, body) {
  if (!ctx.llm) throw new Error('DSH llm 服务未挂载，请检查 profile 是否包含 LLM runtime')
  const provider = String(body.provider || '')
  const model = String(body.model || '')
  if (!provider || !model || !Array.isArray(body.messages)) throw new Error('provider/model/messages required')
  const messages = body.messages.map((m) => makeMessage({
    role: m.role === 'assistant' ? 'assistant' : m.role === 'system' ? 'system' : 'user',
    content: [{ type: 'text', text: String(m.content || '') }],
    source: m.role === 'assistant' ? { kind: 'model', provider, model } : { kind: m.role === 'system' ? 'plugin' : 'user', ...(m.role === 'system' ? { plugin: 'dsh-qq-autoreply' } : {}) },
  }))
  let text = ''
  for await (const chunk of ctx.llm.stream({ provider, model, messages,
    temperature: body.temperature, maxTokens: body.max_tokens })) {
    if (chunk.type === 'text-delta') text += chunk.text || ''
  }
  return { provider, model, content: text }
}


async function runSessionTurn(ctx, body) {
  const sessionId = String(body.session_id || '')
  const text = String(body.text || '')
  const provider = String(body.provider || '')
  const model = String(body.model || '')
  if (!sessionId || !text || !provider || !model) throw new Error('session_id/text/provider/model required')
  const session = ctx.sessions.get(sessionId)
  if (!session && !ctx.agents) throw new Error(`DSH Session 不存在: ${sessionId}`)
  if (ctx.agents) {
    let agent = ctx.agents.get(sessionId)
    if (!agent) {
      const setup = ctx.agentPresets ? async (agentCtx) => { await ctx.agentPresets.mount(agentCtx, body.agent_preset || undefined) } : undefined
      const handle = session
        ? await ctx.agents.resume({ resumeSessionId: sessionId, agentOptions: { provider, model, maxTokens: body.max_tokens }, setup })
        : await ctx.agents.create({ sessionId, meta: { cwd: body.workspace_id || undefined, agentPreset: body.agent_preset || undefined }, agentOptions: { provider, model, maxTokens: body.max_tokens }, setup })
      agent = handle.agent
    }
    agent.inject(makeMessage({ role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } }))
    await agent.whenIdle()
    const messages = agent.session.deriveMessages()
    const last = [...messages].reverse().find((message) => message.role === 'assistant')
    return { provider, model, session_id: sessionId, content: last ? last.content.map((part) => part.type === 'text' ? part.text : '').join('') : '' }
  }
  const userMessage = makeMessage({ role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } })
  const userEvent = session.append('user/message', userMessage, { surfaceOp: 'append', sourceEventSeqs: [] })
  let content = ''
  for await (const chunk of ctx.llm.stream({ provider, model, messages: session.deriveMessages(),
    temperature: body.temperature, maxTokens: body.max_tokens })) {
    if (chunk.type === 'text-delta') content += chunk.text || ''
  }
  const assistantMessage = makeMessage({ role: 'assistant', content: [{ type: 'text', text: content }], source: { kind: 'model', provider, model } })
  session.append('assistant/message', { message: assistantMessage }, { surfaceOp: 'append', sourceEventSeqs: [userEvent.seq] })
  await ctx.sessions.flush(session)
  return { provider, model, session_id: sessionId, content }
}

async function handleDshSession(ctx, body) {
  if (!ctx.sessions) throw new Error('DSH sessions 服务未挂载，请检查 profile 是否包含 Session runtime')
  const action = body.action || 'list'
  if (action === 'list') return { sessions: ctx.sessions.list().map((s) => ({ id: s.id, cwd: s.header.cwd, createdAt: s.header.createdAt })) }
  if (action === 'create') {
    if (ctx.agents) {
      const setup = ctx.agentPresets ? async (agentCtx) => { await ctx.agentPresets.mount(agentCtx, body.agent_preset || undefined) } : undefined
      const handle = await ctx.agents.create({ sessionId: body.id || `qqa-${Date.now()}`, meta: { cwd: body.workspace_id || undefined, agentPreset: body.agent_preset || undefined }, agentOptions: { provider: body.provider || undefined, model: body.model || undefined, maxTokens: body.max_tokens }, setup })
      const session = handle.agent.session
      return { session: { id: session.id, cwd: session.header.cwd, createdAt: session.header.createdAt } }
    }
    const session = ctx.sessions.create(body.id || undefined, { meta: { source: 'qq-autoreply', chatKey: body.chat_key || '' } })
    await ctx.sessions.flush(session)
    return { session: { id: session.id, cwd: session.header.cwd, createdAt: session.header.createdAt } }
  }
  if (action === 'chat') {
    const session = ctx.sessions.get(body.session_id)
    if (!session) throw new Error(`DSH Session 不存在: ${body.session_id || ''}`)
    return await runSessionTurn(ctx, body)
  }
  if (action === 'get') {
    const session = ctx.sessions.get(body.id)
    return { session: session ? { id: session.id, cwd: session.header.cwd, createdAt: session.header.createdAt } : null }
  }
  throw new Error(`unknown session action: ${action}`)
}


function toolsFromPreset(content) {
  const text = typeof content === 'string' ? content : JSON.stringify(content || {})
  const ids = [...text.matchAll(/^\s*-?\s*id:\s*([A-Za-z0-9_.-]+)/gm)].map((m) => m[1])
  return ids.filter((id) => id.startsWith('tool-') || id.startsWith('skill-')).map((id) => ({ id }))
}
// ---- tool executors (used both by model tools and /dsh-qq/execute) ----
async function runTool(tool, args) {
  switch (tool) {
    case 'status': case 'qq_autoreply_status': {
      return await ar('GET', '/api/status')
    }
    case 'config_get': case 'qq_autoreply_config_get': {
      return await ar('GET', '/api/config')
    }
    case 'config_set': case 'qq_autoreply_config_set': {
      if (!args) throw new Error('需要参数：path+value 或 batch')
      if (args.path !== undefined && args.path !== null && args.path !== '') {
        return await ar('POST', '/api/config', { path: args.path, value: args.value })
      }
      if (args.batch && typeof args.batch === 'object') {
        return await ar('POST', '/api/config', { batch: args.batch })
      }
      throw new Error('需要 path+value 或 batch')
    }
    case 'sessions': case 'qq_autoreply_sessions': {
      const limit = args && args.limit ? args.limit : 50
      return await ar('GET', `/api/sessions?limit=${limit}`)
    }
    case 'messages': case 'qq_autoreply_messages': {
      if (!args || !args.chat_key) throw new Error('需要 chat_key')
      const limit = args.limit || 100
      return await ar('GET', `/api/messages?chat_key=${encodeURIComponent(args.chat_key)}&limit=${limit}`)
    }
    case 'logs': case 'qq_autoreply_logs': {
      const decision = args && args.decision ? `&decision=${encodeURIComponent(args.decision)}` : ''
      const limit = args && args.limit ? args.limit : 50
      return await ar('GET', `/api/logs?limit=${limit}${decision}`)
    }
    case 'session_binding': case 'qq_autoreply_session_binding': {
      if (!args || !args.chat_key) throw new Error('需要 chat_key')
      const patch = { ...args }
      delete patch.chat_key
      return await ar('PATCH', '/api/sessions/binding', { chat_key: args.chat_key, ...patch })
    }
    case 'agent_info': case 'qq_autoreply_agent_info': {
      if (!args || !args.agent_preset) throw new Error('需要 agent_preset')
      const cfg = await ar('GET', '/api/config')
      const c = (cfg.config && cfg.config.engine && cfg.config.engine.dsh) || {}
      return {
        agent_preset: args.agent_preset,
        reply_tools: c.reply_tools || [],
        tools: toolsFromPreset(args.preset_content),
      }
    }
    case 'test_llm': case 'qq_autoreply_test_llm': {
      return await ar('POST', '/api/config/test_llm', {})
    }
    case 'service_control': case 'qq_autoreply_service_control': {
      return await runServiceControl(args || {})
    }
    // 回复增强工具：供 AutoReply 引擎在生成回复前调用，获取「账号视角」的
    // 当前状态摘要（连接/开关/今日统计）作为上下文增强。
    case 'reply_knowledge': case 'qq_reply_knowledge': {
      const st = await ar('GET', '/api/status')
      return {
        摘要: {
          连接: st.onebot_connected ? '在线' : '离线',
          登录: st.onebot_login ? '已登录' : '未登录',
          总开关: st.master_switch ? '开' : '关',
        },
        今日统计: st.stats || {},
      }
    }
    default:
      throw new Error(`未知工具: ${tool}`)
  }
}

// ---- model tools ----
const tl = (name, description, properties, render) => ({
  name, description, parameters: { type: 'object', additionalProperties: false, properties },
  output: {
    schema: { type: 'object', additionalProperties: false, properties: { text: { type: 'string' } } },
    render(_args, value) {
      const text = (value && value.text) || JSON.stringify(value || {}, null, 2)
      return [{ type: 'text', text: String(text).slice(0, 4000) }]
    },
  },
  async execute(args) {
    const result = await runTool(name.replace(/^qq_autoreply_/, ''), args || {})
    return { text: JSON.stringify(result, null, 2) }
  },
})

const tools = [
  tl('qq_autoreply_status', '查看 QQ AutoReply 运行状态：OneBot 连接 / QQ 登录 / LLM 配置 / 总开关 / 今日统计 / DSH 接入状态。', {}),
  tl('qq_autoreply_config_get', '读取 QQ AutoReply 完整配置（LLM / 人设 persona / 触发规则 engine / 黑白名单 / DSH 接入）。', {}),
  tl('qq_autoreply_config_set', '修改 QQ AutoReply 配置项（立即生效）。参数 path 支持点路径，如 llm.provider、llm.model、persona.name、persona.system_prompt、engine.master_switch、engine.group_mode、engine.whitelist.friends、engine.dsh.enabled 等；或传 batch 对象一次改多项。配置保存在本机 SQLite。', {
    path: { type: 'string', description: '配置项点路径，如 persona.system_prompt' },
    value: { type: 'string', description: '新值（字符串/布尔/数字均可，按字段类型解析）' },
    batch: { type: 'object', description: '一次改多项的映射 {path: value}' },
  }),
  tl('qq_autoreply_sessions', '列出 QQ AutoReply 的会话列表（按最近活跃排序，含最后一条消息）。', {
    limit: { type: 'integer', description: '返回条数，默认 50' },
  }),
  tl('qq_autoreply_messages', '读取某个 QQ 会话的消息历史（chat_key 形如 friend:<qq> 或 group:<gid>）。', {
    chat_key: { type: 'string', description: '会话键，如 friend:29300000001 或 group:123456' },
    limit: { type: 'integer', description: '条数，默认 100' },
  }),
  tl('qq_autoreply_logs', '查看 QQ AutoReply 的回复决策日志（含 AI 输出/原因/耗时，可按决策类型筛选）。', {
    decision: { type: 'string', enum: ['answered', 'skipped', 'blocked', 'failed'], description: '按决策类型筛选，可选' },
    limit: { type: 'integer', description: '条数，默认 50' },
  }),
  tl('qq_autoreply_test_llm', '测试 AutoReply 的 LLM 连接是否可用（返回模型名与示例回复）。', {}),
    tl('qq_autoreply_session_binding', '为指定 QQ 会话绑定或更新 Agent、模型、Workspace、会话目录和 DSH Session。传入空字符串可清除绑定字段。', {
      chat_key: { type: 'string', description: '好友或群会话键' },
      agent_preset: { type: 'string' },
      model_provider: { type: 'string' },
      model_name: { type: 'string' },
      workspace_dir: { type: 'string' },
      session_dir: { type: 'string' },
      dsh_session_id: { type: 'string' },
    }),
tl('qq_autoreply_agent_info', '读取 Agent preset 的工具清单和当前 AutoReply 工具白名单。', {
      agent_preset: { type: 'string' },
      preset_content: { type: 'string' },
    }),

  tl('qq_autoreply_service_control', '一键启动/停止/重启 QQ AutoReply 全部服务：start 会确保 NapCat 容器与 AutoReply 后端(:8001) 运行并打开总开关；stop 会关闭总开关并停止后端（NapCat 容器保持运行）；restart 会重启后端。', {
    action: { type: 'string', enum: ['start', 'stop', 'restart'], description: 'start=启动全部服务，stop=停止自动回复，restart=重启后端' },
  }),
]

export function apply(ctx) {
  // ---- HTTP 路由：AutoReply → DSH ----
  ctx.webServer.register({
    kind: 'prefix',
    path: '/dsh-qq',
    handler: async (req, res) => {
      const url = new URL(req.url, 'http://localhost')
      const send = (code, obj) => {
        res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify(obj))
      }
      try {
        if (url.pathname === '/dsh-qq/health') {
          send(200, await handleHealth())
        } else if (url.pathname === '/dsh-qq/execute') {
          if (req.method !== 'POST') return send(405, { ok: false, error: 'POST only' })
          let body = {}
          const chunks = []
          for await (const c of req) chunks.push(c)
          try { body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') } catch { /* ignore */ }
          send(200, await handleExecute(body))
        } else if (url.pathname === '/dsh-qq/persona') {
          send(200, await handlePersona())
        } else if (url.pathname === '/dsh-qq/llm' || url.pathname === '/dsh-qq/session') {
          if (req.method !== 'POST') return send(405, { ok: false, error: 'POST only' })
          const chunks = []
          for await (const c of req) chunks.push(c)
          let body = {}
          try { body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') } catch { return send(400, { ok: false, error: 'invalid JSON' }) }
          const result = url.pathname.endsWith('/llm') ? await handleDshLlm(ctx, body) : await handleDshSession(ctx, body)
          send(200, { ok: true, result })
        } else {
          send(404, { ok: false, error: 'not found' })
        }
      } catch (e) {
        send(500, { ok: false, error: String(e && e.message || e) })
      }
    },
  }, 'qq-autoreply: routes')

  // ---- model tools ----
  for (const tool of tools) {
    ctx.effect(() => ctx.tools.register(tool), `qq-autoreply: ${tool.name} tool`)
  }

  // ---- system prompt hint ----
  ctx.systemPrompt.section({
    name: 'tool:qq-autoreply', order: 200,
    text: '本机已挂载 QQ AutoReply 互通插件：可用 qq_autoreply_service_control 一键启动/停止全部服务（NapCat + AutoReply 后端 + 总开关）；用 qq_autoreply_status / qq_autoreply_config_get / qq_autoreply_config_set / qq_autoreply_sessions / qq_autoreply_messages / qq_autoreply_logs / qq_autoreply_test_llm 工具查看与修改本地 QQ 自动回复服务（配置改动立即生效，存储在 AutoReply 的 SQLite 覆盖层）。修改人设用 config_set(path="persona.system_prompt")；选择 DSH 模型用 config_set(path="llm.model")。',
  })
}
