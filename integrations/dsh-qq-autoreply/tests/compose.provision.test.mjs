// ComposeProvider 供给逻辑回归测试（纯 Node，无 Docker 依赖）
// 运行：node tests/compose.provision.test.mjs
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const pluginRoot = dirname(here)
let pass = 0
const ok = (cond, msg) => { if (!cond) { console.error('❌ ' + msg); process.exit(1) } ; pass++; console.log('✅ ' + msg) }

const dir = mkdtempSync(join(tmpdir(), 'qqa-provision-'))
// 模块在 import 时读取 env，必须先改 process.env 再动态 import
process.env.AUTOREPLY_PROVIDER = 'compose'
process.env.AUTOREPLY_COMPOSE_DIR = dir
process.env.AUTOREPLY_IMAGE = 'qq-autoreply-backend:test'
process.env.AUTOREPLY_BACKEND_PORT = '18001'
process.env.AUTOREPLY_WEBUI_PORT = '18099'
process.env.AUTOREPLY_COMPOSE_PROJECT = 'qq-autoreply-test'

// node --experimental-vm-modules 不需要：直接子进程跑 ESM 模块
const mod = await import('../lib/index.js')
const { ensureProvisioned, PROVIDER } = mod.__compose
const { resolveProvider } = mod
ok(PROVIDER === 'compose', 'AUTOREPLY_PROVIDER=compose 生效')

// provider 解析：显式 env 优先，未设置时按供给文件是否存在自动切换
ok(resolveProvider('compose', false) === 'compose', '显式 compose 生效')
ok(resolveProvider('external', true) === 'external', '显式 external 覆盖供给存在')
ok(resolveProvider('', false) === 'external', '无 env 无供给 → external')
ok(resolveProvider('', true) === 'compose', '无 env 有供给 → 自动 compose（迁移后重启即切换）')
ok(resolveProvider('  COMPOSE  ', true) === 'compose', 'env 大小写/空白容忍')

const p1 = ensureProvisioned({ account: '10000' })
const p2 = ensureProvisioned() // 幂等：token/端口不漂移
ok(p1.onebot_token === p2.onebot_token, '重复供给 token 稳定')
ok(p2.account === '10000' && p2.backend_port === '18001', 'account/端口沿用')

ok(existsSync(join(dir, 'compose.yml')), 'compose.yml 生成')
ok(existsSync(join(dir, '.env')), '.env 生成')
ok(existsSync(join(dir, 'napcat', 'config', 'onebot11_10000.json')), 'onebot11_账号.json 生成')
ok(existsSync(join(dir, 'napcat', 'config', 'webui.json')), 'webui.json 生成')

const ob = JSON.parse(readFileSync(join(dir, 'napcat', 'config', 'onebot11_10000.json'), 'utf8'))
const client = ob.network.websocketClients[0]
ok(client.url === 'ws://backend:8001/onebot/ws', '反向 WS 指向 compose 网络 backend')
ok(client.token === p1.onebot_token, 'onebot11 token 与后端同值（自动对齐）')
ok(client.messagePostFormat === 'array', '消息格式 array')

const envText = readFileSync(join(dir, '.env'), 'utf8')
ok(envText.includes('BACKEND_IMAGE=qq-autoreply-backend:test'), '.env 注入镜像')
ok(envText.includes('ACCOUNT=10000'), '.env 注入 ACCOUNT')
ok(envText.includes('BACKEND_PORT=18001'), '.env 注入端口')

const yml = readFileSync(join(dir, 'compose.yml'), 'utf8')
ok(yml.includes('AUTOREPLY_ONEBOT_TOKEN: ${ONEBOT_TOKEN}'), 'compose 传递 token 给后端')
ok(yml.includes('127.0.0.1:${BACKEND_PORT'), '后端端口只绑回环')
ok(yml.includes('condition: service_healthy'), 'napcat 等 backend 健康后启动')

// 换账号：onebot11 重写为新账号文件，token 不变
const p3 = ensureProvisioned({ account: '20000' })
ok(existsSync(join(dir, 'napcat', 'config', 'onebot11_20000.json')), '换账号生成新 onebot11')
ok(p3.onebot_token === p1.onebot_token, '换账号 token 不漂移')

rmSync(dir, { recursive: true, force: true })
console.log(`\n全部 ${pass} 项通过`)
