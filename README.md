# 三国冰河时代富甲天下跑商价格分享

城池 / 商品买卖价格的在线录入、查询与共享平台。单容器部署，数据本地持久化，PC 与手机端自适应；输入游戏昵称即可进入（无需注册），价格趋势、跨城池比价与 PWA 离线支持。

## 一、技术选型与架构

| 层 | 选型 | 理由 |
| --- | --- | --- |
| 运行时 | **Node.js 24** | 前后端同语言；内置 `node:sqlite`，**零原生编译依赖**，跨平台（Windows/Linux/macOS）免装环境 |
| 后端框架 | **Express 4** | 轻量、生态成熟，REST API 足够支撑本场景 |
| 数据库 | **SQLite（WAL 模式）** | 单文件、免运维、随容器卷持久化；本场景量级（城池×商品×区服）远低于 SQLite 上限；未来可无缝切换到 MySQL/PostgreSQL（DAO 已隔离） |
| 前端 | **Vue 3 + Element Plus** | 组合式 API + 成熟中后台组件（表格/下拉/弹窗/对话框），**本地 node_modules 直出**，不依赖外网 CDN，内网可用 |
| 构建 | 无构建步骤（importmap + ESM） | `npm install` 即可运行，无打包等待；生产环境由 Express 直接托管静态资源 |
| 部署 | **Docker 单容器 + Compose 脚本** | 一条命令完成构建、启动、健康检查、备份恢复 |

```
┌──────────────── Docker 容器 (node:24-alpine, 非 root) ────────────────┐
│  Express (:3000)                                                     │
│   ├─ /api/dict       字典（城池/商品）CRUD、唯一约束、负重维护             │
│   ├─ /api/servers    区服登记与联想                                   │
│   └─ /api/prices     查询 / 保存 / 历史 / 趋势 / 比价 / 导出 / 导入      │
│   ├─ 静态：index.html + Vue3 ESM + Element Plus（来自 node_modules）   │
│   └─ SQLite: /app/data/price.db  ←──── 卷挂载 ./data（宿主机持久化）    │
└──────────────────────────────────────────────────────────────────────┘
```

## 二、功能与需求对照

| 需求 | 实现 |
| --- | --- |
| 展示列：区服、城池、商品、买价、卖价 | 桌面表格 8 列：区服、城池、商品+负重标签、买价、卖价、**更新时间**、**更新人**、快捷操作；手机端为卡片列表（含更新人） |
| 搜索：区服输入框 / 城池下拉 / 商品下拉，必选校验，均可清空 | 三个控件均 `clearable`；区服、城池未选时查询/保存给出提示 |
| 初始区服、城池、买价、卖价显示 `-`，商品固定全部商品；选择后填充并查库，无数据显示 `-` | 未查询时商品列即展示全部 25 个商品（含负重），其余列 `-`；查询后带出价格，无数据显示 `-`（输入框 placeholder） |
| 买价/卖价为输入框；右上角保存；弹窗确认 | 每行两个输入框；卡片头「保存」按钮 → 明细确认弹窗（原值→新值、负重、新增/修改/清空标记）→ 写入数据库 |
| 字典表存储城池/商品，不可重复；下拉可输入并保存新增 | `dict_items` 表 + 唯一索引；下拉 `filterable + allow-create`，回车或点保存即入字典；「字典管理」弹窗支持增删改、启停、排序、**商品负重维护** |
| 操作说明区域 | 页面底部「操作说明」卡片：7 步流程 + 4 个技巧卡片 |
| 附加 | **昵称即入**（输入三国冰河时代昵称进入，本机缓存免重复输入，自动作为更新人）、**跨城比价利润**（卖出城卖价−买入城买价，自动推荐最优买卖路线）、更新时间/更新人列、价格趋势图、变更日志记录操作人、响应式（PC 表格/手机卡片+底部保存条）、CSV 导出、批量粘贴导入、快捷键、PWA |

## 三、快速开始

### 本地开发 / 直接运行

```bash
npm install
npm start          # http://localhost:3000
npm run dev        # 文件变化自动重启（--watch）
npm test           # 运行测试（node --test，14 项）
npm run db:vacuum  # 数据库维护（压缩 + 统计）
```

要求 Node.js ≥ 22.5（使用内置 SQLite）。

**无需注册/登录**：打开页面输入「三国冰河时代昵称」点「进入」即可；昵称缓存在本机（localStorage），刷新免重复输入，之后每次保存价格都会以该昵称作为**更新人**记录。顶栏昵称按钮可随时切换。

### Docker 一键部署（推荐）

完整部署、备份恢复、镜像发布与反代配置见 **[DEPLOY.md](./DEPLOY.md)**。

**Linux / macOS：**

```bash
chmod +x deploy.sh
./deploy.sh                # 构建 + 启动 + 健康检查
PORT=8080 ./deploy.sh      # 换端口
./deploy.sh logs           # 看日志
./deploy.sh backup         # 备份数据库
./deploy.sh update         # 更新代码后重建
```

**Windows（PowerShell）：**

```powershell
.\deploy.ps1               # 构建 + 启动 + 健康检查
$env:PORT=8080; .\deploy.ps1
.\deploy.ps1 logs
.\deploy.ps1 backup
.\deploy.ps1 update
```

**手动方式：**

```bash
docker compose up -d --build     # 启动
docker compose logs -f           # 日志
docker compose down              # 停止
```

部署后访问 `http://服务器IP:3000`。数据落盘在 `./data/price.db`，删除/重建容器不丢数据。

## 四、目录结构

```
sgbhsdPriceShare/
├── server/
│   ├── index.js            # Express 入口（静态托管 + API + 错误处理）
│   ├── db.js               # SQLite 连接、建表迁移、种子数据（40 城池 / 25 商品）
│   ├── util.js             # 统一响应/校验/价格解析
│   ├── routes/
│   │   ├── dict.js         # /api/dict 城池、商品字典（含负重）
│   │   ├── servers.js      # /api/servers 区服
│   │   └── prices.js       # /api/prices 查询/保存/日志/趋势/比价/导出/导入
│   └── scripts/vacuum.js
├── public/
│   ├── index.html          # 页面骨架（昵称入口 + Vue 模板 + importmap）
│   ├── js/app.js           # Vue 应用逻辑（昵称/查询/趋势/比价）
│   ├── css/app.css         # 样式 + 响应式
│   ├── sw.js               # Service Worker（PWA 离线缓存）
│   ├── manifest.webmanifest# PWA 清单
│   └── icons/icon.svg      # 应用图标
├── test/api.test.js        # 后端接口测试（14 项，node:test）
├── data/                   # SQLite 数据（自动生成，勿提交）
├── backup/                 # 部署脚本备份目录
├── .github/workflows/      # CI 测试 + Docker 镜像发布
├── Dockerfile
├── docker-compose.yml
├── deploy.sh / deploy.ps1  # 一键部署脚本
├── DEPLOY.md               # 部署指南
└── package.json
```

## 五、API 一览

全部接口开放，无需 Token；保存/导入类接口通过请求体中的 `operator`（更新人昵称）留痕，缺省记为「匿名」。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/health` | 健康检查 |
| GET | `/api/dict?type=city\|commodity` | 下拉数据源（支持 `keyword`、`enabled=0`） |
| GET | `/api/dict/summary` | 管理列表（含负重、价格引用计数） |
| POST | `/api/dict` `{type,name,burden?}` | 新增字典项（重复返回 409） |
| PUT | `/api/dict/:id` | 重命名 / 负重 / 启停 / 排序 |
| DELETE | `/api/dict/:id` | 删除（被价格引用时拒绝） |
| GET | `/api/servers` | 已登记区服（按最近使用排序） |
| DELETE | `/api/servers/:id` | 删除区服及其价格 |
| GET | `/api/prices?server&city&commodity?` | 查询价格（含负重、更新时间、更新人） |
| POST | `/api/prices` `{server,city,items[],operator}` | 保存价格（事务 + 变更流水 + 记录更新人昵称） |
| GET | `/api/prices/history?server&city` | 变更日志（含操作人） |
| GET | `/api/prices/trend?server&city&commodity&days` | 价格趋势（按日聚合 buy/sell 点列） |
| GET | `/api/prices/matrix?server&commodity` | 跨城池比价（各城池价格 + 最低买入/最高卖出） |
| GET | `/api/prices/export?server&city` | CSV 导出（UTF-8 BOM，Excel 兼容） |
| POST | `/api/prices/import` | 粘贴导入（自动创建新商品可选，支持负重列） |

错误码：`0` 成功；`40901` 重复；`40902` 被引用不可删除。

## 六、数据表

- `dict_items`：字典表（`type` = city/commodity，`(type,name)` 唯一，`burden` 商品负重）
- `servers`：区服（自由文本自动登记）
- `prices`：价格（`server_id+city_id+commodity_id` 唯一，upsert 覆盖；`operator` 记录最后改动人昵称）
- `price_history`：买价/卖价每次变更的旧值/新值/时间/操作人昵称

## 七、备份与恢复

```bash
./deploy.sh backup                 # 生成 backup/price-时间戳.db
./deploy.sh restore backup/price-xxx.db
```

建议对 `./data` 目录配置宿主机定时备份（crontab / 任务计划程序）。

## 八、完善与优化建议

**已实现（超出基础需求的部分）**

1. **昵称即入**：输入三国冰河时代昵称即可进入，无需注册登录；昵称缓存本机（localStorage），保存价格自动以该昵称留痕，顶栏可随时切换昵称。
2. **跨城比价利润**：利润 = 卖出城卖价 − 买入城买价（真正的跑商语义，非同城差价）；「比价」弹窗可选卖出城（默认最高卖价城），自动推荐「最便宜买入城 → 最高卖出城」路线并按利润排序；商品字典支持负重维护（种子含 25 个商品及负重，含新增「毛皮」）。
3. **价格趋势图**：基于 `price_history` 的 SVG 折线图（买价/卖价双线、7/14/30 天切换、悬停提示），零外部图表库依赖。
4. **跨城池比价**：同一商品在本区服各城池的买/卖价矩阵，自动标出最低买入城与最高卖出城。
5. **响应式双布局**：PC 端表格、手机端卡片 + 底部吸底保存条，触屏目标区域 ≥ 44px。
6. **脏值跟踪与局部保存**：只提交有改动的行，确认弹窗展示「原值 → 新值」并标注新增/修改/清空。
7. **变更审计**：`price_history` 记录每次改价前后值与操作人，页面「日志」可查。
8. **批量能力**：CSV 导出（含负重/更新时间/更新人，Excel 兼容）+ 粘贴导入（tab/逗号/空格分隔、自动创建新商品、支持负重列）。
9. **防错设计**：数字白名单过滤、唯一约束 409 友好提示、被引用的字典项禁止删除、删除需二次确认。
10. **体验细节**：历史区服联想、最近一次选择记忆（localStorage）、Ctrl+Enter 快捷保存、同上一行复制。
11. **安全与运维**：容器内非 root 运行、健康检查、数据卷持久化、无外网 CDN 依赖（内网可部署）。
12. **PWA**：Service Worker 缓存 + manifest，可添加到手机桌面、弱网可用。
13. **CI/CD**：GitHub Actions 跑测试；推送自动构建 amd64/arm64 镜像并发布 Docker Hub。
14. **工程质量**：14 项后端接口测试（`npm test`）+ 17 步 Chrome CDP 端到端冒烟，覆盖昵称进入、查询、录价保存（更新人留痕）、趋势、比价、字典、日志、刷新免登等。

**后续可扩展路线**

1. **协作实时化**：WebSocket 推送他人改价，避免并发覆盖（当前为最后写入优先 + 流水可查）。
2. **按区服分配权限**：当前角色为全局，可扩展到「某区服仅某小组可编辑」。
3. **数据规模升级**：迁移 MySQL/PostgreSQL（改造点仅在 `server/db.js` 与少量 SQL）；引入 Redis 缓存字典。
4. **自动化**：游戏内物价截图 OCR / 页面抓取自动入库；定时任务汇总日报推送到群机器人。
5. **更丰富的报表**：涨跌幅榜、城池间套利建议、按时间段的成交热度。
6. **工程质量**：补充前端 Vitest 单测与 Playwright E2E；Helm Chart 上 K8s。
