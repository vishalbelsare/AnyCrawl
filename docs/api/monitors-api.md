# Monitors API 文档

## 概述

监控 API 用于对网页进行周期性变更监控（Web 变更监控）与结构化价格监控（Price 监控）。监控任务建立在定时任务（Scheduled Tasks）之上：每个监控对应一条后台 `scrape` 定时任务，按 cron 周期抓取目标页面，抓取完成后自动执行归一化、内容 hash、diff 与告警。

两种监控类型：

- `webpage`：文本变更监控。对归一化后的页面内容计算 hash，并生成行级 unified diff。
- `price`：价格/结构化监控。在文本监控之上，用 `extract_schema` 通过 LLM 抽取结构化字段（如价格、库存），再做字段级 diff 并按阈值分类（`price_up` / `price_down` / `stock`）。

首次有效检查建立 `new` 基线；首次抓取/抽取失败记录 `error`，不能成为基线。后续检查与当前 revision 的上一条完整有效快照比较。

**Base URL**: `https://your-domain.com/v1`

**认证**：所有请求需在 Header 中包含有效的 API Key：
```
Authorization: Bearer YOUR_API_KEY
```

---

## 端点列表

| 方法 | 端点 | 描述 |
|------|------|------|
| POST | `/monitors` | 创建监控 |
| GET | `/monitors` | 获取监控列表 |
| GET | `/monitors/changes` | 所有者范围的跨监控变化 feed |
| GET | `/monitors/:id` | 获取监控详情 |
| GET | `/monitors/:id/checks` | 持久化检查状态及失败原因（limit ≤ 200） |
| GET | `/monitors/:id/notifications` | 各通知渠道的状态、尝试次数和错误（limit ≤ 200） |
| PATCH | `/monitors/:id` | 更新监控 |
| DELETE | `/monitors/:id` | 删除监控（级联删除快照与变更记录） |
| POST | `/monitors/:id/pause` | 暂停监控 |
| POST | `/monitors/:id/resume` | 恢复监控 |
| POST | `/monitors/:id/check` | 立即执行一次检查（on-demand） |
| GET | `/monitors/:id/snapshots` | 获取快照历史（轻量列表，不含 `content` / `extracted`） |
| GET | `/monitors/:id/snapshots/:snapshotId` | 获取单条快照详情（含正文预览 / `extracted`） |
| GET | `/monitors/:id/changes` | 获取变更历史（价格曲线数据源） |
| GET | `/monitors/:id/changes/:changeId` | 获取单条变更详情（含完整 diff） |

---

## 1. 创建监控

**端点**: `POST /monitors`

### 请求参数

| 参数 | 类型 | 必填 | 默认值 | 说明 |
|------|------|------|--------|------|
| `name` | string | 是 | - | 监控名称（1-255 字符） |
| `description` | string | 否 | - | 描述 |
| `monitor_type` | string | 否 | `"webpage"` | 监控类型：`"webpage"` 或 `"price"` |
| `cron_expression` | string | 是 | - | Cron 表达式（标准 5 字段；6 字段秒级表达式被拒绝；触发间隔不得低于 15 分钟） |
| `timezone` | string | 否 | `"UTC"` | IANA 时区（如 `"Asia/Shanghai"`；无效时区返回 400） |
| `targets` | object[] | 是 | - | 监控目标数组（至少 1 个；MVP 仅调度第一个目标） |
| `targets[].url` | string | 是 | - | 目标 URL |
| `targets[].engine` | string | 否 | `"auto"` | 抓取引擎：`auto`/`cheerio`/`playwright`/`puppeteer` |
| `targets[].options` | object | 否 | - | 透传给底层 scrape 的选项 |
| `targets[].location` | object | 否 | - | 新请求不支持固定地域；提供非空 `country` 返回 400，旧值仅保留供读取 |
| `goal` | string | 否 | - | 自然语言判定标准，用于 AI judge 过滤噪声 |
| `track_mode` | string | 否 | 按类型推断 | `"text"`/`"json"`/`"mixed"`；缺省时 `webpage→text`、`price→json` |
| `extract_schema` | object | price 必填 | - | 结构化抽取用的 JSON Schema |
| `diff_options` | object | 否 | - | 见下 |
| `notify_options` | object | 否 | `{channels:["webhook"],only_meaningful:true}` | 见下 |
| `concurrency_mode` | string | 否 | `"skip"` | `"skip"` 或 `"queue"` |
| `max_executions_per_day` | number | 否 | - | 每日最大执行次数 |
| `tags` | string[] | 否 | - | 标签 |
| `metadata` | object | 否 | - | 元数据 |

`diff_options`：

| 字段 | 类型 | 说明 |
|------|------|------|
| `ignore_selectors` | string[] | 含这些字符串的行在归一化时被剔除（降噪） |
| `only_main_content` | boolean | 是否只保留正文（透传给底层 scrape） |
| `min_change_ratio` | number | 变更行占比阈值（0-1），保留字段供后续使用 |

`notify_options`：

| 字段 | 类型 | 说明 |
|------|------|------|
| `channels` | string[] | 通知通道：`"webhook"` / `"email"` |
| `email_recipients` | string[] | 当 `channels` 含 `email` 时必填 |
| `only_meaningful` | boolean | 仅当 AI judge 判定 meaningful 时告警（默认 true） |
| `thresholds.price_change_pct` | number | 价格变化百分比阈值，低于该阈值不触发价格告警 |

### 请求示例（Web 变更监控）

```json
POST /v1/monitors
{
  "name": "Docs Homepage",
  "monitor_type": "webpage",
  "cron_expression": "0 */6 * * *",
  "timezone": "Asia/Shanghai",
  "targets": [{ "url": "https://example.com/docs", "engine": "auto" }],
  "goal": "Alert when the documented API surface changes",
  "notify_options": { "channels": ["webhook"], "only_meaningful": true }
}
```

### 请求示例（价格监控）

```json
POST /v1/monitors
{
  "name": "Competitor Pricing",
  "monitor_type": "price",
  "cron_expression": "0 */6 * * *",
  "timezone": "Asia/Shanghai",
  "targets": [
    { "url": "https://competitor.com/pricing", "engine": "auto" }
  ],
  "track_mode": "json",
  "extract_schema": {
    "type": "object",
    "properties": {
      "plans": {
        "type": "array",
        "items": {
          "type": "object",
          "properties": {
            "name": { "type": "string" },
            "price": { "type": "number" },
            "currency": { "type": "string" }
          }
        }
      }
    }
  },
  "goal": "Alert when any plan price changes or a new plan is added",
  "notify_options": {
    "channels": ["webhook", "email"],
    "email_recipients": ["team@you.com"],
    "only_meaningful": true,
    "thresholds": { "price_change_pct": 1 }
  }
}
```

### 响应

```json
{
  "success": true,
  "data": {
    "monitor_id": "b1c2...",
    "scheduled_task_id": "a9f8...",
    "track_mode": "json",
    "next_execution_at": "2026-07-11T18:00:00.000Z"
  }
}
```

---

## 2. 获取监控列表

**端点**: `GET /monitors` → `{ success, data: Monitor[] }`（按 owner 隔离，按创建时间倒序）

## 3. 获取监控详情

**端点**: `GET /monitors/:id` → `{ success, data: Monitor }`

## 4. 更新监控

**端点**: `PATCH /monitors/:id`

请求体为创建参数的可选子集，**不支持修改 `monitor_type`**，另支持 `is_active`。未声明的顶层字段返回 400。先验证 PATCH 结构，再在事务中读取当前 owner 记录、合并并验证最终配置，监控与底层任务一起提交。

- `diff_options` / `notify_options` 按字段合并；`thresholds` 的兄弟字段保留。切到 email 可复用已存 recipients，但最终列表不能为空。
- `goal: null` 清除判断目标及抽取提示词；`extract_schema: null` 仅在最终模式不需要抽取 schema 时合法。price、json、mixed 均要求 schema。
- name/description/tags/metadata 同步到底层任务；保留服务端 `monitorManaged` / `monitorUuid` 标记，GET 的 metadata 不暴露它们。tags/metadata 可用 null 清空。
- 有效抓取 payload、track_mode、goal、文本行排除规则改变时递增 `revision`，下一次有效结果重新建立基线；仅通知或阈值调整不重建基线。
- `diff_options.only_main_content` 优先于 target options；必须的 markdown/json formats 不会被 target options 覆盖。监控 targets 不支持 template_id/variables。
- 调度同步在提交后执行；Redis 暂时不可用时由 scheduler 从 DB 恢复。

## 5. 删除监控

**端点**: `DELETE /monitors/:id`

删除监控会级联删除其所有快照与变更记录，并删除底层定时任务。

## 6. 暂停 / 恢复

- `POST /monitors/:id/pause`：置 `is_active=false` 并暂停底层任务。
- `POST /monitors/:id/resume`：恢复底层任务并清零连续失败计数。

## 7. 立即检查（on-demand）

**端点**: `POST /monitors/:id/check` → `202 { success, message, data: { monitor_id } }`

立即向共享调度队列投递一次非周期性执行（API 进程本身不运行调度器；投递前会探测队列是否有调度 worker 在消费）。

| 状态码 | 含义 |
|--------|------|
| `202` | 已入队，结果稍后出现在快照/变更中 |
| `409` | 监控已暂停，或已有一次检查在执行中 |
| `503` | 没有调度 worker 在消费队列（检查 `ANYCRAWL_SCHEDULER_ENABLED` 与 Redis 连通性） |

> 创建监控（`POST /monitors`）成功后会自动触发一次立即首检以建立基线快照（仅当调度 worker 在线；否则等待首个 cron 触发）。

## 8. 快照历史

**端点**: `GET /monitors/:id/snapshots?limit=50&offset=0`

返回 `monitor_snapshots` 轻量记录（按 `captured_at` 倒序）。列表**不含** `content` 与 `extracted` 重字段。需要正文预览或抽取结果时使用单条详情端点。每条包含：

| 字段 | 说明 |
|------|------|
| `uuid` | 快照 ID |
| `monitor_uuid` | 所属监控 ID |
| `task_execution_uuid` | 产生该快照的任务执行 ID |
| `url` | 目标 URL |
| `content_hash` | 归一化内容的 sha256 |
| `status` | `new` / `same` / `changed` / `error`（`error` 表示该次检查失败，不参与后续 diff 基线；`removed` 预留未产生） |
| `captured_at` | 抓取时间 |

### 单条快照详情

**端点**: `GET /monitors/:id/snapshots/:snapshotId`

返回快照详情（正文为有上限的预览，完整正文仍保留用于比较），按监控归属校验：监控不存在或不属于当前所有者返回 `404`，快照不属于该监控亦返回 `404`。

| 字段 | 说明 |
|------|------|
| `content` | 归一化后的内联内容（截断上限见 `ANYCRAWL_MONITOR_MAX_INLINE_CHARS`） |
| `extracted` | json/mixed 模式的原始结构化结果 |
| `content_truncated` / `content_length` | 预览是否截断 / 完整正文字符数 |
| `content_complete` / `monitor_revision` / `sequence_number` / `check_uuid` | 比较数据完整性、配置版本、执行序号与持久化检查 ID |

```json
{
  "success": true,
  "data": {
    "uuid": "s1a2...",
    "monitor_uuid": "b1c2...",
    "task_execution_uuid": "e3f4...",
    "url": "https://competitor.com/pricing",
    "content_hash": "9f86d0...",
    "content": "# Pricing\n...",
    "extracted": { "plans": [{ "name": "Pro", "price": 24 }] },
    "status": "changed",
    "captured_at": "2026-07-11T18:00:00.000Z"
  }
}
```

## 9. 变更历史

**端点**: `GET /monitors/:id/changes?limit=50&offset=0`

返回 `monitor_changes` 记录（按创建时间倒序），可作为价格曲线数据源。

**单条详情**: `GET /monitors/:id/changes/:changeId`

| 字段 | 说明 |
|------|------|
| `change_type` | `content` / `price_up` / `price_down` / `stock`（`new` / `removed` 预留未产生） |
| `diff_text` | 文本 unified diff |
| `diff_json` | 字段级 diff：`[{ path, from, to, delta? }]` |
| `judgment` | `{ meaningful: boolean|null, confidence, reason, status }`；status 为 complete/unavailable/incomplete，未知保留变化 |
| `notified` | 新记录：至少一个 SMTP 收件人被接受或 Webhook HTTP 2xx 送达 |
| `notification_status` | `legacy` / `none` / `pending` / `queued` / `delivered` / `failed` / `skipped`；legacy 的 boolean 无法证明实际送达 |

---

## Webhook 事件

监控通过现有 Webhook 系统推送告警（HMAC-SHA256 签名、指数退避重试、投递日志）。订阅时在 `event_types` 中加入以下事件；`scope=specific` 的订阅通过 `specific_task_ids` 包含 `monitor_id` 进行匹配。与作业完成事件不同，监控事件**内联携带变更内容**。

| 事件 | 触发时机 |
|------|----------|
| `monitor.check.completed` | 每次检查完成，携带 same/changed 计数摘要 |
| `monitor.changed` | 检测到有意义的内容变更（webpage） |
| `monitor.price.changed` | 检测到价格变更（price_up / price_down） |
| `monitor.error` | 监控检查失败（抓取失败/超时），payload 携带 `error: { message, code? }` |

`monitor.changed` / `monitor.price.changed` payload：

```json
{
  "monitor_id": "b1c2...",
  "monitor_name": "Competitor Pricing",
  "monitor_type": "price",
  "url": "https://competitor.com/pricing",
  "change_type": "price_up",
  "diff_text": "@@ -1,3 +1,3 @@ ...",
  "diff_json": [{ "path": "plans[0].price", "from": 19, "to": 24, "delta": 5 }],
  "judgment": { "meaningful": true, "confidence": "high", "reason": "Plan price increased" },
  "captured_at": "2026-07-11T18:00:00.000Z"
}
```

遵循克制策略：**无变更时不发送 Email**（仅在有 changed/new/removed/error 时发送）。

---

## Email 通知

当 `notify_options.channels` 含 `email` 且服务端配置了 SMTP（`ANYCRAWL_SMTP_HOST` 等环境变量）时，监控会向 `email_recipients` 发送变更摘要邮件（含字段变更表格与 diff）。失败检查也向 email channel 发送错误邮件。每个收件人有独立持久化意图、有限重试及错误记录；未配置 SMTP 会进入重试/失败状态。Webhook 与 Email 独立处理，入队不等于送达。稳定 Message-ID 可辅助识别重试，SMTP 不保证 exactly-once。

相关环境变量：

| 变量 | 说明 |
|------|------|
| `ANYCRAWL_SMTP_HOST` | SMTP 主机（配置后启用 Email） |
| `ANYCRAWL_SMTP_PORT` | 端口，默认 587 |
| `ANYCRAWL_SMTP_SECURE` | 是否使用 TLS（`true`/`false`） |
| `ANYCRAWL_SMTP_USER` / `ANYCRAWL_SMTP_PASS` | 认证凭据 |
| `ANYCRAWL_SMTP_FROM` | 发件人 |
| `ANYCRAWL_MONITOR_MAX_INLINE_CHARS` | API 正文预览上限，默认 262144 字符 |
| `ANYCRAWL_MONITOR_MAX_CONTENT_CHARS` | 完整比较正文上限，默认 2000000 字符；超限记录 error |
| `ANYCRAWL_MONITOR_MAX_ATTEMPTS` | 处理/通知意图最大尝试次数，默认 5 |
| `ANYCRAWL_MONITOR_RETRY_DELAY_MS` | 初始重试间隔，默认 5000 ms，指数退避最多 15 分钟 |
| `ANYCRAWL_MONITOR_LEASE_MS` | 处理 lease，默认 120000 ms，有续租和 fencing |
| `ANYCRAWL_MONITOR_POLL_MS` | 恢复扫描间隔，默认 5000 ms |
| `ANYCRAWL_MONITOR_RETENTION_DAYS` | 默认 0，不自动删除；启用后分批清理新工作流旧记录，保护 legacy、有效基线、保留的 change 引用和待投递记录 |

---

## 计费

监控本身不额外收费，按每次检查计费（等同一次 scrape）。price 模式的 LLM 抽取按底层 scrape 的 `json_options` 计费规则收取。`min_credits_required` 由服务端估算，余额不足时底层任务会被跳过或暂停（沿用定时任务逻辑）。

---

## 说明与限制

- MVP 仅支持底层 `scrape`（单/多固定 URL 的第一个目标）；`crawl` 类型多页监控为后续能力。
- 变更 diff 依赖独立的 `monitor_snapshots` 表长期保留，不受 `job_results` TTL 影响。
- 地域固定尚不支持；GET 返回 capabilities.location=false。价格图按 URL/path/currency 分组，不把地域字段当作实际出口证据。
- 同一监控的抓取及后处理只有一个活跃 check。skip 跳过重叠 cron，queue 延后执行；手动检查也遵守单飞。monitorManaged 任务不计普通任务配额。

## SDK 用法（JS/TS）

```ts
import { AnyCrawlClient } from "@anycrawl/js-sdk";
const client = new AnyCrawlClient("YOUR_API_KEY");

const { monitor_id } = await client.createMonitor({
  name: "Competitor Pricing",
  monitor_type: "price",
  cron_expression: "0 */6 * * *",
  targets: [{ url: "https://competitor.com/pricing" }],
  extract_schema: { type: "object", properties: { price: { type: "number" } } },
  notify_options: { channels: ["webhook"], thresholds: { price_change_pct: 1 } },
});

await client.runMonitor(monitor_id);          // on-demand check
const changes = await client.getMonitorChanges(monitor_id, { limit: 20 });
```


## 状态、游标和恢复契约

Monitor GET 额外返回 `revision`、`in_progress`、`last_check_state`、`last_check_at`、`last_check_error`、`pause_reason`。有效运行状态为 `is_active && !is_paused`；自动暂停应直接调用 resume。`409` 的 code 区分 `MONITOR_PAUSED` 与 `MONITOR_CHECK_IN_PROGRESS`。

快照、单监控 changes、跨监控 feed 都返回 `{success, data: [...], pagination: {has_more, next_cursor}}`。下一页传 `cursor=next_cursor`，不可从前端去重后的数组长度推算 offset。保留旧 offset 参数；时间相同按 uuid 倒序。非法 cursor 返回 400。feed 支持 change_type，省略重 diff；单监控 changes 可用 `include_diff_text=false`，展开时请求 change detail。详情同时返回该 change 的通知记录。

检查状态为 pending → ready → processing → completed/failed。execution 终态与 ready 意图同事务提交；snapshot/change/notification intents 也同事务提交。Worker 从 DB 认领及恢复，过期处理者不能重复发布。配置变更过程中完成的旧结果保留于原 revision，不发布过时告警。暂停或删除监控会阻止尚未开始的通知；已经发出的 HTTP/SMTP 请求不能撤回。

新完整正文保存在 DB，API 预览截断不影响比较。旧缺少 content_complete 或 revision 的快照保留历史，不用于新基线；升级不追溯重放历史通知。AI 不可用或组合输入超限时记录 meaningful=null，并保留变化证据。阈值比较基于上一有效检查，而不是累计到上一次告警。

```ts
const page = await client.listMonitorChanges({ limit: 20 });
const next = page.pagination.next_cursor
  ? await client.listMonitorChanges({ cursor: page.pagination.next_cursor }) : null;
const snapshotsPage = await client.getMonitorSnapshotsPage(monitor_id, { limit: 20 });
const snapshot = await client.getMonitorSnapshot(monitor_id, snapshotsPage.data[0].uuid);
const checkHistory = await client.getMonitorChecks(monitor_id);
const notifications = await client.getMonitorNotifications(monitor_id);
```
