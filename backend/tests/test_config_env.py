# -*- coding: utf-8 -*-
"""容器化配置注入口测试：路径重定位 + token/端口环境变量覆盖。

背景（B 方案）：插件 ComposeProvider 以容器方式托管后端，容器里可以
完全不带 config.yaml——token/端口由环境变量注入，数据目录指向挂载卷。
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.config import (
    CONFIG_PATH,
    DATA_DIR,
    PROJECT_ROOT,
    _apply_env_overrides,
    _env_path,
    load_config,
)


def test_defaults_keep_source_layout(monkeypatch):
    monkeypatch.delenv("AUTOREPLY_CONFIG", raising=False)
    monkeypatch.delenv("AUTOREPLY_DATA", raising=False)
    assert CONFIG_PATH == PROJECT_ROOT / "backend" / "config.yaml"
    assert DATA_DIR == PROJECT_ROOT / "data"


def test_env_relocates_paths(monkeypatch, tmp_path):
    monkeypatch.setenv("AUTOREPLY_CONFIG", str(tmp_path / "cfg.yaml"))
    monkeypatch.setenv("AUTOREPLY_DATA", str(tmp_path / "data"))
    assert _env_path("AUTOREPLY_CONFIG", PROJECT_ROOT / "backend" / "config.yaml") == tmp_path / "cfg.yaml"
    assert _env_path("AUTOREPLY_DATA", PROJECT_ROOT / "data") == tmp_path / "data"
    # 空值视同未设置
    monkeypatch.setenv("AUTOREPLY_DATA", "   ")
    assert _env_path("AUTOREPLY_DATA", PROJECT_ROOT / "data") == PROJECT_ROOT / "data"


def test_load_config_without_yaml_applies_env(monkeypatch, tmp_path):
    """容器形态：无 config.yaml（显式传不存在路径），token/端口全来自环境变量。"""
    monkeypatch.setenv("AUTOREPLY_ONEBOT_TOKEN", "  container-token  ")
    monkeypatch.setenv("AUTOREPLY_PORT", "18001")
    cfg = load_config(tmp_path / "absent.yaml")
    assert cfg.onebot.access_token == "container-token"   # 去空白
    assert cfg.server.port == 18001
    # 其余字段回落默认值
    assert cfg.engine.master_switch is True
    assert cfg.llm.model == ""


def test_yaml_passthrough_when_env_absent(monkeypatch, tmp_path):
    """无环境变量时：yaml 值原样生效，不被扰动。"""
    monkeypatch.delenv("AUTOREPLY_ONEBOT_TOKEN", raising=False)
    monkeypatch.delenv("AUTOREPLY_PORT", raising=False)
    yaml_path = tmp_path / "cfg.yaml"
    yaml_path.write_text(
        "onebot:\n"
        "  access_token: yaml-token\n"
        "server:\n"
        "  port: 18002\n",
        encoding="utf-8",
    )
    cfg = load_config(yaml_path)
    assert cfg.onebot.access_token == "yaml-token"
    assert cfg.server.port == 18002


def test_invalid_port_ignored(monkeypatch, tmp_path):
    monkeypatch.setenv("AUTOREPLY_PORT", "not-a-port")
    cfg = load_config(tmp_path / "absent.yaml")
    assert cfg.server.port == 8001
