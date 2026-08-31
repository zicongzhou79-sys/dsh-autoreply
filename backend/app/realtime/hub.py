# -*- coding: utf-8 -*-
"""WebSocket 广播 Hub：/ws/live 向面板推送实时事件（消息/回复/状态）。"""
from __future__ import annotations

import asyncio
import json
import logging
from typing import Any, Optional

from fastapi import WebSocket

log = logging.getLogger("realtime")


class LiveHub:
    def __init__(self) -> None:
        self._clients: set[WebSocket] = set()

    async def connect(self, ws: WebSocket) -> None:
        await ws.accept()
        self._clients.add(ws)

    def disconnect(self, ws: WebSocket) -> None:
        self._clients.discard(ws)

    async def broadcast(self, event_type: str, data: dict[str, Any]) -> None:
        if not self._clients:
            return
        payload = json.dumps({"type": event_type, "data": data}, ensure_ascii=False)
        for ws in list(self._clients):
            try:
                await ws.send_text(payload)
            except Exception:
                self._clients.discard(ws)

    async def send_to(self, ws: WebSocket, event_type: str, data: dict[str, Any]) -> None:
        try:
            await ws.send_text(
                json.dumps({"type": event_type, "data": data}, ensure_ascii=False)
            )
        except Exception:
            pass