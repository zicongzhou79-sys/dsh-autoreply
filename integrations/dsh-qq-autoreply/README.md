# dsh-qq-autoreply

DeepSeek Harness ↔ QQ AutoReply 双向互通插件。

## 功能

**DSH 会话 → AutoReply（工具管理）**，DSH agent 可直接调用以下模型工具：

| 工具 | 作用 |
|---|---|
| `qq_autoreply_status` | 查看运行状态（连接/登录/DSH 模型/统计） |
| `qq_autoreply_config_get` | 读取完整配置 |
| `qq_autoreply_config_set` | 修改任意配置（path+value 或 batch），立即生效 |
| `qq_autoreply_sessions` | 会话列表 |
| `qq_autoreply_messages` | 会话消息历史 |
| `qq_autoreply_logs` | 回复决策日志 |
| `qq_autoreply_test_llm` | 通过 DSH runtime 测试当前模型 |

**AutoReply → DSH（唯一模型生成与可选回复增强）**，AutoReply 引擎生成回复时必须调用 DSH `/dsh-qq/llm`；生成前可选调用 DSH 工具：

- `GET /dsh-qq/health` —— AutoReply 健康探测
- `POST /dsh-qq/execute` —— 工具执行（`{tool, args}`）
- `GET /dsh-qq/persona` —— 人设读取
- 内置增强工具：`reply_knowledge`（账号状态摘要，供回复上下文）

## 安装

```bash
# 开发期本地安装（需要网络时）：
dsh plugin --profile web add /path/to/dsh-qq-autoreply
# 或离线手动安装：把本包复制到
#   ~/.nvm/.../lib/node_modules/dsh-qq-autoreply/ 或
#   ~/.dsh/profiles/web/node_modules/dsh-qq-autoreply/
# 并在 ~/.dsh/profiles/web/package.json 的 dsh.profile.bundles 列表追加 "dsh-qq-autoreply"
# 然后重启 DSH web（守护器会自动拉起）
```

## DSH 控制面板

插件控制入口位于 DSH 侧栏设置入口同一组操作区域，点击后打开 QQ AutoReply 控制面板。当前面板已经接入：

- 一键启动/停止 NapCat 与 AutoReply 后端，并控制总开关
- QQ 登录状态和 NapCat WebUI 扫码入口
- DSH 当前模型目录选择（模型服务 / 模型）
- DSH Agent preset 选择
- DSH workspace 选择
- QQ 会话、最近回复日志和运行统计

模型、Agent 和 workspace 分别通过 DSH connection API 的 `llm.models`、`agentPresets.list`、`workspace.list` 读取。模型选择会同步到 AutoReply 的 `llm.provider` 和 `llm.model` 配置；模型凭据由 DSH 管理。Agent preset 的完整 `content` 会同步为 `persona.system_prompt`，preset ID 同时保存到 `engine.dsh.agent_preset`。Workspace 的实际路径会写入 `engine.workspace_dir`，并为每个 QQ 会话生成独立的 `engine.session_dir/<chat_key>` 目录；旧数据库会在启动时自动补充目录字段。

QQ 扫码页现在直接嵌入控制面板内，默认地址为 `http://127.0.0.1:6099/webui/`；二维码和登录凭据仍由 NapCat 管理。

## 配置

- `AUTOREPLY_URL` 环境变量：AutoReply 地址（默认 `http://127.0.0.1:8001`）
- `AUTOREPLY_TOKEN`：若 AutoReply 开了 API 鉴权（默认空=无鉴权）

## 注意

- 插件用 `node:http` 直连 AutoReply（不走系统代理），避免 DSH 进程的
  `ALL_PROXY=socks://...` 影响 localhost 调用
- `/dsh-qq/health` 保持轻量（不递归调 AutoReply），避免探测环路延迟