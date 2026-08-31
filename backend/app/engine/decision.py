# -*- coding: utf-8 -*-
"""决策器：给定消息与运行上下文，决定是否回复及原因（纯函数，零 IO）。

决策优先级（首个命中即返回）：
1. 总开关 off → skipped:master_off
2. 黑名单命中 → skipped:blacklist
3. 白名单非空且未命中 → skipped:whitelist
4. 私聊：private_auto off → skipped:private_off；否则可回
5. 群聊：按 group_mode:
   - off          → skipped:group_off
   - mention      → 需 at_self 或引用自己
   - keyword      → 消息文本命中 group_keywords
   - all          → 全部可回
   - autonomous   → 交给 DSH Agent 结合上下文自主判断
6. 敏感词命中 → blocked:sensitive
7. （频率限制在 service 层，因需要 DB 统计）→ skipped:rate_limited
"""
from __future__ import annotations

from typing import Optional

from app.config import EngineCfg
from app.onebot.protocol import ParsedMessage


def decide(cfg: EngineCfg, msg: ParsedMessage, self_id: Optional[str] = None) -> tuple[bool, str]:
    """返回 (是否回复, 原因标识)。原因标识格式: <decision>:<reason>"""
    if not cfg.master_switch:
        return False, "master_off"

    # 黑白名单（用 chat_key 对端标识：friend:<qq> / group:<gid>）
    if msg.chat_type == "friend":
        uid = msg.sender_id
        if uid in cfg.blacklist.friends:
            return False, "blacklist"
        if cfg.whitelist.friends and uid not in cfg.whitelist.friends:
            return False, "whitelist"
    else:
        gid = msg.group_id or ""
        if gid in cfg.blacklist.groups:
            return False, "blacklist"
        if cfg.whitelist.groups and gid not in cfg.whitelist.groups:
            return False, "whitelist"

    if msg.chat_type == "friend":
        if not cfg.private_auto:
            return False, "private_off"
        return True, ""

    # 群聊
    mode = cfg.group_mode
    if mode == "off":
        return False, "group_off"
    if mode in ("all", "autonomous"):
        return True, ""
    if mode == "mention":
        if msg.at_self:
            return True, ""
        # 引用自己发的消息也视为提及
        return False, "no_mention"
    if mode == "keyword":
        if not cfg.group_keywords:
            return False, "no_keywords"
        kw = msg.raw_text or msg.text
        for k in cfg.group_keywords:
            if k and k in kw:
                return True, ""
        return False, "no_keyword"
    return False, "group_off"


def check_sensitive(text: str, words: list[str]) -> Optional[str]:
    """命中敏感词返回命中的词，否则 None。"""
    for w in words:
        if w and w in text:
            return w
    return None