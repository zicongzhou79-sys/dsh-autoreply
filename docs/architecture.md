# 架构说明

## 组件

```text
NapCat/QQ -> OneBot 11 reverse WebSocket -> FastAPI backend
                                              -> ReplyService (规则/归档/安全/发送)
                                              -> DSH host /dsh-qq/session (Session/Agent/模型/上下文唯一来源)
DSH Web -> dsh-qq-autoreply client -> local AutoReply REST
```

DSH 插件是用户入口，Python 服务是被插件管理的本地回复引擎。后端不再托管独立 WebUI。

## 生命周期

1. `app.main` 加载 YAML 配置并装配单例。
2. FastAPI lifespan 初始化 SQLite、OneBot 看门狗和回复 worker。
3. NapCat 反向连接 `/onebot/ws`。
4. OneBot message frame 经 `parse_message()` 转换后进入 `ReplyService` 队列。
5. 引擎落库、执行本地触发规则和安全检查；仅把当前消息及会话资源引用交给 DSH Session。
6. DSH Session 负责上下文、Agent、模型、工具和记忆，返回本轮回复。
7. AutoReply 对返回内容执行出站安全检查，通过 OneBot 发送并保存日志。
8. DSH 插件通过本地 `/api/*` 查看状态、修改配置和管理会话。

## 关键模块

- `onebot/`：协议解析、WS 双工通信和发送门面。
- `engine/`：触发决策、队列、安全护栏和回复编排；不向 DSH 发送本地历史上下文。
- `ai/`：保留兼容性纯函数，不参与正式 DSH Session 回复链路。
- `store/`：SQLite 消息、会话、日志和配置覆盖层。
- `api/`：插件使用的 REST 和实时事件接口。
- `integrations/dsh-qq-autoreply/`：DSH host/client 插件和唯一模型运行时入口。

## 配置优先级

`SQLite kv_config` 覆盖层高于 `backend/config.yaml`，高于代码默认值。`llm.provider/model` 指向 DSH runtime 的模型，temperature/max_tokens 为生成参数。Agent preset 的内容同步到 `persona.system_prompt`，workspace 路径同步到 `engine.workspace_dir`。

## 会话目录

选择 workspace 后，每个 QQ 会话默认使用：

```text
<workspace>/.dsh/qq-autoreply/<friend_or_group_key>
```

目录只作为 AutoReply 会话归档根目录；DSH 原生 session 仍由 DSH session store 管理。
