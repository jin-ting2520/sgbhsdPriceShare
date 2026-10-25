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
3. 「卡密」页批量生成卡密（1 天 / 1 月 / 永久，单批最多 500 张），也可对未使用卡密点「绑定」直接绑定到已有账号；
4. 启用前用户可用「昵称 + 密码」直接试用；启用后必须输入「昵称 + 密码 + 卡密」注册；
5. 管理后台可续期、封禁、调整设备记录上限、重置密码、踢下线；卡密一经注册、续期或后台绑定即消耗，不能重复使用；
6. 用户首次登录必须填写当前所在区服，之后可点击顶部「当前区服」切换；普通账号只关联自己当前区服的主账号。
7. 需要共享价格时，先确认主账号的「当前区服」已在用户端设置好，再到后台「区服」页为目标区服选择主账号，或在「账号」页对该账号选择「设为本区服主账号」；该区服普通账号默认开启共享，管理员也可对特定账号关闭（关闭后该账号隐藏「主账号价」开关）。开启后仅回退展示本人缺失的商品，本人数据始终优先。

## 2. 环境变量

在 `.env` 中配置（compose 自动读取），默认值如下：

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT` | `3000` | 宿主机访问端口 |
| `FORCE_HTTPS` | `0` | 生产建议设为 `1`，HTTP 请求会 308 跳转 HTTPS |
| `TRUST_PROXY` | `loopback,linklocal,uniquelocal` | 反向代理信任范围；直连可设 `false` |
| `ADMIN_PASSWORD` | 空 | 管理后台密码（**必须设置**；为空则后台禁用） |
| `ADMIN_TOKEN_HOURS` | `168` | 管理后台登录有效期（小时），默认 7 天，最长 365 天 |
| `MYSQL_ROOT_PASSWORD` | `sgbhsd_root` | MySQL root 密码（**生产务必修改**） |
| `MYSQL_DATABASE` | `sgbhsd` | 数据库名 |
| `MYSQL_USER` / `MYSQL_PASSWORD` | `sgbhsd` / `sgbhsd_pass` | 应用账号（**生产务必修改**） |
| `HISTORY_LIMIT` | `20000` | 每账号价格历史保留条数 |
| `TOOL_SSO_SECRET` | 空 | 三国冰河时代助手 SSO 共享密钥（**启用工具直登/同步时必须与工具端一致**；生产未配置会拒绝所有 SSO 请求，开发环境回退文档默认密钥并告警） |
| `SSO_INGEST_MIN_INTERVAL_MS` | `10000` | 同一工具账号两次 ingest 的最小间隔（毫秒），防重试风暴 |
| ~~`SSO_INGEST_TARGET`~~ | **已废弃** | 自安全修复 F1 起不再生效：工具同步**永远只写当前 SSO 账号自身**，绝不代写区服主账号；仅当该账号本身被设为该区服主账号时才按主账号共享广播。旧部署可安全删除此变量 |
| `TZ` | `Asia/Shanghai` | 时区（compose 已设置） |

容器内 app 的完整变量：`DB_DRIVER=mysql`、`MYSQL_HOST=mysql`、`MYSQL_PORT=3306`、`REDIS_URL=redis://redis:6379`。本地非 Docker 运行时，不设置 `MYSQL_HOST` 即使用 SQLite。

### 2.1 工具（三国冰河时代助手）SSO 与价格同步

助手可直接打开价格站并自动登录，无需用户在价格站再注册：助手用 `TOOL_SSO_SECRET` 签 60 秒一次性票据，价格站验签后按工具用户 ID 自动创建/绑定账号（昵称=工具昵称，重名自动加 `_2`/`_3`，到期时间跟随工具授权），随后助手在游戏内抓取 175 城价格并 `POST /api/sso/game-ingest` 写入。

- **两端 `TOOL_SSO_SECRET` 必须完全一致**（建议 32+ 字节随机字符串，例如 `openssl rand -hex 32`）；生产环境未配置时价格站会拒绝所有 SSO 请求（返回 503）。
- 价格站是 HTTP 时票据在局域网内可被抓包，但票据 60 秒过期且 nonce 一次性，风险有限；正式环境建议反代 HTTPS。
- SSO 账号默认：可查看/录入价格、可查看本区服主账号价格；不能指定同步区服；不能进入 `/admin` 后台（后台仍用 `ADMIN_PASSWORD`）。工具封禁/到期后助手不再签发票据，已登录的价格站会话在下次请求时按到期时间立即失效。
- **写入边界（安全修复 F1）**：`game-ingest` 写入的价格/税率/事件**只属于当前 SSO 账号自己**，不会覆盖其他账号（含区服主账号）的数据；只有当管理员把该 SSO 账号设为该区服主账号时，才会按「主账号价格共享」推送给开启共享的查看者。**无需再配置 `SSO_INGEST_TARGET`**（已废弃）。
- 接口：`POST /api/sso/tool-login`（scope=login）、`POST /api/sso/game-meta`（scope=ingest，需账号已绑定且未封禁/未到期）、`POST /api/sso/game-ingest`（scope=ingest）；三者不走会话 HMAC 签名，自行校验票据。

账号体系为「限时试用 + 卡密注册 + 密码登录」，登录与注册已分栏：登录页只填昵称 + 密码，不显示卡密；注册页才显示卡密和卡密帮助。卡密启用前新昵称可在注册页不填卡密直接试用，界面显示「试用中」；启用后新昵称注册必须携带未使用卡密，已有试用账号也需补卡密才能登录。已注册账号直接昵称 + 密码登录，账号不存在会引导注册，昵称已存在会引导登录；到期或试用结束可在登录页点「卡密续期」或按提示输入新卡密。管理员可在「卡密」页把未使用卡密直接绑定到账号，「账号」页也支持用卡密续期；每张卡密只能消耗一次，重复绑定或重复注册会失败。每个账号的价格、历史、税率、游戏 token、定时同步配置完全隔离；首次登录必须设置当前区服，之后可随时切换。主账号按区服独立配置，普通账号只回退本区服主账号价格且默认开启，保存/导入始终只写本人数据；管理员可对特定账号全局关闭共享，关闭后该账号隐藏开关并停止回退。同一账号最多保存 3 台设备记录（后台可调），同一设备可多标签页同时在线；可在「设备」中移除记录，退出登录不会释放设备名额。

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

迁移内容：字典、区服、账号（含区服参数权限）、卡密、价格、变更历史、城池坐标、城池税率、定时设置（含区服覆盖）、按区服主账号映射与同步日志。旧版全局主账号会按该账号当时的 `current_server` 转入 `server_masters`；当前区服为空时无法自动归属，升级后需在后台「区服」页重新设置。脚本兼容旧版共享库：旧数据没有 `account_id` 时归入「历史归属账号」（旧 token 所属账号，否则最早注册账号）；本地 SQLite 旧库没有账号时，首个注册的账号会自动接管旧数据。**会话与设备记录不迁移**，升级后所有用户需重新登录以生成设备记录。

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
    ssl_protocols       TLSv1.2 TLSv1.3;
    ssl_prefer_server_ciphers off;
    add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;

    location / {
        client_max_body_size 2m;
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

生产环境建议在 `.env` 设置 `FORCE_HTTPS=1`，由 Nginx 传递 `X-Forwarded-Proto`；应用会强制 308 跳转并发送 HSTS。请求正文的加密由 HTTPS/TLS 负责，应用层 HMAC 负责签名、防篡改和防重放。HTTP 局域网环境会自动回退到内置纯 JS HMAC 实现，功能不受影响。

## 8. 升级

```bash
git pull
docker compose up -d --build    # 重建 app；MySQL/Redis 数据卷不受影响
./deploy.sh status
```

升级注意：

- 新表（`account_devices` / `sessions` / `invite_keys` / `app_settings`）与 `account_id`、`device_ref_id` 列会在启动时自动创建/补齐；旧 `sessions` 会按 `device_id` 回填设备记录，`app_settings` 会自动增加卡密启用时间、卡密提示与 token 教程字段。旧库升级后历史数据归入最早注册账号。
- 极旧版本的会话表没有 `account_id` 时会重建，用户需重新登录；正常升级会保留仍有效的会话并绑定到设备记录。
- 若 `.env` 未设置 `ADMIN_PASSWORD`，升级后管理后台仍不可用。
- 前端产物在镜像构建时生成；本地源码运行可执行 `npm run build:ui`，未构建时服务端自动回退源码。产物新鲜度按源码内容哈希判定（`public/dist/.build-manifest.json`），源码变动后重启服务会自动重建，无需关心文件时间戳。

## 9. 常见问题

| 问题 | 解决 |
| --- | --- |
| `/admin` 显示「后台未启用」 | 在 `.env` 设置 `ADMIN_PASSWORD` 并重启 app |
| app 一直未启动 | `docker compose logs mysql` 看初始化；修改过 `.env` 密码后旧数据卷仍用旧密码，需删除 `mysql-data` 或改用原密码 |
| 状态 `unhealthy` | 查看 `/api/health` 与 `docker compose logs app`；确认 MySQL/Redis 健康 |
| 登录提示「设备记录已达上限」 | 在弹窗中移除旧设备记录，或到「设备」页管理；后台也可调整设备记录上限或强制下线 |
| 登录提示卡密到期/试用结束 | 在登录页点「卡密续期」输入新卡密，或后台「账号」页续期；封禁需后台解封 |
| 新昵称登录提示账号不存在 | 登录页会自动切到注册；卡密启用后需先在后台生成卡密，用户注册时填写 |
| 注册页没有卡密提示 / 同步页 token 教程为空 | 在后台「设置」填写对应 Markdown 并保存，用户端刷新后生效 |
| 实时协作显示未连接 | 反代需透传 WebSocket（见第 7 节）；确认 `/ws` 未被拦截；登录过期会以 4401 关闭 |
| 请求返回 401/40112 | 会话过期、设备变化或签名失败；退出后重新登录 |
| 管理后台登录后提示「缺少请求签名 / 验签失败」（40113） | 浏览器仍在运行旧版前端包（升级后未刷新）：关闭页面重新打开并强制刷新（Ctrl+Shift+R）；确认部署执行了 `docker compose up -d --build` 重建镜像 |
| 定时同步不执行 | 「定时」中确认已启用、cron 有效、token 已保存（区服默认由 token 自动识别；仅后台授权的账号可填写区服覆盖）；查看本账号运行记录与容器日志 |
| 数据没保存 | 确认 MySQL 健康且 app 使用 `DB_DRIVER=mysql`；`docker compose exec app env | grep MYSQL` |
| 忘记 MySQL 密码 | 使用 `.env` 中的 `MYSQL_ROOT_PASSWORD` 重置，或（可丢数据时）`docker compose down -v` 重建 |
| 忘记管理密码 | 修改 `.env` 的 `ADMIN_PASSWORD` 后 `docker compose up -d` 重建 app |

## 10. 本地开发（非 Docker）

```bash
npm ci
npm run build:ui   # 可选：生成 public/dist 混淆产物
npm run dev        # 默认 3000 端口，SQLite data/price.db
npm test           # 68 项测试
npm run test:smoke # 冒烟自检

# 管理后台
ADMIN_PASSWORD='your-strong-password' npm start

# 可选：本机连接 MySQL/Redis
DB_DRIVER=mysql MYSQL_HOST=127.0.0.1 MYSQL_USER=root MYSQL_PASSWORD=... \
  MYSQL_DATABASE=sgbhsd REDIS_URL=redis://127.0.0.1:6379 npm start
```

国内网络安装依赖可使用 `npm install --registry=https://registry.npmmirror.com`。
