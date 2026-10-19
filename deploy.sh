#!/usr/bin/env bash
# ============================================================
#  三国冰河时代富甲天下跑商价格分享 - 一键部署脚本（Linux / macOS）
#  用法：
#    ./deploy.sh            构建并启动（默认）
#    ./deploy.sh start      同上
#    ./deploy.sh update     拉取最新代码后重新构建并重启
#    ./deploy.sh stop       停止
#    ./deploy.sh restart    重启
#    ./deploy.sh logs       跟踪日志
#    ./deploy.sh status     查看状态
#    ./deploy.sh backup     备份 MySQL（无 mysql 服务时备份 SQLite）到 ./backup
#    ./deploy.sh restore    从 ./backup 的 .sql / .db 恢复数据库
#    ./deploy.sh clean      停止并删除容器（保留数据卷）
# ============================================================
set -euo pipefail

APP_NAME="sgbhsd-price-share"
PORT="${PORT:-3000}"
CMD="${1:-start}"
COMPOSE="docker compose"

cd "$(dirname "$0")"

# ---------- 前置检查 ----------
require_docker() {
  if ! command -v docker >/dev/null 2>&1; then
    echo "[错误] 未检测到 docker，请先安装 Docker（https://docs.docker.com/get-docker/）"
    exit 1
  fi
  if ! docker compose version >/dev/null 2>&1; then
    echo "[错误] 需要 Docker Compose V2（docker compose），请升级 Docker 客户端"
    exit 1
  fi
  docker info >/dev/null 2>&1 || { echo "[错误] Docker 守护进程未运行"; exit 1; }
}

health_wait() {
  echo "  => 等待服务就绪（http://localhost:${PORT}，首次启动初始化 MySQL 可能较慢）..."
  i=0
  while [ "$i" -lt 90 ]; do
    if command -v curl >/dev/null 2>&1 && curl -fsS "http://127.0.0.1:${PORT}/api/health" >/dev/null 2>&1; then
      echo "  => 启动成功！"
      return 0
    fi
    i=$((i + 1))
    sleep 1
  done
  echo "  => 启动超时，请使用 ./deploy.sh logs 查看日志"
  return 1
}

# ---------- 命令分发 ----------
case "$CMD" in
  start)
    require_docker
    mkdir -p data backup
    echo "==> 构建镜像并启动 ${APP_NAME}"
    $COMPOSE build
    $COMPOSE up -d
    health_wait || true
    echo ""
    echo "  访问地址 : http://localhost:${PORT}"
    echo "  数据存储 : MySQL 数据卷 mysql-data（SQLite 兜底/迁移源：$(pwd)/data/price.db）"
    echo "  备份命令 : ./deploy.sh backup"
    echo ""
    ;;
  update)
    require_docker
    if [ -d .git ]; then
      echo "==> 拉取最新代码"
      git pull --ff-only || echo "  (git pull 失败，使用当前代码继续构建)"
    fi
    echo "==> 重新构建并重启"
    $COMPOSE build
    $COMPOSE up -d
    health_wait || true
    ;;
  stop)
    require_docker
    echo "==> 停止 ${APP_NAME}"
    $COMPOSE stop
    ;;
  restart)
    require_docker
    echo "==> 重启 ${APP_NAME}"
    $COMPOSE restart
    health_wait || true
    ;;
  logs)
    require_docker
    $COMPOSE logs -f --tail 100
    ;;
  status)
    require_docker
    $COMPOSE ps
    ;;
  backup)
    require_docker
    mkdir -p backup
    TS="$(date +%Y%m%d-%H%M%S)"
    if $COMPOSE ps --status running --services 2>/dev/null | grep -qx mysql; then
      FILE="backup/mysql-${TS}.sql"
      $COMPOSE exec -T mysql sh -c 'exec mysqldump -uroot -p"$MYSQL_ROOT_PASSWORD" --single-transaction --routines --triggers --databases "$MYSQL_DATABASE" > "/backup/mysql-$1.sql"' sh "$TS"
    else
      FILE="backup/price-${TS}.db"
      $COMPOSE cp app:/app/data/price.db "$FILE" 2>/dev/null || cp -f data/price.db "$FILE"
    fi
    echo "==> 已备份到 $FILE"
    ;;
  restore)
    require_docker
    FILE="${2:-}"
    if [ -z "$FILE" ] || [ ! -f "$FILE" ]; then
      echo "用法: ./deploy.sh restore backup/mysql-YYYYmmdd-HHMMSS.sql"
      echo "      ./deploy.sh restore backup/price-YYYYmmdd-HHMMSS.db"
      ls -1 backup 2>/dev/null || echo "  (backup 目录为空)"
      exit 1
    fi
    read -r -p "确认用 $FILE 覆盖当前数据库？（容器将重启）[y/N] " ok
    [ "$ok" = "y" ] || [ "$ok" = "Y" ] || exit 0
    case "$FILE" in
      *.sql)
        BASE="$(basename "$FILE")"
        $COMPOSE stop app >/dev/null 2>&1 || true
        $COMPOSE exec -T mysql sh -c 'exec mysql -uroot -p"$MYSQL_ROOT_PASSWORD" < "/backup/$1"' sh "$BASE"
        $COMPOSE start app
        ;;
      *)
        cp -f "$FILE" data/price.db
        $COMPOSE restart app
        ;;
    esac
    echo "==> 已恢复并重启"
    ;;
  clean)
    require_docker
    read -r -p "确认停止并删除容器？（MySQL 数据卷与 ./data 会保留）[y/N] " ok
    [ "$ok" = "y" ] || [ "$ok" = "Y" ] || exit 0
    $COMPOSE down
    echo "==> 已清理（数据仍在 Docker 卷 mysql-data 与 ./data 目录）"
    ;;
  *)
    echo "用法: $0 [start|update|stop|restart|logs|status|backup|restore|clean]"
    exit 1
    ;;
esac
