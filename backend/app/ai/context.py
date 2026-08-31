# -*- coding: utf-8 -*-
"""人设渲染 + 上下文组装（纯函数，零 IO）。"""
from __future__ import annotations

from typing import Sequence

from app.config import PersonaCfg


def compose_system_prompt(cfg: PersonaCfg) -> str:
    """把人设模板 + 名字占位渲染成最终 system prompt。"""
    prompt = cfg.system_prompt or ""
    return prompt.replace("{name}", cfg.name or "本人").strip()


def build_messages(
    system_prompt: str,
    history: Sequence[dict],
    incoming_text: str,
    n: int = 12,
) -> list[dict]:
    """组装 OpenAI chat 消息列表：
    [system] + 最近 n 条历史（旧→新，user/assistant）+ [user 当前消息]。

    history: 来自 store.recent_messages() 的结果，
             其中 direction: in → user（对方说的），ai/out → assistant（我方发的）。
             按时间升序传入。
    """
    msgs: list[dict] = [{"role": "system", "content": system_prompt}]
    for item in history[-n:]:
        role = "user" if item.get("direction") == "in" else "assistant"
        text = (item.get("text") or "").strip()
        if not text:
            continue
        msgs.append({"role": role, "content": text})
    msgs.append({"role": "user", "content": incoming_text})
    return msgs