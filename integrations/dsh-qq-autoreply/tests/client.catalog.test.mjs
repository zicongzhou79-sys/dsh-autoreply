/**
 * 自测：会话绑定区的 DSH 目录读取与「此会话的 DSH 配置」选择器。
 *
 * 背景（2026-09-21 故障）：面板用 `connection.api.*` 读模型/Agent preset，
 * 而当前 DSH 的 connection 客户端服务没有 `api` 字段（只有 rpc/state/generation/start），
 * 读取永远落空，于是会话绑定区里「此会话的 DSH 配置」的模型与 Agent preset
 * 下拉框恒为空，也改不了配置。
 *
 * 本测试用 stub 的 ModuleLoader + React 加载 lib/client.js，验证：
 *   1. 当前 DSH 形态（remote.session / remote.agentPresets）能读出模型与 preset；
 *   2. 历史形态（connection.api.*，返回 {result:{ok,value}}）仍可兜底；
 *   3. 失败形态（{ok:false,error}）返回可读原因而不是静默为空；
 *   4. 工作区快照读取，服务缺失时返回 null（区别于空列表）；
 *   5. 会话绑定区渲染出「此会话的 DSH 配置」的模型 / Agent preset 选择器与提示。
 *
 * 运行：node integrations/dsh-qq-autoreply/tests/client.catalog.test.mjs
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const clientPath = join(here, '..', 'lib', 'client.js')

// ---- stubs -----------------------------------------------------------------
let captured = null
globalThis.window = {
  __ModuleLoader__: { load: (spec) => { captured = spec } },
  location: { origin: 'http://127.0.0.1:3080' },
}

const reactStub = {
  createElement: (type, props, ...children) => ({
    type,
    props: props || {},
    children: children.flat(Infinity).filter((c) => c !== null && c !== undefined && c !== false),
  }),
  useState: () => [null, () => {}],
  useEffect: () => {},
  useRef: () => ({ current: null }),
  useCallback: (fn) => fn,
  Fragment: 'Fragment',
}
const primitivesStub = { IconSettingsOutline16: 'IconSettingsOutline16' }
const requireStub = (id) => {
  if (id === 'react') return reactStub
  if (id === '@deepseek-ai/dsh-client-ui-primitives') return primitivesStub
  throw new Error('unexpected require: ' + id)
}

// client.js 是浏览器脚本：设置 window 后按 ESM 载入即可（无 import/export）。
await import(clientPath + '?t=' + Date.now())
assert.ok(captured, 'client.js 应通过 window.__ModuleLoader__.load 注册插件')
assert.equal(captured.id, 'dsh-qq-autoreply')
const mod = captured.factory(requireStub)
const __test = mod.__test
assert.ok(__test, '插件应导出 __test 供自测使用')
assert.equal(typeof mod.apply, 'function', '插件必须导出 apply')
assert.ok(Array.isArray(mod.inject), '插件必须导出 inject')
// 关键回归：必须注入 remote（模型/Agent preset 目录的服务通道）
assert.ok(mod.inject.includes('remote'), 'inject 必须包含 remote')
assert.ok(mod.inject.includes('workspaces'), 'inject 必须包含 workspaces')

const { readDshCatalog, unwrapRemote, readWorkspaceItems, mapWorkspaces, SessionBindingEditor } = __test

// ---- fake contexts ---------------------------------------------------------
const MODEL_GROUPS = [
  { id: 'chatgpt', name: 'ChatGPT', models: [{ id: 'gpt-5.6-luna', name: 'gpt-5.6-luna' }] },
  { id: 'deepseek-official', name: 'DeepSeek', models: [{ id: 'deepseek-v4-flash', name: 'deepseek-v4-flash' }] },
]
const PRESETS = { presets: [{ id: 'standard', name: '标准', trust: 'system', isDefault: true }, { id: 'broken', name: '坏预设', broken: 'parse error' }], authorable: true }

function fakeCtx({ withWorkspaces = true, modelError = null, presetsError = null } = {}) {
  const services = {
    'remote.session': {
      modelCatalog: async () => (modelError ? { ok: false, error: modelError } : { ok: true, value: { groups: MODEL_GROUPS, routableProviders: ['chatgpt'], failures: [] } }),
    },
    'remote.agentPresets': {
      list: async () => (presetsError ? { ok: false, error: presetsError } : { ok: true, value: PRESETS }),
    },
  }
  if (withWorkspaces) {
    services.workspaces = {
      list: { getSnapshot: () => ({ items: [{ workspaceId: 'ws-1', path: ' /home/user/Data/AutoReply', title: 'AutoReply' }], state: 'ready' }) },
    }
  }
  return { get: (name) => services[name] }
}

// ---- 1. 当前 DSH 形态 ------------------------------------------------------
{
  const result = await readDshCatalog(fakeCtx(), undefined)
  assert.deepEqual(result.models, [
    { value: 'chatgpt:gpt-5.6-luna', label: 'ChatGPT / gpt-5.6-luna' },
    { value: 'deepseek-official:deepseek-v4-flash', label: 'DeepSeek / deepseek-v4-flash' },
  ])
  assert.deepEqual(result.agents, [{ id: 'standard', label: '标准' }])
  assert.deepEqual(result.workspaces, [{ id: 'ws-1', path: ' /home/user/Data/AutoReply', label: 'AutoReply' }])
  assert.equal(result.note, '')
  console.log('✓ 当前 DSH 形态：模型 / Agent preset / 工作区均可读取')
}

// ---- 2. 历史 connection.api 形态（含旧结果封装） ---------------------------
{
  const legacyApi = {
    session: { modelCatalog: async () => ({ result: { ok: true, value: { groups: MODEL_GROUPS } } }) },
    agentPresets: { list: async () => ({ result: { ok: true, value: PRESETS } }) },
    workspace: { list: async () => ({ result: { ok: true, value: { items: [{ workspaceId: 'ws-legacy', path: '/tmp/legacy' }] } } }) },
  }
  const result = await readDshCatalog(fakeCtx({ withWorkspaces: false }), legacyApi)
  assert.equal(result.models.length, 2)
  assert.deepEqual(result.agents.map((a) => a.id), ['standard'])
  assert.deepEqual(result.workspaces, [{ id: 'ws-legacy', path: '/tmp/legacy', label: '/tmp/legacy' }])
  console.log('✓ 历史 connection.api 形态：兜底通道仍可用')
}

// ---- 3. 失败形态给出可读原因，而不是静默为空 ------------------------------
{
  const result = await readDshCatalog(fakeCtx({ modelError: { code: 'gateway/offline', message: 'gateway offline' }, presetsError: { code: 'x', message: 'roster unavailable' } }), undefined)
  assert.equal(result.models.length, 0)
  assert.equal(result.agents.length, 0)
  assert.match(result.note, /未读取到模型目录/)
  assert.match(result.note, /未读取到 Agent preset/)
  console.log('✓ 目录读取失败时返回可读 note')
}

// ---- 4. 解包与工作区工具函数 ----------------------------------------------
{
  assert.deepEqual(unwrapRemote({ ok: true, value: 7 }), 7)
  assert.deepEqual(unwrapRemote({ result: { ok: true, value: 8 } }), 8)
  assert.equal(unwrapRemote(null), null)
  assert.throws(() => unwrapRemote({ ok: false, error: { message: 'boom' } }), /boom/)
  assert.equal(readWorkspaceItems(fakeCtx({ withWorkspaces: false })), null)
  assert.equal(readWorkspaceItems(fakeCtx()).length, 1)
  assert.deepEqual(mapWorkspaces([{ workspaceId: 'a', path: '/p', title: 'T' }]), [{ id: 'a', path: '/p', label: 'T' }])
  console.log('✓ unwrapRemote / readWorkspaceItems / mapWorkspaces 行为正确')
}

// ---- 5. 会话绑定区渲染「此会话的 DSH 配置」选择器 --------------------------
{
  const tree = SessionBindingEditor({
    sessions: [{ chat_key: 'friend:1', peer_name: '好友', dsh_session_id: 's1', agent_preset: 'standard' }],
    models: [{ value: 'chatgpt:gpt-5.6-luna', label: 'ChatGPT / gpt-5.6-luna' }],
    agents: [{ id: 'standard', label: '标准' }],
    workspaces: [{ id: 'ws-1', path: '/p', label: 'P' }],
    note: '未读取到模型目录；未读取到 Agent preset',
    onSave: () => {},
    onReloadCatalog: () => {},
    onToggleAuto: () => {},
    onDeleteBinding: () => {},
  })
  const selects = []
  const walk = (node) => {
    if (!node || typeof node !== 'object') return
    if (node.type === 'select') selects.push(node)
    for (const child of node.children || []) walk(child)
  }
  walk(tree)
  // 工作区 / 绑定 DSH 会话 / 模型 / Agent preset
  assert.equal(selects.length, 4, '会话绑定区应有 4 个下拉框')
  const modelOptions = selects[2].children.map((o) => o.props && o.props.value)
  const agentOptions = selects[3].children.map((o) => o.props && o.props.value)
  assert.ok(modelOptions.includes('chatgpt:gpt-5.6-luna'), '模型下拉应包含已加载模型')
  assert.ok(agentOptions.includes('standard'), 'Agent preset 下拉应包含已加载 preset')
  assert.ok(modelOptions.includes(''), '模型下拉应保留「跟随全局」')
  const noteNode = (function find(n) {
    if (!n || typeof n !== 'object') return null
    if (n.props && n.props.className === 'qqa-note') return n
    for (const child of n.children || []) { const hit = find(child); if (hit) return hit }
    return null
  })(tree)
  assert.ok(noteNode, '读取失败提示应显示在会话绑定区')
  console.log('✓ 会话绑定区渲染出模型 / Agent preset 选择器与失败提示')
}

// 源码级回归：不得再依赖 connection.api 读取目录，也不应再有全局配置区
{
  const code = readFileSync(clientPath, 'utf8').replace(/^\s*\/\/.*$/gm, '')
  assert.ok(!/dshApi\.(session|agentPresets|llm|workspace)\b/.test(code), '目录读取不应再走 connection.api 命名空间')
  assert.ok(code.includes('readRemoteNamespace'), '应通过 remote 命名空间读取目录')
  assert.ok(code.includes('此会话的 DSH 配置'), '模型/Agent preset 选择应在会话绑定区')
  console.log('✓ 源码级回归：目录走 remote 命名空间，配置选择留在会话绑定区')
}

console.log('\n全部通过 ✅')
