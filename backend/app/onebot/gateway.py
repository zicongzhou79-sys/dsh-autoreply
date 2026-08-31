# -*- coding: utf-8 -*-
"""OneBotGateway —— 发送门面（对上层隐藏 WS 细节，后续可换 HTTP/正向WS）。

上层（engine/api）只依赖本门面：send_private_msg / send_group_msg /
login 状态。后续扩展新动作（撤回、封禁等）在此追加即可。
"""
from __future__ import annotations

from typing import Optional

from app.onebot.ws_server import OneBotWSServer


class OneBotGateway:
    def __init__(self, ws_server: OneBotWSServer) -> None:
        self._ws = ws_server

    @property
    def is_online(self) -> bool:
        return self._ws.is_online

    @property
    def login_info(self) -> Optional[dict]:
        return self._ws.login_info

    @property
    def self_id(self) -> Optional[str]:
        info = self._ws.login_info
        if info and info.get("user_id"):
            return str(info["user_id"])
        return None

    async def send_private_msg(self, user_id: str, message: str) -> dict:
        return await self._ws.send_private_msg(user_id, message)

    async def send_group_msg(self, group_id: str, message: str) -> dict:
        return await self._ws.send_group_msg(group_id, message)

    async def get_group_info(self, group_id: str) -> dict:
        return await self._ws.call("get_group_info", {"group_id": int(group_id)})

    async def get_image(self, file: str) -> dict:
        """Resolve a OneBot image file name to a temporary URL/path."""
        return await self._ws.call("get_image", {"file": file})

    async def send(self, chat_key: str, message: str) -> dict:
        if chat_key.startswith("group:"):
            return await self.send_group_msg(chat_key[6:], message)
        if chat_key.startswith("friend:"):
            return await self.send_private_msg(chat_key[7:], message)
        raise ValueError(f"未知 chat_key: {chat_key}")