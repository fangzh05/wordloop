# Capture 笔记复习 MVP

本功能在现有 Capture/划词笔记内部提供独立的「笔记复习」入口，不新增顶层导航，也不改变「加入学习」的行为。只有用户显式点击加入、且笔记状态为 `inbox`/`saved`、尚未转换为词库词条、`我的理解` 非空时，笔记才会进入复习候选。

## 状态边界

- 复习状态只存放在 `note_review_states`，评分审计与幂等结果只存放在 `note_review_events`。
- 归档、转换或清空理解会让候选查询暂时隐藏条目，但不会删除 Card 或复习事件；恢复资格后沿用原来的 schedule。
- 首次启用由服务端用 `createEmptyCard(now)` 建立 immediate-due Card；停用只切换 `enabled` 并递增 revision，重复启用不会重置 Card。
- 服务端用现有 `createFsrsScheduler()` 和 `ratingMap` 调度，Web API 不接受客户端 Card 或 user identity。

## Web API

- `GET /api/web/note-reviews`：返回最多 10 条 due 候选以及 total。
- `PUT /api/web/captures/:id/note-review`：strict body `{ enabled }`。
- `POST /api/web/captures/:id/note-review/ratings`：strict body `{ rating, expected_revision, expected_note_updated_at, idempotency_key }`，只允许 `again`/`good`。

评分 RPC 对 note、state 加锁，校验 revision、note `updated_at`、due、资格与幂等 payload；冲突返回可识别的 409 错误，重复 key 返回已保存结果。前端在揭示前只渲染 `selected_text`，揭示后才渲染理解和最近上下文/来源，并只提供 Again/Good。

## 发布与回滚

本轮只提交源码、迁移和本地验证，不执行生产迁移或 Site 发布。新数据库可执行 `supabase/migrations/202610020001_note_review_states.sql`；已有数据库应按顺序执行缺失迁移，并运行 `npm run check:db`。

回滚应用时先恢复不再访问笔记复习 API 的旧应用版本；不要在仍有应用实例运行时删除两张新表或 RPC。确认无旧/新实例需要该功能后，再由数据库维护窗口处理对象清理。迁移本身不删除既有 Capture、词库、队列、尝试、FSRS 或 study session 数据。
