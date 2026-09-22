#!/usr/bin/env bash
# ============================================================
# migrate_to_compose.sh —— external（宿主 uvicorn + napcat 容器）
#                          → compose 托管栈 迁移
#
# 做什么：
#   1. 读取生产 token（backend/config.yaml onebot.access_token），
#      迁移后 token 不变——QQ 登录态与反向 WS 凭据无缝沿用
#   2. 经插件 ComposeProvider 在 ~/.dsh/qq-autoreply 生成供给
#      （compose.yml/.env/NapCat 配置）
#   3. 复制 NapCat 全部数据（config/qq-config/data，含登录态），
#      反向 WS 地址改写为 compose 网络内 ws://backend:8001/onebot/ws
#   4. backend SQLite 迁入 backend-data 命名卷
#   5. 停旧服务 → compose up → 健康检查
#
# 用法：
#   MIGRATE_DRY_RUN=1 bash scripts/migrate_to_compose.sh   # 试运行（不动任何服务）
#   bash scripts/migrate_to_compose.sh                      # 正式迁移
#
# 回滚：docker compose -p qq-autoreply down；bash scripts/start.sh --bg；
#       docker start napcat
# ============================================================
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PROVISION_DIR="${AUTOREPLY_COMPOSE_DIR:-$HOME/.dsh/qq-autoreply}"
BACKEND_IMAGE="${AUTOREPLY_IMAGE:-qq-autoreply-backend:latest}"
COMPOSE_PROJECT="${AUTOREPLY_COMPOSE_PROJECT:-qq-autoreply}"
DRY_RUN="${MIGRATE_DRY_RUN:-0}"
PLUGIN_LIB="$PROJECT_DIR/integrations/dsh-qq-autoreply/lib/index.js"

info() { echo "[迁移] $*"; }
die()  { echo "[迁移][错误] $*" >&2; exit 1; }

[ "$DRY_RUN" = "1" ] && info "=== 试运行模式：不停止任何服务、不启动 compose 栈 ==="

# ---------- 1. 预检 ----------
command -v docker >/dev/null || die "未安装 docker"
docker compose version >/dev/null 2>&1 || die "docker compose 不可用"
[ -f "$PLUGIN_LIB" ] || die "找不到插件库: $PLUGIN_LIB"
[ -f "$PROJECT_DIR/backend/config.yaml" ] || die "找不到 backend/config.yaml"

TOKEN=$(python3 -c "import yaml;print((yaml.safe_load(open('$PROJECT_DIR/backend/config.yaml')).get('onebot') or {}).get('access_token',''))")
[ -n "$TOKEN" ] || die "config.yaml 未配置 onebot.access_token"
info "生产 token 已读取（${TOKEN:0:8}…），迁移后保持不变"

# ---------- 2. 定位生产 NapCat 数据（docker inspect，只读） ----------
BINDS_JSON=$(docker inspect napcat --format '{{json .HostConfig.Binds}}' 2>/dev/null) \
  || die "找不到生产 napcat 容器"
mapfile -t NAPCAT_PATHS < <(python3 - "$BINDS_JSON" <<'PY'
import json, sys
binds = json.loads(sys.argv[1])
want = {'/app/napcat/config': 'config', '/app/.config/QQ': 'qq', '/app/napcat/data': 'data'}
out = {}
for b in binds:
    src, dst = b.split(':')[:2]
    if dst in want:
        out[want[dst]] = src
for k in ('config', 'qq', 'data'):
    print(out.get(k, ''))
PY
)
NAPCAT_CONFIG="${NAPCAT_PATHS[0]:-}"; NAPCAT_QQ="${NAPCAT_PATHS[1]:-}"; NAPCAT_DATA="${NAPCAT_PATHS[2]:-}"
[ -n "$NAPCAT_CONFIG" ] && [ -d "$NAPCAT_CONFIG" ] || die "napcat config 挂载未找到"
info "NapCat 数据源: config=$NAPCAT_CONFIG qq=$NAPCAT_QQ data=$NAPCAT_DATA"

# ACCOUNT 权威来源：后端 /api/status 的登录账号（配置目录里可能残留
# 其它账号的 onebot11 文件，按文件名取会登错号；mtime 仅作后端不可达时兜底）
ACCOUNT=""
if ST_JSON=$(curl -s --max-time 3 "http://127.0.0.1:${AUTOREPLY_BACKEND_PORT:-8001}/api/status"); then
  ACCOUNT=$(echo "$ST_JSON" | python3 -c "import sys,json;d=json.load(sys.stdin);print((d.get('login_info') or {}).get('user_id','') or '')" 2>/dev/null || true)
fi
if [ -n "$ACCOUNT" ]; then
  info "QQ 账号（来自后端登录态）: $ACCOUNT"
else
  ACCOUNT=$(ls -t "$NAPCAT_CONFIG"/onebot11_*.json 2>/dev/null | head -1 | grep -oP 'onebot11_\K[0-9]+' || true)
  [ -n "$ACCOUNT" ] && info "QQ 账号（后端不可达，按最近改用兜底）: $ACCOUNT" \
                     || info "未找到 onebot11_账号.json，迁移后 NapCat 需在 WebUI 手工补反向 WS"
fi

# ---------- 3. 停旧服务（正式模式） ----------
if [ "$DRY_RUN" != "1" ]; then
  info "停止宿主后端（scripts/start.sh --stop）…"
  bash "$PROJECT_DIR/scripts/start.sh" --stop || true
  info "停止生产 napcat 容器（保留供回滚，不删除）…"
  docker stop napcat >/dev/null
else
  info "[试运行] 跳过停止服务"
fi

# ---------- 4. 生成供给（复用插件 ComposeProvider，单一模板源） ----------
if [ "$DRY_RUN" = "1" ]; then
  PROVISION_DIR="$PROVISION_DIR-dryrun"
  rm -rf "$PROVISION_DIR"
fi
# 工作区/会话目录：从 backend config.yaml 读取，做容器路径对等挂载，
# 保留「每会话独立目录」能力（容器里 mkdir 的目录 DSH 宿主侧同样可见）
read -r WORKSPACE_DIR SESSION_DIR < <(python3 - <<PY
import yaml
cfg = (yaml.safe_load(open('$PROJECT_DIR/backend/config.yaml')) or {}).get('engine') or {}
print((cfg.get('workspace_dir') or '').strip(), (cfg.get('session_dir') or '').strip())
PY
)
[ -n "$WORKSPACE_DIR" ] && info "工作区目录: $WORKSPACE_DIR"
[ -n "$SESSION_DIR" ] && info "会话目录:   $SESSION_DIR"
info "生成供给到 $PROVISION_DIR …"
# onebot_token 走供给参数（写入 provision.json + .env，保持两处一致）；
# 生产 token 沿用，QQ 登录态与反向 WS 凭据无缝迁移
AUTOREPLY_PROVIDER=compose AUTOREPLY_COMPOSE_DIR="$PROVISION_DIR" \
AUTOREPLY_IMAGE="$BACKEND_IMAGE" AUTOREPLY_COMPOSE_PROJECT="$COMPOSE_PROJECT" \
node -e "import('$PLUGIN_LIB'.replace('file://','')).then(m => { const p = m.__compose.ensureProvisioned({ account: '$ACCOUNT', workspace_dir: '$WORKSPACE_DIR', session_dir: '$SESSION_DIR', onebot_token: '$TOKEN' }); console.log('[迁移] 供给完成 project=' + p.project) })"

# ---------- 4.5 会话目录权限共享 ----------
# backend 容器以 uid 10001 运行，宿主 DSH 是 uid 1000。
# 用 ACL 授权容器用户（属主可自行 setfacl，无需 root），并设默认 ACL
# 让新建文件继承；setfacl 不可用时退回提示手工处理。
if [ -n "$SESSION_DIR" ] && [ -d "$SESSION_DIR" ]; then
  if command -v setfacl >/dev/null; then
    setfacl -R -m u:10001:rwX "$SESSION_DIR" \
      && setfacl -R -d -m u:10001:rwX "$SESSION_DIR" 2>/dev/null || true
    info "会话目录 ACL 已授权容器用户（uid 10001）读写"
  else
    info "⚠️ 缺 setfacl：请手工执行 setfacl -R -m u:10001:rwX $SESSION_DIR"
  fi
fi

# ---------- 5. 复制 NapCat 数据（登录态无缝沿用） ----------
# QQ 登录态文件属主是容器内 root（宿主用户不可读），必须经助手容器复制；
# busybox 助手在「正式迁移已停旧容器」时同样可用。
docker_cp_dir() { # <src> <dst>
  docker run --rm -v "$1":/src:ro -v "$2":/dst busybox sh -c "cp -a /src/. /dst/"
}
info "复制 NapCat 数据（config/qq-config/data，经 busybox 助手容器）…"
mkdir -p "$PROVISION_DIR/napcat/config" "$PROVISION_DIR/napcat/qq-config" "$PROVISION_DIR/napcat/data"
docker_cp_dir "$NAPCAT_CONFIG" "$PROVISION_DIR/napcat/config"
[ -d "$NAPCAT_QQ" ]   && docker_cp_dir "$NAPCAT_QQ"   "$PROVISION_DIR/napcat/qq-config"
[ -d "$NAPCAT_DATA" ] && docker_cp_dir "$NAPCAT_DATA" "$PROVISION_DIR/napcat/data"

# 复制产物归到宿主用户（复制出来是 root 属主；compose 的 NapCat 以 root
# 运行仍可读写，宿主侧后续改写/清理也不受权限阻塞）
docker run --rm -v "$PROVISION_DIR/napcat":/dst busybox \
  chown -R "$(id -u):$(id -g)" /dst

# 改写 onebot11（必须在复制之后：否则被生产原版覆盖回旧地址）
python3 - "$PROVISION_DIR" "$TOKEN" <<'PY'
import glob, json, sys
d, token = sys.argv[1], sys.argv[2]
for f in glob.glob(f"{d}/napcat/config/onebot11_*.json"):
    cfg = json.load(open(f))
    for c in cfg.get("network", {}).get("websocketClients", []):
        c["url"] = "ws://backend:8001/onebot/ws"
        c["token"] = token
        c["enable"] = True
    json.dump(cfg, open(f, "w"), ensure_ascii=False, indent=2)
    print("[迁移] 已改写", f, "→ ws://backend:8001/onebot/ws")
PY

# ---------- 6. backend SQLite → backend-data 命名卷 ----------
if [ "$DRY_RUN" != "1" ]; then
  info "迁移 backend 数据库到命名卷…"
  STAGING=$(mktemp -d)
  cp -a "$PROJECT_DIR/data/." "$STAGING/"
  VOL="${COMPOSE_PROJECT}_backend-data"
  docker volume create "$VOL" >/dev/null
  # 关键：busybox 以 root 拷贝 → 文件属主 root；backend 容器以 uid 10001
  # 运行，必须把属主改回 10001，否则 SQLite 只读、首条消息即写库失败
  docker run --rm -v "$VOL":/data -v "$STAGING":/src:ro busybox sh -c "cp -a /src/. /data/ && chown -R 10001:10001 /data"
  rm -rf "$STAGING"
else
  info "[试运行] 跳过数据库入卷（正式模式将复制 data/ → ${COMPOSE_PROJECT}_backend-data 卷）"
fi

# ---------- 7. 启动 compose 栈并验证 ----------
if [ "$DRY_RUN" != "1" ]; then
  info "启动 compose 栈…"
  (cd "$PROVISION_DIR" && docker compose up -d backend napcat)
  info "等待后端就绪与 NapCat 反向连接…"
  for i in $(seq 1 30); do
    ST=$(curl -s --max-time 3 "http://127.0.0.1:${AUTOREPLY_BACKEND_PORT:-8001}/api/status" || true)
    if echo "$ST" | grep -q '"onebot_connected": *true'; then break; fi
    sleep 2
  done
  echo "$ST" | python3 -c "import sys,json; d=json.load(sys.stdin); print('[迁移] connected =', d['onebot_connected'], '| login =', d['onebot_login'])" \
    || die "迁移后健康检查失败，请查看 docker compose -p $COMPOSE_PROJECT logs"
  echo ""
  echo "✅ 迁移完成。回滚方式："
  echo "   cd $PROVISION_DIR && docker compose down -v"
  echo "   bash $PROJECT_DIR/scripts/start.sh --bg && docker start napcat"
else
  info "[试运行] 跳过启动。供给产物已生成在 $PROVISION_DIR（确认后可删除）"
  ls -la "$PROVISION_DIR" "$PROVISION_DIR/napcat/config" 2>/dev/null
  echo "✅ 试运行通过"
fi
