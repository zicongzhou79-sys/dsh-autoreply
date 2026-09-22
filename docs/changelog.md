# 变更记录

## Unreleased

### 新增：后端容器化基础（B 方案 B1）

- 目标：插件 ComposeProvider 全托管的后端进容器做准备。本批交付
  「配置环境变量化 + 后端镜像 + 容器冒烟验证」。
- `backend/app/config.py`：
  - `CONFIG_PATH`/`DATA_DIR` 支持 `AUTOREPLY_CONFIG`/`AUTOREPLY_DATA`
    环境变量重定位（默认仍为源码布局，宿主机部署不受影响）；
  - 新增 `_apply_env_overrides`：容器形态可不带 config.yaml，
    `AUTOREPLY_ONEBOT_TOKEN`（token 注入，供编排方与 NapCat 同值对齐）
    与 `AUTOREPLY_PORT` 覆盖配置。
- 新增 `backend/Dockerfile`：python:3.11-slim、非 root（uid 10001）、
  数据卷 `/data`；`PIP_INDEX_URL` 构建参数（默认官方源，受限网络可换镜像源）；
  `.dockerignore` 防止本地含真实 token 的 config.yaml 进入镜像。
- 新增 `scripts/verify_container.sh`：容器冒烟验证（无 yaml 纯 env 启动 /
  API 可用 / token 注入 / SQLite 落卷 / 非 root），已实测 5/5 通过。
- 新增自测 `backend/tests/test_config_env.py`（5 项）。
- 实测记录：本机 legacy docker builder 的 `COPY --chown` 只认数字 ID
  （宿主 umask 077 文件 600，必须 `--chown=10001:10001`）；PyPI 官方源
  不可达时用 `--build-arg PIP_INDEX_URL=<镜像>` 构建。

### 修复：「send:OneBot WS 未连接」半开连接死锁

- 现象：QQ 掉线重登后消息收得到、AI 回复也生成了，但发送一直报
  「OneBot WS 未连接」；面板显示「回复失败，未发送到 QQ」。
- 根因：NapCat 与后端的 WS 长时间无心跳后，看门狗只把 `is_online` 标为
  False 而**不关闭连接**——TCP 仍在，NapCat 认为连接正常永不重连，后端
  收到数据也不会恢复在线，双向死锁。
- 修复（`backend/app/onebot/ws_server.py`）：
  1. 收帧循环收到任何帧即恢复在线（连接活着就能发）；
  2. 心跳超时改为主动 `close(4001)`，触发 NapCat 反向 WS 重连。
- 新增自测 `backend/tests/test_ws_server.py`（自愈恢复 / 超时关连接 /
  健康连接不动 / 离线快速失败）。

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
