# 部署指南（Docker Compose）

三国冰河时代富甲天下跑商价格分享默认以 **app + MySQL 8.4 + Redis 7** 三容器方式部署，一条命令完成建库、建表、种子数据与健康检查。只有 app 单容器运行时自动退化为 SQLite。

> 卡密版必须设置 `ADMIN_PASSWORD`，否则 `/admin` 管理后台禁用（用户端不受影响）。

---

## 1. 快速部署

```bash
git clone https://github.com/jin-ting2520/sgbhsdPriceShare.git
cd sgbhsdPriceShare

cp .env.example .env      # 必改 ADMIN_PASSWORD 与数据库密码
docker compose up -d --build

# 或执行部署脚本
./deploy.sh               # Linux / macOS
./deploy.ps1              # Windows PowerShell
```

启动后访问 `http://服务器IP:3000`，管理后台为 `http://服务器IP:3000/admin`。首次启动 MySQL 初始化可能需要 30–60 秒，app 会等待其健康后启动。

```bash
docker compose ps          # app/mysql/redis 状态
docker compose logs -f app # 应用日志
```

首次使用流程：

1. 用 `ADMIN_PASSWORD` 登录 `/admin`；
2. 「设置」确认卡密启用时间（默认 `2026-10-22 00:00:00`），按需配置卡密提示与 token 教程（支持 Markdown）；
3. 「卡密」页批量生成卡密（1 天 / 1 月 / 永久，单批最多 500 张）；
4. 启用前用户可用「昵称 + 密码」直接试用；启用后必须输入「昵称 + 密码 + 卡密」注册；
5. 管理后台可续期、封禁、调整设备上限、重置密码、踢下线。

## 2. 环境变量

在 `.env` 中配置（compose 自动读取），默认值如下：

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT` | `3000` | 宿主机访问端口 |
| `ADMIN_PASSWORD` | 空 | 管理后台密码（**必须设置**；为空则后台禁用） |
| `MYSQL_ROOT_PASSWORD` | `sgbhsd_root` | MySQL root 密码（**生产务必修改**） |
| `MYSQL_DATABASE` | `sgbhsd` | 数据库名 |
| `MYSQL_USER` / `MYSQL_PASSWORD` | `sgbhsd` / `sgbhsd_pass` | 应用账号（**生产务必修改**） |
| `HISTORY_LIMIT` | `20000` | 每账号价格历史保留条数 |
| `TZ` | `Asia/Shanghai` | 时区（compose 已设置） |

容器内 app 的完整变量：`DB_DRIVER=mysql`、`MYSQL_HOST=mysql`、`MYSQL_PORT=3306`、`REDIS_URL=redis://redis:6379`。本地非 Docker 运行时，不设置 `MYSQL_HOST` 即使用 SQLite。

账号体系为「限时试用 + 卡密注册 + 密码登录」：卡密启用前新昵称可直接注册试用，界面显示「试用中」；启用后新昵称必须携带未使用卡密，已有试用账号也需补卡密才能登录。已注册账号直接昵称 + 密码登录，到期或试用结束可输入新卡密续期。每个账号的价格、历史、税率、游戏 token、定时同步配置完全隔离，同一账号最多 3 台设备（后台可调）并可在「设备」中自助踢出。

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

迁移内容：字典、区服、账号（含区服参数权限）、卡密、价格、变更历史、城池坐标、城池税率、定时设置（含区服覆盖）与同步日志。脚本兼容旧版共享库：旧数据没有 `account_id` 时归入「历史归属账号」（旧 token 所属账号，否则最早注册账号）；本地 SQLite 旧库没有账号时，首个注册的账号会自动接管旧数据。**会话不迁移**，升级后所有用户需重新登录以绑定设备。

## 6. 使用 Docker Hub 镜像（单容器 / SQLite）

仓库配置 GitHub Secrets 后，推送 `main`/`master` 或 `v*` 标签会自动构建并发布多架构镜像（amd64 / arm64）。单容器运行时不带 MySQL/Redis，自动使用 SQLite：

```bash
docker pull ywtm/sgbhsd-price-share:latest

docker run -d \
  --name sgbhsd-price-share \
  --restart always \
  -p 3000:3000 \
  -e ADMIN_PASSWORD='your-strong-password' \
  -v "$(pwd)/data:/app/data" \
  -v "$(pwd)/backup:/app/backup" \
  ywtm/sgbhsd-price-share:latest
```

镜像构建阶段会自动执行 `npm run build:ui` 生成混淆产物，再裁掉开发依赖；运行期无需构建工具。需要 MySQL/Redis 时请使用仓库中的 `docker-compose.yml`。

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

启用 HTTPS 后浏览器可使用 `crypto.subtle` 签名；HTTP 局域网环境会自动回退到内置纯 JS HMAC 实现，功能不受影响。

## 8. 升级

```bash
git pull
docker compose up -d --build    # 重建 app；MySQL/Redis 数据卷不受影响
./deploy.sh status
```

升级注意：

- 新表（`sessions` / `invite_keys` / `app_settings`）与 `account_id` 列会在启动时自动创建/补齐；`app_settings` 会自动增加卡密启用时间、卡密提示与 token 教程字段。旧库升级后历史数据归入最早注册账号。
- 会话表结构变化后旧会话失效，用户需重新登录。
- 若 `.env` 未设置 `ADMIN_PASSWORD`，升级后管理后台仍不可用。
- 前端产物在镜像构建时生成；本地源码运行可执行 `npm run build:ui`，未构建时服务端自动回退源码。

## 9. 常见问题

| 问题 | 解决 |
| --- | --- |
| `/admin` 显示「后台未启用」 | 在 `.env` 设置 `ADMIN_PASSWORD` 并重启 app |
| app 一直未启动 | `docker compose logs mysql` 看初始化；修改过 `.env` 密码后旧数据卷仍用旧密码，需删除 `mysql-data` 或改用原密码 |
| 状态 `unhealthy` | 查看 `/api/health` 与 `docker compose logs app`；确认 MySQL/Redis 健康 |
| 登录提示「设备数量已达上限」 | 在弹窗中踢出旧设备，或到「设备」页管理；后台也可调整设备上限或强制下线 |
| 登录提示卡密到期/试用结束 | 在登录页输入新卡密续期，或后台「账号」页续期；封禁需后台解封 |
| 新昵称登录提示缺少卡密 | 卡密启用时间已到，请先在后台生成卡密；如需继续试用，可在「设置」调整启用时间 |
| 登录页没有卡密提示 / token 教程为空 | 在后台「设置」填写对应 Markdown 并保存，用户端刷新后生效 |
| 实时协作显示未连接 | 反代需透传 WebSocket（见第 7 节）；确认 `/ws` 未被拦截；登录过期会以 4401 关闭 |
| 请求返回 401/40112 | 会话过期、设备变化或签名失败；退出后重新登录 |
| 定时同步不执行 | 「定时」中确认已启用、cron 有效、token 已保存（区服默认由 token 自动识别；仅后台授权的账号可填写区服覆盖）；查看本账号运行记录与容器日志 |
| 数据没保存 | 确认 MySQL 健康且 app 使用 `DB_DRIVER=mysql`；`docker compose exec app env | grep MYSQL` |
| 忘记 MySQL 密码 | 使用 `.env` 中的 `MYSQL_ROOT_PASSWORD` 重置，或（可丢数据时）`docker compose down -v` 重建 |
| 忘记管理密码 | 修改 `.env` 的 `ADMIN_PASSWORD` 后 `docker compose up -d` 重建 app |

## 10. 本地开发（非 Docker）

```bash
npm ci
npm run build:ui   # 可选：生成 public/dist 混淆产物
npm run dev        # 默认 3000 端口，SQLite data/price.db
npm test           # 50 项测试
npm run test:smoke # 冒烟自检

# 管理后台
ADMIN_PASSWORD='your-strong-password' npm start

# 可选：本机连接 MySQL/Redis
DB_DRIVER=mysql MYSQL_HOST=127.0.0.1 MYSQL_USER=root MYSQL_PASSWORD=... \
  MYSQL_DATABASE=sgbhsd REDIS_URL=redis://127.0.0.1:6379 npm start
```

国内网络安装依赖可使用 `npm install --registry=https://registry.npmmirror.com`。
