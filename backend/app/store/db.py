# -*- coding: utf-8 -*-
"""SQLite 存储层（stdlib sqlite3，零额外依赖）。

表：
- messages:   全部消息（收发/AI 回复）
- sessions:   会话（好友/群），含 per-session 自动回复开关
- reply_logs: AI 回复决策日志（answered/skipped/blocked/failed）
- kv_config:  WebUI 配置覆盖层

并发：单进程 uvicorn + asyncio，业务串行化处理（事件队列），
写操作用短锁保护；读走只读连接。数据文件 data/app.db。
"""
from __future__ import annotations

import json
import sqlite3
import threading
import time
from pathlib import Path
from typing import Any, Optional

from app.config import DATA_DIR

DB_PATH = DATA_DIR / "app.db"

_write_lock = threading.Lock()


def _connect() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH, timeout=10)
    conn.row_factory = sqlite3.Row
    return conn


def init_db() -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    with _write_lock, _connect() as conn:
        conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS messages (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                chat_key TEXT NOT NULL,
                direction TEXT NOT NULL,        -- in | out | ai
                sender_id TEXT DEFAULT '',
                nick TEXT DEFAULT '',
                text TEXT DEFAULT '',
                raw_json TEXT DEFAULT '{}',
                ts REAL NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_messages_ck ON messages(chat_key, ts);

            CREATE TABLE IF NOT EXISTS attachments (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                msg_id INTEGER NOT NULL,
                chat_key TEXT NOT NULL,
                kind TEXT NOT NULL,
                file TEXT DEFAULT '',
                url TEXT DEFAULT '',
                name TEXT DEFAULT '',
                size INTEGER,
                raw_json TEXT DEFAULT '{}',
                created_at REAL NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_attachments_msg ON attachments(msg_id);

            CREATE TABLE IF NOT EXISTS sessions (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                chat_key TEXT NOT NULL UNIQUE,
                chat_type TEXT NOT NULL,        -- friend | group
                peer_name TEXT DEFAULT '',
                auto_on INTEGER DEFAULT 1,      -- per-session 自动回复开关
                workspace_dir TEXT DEFAULT '',
                session_dir TEXT DEFAULT '',
                agent_preset TEXT DEFAULT '',
                model_provider TEXT DEFAULT '',
                model_name TEXT DEFAULT '',
                dsh_session_id TEXT DEFAULT '',
                updated_at REAL NOT NULL
            );

            CREATE TABLE IF NOT EXISTS reply_logs (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                msg_id INTEGER DEFAULT 0,
                chat_key TEXT NOT NULL,
                decision TEXT NOT NULL,         -- answered | skipped | blocked | failed
                reason TEXT DEFAULT '',
                llm_output TEXT DEFAULT '',
                duration_ms REAL DEFAULT 0,
                ts REAL NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_logs_ck ON reply_logs(chat_key, ts);

            CREATE TABLE IF NOT EXISTS kv_config (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );
            """
        )
        # Existing databases need the new workspace/session binding columns.
        cols = {row[1] for row in conn.execute("PRAGMA table_info(sessions)")}
        for name, ddl in {
            "agent_preset": "ALTER TABLE sessions ADD COLUMN agent_preset TEXT DEFAULT ''",
            "model_provider": "ALTER TABLE sessions ADD COLUMN model_provider TEXT DEFAULT ''",
            "model_name": "ALTER TABLE sessions ADD COLUMN model_name TEXT DEFAULT ''",
            "dsh_session_id": "ALTER TABLE sessions ADD COLUMN dsh_session_id TEXT DEFAULT ''",
        }.items():
            if name not in cols:
                conn.execute(ddl)
        if "workspace_dir" not in cols:
            conn.execute("ALTER TABLE sessions ADD COLUMN workspace_dir TEXT DEFAULT ''")
        if "session_dir" not in cols:
            conn.execute("ALTER TABLE sessions ADD COLUMN session_dir TEXT DEFAULT ''")


def add_attachment(msg_id: int, chat_key: str, attachment: dict) -> int:
    with _write_lock, _connect() as conn:
        cur = conn.execute(
            "INSERT INTO attachments(msg_id,chat_key,kind,file,url,name,size,raw_json,created_at) VALUES(?,?,?,?,?,?,?,?,?)",
            (msg_id, chat_key, attachment.get("kind", "file"), attachment.get("file", ""),
             attachment.get("url", ""), attachment.get("name", ""), attachment.get("size"),
             json.dumps(attachment.get("raw", {}), ensure_ascii=False), time.time()),
        )
        return int(cur.lastrowid)


def list_attachments(msg_id: int) -> list[dict]:
    with _connect() as conn:
        rows = conn.execute("SELECT * FROM attachments WHERE msg_id=? ORDER BY id", (msg_id,)).fetchall()
    return [dict(row) for row in rows]



# ---------- messages ----------

def add_message(chat_key: str, direction: str, sender_id: str, nick: str,
                text: str, raw: Optional[dict] = None, ts: Optional[float] = None) -> int:
    ts = ts if ts is not None else time.time()
    with _write_lock, _connect() as conn:
        cur = conn.execute(
            "INSERT INTO messages(chat_key,direction,sender_id,nick,text,raw_json,ts) "
            "VALUES(?,?,?,?,?,?,?)",
            (chat_key, direction, sender_id, nick, text, json.dumps(raw or {}, ensure_ascii=False), ts),
        )
        return int(cur.lastrowid)


def recent_messages(chat_key: str, limit: int = 50) -> list[dict]:
    with _connect() as conn:
        rows = conn.execute(
            "SELECT * FROM messages WHERE chat_key=? ORDER BY ts DESC LIMIT ?",
            (chat_key, limit),
        ).fetchall()
    return [dict(r) for r in reversed(rows)]


def messages_range(chat_key: str, before: Optional[float] = None, limit: int = 200) -> list[dict]:
    with _connect() as conn:
        if before is not None:
            rows = conn.execute(
                "SELECT * FROM messages WHERE chat_key=? AND ts<? ORDER BY ts DESC LIMIT ?",
                (chat_key, before, limit),
            ).fetchall()
        else:
            rows = conn.execute(
                "SELECT * FROM messages WHERE chat_key=? ORDER BY ts DESC LIMIT ?",
                (chat_key, limit),
            ).fetchall()
    return [dict(r) for r in reversed(rows)]


# ---------- sessions ----------

def upsert_session(chat_key: str, chat_type: str, peer_name: str = "",
                   auto_on: bool = True, workspace_dir: str = "",
                   session_dir: str = "", agent_preset: str = "",
                   model_provider: str = "", model_name: str = "",
                   dsh_session_id: str = "") -> None:
    ts = time.time()
    with _write_lock, _connect() as conn:
        conn.execute(
            "INSERT INTO sessions(chat_key,chat_type,peer_name,auto_on,workspace_dir,session_dir,agent_preset,model_provider,model_name,dsh_session_id,updated_at) "
            "VALUES(?,?,?,?,?,?,?,?,?,?,?) "
            "ON CONFLICT(chat_key) DO UPDATE SET peer_name=excluded.peer_name, "
            "workspace_dir=CASE WHEN excluded.workspace_dir!='' THEN excluded.workspace_dir ELSE sessions.workspace_dir END, "
            "session_dir=CASE WHEN excluded.session_dir!='' THEN excluded.session_dir ELSE sessions.session_dir END, "
            "agent_preset=CASE WHEN excluded.agent_preset!='' THEN excluded.agent_preset ELSE sessions.agent_preset END, "
            "model_provider=CASE WHEN excluded.model_provider!='' THEN excluded.model_provider ELSE sessions.model_provider END, "
            "model_name=CASE WHEN excluded.model_name!='' THEN excluded.model_name ELSE sessions.model_name END, "
            "dsh_session_id=CASE WHEN excluded.dsh_session_id!='' THEN excluded.dsh_session_id ELSE sessions.dsh_session_id END, "
            "auto_on=CASE WHEN excluded.peer_name!='' THEN sessions.auto_on ELSE sessions.auto_on END, "
            "updated_at=excluded.updated_at",
            (chat_key, chat_type, peer_name, 1 if auto_on else 0, workspace_dir, session_dir,

             agent_preset, model_provider, model_name, dsh_session_id, ts),
        )


def update_session_binding(chat_key: str, *, agent_preset: str | None = None,
                           model_provider: str | None = None,
                           model_name: str | None = None,
                           dsh_session_id: str | None = None,
                           workspace_dir: str | None = None,
                           session_dir: str | None = None) -> bool:
    """Update session-level DSH bindings without changing auto_on."""
    fields = {
        "agent_preset": agent_preset, "model_provider": model_provider,
        "model_name": model_name, "dsh_session_id": dsh_session_id,
        "workspace_dir": workspace_dir, "session_dir": session_dir,
    }
    values = [(key, value) for key, value in fields.items() if value is not None]
    if not values:
        return get_session(chat_key) is not None
    with _write_lock, _connect() as conn:
        sets = ", ".join(f"{key}=?" for key, _ in values)
        cur = conn.execute(f"UPDATE sessions SET {sets}, updated_at=? WHERE chat_key=?",
                           [value for _, value in values] + [time.time(), chat_key])
        return cur.rowcount > 0

def set_session_auto(chat_key: str, auto_on: bool) -> None:
    with _write_lock, _connect() as conn:
        conn.execute("UPDATE sessions SET auto_on=? WHERE chat_key=?", (1 if auto_on else 0, chat_key))


def get_session(chat_key: str) -> Optional[dict]:
    with _connect() as conn:
        row = conn.execute("SELECT * FROM sessions WHERE chat_key=?", (chat_key,)).fetchone()
    return dict(row) if row else None


def list_sessions(limit: int = 100) -> list[dict]:
    with _connect() as conn:
        rows = conn.execute(
            "SELECT s.*, (SELECT text FROM messages m WHERE m.chat_key=s.chat_key "
            "ORDER BY m.ts DESC LIMIT 1) AS last_text "
            "FROM sessions s ORDER BY s.updated_at DESC LIMIT ?",
            (limit,),
        ).fetchall()
    return [dict(r) for r in rows]


# ---------- reply_logs ----------

def add_reply_log(msg_id: int, chat_key: str, decision: str, reason: str = "",
                  llm_output: str = "", duration_ms: float = 0.0,
                  ts: Optional[float] = None) -> None:
    ts = ts if ts is not None else time.time()
    with _write_lock, _connect() as conn:
        conn.execute(
            "INSERT INTO reply_logs(msg_id,chat_key,decision,reason,llm_output,duration_ms,ts) "
            "VALUES(?,?,?,?,?,?,?)",
            (msg_id, chat_key, decision, reason, llm_output, duration_ms, ts),
        )


def list_reply_logs(limit: int = 200, decision: Optional[str] = None) -> list[dict]:
    with _connect() as conn:
        if decision:
            rows = conn.execute(
                "SELECT * FROM reply_logs WHERE decision=? ORDER BY ts DESC LIMIT ?",
                (decision, limit),
            ).fetchall()
        else:
            rows = conn.execute("SELECT * FROM reply_logs ORDER BY ts DESC LIMIT ?", (limit,)).fetchall()
    return [dict(r) for r in rows]


# ---------- kv_config ----------

def get_kv(key: str, default: Any = None) -> Any:
    with _connect() as conn:
        row = conn.execute("SELECT value FROM kv_config WHERE key=?", (key,)).fetchone()
    if row is None:
        return default
    try:
        return json.loads(row["value"])
    except (json.JSONDecodeError, TypeError):
        return row["value"]


def set_kv(key: str, value: Any) -> None:
    with _write_lock, _connect() as conn:
        conn.execute(
            "INSERT INTO kv_config(key,value) VALUES(?,?) "
            "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            (key, json.dumps(value, ensure_ascii=False)),
        )


def all_kv() -> dict[str, Any]:
    with _connect() as conn:
        rows = conn.execute("SELECT key,value FROM kv_config").fetchall()
    out = {}
    for r in rows:
        try:
            out[r["key"]] = json.loads(r["value"])
        except (json.JSONDecodeError, TypeError):
            out[r["key"]] = r["value"]
    return out


# ---------- stats ----------

def today_stats() -> dict[str, int]:
    """今日收发/AI统计（按本地时区 0 点起）。"""
    import datetime

    start = datetime.datetime.now().replace(hour=0, minute=0, second=0, microsecond=0).timestamp()
    with _connect() as conn:
        in_n = conn.execute(
            "SELECT COUNT(*) c FROM messages WHERE direction='in' AND ts>=?", (start,)
        ).fetchone()["c"]
        out_n = conn.execute(
            "SELECT COUNT(*) c FROM messages WHERE direction IN ('out','ai') AND ts>=?", (start,)
        ).fetchone()["c"]
        answered = conn.execute(
            "SELECT COUNT(*) c FROM reply_logs WHERE decision='answered' AND ts>=?", (start,)
        ).fetchone()["c"]
        skipped = conn.execute(
            "SELECT COUNT(*) c FROM reply_logs WHERE decision IN ('skipped','blocked') AND ts>=?", (start,)
        ).fetchone()["c"]
    return {"in": in_n, "out": out_n, "answered": answered, "skipped": skipped}


def clear_session_history(chat_key: str) -> None:
    """清空某会话消息（保留会话记录）。"""
    with _write_lock, _connect() as conn:
        conn.execute("DELETE FROM messages WHERE chat_key=?", (chat_key,))
        conn.execute("UPDATE sessions SET updated_at=? WHERE chat_key=?", (time.time(), chat_key))