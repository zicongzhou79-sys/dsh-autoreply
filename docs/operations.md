# 运维手册

## 状态检查

```bash
curl http://127.0.0.1:8001/api/status
curl http://127.0.0.1:3080/dsh-qq/health
curl http://127.0.0.1:6099/webui/
```

重点确认：

- NapCat 容器正在运行。
- OneBot WebSocket 已连接。
- QQ 登录信息存在。
- DSH host 插件健康检查返回 200。
- DSH 模型运行时在线且已选择 provider/model。

## 日志

后台启动日志位于：

```text
logs/backend.log
```

NapCat 日志：

```bash
docker logs -f napcat
```

## 数据备份

停止 AutoReply 后备份：

```bash
cp data/app.db data/app.db.bak
```

QQ 登录态和 NapCat 数据位于 `NAPCAT_DATA_BASE` 指定目录，默认是 `$HOME/napcat-data`。不要直接删除该目录，否则可能需要重新扫码。

## 常见问题

### OneBot 未连接

检查 NapCat 是否登录、反向 WS URL 是否正确、token 是否一致，以及 8001 端口是否被占用。

### QQ 未登录

在 DSH QQ AutoReply 面板内打开嵌入的 NapCat WebUI 完成扫码。也可以直接访问 `http://127.0.0.1:6099/webui/`。

### 没有自动回复

检查总开关、会话开关、群聊触发模式、白名单、黑名单、敏感词和频率限制。使用 `/api/logs` 查看具体 skip 原因。

### DSH 工具不可用

DSH 模型或工具不可用时，工具增强会被跳过；模型生成失败则记录 `failed` 且不会发送空回复。检查 DSH host 端口、插件加载状态、provider/model 和 `engine.dsh.reply_tools` 白名单。
