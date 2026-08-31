# -*- coding: utf-8 -*-
"""FastAPI 入口：装配 OneBot WS 服务端 / 引擎 / AI / 存储 / API。

启动（scripts/start.sh）：
    uvicorn app.main:app --host 0.0.0.0 --port 8001

生命周期（lifespan）：
    1. 初始化 DB
    2. 启动 OneBot WS 服务端看门狗 + 引擎 worker
    3. 事件接线：WS 消息事件 → ReplyService.submit
"""
from __future__ import annotations

import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request, WebSocket
from fastapi.responses import JSONResponse

from app import config as cfgmod
from app.api import routes
from app.engine.service import ReplyService
from app.onebot.events import EventBus
from app.onebot.gateway import OneBotGateway
from app.onebot.protocol import parse_message
from app.onebot.ws_server import OneBotWSServer
from app.realtime.hub import LiveHub
from app.store import db

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s [%(name)s] %(message)s",
)

log = logging.getLogger("main")

# ---------- 装配（import 时完成，路由注册在 lifespan 外） ----------

cfg = cfgmod.load_config()
ws_server = OneBotWSServer(cfg.onebot)
gateway = OneBotGateway(ws_server)
bus = EventBus()
hub = LiveHub()
service = ReplyService(cfg, gateway, bus, hub)

@asynccontextmanager
async def _lifespan(app: FastAPI):
    db.init_db()

    async def on_onebot_event(frame: dict) -> None:
        msg = parse_message(frame, gateway.self_id)
        if msg is not None:
            await service.submit(msg)

    ws_server.on_event = on_onebot_event
    await ws_server.start()
    await service.start()
    log.info("服务已启动: ws=%s api=/api", cfg.onebot.ws_path)
    try:
        yield
    finally:
        await service.stop()
        await ws_server.stop()
        log.info("服务已停止")
app = FastAPI(title="QQ AI AutoReply", version="0.1.0-demo", lifespan=_lifespan)

@app.middleware("http")
async def api_auth(request: Request, call_next):
    """Protect internal REST calls when a webui token is configured."""
    token = cfg.server.webui_token
    if token and request.url.path.startswith("/api/"):
        auth = request.headers.get("authorization", "")
        supplied = auth[7:].strip() if auth.lower().startswith("bearer ") else request.headers.get("x-api-key", "")
        if supplied != token:
            return JSONResponse({"detail": "unauthorized"}, status_code=401)
    return await call_next(request)


# OneBot 反向 WS 端点
@app.websocket(cfg.onebot.ws_path)
async def onebot_ws(ws: WebSocket):
    await ws_server.endpoint(ws)

# REST API
app.include_router(routes.router)

