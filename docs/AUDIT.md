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

应用层 `VoiceSessionStore.commit` 只原子保存快照和带身份的 outbox，不操作
实时连接。命令显式调用 `SessionLifecycle.persistAndDispatch`，保存后由
`RelaySessionOutbox` 调用独立的 `DisconnectEventHandler` 与发布端口。
轮次和工具结果直接作为业务审计事件发布，不再生成结算 ID、usageUnit 或 usageDelta。

每个订阅者有稳定名称和持久化的事件确认记录。某个订阅者失败不阻止其他订阅者
执行；重启后只重试未确认的投递。副作用成功而确认写入失败时仍可能重投，接收方
必须按稳定 `eventId` 幂等。SQLite 审计 sink 按事件 ID 去重；不承诺
跨系统 exactly-once。仅所有订阅者均确认后清空 outbox，维护服务自动重投，待投递
记录不会被会话保留清理删除。Node 可通过 `createServer({ subscribers })` 注入持久
sink，但默认会话和 outbox 仍是进程内存。

指标测量使用独立 telemetry 端口，不作为持久业务审计的一部分。

SQLite 初始化时将旧 `voice_audit_settlements` 的去重用途迁移为
`voice_audit_deliveries`，从保留的审计行恢复 eventId，再删除旧索引表。
历史审计正文保持不变，新事件不包含结算字段。
