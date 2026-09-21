# 变更记录

## Unreleased

### 修复：会话绑定区读不到模型与 Agent preset

- 根因：面板用 `connection.api.*` 读 DSH 目录，而当前 DSH 的客户端 `connection`
  服务没有 `api` 字段（只有 `rpc`/`state`/`generation`/`start`），模型与
  Agent preset 读取恒为空，会话绑定区「此会话的 DSH 配置」两个下拉框选不了。
- 目录读取改走 remote 命名空间：`remote.session.modelCatalog()`、
  `remote.agentPresets.list()`（`inject` 声明 `remote`），工作区读 `workspaces`
  服务快照；`connection.api.*` 仅作旧版兜底。
- 统一解包 `{ok,value}` 与旧版 `{result:{ok,value}}`；读取失败在会话绑定区显示
  可读提示而不是静默为空，并新增「刷新目录」按钮；打开面板时自动刷新目录。
- 顺带清理无入口的全局配置写入逻辑（`selectDshValue`），模型 / Agent preset /
  工作区选择统一留在会话绑定区。
- 新增自测 `integrations/dsh-qq-autoreply/tests/client.catalog.test.mjs`。

### DSH Session/Agent 深度集成

- AutoReply 不再向 DSH 发送本地 SQLite 历史；只发送当前消息及会话资源引用。
- 每个 QQ 会话绑定独立 DSH Session；DSH Session 事件写入 `user/message` / `assistant/message`。
- DSH `ctx.agents` 可用时，QQ 回复通过 DSH Agent loop 执行；Agent preset 通过 `agentPresets.mount()` 挂载，工具、模型、上下文和记忆由 DSH 管理。
- Session 创建/恢复支持 `provider`、`model`、`agent_preset`、`workspace_id` 和 `max_tokens`。
- DSH Agent 未产生内容时以失败记录处理，禁止发送空回复。
- 移除 AutoReply 侧的旧 `llm.stream` 回退和本地工具增强路径；正式回复只通过 DSH Session/Agent 执行。
- 插件不再直接依赖未声明的 `@deepseek-ai/dsh-llm` 包，可正常被 DSH profile loader 加载。

### 插件化

- DSH 插件成为唯一用户控制入口。
- 控制入口移动到 DSH 侧栏设置同组区域。
- 控制面板支持服务启停、QQ 登录入口、模型、Agent preset 和 workspace 选择。
- Agent preset 由 DSH Agent runtime 挂载，不在 AutoReply 中复制 prompt 副本。
- Workspace 路径同步到引擎配置，并为每个 QQ 会话生成独立会话目录。
- 正式面板只保留私聊/群聊触发规则，新增按真实会话读取消息的模拟聊天。

### 清理

- 删除后端独立 WebUI 及其静态资源。
- 删除 Python 和 pytest 运行缓存。
- 保留 SQLite、NapCat 登录态、部署配置和运行日志。

### DSH-only 模型链路

- 删除 AutoReply 的 OpenAI 兼容直连 Provider；模型生成统一通过 DSH runtime。
- 移除 `llm.base_url`、`llm.api_key` 和 `engine.dsh.proxy` 配置字段；DSH 生成失败记录 `failed`，不再回退到其他模型通道。

### 兼容性

- SQLite 启动时自动添加 `sessions.workspace_dir` 和 `sessions.session_dir` 字段。
- OneBot 协议和消息存储格式保持兼容；模型配置需要迁移到 DSH provider/model。
