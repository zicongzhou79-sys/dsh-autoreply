# API 参考

## AutoReply REST

默认地址由 `AUTOREPLY_URL` 指定，通常为 `http://127.0.0.1:8001`。

| 方法 | 路径 | 用途 |
|---|---|---|
| GET | `/api/status` | OneBot、QQ、LLM、DSH 和统计状态 |
| GET | `/api/sessions` | 会话列表 |
| POST | `/api/sessions/auto` | 修改会话自动回复开关 |
| GET | `/api/messages?chat_key=&limit=` | 读取消息 |
| DELETE | `/api/messages?chat_key=` | 清空会话消息 |
| GET | `/api/logs?decision=&limit=` | 读取回复日志 |
| GET | `/api/config` | 读取生效配置 |
| POST | `/api/config` | 使用 `path/value` 或 `batch` 修改配置 |
| POST | `/api/config/delete` | 删除 SQLite 覆盖项 |
| POST | `/api/config/test_llm` | 通过 DSH runtime 测试当前模型 |
| WS | `/api/ws/live` | 接收实时消息事件 |

配置修改示例：

```json
{"batch":{"engine.master_switch":true,"llm.provider":"chatgpt","llm.model":"gpt-5.6-luna"}}
```

## DSH host 路由

插件 host 暴露：

- `GET /dsh-qq/health`
- `POST /dsh-qq/execute`，请求体为 `{ "tool": "status", "args": {} }`
- `GET /dsh-qq/persona`（兼容读取接口）
- `POST /dsh-qq/session`，支持 `list`、`get`、`create`、`chat`；`chat` 只接收当前消息和 DSH 资源引用，Session 上下文由 DSH host 持有
- `POST /dsh-qq/llm`（旧 host 兼容接口，正式自动回复不使用）

## DSH 原生 API

client 通过 DSH connection API 读取：

- `api.llm.models({})`
- `api.agentPresets.list({})`
- `api.agentPresets.read({ agentPreset })`
- `api.workspace.list({})`

## OneBot

NapCat 连接 `/onebot/ws` 时携带 `Authorization: Bearer <onebot.access_token>`。后端通过 echo 关联动作请求和响应。

## 错误处理

DSH host 工具失败返回 `{ok:false,error}`；工具增强失败只跳过增强信息；DSH 模型生成失败记录为 `failed`，不会回退到其他模型通道。
