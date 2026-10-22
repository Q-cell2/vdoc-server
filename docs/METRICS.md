# 语音指标

Node 与 Cloudflare 都通过事件订阅者输出 JSON 指标行。日志级别为 `info` 或 `debug` 时启用，筛选 `metrics: true`：

| metric | 字段 | 含义 |
|---|---|---|
| `turn.completed` | `toolCalls` | 本轮经过策略审查的调用数，包括被拒绝或要求确认的调用 |
| `turn.telemetry` | `modelToolCalls` | vRealTime 在当前 epoch 接收的完整调用数，在策略审查和执行之前计数，包含随后被拒绝或取消的调用 |
| `turn.telemetry` | `timeToFirstAudioMs` | 用户语音结束至第一段模型音频，存在时才记录 |
| `turn.telemetry` | `timeToFirstToolCallMs` | 用户语音结束至首次工具调用，存在时才记录 |
| `turn.telemetry` | `interruptLatencyMs` | vRealTime 收到中断至本地关闭播放/执行闸门，不是远端取消耗时 |
| `tool.reviewed` | `tool`、`risk`、`decision`、`code` | 审查结果：allow、deny、confirm |
| `tool.completed` | `tool`、`ok`、`code` | 执行结果，包括失败、中断、超时 |

每条记录带 `sessionId`、`turnId`、事件时间与 `count: 1`；工具记录还带 `callId`。按 session/turn 关联，按 metric 和 decision/ok 聚合。缺失时延不会写成零；非有限、负数或非法调用数量会被移除。文本输入通常没有语音结束时间，因此可能只有工具数量而没有首音频时延。

指标只包含明确列出的标识、分类与数值，排除文档、参数、输出、转写与异常正文。`TurnCompleted` 只携带业务轮次 ID 与审查调用数。实时适配器把提供方测量清洗为
独立 `TurnTelemetry`，直接送到 telemetry 端口；它不进入领域聚合或会话 outbox，
也不触发结算。延迟记录使用 `turn.telemetry`，按 session/turn 与 `turn.completed`
关联，避免把两种记录的 `count` 相加。遥测为尽力上报，故障不会阻止业务轮次完成。

没有新增 Analytics Engine、供应商 API 或指标服务器。需要远端聚合时可消费 JSON 日志，或通过 `telemetrySubscribers` 注入自己的测量 sink；业务事件仍使用 `subscribers`；本地 fake 模型的测量不代表真实供应商性能。
