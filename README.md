# QQ AI AutoReply —— 用 AI 替你回 QQ 消息

一个**本地运行的 QQ 自动回复 Demo**：监听 NapCat(OneBot11) 事件，由 DSH Web profile 中配置的模型运行时以「账号本人」人设全自动回复，由 DeepSeek Harness 插件控制，不再提供独立 WebUI。

> ⚠️ 免责声明：本项目为个人学习/实验用途。代替本人回复消息可能产生
> 误解、隐私或合规风险，请仅在合法合规场景下小范围使用，自行承担后果。
> 敏感词过滤、频率限制、黑白名单等保护措施请按需配置。


文档入口：[`docs/README.md`](docs/README.md)。

---

## 1. 架构

```
QQ客户端 ←→ NapCat(Docker, OneBot11 反向WS客户端)
                  │  ws://172.18.0.1:8001/onebot/ws (Bearer token)
                  ▼
FastAPI 单进程 (0.0.0.0:8001)
 ├─ /onebot/ws    OneBot11 反向WS服务端（鉴权/心跳/单连接/事件+API双工）
 ├─ /api/*        内部 REST（状态/会话/消息/日志/配置）
        ├─ onebot/    WS服务端 + 协议解析 + Gateway发送门面
        ├─ engine/    决策器(开关/触发/频率/敏感词) + 上下文 + 回复编排
        ├─ ai/        OpenAI兼容 Provider(httpx) + 人设渲染
后端不再托管独立用户界面，控制入口和面板由 DSH 插件提供。
        ├─ store/     SQLite 持久化（消息/会话/回复日志/配置覆盖层）
        └─ api/       REST + 实时广播
```

**连接形态**：后端是 WS **服务端**，NapCat 是 WS **客户端**反向连入
（NapCat 侧配置 `ws://172.18.0.1:8001/onebot/ws`，token 两端一致）。
单端口 8001 同时承载 OneBot WS 和供 DSH 插件调用的 REST API。

---

## 2. 目录结构

```
AutoReply/
├── README.md
├── scripts/
│   ├── start.sh           # 一键启动后端
│   └── rebuild_napcat.sh  # NapCat 容器重建（含数据抢救）
├── deploy/napcat/         # NapCat 容器挂载数据（config/qq-config/data）
├── backend/
│   ├── config.yaml        # 实际配置（onebot token / llm / engine / persona）
│   ├── requirements.txt
│   ├── app/               # main/config + onebot/engine/ai/store/api
│   └── tests/             # pytest 单元+集成测试
├── data/                  # SQLite 运行时数据（app.db）
└── logs/                  # 运行日志
```

---

## 3. 前置条件

- **Docker**（NapCat 容器运行中，端口 6099 已映射）
- **QQ 账号已登录 NapCat**（首次或重建容器后需扫码一次）
- Python 3.11+，依赖：`pip install -r backend/requirements.txt`
- 一个已在 DSH Web profile 中启用的模型运行时。模型凭据由 DSH 管理。

---

## 4. 快速开始

### 4.1 一次性配置

1. **NapCat 容器**（若已运行且已登录可跳过）：
   ```bash
   bash scripts/rebuild_napcat.sh
   ```
   - 脚本会从旧容器抢救登录态/配置并重建容器（`--restart=always`）
   - 重建后如提示扫码：浏览器打开 **http://127.0.0.1:6099/webui/?token=你的webui_token**
     （NapCat WebUI 登录页，二维码实时刷新；token 见 deploy/napcat/config/webui.json）

2. **对齐 token**（后端与 NapCat 的 OneBot token 必须一致）：
   ```bash
   # 查看 NapCat 当前 token
   docker exec napcat sh -c 'cat /app/napcat/config/onebot11_*.json' | grep token
   # 若为占位符请改掉，并与 backend/config.yaml 的 onebot.access_token 保持一致
   # 改完跑: docker restart napcat
   ```

3. **配置模型与 Agent**：安装 DSH 插件后，在 DSH 侧栏的 QQ AutoReply 控制面板中选择模型、Agent preset 和 workspace。

### 4.2 启动

```bash
bash scripts/start.sh          # 前台运行（Ctrl+C 停止）
# 或
bash scripts/start.sh --bg     # 后台运行，日志看 logs/backend.log
```

控制面板位于 DSH Web 的侧栏设置入口同组位置。

---

## 5. DSH 控制面板功能

| Tab | 功能 |
|---|---|
| **状态** | OneBot 连接灯、QQ 登录灯、LLM 配置灯、总开关、今日统计（收发/AI回复/拦截） |
| **会话** | 会话列表 + 实时消息流（WS 推送自动追加）、每会话「自动回复」开关、清空历史 |
| **回复日志** | 每次决策记录：answered/skipped/blocked/failed + 原因 + AI 输出 + 耗时 |
| **配置** | 在 DSH 控制面板选择模型服务、Agent preset、workspace，并管理触发规则和安全策略 |

---

## 5b. DeepSeek Harness 互通（可选功能）

本项目可与 **DeepSeek Harness (DSH)** 双向打通，用 DSH 会话直接管理 QQ 自动回复，
并让 AutoReply 回复引擎调用 DSH 工具增强回复。

### 双向能力

| 方向 | 能力 |
|---|---|
| **DSH → AutoReply** | DSH 会话中可用工具：`qq_autoreply_status` / `config_get` / `config_set`（改 LLM/人设/规则，立即生效）/ `sessions` / `messages` / `logs` / `test_llm` |
| **AutoReply → DSH** | 回复引擎生成前可调 DSH 工具（如 `reply_knowledge` 状态摘要）注入上下文，再交给 LLM 生成 |

### 插件安装

```bash
# 把 integrations/dsh-qq-autoreply 安装到 DSH profile（离线时见插件 README）
dsh plugin --profile web add ./integrations/dsh-qq-autoreply
# 或手动：复制包到 DSH node_modules + 追加 bundle 名到 profile package.json，
# 然后重启 DSH web（守护器自动拉起）
```

### 启用 AutoReply 侧

```bash
# 在 WebUI 配置页或直接：
POST /api/config  {"batch":{
  "engine.dsh.enabled": true,
  "engine.dsh.base_url": "http://127.0.0.1:3081",   # DSH 后端端口（3080 是 web 前端）
  "engine.dsh.reply_tools": ["reply_knowledge"]      # 回复增强工具白名单
}}
```

验证：`GET /api/status` 应显示 `dsh_enabled: true, dsh_online: true`。

### 架构要点

- DSH 插件用 `node:http` 直连 AutoReply（绕开 DSH 进程的 socks 代理环境），
  去除了 fetch 代理导致的 localhost 挂起
- `/dsh-qq/health` 轻量探测（不递归调 AutoReply），避免 status↔health 探测环路延迟
- AutoReply 侧 `DSHClient.probe()` 带 5s 缓存，不拖慢面板轮询
- DSH 不可达时模型生成记录失败并跳过发送；仅 DSH 工具增强失败时跳过增强信息，不影响后续模型生成。

---

## 6. 配置说明（backend/config.yaml）

| 段 | 字段 | 说明 |
|---|---|---|
| server | port / webui_token | 端口；面板口令（空=仅本机免密） |
| onebot | access_token | **与 NapCat 一致**（唯一事实源） |
| llm | provider/model/temperature/max_tokens | DSH runtime 模型路由和生成参数 |
| engine.master_switch | - | 总开关，关闭则只记录不回复 |
| engine.private_auto | - | 私聊全自动 |
| engine.group_mode | mention/keyword/all/off | 群聊触发策略（默认 @本人 才回） |
| engine.group_keywords | - | keyword 模式触发词 |
| engine.whitelist / blacklist | friends/groups | 空=全部；白名单非空=仅名单 |
| engine.rate_limit | per_session_per_min | 每会话每分钟 AI 回复上限 |
| engine.context_n | - | 喂给 LLM 的历史条数 |
| engine.sensitive_words | - | 入站和出站命中都不回复 |
| engine.dsh | enabled/base_url/reply_tools | DSH 互通：开关、DSH 后端地址（3081）、回复增强工具白名单 |
| persona | name/system_prompt | 人设（{name} 占位符） |

> DSH 控制面板修改的配置存于 SQLite kv_config（覆盖层），优先级高于 config.yaml，保存即时生效；如需彻底清除覆盖层可删除 data/app.db。

---

## 7. 排障

| 现象 | 排查 |
|---|---|
| 状态灯「连接✗」 | ① NapCat 是否已登录（未登录不连 WS）② 两侧 token 是否一致 ③ 容器是否运行 |
| 状态灯「登录✗」 | NapCat WebUI **http://127.0.0.1:6099/webui/?token=…** 重新扫码（token 见 deploy/napcat/config/webui.json） |
| 状态灯「LLM✗」 | 配置页填 API Key 后点「测试连接」看错误 |
| 收不到回复 / 回复日志 skipped | 看日志区原因：no_mention（群聊需@本人）/ whitelist / rate_limited / session_off |
| 面板打不开 | 确认 start.sh 输出地址；logs/backend.log 看报错 |
| 容器重启后要重扫二维码 | 登录态在 deploy/napcat/qq-config，重建容器时先跑 rebuild_napcat.sh 抢救（本仓库的 QQ 会话首次重建即需一次扫码） |

---

## 8. 后续扩展方向（架构已预留接缝）

- `engine/rules.py`：关键词/正则规则引擎（命中规则直接回复，不走 LLM）
- `api/routes_*.py` 路由模块化：新增功能 = 加路由文件
- 会话上下文：加摘要或向量检索，支持长历史
- 更丰富的人设/记忆：按好友群定制 persona
- 前端替换为 React/Vite：后端静态托管 dist/ 即可
- gateway 扩展动作：撤回、禁言、群管操作等