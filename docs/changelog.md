# 变更记录

## Unreleased

### 插件化

- DSH 插件成为唯一用户控制入口。
- 控制入口移动到 DSH 侧栏设置同组区域。
- 控制面板支持服务启停、QQ 登录入口、模型、Agent preset 和 workspace 选择。
- Agent preset 内容同步到 AutoReply system prompt。
- Workspace 路径同步到引擎配置，并为每个 QQ 会话生成独立会话目录。

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
