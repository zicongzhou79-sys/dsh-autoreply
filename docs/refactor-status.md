# QQ AutoReply DSH 深度重构状态与验收清单

> 依据 `docs/design.md` 跟踪重构完成度。本文件用于人工核对剩余验收项。

## 1. 已完成

### 运行时职责

- [x] AutoReply 只负责 QQ 接入、消息归档、触发规则、安全检查和受控发送。
- [x] DSH 是唯一智能回复运行时。
- [x] AutoReply 不再向 DSH 发送本地 SQLite 历史。
- [x] 每个 QQ 会话绑定独立 DSH Session。
- [x] DSH Session 通过 Agent loop 执行 Agent preset、模型、工具、上下文和记忆。
- [x] 移除 AutoReply 侧旧 `llm.stream` 回退路径。
- [x] 移除 DSH host `/dsh-qq/llm` 旧接口。
- [x] 移除 `DSHClient.chat()` 旧直连方法。
- [x] DSH 失败或空回复时不发送 QQ 消息，仅在面板/日志显示。

### 会话绑定

- [x] DSH Session 创建/恢复支持 `agent_preset`、`provider`、`model`、`workspace_id`。
- [x] 未绑定 workspace 时自动回退到 DSH 启动目录，避免 `{{cwd}}` 无值。
- [x] Agent preset 通过 `ctx.agentPresets.mount()` 挂载。

### UI

- [x] 正式 DSH 面板仅保留私聊/群聊触发规则。
- [x] 新增模拟聊天区域，读取真实 `/api/messages`。
- [x] 模拟聊天展示 DSH 失败信息，并标注“未发送到 QQ”。
- [x] 会话绑定支持 Agent preset、模型、Workspace、Session ID。
- [x] DSH 页面可见 `QQ 自动回复` 入口。
- [x] 通过只读浏览器脚本提取页面正文，确认入口文本存在于当前 DSH Web 页面。
- [x] 修复点击“QQ 自动回复”后 `agent is not defined` 导致组件崩溃、按钮消失的问题。

## 2. 自动验证证据

```text
pytest -q backend/tests
28 passed

node --check integrations/dsh-qq-autoreply/lib/index.js
通过

node --check integrations/dsh-qq-autoreply/lib/client.js
通过
```

运行时验证：

```text
GET http://127.0.0.1:3081/dsh-qq/health
{"ok":true,"autoreply":true,"plugin":"dsh-qq-autoreply"}

POST /dsh-qq/session chat
{"ok":true,"result":{"content":"pong"}}

AutoReply Python DSHClient session_chat
"Python E2E OK"
```

## 3. 剩余人工/运维项

- [ ] 刷新 DSH Web 后人工确认点击“QQ 自动回复”可以正常打开控制面板。

## 4. 关键提交

```text
2dff8ac remove legacy DSH LLM endpoint and client method
1be8cec refactor: remove legacy DSH llm fallback from AutoReply
3044e8d docs: update README to Session/Agent-only DSH integration
64e0d9f fix: always provide cwd to DSH agent assembly
dd92822 test: cover DSH session empty and failure paths
17ea94d docs: record DSH session/agent integration
c67c7aa fix: reject empty DSH agent responses
038984f fix: load plugin without private DSH package imports
5ff574a feat: execute QQ replies through DSH agent loop
e08db79 refactor: persist QQ turns in DSH sessions
39e2f55 refactor: align plugin panel with design
9a8808b feat: add session chat panel and scoped reply rules
17222bd refactor: route replies through DSH sessions
```