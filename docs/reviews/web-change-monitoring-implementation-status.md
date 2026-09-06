# Monitoring 修复状态

2026-09-06：本轮修复已完成，覆盖此前审查的 R01–R24、U01–U14、DEV-01。完整映射、验证和发布顺序见 [修复与验收](./web-change-monitoring-fix-validation-2026-09-06.md)。没有 commit、push、部署或重放生产历史告警。

**后续交付状态：** 上述为本地验收时的记录。后端已提交并推送至 dev，PR #99 待合入 main；Dashboard 已直接推送 main。后端 Docker amd64 与 Vercel 暴露出测试直接依赖遗漏，发布构建验收未通过，详见 [CI 错误审查](./pr-99-ci-errors-2026-09-06.md)。本地 E2E 结果保留，不能替代干净安装与镜像验收。

## 实现

- owner 隔离、SQLite/PG 事务和迁移兼容、job/check 原子关联、持久化 lease/重试、串行检查、普通任务配额排除。
- 有效 PATCH、schema/recipients 校验、null 清除、配置 revision、完整正文与预览分离、首次有效基线、AI 未知状态。
- Email/Webhook 持久化意图、实际送达语义、稳定 ID、初次/重试队列恢复、失败及历史查询、opt-in 保留清理。
- 无效历史配置仍可暂停；Scheduler 暂停缺少 monitor 的孤立任务和 inactive monitor 的不一致任务，不再派发隐藏检查。
- UI 明暗主题、响应式、长内容、标签、导航、浮层/表单焦点、复杂 schema/mixed 保留、运行状态、游标/乱序刷新、价格系列、公开示例与能力说明。
- 显式本地 dev 身份不启动远端 Auth SDK；production 开关不能绕过鉴权；正常 Dashboard 保留 SDK 用户订阅。
- SDK 方法/类型及内部、公开 EN/ZH 文档已同步。

## 最终验证

| 范围 | 结果 |
| --- | --- |
| libs | 103 tests 通过 |
| db 单元/原有回归 | 118 tests 通过 |
| scrape | 183 tests 通过，原有 opt-in 3 tests 未启用 |
| JS SDK | 129 tests 通过 |
| Dashboard | 119 tests 通过，含真实本机 API CRUD |
| 双 DB 工作流 | SQLite 13 / PG 13，通过真实迁移、事务、配置、计费、游标、通知与保留规则 |
| 双 DB 传输 | SQLite 4 / PG 4，真实 Redis、SMTP、HTTP |
| 分进程 | SQLite / PG 均通过，含 queue、实际进程崩溃恢复、6 个完成检查、owner、额度、删除及历史暂停保护 |
| 构建 | 后端 libs/db/scrape/api/SDK；Dashboard production；公开 docs production（330 页）均通过 |
| 浏览器 | 320/390/768/820/1024/1440 × Light/Dark；创建到 new 基线、schema 实际保存、50→57 游标、价格分组、焦点、公开/共享页头验证 |
| 示例 | 5 个公开创建示例由实际 createMonitorSchema 校验通过 |

API 包另有 66 tests 通过、原有 17 live tests 未启用；3 个依赖固定 8080 与外部抓取/浏览器/搜索/LLM 的 live suites 共 20 tests 没有通过。沙箱连接先 EPERM，批准只读联网后 8080 health 仍无响应。这一限制已保留，未替换为 mock 或宣称全部 API live tests 通过。真实第三方登录回跳/外部 AI 服务质量不计作本地验证结果。

## 运行与清理

- 开始前的未提交修改备份：`/private/tmp/anycrawl-monitor-fix-baseline-rxnmdd9u`。用户原有业务修改保留，Next 自动重建了路由类型/next-env。
- SQLite 最终 harness：`/private/tmp/anycrawl-monitor-system-sqlite-1788691850788`；PG：`/private/tmp/anycrawl-monitor-system-postgresql-1788691859287`。核心结果已复制到文档 assets；manifest 中只有隔离测试凭据，未复制到验收文档。
- 临时 UI：`/private/tmp/anycrawl-ui-review-yeg5bryo`，仅连接本次本机服务；浏览器测试标签已关闭、viewport 已 reset。
- 已确认停止本次 harness/Next 进程和 `anycrawl-monitor-fix-pg`、`anycrawl-monitor-fix-redis` 两个临时容器；未对既有 SourceWeft 服务执行停止操作。
- 新迁移：PG 0026；SQLite 0021/0022。生产应用顺序与回退限制见验收文档；本次仅迁移隔离测试库。
