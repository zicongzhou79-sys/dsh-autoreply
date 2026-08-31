# -*- coding: utf-8 -*-
"""REST API 路由聚合。

端点一览：
GET  /api/status            连接/登录/LLM 状态 + 今日统计
GET  /api/sessions          会话列表
GET  /api/messages          会话消息（?chat_key=&limit=）
DELETE /api/messages        清空会话历史（?chat_key=）
POST /api/sessions/auto     会话自动回复开关（{chat_key, auto_on})
GET  /api/logs              回复日志（?decision=&limit=）
GET  /api/config            配置视图（扁平）
POST /api/config            保存配置项（{path, value} 或 {batch: {...}}）
POST /api/config/test_llm   LLM 测试连接
GET  /api/events.ping       心跳探活（可选，前端用）
"""
from __future__ import annotations

import logging
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Request, WebSocket, WebSocketDisconnect

from app import config_mgr
from app.engine.service import ReplyService
from app.onebot.gateway import OneBotGateway
from app.store import db

log = logging.getLogger("api")
router = APIRouter(prefix="/api")


# ---------- 依赖注入 ----------


def bounded_limit(value: int, default: int = 100, maximum: int = 500) -> int:
    """Keep plugin-controlled list queries finite and predictable."""
    try:
        return max(1, min(int(value), maximum))
    except (TypeError, ValueError):
        return default

# 装配在 app.main 模块级完成，这里直接引用单例（避免循环依赖用延迟导入）

def get_app_state(request: Request) -> dict:
    from app.main import gateway, hub, service
    return {"gateway": gateway, "service": service, "hub": hub}


# ---------- 状态 ----------

@router.get("/status")
async def api_status(st: dict = Depends(get_app_state)) -> dict:
    gateway: OneBotGateway = st["gateway"]
    service: ReplyService = st["service"]
    cfg = service.refresh_config() or service.cfg
    login = gateway.login_info or {}
    dsh_online = await service.dsh.probe() if service.dsh.enabled else False
    llm_ok = bool(dsh_online and cfg.llm.provider and cfg.llm.model)
    return {
        "onebot_connected": gateway.is_online,
        "onebot_login": bool(login),
        "login_info": {"user_id": login.get("user_id"), "nickname": login.get("nickname")}
        if login else None,
        "llm_configured": llm_ok,
        "llm_model": cfg.llm.model if llm_ok else "",
        "master_switch": cfg.engine.master_switch,
        "dsh_enabled": service.dsh.enabled,
        "dsh_online": dsh_online,
        "dsh_reply_tools": list(service.dsh.cfg.reply_tools or []),
        "stats": db.today_stats(),
        "version": "0.1.0-demo",
        "ts": __import__("time").time(),
    }


# ---------- 会话与消息 ----------

@router.get("/sessions")
async def api_sessions(limit: int = 100) -> dict:
    return {"sessions": db.list_sessions(limit=bounded_limit(limit))}


@router.post("/sessions/auto")
async def api_sessions_auto(body: dict) -> dict:
    chat_key = body.get("chat_key", "")
    auto_on = bool(body.get("auto_on", False))
    if not chat_key:
        raise HTTPException(400, "chat_key 不能为空")
    db.set_session_auto(chat_key, auto_on)
    return {"ok": True}

@router.patch("/sessions/binding")
async def api_session_binding(body: dict, st: dict = Depends(get_app_state)) -> dict:
    chat_key = str(body.get("chat_key", "")).strip()
    if not chat_key:
        raise HTTPException(400, "chat_key 不能为空")
    allowed = {"agent_preset", "model_provider", "model_name", "dsh_session_id", "workspace_dir", "session_dir"}
    patch = {key: body[key] for key in allowed if key in body and body[key] is not None}
    from pathlib import Path
    if "workspace_dir" in patch and patch["workspace_dir"]:
        workspace = Path(patch["workspace_dir"]).expanduser().resolve()
        if not workspace.is_dir():
            raise HTTPException(400, "workspace_dir 不存在或不是目录")
        patch["workspace_dir"] = str(workspace)
    if "session_dir" in patch and patch["session_dir"]:
        session_dir = Path(patch["session_dir"]).expanduser().resolve()
        base = Path(patch.get("workspace_dir") or st["service"].cfg.engine.workspace_dir or "").expanduser().resolve()
        if not base or base == session_dir or base not in session_dir.parents:
            raise HTTPException(400, "session_dir 必须在 workspace 目录内")
        patch["session_dir"] = str(session_dir)
    if not db.update_session_binding(chat_key, **patch):
        raise HTTPException(404, "会话不存在")
    return {"ok": True, "session": db.get_session(chat_key)}



@router.get("/messages")
async def api_messages(chat_key: str, limit: int = 200) -> dict:
    rows = db.messages_range(chat_key, limit=bounded_limit(limit, 200))
    for row in rows:
        row["attachments"] = db.list_attachments(row["id"])
    return {"chat_key": chat_key, "messages": rows}


@router.delete("/messages")
async def api_messages_clear(chat_key: str) -> dict:
    db.clear_session_history(chat_key)
    return {"ok": True}


# ---------- 日志 ----------

@router.get("/logs")
async def api_logs(decision: str | None = None, limit: int = 200) -> dict:
    return {"logs": db.list_reply_logs(limit=bounded_limit(limit, 200), decision=decision)}


# ---------- 配置 ----------

@router.get("/config")
async def api_get_config() -> dict:
    cfg = config_mgr.all_settings()
    llm = cfg.get("llm") or {}
    return {"config": cfg}


@router.post("/config")
async def api_set_config(body: dict) -> dict:
    batch = body.get("batch")
    path = body.get("path")
    value = body.get("value")
    if batch and isinstance(batch, dict):
        for k, v in batch.items():
            try:
                config_mgr.set_setting(k, v)
            except ValueError as e:
                raise HTTPException(400, str(e)) from e
        return {"ok": True, "saved": list(batch.keys())}
    if not path:
        raise HTTPException(400, "path 或 batch 必填")
    try:
        config_mgr.set_setting(path, value)
    except ValueError as e:
        raise HTTPException(400, str(e)) from e
    return {"ok": True, "path": path}


@router.post("/config/delete")
async def api_delete_config(body: dict) -> dict:
    path = body.get("path", "")
    if not path:
        raise HTTPException(400, "path 必填")
    config_mgr.delete_setting(path)
    return {"ok": True}


@router.post("/config/test_llm")
async def api_test_llm(st: dict = Depends(get_app_state)) -> dict:
    service: ReplyService = st["service"]
    service.refresh_config()
    cfg = service.cfg
    try:
        session_id = await service.dsh.create_session(
            "test_llm",
            agent_preset=cfg.engine.dsh.agent_preset,
            provider=cfg.llm.provider,
            model=cfg.llm.model,
            workspace_id=cfg.engine.workspace_dir,
        )
        reply = await service.dsh.session_chat(
            session_id, "test_llm", "ping",
            cfg.llm.provider, cfg.llm.model,
            cfg.engine.dsh.agent_preset, cfg.engine.workspace_dir,
            0, 5,
        )
        return {"ok": True, "model": cfg.llm.model, "reply": reply[:50]}
    except Exception as e:
        return {"ok": False, "error": str(e)[:200]}


# ---------- 实时 WS ----------

@router.websocket("/ws/live")
async def ws_live(ws: WebSocket):
    from app.main import hub
    await hub.connect(ws)
    try:
        while True:
            await ws.receive_text()   # 仅保持连接；前端可发 ping
    except WebSocketDisconnect:
        hub.disconnect(ws)
    except Exception:
        hub.disconnect(ws)