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
| `qq_autoreply_service_control` | 一键启动/停止/重启（external=脚本，compose=托管栈） |
| `qq_autoreply_compose_provision` | （compose 模式）生成/更新栈供给，token 自动对齐 |

**AutoReply → DSH（唯一智能运行时）**：AutoReply 将当前 QQ 消息交给绑定的 DSH Session/Agent。图片消息会在后端完成公网 URL 校验、大小和真实格式校验后，以 `image_url` 多模态内容传给 DSH；所选模型必须支持视觉输入。DSH Agent 负责上下文、工具、模型和记忆，Session 事件由 DSH persistence 插件落盘；AutoReply 不复制 Agent prompt 或本地历史。

- `GET /dsh-qq/health` —— AutoReply 健康探测（返回 `provider`）
- `POST /dsh-qq/execute` —— DSH 工具执行（`{tool, args}`）
- `POST /dsh-qq/session` —— Session 创建、恢复和 Agent turn
- `GET /dsh-qq/persona` —— 兼容读取接口

## 安装

```bash
# 从 npm（发布后）：
dsh plugin --profile web add dsh-qq-autoreply
# 开发期本地安装：
dsh plugin --profile web add /path/to/dsh-qq-autoreply
# 然后重启 DSH web（守护器会自动拉起）
```

> **依赖说明**：插件被 `link:` 到 profile 之外时，harness 包 `@deepseek-ai/dsh-attachment`
> 不在插件自己的解析路径上。插件对该包做**可选加载**：解析得到就用 harness 助手，
> 解析不到就退回 `ctx.attachments.saveImages` 公共 API（base64 校验语义一致），
> 因此即使 `node_modules` 里的软链被 `pnpm install` 清掉，插件也不会加载失败。

## 两种运行模式（AUTOREPLY_PROVIDER）

### external（默认）—— 自管部署

插件调用 AutoReply 仓库的 `scripts/start.sh` 拉起 NapCat 容器 + 宿主 uvicorn。
适合开发机和已有部署。相关环境变量：

- `AUTOREPLY_DIR`：AutoReply 仓库路径（external 模式必填或用下条）
- `AUTOREPLY_START_SCRIPT`：直接指定启动脚本路径
- `AUTOREPLY_URL`：AutoReply 地址（默认 `http://127.0.0.1:8001`）
- `AUTOREPLY_TOKEN`：AutoReply API Bearer token（默认空=无鉴权）

### compose —— 插件全托管（推荐新用户）

```bash
# DSH 环境（或插件进程环境）加：
AUTOREPLY_PROVIDER=compose
# 可选：AUTOREPLY_IMAGE=<后端镜像>，默认 qq-autoreply-backend:latest
```

之后全部通过工具/面板完成：

1. `qq_autoreply_compose_provision` 传 `account`（QQ 号）→ 在
   `~/.dsh/qq-autoreply/` 生成 compose.yml/.env/NapCat 配置；
   **token 自动生成并同值注入后端与 NapCat**，无需手工对齐
2. `qq_autoreply_service_control {action:"start"}` → 拉起 backend（健康门控）
   + napcat
3. 打开 `http://127.0.0.1:6099/webui/` 扫码登录（WebUI token 见 provision.json）

要点：反向 WS 走 compose 网络内 `ws://backend:8001/onebot/ws`（不依赖
docker0 网桥地址）；所有端口只绑 127.0.0.1；stop 只停 backend，NapCat
保持运行登录态不丢。存量部署迁移：`bash scripts/migrate_to_compose.sh`。

## DSH 控制面板

插件控制入口位于 DSH 侧栏设置入口同一组操作区域，点击后打开 QQ AutoReply 控制面板。当前面板已经接入：

- 一键启动/停止 NapCat 与 AutoReply 后端，并控制总开关
- QQ 登录状态和 NapCat WebUI 扫码入口
- DSH 模型目录 / Agent preset / workspace 选择（会话绑定区内）

模型、Agent preset 与 workspace 通过 DSH 客户端 remote 命名空间读取
（`remote.session.modelCatalog()`、`remote.agentPresets.list()`，
`connection.api.*` 仅作旧版兜底）。模型选择会同步到 AutoReply 的
`llm.provider` 和 `llm.model` 配置；模型凭据由 DSH 管理。Agent preset 的
完整 `content` 会同步为 `persona.system_prompt`，preset ID 同时保存到
`engine.dsh.agent_preset`。Workspace 的实际路径会写入
`engine.workspace_dir`，并为每个 QQ 会话生成独立的
`engine.session_dir/<chat_key>` 目录。

QQ 扫码页内嵌在控制面板中；WebUI 地址按页面主机名派生（本机为
`http://127.0.0.1:6099/webui/`），二维码和登录凭据仍由 NapCat 管理。

## 测试

```bash
npm test   # client 面板测试 + compose 供给测试（纯 Node，无 Docker 依赖）
```

## 注意

- 插件用 `node:http` 直连 AutoReply（不走系统代理），避免 DSH 进程的
  `ALL_PROXY=socks://...` 影响 localhost 调用
- `/dsh-qq/health` 保持轻量（不递归调 AutoReply），避免探测环路延迟
- 兼容矩阵：目录读取需要 DSH 客户端提供 `remote.session` /
  `remote.agentPresets` 命名空间；旧版 `connection.api` 自动兜底
