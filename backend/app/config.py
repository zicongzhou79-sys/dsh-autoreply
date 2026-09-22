# -*- coding: utf-8 -*-
"""配置模型：config.yaml + 运行时 kv_config 覆盖层。

设计：图省事但可扩展 —— Pydantic 模型对应 config.yaml 全部字段；
WebUI 编辑的配置写入 SQLite kv_config（覆盖层），读配置时先取
kv_config，缺失回退 config.yaml。后续扩展新配置段只需加字段。
"""
from __future__ import annotations

import os
from pathlib import Path
from typing import Optional

import yaml
from pydantic import BaseModel, Field

PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent


def _env_path(name: str, default: Path) -> Path:
    """环境变量重定位目录（容器部署用）；未设置或为空时用默认值。"""
    raw = os.environ.get(name, "").strip()
    return Path(raw).expanduser() if raw else default


# 容器部署通过 AUTOREPLY_CONFIG / AUTOREPLY_DATA 重定位；默认保持源码布局。
CONFIG_PATH = _env_path("AUTOREPLY_CONFIG", PROJECT_ROOT / "backend" / "config.yaml")
DATA_DIR = _env_path("AUTOREPLY_DATA", PROJECT_ROOT / "data")


# ---------- 配置段模型 ----------

class ServerCfg(BaseModel):
    host: str = "0.0.0.0"
    port: int = 8001
    webui_token: str = ""          # 空 = 仅本机免密访问


class OneBotCfg(BaseModel):
    ws_path: str = "/onebot/ws"
    access_token: str = ""         # 与 NapCat onebot11_*.json 中 token 一致
    heartbeat_timeout_s: int = 90


class LLMCfg(BaseModel):
    """DSH 模型路由参数。模型请求统一由 DSH host 执行。"""
    provider: str = ""             # DSH provider ID
    model: str = ""                # DSH model ID
    temperature: float = 0.7
    max_tokens: int = 500
    timeout_s: float = 60.0


class RateLimitCfg(BaseModel):
    per_session_per_min: int = 10
    daily_per_session: int = 300


class DshCfg(BaseModel):
    """DeepSeek Harness 接入段（DSH 插件互通）。"""
    enabled: bool = True          # 回复和工具调用均通过 DSH
    base_url: str = "http://127.0.0.1:3080"   # DSH web host 地址（须与 dsh web 端口一致）
    health_path: str = "/dsh-qq/health"       # 插件健康探测端点
    tool_path: str = "/dsh-qq/execute"        # 插件工具执行端点（AutoReply→DSH）
    persona_path: str = "/dsh-qq/persona"     # 人设读取端点（DSH→AutoReply 同步用）
    reply_tools: list[str] = Field(default_factory=list)  # 回复前可调用的 DSH 工具白名单
    agent_preset: str = ""         # 当前同步的人设 preset ID
    timeout_s: float = 10.0


class WhitelistCfg(BaseModel):
    friends: list[str] = Field(default_factory=list)   # 空 = 全部
    groups: list[str] = Field(default_factory=list)


class BlacklistCfg(BaseModel):
    friends: list[str] = Field(default_factory=list)
    groups: list[str] = Field(default_factory=list)


class EngineCfg(BaseModel):
    master_switch: bool = True
    private_auto: bool = True          # 私聊全自动
    group_mode: str = "mention"        # mention|keyword|all|off
    group_keywords: list[str] = Field(default_factory=list)
    whitelist: WhitelistCfg = Field(default_factory=WhitelistCfg)
    blacklist: BlacklistCfg = Field(default_factory=BlacklistCfg)
    rate_limit: RateLimitCfg = Field(default_factory=RateLimitCfg)
    context_n: int = 12
    workspace_dir: str = ""          # DSH workspace path used by QQ sessions
    session_dir: str = ""            # optional root for QQ session files
    sensitive_words: list[str] = Field(default_factory=list)
    dsh: DshCfg = Field(default_factory=DshCfg)


class PersonaCfg(BaseModel):
    name: str = ""
    system_prompt: str = "你是{name}。你正在代替 QQ 账号本人回复消息，请以本人的语气、简洁自然地回复。不要声称自己是 AI。"


class AppConfig(BaseModel):
    server: ServerCfg = Field(default_factory=ServerCfg)
    onebot: OneBotCfg = Field(default_factory=OneBotCfg)
    llm: LLMCfg = Field(default_factory=LLMCfg)
    engine: EngineCfg = Field(default_factory=EngineCfg)
    persona: PersonaCfg = Field(default_factory=PersonaCfg)


# ---------- 运行时覆盖层（可选，供 API 层使用） ----------
# 设计：llm.* / persona.* / engine.* 全路径均可被 kv_config 覆盖。
# 为避免与主配置耦合，覆盖解析放在 app/api/routes_config.py。

def _apply_env_overrides(cfg: AppConfig) -> AppConfig:
    """容器部署注入口：OneBot token 与端口可用环境变量覆盖。

    容器里可以完全不带 config.yaml（load_config 容缺席），token 由编排方
    （插件 ComposeProvider）生成并同值注入 NapCat 侧，实现自动对齐。
    """
    token = os.environ.get("AUTOREPLY_ONEBOT_TOKEN", "").strip()
    if token:
        cfg.onebot.access_token = token
    port = os.environ.get("AUTOREPLY_PORT", "").strip()
    if port.isdigit() and 0 < int(port) < 65536:
        cfg.server.port = int(port)
    dsh_url = os.environ.get("AUTOREPLY_DSH_BASE_URL", "").strip()
    if dsh_url:
        # 容器内 127.0.0.1 指容器自身；由编排方注入 host 网关地址
        # （如 http://host.docker.internal:3080），DB 里的配置保持不动，
        # 回滚宿主运行时无需改配置。
        cfg.engine.dsh.base_url = dsh_url
    return cfg


def load_config(path: Optional[Path] = None) -> AppConfig:
    path = path or CONFIG_PATH
    if path.exists():
        data = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
    else:
        data = {}
    return _apply_env_overrides(AppConfig(**data))


def save_config(cfg: AppConfig, path: Optional[Path] = None) -> None:
    path = path or CONFIG_PATH
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        yaml.safe_dump(cfg.model_dump(), allow_unicode=True, sort_keys=False),
        encoding="utf-8",
    )