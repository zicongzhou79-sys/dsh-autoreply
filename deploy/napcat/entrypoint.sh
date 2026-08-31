#!/bin/bash
# 自定义 entrypoint（AutoReply 项目定制）
# 与官方版差异：跳过 `chown -R /app`（数据挂载在 ext4 快速盘，启动时不再
# 全量递归 chown，避免 NTFS 盘上卡死；数据已确保属主可写）。
# 其余逻辑与官方一致。

# 安装 napcat（镜像首启时执行）
if [ ! -f "napcat/napcat.mjs" ]; then
    unzip -q NapCat.Shell.zip -d ./NapCat.Shell
    cp -rf NapCat.Shell/* napcat/
    rm -rf ./NapCat.Shell
fi
if [ ! -f "napcat/config/napcat.json" ]; then
    unzip -q NapCat.Shell.zip -d ./NapCat.Shell
    cp -rf NapCat.Shell/config/* napcat/config/
    rm -rf ./NapCat.Shell
fi

# 配置 WebUI Token（仅当 webui.json 不存在）
CONFIG_PATH=/app/napcat/config/webui.json
if [ ! -f "${CONFIG_PATH}" ] && [ -n "${WEBUI_TOKEN}" ]; then
    echo "正在配置 WebUI Token..."
    cat > "${CONFIG_PATH}" << EOF
{
    "host": "0.0.0.0",
    "prefix": "${WEBUI_PREFIX}",
    "port": 6099,
    "token": "${WEBUI_TOKEN}",
    "loginRate": 3
}
EOF
fi

rm -rf "/tmp/.X1-lock"

: ${NAPCAT_GID:=0}
: ${NAPCAT_UID:=0}
usermod -o -u ${NAPCAT_UID} napcat 2>/dev/null || true
groupmod -o -g ${NAPCAT_GID} napcat 2>/dev/null || true
usermod -g ${NAPCAT_GID} napcat 2>/dev/null || true

echo "[custom entrypoint] 跳过 chown -R /app"

gosu napcat Xvfb :1 -screen 0 1080x760x16 +extension GLX +render > /dev/null 2>&1 &
sleep 2

export FFMPEG_PATH=/usr/bin/ffmpeg
export DISPLAY=:1
cd /app/napcat
ACCOUNT=$(ls /app/napcat/config/ | grep -oE '[1-9][0-9]{4,12}' | head -n 1)
gosu napcat /opt/QQ/qq --no-sandbox -q $ACCOUNT