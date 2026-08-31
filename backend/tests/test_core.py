# -*- coding: utf-8 -*-
"""核心逻辑单元测试：决策器 / 协议解析 / 上下文组装 / 输出清洗。"""
import asyncio
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import pytest

from app.ai.context import build_messages, compose_system_prompt
from app.config import AppConfig, EngineCfg, PersonaCfg
from app.engine.decision import check_sensitive, decide
from app.engine.service import ReplyService
from app.onebot.protocol import ParsedMessage, parse_message


# ---------- 协议解析 ----------

def test_parse_private_text():
    frame = {
        "post_type": "message", "message_type": "private",
        "message_id": 1, "user_id": 10001,
        "sender": {"user_id": 10001, "nickname": "小明"},
        "message": [{"type": "text", "data": {"text": "你好"}}],
    }
    m = parse_message(frame, self_id="99999")
    assert m is not None
    assert m.chat_type == "friend"
    assert m.chat_key == "friend:10001"
    assert m.text == "你好"
    assert not m.at_self


def test_parse_group_at_self():
    frame = {
        "post_type": "message", "message_type": "group",
        "message_id": 2, "group_id": 555, "user_id": 20002,
        "sender": {"user_id": 20002, "card": "阿黄"},
        "message": [
            {"type": "at", "data": {"qq": "99999", "name": "本人"}},
            {"type": "text", "data": {"text": "在吗"}},
        ],
    }
    m = parse_message(frame, self_id="99999")
    assert m.chat_type == "group"
    assert m.chat_key == "group:555"
    assert m.at_self is True
    assert "本人" in m.text or "@" in m.text


def test_parse_non_message_event():
    assert parse_message({"post_type": "meta_event", "meta_event_type": "heartbeat"}, "1") is None


# ---------- 决策器 ----------

def make_msg(chat_type="friend", at_self=False, text="hi", group_id="g1"):
    return ParsedMessage(
        chat_key=f"group:{group_id}" if chat_type == "group" else f"friend:10001",
        chat_type=chat_type, sender_id="10001", sender_name="x", text=text,
        raw_text=text, message_id=1, raw={}, at_self=at_self, group_id=group_id,
    )


def test_decision_master_off():
    cfg = AppConfig().engine
    cfg.master_switch = False
    ok, reason = decide(cfg, make_msg())
    assert not ok and reason == "master_off"


def test_decision_private_default():
    cfg = AppConfig().engine
    ok, _ = decide(cfg, make_msg("friend"))
    assert ok


def test_decision_private_off():
    cfg = AppConfig().engine
    cfg.private_auto = False
    ok, reason = decide(cfg, make_msg("friend"))
    assert not ok and reason == "private_off"


def test_decision_group_mention():
    cfg = AppConfig().engine  # group_mode = mention
    ok, r = decide(cfg, make_msg("group", at_self=False))
    assert not ok and r == "no_mention"
    ok, _ = decide(cfg, make_msg("group", at_self=True))
    assert ok


def test_decision_group_off():
    cfg = AppConfig().engine
    cfg.group_mode = "off"
    ok, r = decide(cfg, make_msg("group", at_self=True))
    assert not ok and r == "group_off"


def test_decision_keyword():
    cfg = AppConfig().engine
    cfg.group_mode = "keyword"
    cfg.group_keywords = ["作业", "安排"]
    ok, _ = decide(cfg, make_msg("group", at_self=False, text="今晚作业是什么"))
    assert ok
    ok, r = decide(cfg, make_msg("group", at_self=False, text="晚上吃什么"))
    assert not ok and r == "no_keyword"


def test_decision_whitelist_blacklist():
    cfg = AppConfig().engine
    cfg.blacklist.friends = ["10001"]
    assert not decide(cfg, make_msg("friend"))[0]
    cfg = AppConfig().engine
    cfg.whitelist.friends = ["20002"]
    ok, r = decide(cfg, make_msg("friend"))
    assert not ok and r == "whitelist"
    cfg = AppConfig().engine
    cfg.whitelist.friends = ["10001"]
    assert decide(cfg, make_msg("friend"))[0]


# ---------- 敏感词 ----------

def test_sensitive():
    assert check_sensitive("这里有敏感内容", ["敏感"]) == "敏感"
    assert check_sensitive("正常内容", ["敏感"]) is None


# ---------- 上下文组装 ----------

def test_build_messages():
    sys_p = compose_system_prompt(PersonaCfg(name="阿强", system_prompt="你是{name}"))
    assert "阿强" in sys_p
    history = [
        {"direction": "in", "text": "你好"},
        {"direction": "ai", "text": "哈喽"},
        {"direction": "in", "text": "今天天气不错"},
    ]
    msgs = build_messages(sys_p, history, "是啊", n=12)
    assert msgs[0]["role"] == "system"
    assert [m["role"] for m in msgs] == ["system", "user", "assistant", "user", "user"]
    assert msgs[-1]["content"] == "是啊"


# ---------- 输出清洗 ----------

def test_clean_reply():
    svc = ReplyService.__new__(ReplyService)
    out = svc._clean_reply("```python\nprint(1)\n```\n好的")
    assert "```" not in out
    assert "好的" in out
    assert "" == svc._clean_reply("   \n  ")


if __name__ == "__main__":
    sys.exit(pytest.main([__file__, "-v"]))