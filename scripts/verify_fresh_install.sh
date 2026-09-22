#!/usr/bin/env bash
# 里程 A3：从 npm 全新安装验证（不触碰本机生产栈）
# 用法：bash scripts/verify_fresh_install.sh [包名] [版本]
#   包名默认 dsh-qq-autoreply；版本默认 latest。
# 前置（A2 完成）：npm 已发布、ghcr 镜像公开。未就绪时各项 SKIP，可反复重跑。
set -uo pipefail

PKG="${1:-dsh-qq-autoreply}"
VER="${2:-latest}"
WORK="$(mktemp -d /tmp/qqa-fresh-install.XXXXXX)"
PASS=0; SKIP=0; FAIL=0
step() { # <名称> <状态: PASS|SKIP|FAIL> <说明>
  case "$2" in
    PASS) PASS=$((PASS+1)); echo "✅ $1 — $3" ;;
    SKIP) SKIP=$((SKIP+1)); echo "⏭️  $1 — $3（就绪后重跑本脚本）" ;;
    *)    FAIL=$((FAIL+1)); echo "❌ $1 — $3" ;;
  esac
}
trap 'rm -rf "$WORK"' EXIT

echo "=== A3 全新安装验证：$PKG@$VER（工作目录 $WORK）==="

# 1. npm 包存在
NPM_META="$(curl -sf --max-time 15 "https://registry.npmjs.org/$PKG")" || NPM_META=""
if [ -z "$NPM_META" ]; then
  step "npm 包存在" SKIP "registry 查无 $PKG（等 A2 的 NPM_TOKEN 配置并发布后重跑）"
else
  step "npm 包存在" PASS "$(echo "$NPM_META" | python3 -c "import sys,json; d=json.load(sys.stdin); print('最新版本', d['dist-tags'].get('latest'))")"
  # 2. 下载 tarball 并校验关键文件
  TAR_URL="$(echo "$NPM_META" | python3 -c "
import sys, json
d = json.load(sys.stdin)
v = '$VER'
if v == 'latest': v = d['dist-tags']['latest']
print(d['versions'][v]['dist']['tarball'])")"
  if curl -sf --max-time 30 "$TAR_URL" -o "$WORK/pkg.tgz"; then
    mkdir -p "$WORK/pkg" && tar -xzf "$WORK/pkg.tgz" -C "$WORK/pkg"
    OK=1
    for f in package/lib/index.js package/lib/client.js package/README.md package/package.json; do
      [ -f "$WORK/pkg/$f" ] || { OK=0; echo "   缺少 $f"; }
    done
    [ "$OK" = 1 ] && step "npm 包内容完整" PASS "index.js/client.js/README/package.json 齐全" \
                      || step "npm 包内容完整" FAIL "发布内容缺文件（检查 files 字段/pack 清单）"
    # 3. 已发布包的语法自检（node --check）
    if node --check "$WORK/pkg/package/lib/index.js" 2>/dev/null \
      && node --check "$WORK/pkg/package/lib/client.js" 2>/dev/null; then
      step "已发布 JS 语法有效" PASS "node --check 通过"
    else
      step "已发布 JS 语法有效" FAIL "node --check 失败"
    fi
  else
    step "npm 包下载" FAIL "tarball 拉取失败：$TAR_URL"
  fi
fi

# 4. ghcr 镜像公开可拉（匿名 token 流程即发布可见性代理检查）
REPO="${GHCR_REPO:-zicongzhou79-sys/dsh-autoreply-backend}"
TOKEN="$(curl -sf --max-time 15 "https://ghcr.io/token?scope=repository:$REPO:pull" | python3 -c "import sys,json; print(json.load(sys.stdin).get('token',''))" 2>/dev/null)"
if [ -n "$TOKEN" ] && curl -sf --max-time 15 -H "Authorization: Bearer $TOKEN" \
    "https://ghcr.io/v2/$REPO/tags/list" | python3 -c "import sys,json; d=json.load(sys.stdin); assert d.get('tags')" 2>/dev/null; then
  step "ghcr 镜像公开" PASS "$REPO tags 可匿名列举"
else
  step "ghcr 镜像公开" SKIP "匿名不可列举（等仓库转 public + 发布 job re-run 后重跑）"
fi

# 5. 供给逻辑对已发布包可执行（临时目录，不触生产）
if [ -f "$WORK/pkg/package/lib/index.js" ]; then
  if AUTOREPLY_PROVIDER=compose AUTOREPLY_COMPOSE_DIR="$WORK/provision" \
     node -e "import('$WORK/pkg/package/lib/index.js'.replace('file://','')).then(m => { const p = m.__compose.ensureProvisioned({ account: '10001' }); if (!p.onebot_token) process.exit(1) })" 2>/dev/null \
     && [ -f "$WORK/provision/compose.yml" ] && [ -f "$WORK/provision/.env" ]; then
    step "已发布包供给自检" PASS "ensureProvisioned 生成 compose.yml/.env（临时目录）"
  else
    step "已发布包供给自检" FAIL "ensureProvisioned 执行失败"
  fi
else
  step "已发布包供给自检" SKIP "无已发布包可测"
fi

echo "=== 结果：PASS=$PASS SKIP=$SKIP FAIL=$FAIL ==="
[ "$FAIL" = 0 ]
