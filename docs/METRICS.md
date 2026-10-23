# 语音指标

Node 与 Cloudflare 都通过事件订阅者输出 JSON 指标行。日志级别为 `info` 或 `debug` 时启用，筛选 `metrics: true`：

| metric | 字段 | 含义 |
|---|---|---|
| `turn.completed` | `toolCalls` | 本轮经过策略审查的调用数，包括被拒绝或要求确认的调用 |
| `turn.telemetry` | `modelToolCalls` | vRealTime 在当前 epoch 接收的完整调用数，在策略审查和执行之前计数，包含随后被拒绝或取消的调用 |
| `turn.telemetry` | `interrupted` | 本轮是否被打断；用于区分正常结束但未调用工具与语音/用户打断，不能单独证明声学回声 |
| `turn.telemetry` | `timeToFirstAudioMs` | 用户语音结束至第一段模型音频，存在时才记录 |
| `turn.telemetry` | `timeToFirstToolCallMs` | 用户语音结束至首次工具调用，存在时才记录 |
| `turn.telemetry` | `interruptLatencyMs` | vRealTime 收到中断至本地关闭播放/执行闸门，不是远端取消耗时 |
| `tool.reviewed` | `tool`、`risk`、`decision`、`code` | 审查结果：allow、deny、confirm |
| `tool.completed` | `tool`、`ok`、`code` | 执行结果，包括失败、中断、超时 |

每条记录带 `sessionId`、`turnId`、事件时间与 `count: 1`；工具记录还带 `callId`。按 session/turn 关联，按 metric 和 decision/ok 聚合。缺失时延不会写成零；非有限、负数或非法调用数量会被移除。文本输入通常没有语音结束时间，因此可能只有工具数量而没有首音频时延。

指标只包含明确列出的标识、分类与数值，排除文档、参数、输出、转写与异常正文。`TurnCompleted` 只携带业务轮次 ID 与审查调用数。实时适配器把提供方测量清洗为
独立 `TurnTelemetry`，直接送到 telemetry 端口；它不进入领域聚合或会话 outbox，
不进入持久审计。延迟记录使用 `turn.telemetry`，按 session/turn 与 `turn.completed`
关联，避免把两种记录的 `count` 相加。遥测为尽力上报，故障不会阻止业务轮次完成。

没有新增 Analytics Engine、供应商 API 或指标服务器。需要远端聚合时可消费 JSON 日志，或通过 `telemetrySubscribers` 注入自己的测量 sink；业务事件仍使用 `subscribers`；本地 fake 模型的测量不代表真实供应商性能。

## 排查重复应答、未写入

按同一 `sessionId`、`turnId` 对照以下事件，不要把口头承诺当作写入成功：

- `modelToolCalls: 0` 且 `interrupted: false`：模型没有发出完整工具调用。SDK 会结束纯语音回复，不会自动接着执行“我来写”的承诺。提示词允许直接调用工具，开场应答仅为可选。
- `interrupted: true` 或工具结果 `INTERRUPTED`：检查语音打断。麦克风 SDK 请求了回声消除，但扬声器回录仍需在真实设备上验证；耳机与外放对照可帮助定位。此标记也包括正常用户打断。
- 只有读取工具：模型读取后没有提交写入；有 `apply_document_operations` 才进入写入链路。
- `tool.reviewed` 为 `deny` / `confirm`：策略拒绝或等待用户确认；`tool.completed` 的 `ok: false` 则查看失败码（如 `FAILED`、`TIMEOUT`）。

模型上下文来自内置 editing-assistant 指令与清洗后的标题、语言；vocabulary 是转写提示。文档正文通过读取工具获取。当前没有自动加载 SKILL.md 的机制；工具说明与 JSON Schema 由浏览器在 hello 中提供，再由 SDK 注入模型。服务端允许的 5 个工具包括 `apply_document_operations`，足以执行文档写入。根目录 `tools/` 的 15 个分类工具是尚未接入的另一套适配层；仅把文件合并进仓库不会注册它们，也不会更新白名单或风险分类。

开发环境未选择真实模型时会使用 fake 回声模型，它只复述输入，默认不会写入；生产配置禁止 fake。自动化测试使用脚本模型验证传输、工具链及中断，不证明真实 Boson 一定遵循提示词，也不能重现声学回声。生产故障归因仍需上述事件与真实设备复现。
