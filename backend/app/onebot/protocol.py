# -*- coding: utf-8 -*-
"""OneBot11 消息段解析：event frame → 业务消息模型。

NapCat 配置 messagePostFormat=array，事件中 message 为段数组：
[{"type":"text","data":{"text":"..."}}, {"type":"face","data":{...}}, ...]

提取：文本拼接、CQ 非文本段占位（[图片]/[表情]/[@xxx]）、
被引用回复、群 @ 提及检测。
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Optional




@dataclass
class Attachment:
    kind: str
    file: str = ""
    url: str = ""
    name: str = ""
    size: int | None = None
    raw: dict = field(default_factory=dict)

@dataclass
class ParsedMessage:
    chat_key: str            # friend:<qq> 或 group:<gid>
    chat_type: str           # friend | group
    sender_id: str
    sender_name: str         # card/remark/nickname 兜底
    text: str                # 纯文本（含非文本占位符）
    raw_text: str            # 仅 text 段拼接（供关键词匹配）
    message_id: int
    raw: dict
    reply_to: Optional[str] = None   # 引用的原消息文本
    reply_to_id: Optional[str] = None   # 引用的原消息 ID
    at_self: bool = False            # 群聊中 @ 了机器人本人
    user_id: Optional[str] = None    # private 时对方 QQ
    group_id: Optional[str] = None   # group 时群号
    attachments: list[Attachment] = field(default_factory=list)


_NON_TEXT_PLACEHOLDER = {
    "face": "[表情]",
    "image": "[图片]",
    "at": "@{name}",
    "record": "[语音]",
    "video": "[视频]",
    "file": "[文件]",
    "reply": "",
    "forward": "[合并转发]",
    "json": "[卡片]",
    "rich": "[卡片]",
}


def parse_message(frame: dict, self_id: Optional[str] = None) -> Optional[ParsedMessage]:
    """把 OneBot11 message 事件解析为业务模型；非目标事件返回 None。"""
    post_type = frame.get("post_type")
    if post_type != "message":
        return None

    mtype = frame.get("message_type")
    if mtype not in ("private", "group"):
        return None

    segments = frame.get("message") or []
    if isinstance(segments, str):
        # 兜底：字符串消息格式
        segments = [{"type": "text", "data": {"text": segments}}]

    text_parts: list[str] = []
    raw_parts: list[str] = []
    reply_to: Optional[str] = None
    reply_to_id: Optional[str] = None
    at_self = False
    attachments: list[Attachment] = []

    for seg in segments:
        t = seg.get("type", "text")
        data = seg.get("data") or {}
        if t == "text":
            s = str(data.get("text", ""))
            text_parts.append(s)
            raw_parts.append(s)
        elif t == "reply":
            reply_to = str(data.get("text", "") or "")
            reply_to_id = str(data.get("id", "") or "")
        elif t == "at":
            qq = str(data.get("qq", ""))
            if self_id and qq == str(self_id):
                at_self = True
            text_parts.append(f"@{data.get('name', qq)}")
            raw_parts.append("")
        elif t in ("image", "file", "record", "video"):
            attachments.append(Attachment(
                kind=t, file=str(data.get("file", "")), url=str(data.get("url", "")),
                name=str(data.get("name", "") or data.get("file", "")),
                size=int(data["size"]) if str(data.get("size", "")).isdigit() else None,
                raw=data,
            ))

        else:
            placeholder = _NON_TEXT_PLACEHOLDER.get(t, f"[{t}]")
            if t == "at":
                placeholder = placeholder.format(name=data.get("qq", ""))
            text_parts.append(placeholder)

    text = "".join(text_parts).strip()
    raw_text = "".join(raw_parts).strip()

    sender = frame.get("sender") or {}
    sender_id = str(frame.get("user_id", ""))
    sender_name = (sender.get("card") or sender.get("nickname")
                   or sender.get("remark") or sender_id)

    if mtype == "private":
        chat_key = f"friend:{sender_id}"
        user_id = sender_id
        group_id = None
        if "sender" in frame and "user_id" in frame.get("sender", {}):
            pass
    else:
        group_id = str(frame.get("group_id", ""))
        chat_key = f"group:{group_id}"
        user_id = None

    # filter 自身消息（reportSelfMessage 会上报自己发的，交给其他层处理）
    return ParsedMessage(
        chat_key=chat_key,
        chat_type="friend" if mtype == "private" else "group",
        sender_id=sender_id,
        sender_name=sender_name,
        text=text,
        raw_text=raw_text,
        message_id=int(frame.get("message_id", 0)),
        raw=frame,
        reply_to=reply_to,
        reply_to_id=reply_to_id,
        at_self=at_self,
        user_id=user_id,
        group_id=group_id,
        attachments=attachments,
    )


def cq_encode(text: str) -> str:
    """发送文本转义（CQ 码安全）。"""
    return text.replace("&", "&amp;").replace("[", "&#91;").replace("]", "&#93;")