# 持久审计

Cloudflare 的每篇文档房间把领域事件写入已有 SQLite 数据库的 `voice_audit_events` 表，同时保留 JSON 审计日志；不需要额外队列、数据库或绑定。表按会话与递增序号索引，对象重建不会丢失记录。

具有 `VOICE_ROOMS` 绑定的内部 Worker 可以通过 RPC 分页查询：

```ts
const room = env.VOICE_ROOMS.get(env.VOICE_ROOMS.idFromName(documentId));
const page = await room.auditEvents(sessionId, 0, 100);
// page.events: [{ sequence, event }]
// page.nextCursor: 下一次查询的 after 参数；page.hasMore 表示还有下一页。
```

每页 1–200 条，游标是非负安全整数。这个 RPC 不经过公开 HTTP 路由，调用方必须能访问对应的内部绑定；如果以后增加对外查询接口，需要单独实现用户鉴权和会话归属检查。

记录经过字段白名单投影，保留事件类型、时间、会话/文档/主体标识、工具名称与结果、风险与决策、操作类型和数值用量。未知事件只保留基本元数据，未知字段不会自动进入存储。文档正文、标题、工具参数/输出、模型文本、异常消息和确认指纹均不保存。

默认保留 30 天，从写入时间计算；每次写入或查询清理过期记录。没有新访问时清理不会主动唤醒房间，因此物理删除可以延迟。这个保留窗口独立于会话快照的 7 天窗口。

同次 `publish()` 的事件在 SQLite 事务中写入，失败会传播到调用方；会话结束时即使订阅者失败仍会断开实时连接。会话快照保存与事件发布仍是两个提交，不承诺崩溃窗口内的事务性 outbox、自动重试去重或 exactly-once。Node 部署可通过 `createServer({ subscribers })` 注入自己的持久 sink。
