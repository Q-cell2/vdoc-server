# ADR 0004：每篇文档一个 Durable Object

状态：已采纳（2026-10-16）

## 背景

同一篇文档的会话需要串行处理（并发策略、限额计数），实时连接断线后要能续传到同一个内存中的会话。

## 决定

Worker 把 `/v1/documents/{documentId}/…` 下的所有请求转发给 `idFromName(documentId)` 的 Durable Object。会话存在这个对象的存储里，实时会话存在它的内存里。

## 结果

- 同一文档的完整应用命令通过串行队列执行，覆盖签名、鉴权等外部 await。
- 断线重连落到同一个对象，可以续传。
- 跨文档的并发和每小时创建次数由另一个按 principal ID 路由的 `PrincipalQuotaRoom` 原子维护，
  见 [跨文档配额](../PRINCIPAL_QUOTAS.md)。
