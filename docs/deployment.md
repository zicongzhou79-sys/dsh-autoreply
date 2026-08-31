# 部署指南

## 依赖

- Docker 已安装并可运行。
- QQ 已登录或准备通过 NapCat WebUI 扫码。
- Python 3.11+ 和 Node.js 20+。
- DSH Web profile 可加载插件。
- DSH Web profile 可加载插件并提供可用模型运行时。

## NapCat

首次部署或需要重建容器时：

```bash
bash scripts/rebuild_napcat.sh
```

脚本使用 `mlikiowa/napcat-docker:v4.3.5`，容器名为 `napcat`，NapCat WebUI 默认映射到 `127.0.0.1:6099`。

OneBot 反向地址必须指向运行 Python 后端主机的 Docker 网关，例如当前配置中的 `ws://172.17.0.1:8001/onebot/ws`。OneBot token 必须与 `backend/config.yaml` 一致。

## 后端

```bash
bash scripts/start.sh --bg
```

前台运行：

```bash
bash scripts/start.sh
```

停止后端但保留 NapCat：

```bash
bash scripts/start.sh --stop
```

## DSH 插件

```bash
dsh plugin --profile web add ./integrations/dsh-qq-autoreply
```

重启 DSH Web 后，在侧栏设置同组位置打开 QQ AutoReply 控制面板。

## 配置

将 `backend/config.example.yaml` 复制为 `backend/config.yaml`，填写 OneBot token，并在 DSH 控制面板选择 provider/model。模型凭据由 DSH 管理，生产环境不要提交真实配置文件。
