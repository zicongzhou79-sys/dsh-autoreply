# -*- coding: utf-8 -*-
"""回复编排服务：事件 → 落库 → 决策 → 上下文 → LLM → 发送 → 日志 → 广播。

设计：
- 事件经 asyncio.Queue 串行化处理（防风暴/防并发写库竞态）
- 只处理他人消息（in）；自身消息（reportSelfMessage）仅作为上下文入库，
  不回不决策
- AI 输出后再次敏感词检查（输出护栏），命中则丢弃
- 每次产出都经 LiveHub 广播给面板
"""
from __future__ import annotations

import asyncio
from dataclasses import asdict
import logging
import re
import time
from pathlib import Path
from typing import Optional

from app.config import AppConfig
from app.dsh_client import DSHClient, DSHUnavailable
from app.engine.decision import check_sensitive, decide
from app.onebot.events import EventBus
from app.onebot.gateway import OneBotGateway
from app.onebot.protocol import ParsedMessage, cq_encode
from app.realtime.hub import LiveHub
from app.store import db

log = logging.getLogger("engine")


class ReplyService:
    def __init__(self, cfg: AppConfig, gateway: OneBotGateway,
                 bus: EventBus, hub: LiveHub,
                 dsh: Optional[DSHClient] = None) -> None:
        self.cfg = cfg
        self.gateway = gateway
        self.bus = bus
        self.hub = hub
        self.dsh = dsh if dsh is not None else DSHClient(cfg.engine.dsh)
        self._queue: asyncio.Queue[ParsedMessage] = asyncio.Queue(maxsize=200)
        self._worker: Optional[asyncio.Task] = None

    # ---------- 生命周期 ----------

    async def start(self) -> None:
        self._worker = asyncio.create_task(self._worker_loop())

    async def stop(self) -> None:
        if self._worker:
            self._worker.cancel()
            try:
                await self._worker
            except asyncio.CancelledError:
                pass
        await self.dsh.close()

    async def submit(self, msg: ParsedMessage) -> None:
        try:
            self._queue.put_nowait(msg)
        except asyncio.QueueFull:
            log.warning("事件队列满，丢弃消息 %s", msg.chat_key)

    async def _worker_loop(self) -> None:
        while True:
            msg = await self._queue.get()
            try:
                await self.handle(msg)
            except Exception:
                log.exception("处理消息异常 chat_key=%s", msg.chat_key)

    # ---------- 配置热更新 ----------

    def refresh_config(self) -> None:
        """每次处理消息前调用：读取生效配置（静态+覆盖层）并同步到 provider。"""
        from app import config_mgr
        eff = config_mgr.effective_config(self.cfg)
        self.cfg = eff
        self.dsh.cfg = eff.engine.dsh

    # ---------- 主处理 ----------
    def _session_paths(self, chat_key: str) -> tuple[str, str]:
        """Derive a stable workspace and per-QQ session directory."""
        workspace = (self.cfg.engine.workspace_dir or "").strip()
        if not workspace:
            return "", ""
        try:
            workspace_path = Path(workspace).expanduser().resolve()
            if not workspace_path.is_dir():
                return "", ""
            root = Path(self.cfg.engine.session_dir or (workspace_path / ".dsh" / "qq-autoreply")).expanduser().resolve()
            if root != workspace_path and workspace_path not in root.parents:
                log.warning("拒绝工作区之外的会话目录: %s", root)
                return "", ""
            root.mkdir(parents=True, exist_ok=True)
            safe_key = re.sub(r"[^A-Za-z0-9_.-]+", "_", chat_key)
            session_path = root / safe_key
            session_path.mkdir(parents=True, exist_ok=True)
            return str(workspace_path), str(session_path)
        except OSError as e:
            log.warning("创建会话目录失败: %s", e)
            return "", ""



    async def _resolve_peer_name(self, msg: ParsedMessage) -> str:
        """私聊返回对方昵称；群聊优先返回真实群名，失败时回退到发送者昵称。"""
        if msg.chat_type != "group" or not msg.group_id:
            return msg.sender_name
        get_info = getattr(self.gateway, "get_group_info", None)
        if get_info is None:
            return msg.sender_name
        try:
            info = await get_info(msg.group_id)
            name = (info or {}).get("group_name") or ""
            if name.strip():
                return name.strip()
        except Exception:
            pass
        return msg.sender_name

    async def handle(self, msg: ParsedMessage) -> None:
        self.refresh_config()
        peer_name = await self._resolve_peer_name(msg)
        # 统一落库（in 与自身消息都入库做上下文）
        msg_id = db.add_message(
            msg.chat_key, "in", msg.sender_id, msg.sender_name,
            msg.text, msg.raw,
        )
        workspace_dir, session_dir = self._session_paths(msg.chat_key)
        db.upsert_session(msg.chat_key, msg.chat_type, peer_name,
                          workspace_dir=workspace_dir, session_dir=session_dir)
        for attachment in msg.attachments:
            db.add_attachment(msg_id, msg.chat_key, asdict(attachment))
        await self.bus.publish("message.new", {
            "chat_key": msg.chat_key, "msg_id": msg_id,
            "text": msg.text, "sender_name": msg.sender_name,
            "ts": time.time(),
        })
        await self.hub.broadcast("message", {
            "id": msg_id, "chat_key": msg.chat_key, "direction": "in",
            "sender_id": msg.sender_id, "sender_name": msg.sender_name,
            "text": msg.text, "ts": time.time(),
        })

        self_id = self.gateway.self_id
        # 引用自己消息也视为提及
        if not msg.at_self and self_id and msg.reply_to_id:
            for h in db.recent_messages(msg.chat_key, limit=50):
                if str(h.get("id")) == str(msg.reply_to_id) and h.get("direction") in ("ai", "out") and str(h.get("sender_id")) == str(self_id):
                    msg.at_self = True
                    break
        # 自身消息：只入库（上下文），不回
        if self_id and msg.sender_id == self_id:
            return

        # 会话级开关
        sess = db.get_session(msg.chat_key)
        if sess is not None and not sess.get("auto_on", 1):
            db.add_reply_log(msg_id, msg.chat_key, "skipped", "session_off")
            return

        # 决策
        should_reply, reason = decide(self.cfg.engine, msg, self_id)
        if not should_reply:
            db.add_reply_log(msg_id, msg.chat_key, "skipped", reason)
            await self.hub.broadcast("reply_skip", {
                "msg_id": msg_id, "chat_key": msg.chat_key, "reason": reason,
                "ts": time.time(),
            })
            return

        # 入站敏感词
        hit = check_sensitive(msg.text, self.cfg.engine.sensitive_words)
        if hit:
            db.add_reply_log(msg_id, msg.chat_key, "blocked", f"sensitive:{hit}")
            await self.hub.broadcast("reply_skip", {
                "msg_id": msg_id, "chat_key": msg.chat_key, "reason": f"sensitive:{hit}",
                "ts": time.time(),
            })
            return

        # 频率限制
        rate = self.cfg.engine.rate_limit
        if not self._rate_ok(msg.chat_key, rate.per_session_per_min, 60):
            db.add_reply_log(msg_id, msg.chat_key, "skipped", "rate_limited")
            await self.hub.broadcast("reply_skip", {
                "msg_id": msg_id, "chat_key": msg.chat_key, "reason": "rate_limited",
                "ts": time.time(),
            })
            return
        if not self._daily_rate_ok(msg.chat_key, rate.daily_per_session):
            db.add_reply_log(msg_id, msg.chat_key, "skipped", "daily_rate_limited")
            await self.hub.broadcast("reply_skip", {
                "msg_id": msg_id, "chat_key": msg.chat_key, "reason": "daily_rate_limited",
                "ts": time.time(),
            })
            return


        start = time.time()
        try:
            if not sess:
                sess = db.get_session(msg.chat_key)
            dsh_session_id = (sess or {}).get("dsh_session_id", "")
            if not dsh_session_id:
                dsh_session_id = await self.dsh.create_session(
                    msg.chat_key,
                    agent_preset=(sess or {}).get("agent_preset") or self.cfg.engine.dsh.agent_preset,
                    provider=(sess or {}).get("model_provider") or self.cfg.llm.provider,
                    model=(sess or {}).get("model_name") or self.cfg.llm.model,
                    workspace_id=(sess or {}).get("workspace_dir") or self.cfg.engine.workspace_dir,
                )
                if dsh_session_id:
                    db.update_session_binding(msg.chat_key, dsh_session_id=dsh_session_id)
                    sess = db.get_session(msg.chat_key)
            reply = await self.dsh.session_chat(
                dsh_session_id, msg.chat_key, msg.text,
                (sess or {}).get("model_provider") or self.cfg.llm.provider,
                (sess or {}).get("model_name") or self.cfg.llm.model,
                (sess or {}).get("agent_preset") or self.cfg.engine.dsh.agent_preset,
                (sess or {}).get("workspace_dir") or self.cfg.engine.workspace_dir,
                self.cfg.llm.temperature, self.cfg.llm.max_tokens,
            )
            duration_ms = (time.time() - start) * 1000
        except DSHUnavailable as e:
            duration_ms = (time.time() - start) * 1000
            db.add_reply_log(msg_id, msg.chat_key, "failed", str(e)[:200], "", duration_ms)
            await self.hub.broadcast("reply_skip", {
                "msg_id": msg_id, "chat_key": msg.chat_key, "reason": f"llm_failed:{str(e)[:100]}",
                "ts": time.time(),
            })
            return

        reply = self._clean_reply(reply)
        if not reply:
            db.add_reply_log(msg_id, msg.chat_key, "skipped", "empty_output", "", duration_ms)
            return

        # 输出敏感词护栏
        hit_out = check_sensitive(reply, self.cfg.engine.sensitive_words)
        if hit_out:
            db.add_reply_log(msg_id, msg.chat_key, "blocked", f"output_sensitive:{hit_out}",
                             reply[:200], duration_ms)
            return

        # 发送
        try:
            await self.gateway.send(msg.chat_key, cq_encode(reply))
            direction = "ai"
        except Exception as e:
            db.add_reply_log(msg_id, msg.chat_key, "failed", f"send:{str(e)[:200]}",
                             reply[:200], duration_ms)
            return

        out_id = db.add_message(msg.chat_key, direction, self_id or "0", "AI",
                                reply, ts=time.time())
        workspace_dir, session_dir = self._session_paths(msg.chat_key)
        db.upsert_session(msg.chat_key, msg.chat_type, peer_name,
                          workspace_dir=workspace_dir, session_dir=session_dir)
        db.add_reply_log(msg_id, msg.chat_key, "answered", "", reply, duration_ms)
        await self.hub.broadcast("message", {
            "id": out_id, "chat_key": msg.chat_key, "direction": "ai",
            "sender_id": self_id or "0", "sender_name": "AI", "text": reply,
            "ts": time.time(),
        })
        log.info("[answered] %s: %r -> %r (%.0fms)", msg.chat_key,
                 msg.text[:40], reply[:40], duration_ms)

    # ---------- 工具 ----------

    def _rate_ok(self, chat_key: str, n_per_window: int, window_s: float) -> bool:
        """窗口内已由 AI 发出条数 < 阈值。"""
        if n_per_window <= 0:
            return True
        cutoff = time.time() - window_s
        with db._connect() as conn:
            c = conn.execute(
                "SELECT COUNT(*) c FROM reply_logs WHERE chat_key=? AND decision='answered' AND ts>=?",
                (chat_key, cutoff),
            ).fetchone()["c"]
        return c < n_per_window

    def _daily_rate_ok(self, chat_key: str, limit: int) -> bool:
        if limit <= 0:
            return True
        import datetime
        start = datetime.datetime.now().replace(hour=0, minute=0, second=0, microsecond=0).timestamp()
        with db._connect() as conn:
            count = conn.execute(
                "SELECT COUNT(*) c FROM reply_logs WHERE chat_key=? AND decision='answered' AND ts>=?",
                (chat_key, start),
            ).fetchone()["c"]
        return count < limit

    @staticmethod
    def _clean_reply(text: str) -> str:
        """输出清洗：去 markdown 代码围栏、截断长度、压缩空白。"""
        t = text.strip()
        # 去 ```lang ... ``` 围栏
        t = re.sub(r"```[a-zA-Z0-9_]*\s*", "", t)
        t = re.sub(r"```", "", t)
        # 去行首引用标记（AI 常用 > 引用原文）
        t = re.sub(r"(?m)^>\s?", "", t)
        t = re.sub(r"\n{3,}", "\n\n", t).strip()
        max_len = 1500
        if len(t) > max_len:
            t = t[:max_len] + "…"
        return t