"""受控获取 QQ 图片并转换为模型可用的 data URL。"""
from __future__ import annotations

import asyncio
import base64
import ipaddress
import socket
from urllib.parse import urlparse

import httpx


MAX_IMAGE_BYTES = 5 * 1024 * 1024
ALLOWED_TYPES = {
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "image/gif": ".gif",
    "image/webp": ".webp",
}


def _public_host(hostname: str) -> bool:
    if not hostname or hostname.lower() in {"localhost", "localhost.localdomain"}:
        return False
    try:
        addresses = {item[4][0] for item in socket.getaddrinfo(hostname, None)}
    except OSError:
        return False
    return bool(addresses) and all(
        not (ip := ipaddress.ip_address(address)).is_private
        and not ip.is_loopback
        and not ip.is_link_local
        and not ip.is_reserved
        and not ip.is_multicast
        for address in addresses
    )


def _mime_from_bytes(data: bytes) -> str | None:
    if data.startswith(b"\xff\xd8\xff"):
        return "image/jpeg"
    if data.startswith(b"\x89PNG\r\n\x1a\n"):
        return "image/png"
    if data.startswith((b"GIF87a", b"GIF89a")):
        return "image/gif"
    if data.startswith(b"RIFF") and data[8:12] == b"WEBP":
        return "image/webp"
    return None


async def image_url_to_data_url(url: str, max_bytes: int = MAX_IMAGE_BYTES) -> str:
    """下载公网图片并返回 data URL；拒绝重定向、内网地址和未知格式。"""
    parsed = urlparse(url)
    if parsed.scheme not in {"http", "https"} or not _public_host(parsed.hostname or ""):
        raise ValueError("图片 URL 不是受允许的公网 HTTP(S) 地址")

    async with httpx.AsyncClient(timeout=12.0, follow_redirects=False, trust_env=False) as client:
        async with client.stream("GET", url, headers={"Accept": "image/*"}) as response:
            if response.status_code != 200:
                raise ValueError(f"图片下载 HTTP {response.status_code}")
            declared = response.headers.get("content-type", "").split(";", 1)[0].lower()
            if declared and declared not in ALLOWED_TYPES:
                raise ValueError(f"不支持的图片类型: {declared}")
            length = response.headers.get("content-length")
            if length and length.isdigit() and int(length) > max_bytes:
                raise ValueError("图片超过大小限制")
            chunks: list[bytes] = []
            total = 0
            async for chunk in response.aiter_bytes(64 * 1024):
                total += len(chunk)
                if total > max_bytes:
                    raise ValueError("图片超过大小限制")
                chunks.append(chunk)
    data = b"".join(chunks)
    mime = _mime_from_bytes(data)
    if mime is None:
        raise ValueError("图片内容格式无法校验")
    return f"data:{mime};base64,{base64.b64encode(data).decode('ascii')}"


async def resolve_image_data_url(url: str) -> str:
    """DNS 解析放到线程，避免下载前的 SSRF 校验阻塞事件循环。"""
    parsed = urlparse(url)
    if parsed.hostname and not await asyncio.to_thread(_public_host, parsed.hostname):
        raise ValueError("图片 URL 不是受允许的公网 HTTP(S) 地址")
    return await image_url_to_data_url(url)
