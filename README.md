# SGBHSD 物价共享平台

城池 / 商品买卖价格的在线录入、查询与共享平台。单容器部署，数据本地持久化，PC 与手机端自适应。

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
│   ├─ /api/dict       字典（城池/商品）CRUD、唯一约束                   │
│   ├─ /api/servers    区服登记与联想                                   │
│   └─ /api/prices     查询 / 保存 / 历史 / CSV 导出 / 粘贴导入          │
│   ├─ 静态：index.html + Vue3 ESM + Element Plus（来自 node_modules）   │
│   └─ SQLite: /app/data/price.db  ←──── 卷挂载 ./data（宿主机持久化）    │
└──────────────────────────────────────────────────────────────────────┘
```

## 二、功能与需求对照

| 需求 | 实现 |
| --- | --- |
| 展示列：区服、城池、商品、买价、卖价 | 价格表五列（桌面表格）；手机端为卡片列表 |
| 搜索：区服输入框 / 城池下拉 / 商品下拉，必选校验，均可清空 | 三个控件均 `clearable`；区服、城池未选时查询/保存给出提示 |
| 初始区服、城池、买价、卖价显示 `-`，商品固定全部商品；选择后填充并查库，无数据显示 `-` | 未查询时商品列即展示全部 24 个商品，其余列 `-`；查询后带出价格，无数据显示 `-`（输入框 placeholder） |
| 买价/卖价为输入框；右上角保存；弹窗确认 | 每行两个输入框；卡片头「保存」按钮 → 明细确认弹窗（原值→新值、新增/修改/清空标记）→ 写入数据库 |
| 字典表存储城池/商品，不可重复；下拉可输入并保存新增 | `dict_items` 表 + 唯一索引；下拉 `filterable + allow-create`，回车或点保存即入字典；「字典管理」弹窗支持增删改、启停、排序 |
| 操作说明区域 | 页面底部「操作说明」卡片：7 步流程 + 4 个技巧卡片 |
| 附加 | 响应式（PC 表格/手机卡片+底部保存条）、变更日志、CSV 导出、批量粘贴导入、差价预警、快捷键 |

## 三、快速开始

### 本地开发 / 直接运行

```bash
npm install
npm start          # http://localhost:3000
npm run dev        # 文件变化自动重启（--watch）
npm run db:vacuum  # 数据库维护（压缩 + 统计）
```

要求 Node.js ≥ 22.5（使用内置 SQLite）。

### Docker 一键部署（推荐）

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
│   ├── db.js               # SQLite 连接、建表、种子数据（40 城池 / 24 商品）
│   ├── util.js             # 统一响应/校验/价格解析
│   ├── routes/
│   │   ├── dict.js         # /api/dict 城池、商品字典
│   │   ├── servers.js      # /api/servers 区服
│   │   └── prices.js       # /api/prices 查询/保存/日志/导出/导入
│   └── scripts/vacuum.js
├── public/
│   ├── index.html          # 页面骨架（Vue 模板 + importmap）
│   ├── css/app.css         # 样式 + 响应式
│   └── js/app.js           # Vue 应用逻辑
├── data/                   # SQLite 数据（自动生成，勿提交）
├── backup/                 # 部署脚本备份目录
├── Dockerfile
├── docker-compose.yml
├── deploy.sh / deploy.ps1  # 一键部署脚本
└── package.json
```

## 五、API 一览

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/health` | 健康检查 |
| GET | `/api/dict?type=city\|commodity` | 下拉数据源（支持 `keyword`、`enabled=0`） |
| GET | `/api/dict/summary` | 管理列表（含价格引用计数） |
| POST | `/api/dict` `{type,name}` | 新增字典项（重复返回 409） |
| PUT | `/api/dict/:id` | 重命名 / 启停 / 排序 |
| DELETE | `/api/dict/:id` | 删除（被价格引用时拒绝） |
| GET | `/api/servers` | 已登记区服（按最近使用排序） |
| DELETE | `/api/servers/:id` | 删除区服及其价格 |
| GET | `/api/prices?server&city&commodity?` | 查询价格（商品列固定全部商品） |
| POST | `/api/prices` `{server,city,items[]}` | 保存价格（事务 + 变更流水） |
| GET | `/api/prices/history?server&city` | 变更日志 |
| GET | `/api/prices/export?server&city` | CSV 导出（UTF-8 BOM，Excel 兼容） |
| POST | `/api/prices/import` | 粘贴导入（自动创建新商品可选） |

## 六、数据表

- `dict_items`：字典表（`type` = city/commodity，`(type,name)` 唯一）
- `servers`：区服（自由文本自动登记）
- `prices`：价格（`server_id+city_id+commodity_id` 唯一，upsert 覆盖）
- `price_history`：买价/卖价每次变更的旧值/新值/时间

## 七、备份与恢复

```bash
./deploy.sh backup                 # 生成 backup/price-时间戳.db
./deploy.sh restore backup/price-xxx.db
```

建议对 `./data` 目录配置宿主机定时备份（crontab / 任务计划程序）。

## 八、完善与优化建议

**已实现（超出基础需求的部分）**

1. **响应式双布局**：PC 端表格、手机端卡片 + 底部吸底保存条，触屏目标区域 ≥ 44px。
2. **脏值跟踪与局部保存**：只提交有改动的行，确认弹窗展示「原值 → 新值」并标注新增/修改/清空。
3. **变更审计**：`price_history` 记录每次改价前后值，页面「日志」可查，便于回溯价格走势。
4. **批量能力**：CSV 导出（Excel 兼容）+ 粘贴导入（tab/逗号/空格分隔、自动创建新商品）。
5. **防错设计**：买≥卖实时提示、数字白名单过滤、唯一约束 409 友好提示、被引用的字典项禁止删除。
6. **体验细节**：历史区服联想、最近一次选择记忆（localStorage）、Ctrl+Enter 快捷保存、同上一行复制。
7. **安全与运维**：容器内非 root 运行、健康检查、数据卷持久化、无外网 CDN 依赖（内网可部署）。

**后续可扩展路线**

1. **账号与权限**：登录（JWT/Session）+ 操作人记录到历史表；按区服分配编辑/只读权限。
2. **价格趋势图**：基于 `price_history` 用 ECharts 展示商品 7/30 日价格曲线、涨跌幅榜。
3. **跨城池比价**：同一商品在各城池的买/卖价矩阵热力图，一键找最优交易城池。
4. **协作实时化**：WebSocket 推送他人改价，避免并发覆盖（当前为最后写入优先 + 流水可查）。
5. **数据规模升级**：迁移 MySQL/PostgreSQL（改造点仅在 `server/db.js` 与少量 SQL）；引入 Redis 缓存字典。
6. **自动化**：游戏内物价截图 OCR / 页面抓取自动入库；定时任务汇总日报推送到群机器人。
7. **PWA**：离线可用 + 手机添加到桌面，弱网友好。
8. **工程质量**：补充 Vitest 单测与 Playwright E2E；GitHub Actions 构建镜像推送私有仓库；Helm Chart 上 K8s。
