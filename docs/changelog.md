# 变更记录

## Unreleased

### 修复：NapCat 快速登录登错号（生产实战定位）

- 现象：每次容器重启都弹二维码，日志显示 `正在快速登录 2930XXXXX01`
  （八月测试的旧账号）而非机器人账号。
- 根因：napcat-docker 镜像 entrypoint 不读 ACCOUNT env，用
  `ls config/ | grep -oE 数字 | head -1`（字母序）选快速登录账号；
  迁移保留的多账号 `onebot11_*/napcat_*.json` 中旧账号文件抢占。
- 修复：隔离非机器人账号的账号配置文件（备份不删）→ 重启即自动快速
  登录正确账号，**免扫码**；迁移脚本固化该清理步骤。
- 实测：连续两次重启均自动快速登录成功（17:24 / 17:26），登录态持久
  符合预期，此前「每次重启都要扫码」的问题不复存在。
### 修复：compose 栈三连 bug（E2E 注入测试实战发现）

用「独占 OneBot WS 注入合成消息」的端到端测试法，在真实流量到来前
连续暴露并修复三个只在写路径上才会炸的问题：

1. **SQLite 只读**：迁移用 busybox(root) 拷贝 app.db 入卷 → 属主 root，
   uid 10001 的容器读正常、写全炸（首条消息即触发）。修：拷贝后
   `chown -R 10001:10001`，迁移脚本固化该步。
2. **DSH 桥接不可达**：配置 `engine.dsh.base_url=127.0.0.1:3080` 在容器
   内指向容器自身；且宿主 DSH web 只听回环，host-gateway 也到不了。
   修：config.py 新增 `AUTOREPLY_DSH_BASE_URL` env 覆盖（DB 配置不动，
   回滚宿主运行时无需改配置）+ compose 模板 v4 把 backend 放到 host
   网络（127.0.0.1 即宿主回环），NapCat 经 `backend:host-gateway` 别名
   回连。
3. **测试断言随模板演进更新**：host 网络下 backend 无端口发布，回环
   限定收敛到 NapCat WebUI。

- 插件测试 30 → 36 项；后端 42 项。
- 附：E2E 注入脚本要点（docker exec 容器内独占 WS 连接，天然可复用
  于回归验证），NapCat 快速登录在非优雅停机后会失效需重扫，运维手册
  已有对应条目。
### 新增：运维手册（双模式）与 A3 全新安装验证脚本（里程 A 预备）

- `docs/operations.md` 重写为双模式：compose 托管（架构/状态/日志/升级/
  备份/回滚 external/常见故障含 403 token 漂移、每会话目录失效）+ 旧版
  external 附录。
- `scripts/verify_fresh_install.sh`：npm 发布后验证全新安装链路（包存在/
  tarball 内容完整/JS 语法/ghcr 匿名可见/已发布包供给自检），未就绪时
  优雅 SKIP，可反复重跑；本地 npm pack 预检确认发布清单 5 文件齐全、
  供给自检逻辑实测通过。
### 修复：compose 模式会话目录能力与 token 漂移（里程 A 迁移后实战修复）

- 正式迁移后发现两个实战问题：
  1. **每会话目录丢失**：容器内看不到宿主 workspace/session 路径，
     `_session_paths` 优雅降级为空 → Agent 失去工作区绑定；
  2. **token 漂移**：迁移脚本用 sed 事后改 .env，provision.json 里仍是
     生成 token——任何一次重新供给都会把生产 token 覆盖回生成值，
     NapCat 反向 WS 报 403（live 实测触发）。
- 修复：
  1. compose.yml 模板 v2：WORKSPACE_DIR/SESSION_DIR 路径对等挂载
     （宿主路径 = 容器路径），未配置时挂占位目录无副作用；模板带版本
     标记，旧文件在下次供给时自动重生成；
  2. `onebot_token`/`webui_token` 改走供给参数（provision.json 与 .env
     单一来源一致），迁移脚本废弃 sed 事后改写；
  3. 会话目录权限用 ACL 共享（setfacl 授权容器 uid 10001 读写 +
     默认 ACL 继承），宿主 DSH 用户属主不变——属主可自行 setfacl，
     无需 root。
- 迁移脚本：从 backend config.yaml 读取 workspace/session 目录传入供给；
  迁移完成实测容器内会话目录可写、宿主仍可写、NapCat 反向 WS 重连成功。
- 插件测试 23 → 30 项。
### 新增：面板向导化 + provider 自动检测（里程 A / A4）

- provider 自动检测（`resolveProvider`）：显式 `AUTOREPLY_PROVIDER` 优先；
  未设置时「`~/.dsh/qq-autoreply/provision.json` 存在 → compose」。迁移
  完成后重启 DSH 即自动切托管模式，杜绝 external 的 start.sh 与 compose
  栈抢 8001 端口。
- 新增 `/dsh-qq/compose` 路由：托管项目/账号/端口/服务状态（compose ps）
  /安装体检（供给+token 对齐+双服务），面板「托管与安装」区数据源。
- 面板（client）：新增「托管与安装（compose）」区（模式/账号/端口/栈服务
  /体检徽标）；compose 模式下 QQ 登录 iframe 改用带 token 的 WebUI 地址，
  扫码页免输 token。
- 测试：resolveProvider 5 项分支断言，插件测试 18 → 23 项。
### 新增：发布工程与迁移路径（B 方案 B3）

- `scripts/migrate_to_compose.sh`：external → compose 托管栈迁移。
  token 保持生产值不变（QQ 登录态与反向 WS 凭据无缝沿用）；NapCat
  登录态经 busybox 助手容器复制（宿主用户读不了容器 root 属主文件）；
  onebot11 反向 WS 改写为 compose 网络地址（**必须在复制之后执行**，
  否则被生产原版覆盖——试运行实测抓出的时序 bug）；ACCOUNT 取自后端
  `/api/status` 登录账号（配置目录残留他账号文件，按文件名取会登错号）。
  `MIGRATE_DRY_RUN=1` 试运行不动任何服务，已实测通过（url 改写、
  token 对齐、ACCOUNT=登录账号 三项断言全绿）。
- CI：`.github/workflows/ci.yml`（pytest / 插件语法+测试 / 镜像构建+
  容器冒烟）；`.github/workflows/docker-publish.yml`（打 tag 多架构
  buildx → GHCR，NPM_TOKEN 配置后同流水线发 npm）。
- 插件 README 重写：双模式说明（external/compose）、compose 安装故事、
  工具清单、修正过时的目录读取描述（connection.api → remote 命名空间）。

### 新增：插件 Compose 托管生命周期（B 方案 B2）

- 插件新增 ComposeProvider（`AUTOREPLY_PROVIDER=compose` 启用）：AutoReply
  栈（backend + NapCat）由插件经 `docker compose` 托管，external 模式
  （默认）保持 start.sh 行为不变，生产链路零影响。
- 供给（`qq_autoreply_compose_provision` 工具，幂等）：生成
  `~/.dsh/qq-autoreply/` 下的 compose.yml/.env/provision.json 与 NapCat
  配置；token 自动生成并同值注入后端（env）与 NapCat（onebot11_账号.json），
  免去手工对齐；传 account（QQ 号）才生成反向 WS 配置并随 start 拉起
  NapCat。反向 WS 指向 compose 网络内 `ws://backend:8001/onebot/ws`，
  不再依赖 172.17.0.1 桥接。
- 生命周期（`qq_autoreply_service_control`，语义与 external 对齐）：
  start=供给+up（backend 未配账号时仅 backend）+等就绪+开总开关；
  stop=关总开关+stop backend（NapCat 保持运行）；restart=重启 backend。
- compose 要点：backend 命名卷 + 自健康检查（python urlopen，slim 无 curl），
  NapCat 等 backend healthy 后启动；端口仅绑 127.0.0.1。
- client.js：面板三处硬编码 URL（实时 WS、NapCat WebUI ×2）改为按
  `location.hostname` 派生，远程/隧道访问不再断连。
- 测试：新增 `tests/compose.provision.test.mjs`（18 项：幂等供给/token
  稳定/文件生成/token 对齐/回环绑定/健康门控/换账号），`npm test` 串联
  两个插件测试；实测隔离 compose 栈（项目 qq-autoreply-test，端口
  18001/18099）：compose config 合法 → up backend 健康(healthy) →
  restart → stop 端口关闭 → down -v 清理，全程未触碰生产栈。
- 版本：插件 0.2.0 → 0.3.0。

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
