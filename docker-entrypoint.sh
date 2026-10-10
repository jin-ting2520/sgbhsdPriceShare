#!/bin/sh
# 容器入口：以 root 启动，确保数据目录存在且可写，再降权为 node 用户运行应用。
# 解决挂载卷（./data）属主为 root 时，容器内 node 用户无法创建 SQLite 文件的问题。
set -e

mkdir -p /app/data /app/backup
chown -R node:node /app/data /app/backup 2>/dev/null || true

exec su-exec node "$@"
