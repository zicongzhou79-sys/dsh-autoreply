# -*- coding: utf-8 -*-
"""集成测试：ReplyService 通过 DSH 模型运行时完成完整回复管线。"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import pytest

from app.config import AppConfig
from app.dsh_client import DSHUnavailable
from app.engine.service import ReplyService
from app.onebot.events import EventBus
from app.onebot.protocol import ParsedMessage
from app.realtime.hub import LiveHub
from app.store import db


class FakeDSH:
    def __init__(self, reply="收到:在吗", fail=False):
        self.cfg = AppConfig().engine.dsh
        self.cfg.enabled = True
        self.chats = []
        self.reply = reply
        self.fail = fail

    @property
    def enabled(self):
        return self.cfg.enabled

    async def close(self):
        pass

    async def create_session(self, chat_key, session_id="", **kwargs):
        return "session-test"

    async def session_chat(self, session_id, chat_key, text, provider, model, agent_preset,
                           workspace_id, temperature, max_tokens, content=None):
        self.chats.append({
            "session_id": session_id, "chat_key": chat_key, "text": text,
            "provider": provider, "model": model, "agent_preset": agent_preset,
            "workspace_id": workspace_id,
        })
        if self.fail:
            raise DSHUnavailable("DSH generation failed")
        return self.reply


class FakeGateway:
    is_online = True
    login_info = {"user_id": 99999, "nickname": "本人"}

    def __init__(self):
        self.sent = []

    @property
    def self_id(self):
        return "99999"

    async def send(self, chat_key, message):
        self.sent.append((chat_key, message))
        return {"message_id": 1}


@pytest.fixture(autouse=True)
def clean_db(tmp_path, monkeypatch):
    test_db = tmp_path / "test.db"
    monkeypatch.setattr(db, "DB_PATH", test_db)
    db.init_db()
    yield


def make_service(fake_gateway=None, dsh=None):
    cfg = AppConfig()
    cfg.llm.provider = "test-provider"
    cfg.llm.model = "test-model"
    gateway = fake_gateway or FakeGateway()
    return ReplyService(cfg, gateway, EventBus(), LiveHub(), dsh=dsh or FakeDSH())


def make_msg(text="在吗", chat_type="friend", at_self=False):
    return ParsedMessage(
        chat_key="friend:10001" if chat_type == "friend" else "group:555",
        chat_type=chat_type, sender_id="10001", sender_name="小明", text=text,
        raw_text=text, message_id=1, raw={}, at_self=at_self,
        user_id="10001" if chat_type == "friend" else None,
        group_id=None if chat_type == "friend" else "555",
    )


@pytest.mark.asyncio
async def test_private_auto_reply_pipeline_uses_dsh():
    gw = FakeGateway()
    dsh = FakeDSH(reply="收到:在吗")
    svc = make_service(gw, dsh)
    await svc.handle(make_msg("在吗"))

    assert len(gw.sent) == 1
    assert gw.sent[0][0] == "friend:10001"
    assert "在吗" in gw.sent[0][1]
    assert len(dsh.chats) == 1
    assert dsh.chats[0]["provider"] == "test-provider"
    assert dsh.chats[0]["model"] == "test-model"
    assert dsh.chats[0]["text"] == "在吗"

    msgs = db.recent_messages("friend:10001")
    assert [m["direction"] for m in msgs] == ["in", "ai"]
    assert db.list_reply_logs()[0]["decision"] == "answered"


@pytest.mark.asyncio
async def test_group_no_mention_skipped():
    gw = FakeGateway()
    dsh = FakeDSH()
    svc = make_service(gw, dsh)
    await svc.handle(make_msg("大家好", chat_type="group", at_self=False))
    assert not gw.sent
    assert db.list_reply_logs()[0]["reason"] == "no_mention"
    assert not dsh.chats


@pytest.mark.asyncio
async def test_group_autonomous_can_skip_without_sending():
    gw = FakeGateway()
    dsh = FakeDSH(reply='{"reply":false,"reason":"普通闲聊"}')
    svc = make_service(gw, dsh)
    svc.cfg.engine.group_mode = "autonomous"
    await svc.handle(make_msg("大家好", chat_type="group", at_self=False))
    assert not gw.sent
    assert db.list_reply_logs()[0]["reason"] == "autonomous:普通闲聊"


@pytest.mark.asyncio
async def test_own_message_only_enters_context():
    gw = FakeGateway()
    dsh = FakeDSH()
    svc = make_service(gw, dsh)
    msg = make_msg("大家好")
    msg.sender_id = "99999"
    await svc.handle(msg)
    assert not gw.sent
    assert not db.list_reply_logs()
    assert len(db.recent_messages("friend:10001")) == 1
    assert not dsh.chats


@pytest.mark.asyncio
async def test_sensitive_input_blocked():
    gw = FakeGateway()
    dsh = FakeDSH()
    svc = make_service(gw, dsh)
    svc.cfg.engine.sensitive_words = ["脏话"]
    await svc.handle(make_msg("你说脏话吗"))
    assert not gw.sent
    assert db.list_reply_logs()[0]["decision"] == "blocked"
    assert not dsh.chats


@pytest.mark.asyncio
async def test_dsh_generation_failure_logged():
    gw = FakeGateway()
    dsh = FakeDSH(fail=True)
    svc = make_service(gw, dsh)
    await svc.handle(make_msg("你好"))
    assert not gw.sent
    log = db.list_reply_logs()[0]
    assert log["decision"] == "failed"
    assert "DSH generation failed" in log["reason"]


@pytest.mark.asyncio
async def test_rate_limit_skips():
    gw = FakeGateway()
    dsh = FakeDSH()
    svc = make_service(gw, dsh)
    svc.cfg.engine.rate_limit.per_session_per_min = 1
    await svc.handle(make_msg("1"))
    await svc.handle(make_msg("2"))
    logs = db.list_reply_logs()
    assert logs[0]["decision"] == "skipped"
    assert logs[0]["reason"] == "rate_limited"
    assert logs[1]["decision"] == "answered"
    assert len(dsh.chats) == 1
