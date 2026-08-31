# -*- coding: utf-8 -*-
"""配置覆盖层：config.yaml 为静态默认，kv_config 为 WebUI 热更新覆盖。

覆盖路径（带点，如 "llm.model"）：保存到 kv_config 的扁平键；
读取时 merge 进 AppConfig 对应位置。设置任意键后即刻生效
（engine/persona/llm 都被 engine/service 每次实时读取）。
"""
from __future__ import annotations

from copy import deepcopy
from typing import Any

from app import config as cfgmod
from app.config import AppConfig
from app.store import db


def _kv_to_overlay(kv: dict[str, Any]) -> dict:
    """扁平键 {`a.b.c`: v} → 嵌套 dict {a: {b: {c: v}}}。"""
    out: dict = {}
    for k, v in kv.items():
        node = out
        parts = k.split(".")
        for p in parts[:-1]:
            node = node.setdefault(p, {})
        node[parts[-1]] = v
    return out


def effective_config(base: AppConfig | None = None) -> AppConfig:
    """读取当前生效配置（静态 + 覆盖层）。"""
    cfg = base if base is not None else cfgmod.load_config()
    overlay = _kv_to_overlay(db.all_kv())
    if overlay:
        merged = deepcopy(cfg.model_dump())
        _deep_merge(merged, overlay)
        cfg = AppConfig(**merged)
    return cfg


def _deep_merge(base: dict, overlay: dict) -> None:
    for k, v in overlay.items():
        if isinstance(v, dict) and isinstance(base.get(k), dict):
            _deep_merge(base[k], v)
        else:
            base[k] = v


def all_settings() -> dict[str, Any]:
    """给 WebUI 的完整配置视图（覆盖层 + 静态默认，扁平）。"""
    base = cfgmod.load_config().model_dump()
    overlay = _kv_to_overlay(db.all_kv())
    merged = deepcopy(base)
    _deep_merge(merged, overlay)
    return merged


def set_setting(path: str, value: Any) -> None:
    """保存单个配置项到覆盖层。

    智能类型转换：若 value 是字符串但目标字段为 bool/int/list，
    按目标类型解析（避免 WebUI/DSH 传字符串导致 Pydantic 校验失败）。
    """
    if not _path_allowed(path):
        raise ValueError(f"不允许修改配置项: {path}")
    db.set_kv(path, _coerce(path, value))

_ALLOWED_PREFIXES = (
    "llm.", "persona.name", "persona.system_prompt",
    "engine.master_switch", "engine.private_auto", "engine.group_mode",
    "engine.group_keywords", "engine.whitelist.", "engine.blacklist.",
    "engine.rate_limit.", "engine.context_n", "engine.sensitive_words",
    "engine.workspace_dir", "engine.session_dir", "engine.dsh.",
)

def _path_allowed(path: str) -> bool:
    return any(path == prefix.rstrip(".") or path.startswith(prefix) for prefix in _ALLOWED_PREFIXES)


def _coerce(path: str, value: Any) -> Any:
    """按配置路径目标类型转换字符串值。"""
    if not isinstance(value, str):
        return value
    target = _field_type(path)
    if target in ("list", "List[str]", "list[str]", "list[Any]"):
        s = value.strip()
        if s.startswith("[") and s.endswith("]"):
            try:
                import json
                parsed = json.loads(s)
                if isinstance(parsed, list):
                    return parsed
            except Exception:
                pass
        # 逗号分隔 → 列表
        return [x.strip() for x in s.split(",") if x.strip()] if s else []
    if target == "bool":
        return value.strip().lower() in ("1", "true", "yes", "on", "开", "是")
    if target in ("int", "float"):
        try:
            return {"int": int, "float": float}[target](value)
        except (ValueError, TypeError):
            return value
    return value


def _field_type(path: str) -> str:
    """解析扁平路径对应的字段类型：用静态默认实例逐层取值推断。"""
    try:
        node: Any = cfgmod.load_config()
        for part in path.split("."):
            node = getattr(node, part)
        return _infer(node)
    except Exception:
        return ""


def _infer(value: Any) -> str:
    """由生效值的实际类型推断字符串应转换的目标类型。"""
    import typing
    if isinstance(value, list):
        return "list"
    if isinstance(value, bool):
        return "bool"
    if isinstance(value, int):
        return "int"
    if isinstance(value, float):
        return "float"
    return ""


def delete_setting(path: str) -> None:
    """删除覆盖项（回退静态默认）。"""
    with db._write_lock, db._connect() as conn:
        conn.execute("DELETE FROM kv_config WHERE key=?", (path,))