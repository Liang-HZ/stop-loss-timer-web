# packages/core — 共享领域逻辑

纯 JS ESM，零依赖，**不碰 DOM、微信 API、原生 API、网络、存储**。Web、小程序、Android/iOS（后者只参考）共用同一份「事项—轮次—决定」语义。

**这个包不拥有提醒调度、不拥有存储读写**——它只做纯函数计算，输入 state、输出新 state。

## 模块职责

| 模块 | 职责 | 不负责 |
| --- | --- | --- |
| `model.js` | v2 的 Task / Session / Decision / Template 创建、校验、id 生成、查询辅助 | 任何持久化 |
| `migrate.js` | v1 → v2 迁移（幂等）、v1 投影（回退与旧客户端） | 读写 localStorage / KV |
| `flow.js` | 状态流：开始、改截止、打开重评、**统一的 `decide`**、取消、接续、回访 | 提醒排期、音频、通知 |
| `capacity.js` | 容量边界与满仓拒写（`code:'capacity_full'`） | 自动清理、截断 |
| `review.js` | 按天／事项列决定、弱化的累计投入、今日复盘 Markdown、**高级复盘 `advancedReview()`**（按场景与时段分组计数） | 图片导出、剪贴板、任何形式的评分与排名 |
| `templates.js` | 五个跨生活领域的**内置**重评规则例子（只读，不写进 state） | 用户自己的规则（那些走 `flow.saveTemplate`） |
| `sync.js` | 按 id 合并、冲突检测、访客登录三选一 | 发请求、鉴权 |
| `copy.js` | zh-CN / en 文案表（键名稳定） | 排版与 DOM |

所有会用到「当前时间」和「随机 id」的函数都接受第三个参数 `ctx = { now, idGen }`，测试里注入即可完全确定化。

## 数据形状（v2）

```js
{ schemaVersion: 2, tasks: Task[], sessions: Session[], decisions: Decision[],
  templates?: Template[],                                  // 没有模板时这个键不出现
  updatedAt, rev, legacy?: {version:1, capturedAt, items, history}, sourceVersion?: 1 }
```

- `Task  { taskId, name, createdAt, status:'active'|'ended'|'completed'|'later', hypothesis?, scene?, templateId?, origin?:{legacyHistId} }`
- `Session { sessionId, taskId, entryMode:'planned'|'immediate', plannedMs?, legacyPlanned?, deadlineAt?, deadlineChanges:[{at,deadlineAt}], startedAt?, endedAt?, endReason?:'decision'|'early'|'cancelled'|'unknown', continuedFrom?, userEstimatedPriorMs?:{value,source:'user_estimate'}, legacy? }`
- `Decision { decisionId, taskId, sessionId:string|null, entryMode, at, kind:'stop'|'switch'|'continue', continueMs?, note?, expectation?, later?, completed?, userEstimatedPriorMs?:{value,source:'user_estimate'}, followUp?:{at,stillAgree?,feeling?} }`
- `Template { templateId, name, createdAt, updatedAt, hypothesis?, reminderText?, scene?, durationsMs?:number[], builtIn? }`
- `Scene = 'compare'|'stuck'|'detail'|'argue'|'debug'|'other'`（`SCENES` 导出；「其它／不填写」永远可选，不强制用户归类）

五条硬约束，集成时别绕开：

1. **`startedAt` 只在真有开始时刻时存在。** 旧数据与旧 `items` 迁移过来的轮次没有它，`sessionElapsedMs()` 对它们返回 `null`。不要用 `plannedMs` 顶替经过时间。
2. **`legacyPlanned:true` 的 `plannedMs` 是「旧版计划用时」**，不是实测投入，UI 必须标注可辨认。
3. **即时入口默认没有 Session**，`Decision.sessionId = null`。不要为了让列表好看凭空造一个轮次。
4. **`userEstimatedPriorMs` 永远是用户自述**，有计时轮次时挂 Session、即时决定时挂 Decision。它与实测经过时间分开呈现，**不相加**，也绝不能拿它补造一段计时。`source` 固定 `'user_estimate'`。
5. **`templates` 只是输入预设**，不参与任何「事项—轮次—决定」的判定：用模板开一轮和手填开一轮产生的记录完全一样。`builtInTemplates(locale)` 给的内置例子是**只读**的，不要写进 state（会占容量、还要跨端同步）。`advancedReview()` 只做分组计数，**不排名、不打分、不判定谁的选择更理性**。

## 调用示例

### Web（ESM）

```html
<script type="module">
import { migrate, startPlanned, openReassessment, decide, todayReviewMarkdown, checkCapacity }
  from '/core/index.js';   // 由 npm run build:core 从 packages/core 产出

// 1) 读本机数据并迁移（v2 输入原样返回，随便调多少次）
const v1 = { items: JSON.parse(localStorage.getItem('stoploss.v1') || '[]'),
             history: JSON.parse(localStorage.getItem('stoploss.history.v1') || '[]') };
let state = migrate(v1);

// 2) 事前设点
const started = startPlanned(state, { name: '比价', plannedMs: 30 * 60000, hypothesis: '差价不到 20 元就买' });
state = started.state;

// 3) 到点／提前／列表／全屏／画中画——都走同一条路：先 open 拿 decisionId，再 decide
const { draft } = openReassessment(state, { taskId: started.task.taskId });
state = decide(state, { ...draft, kind: 'continue', continueMs: 15 * 60000, expectation: '再看两家' }).state;

// 同一个 draft.decisionId 再提交一次不会重复归档（idempotent:true，state 原样返回）

// 4) 容量与复盘
if (checkCapacity(state).level !== 'ok') showExportEntry();
copyToClipboard(todayReviewMarkdown(state, { locale: 'zh-CN' }));
</script>
```

### 小程序（CommonJS）

```js
// miniprogram/core/ 由 npm run build:core 生成，随包一起发布
const core = require('../core/index.js');
let state = core.migrate(wx.getStorageSync('data') || {});
const r = core.enterImmediate(state, { name: '这次纠结' });   // 不建轮次、不虚报时长
state = core.decide(r.state, { taskId: r.task.taskId, kind: 'stop', later: true }).state;
wx.setStorageSync('data', state);
```

### 同步

```js
import { detectConflict, mergeStates, resolveGuestLogin } from '/core/index.js';

const c = detectConflict(localRev, serverRev);
if (c.conflict) {                      // 'server_ahead' 或 'unknown_base'
  // 保存本地副本为「待处理冲突」，让用户选：保留云端／保留本机／导出本机
}
const { state, discarded, keepLocalBackup } = resolveGuestLogin(choice, { local, cloud });
// choice==='cloud' 时 discarded 是被放弃的访客数据，必须提供导出，不能静默丢
```

## `decide()` 的规则（所有入口共用）

| kind | Session | Task.status | 备注 |
| --- | --- | --- | --- |
| `stop` | 关闭当前轮 | `ended`；`later:true`→`later`；`completed:true`→`completed` | 默认结束，**不**自动进待继续；`later` 与 `completed` 互斥 |
| `switch` | 关闭当前轮，**不新建** | `ended` | 换个办法不必再开一轮；`note` 可选 |
| `continue` | 关旧轮 + 开新轮（`continuedFrom`） | `active` | 必须给 `continueMs` |

- `endReason`：决定时刻早于 `deadlineAt` → `early`，到点或超时确认 → `decision`，主动取消 → `cancelled`，旧数据 → `unknown`。（细分 `early` 与 `decision`，是为了让「提前结束」与「超时确认」可区分。）
- **幂等**：`decisionId` 已存在就原样返回旧 state（`idempotent:true`）。刷新、重复点击、重复同步都安全。
- `openReassessment()` 不改数据，只发 `decisionId`；打开重评不等于做了决定。
- `resumeLater()` 只接受 `status==='later'` 的事项（`code:'not_later'`），因为只有用户主动选「以后再看」才有接续入口。

## 错误

| 类 | `code` | 场景 |
| --- | --- | --- |
| `ValidationError` | `invalid` | 字段不合法（如 `later` 与 `completed` 同时为真） |
| `FlowError` | `not_found` / `invalid_input` / `session_closed` / `not_later` / `schema_mismatch` | 状态流前置条件不满足 |
| `CapacityError` | `capacity_full` | 达到 tasks 500 / sessions 3000 / decisions 3000；**抛错，不截断**，`detail.blocked` 说明是哪一项 |

## 构建与测试

```bash
npm run build:core   # packages/core → public/core（ESM 原样）+ miniprogram/core（CJS）
npm test             # node --test，覆盖全部验收场景
```

`public/core/` 与 `miniprogram/core/` 是构建产物，**勿手改**；改动只落在 `packages/core/`。
