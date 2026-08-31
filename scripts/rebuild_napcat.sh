#!/usr/bin/env bash
# ============================================================
# rebuild_napcat.sh —— NapCat 容器重建（数据放在 ext4 快速盘）
#
# 为什么放 ext4：官方 entrypoint 每次 `chown -R /app`，若数据挂载在
# NTFS 盘（/media/Data）会因跨文件系统递归 chown 而卡死数分钟。
# 本项目将数据目录放在 /home/<user>/napcat-data（ext4），并用自定义
# entrypoint 跳过 chown，容器几秒内即可启动。
#
# 用法：bash scripts/rebuild_napcat.sh
# 说明：首次重建后若 QQ 提示扫码（登录态丢失时），打开
#   http://127.0.0.1:6099/webui/?token=你的token 扫码一次（仅此一次）。
# ============================================================
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
IMAGE="mlikiowa/napcat-docker:v4.3.5"
CONTAINER="napcat"
WEBUI_PORT=6099

# ext4 数据目录（不要放 NTFS 挂载的盘上）
DATA_BASE="${NAPCAT_DATA_BASE:-$HOME/napcat-data}"
QQ_CONFIG_DIR="$DATA_BASE/qq-config"
CONFIG_DIR="$DATA_BASE/config"
DATA_DIR="$DATA_BASE/data"
ENTRYPOINT_SRC="$PROJECT_DIR/deploy/napcat/entrypoint.sh"

mkdir -p "$QQ_CONFIG_DIR" "$CONFIG_DIR" "$DATA_DIR"

echo "[1/4] 检查镜像与自定义 entrypoint…"
docker image inspect "$IMAGE" >/dev/null 2>&1 || { echo "缺少镜像 $IMAGE"; exit 1; }
if [ ! -f "$ENTRYPOINT_SRC" ]; then
  echo "缺少 deploy/napcat/entrypoint.sh（跳过 chown 的定制启动脚本）"
  exit 1
fi

if docker ps -a --format '{{.Names}}' | grep -qx "$CONTAINER"; then
  if [ "$(docker inspect -f '{{.State.Running}}' "$CONTAINER")" = "true" ]; then
    echo "[2/4] 抢救运行中容器数据…"
    docker exec "$CONTAINER" tar c -C /app/.config QQ 2>/dev/null | tar x -C "$QQ_CONFIG_DIR" || true
    docker exec "$CONTAINER" tar c -C /app/napcat config data 2>/dev/null | tar x -C "$DATA_BASE" || true
  else
    echo "[2/4] 旧容器已停止，跳过抢救"
  fi
  docker rm -f "$CONTAINER" >/dev/null 2>&1
else
  echo "[2/4] 无旧容器，跳过"
fi

echo "[3/4] 启动新容器（ext4 数据 + 自定义 entrypoint）…"
docker run -d --name "$CONTAINER" --restart=always \
  -e TZ=Asia/Shanghai \
  -p 127.0.0.1:${WEBUI_PORT}:${WEBUI_PORT} \
  -v "$QQ_CONFIG_DIR:/app/.config/QQ" \
  -v "$CONFIG_DIR:/app/napcat/config" \
  -v "$DATA_DIR:/app/napcat/data" \
  -v "$ENTRYPOINT_SRC:/app/entrypoint.sh:ro" \
  "$IMAGE"

echo "[4/4] 等待启动…"
sleep 12
docker ps --filter name="$CONTAINER" --format '状态: {{.Status}}  端口: {{.Ports}}'
echo "WebUI: http://127.0.0.1:${WEBUI_PORT}/webui/  （token 见 $CONFIG_DIR/webui.json）"
echo "完成。"