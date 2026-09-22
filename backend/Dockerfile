# QQ AI AutoReply 后端镜像（B 方案：插件 ComposeProvider 托管）
# 构建：docker build -t qq-autoreply-backend:<tag> ./backend
# 运行：见 docs/deployment.md；数据卷挂载到 /data（SQLite 位于 /data/app.db）
#
# 容器内可以完全不带 config.yaml：默认值 + 环境变量即可运行——
#   AUTOREPLY_ONEBOT_TOKEN  OneBot access_token（与 NapCat 侧同值注入）
#   AUTOREPLY_PORT          监听端口（默认 8001）
#   AUTOREPLY_DATA          数据目录（默认 /data）
FROM python:3.11-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    AUTOREPLY_DATA=/data

WORKDIR /app

# 非 root 运行（uid 固定 10001，命名卷/挂载卷按此对属主）
RUN useradd --create-home --uid 10001 autoreply \
    && mkdir -p /data \
    && chown autoreply:autoreply /data

# 宿主机 umask 可能为 077（文件 600），COPY --chown 确保运行用户可读。
# 注意：legacy builder 的 --chown 只认数字 ID 或已存在用户。
COPY --chown=10001:10001 requirements.txt ./
# 网络受限环境可 --build-arg PIP_INDEX_URL=<镜像源> 覆盖，默认官方源
ARG PIP_INDEX_URL=https://pypi.org/simple
RUN pip install --no-cache-dir --index-url "${PIP_INDEX_URL}" -r requirements.txt

COPY --chown=10001:10001 app ./app
USER autoreply

EXPOSE 8001
VOLUME ["/data"]

CMD ["python", "-m", "uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8001"]
