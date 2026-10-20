# 部署指南（Docker Compose）

三国冰河时代富甲天下跑商价格分享默认以 **app + MySQL 8.4 + Redis 7** 三容器方式部署，一条命令完成建库、建表、种子数据与健康检查。只有 app 单容器运行时自动退化为 SQLite。

---

## 1. 快速部署

```bash
git clone https://github.com/jin-ting2520/sgbhsdPriceShare.git
cd sgbhsdPriceShare

cp .env.example .env      # 可选：修改数据库密码与端口
docker compose up -d --build

# 或执行部署脚本
./deploy.sh               # Linux / macOS
./deploy.ps1              # Windows PowerShell
```

启动后访问 `http://服务器IP:3000`。首次启动 MySQL 初始化可能需要 30–60 秒，app 会等待其健康后启动。

```bash
docker compose ps          # app/mysql/redis 状态
docker compose logs -f app # 应用日志
```

## 2. 环境变量

在 `.env` 中配置（compose 自动读取），默认值如下：

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT` | `3000` | 宿主机访问端口 |
| `MYSQL_ROOT_PASSWORD` | `sgbhsd_root` | MySQL root 密码（**生产务必修改**） |
| `MYSQL_DATABASE` | `sgbhsd` | 数据库名 |
| `MYSQL_USER` / `MYSQL_PASSWORD` | `sgbhsd` / `sgbhsd_pass` | 应用账号（**生产务必修改**） |
| `HISTORY_LIMIT` | `20000` | 每区服价格历史保留条数 |
| `TZ` | `Asia/Shanghai` | 时区（compose 已设置） |

容器内 app 的完整变量：`DB_DRIVER=mysql`、`MYSQL_HOST=mysql`、`MYSQL_PORT=3306`、`REDIS_URL=redis://redis:6379`。本地非 Docker 运行时，不设置 `MYSQL_HOST` 即使用 SQLite。

本应用**无登录鉴权**：使用者输入「三国冰河时代昵称」即可进入，昵称缓存在各自浏览器，保存价格时作为更新人记录。

## 3. 数据持久化

| 数据 | 位置 |
| --- | --- |
| MySQL 数据 | Docker 命名卷 `mysql-data` |
| Redis AOF | Docker 命名卷 `redis-data` |
| SQLite 兜底库 / 迁移源 | 宿主机 `./data/price.db` |
| 备份 | 宿主机 `./backup`（同时挂载到 mysql 容器 `/backup`） |

`docker compose down` 保留命名卷；`docker compose down -v` 会删除 MySQL/Redis 数据卷（慎用）。

## 4. 备份与恢复

```bash
# 备份 MySQL（生成 backup/mysql-时间戳.sql）
./deploy.sh backup

# 恢复（脚本会先暂停 app，导入后重启）
./deploy.sh restore backup/mysql-20260101-120000.sql

# 无 mysql 服务（纯 SQLite 部署）时，backup 自动改为复制 data/price.db
```

Windows：

```powershell
.\deploy.ps1 backup
.\deploy.ps1 restore backup\mysql-20260101-120000.sql
```

手动备份/恢复 MySQL：

```bash
docker compose exec -T mysql sh -c \
  'exec mysqldump -uroot -p"$MYSQL_ROOT_PASSWORD" --single-transaction --databases "$MYSQL_DATABASE"' \
  > backup/manual.sql

docker compose stop app
docker compose exec -T mysql sh -c \
  'exec mysql -uroot -p"$MYSQL_ROOT_PASSWORD"' < backup/manual.sql
docker compose start app
```

建议对 `./backup` 配置宿主机定时任务并异地保存。

## 5. 从旧 SQLite 迁移

旧版本的 `./data/price.db` 会挂载到 app 容器。MySQL 部署成功后执行：

```bash
docker compose exec app npm run db:migrate           # 目标库为空时
docker compose exec app npm run db:migrate -- --force # 目标库已有数据时合并
```

迁移内容：字典、区服、价格、变更历史、城池坐标、城池税率、账号与同步设置。

## 6. 使用 Docker Hub 镜像（单容器 / SQLite）

仓库配置 GitHub Secrets 后，推送 `main`/`master` 或 `v*` 标签会自动构建并发布多架构镜像（amd64 / arm64）。单容器运行时不带 MySQL/Redis，自动使用 SQLite：

```bash
docker pull ywtm/sgbhsd-price-share:latest

docker run -d \
  --name sgbhsd-price-share \
  --restart always \
  -p 3000:3000 \
  -v "$(pwd)/data:/app/data" \
  -v "$(pwd)/backup:/app/backup" \
  ywtm/sgbhsd-price-share:latest
```

需要 MySQL/Redis 时请使用仓库中的 `docker-compose.yml`。

### 配置 GitHub Actions Secrets

仓库 → **Settings → Secrets and variables → Actions → New repository secret**：

| Secret | 值 |
| --- | --- |
| `DOCKERHUB_USERNAME` | Docker Hub 用户名 |
| `DOCKERHUB_TOKEN` | Docker Hub Access Token（权限 Write） |

镜像命名：`{DOCKERHUB_USERNAME}/sgbhsd-price-share:{分支名|版本号|sha}`。

## 7. 反向代理 + HTTPS（Nginx 示例）

WebSocket 需要透传 `Upgrade`/`Connection` 头，并适当延长超时：

```nginx
server {
    listen 80;
    server_name price.example.com;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl http2;
    server_name price.example.com;
    ssl_certificate     /etc/letsencrypt/live/price.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/price.example.com/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_read_timeout 300s;
    }
}
```

## 8. 升级

```bash
git pull
docker compose up -d --build    # 重建 app；MySQL/Redis 数据卷不受影响
./deploy.sh status
```

## 9. 常见问题

| 问题 | 解决 |
| --- | --- |
| app 一直未启动 | `docker compose logs mysql` 看初始化；修改过 `.env` 密码后旧数据卷仍用旧密码，需删除 `mysql-data` 或改用原密码 |
| 状态 `unhealthy` | 查看 `/api/health` 与 `docker compose logs app`；确认 MySQL/Redis 健康 |
| 实时协作显示未连接 | 反代需透传 WebSocket（见第 7 节）；确认 `/ws` 未被拦截 |
| 定时同步不执行 | 页面「定时」中确认已启用、cron 有效、token 与区服已保存；查看运行记录与容器日志 |
| 数据没保存 | 确认 MySQL 健康且 app 使用 `DB_DRIVER=mysql`；`docker compose exec app env | grep MYSQL` |
| 忘记 MySQL 密码 | 使用 `.env` 中的 `MYSQL_ROOT_PASSWORD` 重置，或（可丢数据时）`docker compose down -v` 重建 |
| 昵称每次都要重输 | 昵称只存浏览器 localStorage，属正常现象 |

## 10. 本地开发（非 Docker）

```bash
npm ci
npm run dev        # 默认 3000 端口，SQLite data/price.db
npm test           # 31 项测试
npm run test:smoke # 冒烟自检

# 可选：本机连接 MySQL/Redis
DB_DRIVER=mysql MYSQL_HOST=127.0.0.1 MYSQL_USER=root MYSQL_PASSWORD=... \
  MYSQL_DATABASE=sgbhsd REDIS_URL=redis://127.0.0.1:6379 npm start
```
