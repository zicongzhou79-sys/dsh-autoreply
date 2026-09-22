/**
 * dsh-qq-autoreply host half: DeepSeek Harness ↔ QQ AutoReply integration.
 *
 * Two directions:
 *   A) DSH session → AutoReply: registers model tools (qq_autoreply_*) that
 *      read/write AutoReply's REST API — status, config (DSH model / persona /
 *      engine rules), sessions, messages, reply logs, and a DSH model test-call.
 *   B) AutoReply → DSH: exposes /dsh-qq/health, /dsh-qq/execute and /dsh-qq/session;
 *      DSH Agent 是唯一回复运行时。
 */

export const name = 'dsh-qq-autoreply'
export const inject = ['webServer', 'tools', 'systemPrompt', 'sessions', 'agents', 'agentPresets', 'workspaceRegistry', 'attachments']

const DEFAULT_URL = process.env.AUTOREPLY_URL || 'http://127.0.0.1:8001'
const AUTOREPLY_KEY = process.env.AUTOREPLY_TOKEN || '' // Bearer token if AutoReply requires one (empty = open)

// DSH Agent 的 cwd 必须始终存在；未绑定 workspace 时回退到 DSH 启动目录，
// 避免 preset 中的 {{cwd}} 变量无值导致装配错误。
const resolveCwd = (workspaceId) => String(workspaceId || process.cwd() || '').trim()
// ---- tiny JSON client for AutoReply REST ----
// 用 node:http 直连：DSH 进程环境带 ALL_PROXY=socks://127.0.0.1:7897（代理常未运行），
// 原生 fetch 会继承该代理导致 localhost 调用挂起；node:http 不读代理环境，直连可靠。
import { request as httpRequest } from 'node:http'
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'

// @deepseek-ai/dsh-attachment 由 DSH 运行环境提供。本插件以 pnpm `link:` 方式装在
// profile 之外（integrations/dsh-qq-autoreply），harness 包不在它的解析路径上：一旦
// 插件 node_modules 里的链接被 prune，静态 import 会让整个插件在加载期直接失败
// （boot 报 Cannot find package，热挂载失败后退化为重启）。因此改为可选加载，
// 解析不到时退回 attachments.saveImages 这一公共 API，图片准入语义保持一致。
let admitEncodedImages = null
try {
  ({ admitEncodedImages } = await import('@deepseek-ai/dsh-attachment'))
} catch {
  admitEncodedImages = null
}


function makeMessage(input) {
  return { ...input, id: crypto.randomUUID() }
}

const AUTOREPLY_DIR = process.env.AUTOREPLY_DIR || process.cwd()
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

// ============================================================
// B 方案：Compose 托管生命周期（AUTOREPLY_PROVIDER=compose 启用）
//
// 插件自管 AutoReply 栈：生成 compose.yml + NapCat 配置到供给目录
// （默认 ~/.dsh/qq-autoreply/），token 自动生成并与后端/NapCat 同值
// 注入，免去手工对齐。external 模式（默认）保持原有 start.sh 行为。
// ============================================================
import { randomBytes } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import os from 'node:os'

const COMPOSE_DIR = process.env.AUTOREPLY_COMPOSE_DIR || join(os.homedir(), '.dsh', 'qq-autoreply')
const DEFAULT_BACKEND_IMAGE = process.env.AUTOREPLY_IMAGE || 'qq-autoreply-backend:latest'
const DEFAULT_NAPCAT_IMAGE = process.env.AUTOREPLY_NAPCAT_IMAGE || 'mlikiowa/napcat-docker:v4.3.5'
const DEFAULT_BACKEND_PORT = process.env.AUTOREPLY_BACKEND_PORT || '8001' // 宿主侧发布端口
const DEFAULT_WEBUI_PORT = process.env.AUTOREPLY_WEBUI_PORT || '6099'
const COMPOSE_PROJECT = process.env.AUTOREPLY_COMPOSE_PROJECT || 'qq-autoreply'

/**
 * Provider 解析：显式环境变量优先；未设置时「供给目录已存在 → compose」。
 * 迁移完成后（provision.json 存在）无需改任何环境变量，重启 DSH 即自动
 * 切到托管模式，避免 external 的 start.sh 与 compose 栈抢 8001 端口。
 */
export function resolveProvider(explicit, provisionFileExists) {
  const e = String(explicit || '').toLowerCase().trim()
  if (e === 'compose' || e === 'external') return e
  return provisionFileExists ? 'compose' : 'external'
}

const PROVIDER = resolveProvider(process.env.AUTOREPLY_PROVIDER, existsSync(join(COMPOSE_DIR, 'provision.json')))

/** compose 栈服务状态（docker compose ps --format json，兼容数组/JSONL 两种输出）。 */
async function composeServiceStates() {
  try {
    const out = await runCompose(['ps', '--format', 'json'], 20_000)
    const lines = out.trim().split('\n').filter(Boolean)
    const parsed = out.trim().startsWith('[')
      ? JSON.parse(out)
      : lines.map((l) => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
    return parsed.map((o) => ({
      service: o.Service || o.Name || '',
      state: o.State || '',
      health: o.Health || '',
    }))
  } catch {
    return []
  }
}

/** /dsh-qq/compose：托管模式状态 + 供给信息（面板「托管与安装」区数据源）。 */
async function handleComposeStatus() {
  if (PROVIDER !== 'compose') {
    return { ok: false, provider: PROVIDER, note: 'external 模式；存在 ~/.dsh/qq-autoreply/provision.json 时重启 DSH 自动切 compose' }
  }
  let provision = {}
  try { provision = JSON.parse(readFileSync(provisionPath(), 'utf8')) } catch { /* 无供给文件 */ }
  const services = await composeServiceStates()
  const webuiPort = provision.webui_port || DEFAULT_WEBUI_PORT
  return {
    ok: true,
    provider: 'compose',
    project: provision.project || COMPOSE_PROJECT,
    compose_dir: COMPOSE_DIR,
    account: provision.account || '',
    backend_port: provision.backend_port || DEFAULT_BACKEND_PORT,
    webui_port: webuiPort,
    webui_token: provision.webui_token || '',
    webui_url: `http://127.0.0.1:${webuiPort}/webui/`,
    services,
    // 安装体检：能走到这里 = docker/compose 可用 + 供给完整
    checks: {
      docker: true,
      compose_file: existsSync(composeFilePath()),
      provision: Boolean(provision.onebot_token),
      token_aligned: Boolean(provision.onebot_token),
    },
  }
}

const provisionPath = () => join(COMPOSE_DIR, 'provision.json')
const composeFilePath = () => join(COMPOSE_DIR, 'compose.yml')

function hexToken() {
  return randomBytes(16).toString('hex')
}

/** 执行 docker compose 子命令（cwd=供给目录，自动读取该目录 .env）。 */
function runCompose(args, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn('docker', ['compose', ...args], {
      cwd: COMPOSE_DIR,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let out = ''
    let err = ''
    child.stdout.on('data', (d) => { out += d })
    child.stderr.on('data', (d) => { err += d })
    const timer = setTimeout(() => {
      child.kill()
      reject(new Error(`docker compose ${args.join(' ')} 超时(>${Math.round(timeoutMs / 1000)}s): ${(err || out).trim().slice(0, 300)}`))
    }, timeoutMs)
    child.on('error', (e) => {
      clearTimeout(timer)
      reject(new Error(`无法执行 docker compose: ${e.message}（请确认已安装 Docker）`))
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (code === 0) resolve(out.trim())
      else reject(new Error(`docker compose ${args.join(' ')} 退出码 ${code}: ${(err || out).trim().slice(0, 300)}`))
    })
  })
}

/** NapCat onebot11 配置：反向 WS 指向 compose 网络内的 backend 服务。 */
function renderOnebot11(onebotToken) {
  return JSON.stringify({
    network: {
      httpServers: [],
      httpSseServers: [],
      httpClients: [],
      websocketServers: [],
      websocketClients: [{
        name: 'qq-auto-reply',
        enable: true,
        url: 'ws://backend:8001/onebot/ws',
        messagePostFormat: 'array',
        reportSelfMessage: true,
        reconnectInterval: 5000,
        token: onebotToken,
        debug: false,
        heartInterval: 30000,
        type: 'WebSocket 客户端',
      }],
    },
    musicSignUrl: '',
    enableLocalFile2Url: false,
    parseMultMsg: false,
  }, null, 2) + '\n'
}

function renderWebui(webuiToken) {
  return JSON.stringify({
    host: '0.0.0.0',
    prefix: '/webui',
    port: 6099,
    token: webuiToken,
    loginRate: 3,
  }, null, 2) + '\n'
}

// compose.yml 模板版本：结构变更时递增，ensureProvisioned 检测到旧版会重生成
const COMPOSE_TEMPLATE_VERSION = 4

function renderComposeYml() {
  return `# qqa-template: ${COMPOSE_TEMPLATE_VERSION}
name: \${COMPOSE_PROJECT:-qq-autoreply}

services:
  backend:
    image: \${BACKEND_IMAGE}
    container_name: \${COMPOSE_PROJECT}-backend
    restart: unless-stopped
    # 与宿主共享 netns：DSH web 只听 127.0.0.1:3080，host 网络下天然可达；
    # uvicorn 直接监听宿主 0.0.0.0:8001（与 external 模式暴露面一致）
    network_mode: host
    environment:
      TZ: \${TZ:-Asia/Shanghai}
      AUTOREPLY_ONEBOT_TOKEN: \${ONEBOT_TOKEN}
      # host 网络下 127.0.0.1 即宿主回环；保留覆盖入口以兼容特殊部署
      AUTOREPLY_DSH_BASE_URL: \${DSH_BASE_URL:-http://127.0.0.1:3080}
    volumes:
      - backend-data:/data
      # 工作区/会话目录路径对等挂载（宿主路径 = 容器路径），保留每会话
      # 目录能力；未配置时挂载占位目录，无副作用
      - \${WORKSPACE_DIR:-/tmp/qq-autoreply-unused}:\${WORKSPACE_DIR:-/tmp/qq-autoreply-unused}:rw
      - \${SESSION_DIR:-/tmp/qq-autoreply-unused}:\${SESSION_DIR:-/tmp/qq-autoreply-unused}:rw
    healthcheck:
      test: ["CMD", "python", "-c", "import urllib.request as u; u.urlopen('http://127.0.0.1:8001/api/status', timeout=3)"]
      interval: 10s
      timeout: 5s
      retries: 6
      start_period: 10s

  napcat:
    image: \${NAPCAT_IMAGE}
    container_name: \${COMPOSE_PROJECT}-napcat
    restart: unless-stopped
    environment:
      TZ: \${TZ:-Asia/Shanghai}
      ACCOUNT: \${ACCOUNT:-}
    extra_hosts:
      # backend 在宿主 netns，DNS 无此名字；经宿主网关访问 0.0.0.0:8001
      - "backend:host-gateway"
    ports:
      - "127.0.0.1:\${WEBUI_PORT:-6099}:6099"
    volumes:
      - ./napcat/config:/app/napcat/config
      - ./napcat/qq-config:/app/.config/QQ
      - ./napcat/data:/app/napcat/data
    depends_on:
      backend:
        condition: service_healthy

volumes:
  backend-data:
`
}

/**
 * 幂等供给：生成 compose.yml/.env/NapCat 配置。
 * 已有 provision.json 时只在 account/image/port 变化时重写对应文件。
 * 返回供给信息；account 未定时不写 onebot11（用
 * qq_autoreply_compose_provision 传入 QQ 号生成）。
 */
function ensureProvisioned(opts = {}) {
  let prev = {}
  try { prev = JSON.parse(readFileSync(provisionPath(), 'utf8')) } catch { /* 首次供给 */ }

  const account = String(opts.account ?? prev.account ?? '').trim()
  const backendImage = String(opts.image || prev.backend_image || DEFAULT_BACKEND_IMAGE)
  const napcatImage = String(opts.napcat_image || prev.napcat_image || DEFAULT_NAPCAT_IMAGE)
  const backendPort = String(opts.backend_port || prev.backend_port || DEFAULT_BACKEND_PORT)
  const webuiPort = String(opts.webui_port || prev.webui_port || DEFAULT_WEBUI_PORT)
  const workspaceDir = String(opts.workspace_dir ?? prev.workspace_dir ?? '').trim()
  const sessionDir = String(opts.session_dir ?? prev.session_dir ?? '').trim()
  const onebotToken = String(opts.onebot_token || prev.onebot_token || hexToken())
  const webuiToken = String(opts.webui_token || prev.webui_token || hexToken())

  mkdirSync(join(COMPOSE_DIR, 'napcat', 'config'), { recursive: true })
  mkdirSync(join(COMPOSE_DIR, 'napcat', 'qq-config'), { recursive: true })
  mkdirSync(join(COMPOSE_DIR, 'napcat', 'data'), { recursive: true })

  // compose.yml 缺失或模板版本过旧时重生成（.env 是唯一变量入口）
  let needCompose = true
  try {
    const cur = readFileSync(composeFilePath(), 'utf8')
    needCompose = !cur.includes(`qqa-template: ${COMPOSE_TEMPLATE_VERSION}`)
  } catch { /* 文件不存在 */ }
  if (needCompose) {
    writeFileSync(composeFilePath(), renderComposeYml(), 'utf8')
  }
  const envLines = [
    `COMPOSE_PROJECT=${COMPOSE_PROJECT}`,
    `BACKEND_IMAGE=${backendImage}`,
    `NAPCAT_IMAGE=${napcatImage}`,
    `ONEBOT_TOKEN=${onebotToken}`,
    `BACKEND_PORT=${backendPort}`,
    `WEBUI_PORT=${webuiPort}`,
    'TZ=Asia/Shanghai',
  ]
  if (account) envLines.push(`ACCOUNT=${account}`)
  if (workspaceDir) envLines.push(`WORKSPACE_DIR=${workspaceDir}`)
  if (sessionDir) envLines.push(`SESSION_DIR=${sessionDir}`)
  // DSH web 地址：backend 为 host 网络，127.0.0.1 即宿主回环
  envLines.push(`DSH_BASE_URL=${opts.dsh_base_url || prev.dsh_base_url || 'http://127.0.0.1:3080'}`)
  writeFileSync(join(COMPOSE_DIR, '.env'), envLines.join('\n') + '\n', 'utf8')

  // WebUI 配置：仅文件缺失时写（避免覆盖 NapCat 首启生成的用户改动）
  const webuiFile = join(COMPOSE_DIR, 'napcat', 'config', 'webui.json')
  if (!existsSync(webuiFile)) {
    writeFileSync(webuiFile, renderWebui(webuiToken), 'utf8')
  }

  // onebot11：账号就绪且（无文件或账号变化）时写
  if (account) {
    const obFile = join(COMPOSE_DIR, 'napcat', 'config', `onebot11_${account}.json`)
    const accountChanged = prev.account !== account
    if (accountChanged || !existsSync(obFile)) {
      writeFileSync(obFile, renderOnebot11(onebotToken), 'utf8')
    }
  }

  const provision = {
    provider: 'compose',
    project: COMPOSE_PROJECT,
    account,
    backend_image: backendImage,
    napcat_image: napcatImage,
    backend_port: backendPort,
    webui_port: webuiPort,
    workspace_dir: workspaceDir,
    session_dir: sessionDir,
    onebot_token: onebotToken,
    webui_token: webuiToken,
    updated_at: new Date().toISOString(),
  }
  writeFileSync(provisionPath(), JSON.stringify(provision, null, 2) + '\n', 'utf8')
  return provision
}

/** compose 托管模式的服务控制（语义与 external 对齐：stop 保 NapCat）。 */
async function composeServiceControl(args) {
  const action = (args && args.action) || 'start'
  if (action !== 'start' && action !== 'stop' && action !== 'restart') {
    throw new Error('action 需要是 start、stop 或 restart')
  }

  if (action === 'start') {
    const prov = ensureProvisioned()
    const services = prov.account ? ['backend', 'napcat'] : ['backend']
    await runCompose(['up', '-d', ...services], 240_000)
    await waitForBackend(60_000)
    await ar('POST', '/api/config', { path: 'engine.master_switch', value: true })
    const after = await ar('GET', '/api/status')
    const note = prov.account
      ? `Compose 栈已启动（backend+napcat）。扫码登录: http://127.0.0.1:${prov.webui_port}/webui/ （WebUI token 见 provision.json）`
      : 'Compose 后端已启动；未配置 QQ 号，NapCat 未启动——用 qq_autoreply_compose_provision 传入 account 后重新 start'
    return { action, provider: 'compose', services, master_switch: true, note, status: after }
  }

  if (action === 'restart') {
    try { await ar('POST', '/api/config', { path: 'engine.master_switch', value: false }) } catch { /* 未运行也继续 */ }
    ensureProvisioned()
    await runCompose(['restart', 'backend'], 120_000)
    await waitForBackend(60_000)
    await ar('POST', '/api/config', { path: 'engine.master_switch', value: true })
    const after = await ar('GET', '/api/status')
    return { action, provider: 'compose', master_switch: true, note: 'Compose 后端已重启，总开关已打开', status: after }
  }

  // stop：关总开关并停 backend（napcat 保持运行，登录态不丢）
  try { await ar('POST', '/api/config', { path: 'engine.master_switch', value: false }) } catch { /* 同上 */ }
  await runCompose(['stop', 'backend'], 60_000)
  return {
    action: 'stop',
    provider: 'compose',
    master_switch: false,
    backend_stopped: true,
    note: 'Compose 后端已停止（NapCat 容器保持运行，登录态不丢）',
    status: null,
  }
}

async function runServiceControl(args) {
  if (PROVIDER === 'compose') return composeServiceControl(args)
  return externalServiceControl(args)
}

async function externalServiceControl(args) {
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
    return { ok: true, autoreply: true, plugin: 'dsh-qq-autoreply', provider: PROVIDER }
  } catch (e) {
    return { ok: false, autoreply: false, provider: PROVIDER, error: String(e && e.message || e) }
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


async function attachSessionToWorkspace(ctx, session) {
  if (!ctx || !ctx.workspaceRegistry || !session || !session.header || !session.header.cwd) return
  try {
    const ws = await ctx.workspaceRegistry.resolveByPath(session.header.cwd)
    if (ws) await ws.attachSession(session.id)
  } catch (e) {
    // 工作区 attach 是增强行为，失败不应阻断回复。
  }
}

/** canonical base64 校验 + 解码，语义与 dsh-attachment 的 admission 一致。 */
function decodeCanonicalImageBase64(data) {
  const text = String(data ?? '')
  const decoded = Buffer.from(text, 'base64')
  if (!text.length || decoded.toString('base64') !== text) throw new Error('图片不是规范的 base64 数据')
  return new Uint8Array(decoded)
}

/** 准入一批 wire 形式图片：优先用 harness 助手，不可用时退回 attachments.saveImages。 */
async function admitImages(attachments, images) {
  if (typeof admitEncodedImages === 'function') return admitEncodedImages(attachments, images)
  return attachments.saveImages(images.map((image) => ({
    mediaType: image.mediaType,
    data: decodeCanonicalImageBase64(image.data),
    ...(image.name === undefined ? {} : { name: image.name }),
  })))
}

async function toAgentContent(ctx, content) {
  const textParts = content.filter((part) => part && part.type === 'text')
  const imageParts = content.filter((part) => part && part.type === 'image_url')
  if (!imageParts.length) return content
  if (!ctx.attachments) throw new Error('DSH attachments 服务未挂载，无法读取图片')
  const encoded = imageParts.map((part) => {
    const match = String(part.image_url.url).match(/^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/=]+)$/)
    if (!match) throw new Error('图片必须是受支持格式的 base64 Data URL')
    return { mediaType: match[1], data: match[2] }
  })
  const refs = await admitImages(ctx.attachments, encoded)
  return [
    ...textParts,
    ...refs.map((attachment) => ({ type: 'image', attachment })),
  ]
}

/**
 * 把 agent 的模型绑定纠正为本次请求指定的 provider/model。
 * 背景：会话可能由面板/旧版本在不带 provider/model 的情况下创建，复用内存中的
 * 活 agent 时其 options.model 为空，导致系统提示词装配报
 * `prompt variable "{{model}}" has no value (deployment:persona-prefix)`、
 * 本轮无回复（"DSH Agent 未产生回复"）。这里用与 GUI selectModel 相同的
 * agents.selectForNextRequest 途径在每次回复前自愈。
 */
async function rebindAgentModel(ctx, agent, provider, model) {
  if (!agent || !provider || !model) return
  try {
    if (agent.options && agent.options.provider === provider && agent.options.model === model) return
  } catch { /* options 不可读时继续尝试纠正 */ }
  if (!ctx.agents || typeof ctx.agents.selectForNextRequest !== 'function') return
  try {
    let selection = { provider, model }
    if (ctx.llm && typeof ctx.llm.resolveCallConfig === 'function') {
      const resolved = await ctx.llm.resolveCallConfig({ provider, model })
      selection = {
        provider: resolved.provider,
        model: resolved.model,
        ...(resolved.reasoningEffort ? { reasoningEffort: resolved.reasoningEffort } : {}),
      }
    }
    ctx.agents.selectForNextRequest(agent, selection)
  } catch { /* 纠正失败不阻塞回复流程，保持原绑定 */ }
}

async function runSessionTurn(ctx, body) {
  const sessionId = String(body.session_id || '')
  const text = String(body.text || '')
  const provider = String(body.provider || '')
  const model = String(body.model || '')
  if (!sessionId || !text || !provider || !model) throw new Error('session_id/text/provider/model required')
  const content = Array.isArray(body.content) && body.content.length
    ? body.content
    : [{ type: 'text', text }]
  const messageContent = content.filter((part) =>
    (part && part.type === 'text' && typeof part.text === 'string') ||
    (part && part.type === 'image_url' && part.image_url && typeof part.image_url.url === 'string')
  )
  if (!messageContent.length) throw new Error('message content is empty')
  if (!ctx.agents) throw new Error('DSH agents 服务未挂载，请检查 profile 是否包含 Agent loop')
  const session = ctx.sessions.get(sessionId)
  let agent = ctx.agents.get(sessionId)
  if (!agent) {
    const setup = ctx.agentPresets ? async (agentCtx) => { await ctx.agentPresets.mount(agentCtx, body.agent_preset || undefined) } : undefined
    const agentOptions = {
      ...(provider ? { provider } : {}),
      ...(model ? { model } : {}),
      ...(body.max_tokens ? { maxTokens: body.max_tokens } : {}),
    }
    let handle
    if (session) {
      handle = await ctx.agents.resume({ resumeSessionId: sessionId, agentOptions, setup })
    } else {
      try {
        // 优先恢复持久化存在的 Session；持久化不存在时再新建。
        handle = await ctx.agents.resume({ resumeSessionId: sessionId, agentOptions, setup })
      } catch (error) {
        handle = await ctx.agents.create({ sessionId, meta: { cwd: resolveCwd(body.workspace_id), agentPreset: body.agent_preset || undefined }, agentOptions, setup })
      }
    }
    agent = handle.agent
  }
  // 自愈：内存复用或 resume 出的 agent 若缺模型绑定，按本次请求纠正
  await rebindAgentModel(ctx, agent, provider, model)
  await attachSessionToWorkspace(ctx, agent.session)
  const agentContent = await toAgentContent(ctx, messageContent)
  agent.followup(makeMessage({ role: 'user', content: agentContent, source: { kind: 'user' } }))
  await agent.whenIdle()
  const messages = agent.session.deriveMessages()
  const last = [...messages].reverse().find((message) => message.role === 'assistant')
  if (!last) throw new Error('DSH Agent 未产生回复')
  return { provider, model, session_id: sessionId, content: last.content.map((part) => part.type === 'text' ? part.text : '').join('') }
}

async function handleDshSession(ctx, body) {
  if (!ctx.sessions) throw new Error('DSH sessions 服务未挂载，请检查 profile 是否包含 Session runtime')
  const action = body.action || 'list'
  if (action === 'list') return { sessions: ctx.sessions.list().map((s) => ({ id: s.id, cwd: s.header.cwd, createdAt: s.header.createdAt })) }
  if (action === 'create') {
    if (!ctx.agents) throw new Error('DSH agents 服务未挂载，请检查 profile 是否包含 Agent loop')
    const setup = ctx.agentPresets ? async (agentCtx) => { await ctx.agentPresets.mount(agentCtx, body.agent_preset || undefined) } : undefined
    const handle = await ctx.agents.create({ sessionId: body.id || `qqa-${Date.now()}`, meta: { cwd: resolveCwd(body.workspace_id), agentPreset: body.agent_preset || undefined }, agentOptions: { provider: body.provider || undefined, model: body.model || undefined, maxTokens: body.max_tokens }, setup })
    const session = handle.agent.session
    await attachSessionToWorkspace(ctx, session)
    return { session: { id: session.id, cwd: session.header.cwd, createdAt: session.header.createdAt } }
  }
  if (action === 'chat') {
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
    case 'session_auto': case 'qq_autoreply_session_auto': {
      if (!args || !args.chat_key) throw new Error('需要 chat_key')
      return await ar('POST', '/api/sessions/auto', { chat_key: args.chat_key, auto_on: !!args.auto_on })
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
    case 'compose_provision': case 'qq_autoreply_compose_provision': {
      if (PROVIDER !== 'compose') {
        return { ok: false, error: '当前 provider 为 external（AUTOREPLY_PROVIDER=compose 启用托管模式）', provider: PROVIDER }
      }
      const prov = ensureProvisioned(args || {})
      return {
        ok: true,
        provider: 'compose',
        compose_dir: COMPOSE_DIR,
        account: prov.account,
        backend_port: prov.backend_port,
        webui_port: prov.webui_port,
        webui_url: `http://127.0.0.1:${prov.webui_port}/webui/`,
        webui_token: prov.webui_token,
        next: prov.account
          ? 'service_control start 拉起 backend+napcat，然后打开 webui_url 扫码登录'
          : '传入 account 后重新供给，或仅 start 先拉起 backend',
      }
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
    chat_key: { type: 'string', description: '会话键，如 friend:10001 或 group:123456' },
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

  tl('qq_autoreply_compose_provision', '（Compose 托管模式）生成/更新 AutoReply 栈供给：compose.yml、.env 与 NapCat 配置（token 自动对齐）。传入 account（QQ 号）会同时生成 onebot11 反向 WS 配置，之后 service_control start 即可拉起 backend+napcat。传 workspace_dir/session_dir 可保留每会话目录能力（宿主路径对等挂载）。', {
    account: { type: 'string', description: 'QQ 号；提供后自动生成 onebot11_{qq}.json', optional: true },
    image: { type: 'string', description: '后端镜像（默认 qq-autoreply-backend:latest）', optional: true },
    backend_port: { type: 'string', description: '宿主侧后端端口（默认 8001）', optional: true },
    webui_port: { type: 'string', description: '宿主侧 NapCat WebUI 端口（默认 6099）', optional: true },
    workspace_dir: { type: 'string', description: 'DSH 工作区宿主路径（路径对等挂载进容器）', optional: true },
    session_dir: { type: 'string', description: '会话目录宿主根路径（需在 workspace_dir 之下）', optional: true },
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
        } else if (url.pathname === '/dsh-qq/compose') {
          send(200, await handleComposeStatus())
        } else if (url.pathname === '/dsh-qq/execute') {
          if (req.method !== 'POST') return send(405, { ok: false, error: 'POST only' })
          let body = {}
          const chunks = []
          for await (const c of req) chunks.push(c)
          try { body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') } catch { /* ignore */ }
          send(200, await handleExecute(body))
        } else if (url.pathname === '/dsh-qq/persona') {
          send(200, await handlePersona())
        } else if (url.pathname === '/dsh-qq/session') {
          if (req.method !== 'POST') return send(405, { ok: false, error: 'POST only' })
          const chunks = []
          for await (const c of req) chunks.push(c)
          let body = {}
          try { body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') } catch { return send(400, { ok: false, error: 'invalid JSON' }) }
          const result = await handleDshSession(ctx, body)
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
    text: '本机已挂载 QQ AutoReply 互通插件：可用 qq_autoreply_service_control 一键启动/停止全部服务（NapCat + AutoReply 后端 + 总开关）；用 qq_autoreply_status / qq_autoreply_config_get / qq_autoreply_config_set / qq_autoreply_sessions / qq_autoreply_messages / qq_autoreply_logs / qq_autoreply_test_llm 工具查看与修改本地 QQ 自动回复服务（配置改动立即生效，存储在 AutoReply 的 SQLite 覆盖层）。修改人设用 config_set(path="persona.system_prompt")；选择 DSH 模型用 config_set(path="llm.model")。Compose 托管模式下另有 qq_autoreply_compose_provision：生成/更新栈供给（compose.yml/.env/NapCat 配置，token 自动对齐），传 account（QQ 号）后 start 即拉起全部服务。',
  })
}

// 测试钩子：供给与 compose 生命周期的纯逻辑可在宿主 Node 里直测
export const __compose = { ensureProvisioned, composeServiceControl, runCompose, PROVIDER, COMPOSE_DIR }
