# -*- coding: utf-8 -*-
"""轻量事件总线：主题 + 异步订阅。为后续扩展（告警/统计/前端推送）留接缝。

用法：
    bus = EventBus()
    bus.subscribe("message.new", handler)     # handler(event: dict)
    await bus.publish("message.new", {...})
"""
from __future__ import annotations

import asyncio
import logging
from collections import defaultdict
from typing import Awaitable, Callable

log = logging.getLogger("events")

Handler = Callable[[dict], Awaitable[None]]


class EventBus:
    def __init__(self) -> None:
        self._subs: dict[str, list[Handler]] = defaultdict(list)

    def subscribe(self, topic: str, handler: Handler) -> None:
        if handler not in self._subs[topic]:
            self._subs[topic].append(handler)

    def unsubscribe(self, topic: str, handler: Handler) -> None:
        if handler in self._subs[topic]:
            self._subs[topic].remove(handler)

    async def publish(self, topic: str, event: dict) -> None:
        for h in list(self._subs.get(topic, [])):
            try:
                await h(event)
            except Exception:
                log.exception("事件订阅处理异常: %s", topic)