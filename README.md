# 三国冰河时代富甲天下跑商价格分享

城池 / 商品买卖价格的在线录入、查询与共享平台。支持**游戏直连同步**、**WebSocket 实时协作**、**定时自动同步**、**跨城套利报表**；生产环境使用 **MySQL + Redis**，`docker compose up -d --build` 一键部署，本地开发与测试自动使用 SQLite。PC 与手机端自适应。昵称 + 密码登录（首次输入即自动注册），各账号的游戏 token 独立存储、仅本人可见。

## 一、技术选型与架构

| 层 | 选型 | 说明 |
| --- | --- | --- |
| 运行时 | **Node.js 24** | 前后端同语言；SQLite 使用内置 `node:sqlite`，零原生编译依赖 |
| 后端框架 | **Express 4 + ws** | REST API + WebSocket 实时推送 |
| 数据库 | **MySQL 8.4（生产）/ SQLite（本地、测试、兜底）** | 通过 `DB_DRIVER` 或 `MYSQL_HOST` 自动选择；SQL 由 `server/db.js` 统一适配 |
| 缓存 | **Redis 7（可选）** | 字典数据缓存；未配置或连接失败时自动退化为无缓存 |
| 定时任务 | **node-cron** | 按北京时间执行游戏同步，可在页面配置频率 |
| 前端 | **Vue 3 + Element Plus** | importmap + ESM 无构建步骤，本地 node_modules 直出，不依赖外网 CDN |
| 部署 | **Docker Compose** | app + mysql + redis 一次拉起，健康检查、数据卷、备份脚本齐备 |

```
┌──────────────────────── docker compose ────────────────────────┐
│                                                                │
│  app (node:24-alpine, 非 root, :3000)                          │
│   ├─ /api/dict            字典 CRUD（Redis 缓存 + 变更广播）     │
│   ├─ /api/servers         区服                                 │
│   ├─ /api/prices          查询/保存(乐观并发)/日志/趋势/比价/导入导出 │
│   ├─ /api/game/sync       游戏直连同步（42 城 × 25 商品，原价 + 税率入账）  │
│   ├─ /api/auth            账号登录 / 会话 / 本人 token                    │
│   ├─ /api/sync-settings   定时同步配置 / 立即执行 / 运行日志      │
│   ├─ /api/reports         涨跌幅榜 / 套利建议 / 更新热度          │
│   ├─ /ws                  WebSocket 实时协作                    │
│   └─ 静态：index.html + Vue3 ESM + Element Plus                 │
│                                                                │
│  mysql:8.4 (mysql-data 卷)      redis:7 (redis-data 卷)         │
└────────────────────────────────────────────────────────────────┘
```

## 二、功能

| 模块 | 说明 |
| --- | --- |
| 账号入口 | 昵称 + 密码登录，首次输入即自动注册；无角色权限，仅以账号区分更新人并隔离各账号的游戏 token（存库，仅本人可见） |
| 价格录入 | 桌面表格 / 手机卡片双布局；行内输入、同上一行、脏值跟踪、确认弹窗、Ctrl+Enter 保存 |
| 查询与字典 | 区服联想、城池/商品下拉（可输入新增）；商品负重维护；被引用项禁止删除 |
| 实时协作 | WebSocket 推送他人改价，正在查看的城池立即刷新；本地有未保存修改时标记冲突 |
| 并发保护 | 保存携带 `baseUpdatedAt`，被他人抢先更新时返回 `40903`，可选「覆盖保存」或「使用最新数据」 |
| 游戏直连同步 | 凭 `x-game-token-pcweb` 登录游戏服务器，逐城抓取 42 城价格，落库税前原价与城池税率（每城 3 个商品可买入、25 个可卖出） |
| 赋税换算 | 各城税率自动同步；用户可设「我的赋税减免」（默认 5%，本机缓存），价格按个人减免实时换算，手工录入/导入自动反推原价 |
| 定时同步 | 页面配置开关、cron 频率、区服、更新人；token 存于保存者账号并绑定该账号，服务器定时执行并保留运行记录 |
| 报表 | 涨跌幅榜、城池间套利建议（按载重估算可购件数与毛利）、改价与同步热度图 |
| 历史与趋势 | `price_history` 记录改价前后值与操作人；SVG 趋势图支持 7/30/90 天、缩放/拖拽 |
| 导入导出 | Excel 导入（模板下载、预览修改、自动建商品、merge 模式）、CSV 导出 |
| 运维 | 健康检查 `/api/health`、Docker 健康依赖、MySQL 备份/恢复脚本、PWA 离线缓存 |

## 三、快速开始

### Docker 一键部署（推荐）

```bash
cp .env.example .env        # 可选；不创建则使用默认密码
docker compose up -d --build

# 或使用脚本
./deploy.sh                 # Linux / macOS
.\deploy.ps1                # Windows PowerShell
```

启动后访问 `http://服务器IP:3000`。首次启动会自动初始化 MySQL 库表与种子数据（40 城池 / 25 商品）。首次打开输入昵称与自定义密码即可（自动注册）；进入后在「同步」粘贴自己的游戏 token，token 仅本账号可见、可留空复用。完整部署、备份恢复、反代与升级说明见 **[DEPLOY.md](./DEPLOY.md)**。

### 本地开发（SQLite，无需 MySQL/Redis）

```bash
npm install
npm start          # http://localhost:3000
npm run dev        # 文件变化自动重启
npm test           # 38 项后端/账号/游戏/报表测试
npm run test:smoke # 冒烟自检（健康检查 + 写入/查询 + 并发冲突）
npm run db:vacuum  # SQLite VACUUM / MySQL OPTIMIZE
```

要求 Node.js ≥ 22.5。未设置 `MYSQL_HOST` / `DB_DRIVER=mysql` 时自动使用 `data/price.db`；连接 Redis 需设置 `REDIS_URL`。

### 从旧 SQLite 迁移到 MySQL

```bash
# compose 环境下（./data 已挂载，MySQL 连接信息来自容器环境）
docker compose exec app npm run db:migrate

# 目标库已有数据时可加 --force 合并
docker compose exec app npm run db:migrate -- --force
```

迁移脚本将字典、区服、价格、历史、城池坐标、城池税率与同步设置写入 MySQL；目标库为空时直接导入。

## 四、环境变量

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT` | `3000` | 监听端口 |
| `DB_DRIVER` | 有 `MYSQL_HOST` 则 `mysql`，否则 `sqlite` | 强制指定驱动 |
| `MYSQL_HOST` / `MYSQL_PORT` | `127.0.0.1` / `3306` | MySQL 地址 |
| `MYSQL_USER` / `MYSQL_PASSWORD` | `price` / `price` | MySQL 账号 |
| `MYSQL_DATABASE` | `price_share` | 数据库名 |
| `MYSQL_POOL` | `10` | 连接池大小 |
| `REDIS_URL` | 空 | 如 `redis://redis:6379`；为空则禁用缓存 |
| `PRICE_DB` | `data/price.db` | SQLite 文件路径 |
| `HISTORY_LIMIT` | `20000` | 每区服价格历史保留条数 |
| `TZ` | `Asia/Shanghai` | 时区（时间统一按北京时间存储） |

## 五、目录结构

```
sgbhsdPriceShare/
├── server/
│   ├── index.js            # Express 入口（静态托管 + API + WS + 健康检查）
│   ├── db.js               # 双驱动数据层（MySQL/SQLite）、建表、种子、事务
│   ├── cache.js            # Redis 字典缓存（失败自动退化）
│   ├── dict-cache.js       # 字典缓存失效 + 广播（字典/同步共用）
│   ├── ws.js               # WebSocket 服务端与广播
│   ├── scheduler.js        # node-cron 定时同步与运行日志
│   ├── util.js             # 统一响应/校验
│   ├── auth.js             # 账号密码（scrypt）、会话与 token 隔离
│   ├── routes/
│   │   ├── auth.js         # /api/auth 登录注册/会话/本人 token
│   │   ├── dict.js         # /api/dict
│   │   ├── servers.js      # /api/servers
│   │   ├── prices.js       # 查询/保存/日志/趋势/比价/导出/导入
│   │   ├── game.js         # /api/game/sync
│   │   ├── sync-settings.js# 定时同步配置与日志
│   │   └── reports.js      # 涨跌幅/套利/热度
│   ├── game/               # 游戏协议直连（登录链 + WS + Thrift 编解码）
│   │   ├── login.js        # JWT → authCode → SDK 登录 → v1/login
│   │   ├── client.js       # 游戏 WebSocket 客户端
│   │   ├── sync.js         # 逐城抓取 → 原价 + 税率落库
│   │   ├── frame.js        # 10 字节帧头
│   │   ├── thrift.js       # Thrift Compact Protocol
│   │   ├── thrift_schema.json
│   │   └── data/city_map.json  # 42 城池映射（nodeNo/metaId/gridX/gridY）
│   └── scripts/
│       ├── game-sync.js        # CLI 同步（--settings 复用定时配置）
│       ├── migrate-to-mysql.js # SQLite → MySQL
│       ├── smoke.js            # 冒烟自检
│       └── vacuum.js           # 数据库维护
├── public/
│   ├── index.html          # 页面模板（含同步/定时/报表弹窗）
│   ├── js/app.js           # Vue 应用（WS、乐观并发、导入、报表）
│   ├── css/app.css
│   ├── sw.js               # Service Worker
│   ├── manifest.webmanifest
│   └── icons/icon.svg
├── test/
│   ├── api.test.js         # 接口测试（17）
│   ├── auth.test.js        # 账号/会话/token 隔离（4）
│   ├── game.test.js        # 游戏同步模块（9）
│   └── reports.test.js     # 报表/定时设置/并发（8）
├── data/                   # SQLite（本地/兜底/迁移源，勿提交）
├── backup/                 # 备份目录（MySQL dump / SQLite 副本）
├── docker-compose.yml      # app + mysql + redis
├── Dockerfile
├── deploy.sh / deploy.ps1
├── DEPLOY.md
└── package.json
```

## 六、API 一览

除各账号自己的游戏 token 外全部接口开放，无需登录；写操作通过 `operator` 记录更新人昵称。涉账号自身 token 的接口需携带会话头 `X-Account-Token`。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/health` | 健康检查（返回驱动、缓存、WS 人数、定时状态） |
| POST | `/api/auth/login` `{name,password}` | 昵称 + 密码登录；首次输入自动注册，返回 `{name,session,token,created}` |
| POST | `/api/auth/logout` | 注销当前会话 |
| GET | `/api/auth/me` | 当前账号与本人的游戏 token（仅本人可见） |
| PUT | `/api/auth/token` `{token}` | 更新本人游戏 token |
| GET | `/api/dict?type=city\|commodity` | 下拉数据源 |
| GET | `/api/dict/summary` | 管理列表（负重、引用计数） |
| POST | `/api/dict` `{type,name,burden?}` | 新增字典项 |
| PUT/DELETE | `/api/dict/:id` | 重命名/负重/启停/排序/删除 |
| GET | `/api/servers` | 区服列表 |
| DELETE | `/api/servers/:id` | 删除区服及价格 |
| GET | `/api/prices?server&city&commodity?&relief=5` | 查询价格（按个人减免换算为游戏显示价） |
| POST | `/api/prices` | 保存价格（税后显示值 + `relief`，服务端反推原价）；支持 `items[].baseUpdatedAt` 乐观并发，冲突返回 40903 |
| GET | `/api/prices/history` | 变更日志（按当前减免换算显示） |
| GET | `/api/prices/trend` | 价格趋势（`relief` 可选） |
| GET | `/api/prices/matrix` | 跨城池比价（`relief` 可选，返回各城税率） |
| GET | `/api/prices/export` | CSV 导出（按当前减免） |
| POST | `/api/prices/import` | Excel/结构化导入（`merge` 可选；按 `relief` 反推原价） |
| GET | `/api/game/meta` | 同步支持城池清单 |
| POST | `/api/game/sync` | 游戏直连同步 `{token?,server?,operator?,cities?}`；token 缺省用本账号已保存 token（同步成功后保存） |
| GET | `/api/sync-settings` | 定时同步配置（不返回 token 明文；`hasToken/tokenOwner`） |
| PUT | `/api/sync-settings` | 保存配置（需登录；`token` 存本账号并绑定定时同步） |
| POST | `/api/sync-settings/run` | 用已保存配置立即同步（需登录） |
| GET | `/api/sync-settings/logs` | 同步运行记录 |
| GET | `/api/reports/movers?server&days&limit&relief` | 涨跌幅榜 |
| GET | `/api/reports/arbitrage?server&load&relief&all` | 套利建议（按载重与个人减免估算毛利） |
| GET | `/api/reports/heat?server&days&bucket=day\|hour` | 改价/同步热度 |

错误码：`0` 成功；`40901` 重复；`40902` 被引用不可删除；`40903` 价格已被他人更新（乐观并发冲突）。

### WebSocket `/ws`

客户端连接后服务端推送 `hello`；改价、字典变更、同步完成/失败、设置更新等事件会广播给所有在线页面。客户端每 25 秒发送 `{type:'ping'}` 保活，服务端回 `pong`。消息类型：

- `price.updated` `{server,city,operator,items[]}`（`items` 为空表示需刷新）
- `dict.changed`、`server.deleted`、`settings.updated`
- `sync.finished`、`sync.failed`

### 游戏直连同步

浏览器登录 https://www.wanyiwan.top/game/sgbhsd ，F12 → Application → Local Storage → 复制 `x-game-token-pcweb`（JWT，有效期约 12 天）填入「同步」或「定时」即可。token 保存在当前账号下（换账号登录只能看到自己的 token）；服务端自动完成：换取 authCode → SDK 登录 → 区服登录 → WebSocket 登录 → 逐城拉取行情（游戏以分为单位，落库 ÷100 为税前原价），并将各城税率写入 `city_taxes`（每次同步按最新税率覆盖）。

- 赋税：2104 响应含每城税率（0.1~0.9），页面按「我的赋税减免」（默认 5%）实时换算：显示卖出 = 原价 × (1 − 税率 × (1 − 减免/100))，显示买入 = 原价 × (1 + 税率 × (1 − 减免/100))，保留 1 位小数与游戏显示一致。切换减免只影响显示，不写库。
- 手工录入 / Excel 导入填写的是自己看到税后价，服务端按当前减免与该城税率反推原价入库；税率未知的城池按原价处理（不折算）。
- 每城仅 3 个商品可买入（2104 中 type=2），全部 25 个商品均可卖出（type=0/1）；非可购商品的买入价落库为 NULL。
- 单次同步全部 42 城约 10 秒，返回 `{queried,saved,created,updated,newCities[],failed[]}`；字典里缺失的城池同步时自动登记（见 `newCities`）并清缓存广播刷新，赛季未开放的州城可能失败并列入 `failed`，不影响其他城池。
- 定时同步使用「定时」页保存 token 的账号的 token（`sync_settings.token_account_id`），到期换 token 后重新保存即可；旧版单行 token 仅作升级兜底。
- 命令行：`node server/scripts/game-sync.js <token> [区服] [更新人]`，或 `--settings` 复用定时同步配置。

## 七、数据表

| 表 | 说明 |
| --- | --- |
| `accounts` | 账号（昵称唯一、scrypt 密码哈希、会话、本人游戏 token） |
| `dict_items` | 字典（city/commodity，`(type,name)` 唯一，`burden` 负重） |
| `servers` | 区服 |
| `prices` | 税前原价（`server_id+city_id+commodity_id` 唯一，含更新时间/更新人） |
| `price_history` | 改价流水（原价旧值/新值/操作人/时间，按 `HISTORY_LIMIT` 裁剪） |
| `city_taxes` | 城池税率（`server_id+city_id` 唯一，游戏同步写入，0.1~0.9） |
| `city_nodes` | 城池游戏节点与地图坐标（gridX/gridY） |
| `sync_settings` | 定时同步单行配置（开关/cron/区服/更新人/绑定 token 的账号/上次状态） |
| `sync_log` | 同步运行记录（触发方式、查询/写入数、失败数、消息） |

## 八、备份与维护

```bash
./deploy.sh backup                        # MySQL → backup/mysql-*.sql
./deploy.sh restore backup/mysql-*.sql    # 恢复（自动暂停 app）
./deploy.sh backup                        # 无 mysql 服务时备份 SQLite → backup/price-*.db
```

MySQL 数据位于 Docker 卷 `mysql-data`，Redis 位于 `redis-data`；`./data` 保留 SQLite 兜底库与迁移源。`docker compose down` 不会删除命名卷，`down -v` 才会。

## 九、测试与 CI

- `npm test`：38 项测试，覆盖账号会话、字典、价格、并发冲突、导入导出、游戏协议解析、税率换算、报表、定时设置、健康检查（SQLite 临时库）。
- `npm run test:smoke`：启动真实 HTTP 服务，验证健康检查、价格写入/查询、40903 冲突与清理。
- GitHub Actions：
  - `test`：SQLite 全量测试；
  - `mysql-redis`：启动 MySQL 8.4 + Redis 7 服务，执行冒烟自检，验证双驱动与缓存路径。

## 十、后续可扩展

1. 按区服分配编辑权限 / 操作审计与回滚。
2. 定时同步失败通知（企业微信/QQ 机器人）。
3. 报表导出与历史趋势预测。
4. 前端组件测试与 Playwright E2E。
