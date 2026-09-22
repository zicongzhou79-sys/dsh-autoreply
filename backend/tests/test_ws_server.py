# -*- coding: utf-8 -*-
"""OneBot WS 服务端测试：半开连接自愈与心跳超时关闭。

背景（2026-09-22 故障）：NapCat 与后端的 WS 半开（无心跳 8.7h 但 TCP 未断），
看门狗只把 is_online 标为 False 不关连接 —— NapCat 认为连接正常永不重连，
后端账号重登后从同一连接收到消息、生成回复却发不出去（「OneBot WS 未连接」）。
两处修复：
1) 收到任何帧都恢复在线（连接活着就能发）；
2) 心跳超时主动 close，触发 NapCat 反向重连。
"""
import asyncio
import json
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import pytest

from app.config import OneBotCfg
from app.onebot.ws_server import OneBotWSServer


class FakeWebSocket:
    """最小化的 Starlette WebSocket 替身。"""

    def __init__(self, frames=(), headers=None, on_receive=None):
        self._frames = list(frames)
        self.headers = headers or {}
        self.on_receive = on_receive      # 每次 receive 前的钩子（测试用）
        self.accepted = False
        self.closed = None
        self.sent = []
        self._release = asyncio.Event()

    async def accept(self):
        self.accepted = True

    async def receive_text(self) -> str:
        if self.on_receive:
            self.on_receive()
        if self._frames:
            return self._frames.pop(0)
        await self._release.wait()
        raise RuntimeError("connection released")

    async def close(self, code: int = 1000, reason: str = ""):
        self.closed = (code, reason)
        self._release.set()

    async def send_text(self, text: str):
        self.sent.append(json.loads(text))


def make_server(heartbeat_timeout_s: int = 90) -> OneBotWSServer:
    return OneBotWSServer(OneBotCfg(access_token="", heartbeat_timeout_s=heartbeat_timeout_s))


MESSAGE_FRAME = json.dumps({
    "post_type": "message", "message_type": "private",
    "message_id": 1, "user_id": 10001, "sender": {"user_id": 10001},
    "message": [{"type": "text", "data": {"text": "在吗"}}],
})


async def stop_task(task) -> None:
    task.cancel()
    try:
        await task
    except (asyncio.CancelledError, RuntimeError):
        pass


@pytest.mark.asyncio
async def test_receive_restores_online_after_watchdog_offline():
    """看门狗判离线后，只要重新收到数据就恢复在线（自愈）。"""
    server = make_server()
    # 模拟时序：连接已在（endpoint 已置在线）→ 看门狗因无心跳判离线 →
    # NapCat 从同一条连接推来一条消息 → 收帧循环应恢复在线。
    # 钩子只触发一次：仅在下一条帧被读取「前」把状态翻成离线。
    def mark_offline_once():
        mark_offline_once.fired = getattr(mark_offline_once, "fired", False)
        if not mark_offline_once.fired:
            mark_offline_once.fired = True
            server.is_online = False

    ws = FakeWebSocket(frames=[MESSAGE_FRAME], on_receive=mark_offline_once)
    seen_online_at_frame = []

    async def on_event(frame):
        seen_online_at_frame.append(server.is_online)

    server.on_event = on_event
    task = asyncio.create_task(server.endpoint(ws))
    try:
        for _ in range(200):
            if seen_online_at_frame:
                break
            await asyncio.sleep(0.01)
        assert seen_online_at_frame, "消息事件未派发"
        assert seen_online_at_frame[0] is True, "处理消息时应已恢复在线"
    finally:
        await stop_task(task)
        for fut in server._pending.values():
            fut.cancel()


@pytest.mark.asyncio
async def test_watchdog_closes_halfopen_connection():
    """心跳超时：标记离线并主动关闭连接（触发 NapCat 重连）。"""
    server = make_server(heartbeat_timeout_s=10)
    ws = FakeWebSocket()
    server.connection = ws
    server.is_online = True
    server.login_info = {"user_id": 1}
    server._last_heartbeat = time.time() - 3600

    await server._check_watchdog()
    assert server.is_online is False
    assert server.connection is None
    assert ws.closed is not None and ws.closed[0] == 4001
    assert server.login_info is None


@pytest.mark.asyncio
async def test_watchdog_keeps_healthy_connection():
    """心跳正常：不动连接。"""
    server = make_server(heartbeat_timeout_s=90)
    ws = FakeWebSocket()
    server.connection = ws
    server.is_online = True
    server._last_heartbeat = time.time()

    await server._check_watchdog()
    assert server.is_online is True
    assert server.connection is ws
    assert ws.closed is None


@pytest.mark.asyncio
async def test_call_raises_when_offline():
    """离线时发送必须快速失败（即面板看到的「OneBot WS 未连接」）。"""
    server = make_server()
    server.connection = FakeWebSocket()
    server.is_online = False
    with pytest.raises(ConnectionError, match="OneBot WS 未连接"):
        await server.send_private_msg("10001", "hi")
