# 三国冰河时代富甲天下跑商价格分享（卡密版）

城池 / 商品买卖价格的在线录入、查询与共享平台，支持**游戏直连同步**、**WebSocket 实时协作**、**定时自动同步**、**涨跌幅与更新热度报表**。账号采用**限时试用 + 卡密注册**（管理后台配置卡密启用时间，默认 `2026-10-22 00:00:00`；启用后新账号必须使用卡密，卡密分 1 天 / 1 月 / 永久），每个账号的数据完全私有；独立 `/admin` 管理后台可生成卡密、查看账号、维护字典与区服、配置登录页提示与 token 教程、封禁与续期。生产环境使用 **MySQL + Redis**，`docker compose up -d --build` 一键部署，本地开发与测试自动使用 SQLite。

> 升级提示：本项目已从「共享价格表」改为「按账号隔离」。旧版 SQLite 数据迁移后归入历史归属账号（详见「备份与迁移」）。

## 一、技术选型与架构

| 层 | 选型 | 说明 |
| --- | --- | --- |
| 运行时 | **Node.js 24** | 前后端同语言；SQLite 使用内置 `node:sqlite`，零原生编译依赖 |
| 后端框架 | **Express 4 + ws** | REST API + WebSocket 实时推送 |
| 数据库 | **MySQL 8.4（生产）/ SQLite（本地、测试、兜底）** | 通过 `DB_DRIVER` 或 `MYSQL_HOST` 自动选择；SQL 由 `server/db.js` 统一适配 |
| 缓存 | **Redis 7（可选）** | 字典缓存；未配置或连接失败时自动退化为无缓存 |
| 定时任务 | **node-cron** | 按账号注册定时同步，频率可在页面配置 |
| 前台 | **Vue 3 + Element Plus** | 源码开发，生产构建为压缩 + 混淆产物；importmap 指向本地 vendor，不依赖外网 CDN |
| 加固 | **HMAC 请求签名 + 设备记录 + 限流** | 所有已登录请求需签名，时间窗 ±5 分钟、nonce 防重放 |
| 部署 | **Docker Compose** | app + mysql + redis 一次拉起，健康检查、数据卷、备份脚本齐备 |

```
┌──────────────────────── docker compose ────────────────────────┐
│  app (node:24-alpine, 非 root, :3000)                          │
│   ├─ /                用户端（卡密登录 / 价格 / 报表）          │
│   ├─ /admin           管理后台（ADMIN_PASSWORD 登录）           │
│   ├─ /api/auth        卡密注册 / 密码登录 / 设备记录            │
│   ├─ /api/admin       卡密 / 账号 / 字典 / 区服 / 设置 / 日志   │
│   ├─ /api/prices      查询/保存(乐观并发)/趋势/比价/导入导出    │
│   ├─ /api/game/sync   游戏直连同步（175 城 × 25 商品）          │
│   ├─ /api/sync-settings 按账号定时同步 / 立即执行 / 运行日志    │
│   ├─ /api/reports     涨跌幅榜 / 更新热度                       │
│   ├─ /ws              WebSocket 实时协作（按账号隔离）          │
│   └─ /bundle/*        构建后的混淆前端产物                      │
│  mysql:8.4 (mysql-data 卷)      redis:7 (redis-data 卷)         │
└────────────────────────────────────────────────────────────────┘
```

## 二、功能

| 模块 | 说明 |
| --- | --- |
| 注册与试用 | 后台配置卡密启用时间（默认 `2026-10-22`）。启用前新账号可不填卡密直接注册，到期位置显示「试用中」；启用后新注册必须填写卡密。卡密一次性使用，1 天 / 30 天 / 永久，从使用时刻起算 |
| 卡密续期 | 已注册账号卡密到期或试用结束后，在登录页输入新卡密即可续期；后台可在「卡密」页直接把未使用卡密绑定到账号，也可从「账号」页用卡密续期。每张卡密只能消耗一次 |
| 密码登录 | 已注册账号直接「昵称 + 密码」登录；到期或试用结束返回 40301，封禁返回 40302，后台关闭注册返回 40303 |
| 帮助配置 | 后台可用 Markdown 配置「卡密获取提示」和「token 获取教程」，支持链接、图片、列表等；服务端清洗危险 HTML，公开配置接口无需登录 |
| 数据隔离 | 价格、历史、税率、定时同步配置、游戏 token、当前区服默认按账号隔离；首次登录必须设置当前区服，之后可随时切换；启用主账号共享后仅只读回退本区服缺失商品，未登录不可访问业务接口 |
| 设备管理 | 每账号默认保存 3 台设备记录，同一设备可多标签页同时在线；新增设备超限时返回记录列表，可移除单台或全部其他设备；后台可调整单账号记录上限并强制下线 |
| 价格录入 | 桌面表格 / 手机卡片双布局；行内输入、同上一行、脏值跟踪、确认弹窗、Ctrl+Enter 保存 |
| 查询与字典 | 区服必填、城池必选、商品可选；城池 / 商品字典**只读**，由管理员在后台统一维护 |
| 实时协作 | WebSocket 推送同账号其他设备的改价，正在查看的城池立即刷新；本地未保存修改时标记冲突 |
| 主账号价格共享 | 管理员可在「区服」页为每个区服单独指定主账号，也可在「账号」页按账号当前区服设置/取消主账号；设置后该区服普通账号默认开启共享，管理员也可对特定账号全局禁用（禁用后该账号隐藏「主账号价」开关）；普通账号只关联自己**当前区服**的主账号，本人已录入的商品整行优先，缺失商品回退展示主账号价格并标记来源；主账号保存/导入/游戏同步后仅实时通知本区服查看者。历史、趋势、跨城比价、CSV 导出同样按当前区服回退，报表不混入共享数据 |
| 并发保护 | 保存携带 `baseUpdatedAt`，被其他设备抢先更新时返回 `40903`，可选「覆盖保存」或「使用最新数据」 |
| 游戏直连同步 | 凭 `x-game-token-pcweb` 登录游戏服务器，默认自动识别 token 所属区服并逐城抓取 175 城价格；同步时自动接收 `GcMonopolyNews(2136)` 大事件推送，按区服/城池/商品显示事件文案与涨跌幅度并修正显示价；管理员可逐账号开启 `server` 覆盖权限 |
| 赋税换算 | 各城税率自动同步；账号可设「我的赋税减免」（默认 5%），价格按个人减免实时换算 |
| 定时同步 | 页面配置开关、cron 频率与 token；默认按 token 自动识别区服，授权账号可保存 `server_override`；按账号独立调度、独立运行记录 |
| 报表 | 涨跌幅榜、改价与同步热度图 |
| 历史与趋势 | `price_history` 记录改价前后值与操作人；SVG 趋势图支持 7/30/90 天 |
| 导入导出 | Excel 导入（模板下载、预览、merge 模式；未知商品需管理员先维护）、CSV 导出 |
| 管理后台 | 概览、卡密批量生成（单批最多 500）/导出/直接绑定账号/作废、账号续期/改设备记录上限/重置密码/踢下线/封禁/删除、区服参数授权、字典与区服维护、卡密启用时间、注册开关与公告、卡密提示与 token 教程 Markdown 配置、同步日志 |
| 运维 | 健康检查 `/api/health`、Docker 健康依赖、MySQL 备份/恢复脚本、PWA 离线缓存 |

## 三、快速开始

### Docker 一键部署（推荐）

```bash
cp .env.example .env        # 必须设置 ADMIN_PASSWORD
docker compose up -d --build

# 或使用脚本
./deploy.sh                 # Linux / macOS
.\deploy.ps1                # Windows PowerShell
```

启动后：

1. 打开 `http://服务器IP:3000/admin`，用 `.env` 中的 `ADMIN_PASSWORD` 登录；
2. 在「设置」确认「卡密启用时间」（默认 `2026-10-22 00:00:00`），按需编辑卡密获取提示与 token 教程；
3. 在「卡密」页批量生成卡密（选择 1 天 / 1 月 / 永久）；启用前用户也可「昵称 + 密码」直接试用；
4. 把卡密发给用户，启用后在首页输入「昵称 + 密码 + 卡密」注册并进入；
5. 在「设置」中粘贴自己的游戏 token（仅本账号可见）。

管理员密码未配置时，`/admin` 与 `/api/admin/*` 全部返回 503（后台禁用），用户端不受影响。完整部署、备份恢复、反向代理与升级说明见 **[DEPLOY.md](./DEPLOY.md)**。

### 本地开发（SQLite，无需 MySQL/Redis）

```bash
npm install --registry=https://registry.npmmirror.com   # 国内网络建议
npm run build:ui   # 可选：生成混淆产物；不做则回退源码
npm start          # http://localhost:3000
npm run dev        # 文件变化自动重启
npm test           # 68 项后端/账号/设备/游戏/大事件/报表/按区服主账号测试
npm run test:smoke # 冒烟自检（健康检查 + 写入/查询 + 并发冲突）
npm run db:vacuum  # SQLite VACUUM / MySQL OPTIMIZE
```

要求 Node.js ≥ 22.5。未设置 `MYSQL_HOST` / `DB_DRIVER=mysql` 时自动使用 `data/price.db`；连接 Redis 需设置 `REDIS_URL`。管理后台需设置 `ADMIN_PASSWORD`，例如：

```bash
# PowerShell
$env:ADMIN_PASSWORD='your-strong-password'; npm start
# bash
ADMIN_PASSWORD='your-strong-password' npm start
```

## 四、账号、卡密与设备规则

- 登录与注册已分栏：登录只需昵称 + 密码，不显示卡密输入；注册才显示卡密与卡密帮助；卡密到期/试用结束可在登录页点「卡密续期」或登录后按提示续期。
- 卡密格式 `XXXX-XXXX-XXXX-XXXX`，字符集去掉易混淆字符（无 0/O/1/I）；生成时记录批次、备注与类型。卡密严格一次性使用：注册、用户续期、后台绑定/续期都通过条件更新原子占用，同一张卡密不能重复注册或重复绑定。
- 后台「卡密」页可对未使用卡密点「绑定」，输入账号昵称后直接把卡密绑到该账号；有效期从账号当前到期时间（已过期则从现在）顺延。永久有效账号绑定 `day` / `month` 卡密时从现在重新计时，绑定 `forever` 卡密仍为永久。
- `day` = 使用后 1 天，`month` = 使用后 30 天，`forever` = 无到期时间；到期后登录返回 40301，在线会话立即失效，数据保留。
- 后台「卡密启用时间」默认 `2026-10-22 00:00:00`。启用前新账号可不填卡密注册，账号无卡密、到期时间为启用时间，界面显示「试用中」；启用后新注册必须填卡密，已有试用账号也需补卡密才能登录。
- 修改启用时间会同步所有无卡密试用账号的到期时间；试用账号在启用前也可提前输入卡密转为正式账号。
- 后台可对账号直接修改到期时间，也可「用卡密续期」：输入一张未使用卡密，按其类型从当前到期时间（已过期则从现在）顺延；永久有效账号同样从现在重新计时。
- 设备记录：登录携带 `deviceId`/`deviceName`/`deviceMeta`。设备 ID 同时保存在 localStorage 与 first-party cookie，二者互为备份；都不可用时服务端按浏览器特征生成 `fp-*` 指纹 ID。每个设备记录可同时建立多个会话（例如同一浏览器多个标签页），不额外占用名额。
- 默认最多保存 3 台设备记录；新设备超限时返回 `40910` 与设备记录列表，用户确认后可移除全部旧记录再登录。普通退出登录只删除会话，不删除设备记录；移除设备记录会注销该设备的全部会话。
- 后台可调整单账号设备记录上限、清空全部设备记录并踢下线、重置密码（同时注销全部会话）、封禁（同时删除全部会话）与解封。
- 同一账号的多台设备共享价格与游戏 token，可实现实时协作；不同账号之间完全不可见。

## 五、环境变量

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT` | `3000` | 监听端口 |
| `FORCE_HTTPS` | 未启用 | 设为 `1` 时 HTTP 请求 308 跳转 HTTPS；生产环境建议开启 |
| `TRUST_PROXY` | `loopback,linklocal,uniquelocal` | Express 信任的代理网段；直连可设 `false`，单层反代可设 `1` |
| `ADMIN_PASSWORD` | 空 | 管理后台密码；为空则后台禁用（生产必填） |
| `ADMIN_TOKEN_HOURS` | `168` | 管理后台登录有效期（小时），默认 7 天，最长 365 天 |
| `DB_DRIVER` | 有 `MYSQL_HOST` 则 `mysql`，否则 `sqlite` | 强制指定驱动 |
| `MYSQL_HOST` / `MYSQL_PORT` | `127.0.0.1` / `3306` | MySQL 地址 |
| `MYSQL_USER` / `MYSQL_PASSWORD` | `price` / `price` | MySQL 账号 |
| `MYSQL_DATABASE` | `price_share` | 数据库名 |
| `MYSQL_POOL` | `10` | 连接池大小 |
| `REDIS_URL` | 空 | 如 `redis://redis:6379`；为空则禁用缓存 |
| `PRICE_DB` | `data/price.db` | SQLite 文件路径 |
| `HISTORY_LIMIT` | `20000` | 每账号价格历史保留条数 |
| `TZ` | `Asia/Shanghai` | 时区（时间统一按北京时间存储） |

## 六、目录结构

```
sgbhsdPriceShare/
├── server/
│   ├── index.js            # Express 入口（静态托管、bundle、API、WS、健康检查）
│   ├── db.js               # 双驱动数据层（MySQL/SQLite）、建表、种子、事务
│   ├── cache.js            # Redis 字典缓存（失败自动退化）
│   ├── dict-cache.js       # 字典缓存失效 + 广播
│   ├── ws.js               # WebSocket 一次性票据认证、按账号广播
│   ├── master.js           # 按区服主账号、共享开关与查看者广播
│   ├── scheduler.js        # 按账号 cron 定时同步与运行日志
│   ├── util.js             # 统一响应/校验
│   ├── auth.js             # 密码（scrypt）、设备记录/会话、账号状态
│   ├── sign.js             # 用户/后台 HMAC 请求签名 + nonce 防重放
│   ├── security.js         # HTTPS/HSTS、CSP/安全头、JSON 请求限制
│   ├── ratelimit.js        # 内存限流
│   ├── keys.js             # 卡密生成/校验/类型
│   ├── routes/
│   │   ├── auth.js         # 卡密注册 / 登录 / 设备记录
│   │   ├── admin.js        # /api/admin 管理接口
│   │   ├── dict.js         # /api/dict（只读）
│   │   ├── servers.js      # /api/servers
│   │   ├── prices.js       # 查询/保存/日志/趋势/比价/导出/导入
│   │   ├── game.js         # /api/game/sync
│   │   ├── sync-settings.js# 按账号定时同步配置与日志
│   │   └── reports.js      # 涨跌幅/热度
│   ├── game/               # 游戏协议直连（登录链 + WS + Thrift 编解码）
│   │   ├── login.js        # JWT → authCode → SDK 登录 → v1/login
│   │   ├── client.js       # 游戏 WebSocket 客户端
│   │   ├── sync.js         # 逐城抓取 → 原价 + 税率落库
│   │   ├── news.js         # 2136 大事件文案与价格修正
│   │   ├── frame.js        # 10 字节帧头
│   │   ├── thrift.js       # Thrift Compact Protocol
│   │   ├── thrift_schema.json
│   │   └── data/
│   │       ├── city_map.json       # 175 城池映射（nodeNo/metaId/gridX/gridY）
│   │       └── monopoly_news.json  # CfgMonopolyBigNews 文案模板与价格修正
│   └── scripts/
│       ├── game-sync.js        # CLI 同步（<账号ID> <token> [操作人]，区服自动识别）
│       ├── migrate-to-mysql.js # SQLite → MySQL（兼容旧共享库）
│       ├── smoke.js            # 冒烟自检
│       └── vacuum.js           # 数据库维护
├── public/
│   ├── index.html          # 用户端模板
│   ├── admin.html          # 管理后台模板
│   ├── js/app.js           # 用户端源码（WS 票据、签名、设备管理、报表）
│   ├── js/admin.js         # 管理后台源码（签名请求）
│   ├── js/request-sign.js  # 纯 JS SHA-256/HMAC 请求签名
│   ├── dist/               # 构建产物（app.js / admin.js，混淆）
│   ├── css/app.css
│   ├── sw.js               # Service Worker（/admin 不做缓存）
│   ├── manifest.webmanifest
│   └── icons/icon.svg
├── scripts/build-ui.js     # esbuild 打包 + javascript-obfuscator 混淆
├── test/                   # api / auth / game / reports / master 共 68 项
├── data/                   # SQLite（本地/兜底/迁移源，勿提交）
├── backup/                 # 备份目录（MySQL dump / SQLite 副本）
├── docker-compose.yml      # app + mysql + redis
├── Dockerfile
├── deploy.sh / deploy.ps1
├── DEPLOY.md
└── package.json
```

## 七、API 概览

除 `/api/auth/login`、`/api/health` 与管理后台登录外，所有接口都要求已登录并携带签名头。登录成功后返回 `X-Account-Token` 会话 token，后续请求需带：

```
X-Account-Token: <session token>
X-Device-Id:     <device id>
X-Timestamp:     <毫秒时间戳>
X-Nonce:         <随机串>
X-Sign:          HMAC-SHA256(sessionToken, METHOD + "\n" + originalUrl + "\n" + TS + "\n" + NONCE + "\n" + SHA256(rawBody))
```

服务端校验时间窗 ±5 分钟、nonce 10 分钟去重、会话与设备 ID 绑定；失败返回 401（`40111` 设备不匹配，`40112` 签名无效/重放）。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/health` | 健康检查（驱动、缓存、WS 人数、调度状态） |
| GET | `/api/public/config` | 公开配置：卡密是否启用、启用时间、注册开关、公告、卡密提示与 token 教程的已清洗 HTML |
| POST | `/api/auth/login` | `{name,password,key?,mode?,deviceId,deviceName,deviceMeta?,kick?}`；`mode=login` 只登录已有账号（未知账号 `40401`），`mode=register` 只注册新账号（已有昵称 `40012`）；不传 `mode` 保留自动识别；卡密启用前新账号可无 key 试用，启用后必须带卡密；已有账号可带新卡密续期；新设备超出记录上限返回 `40910`，`kick=all` 或设备记录 ID 可移除后继续 |
| POST | `/api/auth/logout` | 注销当前会话 |
| GET | `/api/auth/me` | 当前账号、到期时间、游戏 token（仅本人）、赋税减免、当前区服、`allowSyncServer`、本区服主账号名称、`masterPricesAllowed` 与查看开关 |
| POST | `/api/auth/ws-ticket` | 签发 60 秒一次性 WebSocket 连接票据（需签名）；旧版 `?token=` 直连方式已停用 |
| PUT | `/api/auth/server` | 传 `{server:string}` 设置/切换当前区服，返回该区服主账号与共享开关状态 |
| PUT | `/api/auth/relief` | 更新赋税减免（0~100） |
| PUT | `/api/auth/master-prices` | 传 `{enabled:boolean}` 开启/关闭查看本区服主账号价格；主账号自身不可开启，管理员禁用共享的账号返回 `403`，当前区服无主账号时开启返回 `400` |
| PUT | `/api/auth/token` | 更新本人游戏 token |
| GET | `/api/auth/sessions`、`/api/auth/devices` | 当前账号设备记录列表（含在线会话数、是否本机、最近活跃；`sessions` 为兼容别名） |
| DELETE | `/api/auth/sessions/:id`、`/api/auth/devices/:id` | 移除指定设备记录及其全部会话 |
| POST | `/api/auth/sessions/kick-others`、`/api/auth/devices/kick-others` | 移除除本机外的全部设备记录及会话 |
| POST | `/api/admin/login` | 管理后台登录（`X-Admin-Token` 默认有效期 7 天，可用 `ADMIN_TOKEN_HOURS` 调整，重启失效） |
| GET | `/api/admin/overview` | 概览统计 |
| GET/POST | `/api/admin/keys`、`/keys/export`、`/keys/revoke`、`/batches` | 卡密生成/列表/导出/作废/批次 |
| POST | `/api/admin/keys/:id/bind` | 传 `{accountId}` 或 `{accountName}`，把未使用卡密直接绑定到账号；卡密只能消耗一次，有效期从账号当前到期时间顺延；永久账号绑定限时卡密时从现在重新计时 |
| GET/POST | `/api/admin/accounts`、`/:id/status`、`/:id/expires`、`/:id/device-limit`、`/:id/password`、`/:id/kick`、`/:id/sync-server`、`/:id/master`、`/:id/master-prices`、`DELETE /:id` | 账号管理；`/expires` 支持 `expiresAt` / `extendDays` / `keyCode`，卡密绑定从当前到期时间顺延且只能使用一次（永久账号从现在重新计时）；`/sync-server` 传 `{allow:boolean}` 控制区服参数权限；`/master` 传 `{master:boolean}` 按账号当前区服设置/取消主账号；`/master-prices` 传 `{allowed:boolean}` 允许/禁止指定账号共享主账号价格 |
| GET/POST/PUT/DELETE | `/api/admin/dict`、`/api/admin/servers` | 字典 / 区服维护（删除被引用项返回 40901/40902，`?force=1` 强制）；区服列表返回 `masterAccountId` 与 `masterCandidates` |
| POST | `/api/admin/servers/:id/master` | 传 `{accountId:number\|null}` 设置/取消该区服主账号；账号当前区服必须与目标区服一致。设置时本区服允许共享的普通账号默认开启，取消时关闭 |
| GET/PUT | `/api/admin/settings` | 注册开关、公告、默认设备记录上限、`keyRequiredAt`、`keyHelpMd`、`tokenHelpMd`；GET/PUT 返回渲染后的 HTML |
| POST | `/api/admin/markdown/preview` | `{text}` 预览 Markdown（服务端清洗后返回 HTML） |
| GET/DELETE | `/api/admin/sync-logs` | 全部账号同步日志 |
| GET | `/api/dict?type=city\|commodity` | 下拉数据源（登录可读） |
| GET | `/api/servers` | 区服列表 |
| GET | `/api/prices?server&city&commodity?&relief=5` | 查询价格（按个人减免与大事件修正换算为游戏显示价）；返回 `masterAccountName`、`sharedCount`、当前城池生效的 `events`（含 `description`、`priceCorrection`、`direction`），每条价格带 `source: own/master` 与所属商品的 `events` |
| POST | `/api/prices` | 保存价格；支持 `items[].baseUpdatedAt` 乐观并发，冲突返回 40903；主账号保存后通知共享查看者 |
| GET | `/api/prices/history`、`/trend`、`/matrix`、`/export` | 历史 / 趋势 / 跨城比价 / CSV 导出；启用共享时按整行回退并在响应或来源列标记主账号；`matrix` 每条城池价格带该商品的大事件 `events`，查询/导出价格含事件修正 |
| POST | `/api/prices/import` | Excel/结构化导入（`merge` 可选；未知商品需管理员先维护） |
| GET | `/api/game/meta` | 同步支持城池清单 |
| POST | `/api/game/token-info` | 识别 token 所属区服（仅展示，不保存 token；不接收区服参数） |
| POST | `/api/game/sync` | 游戏直连同步；可带可选 `server`（仅 `allowSyncServer` 账号生效，否则 403）；每账号 30 秒一次；token 缺省用本账号已保存 token |
| GET/PUT | `/api/sync-settings` | 本账号定时同步配置；PUT 可带 `server` 写入 `server_override`（无权限且非空返回 403）；不返回 token 明文，返回 `hasToken`、`serverOverride`、`allowSyncServer` |
| POST | `/api/sync-settings/run` | 立即同步 |
| GET | `/api/sync-settings/logs` | 本账号同步记录 |
| GET | `/api/reports/movers`、`/heat` | 涨跌幅 / 热度 |

错误码：`0` 成功；`40010` 卡密启用后新账号缺卡密；`40012` 注册时昵称已存在；`40111` 设备不匹配；`40112` 签名无效；`40301` 卡密到期或试用结束；`40302` 账号封禁；`40303` 注册关闭；`40401` 登录时账号不存在；`40901` 字典重复/被引用；`40902` 区服被引用；`40903` 价格并发冲突；`40910` 设备记录数超限；`50301` 后台未启用。

### WebSocket `/ws`

连接地址 `/ws?token=<session>&device=<deviceId>`，校验失败关闭码 4401（未认证/设备记录已移除）/ 4403（账号不可用）。服务端只向同账号在线会话广播：

- `hello`（账号昵称、在线会话数）
- `price.updated` `{server,city,operator,items[]}`（`items` 为空表示需刷新；主账号共享更新额外带 `shared:true`）
- `master.changed` `{server, masterAccountId, masterAccountName}`（按区服主账号设置变更，客户端忽略非当前区服事件）、`master.preference` `{enabled, allowed?}`（共享开关或管理员权限变更）
- `dict.changed`、`server.deleted`、`settings.updated`
- `sync.finished`、`sync.failed`

客户端每 25 秒发送 `{type:'ping'}`，服务端回 `pong`。

## 八、游戏直连同步

浏览器登录 https://www.wanyiwan.top/game/sgbhsd ，复制 `x-game-token-pcweb`（JWT，有效期约 12 天）填入「同步」或「定时」。token 保存在当前账号下，其他账号不可见。服务端自动完成：换取 authCode → SDK 登录 → 识别 token 所属区服 → 区服登录 → WebSocket 登录 → 逐城拉取行情（游戏以分为单位，落库 ÷100 为税前原价），并将各城税率写入 `city_taxes`（每次同步按最新税率覆盖）。

### 获取登录 token

1. 在电脑浏览器打开游戏网页端，登录要同步价格的账号。
2. 按 `F12`（或右键 → 检查）打开开发者工具，切换到 **Application / 应用**。
3. 左侧选择 **Storage → Local Storage**，点击游戏页面对应的域名。
4. 在右侧列表找到键名 `x-game-token-pcweb`，复制它的 **Value**。
5. 回到本系统，把完整 Value 粘贴到「从游戏同步价格」或「定时自动同步」的登录 token 输入框。

Chrome / Edge 在 Application → Local Storage；Firefox 在 存储 → 本地存储。token 一般可用约 12 天，失效后重新登录并重新复制。token 等同于游戏账号登录凭证，请勿发给他人或提交到仓库。

以上为默认教程。管理员可在后台「设置 → token 获取教程」用 Markdown 自定义文字、链接和图片，注册页的「如何获取卡密」提示同样可配置；服务端会过滤脚本、事件属性等危险 HTML，外链图片需使用 HTTPS。

### 区服处理

- 默认按 token 登录信息自动识别：优先角色区服 `oServerId`，回退角色区服列表与赛季服。
- 管理员可在后台按账号开启「区服参数」权限，默认关闭。开启后手动同步可传 `server`，定时同步可保存 `server_override`；留空仍自动识别。
- 覆盖值只替换价格落库的区服名；赛季节点 / `capitalNodeId` 仍由 token 的 `serverId` 决定，不能把显示区服与赛季服混用。

### 同步细节

- 赋税：2104 响应含每城税率（0.1~0.9），页面按「我的赋税减免」（默认 5%，按账号保存）实时换算：显示卖出 = 原价 × (1 − 税率 × (1 − 减免/100)) × (1 + 事件修正)，显示买入 = 原价 × (1 + 税率 × (1 − 减免/100)) × (1 + 事件修正)，保留 1 位小数。
- 手工录入 / Excel 导入填写的是税后价，服务端按当前减免、该城税率与生效事件修正反推原价入库；税率未知的城池按原价处理。
- 每城仅 3 个商品可买入（2104 中 type=2），全部 25 个商品均可卖出（type=0/1）；非可购商品的买入价落库为 NULL。
- 大事件：同步期间接收服务器推送的 `GcMonopolyNews(2136)`（`metaId/capitalId/startTime/endTime/productId`），将 `capitalId` 按 `serverId × 100000000000 + nodeNo` 映射到城池、`productId` 按 1–25 / 201–225 映射到商品，写入 `city_events`。事件按区服共享（不按账号隔离），同一事件重复推送会更新起止时间；`metaId` 对应 `CfgMonopolyBigNews`，由 `server/game/data/monopoly_news.json` 提供事件文案模板与 `priceCorrection`，查询时按城池、商品和涨跌幅生成完整描述。价格查询和跨城比价只返回当前生效事件，页面显示事件文案与涨跌幅度；生效事件会修正显示价，但不修改落库的税前原价。
- 单次同步全部 175 城约 30~60 秒；赛季未开放的州城（当前为 node 156-175，lv5-7）可能超时并列入 `failed`，不影响其他城池。
- 调度器按账号注册 cron，同账号同步串行；修改定时设置后自动重建任务。
- 命令行：`node server/scripts/game-sync.js <账号ID> <token> [操作人]` 直接按 token 自动识别；`--settings` 方式执行本账号定时配置，授权账号会使用已保存的 `server_override`。

## 九、数据表

| 表 | 说明 |
| --- | --- |
| `accounts` | 账号（昵称唯一、scrypt 密码、状态、到期时间、卡密、设备记录上限、当前区服、区服参数权限） |
| `account_devices` | 设备记录（账号、稳定 device_id/指纹、名称/平台、首次与最后活跃；账号内 device_id 唯一） |
| `sessions` | 登录会话（token、账号、设备记录、device_id/name、IP、最后活跃；同一设备可多行） |
| `invite_keys` | 卡密（code 唯一、类型、状态、批次、备注、使用者、使用时间） |
| `app_settings` | 全局设置单行（注册开关、公告、默认设备记录上限、卡密启用时间、卡密提示与 token 教程 Markdown；旧 `master_account_id` 仅用于升级迁移） |
| `dict_items` | 字典（city/commodity，`(type,name)` 唯一，`burden` 负重） |
| `servers` | 区服 |
| `server_masters` | 区服主账号映射（`server_id` 主键，每区服最多一个主账号；账号或区服删除时级联清理） |
| `prices` | 税前原价（`account_id+server_id+city_id+commodity_id` 唯一） |
| `price_history` | 改价流水（按账号隔离，按 `HISTORY_LIMIT` 裁剪） |
| `city_taxes` | 城池税率（`account_id+server_id+city_id` 唯一，游戏同步写入） |
| `city_events` | 游戏大事件（`server_id+city_id+commodity_id+meta_id` 唯一，区服内共享；起止时间按北京时间） |
| `city_nodes` | 城池游戏节点与地图坐标（全局共享） |
| `sync_settings` | 每账号一行定时配置（开关/cron/更新人/上次状态；`server_name` 为展示缓存，`server_override` 为授权账号的区服覆盖值） |
| `sync_log` | 同步运行记录（按账号隔离） |

## 十、备份与迁移

```bash
./deploy.sh backup                        # MySQL → backup/mysql-*.sql
./deploy.sh restore backup/mysql-*.sql    # 恢复（自动暂停 app）
./deploy.sh backup                        # 无 mysql 服务时备份 SQLite → backup/price-*.db
```

从旧 SQLite 迁移到 MySQL：

```bash
docker compose exec app npm run db:migrate            # 目标库为空时
docker compose exec app npm run db:migrate -- --force # 目标库已有数据时合并
```

迁移脚本兼容旧版共享库与新卡密库：字典、区服、账号（含区服参数权限）、卡密、价格、历史、税率、坐标、定时设置（含 `server_override`）、按区服主账号映射与同步日志都会导入；旧数据没有 `account_id` 时归入「历史归属账号」（旧 token 所属账号，否则最早注册账号）。旧版全局 `master_account_id` 会按该主账号当时的 `current_server` 转入 `server_masters`，当前区服为空时无法自动归属，需在后台重新设置。本地 SQLite 旧库没有账号时，**首个注册的账号会自动接管旧数据**。`migrate-to-mysql` 不迁移会话与设备记录，迁移后需重新登录并重新生成设备记录；同库原地升级会自动补建 `account_devices` 并把仍有 `account_id` 的旧会话回填到设备记录。

## 十一、安全与加固说明

- 所有已登录用户 API 与后台 API 强制 HMAC-SHA256 验签：签名覆盖方法、原始 URL、时间戳、nonce 和请求体 SHA-256；时间窗 5 分钟，nonce 10 分钟内仅可使用一次，后台 token 同样作为签名密钥。
- WebSocket 不再把会话 token 放入 URL，改为先调用签名接口 `/api/auth/ws-ticket` 获取 60 秒一次性票据，并校验连接 `Origin`；票据使用后立即失效。
- 请求加密依赖 HTTPS/TLS，应用层 HMAC 只负责防篡改与防重放，不等同于加密。生产环境应设置 `FORCE_HTTPS=1`，由反向代理配置证书并传递 `X-Forwarded-Proto`；应用会 308 跳转 HTTP、启用 HSTS，并设置 CSP、`X-Frame-Options: DENY`、`nosniff`、COOP/CORP 等安全头。
- 注册密码至少 8 位（已有旧账号仍可按原密码登录）。限流：登录 40 次 / 5 分钟 / IP，后台登录 10 次 / 15 分钟 / IP，同步 1 次 / 30 秒 / 账号；全 API 600 次 / 分钟 / IP，后台 API 240 次 / 分钟 / IP，认证 API 120 次 / 分钟 / IP。
- 请求体仅接受 `application/json`，上限 1 MB；禁用嵌套 query 解析、启用 JSON 转义，并限制 HTTP 头/请求超时。
- 会话 token 仅存服务端，浏览器 localStorage 保存；封禁/重置密码/到期会立即注销会话。管理 token 保存在服务端内存（默认 7 天，可用 `ADMIN_TOKEN_HOURS` 调整），服务重启后需重新登录。
- 前端生产构建使用 esbuild 压缩 + javascript-obfuscator 混淆；`/bundle/*` 优先返回 `public/dist` 产物，缺失时回退源码（不影响功能）。
- `/admin` 与 API 响应禁止缓存；`/admin` 不被 Service Worker 缓存，避免缓存串页。
- 前端在非安全上下文（HTTP 局域网）使用内置纯 JS SHA-256/HMAC 实现，保证签名在无 `crypto.subtle` 时仍可用；正式环境必须启用 HTTPS。
- nonce 与 WebSocket 票据保存在进程内存，适用于单实例部署；多实例横向扩展需改为 Redis 等共享存储。

## 十二、测试与 CI

- `npm test`：68 项，覆盖账号/卡密一次性占用/后台绑定/永久账号重新计时/试用启用/续期/到期/封禁、设备记录上限与同设备多会话/退出保留记录/指纹兜底/踢出、签名与重放、后台验签、WebSocket 一次性票据、数据隔离、首次登录强制设置当前区服与切换、按区服主账号设置/隔离/默认共享/管理员禁用、整行回退、历史/趋势/比价/导出、税率回退、删除主账号清理、字典只读、价格并发、导入导出、游戏协议解析、2136 大事件映射/去重/区服共享/过期过滤/文案与价格修正、报表、同步日志、定时设置、Markdown 清洗/公共配置与健康检查（SQLite 临时库）。
- `npm run test:smoke`：启动真实 HTTP 服务（SQLite 默认使用临时库），验证卡密注册、HMAC 签名请求、价格写入/查询、40903 冲突与清理。
- GitHub Actions：
  - `test`：SQLite 全量测试；
  - `mysql-redis`：启动 MySQL 8.4 + Redis 7，执行冒烟自检，验证双驱动与缓存路径。

## 十三、后续可扩展

1. 卡密使用审计与导出增强（按批次统计注册转化）。
2. 定时同步失败通知（企业微信/QQ 机器人）。
3. 报表导出与历史趋势预测。
4. 前端组件测试与 Playwright E2E。
