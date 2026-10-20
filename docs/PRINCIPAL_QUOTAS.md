# 跨文档的 principal 配额

配额以可信鉴权结果的 `PrincipalId` 为键，不使用浏览器传入的用户或文档上下文。
vdoc 的 BFF 在 client key 之外带上 `X-Vdoc-User-Id` 时，鉴权返回由 client ID 与用户 ID 派生的用户 principal，
每个登录用户跨文档单独计数（#4，见 [可信用户身份](TRUSTED_USER_IDENTITY.md)）。只有
`VDOC_SERVER_ALLOW_CLIENT_ONLY=true` 时，不带用户头的请求才返回 client principal，同一 client key 的全部文档共享计数。

## 规则

- `VDOC_SERVER_MAX_CONCURRENT_SESSIONS_PER_PRINCIPAL`：默认 3，正安全整数。
  包括 `granted` 和 `active` 会话；所有结束原因均释放并发名额，重复结束幂等。
- `VDOC_SERVER_MAX_SESSIONS_PER_HOUR`：默认 60，正安全整数。计算滚动的过去一小时内
  新建会话数，精确到毫秒。在窗口边界移除旧记录；结束会话不退还次数。
- 续签和重连更新原会话的租约，不增加次数。未连接的租约随连接期限到期；
  连接后的租约随最长会话时长到期。即使文档对象不再被访问，也不会永久占用名额。
- 超限返回 `QUOTA_EXCEEDED`，HTTP 429、`Retry-After: <秒数>`。等待值向上取整，
  同时考虑并发和频率限制；仍可能因其他请求或续期而延长。
- 单文档 `reject` 仍返回 `DOCUMENT_BUSY` / 409。`supersede` 可在并发已满时替换同一
  principal 的原会话，但新会话仍消耗一次频率额度。配额拒绝不会结束原会话。
  其他 principal 的会话不提供替换额度。

## 存储与故障

Worker 的 `DocumentVoiceRoom` 通过绑定 RPC 访问 `idFromName(principalId)` 对应的
`PrincipalQuotaRoom`。配额读取、判定、保存及 alarm 在同一个持久化事务内执行，
因此不同文档的并行申请不能突破限制。Alarm 回收过期租约和超过一小时的创建记录，
无剩余记录时删除状态和 alarm。计数在 Worker / Durable Object 重启后保留。

配额在签名成功后、保存新会话或延长期限之前预留。鉴权失败、单文档冲突、签名失败
不扣次数。全局存储故障不会回退到内存放行。预留后如文档存储发生不明确的故障，
保守保留预留和频率记录，避免已写入的会话逃过限制；并发租约到期后会回收，频率
记录一小时后回收。会话已结束但事件订阅器失败时，仍尝试释放名额并关闭实时连接；
释放失败可通过重复 DELETE 重试，也会随租约到期回收。

Node 使用进程内的原子配额存储，与 Worker 共用领域策略。Node 重启会清空计数，
多个 Node 进程不共享计数；多实例部署需注入统一的 `PrincipalQuotaStore`。

## 部署

保留 `DocumentVoiceRoom`、`VOICE_ROOMS` 和原 `v1` migration。
两份 Wrangler 配置新增 `PRINCIPAL_QUOTAS` 绑定及 `v2` migration，创建 SQLite-backed
`PrincipalQuotaRoom`。生产和 Preview 均声明新绑定；Preview 使用独立命名空间。
不需要外部数据库。调整限额时通过环境变量配置，并保持两个入口及 Preview 配置一致。

已有会话在下次续签或连接时登记租约；新创建会话立即受限。

## 验证

`npm run check` 覆盖领域窗口边界、幂等续签、替换与拒绝、应用结束路径、Node HTTP 429，
以及真实 workerd 中跨文档并发和持久化重启。`npm test -w @vdoc-server/app-worker`
进一步通过 `wrangler dev --local` 验证生产绑定、DELETE 释放名额和每小时次数仍受限。
