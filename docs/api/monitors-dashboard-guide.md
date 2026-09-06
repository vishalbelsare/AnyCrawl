# Monitors Dashboard 接入与交互契约

Dashboard 通过带会话的 BFF 访问 AnyCrawl REST API。API key 保留在服务端。端点与校验以 [Monitors API](./monitors-api.md) 为准。

## 页面与状态

- `/dashboard/monitors`：所有者范围的监控列表，按类型及有效运行状态筛选。
- `/dashboard/monitors/new`：目标/频率与通知两步向导。切换步骤滚动并移动阅读焦点；失败定位字段或错误摘要。
- `/dashboard/monitors/:id`：概览、changes、snapshots、price、settings。
- `/dashboard/monitors/changes`：跨监控变化 feed，独立的监控链接与 diff 展开按钮。

有效运行状态为 `is_active && !is_paused`。自动暂停显示 `pause_reason`，恢复按钮直接 resume，不能先 pause 再 resume。运行中的 check 看 `in_progress`，最近处理结果看 `last_check_state` / `last_check_error` / `last_check_at`；`last_execution_at` 只是调度执行时间。

`POST /check`：202 表示入队；409 的 code 区分 MONITOR_PAUSED 与 MONITOR_CHECK_IN_PROGRESS；503 表示没有 scheduler consumer。error snapshot / failed check 不可提示“检查成功”。等待超时只结束本地等待，不改变服务器状态。

## 编辑与校验

- 顶层 API 字段 snake_case，经 mapper 转 camelCase；用户 JSON 内部键原样保留。
- PATCH 片段与最终配置分别校验；未提交的字段保留，goal=null 清除旧提示词。
- price、json、mixed 都需要 schema。混合模式保存后仍是 mixed。
- 简单字段构造器只处理能无损重建的 schema。含对象数组、required、enum、additionalProperties 等额外结构时显示原始 JSON 编辑器；没编辑就不发送 extractSchema。
- notifyOptions 按字段合并；email 开启时最终 recipients 非空且最多 20。每个收件人单独追踪送达。
- ignore_selectors 是“排除包含这些字面短语的文本行”，不是 CSS；UI 文案与示例使用文本短语。
- 固定 country routing 不可用，不能显示为生效能力。现有 location 元数据在无关 PATCH 时保留；用户重新编辑目标时只发送当前支持的配置。
- 每次只监控第一个 target；这项限制必须在设置中明确。

## 刷新与分页

详情页空闲 45 秒刷新，运行时 5 秒刷新；列表 30 秒刷新。feed 提供刷新按钮、45 秒轮询及恢复焦点刷新。后台标签页暂停轮询。状态刷新不覆盖 settings 草稿。

列表请求失败保留已有数据并显示“刷新失败”的状态。切换 feed 筛选或卸载时取消请求，并用请求代次阻止迟到响应覆盖当前数据。首次页面加载与后续加载有独立状态。

snapshot/changes/feed 用 `{data, pagination:{has_more,next_cursor}}` 游标。游标来自服务器已消费的位置，不能拿去重后 UI 数组长度充当 offset。feed 无重 diff；详情 changes 使用 include_diff_text=false，展开时取单条完整 diff。snapshot 列表无正文和 extracted；打开抽屉时获取预览详情，并显示 content_truncated。

## 变化、通知与价格图

- notified 只说明新记录至少一个渠道实际送达；细分状态用 notification_status，投递错误与每收件人状态从 change detail.notifications 或 notifications 端点读取。
- legacy 的历史 boolean 无法逆推出 SMTP/HTTP 结果，明确标成历史标记。
- AI meaningful=null、status=unavailable/incomplete 时显示未知状态与原因，不能显示为明确 meaningful/same。
- 价格图只表示已加载的变化点；按 URL + path + currency 分组。无法证实货币的历史记录显示独立点，不连接为同一价格曲线。
- 概览计数标为“已加载”范围，不能伪装为完整历史统计。

## 样式、导航与焦点

共享 Tailwind reset 和主题由 packages/ui/src/styles/globals.css 单独提供。app/globals.css 只放应用自有规则，避免第二次 preflight 覆盖暗色边框。普通文字对比度目标 4.5:1；delta 同时保留正负号。

至少覆盖 320、390、768、820、1024、1440px 和 Light/Dark。长 monitor name/hash/JSON 不能撑宽页面；表格和代码的局部滚动不得变为整页横向溢出。

label 关联真实输入，图标按钮有名称，类型卡片暴露选中状态，diff 按钮有 aria-expanded/aria-controls。breadcrumb 使用可键盘访问的 href。手机侧栏有名称与关闭入口，导航后关闭。Snapshot/Delete 浮层取消或 Escape 后回到触发控件；字段错误聚焦首错或可访问摘要。

## 开发与验证

开发登录仅在非 production 且 ANYCRAWL_DASHBOARD_DEV_AUTH=1 时启用，使用合法格式的测试 project UUID。真实 API key 仍只留在服务端。此登录路径不能被当作真实 Hexclave 登录回跳已经验收的证据。

现有 Vitest/Testing Library 覆盖 schema round-trip、自动暂停、价格系列和请求状态。旧 scheduled-tasks CRUD 测试已迁至实际 API 客户端，需显式配置 ANYCRAWL_MONITOR_TEST_API_URL 指向隔离本机 API；缺少环境直接失败，不能改用模拟数据库声称通过。
