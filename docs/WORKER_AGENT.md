# Higgs performer + Pi worker agent

## 角色与部署

`VDOC_SERVER_MODEL=boson-worker` 把 Higgs Realtime 变成没有工具的前台：它只负责听（语音识别、判断说完）和说（朗读 Pi 的回复）。
是否执行、执行什么不由 Higgs 决定：服务端拿到用户的最终转写或打字输入后直接启动 Pi。
后台使用固定版本 `@earendil-works/pi-agent-core` / `pi-ai` 1.4.0，默认 Claude Haiku 5.5，思考关闭。
同时存在 Boson 与 Anthropic 密钥、且未指定模型时，此模式为默认。显式 `boson` 保留旧模式。
Node 需要 22.19+；Cloudflare 复用同一模型适配器，密钥来自 Worker Secrets。

这里的 worker 是逻辑后台 agent，不是新建操作系统线程或单独一个 Cloudflare Worker。
它异步运行在当前文档房间中，通过 HTTP 流访问文字模型。无需 Python、Pi CLI、shell 或文件工具。
任务结束后销毁该次 Pi agent，保留最近 8 次请求和简短结果作为后续上下文，不保留跨任务的整篇文档。

## 执行路径

```text
用户语音 → Higgs 识别 → 最终转写（或打字输入）
                 ↓ Server 直接启动 Pi（Higgs 自己生成的回复一律取消、不播放）
               Pi Agent 自主循环
                 ↓ 实际工具调用事件
               vRT → Server 权限/预算/确认 → vdoc 原有工具
                 ↑ 真实工具结果
               Pi → 最终短回复 → Server 让 Higgs 逐字朗读
```

Pi 是唯一的后台循环负责人。组合模型声明工具结果后自行续生成，vRT 不再额外请求一轮；
但它仍然追踪每个 Pi 轮次和真实工具调用，保持已有幂等 ID、取消、审查和客户端超时。

启动 Pi 之前，Worker 先通过同一条 `execute` 通道依次调用 `read_document` 和 `get_context`（`VDOC_SERVER_WORKER_PREFETCH`，默认开），结果放进任务信封的 `document` 和 `context` 字段，系统提示词说明可直接使用，省掉模型自己先读的请求（只预读文档时，本地压测每个任务约省 0.7–1.1 秒）。
`get_context` 也要预读：vdoc 的编辑规则要求编辑前读上下文，续写还要用它独有的 `recentEdits`，只预读文档时 Pi 仍可能先花一轮模型请求去调 `get_context`。它给出的选区按当前轮冻结，所以预读结果在整个任务内有效。
预读和 Pi 自己读一样经过治理审查和审计，每项占用每轮工具调用次数的 1 次，并计入后台工具结果字符预算。某项被拒绝、失败、累计超过 100000 字符或客户端没有声明该工具时，信封里不带这一项，Pi 照旧自己读。
没有前台委派这一步，所以不存在“Higgs 没有及时委派”的失败（原 DELEGATION_TIMEOUT / ACTOR_DELEGATION_FAILED）。
只剩转写本身：语音结束后 15 秒仍无最终转写，报 TRANSCRIPTION_TIMEOUT。空白转写视为噪音，直接结束本轮。
未修改 vRT 或 vdoc 源码。

前台在后台完成前生成的语音被抑制；不允许前台工具直接访问文档，也不向它发送文档工具定义和工具结果。
最终服务端向前台发一条“请逐字朗读下面这句话，不要添加任何内容：<回复>”的消息并请求回复。
实测真实 Boson 会逐字朗读这条消息（中英文、疑问句、长句均逐字），而单次回复附带的 instructions 会被它忽略。Realtime 模型的逐字忠实度仍需真实 Boson 验证，
并非程序级保证；如果产品要求严格逐字朗读，应另选 Boson TTS 路径。

下文“暂停收音的结束确认与委派超时”和“委派修复”两节描述的是 2026-10-24 之前由 Higgs 调用 `run_worker_agent` 委派的旧流程，仅作历史记录。

## 流式与提交

Pi 的 text delta 转成既有文字事件；toolcall delta 转成既有工具参数预览。
私有 thinking 事件不转发。只有 Pi 完成参数校验并执行工具时，才发出实际 tool.call。
预览不会修改文档。vdoc 是否展示 text/tool.stream 取决于现有界面，本次没有新增 UI。
Higgs 在最终结果到达后输出流式语音；本版不逐句朗读后台中间进度，也不朗读长文章。

后台只获得客户端声明、并经现有 Server 白名单许可的工具。没有凭空新增搜索、原文抓取或外部知识能力。
引用/完整性保障仍需另行实施研究方案；换成 Pi 并不自动解决事实错误。

## 预算、失败和取消

- 默认总超时 90 秒，包含模型和工具等待；可配置最大 300 秒。
- 默认/最大 12 次后台模型请求，每次最多 8192 输出 token。
- 实际工具继续执行现有每轮调用上限（默认 12），并沿用客户端工具 15 秒超时。
- 后台普通文字每轮最多 16000 字符，累计工具结果最多 160000 字符；超限按任务失败处理。
- Pi 工具执行顺序为 sequential，避免并行修改同一 revision。
- 治理拒绝、客户端超时、应用 ok:false 反馈给 Pi，不能当作成功。
- 用户打断/关闭会取消 Pi，拒绝待处理工具 Promise，关闭旧结果闸门；旧结果不送入新任务。
- 取消结果回填给 Higgs，关闭它先前的委派工具调用，避免下一轮残留未配对工具调用。
- 后台失败不让前台继续说成功；发送通用可恢复错误，不把供应商错误正文当作用户消息。
- 已经生效的文档修改不会因中断自动撤销；写入超时仍必须读回核对，不能盲目重试。

## 配置与回滚

```text
VDOC_SERVER_MODEL=boson-worker
BOSON_API_KEY=<secret>
ANTHROPIC_API_KEY=<secret>
VDOC_SERVER_WORKER_MODEL=claude-haiku-5-5
VDOC_SERVER_WORKER_THINKING=off
VDOC_SERVER_WORKER_PREFETCH=true
VDOC_SERVER_WORKER_TIMEOUT_MS=90000
VDOC_SERVER_WORKER_MAX_REQUESTS=12
```

`boson-worker:<model>` 的冒号后是 Higgs 前台型号；后台型号只由 WORKER_MODEL 指定。
模型必须存在于固定 Pi 目录，未知型号在创建模型注册表时拒绝，不静默降级。
重启/重部署后生效；回滚选择 `VDOC_SERVER_MODEL=boson`，已有会话应结束后重开。
仓库的生产与预览配置均选择 boson-worker；发布前需分别配置 ANTHROPIC_API_KEY。
密钥不进入客户端、仓库或普通日志。本次未部署、未写入任何密钥。

## 验证边界

自动测试使用真实 Pi loop、vRT runtime/Hub/客户端和脚本化的上游模型，验证循环与传输行为。
这些测试不证明真实 Boson 会稳定委派、逐字发声，也不证明后端模型的事实质量。
上线前需用实际密钥验证语音转写、长文章参数流、说话打断、网络恢复、应用写入冲突与中文音色。


## 本地调试入口

Node 的 development 模式在 `/` 提供仅回环地址可访问的调试页，浏览器 bundle 位于 `/dev/playground.js`。
`npm run dev` 自动读取仓库根目录 `.env`，实际环境变量优先；该文件已被 Git 忽略。
页面只使用开发 client key 与短期会话 grant，模型密钥不发送到浏览器。

可选择连接麦克风或仅发送文字，两者都启用扬声器。浏览器会请求麦克风权限。
后台文字和工具参数预览实时展示；工具参数完整并验证后才提交到本页的独立测试文档。
测试文档支持稳定 block id、revision/session 前置条件、callId 去重与最近一次插入撤销；
不支持完整 vdoc 格式操作，不连接正式用户文档，不绕过现有前端的登录或数据库授权。

本地模式已用真实服务验证：Pi 调用 get_context 与 insert_structured_article 成功，
测试文档 revision 从 0 到 1、生成标题与正文两个 block，并收到 Higgs 音频。
这只证明最小链路可用，不能替代真实麦克风、长文、打断和事实质量验收。


### 新建与编辑测试文档

“新建空白文档”会创建带稳定空段落 ID 的独立文档，显示名称和可输入的正文区域；
本页内旧文档保留在文档切换列表，不再静默清空。刷新页面仍会清空本页测试文档。
手动输入和改名会增加 revision，旧 agent 前置条件必须重新读取；手动编辑会清除旧撤销快照以保护用户输入。
开发模式额外允许 create_test_document，Pi 可以按语音或文字要求新建空白测试文档。
生产配置的文档工具白名单不增加这个测试专用工具。


### 暂停收音而不打断任务

麦克风连接后可点击“暂停收音”，按钮变为“恢复收音”。暂停立即关闭真实音频帧的转发，
停止麦克风采集并释放设备；会话、Pi 任务、工具等待和扬声器保持运行。
暂停时通过服务端控制请求结束当前语音；服务端补发合成静音并等待供应商确认，详见下文“不依赖固定静音尾段”的结束确认流程。不会收集或发送后续环境声音。
恢复时在同一个会话中重新开启麦克风；旧采集回调失效，断开时清理所有采集与定时器。
“打断”仍是另一个独立按钮；暂停收音不调用 interrupt、close 或清空音频输入。
已经在点击暂停前由声音触发的中断不能追溯撤销，需要重新提交任务。

### 本地调试页的文章流式显示

Pi 生成 `insert_structured_article` 的工具参数时，现有 `tool.stream` 的 `arguments-delta` 已实时传到浏览器。调试页直接解析这些真实片段，把标题与段落显示在右侧文档的目标位置，按浏览器动画帧合并绘制；不会等待完整文章返回后播放打字动画。该显示仅适用于文章工具中的内容，普通进度文字仍在左侧显示。

流式内容显示“正在生成 / 正在校验并写入”，此时尚未修改文档 revision，文档读取工具与下载只包含已提交内容。完整参数仍通过原有版本校验、取消检查、原子插入及 callId 去重执行，成功后移除临时显示并保留正式文章。打断、断连或写入失败会保留标明未完成的临时片段，可点击“清除未完成草稿”；已关闭调用的后续片段不能继续更新。修改或切换文档后，旧版本的流式内容不会覆盖新文档。

只修改 fork 的本地调试页与浏览器打包依赖，不修改原版 vdoc、vRT 协议或模型运行时。模型最初思考、读取文档时仍可能短暂没有正文；一旦开始输出文章参数，内容即逐步显示。

### 暂停收音的结束确认与委派超时（取代客户端固定静音尾段）

本地页面暂停时先关闭采集，再通过已认证 WebSocket 的应用 context 通道发送带唯一 ID 的 `voiceControl: { type: "finish-speech", id }`，并附上当前连接的 documentId。服务端检查文档作用域、参数长度、单一活动模型并去重；该控制不会调用会先取消任务的 AgentSession.commitAudio()。已经进入 Pi、工具执行或播报的任务保持运行。

真实 Boson 接口限制：自动模式不允许 `input_audio_buffer.commit`，会话开始后也不允许修改 turn_detection。因此 boson-worker 的演员连接从一开始使用 `server_vad`，不再用语义判断决定何时结束。暂停后服务端按实时速度补发当前格式的合成静音，收到供应商 `input.speech.end` 或响应开始即停止；总等待由 15 秒委派超时限制。若已结束语音则不再补发。收到语音结束或最终转写后，若 600ms 内仍无响应开始，补发一次 response.create；自动响应先到则取消补发。不会伪造“已经收到结束确认”。

每次文字请求、语音结束或暂停请求都会启动委派等待保护；Pi 开始后才切换到独立的 Worker 执行期限。超时会结束当前轮次并提示 DELEGATION_TIMEOUT，不会永远停留 thinking，超时响应的迟到工具调用会被丢弃，用户可重新输入。页面显示收音、等待委派、Pi 已启动、工具执行、生成正文和错误等实际阶段。Pi 启动通知是服务端生成的公开进度文本，沿用现有 text 传输并由调试页单独显示为状态，不包含模型内部推理；不扩展 vRT 协议。

官方依据：
- https://docs.boson.ai/models/higgs-realtime/guides/turn-detection-and-interruptions.md
- https://docs.boson.ai/api-reference/realtime/client-events.md

验收包含真实 HTTP/WS + 客户端的暂停控制、结束事件确认、缺失响应补发、重复控制去重、已有 Worker 不被取消、委派超时及迟到响应隔离。另使用本机合成中文语音实测真实 Boson 与 Pi，未录制用户麦克风。

### Cancel races and partial deletion

Cancel the Pi run locally; send performer cancellation only when Higgs itself has an active response. A recoverable response_not_active / response_cancel_not_active, or the exact "No active response to cancel" error, is an idempotent cancellation acknowledgement. It must not abort a newer worker. Other errors remain visible.

The local editor now offers delete_test_blocks, allowed only as an additional development-profile tool. Read session/revision and stable block ids first; submit 1-20 unique ids for atomic deletion. Unknown ids, stale revisions, duplicate targets and cancellation apply no partial changes. All remaining blocks keep their content and ids. Repeated call ids do not delete again. The result returns actual deletedBlockIds, deletedCount and revision. undo_turn can restore the latest insertion or deletion; deleting every block leaves one editable blank paragraph. This bounded, undoable local tool is medium risk; production tools and the existing block.delete risk remain unchanged.

For "delete the last two paragraphs", select only the last two paragraph ids, preserving headings and earlier paragraphs. Never undo an entire article to approximate a partial deletion. This distinction is stated in both worker instructions and tool descriptions.

Validation includes real Pi/Higgs delegation through HTTP/WS with exactly one deletion, retained ids, development-only authorization, atomic failures, undo, deduplication and cancellation races.

Provider-side speech barge-in needs separate worker cleanup: vRT assumes the provider has already cancelled its response and does not call model.cancel() on that path. The delegated adapter therefore stops the prior Pi run on input.speech.start before accepting a new voice request. Tests ensure the old worker is aborted, its late write is dropped, and the new voice delegation completes.

### Authoritative input and real local tables

The server task envelope now contains only userRequest (the actual typed input or current final speech transcript), requestSource, and previousTasks as background. Higgs's delegated request is not forwarded as a competing instruction. If delegation finishes before final transcription, Pi waits; the original bounded deadline reports TRANSCRIPTION_TIMEOUT if no final input arrives. A delayed transcript cannot override a newer typed request. Tests inject an unrelated box-office delegation while the user requests an Ultraman table and assert that only the user's request reaches Pi.

The development-only insert_test_table tool creates a real table block (caption, column headers, rows) rather than paragraph text. It shares article insertion's atomic destination/version checks, undo history, call-id deduplication and cancellation handling. Limits: 1-12 columns, 1-200 rectangular rows, 1000 characters per cell, 60000 total characters. Tables render as safe DOM table/thead/tbody/th/td elements, show partial generated rows through the existing argument stream, serialize structurally in read_document, and export as tab-separated text. Cells are currently read-only in this simple local page; a table can be removed by stable block id or insertion undone.

No research tools or source registry have been added in this change. The table tool requires an explicit scopeNote and always displays an unverified/completeness limitation; the worker must not present an unresearched exhaustive list as complete, current, official or source-backed. This fixes request routing and table output, not factual coverage. Production vdoc and vRT repositories/protocol remain unchanged.

Manual evaluation with the exact user sentence successfully created a real 18-row Ultraman table. This is a routing/format pass, NOT a factual-quality pass: the model still confused names (for example Jack versus Zetton). The official Jack entry is https://m-78.jp/character/jack/. The unverified caption is a disclosure, not evidence verification or a factual guarantee. Source-backed research remains necessary before this can satisfy an exhaustive, accurate-list task.

### Bounded delegation repair and generation failure diagnosis

A real failed deletion request at 2026-10-24 00:52:11 UTC logged "Voice performer must delegate exactly once" followed by the runtime's generic "Generation stopped: failed"; there were zero document tool calls in that turn. The generic message hid the actionable cause.

If the performer finishes without a valid delegation and no worker or client tool has run, the adapter now allows exactly one corrective response with the authoritative current user request. It stays within the original delegation deadline and normal continuation limit. Missing final transcription still blocks execution. Invalid tools never execute directly. A second failure reports ACTOR_DELEGATION_FAILED; it does not loop indefinitely. New speech, explicit interruption, timeout or disconnect close the repair path and invalidate late responses.

Worker failures are never retried by replaying the task. Successfully acknowledged mutating tool results are counted: WORKER_FAILED_AFTER_WRITE warns that document changes have already succeeded. A failure during the performer's final reply is VOICE_REPLY_FAILED: Pi's text and confirmed edits remain, and tools are not replayed. Failures before confirmed edits report WORKER_FAILED. Provider errors retain their normal failure path.

The local UI retains the specific task error when the runtime subsequently sends its generic Generation stopped terminator. A lone generic failure gets a useful fallback message directing the user to inspect document/tool results before retrying unfinished work. Stage-prefixed server progress is shown in the status area. This is an application adapter/UI fix; no vRT source or protocol change.

Tests cover missing/wrong-tool delegation followed by a successful single repair, repair exhaustion, an already-applied write followed by Pi failure, voice-only failure after editing, and primary-error preservation.
