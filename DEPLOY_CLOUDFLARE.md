# LunaTV 部署到 Cloudflare Workers + D1

> 本目录是**已改造完成**的 LunaTV，可直接部署到 Cloudflare Workers，业务数据（用户、播放记录、收藏、搜索历史、片头片尾配置、站点配置）全部存放在 Cloudflare D1。
>
> 改造思路参考 [MoonTVPlus](https://github.com/mtvpls/MoonTVPlus) 的 Cloudflare 分支：用 `@opennextjs/cloudflare` 把 Next.js 打成 Worker，用 `getCloudflareContext().env.DB` 懒加载 D1 binding。

---

## 一、为什么原版不能直接部署

LunaTV 原版的存储层只有四种实现：

| 存储类型 | 实现 | 能否跑在 Workers |
| --- | --- | --- |
| `localstorage` | 浏览器本地 | 只能单机，换设备就丢数据 |
| `redis` | `node-redis`，TCP 连接 | ❌ Workers 没有 TCP socket |
| `kvrocks` | 同上 | ❌ |
| `upstash` | HTTP REST | ✅ 但数据在 Upstash，不在 Cloudflare |

所以「部署到 Cloudflare + 数据也放 Cloudflare」只有一条路：**新增 `d1` 存储实现**，把 `IStorage` 的 24 个方法映射到 D1 的 SQL 表。这也正是 MoonTVPlus 做的事。

LunaTV 的 `IStorage` 接口很干净（只有播放记录、收藏、用户、搜索历史、站点配置、片头片尾 6 类），比 MoonTVPlus 小一个量级，D1 适配器约 470 行即可覆盖全部能力。

---

## 二、整体架构

```
浏览器
  │
  ├─ 静态资源 ──► Workers Static Assets（.open-next/assets）
  │
  └─ 动态请求 ──► Cloudflare Worker（Next.js 14 + OpenNext 适配层）
                     │
                     ├─ middleware（Edge，HMAC 校验 Cookie）
                     ├─ Server Components / Route Handlers
                     └─ D1Storage ──► D1 数据库（binding: DB）
                                        ├─ users
                                        ├─ play_records
                                        ├─ favorites
                                        ├─ search_history
                                        ├─ skip_configs
                                        └─ admin_config
```

- **运行时**：Workers（`nodejs_compat`），不是 Pages Functions
- **数据库**：D1（SQLite 方言），单库上限 10 GB
- **定时任务**：Cron Triggers 每天 01:00 调一次 `/api/cron`（等价原 `vercel.json`）
- **缓存**：OpenNext 的 ISR 缓存设为 `dummy`（LunaTV 页面基本是 `force-dynamic`，不需要）

---

## 三、改造清单

| 文件 | 类型 | 说明 |
| --- | --- | --- |
| `src/lib/d1-adapter.ts` | 新增 | D1 / better-sqlite3 统一适配层，把同步 SQLite API 包成 D1 的 Promise API |
| `src/lib/d1.db.ts` | 新增 | `D1Storage implements IStorage`，24 个方法全部落到 SQL |
| `src/lib/db.ts` | 修改 | 存储工厂加 `d1` 分支；redis/kvrocks 改为动态 `require`，CF 构建下直接报可读错误；`getD1Adapter()` 用 Proxy 懒加载 `env.DB` |
| `src/lib/cloudflare-shims/node-unsupported.ts` | 新增 | 把 `redis` / `better-sqlite3` 替换成显式报错的空实现，避免打包 Node 原生模块 |
| `next.config.js` | 修改 | CF 构建时去掉 `output: 'standalone'`、关闭 instrumentation / PWA / lint，alias 掉 Node-only 包 |
| `open-next.config.ts` | 新增 | OpenNext for Cloudflare 配置（node wrapper、edge middleware、dummy cache） |
| `cloudflare-worker.ts` | 新增 | Worker 入口：转发 OpenNext 的 `fetch`，补 `scheduled` |
| `wrangler.toml` | 新增 | D1 binding、静态资源 binding、Cron、运行时变量 |
| `migrations/0001_init.sql` | 新增 | 6 张表的建表语句 + 索引 |
| `package.json` | 修改 | 加 `build:cloudflare` / `deploy:cloudflare` / `db:init:*` 脚本与依赖 |
| `tsconfig.json` | 修改 | 把 `open-next.config.ts`、`cloudflare-worker.ts` 排除出 Next 的类型检查 |

数据模型与 Redis 版保持一致：所有记录的主键仍是 `source+id`（如 `tmdb+12345`），所以导入导出、前端逻辑都不用改。

---

## 四、部署步骤（CLI，推荐）

### 0. 准备

- Node.js ≥ 20（推荐 22）
- Cloudflare 账号（免费版即可跑起来，但**登录可能超 CPU，见第六节**）
- 已安装 pnpm

```powershell
npm i -g pnpm wrangler
wrangler login
```

### 1. 创建 D1 数据库

```powershell
wrangler d1 create moontv
```

输出里会有一行 `database_id = "xxxxxxxx-xxxx-..."`，把它填进 `wrangler.toml`：

```toml
[[d1_databases]]
binding = "DB"
database_name = "moontv"
database_id = "这里替换成你的 id"
```

### 2. 建表

```powershell
wrangler d1 execute moontv --remote --file=./migrations/0001_init.sql
```

验证：

```powershell
wrangler d1 execute moontv --remote --command "SELECT name FROM sqlite_master WHERE type='table'"
```

应看到 `users`、`play_records`、`favorites`、`search_history`、`skip_configs`、`admin_config`。

### 3. 安装依赖并构建

```powershell
pnpm install
pnpm build:cloudflare
```

> `build:cloudflare` 已内置 `BUILD_TARGET=cloudflare` 和 `NEXT_PUBLIC_STORAGE_TYPE=d1`。
> `NEXT_PUBLIC_*` 会在构建时被内联，**不能只在运行时配**，这是最容易踩的坑。

### 4. 配置密钥

站长账号密码直接走环境变量，不落库：

```powershell
wrangler secret put USERNAME
wrangler secret put PASSWORD
```

可选变量（按需，写在 `wrangler.toml` 的 `[vars]` 或 `wrangler secret put`）：

| 变量 | 作用 |
| --- | --- |
| `SITE_BASE` | 站点完整 URL，如 `https://tv.example.com` |
| `NEXT_PUBLIC_SITE_NAME` | 站点名（构建时内联，需重新构建） |
| `ANNOUNCEMENT` | 首页公告 |
| `NEXT_PUBLIC_SEARCH_MAX_PAGE` | 搜索最大页数，默认 5 |
| `NEXT_PUBLIC_DOUBAN_PROXY_TYPE` | 豆瓣代理方式，国内建议 `cmliussss-cdn-tencent` |

### 5. 部署

```powershell
wrangler deploy
```

成功后输出 `https://lunatv.<你的子域>.workers.dev`。

### 6. 首次登录

用第 4 步设置的 `USERNAME` / `PASSWORD` 登录，角色是 `owner`（不查 `users` 表）。其他用户在后台「用户管理」里创建，密码经 scrypt 加盐后写入 D1 的 `users` 表。

### 7. 绑定自定义域名（可选）

控制台 → Workers & Pages → `lunatv` → Settings → Domains & Routes → Add custom domain。
绑定后记得把 `SITE_BASE` 改成新域名并重新部署。

---

## 五、本地开发与预览

```powershell
pnpm install               # package.json 已声明 onlyBuiltDependencies，正常会自动编译
pnpm db:init:local         # 在 .wrangler/state 里建本地 D1 表
pnpm build:cloudflare
pnpm preview:cloudflare    # wrangler dev，本地带 D1 模拟
```

如果安装时仍提示 `Ignored build scripts`，执行一次 `pnpm approve-builds` 并勾选 `better-sqlite3` / `workerd`。

如果不想跑 Worker 预览，也可以让 `next dev` 直连本地 SQLite：

```powershell
$env:NEXT_PUBLIC_STORAGE_TYPE="d1"
pnpm dev
```

`db.ts` 在非 CF 构建下会自动用 `better-sqlite3` 打开 `.data/lunatv.db`，SQL 与 D1 完全一致。

---

## 六、成本与限制（重要）

### 免费额度

| 项目 | 免费额度 | 超出后 |
| --- | --- | --- |
| Workers 请求 | 10 万/天 | $5/月起（1000 万/月） |
| Workers CPU | **10 ms/请求** | 直接 1101 错误 |
| D1 存储 | 5 GB | $0.75/GB/月 |
| D1 读 | 500 万行/天 | $0.001/千行 |
| D1 写 | 10 万行/天 | $0.001/千行 |

### 三个必须知道的坑

1. **登录可能超 CPU**
   `password.ts` 用 scrypt（N=16384, r=8），单次约 30–80 ms CPU，免费版 10 ms 限制下大概率 1101。
   解决：升级 Workers Paid（$5/月，30 s CPU），或把 `password.ts` 换成 PBKDF2 / WebCrypto（需要把 `hashPassword` 改成 async，并改 3 处调用点）。

2. **每次播放进度保存都是一次 D1 写**
   本仓库已把 `src/app/play/page.tsx` 的保存间隔从 5 秒改成 20 秒（条件从 `=== 'upstash'` 改为 `!== 'localstorage'`）。
   一个用户看 2 小时约 360 次写，10 个用户就逼近免费额度（10 万行/天）。如果用户更多，可以再调大到 30–60 秒，代价是换设备时进度最多丢一分钟。

3. **无法使用 Node TCP**
   自建 Redis / MySQL / SMTP 都连不上。LunaTV 的图片代理、m3u8 代理都是 `fetch`，不受影响；如果以后加邮件通知，要用 HTTP API（Resend / MailChannels）。

### 其它

- Worker 包体积：免费版 3 MB（gzip）、付费版 10 MB。本项目构建产物见下方实测。
- D1 是单主库，写操作串行；本项目写入量小，无压力。
- 没有 ISR 缓存，所有页面动态渲染，D1 读会计入配额。日活几十人完全够用。
- 中国大陆直连 `workers.dev` 不稳定，建议绑自定义域名（域名需在 Cloudflare 托管）。

### 本仓库实测数据

| 项目 | 结果 |
| --- | --- |
| 构建链 | Next.js 14.2.35 + `@opennextjs/cloudflare` 1.20.18 + wrangler 4.168 |
| 构建命令 | `pnpm build:cloudflare`（约 1.5 分钟） |
| Worker 产物 | Total Upload **4217 KiB**，gzip 后 **1186 KiB**（免费版 3 MB 限额内） |
| 首页 SSR | `GET /` → 200，约 40 KB HTML |
| 登录 | owner（环境变量）与普通用户（D1 + scrypt）均通过 |
| 播放记录 / 收藏 | 写入 → 读回 → 字段完整，`source+id` 主键正常 |
| 搜索历史 | 连写 25 条只保留最近 20 条，重复关键词自动置顶 |
| 片头片尾 | 写入 / 单条读 / 全量读 均正常 |
| 站点配置 | 首次访问自动初始化（INSERT），后台修改后 UPDATE 生效 |
| 删除用户 | users / play_records / favorites / search_history / skip_configs 全部级联清空 |

> 关于 `--dangerouslyUseUnsupportedNextVersion`：Next 14.2 已超出 Next.js 官方支持期，OpenNext 1.20 默认拒绝构建。该开关只跳过版本检查，不影响产物；本项目已实测可正常运行。若想彻底规避，需要把 LunaTV 升级到 Next 15（涉及 `params` / `cookies` 异步化等 breaking change，工作量大）。

---

## 七、数据迁移（从旧站搬过来）

LunaTV 自带导入导出，走的是同一套 `IStorage` 接口，所以 D1 版可以直接用：

1. 旧站（Redis / Upstash 版）后台 → 数据管理 → **导出**，得到一个 JSON；
2. 新站（D1 版）后台 → 数据管理 → **导入**，选择该 JSON。

导入会通过 `D1Storage` 逐条写库。用户量大时建议分批，避免一次请求超过 Workers 的 CPU / 子请求限制。

如果旧站已经打不开，也可以用 Upstash REST API 直接拉：

```bash
# 列出所有 key（仅示意，按需换成自己的库）
curl "https://<your-db>.upstash.io/hgetall/u:<username>:pr" \
  -H "Authorization: Bearer <token>"
```

拿到 `field -> JSON` 后拼成 SQL，用 `wrangler d1 execute --file` 导入即可。

---

## 八、常见问题

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| 500，日志 `未找到 D1 binding「DB」` | `wrangler.toml` 没配 D1 或 id 是占位符 | 补 `[[d1_databases]]` 后重新 `wrangler deploy` |
| `D1_ERROR: no such table: play_records` | 没执行建表 SQL | 跑第 2 步的 `d1 execute` |
| 登录一直 401 | `PASSWORD` secret 没设 / 与登录输入不一致 | `wrangler secret list` 检查，重设后重新登录 |
| 页面能开但样式全丢 | 静态资源没上传 | 确认 `[assets] directory = ".open-next/assets"`，用 `wrangler deploy` 而不是 `pages deploy` |
| `Error 1101 Worker exceeded CPU` | scrypt 或大搜索 | 升级付费计划，或改密码哈希算法 |
| `Cannot find module 'redis'` | 构建时没带 `BUILD_TARGET=cloudflare` | 用 `pnpm build:cloudflare`，不要用 `pnpm build` |
| 部署后功能正常但配置改不动 | `admin_config` 写入失败 | 看 `wrangler tail`，多半是表缺失或 D1 配额满 |

排错通用命令：

```powershell
wrangler tail            # 实时日志
wrangler d1 execute moontv --remote --command "SELECT COUNT(*) FROM play_records"
```

---

## 九、和 MoonTVPlus 的差异

MoonTVPlus 是 MoonTV 的「大而全」分支（弹幕、漫画、音乐、网盘、AI、观影室……），它的 D1 实现有 112 KB、二十多张表。LunaTV 功能收敛，本次只移植了核心的 6 张表：

- 保留 MoonTVPlus 验证过的两个关键设计：`getCloudflareContext()` 懒加载 D1、`DatabaseAdapter` 同时兼容 D1 与 better-sqlite3；
- 去掉它依赖的 `@libsql/client`、`better-sqlite3` 原生模块打包配置（LunaTV 不需要）；
- 补了 MoonTVPlus 没覆盖的一点：把 `redis` / `kvrocks` 改成动态 `require`，否则 webpack 仍会把 `node-redis` 打进 Worker，构建能过但产物里带着跑不起来的代码。

---

## 十、升级与维护

拉取上游 LunaTV 新版本时：

1. `git pull` 后如果 `src/lib/db.ts`、`package.json`、`next.config.js` 有冲突，保留本仓库的 D1 分支逻辑；
2. 上游如果给 `IStorage` 加了新方法，`d1.db.ts` 会编译报错 —— 按报错补对应 SQL；
3. 上游如果加了新表字段，在 `migrations/` 下新增 `0002_xxx.sql`，然后 `wrangler d1 execute ... --file` 执行。

部署自动化：Cloudflare 控制台的 Workers Builds 会在每次 push 时自动重新构建，无需额外配置 GitHub Actions。
