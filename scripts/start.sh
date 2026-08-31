#!/usr/bin/env bash
# ============================================================
# start.sh —— 一键启动 QQ AI AutoReply 全部服务
#
# 启动顺序：
#   1. NapCat 容器（未运行则 docker start；容器 --restart=always 自启）
#   2. 等 NapCat 登录态就绪（快速登录，无需扫码——除非登录态丢失）
#   3. 后端 uvicorn（0.0.0.0:8001，面板/API/OneBot WS 单端口）
#
# 用法：
#   bash scripts/start.sh          # 前台运行（Ctrl+C 停止）
#   bash scripts/start.sh --bg     # 后台运行，日志写 logs/backend.log
#   bash scripts/start.sh --stop    # 停止后端（容器保持运行）
# ============================================================
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BACKEND_DIR="$PROJECT_DIR/backend"
LOG_DIR="$PROJECT_DIR/logs"
PORT="$(grep -A2 '^server:' "$BACKEND_DIR/config.yaml" | grep 'port:' | awk '{print $2}')"
PORT="${PORT:-8001}"
CONTAINER="napcat"

mkdir -p "$LOG_DIR"

# ---------- stop 模式 ----------
if [ "${1:-}" = "--stop" ]; then
  echo "[stop] 停止后端…"
  pkill -f "uvicorn app.main:app" 2>/dev/null && echo "后端已停止" || echo "后端未在运行"
  echo "NapCat 容器保持运行（docker stop napcat 可停止）"
  exit 0
fi

# ---------- 1. NapCat 容器 ----------
echo "[1/3] 检查 NapCat 容器…"
if docker ps --format '{{.Names}}' | grep -qx "$CONTAINER"; then
  echo "     ✅ 容器运行中: $(docker ps --filter name=$CONTAINER --format '{{.Status}}')"
elif docker ps -a --format '{{.Names}}' | grep -qx "$CONTAINER"; then
  echo "     ⏳ 容器已存在但未运行，启动中…"
  docker start "$CONTAINER"
  sleep 5
else
  echo "     ❌ 容器不存在，请先执行: bash scripts/rebuild_napcat.sh"
  exit 1
fi

# ---------- 2. 等待 NapCat 就绪（快速登录,通常 20-40s） ----------
echo "[2/3] 等待 NapCat 快速登录就绪（首次/登录态丢失需扫码 WebUI）…"
for i in $(seq 1 12); do
DOCKER_LOG=$(docker logs --since 30s "$CONTAINER" 2>&1 | grep -E "快速登录|登录.*成功|请扫描" | tail -1 || true)
  if echo "$DOCKER_LOG" | grep -q "请扫描"; then
    echo "     ⚠️ 需要扫码登录！请打开:"
    TOKEN=$(docker exec "$CONTAINER" sh -c 'cat /app/napcat/config/webui.json 2>/dev/null' | grep -o '"token": "[^"]*"' | head -1 | cut -d'"' -f4)
    TOKEN="${TOKEN:-<见 deploy/napcat/config/webui.json>}"
    echo "       http://127.0.0.1:6099/webui/?token=${TOKEN}"
  elif echo "$DOCKER_LOG" | grep -q "快速登录\|登录.*成功"; then
    echo "     ✅ 快速登录已启动"
    break
  fi
  sleep 5
done

# ---------- 3. 后端 ----------
echo "[3/3] 启动后端 (端口 $PORT)…"
if ss -tlnp 2>/dev/null | grep -q ":$PORT "; then
  echo "     ⚠️ 端口 $PORT 已占用（后端可能已在运行）。如要重启请先 bash scripts/start.sh --stop"
  echo "     面板: http://127.0.0.1:$PORT"
  exit 0
fi
cd "$BACKEND_DIR"
if [ "${1:-}" = "--bg" ]; then
  nohup python -m uvicorn app.main:app --host 0.0.0.0 --port "$PORT" \
    > "$LOG_DIR/backend.log" 2>&1 &
  sleep 3
  echo "     ✅ 后台启动，日志: logs/backend.log"
else
  python -m uvicorn app.main:app --host 0.0.0.0 --port "$PORT"
fi

echo ""
echo "✅ 面板地址: http://127.0.0.1:$PORT"
echo "   状态:    连接/登录/LLM 三灯（连接需 NapCat 已登录并反向 WS 已连）"
