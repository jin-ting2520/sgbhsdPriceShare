# 部署指南（Docker）

三国冰河时代富甲天下跑商价格分享为**单容器 Node.js 应用**（内置 SQLite，无外部数据库依赖），支持 Docker / Docker Compose 一键部署。

---

## 1. 快速部署（推荐）

```bash
git clone https://github.com/jin-ting2520/sgbhsdPriceShare.git
cd sgbhsdPriceShare

# 方式一：Compose 一键启动
docker compose up -d --build

# 方式二：执行部署脚本
./deploy.sh          # Linux / macOS
./deploy.ps1         # Windows PowerShell
```

启动后访问 `http://服务器IP:3000`。

```bash
docker compose ps          # 查看状态（healthy 表示健康）
docker compose logs -f     # 查看日志
```

## 2. 环境变量

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT` | `3000` | 对外端口（compose 下：`PORT=8080 docker compose up -d`） |
| `TZ` | `Asia/Shanghai` | 时区（容器内已默认） |
| `PRICE_DB` | `/app/data/price.db` | SQLite 数据库路径（一般无需设置） |

本应用**无登录鉴权**：使用者打开页面输入「三国冰河时代昵称」即可进入，昵称缓存在各自浏览器本机，保存价格时自动作为更新人记录。

## 3. 数据持久化与备份

Compose 已将容器内 `/app/data`、`/app/backup` 挂载到宿主机同名目录：

```
./data/price.db      # 主数据库
./backup/            # 备份文件
```

**手动备份 / 恢复：**

```bash
# 备份（SQLite 热备份，不中断服务）
docker compose exec app node -e "const{DatabaseSync}=require('node:sqlite');const s=new DatabaseSync('/app/data/price.db');s.exec(\"VACUUM INTO '/app/backup/price-$(date +%Y%m%d-%H%M).db'\");" 

# 恢复（先停服务，再用备份覆盖）
docker compose down
cp ./backup/price-20260101-1200.db ./data/price.db
docker compose up -d
```

## 4. 使用 Docker Hub 镜像部署

仓库配置好 GitHub Secrets（见下节）后，每次推送 `main`/`master` 或打 `v*` 标签都会自动构建并发布多架构镜像（amd64 / arm64）。

```bash
docker pull jin-ting2520/sgbhsd-price-share:latest

docker run -d \
  --name sgbhsd-price-share \
  --restart unless-stopped \
  -p 3000:3000 \
  -v "$(pwd)/data:/app/data" \
  -v "$(pwd)/backup:/app/backup" \
  jin-ting2520/sgbhsd-price-share:latest
```

### 配置 GitHub Actions Secrets

仓库 → **Settings → Secrets and variables → Actions → New repository secret**：

| Secret | 值 |
| --- | --- |
| `DOCKERHUB_USERNAME` | Docker Hub 用户名 |
| `DOCKERHUB_TOKEN` | Docker Hub Access Token（[创建](https://hub.docker.com/settings/security)，权限 Write） |

镜像命名规则：`{DOCKERHUB_USERNAME}/sgbhsd-price-share:{分支名|版本号|sha}`。

## 5. 反向代理 + HTTPS（Nginx 示例）

```nginx
server {
    listen 80;
    server_name price.example.com;
    # certbot 签发证书后强制 HTTPS
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl http2;
    server_name price.example.com;
    ssl_certificate     /etc/letsencrypt/live/price.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/price.example.com/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

## 6. 升级

```bash
git pull
docker compose up -d --build    # 重建并滚动重启，数据不受影响
```

## 7. 常见问题

| 问题 | 解决 |
| --- | --- |
| 容器启动即退出 / 反复重启 | `docker compose logs app` 查看报错；端口被占用时改 `PORT` |
| 状态显示 `unhealthy` | 检查 `/api/health`（容器内自动探活），确认 Node 版本支持 `node:sqlite`（≥22.5，镜像内为 24） |
| 数据没保存下来 | 确认 `./data` 卷挂载存在；容器内数据库路径为 `/app/data/price.db` |
| 换了电脑 / 清了浏览器缓存要重新输昵称 | 正常现象：昵称只存在浏览器本机（localStorage），输入一次后刷新页面免重复输入 |

## 8. 本地开发（非 Docker）

```bash
npm ci
npm run dev        # 开发模式（node --watch，默认 3000 端口）
npm test           # 运行全部测试（14 项）
```
