# -*- coding: utf-8 -*-
"""DeepSeek Harness (DSH) 客户端 — AutoReply → DSH 单向调用。

职责：
- probe()：健康探测（DSH 及其插件是否在线）
- call_tool(name, args)：调用 DSH 插件暴露的 /dsh-qq/execute 端点，
  让 AutoReply 回复引擎能用 DSH 注册的工具（web_search 等）增强上下文
- get_persona()：从 DSH 侧读取人设（若开启 persona 同步）

设计：
- httpx AsyncClient，trust_env=False（DSH 与本机后端都在 localhost，不走代理）
- 所有调用带超时，失败抛 DSHUnavailable并记录失败日志
- 零业务耦合：本模块只做传输，不感知 DSH 工具内容
"""
from __future__ import annotations

import logging
import time
from typing import Any, Optional

import httpx

from app.config import DshCfg

log = logging.getLogger("dsh")


class DSHUnavailable(Exception):
    """DSH 不可达或插件未就绪，模型生成将失败。"""


class DSHClient:
    def __init__(self, cfg: DshCfg) -> None:
        self.cfg = cfg
        self._client: Optional[httpx.AsyncClient] = None

    def _get_client(self) -> httpx.AsyncClient:
        if self._client is None:
            self._client = httpx.AsyncClient(timeout=self.cfg.timeout_s, trust_env=False)
        return self._client

    @property
    def enabled(self) -> bool:
        return self.cfg.enabled

    async def close(self) -> None:
        if self._client is not None:
            await self._client.aclose()
            self._client = None

    # ---------- 探测 ----------

    async def probe(self) -> bool:
        """健康探测：GET {base_url}{health_path} 返回 200 即在线。带 5s 结果缓存。"""
        if not self.enabled:
            return False
        now = time.monotonic()
        if now - getattr(self, "_probe_at", 0.0) < 5.0:
            return getattr(self, "_probe_ok", False)
        try:
            resp = await self._get_client().get(
                f"{self.cfg.base_url.rstrip('/')}{self.cfg.health_path}",
                timeout=4.0,
            )
            ok = resp.status_code == 200
        except Exception as e:
            log.debug("DSH probe 失败: %s", e)
            ok = False
        self._probe_at = now
        self._probe_ok = ok
        return ok

    # ---------- 工具调用 ----------

    async def call_tool(self, name: str, args: Optional[dict] = None) -> Any:
        """调用 DSH 插件工具。返回工具执行结果（dict/str），失败抛 DSHUnavailable。"""
        if not self.enabled:
            raise DSHUnavailable("DSH 接入未启用")
        try:
            resp = await self._get_client().post(
                f"{self.cfg.base_url.rstrip('/')}{self.cfg.tool_path}",
                json={"tool": name, "args": args or {}},
            )
            if resp.status_code != 200:
                raise DSHUnavailable(f"DSH execute HTTP {resp.status_code}: {resp.text[:200]}")
            data = resp.json()
            if data.get("ok") is False:
                raise DSHUnavailable(f"DSH tool '{name}' 失败: {data.get('error', '')}")
            return data.get("result")
        except DSHUnavailable:
            raise
        except Exception as e:
            raise DSHUnavailable(f"DSH 调用异常: {e.__class__.__name__}: {e}")

    # ---------- 人设同步 ----------
    async def create_session(self, chat_key: str, session_id: str = "", *, agent_preset: str = "", provider: str = "", model: str = "", workspace_id: str = "") -> str:
        """Create a DSH-owned session and return its stable id."""
        if not self.enabled:
            raise DSHUnavailable("DSH 接入未启用")
        try:
            resp = await self._get_client().post(
                f"{self.cfg.base_url.rstrip('/')}/dsh-qq/session",
                json={"action": "create", "id": session_id or None, "chat_key": chat_key,
                      "agent_preset": agent_preset, "provider": provider, "model": model,
                      "workspace_id": workspace_id},
            )
            if resp.status_code != 200:
                raise DSHUnavailable(f"DSH Session HTTP {resp.status_code}: {resp.text[:200]}")
            data = resp.json()
            if data.get("ok") is False:
                raise DSHUnavailable(data.get("error", "DSH Session failed"))
            return str(((data.get("result") or {}).get("session") or {}).get("id", ""))
        except DSHUnavailable:
            raise
        except Exception as e:
            raise DSHUnavailable(f"DSH Session 创建异常: {e.__class__.__name__}: {e}")

    async def session_chat(self, session_id: str, chat_key: str, text: str,
                           provider: str, model: str, agent_preset: str = "",
                           workspace_id: str = "", temperature: float = 0.7,
                           max_tokens: int = 500) -> str:
        """Run one turn in a DSH-owned session; no local history is sent."""
        if not session_id:
            raise DSHUnavailable("未绑定 DSH Session")
        try:
            resp = await self._get_client().post(
                f"{self.cfg.base_url.rstrip('/')}/dsh-qq/session",
                json={"action": "chat", "session_id": session_id, "chat_key": chat_key,
                      "text": text, "provider": provider, "model": model,
                      "agent_preset": agent_preset, "workspace_id": workspace_id,
                      "temperature": temperature, "max_tokens": max_tokens},
            )
            if resp.status_code != 200:
                raise DSHUnavailable(f"DSH Session chat HTTP {resp.status_code}: {resp.text[:200]}")
            data = resp.json()
            if data.get("ok") is False:
                raise DSHUnavailable(data.get("error", "DSH Session chat failed"))
            return str((data.get("result") or {}).get("content", ""))
        except DSHUnavailable:
            raise
        except Exception as e:
            raise DSHUnavailable(f"DSH Session 调用异常: {e.__class__.__name__}: {e}")


    async def get_persona(self) -> Optional[dict]:
        """从 DSH 插件读取人设（若配置了 persona_path）。失败返回 None。"""
        if not self.enabled:
            return None
        try:
            resp = await self._get_client().get(
                f"{self.cfg.base_url.rstrip('/')}{self.cfg.persona_path}",
                timeout=3.0,
            )
            if resp.status_code == 200:
                data = resp.json()
                return data.get("persona")
        except Exception as e:
            log.debug("DSH get_persona 失败: %s", e)
        return None