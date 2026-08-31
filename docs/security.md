# 安全说明

## 凭据

以下内容属于敏感数据：

- OneBot access token。
- NapCat WebUI token。
- DSH host 管理的模型凭据（AutoReply 不直接持有）。
- QQ 登录态。
- 消息正文和回复日志。

`backend/config.yaml`、`data/`、`logs/` 和 NapCat QQ 数据不应提交到版本库或暴露到公网。

## 网络边界

AutoReply 后端建议只监听本机或受控 Docker 网络。若必须监听 `0.0.0.0`，应在反向代理或防火墙层限制来源，并实现 REST API 鉴权。

OneBot WebSocket 必须启用 token 鉴权。DSH host 到 AutoReply 的调用应只允许本机来源。

## Workspace

Workspace 路径来自 DSH 的注册表。所有由 QQ 消息触发的文件访问都应限制在已选 workspace 或会话目录内，不执行收到的脚本或可执行文件。

会话目录按 chat key 生成安全文件名，不能直接把 QQ 消息内容作为路径。

## LLM 数据

通过 DSH runtime 发送模型请求前应考虑：

- 消息是否包含个人信息。
- 是否包含图片或文件。
- Agent 是否允许外部工具。
- 是否需要人工确认。
- 是否需要限制上下文长度。

## 破坏性操作

停止服务、退出 QQ、清空消息、删除会话目录和修改工具权限都应经过明确的用户确认。当前服务停止会保留 NapCat 容器，以避免丢失登录态。
