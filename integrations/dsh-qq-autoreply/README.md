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

**AutoReply → DSH（唯一智能运行时）**：AutoReply 将当前 QQ 消息交给绑定的 DSH Session/Agent。图片消息会在后端完成公网 URL 校验、大小和真实格式校验后，以 `image_url` 多模态内容传给 DSH；所选模型必须支持视觉输入。DSH Agent 负责上下文、工具、模型和记忆，Session 事件由 DSH persistence 插件落盘；AutoReply 不复制 Agent prompt 或本地历史。

- `GET /dsh-qq/health` —— AutoReply 健康探测
- `POST /dsh-qq/execute` —— DSH 工具执行（`{tool, args}`）
- `POST /dsh-qq/session` —— Session 创建、恢复和 Agent turn
- `GET /dsh-qq/persona` —— 兼容读取接口


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

> **依赖说明**：插件被 `link:` 到 profile 之外时，harness 包 `@deepseek-ai/dsh-attachment`
> 不在插件自己的解析路径上。插件现在对该包做**可选加载**：解析得到就用 harness 助手，
> 解析不到就退回 `ctx.attachments.saveImages` 公共 API（base64 校验语义一致），
> 因此即使 `node_modules` 里的软链被 `pnpm install` 清掉，插件也不会再加载失败。
> 若希望走 harness 自带助手，可补一条软链：
>
> ```bash
> ln -sfn ~/.dsh/profiles/node_modules/@deepseek-ai/dsh-attachment \
>   integrations/dsh-qq-autoreply/node_modules/@deepseek-ai/dsh-attachment
> ```

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