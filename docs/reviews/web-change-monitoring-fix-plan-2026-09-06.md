# Web Change Monitoring 修复计划

日期：2026-09-06。状态：**用户授权的修复已实施，验收结果已记录**。本文件保留原审查阶段的方案；实际完成情况见 [实施状态](./web-change-monitoring-implementation-status.md)。

依据：[完整审查报告](./web-change-monitoring-review-2026-09-06.md)。R01–R24、O1–O9 均引用该报告的编号。本文件只描述后续工作，不代表已经修改、迁移、提交或部署。

补充依据：[实际 UI 审查](./web-change-monitoring-ui-review-2026-09-06.md)，包括 U01–U14、DEV-01 与 33 张截图。临时登录授权只用于审查，不代表已经获准开始实施本计划。

## 1. 目标与范围

修复目标是让当前单目标 Monitors 达到可验证的可靠闭环：

1. 每次检查和通知均严格属于正确 owner。
2. PostgreSQL 与 SQLite 上的创建、修改、暂停、恢复、删除和调度行为一致。
3. 一次检查即使遇到进程退出、DB/Redis 暂时失败，也能恢复到可解释的终态。
4. 可比较的变化不因文本 hash、存储预览截断或错误基线而丢失。
5. Dashboard 展示的有效状态、配置和通知状态对应实际行为。
6. API、SDK、文档和自动化验收采用同一契约。
7. 视觉样式、明暗主题、响应式、键盘操作、表单及浮层焦点均满足明确的 UI 验收标准。

本次修复不自动扩展为多 URL/crawl 监控、视觉截图 diff、站点发现、Dataset reconciliation、实时 WebSocket 服务或整套抓取引擎重写。已有多 targets 只执行第一项的限制先明确呈现，是否扩展另行决定。

## 2. 方案比较

| 方案 | 优点 | 代价与边界 |
| --- | --- | --- |
| **A. 分批修复现有系统，并补齐持久化检查/通知状态（推荐）** | 可先修隔离和驱动阻塞；复用现有 DB、BullMQ、抓取和 BFF；逐步建立恢复能力 | 需要小规模新增状态/索引/迁移，必须仔细设计幂等与兼容 |
| B. 只修分支判断与 UI | 改动少，能很快消除 hash、PATCH 和表单错误 | 无法解决终态后丢处理、DB/Redis 两步提交和 Email 重试；只能作为第一批止血，不能完整验收 |
| C. 独立重写监控服务 | 可重新设计全部状态和存储边界 | 迁移与运维成本大，双运行和数据切换复杂，超出当前修复需要 |

采用 A 的设计建议。所有数据库、队列、存储和 AI provider 继续使用现有配置；任何依赖不可用都记录失败和验证阻塞，不在实施中静默换 provider、数据库或测试策略。

## 3. 先确定的设计约束

### 3.1 Owner 一致性

- HTTP API、backing task、check、snapshot、change、notification 使用同一 OwnerContext 规则。
- 存在 userId 时按用户隔离，支持同用户换 API Key；没有 userId 时按 API Key 隔离。
- 托管模式空 owner 应拒绝分发；auth-disabled 单租户模式需要显式配置语义。
- Webhook 的 scope 是 owner 范围内的二次筛选，不能替代 owner 边界。

### 3.2 执行完成与监控处理分别记录

建议增加独立的持久化 monitor check/postprocess 记录，具体表名在数据库实现 PR 中定稿。最小字段包括：monitor、execution、target URL、job 关联、配置快照/版本、处理状态、尝试次数、lease、下次重试时间和错误原因。

- execution 仍沿用现有不可逆终态；禁止为了重试将 completed 改回 running。
- job/execution 关联在实际入队前持久化。
- 处理任务以 `execution + target` 唯一键认领。队列只是唤醒机制，DB 中的 pending/retry 状态可重新扫描。
- snapshot/change/notification intent 原子写入；每个逻辑结果有唯一键，重放不会复制快照或事件。
- 外部 AI/SMTP/HTTP/Redis 调用不放进持有数据库锁的事务。
- 同一 monitor/target 的基线提交有顺序约束；旧检查晚到不能覆盖新基线。

### 3.3 可比较数据与预览分离

- `contentHash` 可继续用于文本快速判断，但结构化数据独立比较。
- 内联正文限制只限制预览/响应体，完整比较数据通过现有可用存储后端保留；不能以增加截断上限作为最终修复。
- 全文存储或读取失败时，记录比较失败并保留健康基线，不静默按 same 处理。
- 配置快照记录 normalize/extract 版本，避免拿两种语义的内容直接比较。

### 3.4 通知按可重试意图投递

- change 与通知意图一起持久化；Webhook 和 Email 都有有限重试、失败记录与查询入口。
- `queued`、`delivered`、`failed`、`skipped` 有明确区别；不把 Redis 入队成功当作 Webhook 已到达。
- 初次入队和 retrying→pending 的两步提交需要 reconciliation，不能让 pending 永久失联。
- 交付保证为可恢复的至少一次尝试。Webhook 带稳定事件 ID；Email 可用稳定 Message-ID 减少重复，但不得宣称 SMTP exactly-once。

## 4. 实施前需要评审的行为选择

以下是有推荐值的明确决策项，不是留白占位。本轮不要求立即回答，也不会在未确认时执行这些行为变更；不受影响的隔离/驱动修复可单独实施。

| 决策 | 推荐 | 行为与兼容影响 |
| --- | --- | --- |
| D1 selector 语义 | 先保留 API 的字面文本行排除，修正 UI/文档；真 CSS 排除用显式新模式 | 保留已有调用行为；避免把旧字符串解释成 CSS 后意外删除正文 |
| D2 阈值和配置变更基线 | 阈值先保持相对上一次有效检查；修改目标、抽取 schema、比较模式或归一化规则后建立新版本基线 | 不追溯补发历史变化；若需要累计变化阈值，单独引入“上次告警基线” |
| D3 地域固定 | 只有代理路由和验收能证实固定出口才启用；此前 UI 明确不支持 | 不能只转发 country 字段；实际地域能力可能需要运营侧配置，不自动替换代理服务 |
| D4 AI 不可用/输入不完整 | 独立记录 `judgment_status=unavailable/incomplete`，默认不把未知判断成无变化；保留变化证据 | 是否立即告警还是延迟重试由通知策略决定；不得伪装为正常 meaningful/same |
| D5 通知状态和错误 Email | 增加细分通知状态；明确 failed-check 是否跟随 email channel；旧 notified 通过兼容期映射并标注语义 | 现有历史 boolean 无法逆推出真实送达；不能批量声称历史已投递 |
| D6 历史保留与完整正文 | 比较正文使用当前存储能力，配置明确的保留期；必要基线和 change 引用不随普通预览清理 | 历史已截断正文不可恢复；没有全文时重建基线，不制造缺失的历史 diff |

## 5. 修复批次与依赖

以下编号是建议的独立 PR/变更批次，不表示现在创建 PR。复杂度 S/M/L 为相对范围，非工期承诺。

| 批次 | 覆盖问题 | 复杂度 | 依赖 | 完成标志 |
| --- | --- | --- | --- | --- |
| S0 验证基线 | 测试缺口、Dashboard 类型检查阻塞、UI 截图/数据场景 | M | 无 | 固定现有缺陷的可重复回归条件，两个仓库的检查路径明确 |
| S1 所有者隔离与真实入队结果 | R01、R17 的错误计数 | S–M | S0 的针对性测试 | 无跨 owner 投递；queue.add 失败不报告入队成功 |
| S2 数据库兼容与配置原子性 | R02、R03、R13 | L | S0 | 两种数据库真实事务/CRUD/日期/通知查询通过 |
| S3 检查生命周期与调度规则 | R04、R05、R06、R07 | L | S2；owner 规则采用 S1 | 可恢复后处理、顺序基线、正确配额，故障注入通过 |
| S4 比较与基线正确性 | R08、R09、R10、R19 | M–L | S3 的处理状态；D2/D4/D6 | 文本/JSON/mixed、长文、无效抽取均有正确结果 |
| S5 API 有效配置与能力契约 | R11、R12、R14、R15、R16 | M | S2；D1/D3 | PATCH 无静默覆盖/丢字段；能力声明与行为一致 |
| S6 通知恢复与状态 | R17 的持久化恢复、R18 | L | S1/S2/S3；D5 | Webhook/Email 有意图、重试、可见失败，无 pending 失联 |
| S7 Dashboard 与 UI 正确性 | R20、R21、R22、R23；U01–U13 | M–L | 数据状态依赖 S4/S5/S6；视觉与键盘子批可在 S0 后独立进行 | 配置无损、状态准确、响应式/主题正确、导航与焦点可用 |
| S8 SDK、文档与发布验收 | R24、U14、DEV-01；O1–O9 的约定/验收 | M | 前述适用批次 | 示例/契约对齐、开发环境可启动、双 DB 和真实登录/浏览器验收、迁移/回滚记录 |

S1 隔离修复可作为独立优先补丁，不等待所有产品决策。后续不同批次可在接口定稿后独立开发，但不要为了并行而提前部署不完整的状态协议。

### S0：建立可重复验收基线

计划动作：

1. 将报告中的 E2 临时复现转为正式回归用例，使用真实 normalize/diff/Schema/controller 代码，mock 仅位于外部 I/O 边界。
2. 新增实际 PostgreSQL 与 SQLite 迁移后的集成测试，覆盖 async transaction、raw Date、JSON membership、状态/布尔字段读写。
3. 保留现有 Jest/Vitest 体系。查明 `.next` 路由类型与旧 scheduled-tasks 测试错误；不能通过排除失败文件来宣称类型检查通过。
4. 为本轮新增 R17/R20 回归保留“入队失败计数”和“复杂 schema round-trip”用例。

验收：缺陷用例先能稳定暴露当前行为，修复后才转绿；环境不可用必须单列阻塞，不能 mock 掉数据库后计为双 DB 测试通过。本轮文档工作没有执行这些新增测试/配置变更。

### S1：立即修复跨 owner 分发及错误成功计数

主要文件：`B/packages/scrape/src/managers/Webhook.ts`、`monitor/MonitorPostProcessor.ts`，以及所有 triggerEvent 调用点。

计划动作：使用完整 owner 进行订阅查询/筛选，更新调用参数；让 enqueueDelivery 返回可证明的结果或抛出错误；不要把查询/入队失败解释成“没有订阅”。

验收用例：

- 用户 A/B 隔离；同用户不同 key；API-Key-only A/B；托管空 owner；显式 auth-disabled 单租户。
- `scope=all/specific` 均不能越过 owner；change、check.completed、error 三类事件都覆盖。
- DB insert 失败/queue.add 失败/无订阅分别测试；只有实际入队才增加成功计数。

此批次解决错误计数，但 pending 投递的最终恢复仍由 S6 完成，发布说明不得把它称为完整通知可靠性修复。

### S2：双驱动兼容和 monitor/task 原子写入

主要文件：`B/packages/db/src/db/`、MonitorController、Scheduler/Webhook 的 DB 查询、`B/packages/db/drizzle/`。

计划动作：

- 在现有 DB 层封装真实兼容的事务接口；SQLite 使用其支持的同步事务执行，PostgreSQL 保持正确的异步事务边界。
- 用带字段编码的 ORM 比较替代直接 Date 插值，JSON 过滤采用明确方言实现。
- create/delete/update/pause/resume 涉及的 monitor/task 状态同事务提交；Redis 调度同步在事务外且能重试。
- 给 SQLite 补齐必要的 lookup 索引。新增迁移，禁止改写已经应用的迁移。

验收：两种数据库都从空库迁移，再从审查基线版本升级；在两张表之间注入失败，必须全部回滚。检查失败后不能有延迟写入。暂停后不能继续派发新检查；恢复后 cron/timezone 仍正确。

### S3：执行和后处理恢复协议

主要文件：Scheduler、ExecutionLifecycle、Base、MonitorPostProcessor、MonitorAccess，以及新增的持久化检查状态模型/迁移。

计划动作：

1. 入队前持久化 job/execution 关联；固定该次检查的 target 和 effective config。
2. execution 真实完成后持久化后处理意图；数据库终态与统计需避免部分提交。队列入队可补偿。
3. 后处理采用 lease/attempt 状态；成功提交 snapshot/change 后标记完成，失败保留错误与重试时间。
4. 同 monitor/target 串行提交基线；skip/queue/manual/catch-up 共用准入逻辑。queue 等待的范围必须覆盖真实抓取和基线处理。
5. 普通任务配额查询和后台 enforcement 都排除 monitorManaged；同 owner 的额度归属一致。

验收时序：

- Worker 在 Scheduler 返回前就完成抓取；jobUuid 仍始终可查。
- 入队前后、execution 终态后、snapshot 写入后、change 写入前后分别崩溃并恢复。
- 两个 worker 同时 claim；一个 lease 过期，另一个接管；结果最多一次提交。
- manual 与 cron 同时到达；跨 10 秒桶重复 manual；较旧检查晚到；长检查覆盖下一 cron。
- 额度为 1 的 owner 拥有多个 monitor 时，普通任务配额不能把 monitor 自动暂停。

### S4：比较与 AI 输入

主要文件：`monitor/normalize.ts`、`diff.ts`、`MonitorPostProcessor.ts`、`judge.ts` 和 snapshot 存储/读取模型。

计划动作：

- text 按文本比较，json 按结构化数据比较，mixed 合并两者；hash 仅作对应数据的优化。
- 完整正文持久化和比较，内联内容只作预览；明确大小/读取错误状态。
- 无效抽取在首次与后续检查都不能成为健康基线；首次有效数据才建 baseline。
- judge 同时收到文本和 JSON 差异；输入截断和服务不可用都记录状态。
- 按 D2 对配置变化生成新基线版本；不追溯伪造已有缺失的差异。

验收：相同 Markdown/不同 JSON、不同文本/相同 JSON、两者都变、尾部超上限变化、全 null 初次/恢复、合法空列表、阈值边界、mixed 文本噪声+真实价格变化、重要变化在 judge 输入尾部。不要只使用 `OLD_HASH` 常量模拟变化。

### S5：API、有效配置和能力提示

主要文件：MonitorSchema、MonitorController、Dashboard mapper/validation，以及公开 API 文档。

计划动作：

- 两阶段校验：PATCH 片段结构 → owner 读取 → effective config 校验。
- 统一生成 monitor 存储、task payload、执行配置快照和 credits 估算；null 与 omitted 不混淆。
- 校验 email 最终 recipients；所有 track_mode=json/mixed 均要求可用 schema。
- 明确 tags/metadata 和 monitor_type 等字段的支持情况，不接受后静默忽略。
- 按 D1 修正 selector 语义；按 D3 处理地域能力，不假装参数透传就已固定出口。

验收：仅修改一个嵌套字段不会重置兄弟字段；清空 goal 不会继续使用旧抽取 prompt；email 切换/清空合法性正确；创建与更新矩阵一致；GET 能反映有效执行配置。

### S6：可靠通知和可解释的送达状态

主要文件：WebhookManager、EmailNotifier、MonitorPostProcessor、DB 通知状态模型及读取 API。

计划动作：

- change/error 与通知意图一起写入；扫描并重试 pending/retrying 的可恢复记录。
- 引入稳定 event/intent ID，明确重试次数、attempt 和最终失败。
- Webhook HTTP 2xx 与 queue accepted 分开记录；SMTP partial acceptance 明确哪些收件人成功。
- Email 暂时失败可重试；失败检查是否向 email 发信按 D5 实现。
- 明确 paused/deleted monitor、失效订阅和历史重放的处理规则，避免批量重放旧告警。

验收：Redis 初次/重试入队失败可恢复；SMTP 临时失败后恢复；Webhook 接收端 500→200；全拒收/部分拒收；重复 queue job；最终失败可见；没有变化不发变更邮件。

### S7：Dashboard 功能、视觉和可访问性修复

主要文件：`D/apps/web/app/dashboard/monitors/`、BFF monitor routes、`components/monitors/`、mapper/types。

计划动作：

- 保留复杂 schema 的原始对象；用户没编辑时不得重新构造；mixed 不隐式转 json。
- 统一有效 active/paused 状态。恢复按钮直接 resume 自动暂停任务，区分 409 的错误码/原因。
- 刷新运行状态不覆盖草稿；error snapshot 不能提示检查成功。
- feed 增加可见页轮询/恢复焦点刷新或明确刷新按钮；请求以筛选版本隔离。
- 后端列表稳定排序，分页不以去重后的 UI 长度代替已消费服务端位置；推荐游标方案。
- 价格按 target/path/currency 分系列或选择单字段，明确当前是已加载变化点还是完整价格历史。

在以上功能修复之外，按如下 UI 子批执行；可以独立交付的共享样式/导航修复，不必等待全部后端状态协议完成。

| 子批 | 覆盖 | 计划改动 | 验收 |
| --- | --- | --- | --- |
| S7-A 主题与响应式 | U01–U06 | 调整可读的主题/语义色组合；修复重复 preflight 对 border token 的覆盖；按可用宽度折叠 header；约束标题/hash/骨架的收缩与断行 | 普通文字达到适用对比度；768px header 不撑到 837px；390px 长名称不撑到 3403px；快照抽屉无整层横向溢出；320px skeleton 不撑宽 |
| S7-B 名称、语义与键盘导航 | U07–U09、U11 | 连接 label/id；给动态输入/图标按钮命名；类型卡片提供选中语义；面包屑用真实 href；将监控链接和 diff 展开拆成独立交互并提供展开状态 | Tab/Enter 可完成导航；AX 名称/选中/展开状态明确；无 button 内嵌 link |
| S7-C 焦点与手机流程 | U10、U12、U13 | 关闭浮层恢复触发焦点；校验失败聚焦首错；换步重设阅读位置；手机导航选中后关闭并提供抽屉标题/关闭入口 | Escape/Cancel 后不落到 body；新步骤标题/首字段可见；地址变化后侧栏不继续遮挡页面 |
| S7-D 视觉回归 | 全部 U01–U13 与 R20–R23 | 固化合成数据、尺寸/主题和状态截图；对实际浏览器交互增加相应用例 | 复现截图可对比；空态/错误/Retry 通过项保持；共享组件变化覆盖其他 Dashboard 页面 |

主要样式源除监控组件外还包括 `D/packages/ui/src/styles/globals.css`、`D/apps/web/app/globals.css`、Dashboard header/sidebar 和通用 button/sheet/breadcrumb。修复共享层时，不能只观察一个监控页面就宣称全站无回归。

验收：对象数组 schema 打开再保存无损；自动暂停→单次恢复；迟到的旧 filter/loadMore 响应；分页过程中有新增事件；断网后恢复；价格多套餐不同货币；键盘展开 diff 和深链接。视觉矩阵至少包含 320/390/768/820/1024/1440px、Light/Dark、最长标题/hash、loading/empty/error、侧栏展开/折叠和浮层焦点。

### S8：SDK、文档和最终验收

计划动作：SDK 补 snapshot detail 和跨 monitor feed，拆分 list/detail 类型、修正更新字段；公开中英文文档、内部 API/接入指南和真实行为同步。新字段采用兼容的发布方式。

同时修正 Price Monitoring 页面 Copy 示例：email channel 必须有合法 recipients（U14），并用真实 create schema 验证所有公开样例。修正开发登录无配置时的无效默认 project ID（DEV-01），分别验收“无真实凭据的本机开发登录”与“真实浏览器登录回跳”，不能将两者混为一项通过。

验收：真实双 DB × API/Scheduler/Worker 分进程的闭环；浏览器 UI 流程；完整必要构建/类型检查；故障恢复；代表性数据量的查询和正文存储压力测试。

不能因为单元测试通过就跳过真实 DB/队列验收，不能用更换数据库或丢弃失败用例替代。

## 6. 回归矩阵

| 维度 | 必须包含的组合 |
| --- | --- |
| owner | user、同 user 多 key、API-Key-only、多租户、显式单租户无鉴权 |
| DB | PostgreSQL/SQLite；空库迁移/基线升级/中途回滚 |
| 部署 | API/Scheduler/Scrape 分进程；一个/多个 worker；重启恢复 |
| 调度 | cron/manual/catch-up；skip/queue；暂停/自动暂停；时区；额度边界 |
| 内容 | text/json/mixed；首次/相同/变更；失败/恢复；空数据；长文尾部；复杂 JSON |
| 配置 | partial PATCH；null/omitted；模式/schema 修改；地区/排除能力提示 |
| 通知 | webhook/email/两者/无；无订阅；入队失败；投递失败；partial acceptance；重复处理 |
| Dashboard | 列表/详情/Changes；刷新；分页+新事件；乱序响应；无损编辑；自动暂停；多价格字段 |
| 视觉/可访问性 | 320–1440px；Light/Dark；长内容；实际 CSS 对比度；键盘导航/选中/展开；错误焦点；浮层焦点恢复；手机侧栏 |
| 性能 | 快照增长、全文读写、单页/全局 change 查询、并发 diff CPU/内存 |

## 7. 数据迁移、发布和回退

以下也是计划，当前没有对任何数据库执行这些操作。

1. **新增结构优先兼容旧读路径。** 新状态/引用字段允许旧记录保持 legacy；新索引/唯一键前先检查重复记录，不直接删除历史。
2. **明确历史不可恢复部分。** 截断正文、没有 change 的历史事件和旧 notified boolean 不能通过脚本猜测还原。保留原始记录，标记未知，必要时建立新 baseline。
3. **先部署兼容读取，再启用新生产路径。** 新的持久化后处理/通知有明确 producer ownership，避免新旧 Worker 同时产出同一次结果。
4. **不要自动重放历史邮件/告警。** 恢复只针对明确未完成且在允许窗口内的意图；历史补发需单独审核范围。
5. **监控运行指标。** 待后处理数、最老 pending 时间、失败/重试数、check→snapshot 延迟、通知最终失败数、每监控存储增长、重复事件数。
6. **按阶段回退。** 关闭新 producer 并保留 DB 意图，不删新增表/历史状态；旧 Worker 未理解的新格式不强行交给旧 Worker。隔离修复和数据兼容修复不应随 UI 回退一起撤销。

## 8. 完成标准

- R01–R24 均有对应修复或明确、经评审的兼容处理，不以文档标注替代已经承诺的核心能力。
- R01/R02/R03/R04/R08 对适用部署的阻塞已经消除，并有真实依赖验证。
- 崩溃后检查能恢复；同一逻辑检查不会重复提交；失败不会悄悄推进基线。
- 需要通知的变化不会因为暂时入队/发送失败而永久失联；最终失败可查询。
- Dashboard 可以准确解释 active/paused/in-flight/error、配置保存和通知状态。
- U01–U14 有对应修复与浏览器证据；布局、主题、语义和焦点回归通过，已有可用空态/错误态保留。真实登录/真实设备与模拟环境结论分别记录。
- 双数据库迁移、类型检查、既有回归、新增缺陷回归和全链路验收均通过，未通过项有真实原因，不能替换验证口径。
- 历史迁移、基线重建、通知兼容和回退步骤经过审核，实施授权与文档评审分开。

## 9. Docs consulted

- [完整审查报告与全部源码证据](./web-change-monitoring-review-2026-09-06.md)
- [UI 专项审查与实际截图](./web-change-monitoring-ui-review-2026-09-06.md)
- [Monitors API](../api/monitors-api.md)
- [Monitors Dashboard Guide](../api/monitors-dashboard-guide.md)
- [Scheduled Task Execution Lifecycle](../scheduled-task-execution-lifecycle.md)
- [Scheduled Tasks API](../api/scheduled-tasks-api.md)
- [Webhooks API](../api/webhooks-api.md)
- [Cache](../cache.md)
- [Jest Config Guide](../jest-config-guide.md)
- [AI Config](../ai-config.md)

方案取舍参考本会话的 brainstorming 技能；用户要求是先审查和形成计划，因此这里只提供待评审方案，没有执行技能中后续的实现、提交或部署步骤。
