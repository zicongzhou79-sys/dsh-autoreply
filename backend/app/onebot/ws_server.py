# -*- coding: utf-8 -*-
"""OneBot11 反向 WebSocket 服务端。

NapCat 以 WS **客户端**身份反向连入本服务端（url 形如
ws://172.18.0.1:8001/onebot/ws，携带 Authorization: Bearer <token>）。

职责：
- Bearer token 鉴权
- 单连接：新连接踢掉旧连接（NapCat 重连收敛）
- 心跳看门狗：超时判离线（NapCat 心跳间隔 30s）
- 收帧路由：
    * {"status":..., "retcode":...}  → API 回执，交给 pending 等待者
    * 事件（post_type: message/meta_event/...）→ 回调 on_event
- 发送动作：send_private_msg / send_group_msg / get_login_info /
  send_group_msg 等，走同一条连接 JSON-RPC 双工

线程模型：uvicorn 事件循环内单线程；回执用 asyncio.Future 等待。
"""
from __future__ import annotations

import asyncio
import json
import logging
import time
from typing import Awaitable, Callable, Optional

from fastapi import WebSocket, WebSocketDisconnect

from app.config import OneBotCfg

log = logging.getLogger("onebot.ws")

EventCallback = Callable[[dict], Awaitable[None]]


class OneBotWSServer:
    def __init__(self, cfg: OneBotCfg) -> None:
        self.cfg = cfg
        self.connection: Optional[WebSocket] = None
        self._pending: dict[str, asyncio.Future] = {}
        self._seq = 0
        self.is_online = False
        self.login_info: Optional[dict] = None
        self.on_event: EventCallback | None = None
        self._watchdog_task: Optional[asyncio.Task] = None
        self._last_heartbeat = 0.0

    # ---------- 生命周期 ----------

    async def start(self) -> None:
        self._watchdog_task = asyncio.create_task(self._watchdog_loop())

    async def stop(self) -> None:
        if self._watchdog_task:
            self._watchdog_task.cancel()
        if self.connection:
            try:
                await self.connection.close()
            except Exception:
                pass
        self.connection = None
        self.is_online = False

    # ---------- 端点 ----------

    async def endpoint(self, ws: WebSocket) -> None:
        # Bearer 鉴权
        token = ""
        auth = ws.headers.get("authorization", "")
        if auth.lower().startswith("bearer "):
            token = auth[7:].strip()
        if self.cfg.access_token and token != self.cfg.access_token:
            await ws.close(code=4401, reason="unauthorized")
            log.warning("WS 鉴权失败（token 不匹配），拒绝连接")
            return

        await ws.accept()
        # 踢旧留新
        old = self.connection
        if old is not None:
            log.info("检测到新连接，关闭旧连接")
            try:
                await old.close(code=4000, reason="replaced")
            except Exception:
                pass
        self.connection = ws
        self.is_online = True
        self._last_heartbeat = time.time()
        log.info("OneBot WS 已连接")

        # 尝试探测登录态（非阻塞：慢响应不阻塞 receive 循环）
        asyncio.create_task(self._probe_login())
        try:
            while True:
                raw = await ws.receive_text()
                try:
                    frame = json.loads(raw)
                except json.JSONDecodeError:
                    continue
                self._last_heartbeat = time.time()
                self._route(frame)
        except WebSocketDisconnect:
            pass
        except Exception:
            log.exception("WS 读取异常")
        finally:
            if self.connection is ws:
                self.connection = None
                self.is_online = False
            log.info("OneBot WS 断开")

    async def _probe_login(self) -> None:
        try:
            info = await self.call("get_login_info", timeout_s=25.0)
            if info:
                self.login_info = info
                log.info("登录探测成功: user_id=%s nickname=%s", info.get("user_id"), info.get("nickname"))
        except Exception as e:
            log.warning("get_login_info 探测失败: %s", e)

    # ---------- 收帧路由 ----------

    def _route(self, frame: dict) -> None:
        log.debug("收帧: %s", json.dumps(frame, ensure_ascii=False)[:300])
        if "status" in frame and ("retcode" in frame or "echo" in frame):
            # API 回执
            echo = frame.get("echo")
            fut = self._pending.pop(str(echo), None) if echo is not None else None
            if fut and not fut.done():
                fut.set_result(frame)
            return
        # 心跳/生命周期 meta_event：仅更新时间，不派发
        if frame.get("post_type") == "meta_event":
            return
        if self.on_event is not None and frame.get("post_type") == "message":
            asyncio.create_task(self._safe_dispatch(frame))

    async def _safe_dispatch(self, frame: dict) -> None:
        try:
            await self.on_event(frame)
        except Exception:
            log.exception("事件处理异常: %s", frame.get("message_type"))

    # ---------- API 发送 ----------

    def _next_echo(self) -> str:
        self._seq += 1
        return f"qqa_{self._seq}_{int(time.time() * 1000)}"

    async def call(self, action: str, params: Optional[dict] = None, timeout_s: float = 15.0) -> dict:
        ws = self.connection
        if ws is None or not self.is_online:
            raise ConnectionError("OneBot WS 未连接")
        echo = self._next_echo()
        fut: asyncio.Future = asyncio.get_running_loop().create_future()
        self._pending[echo] = fut
        await ws.send_text(json.dumps({
            "action": action,
            "params": params or {},
            "echo": echo,
        }, ensure_ascii=False))
        try:
            reply = await asyncio.wait_for(fut, timeout=timeout_s)
        except asyncio.TimeoutError:
            self._pending.pop(echo, None)
            raise TimeoutError(f"OneBot API 超时: {action}")
        if reply.get("status") == "failed":
            raise RuntimeError(f"OneBot API 失败 {action}: {reply.get('message') or reply.get('wording')}")
        return reply.get("data") or {}

    async def send_private_msg(self, user_id: str, message: str) -> dict:
        return await self.call("send_private_msg", {"user_id": int(user_id), "message": message})

    async def send_group_msg(self, group_id: str, message: str) -> dict:
        return await self.call("send_group_msg", {"group_id": int(group_id), "message": message})

    # ---------- 心跳看门狗 ----------

    async def _watchdog_loop(self) -> None:
        interval = 10.0
        while True:
            await asyncio.sleep(interval)
            if self.is_online and time.time() - self._last_heartbeat > self.cfg.heartbeat_timeout_s:
                log.warning("心跳超时（%.0fs 无数据），标记离线",
                            time.time() - self._last_heartbeat)
                self.is_online = False
                self.login_info = None