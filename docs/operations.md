# 运维手册

> 两种运行模式：**compose 托管**（推荐，容器自愈、与 DSH 生命周期解耦）与 **external**（旧版，宿主 start.sh）。
> 当前所处模式：看插件 `/dsh-qq/health` 返回的 `provider` 字段，或面板「托管与安装」区。

---

## 一、compose 托管模式

### 架构一览

```
DSH 插件（宿主，lib/index.js）
  └─ docker compose（~/.dsh/qq-autoreply/）
       ├─ backend   qq-autoreply-backend   127.0.0.1:8001（healthcheck）
       └─ napcat    mlikiowa/napcat-docker 127.0.0.1:6099（WebUI）
```

| 路径 | 内容 |
|---|---|
| `~/.dsh/qq-autoreply/compose.yml` | 栈定义（模板带版本标记，供给时自动升级重生成） |
| `~/.dsh/qq-autoreply/.env` | 唯一变量入口（镜像/端口/token/工作区目录） |
| `~/.dsh/qq-autoreply/napcat/config/` | onebot11_*.json、webui.json |
| `~/.dsh/qq-autoreply/napcat/qq-config/` | QQ 登录态（扫码一次后持久） |
| 卷 `qq-autoreply_backend-data` → `/data` | SQLite（config/日志/绑定） |

反向 WS：`ws://backend:8001/onebot/ws`（compose 网络内，token 自动对齐）。

### 状态检查

```bash
curl http://127.0.0.1:8001/api/status        # connected / login
cd ~/.dsh/qq-autoreply && docker compose ps  # 服务与健康
curl http://127.0.0.1:3080/dsh-qq/compose    # 面板「托管与安装」同源数据
```

### 日志

```bash
cd ~/.dsh/qq-autoreply
docker compose logs -f backend    # 后端（回复决策/错误）
docker compose logs -f napcat     # 登录事件/反向 WS
```

### 日常操作

```bash
cd ~/.dsh/qq-autoreply
docker compose restart backend    # 只重启后端
docker compose restart            # 全栈重启（登录态持久，免扫码）
```

面板操作（推荐）：启动/停止/重启按钮走插件 service_control（compose 感知）。

### 升级

```bash
cd ~/.dsh/qq-autoreply
docker pull ghcr.io/zicongzhou79-sys/dsh-autoreply-backend:latest
sed -i 's|^BACKEND_IMAGE=.*|BACKEND_IMAGE=ghcr.io/zicongzhou79-sys/dsh-autoreply-backend:latest|' .env
docker compose up -d backend      # 只重建后端，QQ 登录不受影响
```

### 备份 / 恢复

```bash
# SQLite（更稳妥先 stop backend）
docker run --rm -v qq-autoreply_backend-data:/data -v "$PWD":/bak busybox \
  cp /data/app.db /bak/app.db.$(date +%F).bak
# QQ 登录态
docker cp qq-autoreply-napcat:/app/.config/QQ ./qq-config-backup
# 恢复 = 反向拷回后 docker compose up -d
```

### 回滚到 external

```bash
cd ~/.dsh/qq-autoreply && docker compose down   # 停 compose 栈（数据保留）
bash scripts/start.sh --bg                       # 宿主 uvicorn 回到 8001
docker start napcat                              # 旧 napcat 容器仍在（迁移未删除）
# 插件侧：设 AUTOREPLY_PROVIDER=external（或临时移走 provision.json 后重启 DSH）
```

### 常见故障

| 症状 | 原因 | 处理 |
|---|---|---|
| napcat 日志 `反向WebSocket … 403` | token 漂移（.env 与 onebot11_*.json 不一致） | 用 `qq_autoreply_compose_provision` 重跑供给（token 走 provision.json 单一来源），勿只手工改 .env |
| `connected=false, login=false` | QQ 登录态失效 | 面板 QQ 登录区重新扫码（compose 模式 iframe 已带 token） |
| 重启后弹二维码：`正在快速登录 <错误账号>` | 镜像 entrypoint 按 `ls config/` 字母序取第一个带 QQ 号的文件选快速登录账号；残留的其它账号 `onebot11_*/napcat_*.json` 会抢占 | 把非机器人账号的 `config/onebot11_<x>.json`、`napcat_<x>.json` 移出（如 `stale-backup/`），重启即自动快速登录正确账号 |
| backend 反复重启 | `docker compose logs backend` 看报错；常见 .env 镜像名拼错 | 修正 .env 后 `up -d` |
| 端口 8001 被占 | 旧宿主 uvicorn 残留 | `pkill -f "uvicorn.*8001"` 后 `docker compose up -d` |
| 每会话目录失效 | WORKSPACE_DIR/SESSION_DIR 未配置或权限缺失 | `.env` 配齐宿主路径；`setfacl -R -m u:10001:rwX <session_dir>`；`up -d backend` |

### 设计要点

- **DSH 重启不再连带杀后端**：compose 容器由 docker 守护进程托管（`restart: unless-stopped`），与 DSH 进程组/cgroup 解耦。
- **token 单一来源**：onebot token 经供给参数写入 provision.json + .env + onebot11_*.json 三处一致；任何绕过供给的手工改法都可能触发 403。
- **路径对等挂载**：WORKSPACE_DIR/SESSION_DIR 宿主路径 = 容器路径，后端把路径字符串传给宿主侧 DSH 时天然有效；未配置时挂占位目录，无副作用。
- **provider 自动检测**：供给目录存在即自动 compose；显式 `AUTOREPLY_PROVIDER` 永远优先。

---

## 二、external 模式（旧版附录）

### 状态检查

```bash
curl http://127.0.0.1:8001/api/status
curl http://127.0.0.1:3080/dsh-qq/health
curl http://127.0.0.1:6099/webui/
```

重点确认：NapCat 容器在运行、OneBot WS 已连接、QQ 登录信息存在、DSH host 插件健康检查 200、DSH 模型运行时在线且已选 provider/model。

### 日志与备份

- 后台启动日志：`logs/backend.log`
- NapCat 日志：`docker logs -f napcat`
- 备份：`cp data/app.db data/app.db.bak`（先停止服务）
- QQ 登录态/NapCat 数据在 `NAPCAT_DATA_BASE`（默认 `$HOME/napcat-data`），勿直接删除，否则需重新扫码。

### 常见问题

- **OneBot 未连接**：NapCat 是否登录、反向 WS URL/token 是否一致、8001 端口占用。
- **QQ 未登录**：面板内嵌 NapCat WebUI 扫码，或直接访问 `http://127.0.0.1:6099/webui/`。
- **没有自动回复**：检查总开关、会话开关、群聊触发模式、黑白名单、敏感词、频率限制；`/api/logs` 看 skip 原因。
- **DSH 工具不可用**：模型/工具不可用时工具增强跳过；模型生成失败记录 `failed` 且不发空回复。检查 DSH host 端口、插件加载、provider/model、`engine.dsh.reply_tools` 白名单。
