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
    def __init__(self, online=True, tool_result="增强信息", fail_tools=(), fail_chat=False):
        self.online = online
        self.tool_result = tool_result
        self.fail_tools = set(fail_tools)
        self.fail_chat = fail_chat
        self.probed = 0
        self.called = []
        self.chat_calls = []
        self.cfg = DshCfg(enabled=True, reply_tools=["web_search"])

    @property
    def enabled(self):
        return self.cfg.enabled

    async def close(self):
        pass

    async def probe(self):
        self.probed += 1
        return self.online

    async def call_tool(self, name, args=None):
        self.called.append(name)
        if name in self.fail_tools:
            raise DSHUnavailable("工具不可用")
        return self.tool_result

    async def chat(self, messages, provider, model, temperature, max_tokens):
        self.chat_calls.append({"messages": messages, "provider": provider, "model": model})
        if not self.cfg.enabled or self.fail_chat:
            raise DSHUnavailable("DSH generation failed")
        return "回复完成"


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
        await client.chat([], "p", "m", 0, 5)


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
async def test_engine_uses_dsh_for_tools_and_generation():
    dsh = FakeDSH(tool_result="据检索：今天天气晴")
    svc, gw = make_service(dsh)
    await svc.handle(make_msg("今天天气怎么样"))
    assert dsh.called == ["web_search"]
    assert len(dsh.chat_calls) == 1
    assert dsh.chat_calls[0]["provider"] == "test-provider"
    assert "据检索" in str(dsh.chat_calls[0]["messages"])
    assert len(gw.sent) == 1


@pytest.mark.asyncio
async def test_tool_failure_skips_enrichment_but_generation_continues():
    dsh = FakeDSH(fail_tools=["web_search"])
    svc, gw = make_service(dsh)
    await svc.handle(make_msg("随便聊聊"))
    assert len(dsh.chat_calls) == 1
    assert "增强信息" not in str(dsh.chat_calls[0]["messages"])
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
    assert not dsh.called
    assert len(dsh.chat_calls) == 1
    assert not gw.sent
    assert db.list_reply_logs()[0]["decision"] == "failed"


def test_dsh_cfg_defaults():
    cfg = AppConfig()
    assert cfg.engine.dsh.enabled is True
    assert cfg.engine.dsh.base_url == "http://127.0.0.1:3081"
    assert cfg.engine.dsh.reply_tools == []
    assert not hasattr(cfg.llm, "api_key")
    assert not hasattr(cfg.llm, "base_url")
