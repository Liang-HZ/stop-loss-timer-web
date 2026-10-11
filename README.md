# 止损计时 · Check-in Timer（网页版）

随手安放灵感，到点重新决定。一个把「该不该继续投入」摆上台面的网页计时器：念头零压力存入待启池，想开始时以 15 分钟最小阻力破冰，到点铃响自主做出决定——继续、换个办法，还是就此收场。

**本仓库是纯网页版的开源自托管版**：所有功能对所有用户免费，没有任何账号体系之外的付费门禁、订阅或统计埋点广告。不登录也能完整使用（数据只在本机）；登录后数据同步到你自己的 Cloudflare KV，多端秒级实时同步。界面有中文与 English 两套。

> 另请阅读 [LICENSE](./LICENSE)。本项目零 npm 依赖，CI 会强制这一点。

## 功能

- **待启灵感池**：闪烁念头随手存入，带假设（什么情况就停下来）与场景标签；搜索、随机唤醒。
- **破冰专注**：15 分钟（可调）时间盒 + 到点强制重评；全屏单任务聚焦与全景看板两种模式，支持画中画迷你秒表。
- **到点重评**：铃响后弹出到点面板，自主决定「就到这里 / 换个办法 / 再投入一会儿 / 以后再看」，提交前写下假设与预期。
- **记录与复盘**：决定历史、每日复盘、Markdown / JSON 导出、高级多维洞察（按场景与时段分布）。
- **个人重评规则**：内置跨场景思考框架模板，也可自定义（提醒词、多轮时长组合）。
- **提醒能力**：预告提醒、未响应重复提醒、按事项绑定自定义铃声（本地导入音频，只存在这台设备）。
- **曜石能量与连击**：完成破冰、决断、入库获得曜石；连续专注累计连击，中断时连击保护卡自动兜底。
- **可选云同步**：注册 / 登录后与本机数据双向同步，乐观并发（`If-Match`）防覆盖，冲突时给「保留云端 / 保留本机」三选一。

## 部署（Cloudflare Pages）

服务端 = Pages Functions + KV，全部在一个仓库里，不需要任何 npm 安装步骤。

1. Fork / 克隆本仓库，推到你的 GitHub。
2. 在 Cloudflare Dashboard 创建 Pages 项目，连接该仓库（框架预设选 None，构建命令留空，输出目录 `public`）。
3. 创建 KV namespace 并绑定：

   ```bash
   npx wrangler kv namespace create KV
   # 把输出的 id 填进 wrangler.toml 的 [[kv_namespaces]]
   ```

4. （可选）配置管理端 token，用于 `POST /api/events/summary`：

   ```bash
   npx wrangler pages secret put ADMIN_TOKEN
   ```

5. 部署。之后 push 到 `main` 会经 GitHub Actions 测试后自动部署（见 `.github/workflows/web.yml`，需要在仓库与 Cloudflare 侧配置 `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID`）。

本地开发（`wrangler pages dev` 不读进程环境变量，用 `--binding`）：

```bash
npx wrangler pages dev --port 8788 --kv KV --binding ADMIN_TOKEN=dev-admin
# 打开 http://127.0.0.1:8788
```

### 绑定与环境变量

| 名称 | 类型 | 必需 | 说明 |
| --- | --- | --- | --- |
| `KV` | KV namespace | 是 | 账户、会话 token、数据同步与事件计数的唯一存储 |
| `ADMIN_TOKEN` | secret | 否 | 配置后可访问管理端接口（当前只有事件汇总） |
| `SEND_EMAIL` | service binding | 否 | 可选的发信 Worker（持有 `send_email` 绑定），用于邮箱验证信 |
| `MAIL_FROM` | secret | 否 | 发信 Worker 的默认发件地址 |

> 注意：Pages Functions **不支持** `[[send_email]]` 绑定。要发信需另起一个持有 `send_email` 的 Worker，以 service binding 形式接入（代码已按该形状写好，未配置时邮箱相关接口返回 `pending`，不影响任何核心功能）。详见 `functions/api/[[route]].js` 内注释。

## 结构

```
public/index.html          样式（<style>，全部走 CSS 变量）与结构（<body>，只有 id，文案由 t() 填）
public/app/                Web 客户端逻辑（ESM，零依赖）：app.js 主脚本 + storage / sync-client / reminders / events / sounds / energy
public/core/               packages/core 的 ESM 构建产物（勿手改，`npm run build:core` 重新生成）
public/manifest.webmanifest PWA 清单
functions/api/[[route]].js 账户（注册/登录/找回）与数据同步 v1+v2
functions/api/_lib.js      服务端共享工具（口令、token、限流）
functions/api/_schema.js   数据契约 v2 的服务端校验 + v2↔v1 投影
functions/api/events/      经同意的最小事件（按天聚合计数，不存任何自由文本）
functions/test/            服务端单测（node:test，零依赖，env.KV 用内存 Map）
packages/core/             四端共享的领域逻辑（纯函数：输入 state、输出新 state）+ 双语文案
scripts/                   build-core / check-html
.github/workflows/web.yml  测试（连跑两遍）+ 产物一致性校验 + main 部署
```

### API 列表

| 方法 | 路径 | 鉴权 | 说明 |
| --- | --- | --- | --- |
| POST | `/api/register` | — | 注册，返回 token。5 次/小时/IP |
| POST | `/api/login` | — | 登录，返回 token。10 次/5 分钟/IP |
| GET | `/api/data` | Bearer | 带 `X-Schema-Version: 2` 得 v2，否则得 v1（云端已是 v2 时给保守投影）。响应头 `X-Data-Schema` 说明云端实际格式 |
| PUT | `/api/data` | Bearer | v2 需带 `If-Match: <rev>`。不匹配 409 `conflict`（带回云端整包）；旧客户端撞上 v2 云端 409 `client_outdated`；超容量 413 `capacity_full`。**内容与云端一致时不写 KV**，返回 `{ok:true, rev, unchanged:true}` |
| POST | `/api/recovery/code` | Bearer | 生成 12 位一次性找回码，明文只返回这一次 |
| POST | `/api/recovery/email` | Bearer | 绑定邮箱（可选发验证信）。未配 `SEND_EMAIL` 时返回 `{pending:true}` |
| POST | `/api/recover` | — | 用户名 + 找回码 + 新密码 → 重置密码、吊销该用户全部旧 token。5 次/小时/IP |
| POST | `/api/events` | — | `{events:[{name, at, platform, version?, decisionKind?, entryMode?, decisionId?, sessionId?}]}`。白名单外的事件名与**任何自由文本字段一律丢弃**。60 次/分钟/IP |
| GET | `/api/events/summary?from=&to=` | Admin | 按天聚合计数（区间最长 92 天） |

### KV 键位

`user:{用户名}` 凭据 · `token:{token}` 会话（30 天 TTL）· `tokens:{用户名}` 会话反向索引 · `data:{用户名}` 全量数据（v1/v2）· `recovery:{用户名}` 找回码哈希 · `email:{用户名}` 与 `emailhash:{sha256(邮箱)}` 邮箱正反向索引 · `agg:{YYYY-MM-DD}:{name}:{platform}` 事件计数 · `evdedup:{decisionId}` 事件去重（TTL 7 天）

### 本机存储键位（localStorage + IndexedDB）

`sl.v2` 访客本机数据 · `stoploss.v1` 旧版数据（迁移后不删，回退路径）· `sl.settings` 设置 · `sl.token` / `sl.user` 会话 · `sl.energy` 曜石与连击 · 自定义音频在 IndexedDB `sl.sounds` 库（只存在这台设备，不进同步整包）

## 测试

```bash
npm test        # node --test，零依赖，覆盖 packages/core、functions、public/app 三层
npm run check:html
npm run build:core   # 改了 packages/core 后重新生成 public/core 并一起提交
```

CI（GitHub Actions）会把 `npm test` 连跑两遍、校验 `public/core` 与源码同版、做 HTML 静态自检，然后才允许部署。

## 设计约束

- **零 npm 依赖**：运行时与测试都不装任何包。CI 检出 `node_modules` 或 lockfile 直接失败。
- **纯函数领域内核**：`packages/core` 只做「输入 state、输出新 state」的计算，不拥有提醒调度、存储读写；四端（本仓库网页端）共用同一份语义。
- **隐私边界**：事件分析只收枚举与 id，任何自由文本（事项名、笔记、期待、感受）在客户端与服务端都被双重丢弃；同意关闭时整个是空操作。
- **防刷**：进程内固定窗口限流（按 `CF-Connecting-IP`）压平突发；KV 写入在内容未变时服务端短路，省免费档每日 1000 次写配额。

## License

[MIT](./LICENSE)
