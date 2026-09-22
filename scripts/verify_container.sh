#!/usr/bin/env bash
# ============================================================
# verify_container.sh —— B1 容器化冒烟验证
#
# 验证后端镜像在「无 config.yaml、纯环境变量」的容器形态下可用：
#   1. 起容器（挂载临时卷 + 注入 AUTOREPLY_ONEBOT_TOKEN）
#   2. /api/status 返回 200 且 JSON 合法
#   3. 环境变量注入的 token 生效（覆盖层读取确认）
#   4. SQLite 落在挂载卷（AUTOREPLY_DATA=/data 生效）
#   5. 非 root 运行
#
# 用法：bash scripts/verify_container.sh [镜像tag]（默认 qq-autoreply-backend:b1）
# ============================================================
set -euo pipefail

IMAGE="${1:-qq-autoreply-backend:b1}"
PORT=18001
TOKEN="smoke-token-$(date +%s)"
VOL="qqa-smoke-vol-$$"
NAME="qqa-smoke-$$"
CURL="curl -s --max-time 5"

cleanup() { docker rm -f "$NAME" >/dev/null 2>&1 || true; docker volume rm "$VOL" >/dev/null 2>&1 || true; }
trap cleanup EXIT

echo "[1/5] 启动容器 $NAME（$IMAGE，127.0.0.1:$PORT，命名卷 $VOL）"
docker run -d --name "$NAME" -p "127.0.0.1:$PORT:8001" \
  -e AUTOREPLY_ONEBOT_TOKEN="$TOKEN" \
  -v "$VOL":/data "$IMAGE" >/dev/null

for i in $(seq 1 15); do
  $CURL "http://127.0.0.1:$PORT/api/status" >/dev/null 2>&1 && break
  sleep 1
done

echo "[2/5] /api/status 可用性"
STATUS=$($CURL "http://127.0.0.1:$PORT/api/status")
echo "$STATUS" | python3 -c "import sys,json; d=json.load(sys.stdin); assert 'onebot_connected' in d, d; print('     ✅ 200 JSON 合法, onebot_connected =', d['onebot_connected'])"

echo "[3/5] 环境变量 token 注入"
$CURL "http://127.0.0.1:$PORT/api/config" | python3 -c "
import sys, json
d = json.load(sys.stdin)
tok = d['config']['onebot']['access_token']
assert tok == '$TOKEN', f'token 不匹配: {tok!r}'
print('     ✅ access_token 来自 AUTOREPLY_ONEBOT_TOKEN')
"

echo "[4/5] SQLite 落在数据卷"
docker exec "$NAME" ls /data/app.db >/dev/null 2>&1 \
  && echo "     ✅ /data/app.db 已创建（命名卷 $VOL）" \
  || { echo "     ❌ 数据卷无 app.db"; exit 1; }

echo "[5/5] 非 root 运行"
[ "$(docker exec "$NAME" whoami)" = "autoreply" ] && echo "     ✅ 用户 autoreply (uid 10001)" || { echo "     ❌ 非预期用户"; exit 1; }

echo ""
echo "✅ 容器冒烟验证全部通过（镜像 $IMAGE）"
