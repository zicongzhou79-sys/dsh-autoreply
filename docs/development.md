# 开发指南

## 环境

- Python 3.11+
- Node.js 20+
- Docker
- DSH CLI

安装后端依赖：

```bash
python -m venv .venv
. .venv/bin/activate
pip install -r backend/requirements.txt
```

## 测试

```bash
pytest -q backend/tests
node --check integrations/dsh-qq-autoreply/lib/client.js
```

## 修改原则

- 用户界面代码放在 DSH client plugin，不重新添加后端 WebUI。
- OneBot 发送必须经过 `OneBotGateway`。
- 配置修改必须经过 `config_mgr`，不要直接写 YAML。
- 新数据库字段必须在 `init_db()` 中提供旧库迁移。
- 外部调用必须有超时；DSH 模型生成失败必须记录 failed，不发送空回复。
- 不提交 `backend/config.yaml`、`data/`、`logs/` 或 NapCat 登录态。

## 调试

前台运行：

```bash
cd backend
python -m uvicorn app.main:app --host 127.0.0.1 --port 8001
```

查看 DSH 插件加载错误时，检查插件是否已重新安装到目标 profile，并重启 DSH Web。

## 代码分层

协议层不能依赖引擎；引擎不能拼接 OneBot JSON；API 层通过单例状态调用业务；DSH client 只负责展示和 DSH 原生 API 读取，host 侧负责访问 AutoReply。
