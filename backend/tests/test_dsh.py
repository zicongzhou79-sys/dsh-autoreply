# -*- coding: utf-8 -*-
"""DSH 接入测试：传输、工具增强和唯一模型生成通道。"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import pytest

from app.config import AppConfig, DshCfg
from app.dsh_client import DSHClient, DSHUnavailable
from app.engine.service import ReplyService
from app.onebot.events import EventBus
from app.realtime.hub import LiveHub
from app.store import db


class FakeDSH:
    def __init__(self, online=True, fail_chat=False):
        self.online = online
        self.fail_chat = fail_chat
        self.probed = 0
        self.chats = []
        self.cfg = DshCfg(enabled=True, reply_tools=[])

    @property
    def enabled(self):
        return self.cfg.enabled

    async def close(self):
        pass

    async def probe(self):
        self.probed += 1
        return self.online

    async def create_session(self, chat_key, session_id="", **kwargs):
        return "session-test"

    async def session_chat(self, session_id, chat_key, text, provider, model, agent_preset,
                           workspace_id, temperature, max_tokens):
        self.chats.append({
            "session_id": session_id, "chat_key": chat_key, "text": text,
            "provider": provider, "model": model, "agent_preset": agent_preset,
            "workspace_id": workspace_id,
        })
        if not self.cfg.enabled or self.fail_chat:
            raise DSHUnavailable("DSH generation failed")
        return "回复完成"

class FakeSessionDSH:
    """DSH client compatible with the primary session_chat path."""
    def __init__(self, reply="", fail=False):
        self.cfg = DshCfg(enabled=True, reply_tools=[])
        self.reply = reply
        self.fail = fail
        self.created = []
        self.chats = []

    @property
    def enabled(self):
        return self.cfg.enabled

    async def close(self):
        pass

    async def probe(self):
        return True

    async def create_session(self, chat_key, session_id="", **kwargs):
        self.created.append({"chat_key": chat_key, **kwargs})
        return "session-test"

    async def session_chat(self, session_id, chat_key, text, provider, model, agent_preset,
                           workspace_id, temperature, max_tokens):
        self.chats.append({
            "session_id": session_id, "chat_key": chat_key, "text": text,
            "provider": provider, "model": model, "agent_preset": agent_preset,
            "workspace_id": workspace_id,
        })
        if self.fail:
            raise DSHUnavailable("DSH Session chat failed")
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


def make_msg(text="帮我查点东西", chat_type="friend", at_self=False):
    from app.onebot.protocol import ParsedMessage
    return ParsedMessage(
        chat_key="friend:10001" if chat_type == "friend" else "group:555",
        chat_type=chat_type, sender_id="10001", sender_name="小明", text=text,
        raw_text=text, message_id=1, raw={}, at_self=at_self,
        user_id="10001" if chat_type == "friend" else None,
        group_id=None if chat_type == "friend" else "555",
    )


def make_service(dsh, enabled=True, reply_tools=None):
    cfg = AppConfig()
    cfg.llm.provider = "test-provider"
    cfg.llm.model = "test-model"
    cfg.engine.dsh.enabled = enabled
    cfg.engine.dsh.reply_tools = reply_tools or ["web_search"]
    dsh.cfg = DshCfg(enabled=enabled, reply_tools=reply_tools or ["web_search"])
    gw = FakeGateway()
    svc = ReplyService(cfg, gw, EventBus(), LiveHub(), dsh=dsh)
    return svc, gw


@pytest.fixture(autouse=True)
def clean_db(tmp_path, monkeypatch):
    test_db = tmp_path / "test.db"
    monkeypatch.setattr(db, "DB_PATH", test_db)
    db.init_db()
    yield


@pytest.mark.asyncio
async def test_disabled_client_raises():
    client = DSHClient(DshCfg(enabled=False))
    assert await client.probe() is False
    with pytest.raises(DSHUnavailable):
        await client.call_tool("web_search", {"query": "x"})
    with pytest.raises(DSHUnavailable):
        await client.create_session("friend:1")
    with pytest.raises(DSHUnavailable):
        await client.session_chat("s", "friend:1", "hi", "p", "m")


@pytest.mark.asyncio
async def test_client_call_tool_ok(monkeypatch):
    import httpx
    client = DSHClient(DshCfg(enabled=True, base_url="http://127.0.0.1:1"))

    class FakeResp:
        status_code = 200
        def json(self):
            return {"ok": True, "result": {"answer": "检索结果"}}

    class FakeClient:
        async def post(self, url, json=None):
            assert url == "http://127.0.0.1:1/dsh-qq/execute"
            assert json == {"tool": "web_search", "args": {"query": "q"}}
            return FakeResp()

    monkeypatch.setattr(httpx, "AsyncClient", lambda timeout=None, trust_env=None: FakeClient())
    assert await client.call_tool("web_search", {"query": "q"}) == {"answer": "检索结果"}




@pytest.mark.asyncio
async def test_client_session_chat_contract(monkeypatch):
    import httpx
    client = DSHClient(DshCfg(enabled=True, base_url="http://127.0.0.1:1"))

    class FakeResp:
        status_code = 200
        text = ""
        def json(self):
            return {"ok": True, "result": {"content": "session reply"}}

    class FakeClient:
        async def post(self, url, json=None, timeout=None):
            assert url == "http://127.0.0.1:1/dsh-qq/session"
            assert timeout is not None and timeout >= 120
            assert json == {
                "action": "chat", "session_id": "s1", "chat_key": "friend:1",
                "text": "hello", "provider": "p", "model": "m",
                "agent_preset": "agent", "workspace_id": "/tmp/work",
                "temperature": 0.7, "max_tokens": 50,
            }
            return FakeResp()

    monkeypatch.setattr(httpx, "AsyncClient", lambda timeout=None, trust_env=None: FakeClient())
    assert await client.session_chat("s1", "friend:1", "hello", "p", "m", "agent", "/tmp/work", 0.7, 50) == "session reply"

@pytest.mark.asyncio
async def test_client_session_chat_sends_image_content(monkeypatch):
    import httpx
    client = DSHClient(DshCfg(enabled=True, base_url="http://127.0.0.1:1"))
    expected = [{"type": "text", "text": "请看图"}, {"type": "image_url", "image_url": {"url": "data:image/png;base64,AA=="}}]

    class FakeResp:
        status_code = 200
        text = ""
        def json(self):
            return {"ok": True, "result": {"content": "看到了"}}

    class FakeClient:
        async def post(self, url, json=None, timeout=None):
            assert json["content"] == expected
            return FakeResp()

    monkeypatch.setattr(httpx, "AsyncClient", lambda timeout=None, trust_env=None: FakeClient())
    assert await client.session_chat("s1", "friend:1", "请看图", "p", "m", content=expected) == "看到了"


@pytest.mark.asyncio
async def test_session_empty_reply_does_not_send():
    dsh = FakeSessionDSH(reply="")
    svc, gw = make_service(dsh)
    await svc.handle(make_msg("你好"))
    assert not gw.sent
    log = db.list_reply_logs()[0]
    assert log["decision"] == "skipped"
    assert log["reason"] == "empty_output"
    assert dsh.created and dsh.chats


@pytest.mark.asyncio
async def test_session_failure_does_not_send():
    dsh = FakeSessionDSH(fail=True)
    svc, gw = make_service(dsh)
    await svc.handle(make_msg("你好"))
    assert not gw.sent
    log = db.list_reply_logs()[0]
    assert log["decision"] == "failed"
    assert "DSH Session chat failed" in log["reason"]


@pytest.mark.asyncio
async def test_engine_uses_dsh_session_for_generation():
    dsh = FakeDSH()
    svc, gw = make_service(dsh)
    await svc.handle(make_msg("今天天气怎么样"))
    assert len(dsh.chats) == 1
    assert dsh.chats[0]["provider"] == "test-provider"
    assert dsh.chats[0]["text"] == "今天天气怎么样"
    assert len(gw.sent) == 1


@pytest.mark.asyncio
async def test_generation_failure_does_not_fallback():
    dsh = FakeDSH(fail_chat=True)
    svc, gw = make_service(dsh, reply_tools=[])
    await svc.handle(make_msg("你好"))
    assert not gw.sent
    log = db.list_reply_logs()[0]
    assert log["decision"] == "failed"
    assert "DSH generation failed" in log["reason"]


@pytest.mark.asyncio
async def test_engine_disabled_no_dsh_calls_or_reply():
    dsh = FakeDSH()
    svc, gw = make_service(dsh, enabled=False)
    await svc.handle(make_msg("你好"))
    assert len(dsh.chats) == 1
    assert not gw.sent
    assert db.list_reply_logs()[0]["decision"] == "failed"


def test_dsh_cfg_defaults():
    cfg = AppConfig()
    assert cfg.engine.dsh.enabled is True
    assert cfg.engine.dsh.base_url == "http://127.0.0.1:3080"
    assert cfg.engine.dsh.reply_tools == []
    assert not hasattr(cfg.llm, "api_key")
    assert not hasattr(cfg.llm, "base_url")
