# Boson 资料补充与事实写入：最小服务端改造方案

日期：2026-10-23  
状态：设计建议，未实施；本次只新增此 Markdown，未修改现有代码、依赖或部署配置。

## 1. 结论与建议

**第一阶段优先只改 vdocServer。现有证据没有显示必须修改 vRT，也不要求修改 vdoc。**

建议保留 Boson 的实时语音、交互和最终整理能力，在 Server 增加两条可以独立测试的资料通道：

1. **网络通道**：快速搜索，返回少量相关片段与真实来源；需要严谨写入时，再读取原文。
2. **知识模型通道**：调用另一个纯文本模型，关闭联网与工具，只返回候选事实、范围建议和不确定项。

再增加第三种实验配置：Server 内并行获取这两路结果，清楚标注各自性质，一次交给 Boson 比较、整理。这里的“另一个 agent”先实现为**一次无状态的模型 API 调用**，不引入完整多 agent 框架。

**网络搜索和知识模型都可能改善结果，但改善幅度必须用真实 Boson 测出来。两个答案相同也不等于事实正确。** 网络片段可能过时、截断；知识模型可能重复同一种错误。Boson 不应通过“二比一投票”决定事实。

建议顺序：

> 固定评测集 → 网络单路 / 知识模型单路对比 → 双路并行对比 → 选出质量、延迟、成本合适的默认模式。

不要先替换 Boson，不要先改语音链路，也不要把完整性规则写进 vRT 核心。

本文将用户所说的 BRT 按当前仓库中的 vRT / vRealTime 理解，将 VBOX 按上下文中的 vdoc 文档端理解；如果它们是独立组件，涉及它们的结论需要另行核对。

## 2. 根据当前代码，为什么可以先只改 Server

### 2.1 已核查的事实

本方案以 vdocServer 当前 `380611a`、相邻 vRealTime 当前 `03ba90c` 的代码为基础，并核对了 Server 已安装的 SDK 类型声明。仓库原有未跟踪文件未作处理。

| 现状 | 已核查位置 | 对方案的影响 |
| --- | --- | --- |
| Server 创建 `defineAgent` 时设置 `clientTools: 'accept'`，没有注册服务端研究工具 | `packages/adapters/vrt/src/realtime-host.ts` | 可在此增加 `tools`，继续接受现有客户端工具 |
| 当前白名单只有 6 个文档工具 | `packages/config/src/profiles/editing-assistant.ts` | 新工具必须同时进入白名单，不能只写提示词 |
| vRT `AgentDefinition.tools` 支持服务端 `run(args, context)` | vRealTime `packages/core/src/agent.ts`、`tool.ts`；Server 安装包 `dist/*.d.ts` | 搜索和辅助模型无需绕到浏览器执行 |
| `ToolContext` 有 `signal / callId / turnId / epoch` | 同上 | 研究请求可以绑定取消、任务和调用身份 |
| `beforeToolCall` 支持 `allow / reject / rewrite` | 同上；`packages/core/src/session.ts` | 可以在 Server 拦截写入，并将来源标记解析成既有文本参数 |
| 目前 Server 只返回 `allow/reject`，没有使用 `rewrite` | Server `realtime-host.ts` | 需要修改适配层接线，而不是增加 vRT 协议 |
| 每轮工具调用默认 12 次 | `packages/domain/src/voice-session/session-limits.ts` | 研究和编辑仍共同受总调用数约束 |
| Server 明确配置 `maxContinuations: 16` | `realtime-host.ts` | 这是续生成预算，不是 16 次搜索或 16 次工具调用 |
| 客户端工具默认超时 15 秒 | `realtime-host.ts` | 不要拿它当搜索超时；研究工具自己管理 deadline |
| 当前结果审计只接收 `ok/code`，不保存结果正文 | `packages/application/src/use-cases/record-tool-result.ts` | 不能把现有审计当作证据库，需要独立研究记录 |
| vRT 当前工具队列逐个执行普通工具 | vRealTime `packages/core/src/session.ts` 的 `#pump/#execute` | 双路低延迟应在一个 Server 工具内部并行 |
| Server 使用部分本地 vRT tarball | `vendor/vrt/README.md`、根 `package.json` | 不能只改相邻 SDK 源码便认为运行中的 Server 会生效 |

### 2.2 三端变更边界

| 组件 | 第一阶段是否改 | 具体内容 |
| --- | --- | --- |
| vdocServer | **要改** | 工具注册、研究服务、外部 API 适配、证据记录、写入门禁、引用文本解析、配置、指标和评测 |
| vRT | **目前不需要** | 复用已有服务端工具、rewrite hook、取消与续生成能力 |
| vdoc | **优先不改** | 沿用现有读写工具，用普通文本 `[1]` 与来源列表展示引用 |

“只改服务端”指只改 Server 仓库，仍包含 Node、Worker 两个部署入口的装配与配置；不是只改一个文件。

尚未核查 vdoc 实际实现，因此**不能保证它已支持原生链接、脚注、返回引用映射或跨新 callId 的语义去重**。第一阶段不依赖这些能力。

## 3. 极速搜索：可以做到什么，不能承诺什么

### 3.1 把延迟拆开

```text
用户说完 → 转写/任务判断 → Boson 发起工具 → Server 取资料
         → Boson 读取并生成文章参数 → 浏览器写入 → 确认结果
```

搜索 API 一秒返回，不等于用户一秒拿到完整文章。文章生成、工具参数传输和编辑器写入都需要时间。

**毫秒级最现实的来源是内存缓存或预先建立的资料索引；任意问题的实时联网搜索不能保证始终在毫秒级返回。** 1～2 秒可以作为快速研究工具的工程目标，不能作为尚未测试的生产承诺。

以下均为初始测试目标，不是本项目实测数据，也不是供应商 SLA：

| 路径 | 初始目标 | 适用情况 |
| --- | --- | --- |
| 进程/DO 内存缓存命中 | 服务内处理 5～30ms | 相同问题与相同范围已查过；不含用户到服务器网络 |
| 持久缓存命中 | 服务端取回 20～150ms | 同区域、缓存可用；以部署实测为准 |
| 外部快速搜索 | 工具端到端 p50 ≤ 1s、p95 ≤ 2s | 少量结果、无实时全文抓取、无答案合成 |
| 辅助模型短回答 | p50 ≤ 2s，单独测 p95 | 受排队、输入长度、输出量与模型影响 |
| 原文读取 | 另给约 6s 总预算 | 目标页面可能慢、拒绝访问、没有正文 |
| 完整研究与文档写入 | 分开统计 | 不要求受快速搜索的 2s 指标约束 |

### 3.2 第一轮供应商实验

| 候选 | 对应能力 | 本项目使用方式 |
| --- | --- | --- |
| Exa Search `type: lite` | 官方定位为低延迟，直接读取定期更新的索引，不在查询时抓网页 | 首个快速检索候选；返回少量 highlights，保留抓取新鲜度限制 |
| Tavily `search_depth: fast` | 返回相关原文片段，偏向较低延迟 | 与 Exa 做质量、中文覆盖和延迟对照 |
| Tavily `ultra-fast` | 每个 URL 返回 NLP 摘要 | 可做更激进的延迟实验；必须标成摘要，不能冒充原文 |
| Brave Web / LLM Context | 网页结果或预提取片段，可限制上下文规模 | 作为替代候选；先不增加第三家生产依赖 |

Exa 当前文档已将 `instant/fast` 标为 legacy 并推荐 `lite`；应按现有接口实施，不照搬旧示例。其索引模式无法保证刚发布的网页已收录。[Exa Search 官方文档](https://exa.ai/docs/reference/search)

Tavily 明确区分 `fast` 的片段与 `ultra-fast` 的摘要，并可关闭答案合成；两种内容要分别处理。[Tavily Search 官方文档](https://docs.tavily.com/documentation/api-reference/endpoint/search)

Brave LLM Context 可返回带 URL 的提取内容，并支持控制 URL、片段与 token 数。[Brave LLM Context 官方文档](https://api-dashboard.search.brave.com/api-reference/ai/llm_context/get)

**建议先选两家做离线对照，生产默认只启用一家。** 在没有 API 密钥和同部署区域基准之前，不宣称哪家一定最快或中文最好。

### 3.3 最小性能策略

- 快速路径每次取 3～5 条结果，每条约 300～600 个字符，总包建议不超过 4,000 字符；Server 另按模型上下文限制截 token。
- 关闭供应商生成式答案、深度研究、图像和不相关元数据；不要让搜索服务先写一篇答案再交给 Boson。
- 优先选择原文相关片段；如果供应商只提供摘要，明确 `contentKind: summary`。
- 普通知识命中缓存可直接返回；最新资料按短 TTL 或重新验证。过期缓存只能在明确披露时降级使用。
- 请求键包含查询、语言、范围、截至时间、来源过滤、供应商和配置版本；含私人资料的查询按用户/租户隔离。
- 合并同一时刻的相同请求，限制缓存大小；不缓存失败为“空结果”。
- 同区域部署、复用 HTTP 连接，减少可避免的握手与跨区传输；Cloudflare 边缘并不自动保证离所有供应商都近。
- 第一次只接一家，不做每次双供应商竞速。后续只有尾延迟确有问题，再评估延迟触发的备用请求及其成本。

“只给一点点信息，让模型推理”适用于候选实体、名称消歧和一般背景；**完整名单不能从三条摘要中推理出缺失成员**。完整性任务必须允许切换到原文读取、翻页或承认范围不足。

## 4. 另一语言模型：作为知识顾问，而不是新的主代理

### 4.1 接入方式

```text
Boson → Server 研究工具 → 纯文本模型 API
                         ↓
          候选事实 / 范围 / 不确定项 → Boson
```

顾问模型不接麦克风、不生成语音、不连接文档、不执行工具，也不自动访问网络。Server 只提供用户问题、必要范围和少量上下文，不发送整篇文档或原始音频。

仓库已有 Anthropic SDK 与 Claude 文本适配，但现有 `cascade-claude` 是替换整条语音模型管线的方案，**不能直接把它当作知识顾问调用**。应新增轻量 `KnowledgeAdvisor` 端口与独立适配器，通过组合根注入研究服务，避免适配器互相依赖。

模型选型建议：

| 候选 | 为什么进入实验 | 是否能直接认定强于 Boson |
| --- | --- | --- |
| Claude Haiku / Sonnet 当前可用版本 | 现有项目已有相关供应商依赖，接入成本较低；分别测速度与知识表现 | 不能，必须在本项目题集测 |
| Gemini Flash / Flash-Lite 当前可用版本 | 适合作为第二组速度、成本、知识质量候选 | 不能，同样评测 |

具体模型 ID 在实施当天核对、固定到配置与评测记录，不把滚动别名当成固定实验对象。候选系列可参考 [Claude 官方模型页](https://platform.claude.com/docs/en/models/overview) 与 [Gemini 官方模型页](https://ai.google.dev/gemini-api/docs/models)。这些页面无法证明候选在本项目上胜过 Boson。

先不引入本地模型推理部署或新的 GPU 基础设施。已有合适服务时，可以按相同端口加入实验。

### 4.2 顾问返回格式

```json
{
  "kind": "model_knowledge",
  "consultationId": "adv_opaque_id",
  "provider": "configured_provider",
  "model": "pinned_model_id",
  "generatedAt": "2026-10-23T12:00:00Z",
  "scopeSuggestion": "建议按官方电视主系列主角整理，需对照官方目录",
  "candidateClaims": [
    {"claim": "候选条目或背景事实", "certainty": "uncertain"}
  ],
  "unknowns": ["是否覆盖衍生作品尚未验证"],
  "completeness": "unverified",
  "externalEvidence": false,
  "truncated": false
}
```

上面只是协议示例，不包含真实事实结论。`certainty` 是模型自述，不是经过校准的概率。

要求顾问：不编造参考 URL；不知道就返回 `unknowns`；候选列表与范围分开；不输出隐式推理过程；只给结论和简短依据。输出有字符/token 上限，结构不合法只允许一次有预算的修复。

### 4.3 不能越过的证据边界

- 顾问回答可作候选事实，但不发放网页 `sourceId`，不能计入“已取得外部来源”。
- 知识单路适合一般、稳定的知识任务；不满足“最新、必须引用、官方完整名单”的严格要求。
- 搜索失败后可返回顾问建议，但必须标记“未联网核实”；不能说“已查证”。
- 两路一致仍需看来源是否支持对应陈述；两路冲突时优先核查时间、范围和原文，不能直接选更自信的答案。
- 辅助模型表现更好，也不代表 Boson 能正确采用它的结果；必须测最终写入文章。

## 5. 工具设计：两种内部通道，两个对 Boson 暴露的研究工具

为了减少模型选择工具和来回调用的成本，推荐把第一版模型可见接口收敛为：

| 工具 | 职责 | 执行位置 |
| --- | --- | --- |
| `get_research_context` | 按 Server 配置获取网络结果、知识顾问或两者；结果类型明确分开 | Server |
| `read_web_sources` | 批量读取来源或用户链接，按页返回片段与状态 | Server |
| 现有文档工具 | 读取上下文、提交文章或修改、撤销 | vdoc，沿用现有接口 |

原建议的 `search_web` 保留为应用层检索能力与可独立测试的服务；知识通道对应 `consult_knowledge_model`。第一阶段不一定把两者都注册为模型工具。如果团队必须沿用 `search_web` 工具名，可以采用三个独立工具，但双路并行仍需一个组合入口；不要让名为 `search_web` 的工具悄悄返回纯模型答案。

### 5.1 `get_research_context`

模型参数建议：

```json
{
  "query": "整理奥特曼系列主角名单",
  "scope": "用户尚未限定电视、电影或衍生作品",
  "purpose": "complete_list",
  "language": "zh-CN"
}
```

`taskId / sessionId / turnId / mode / deadline / budget` 由 Server 从可信调用上下文附加，不让模型指定其他用户的任务、放宽预算或选择关闭证据门禁。模型填写的 `scope/purpose` 是建议，不能覆盖已记录的用户范围。

统一返回形状：

```json
{
  "status": "partial",
  "taskId": "task_opaque_id",
  "mode": "hybrid",
  "web": {
    "status": "ok",
    "sources": [{
      "sourceId": "src_opaque_id",
      "title": "页面标题",
      "url": "https://example.org/catalog",
      "contentKind": "search_snippet",
      "text": "相关片段",
      "publishedAt": null,
      "retrievedAt": "2026-10-23T12:00:00Z",
      "readStatus": "not_read",
      "truncated": false
    }],
    "pagination": {"state": "unknown", "nextCursor": null}
  },
  "advisor": {"status": "timeout", "externalEvidence": false},
  "coverage": "unverified",
  "gaps": ["尚未读取官方目录，无法确认名单完整"],
  "suggestedNextAction": "read_web_sources"
}
```

`pagination.state` 可取 `more / exhausted / unsupported / unknown`。供应商不支持翻页时，不伪造“已穷尽”；搜索结果已穷尽也不代表现实世界的实体已列全。

**快照提取的原文段落可以作为段落证据；纯搜索摘要不能自动升级为原文读取。** 如果搜索接口同时带回可追溯的原文内容，应保存内容类型、提取时间和快照标识，避免为形式上的“已调用读取工具”重复请求；完整性仍单独核验。

### 5.2 双路并行与 deadline

在 `get_research_context.run()` 内启动两路异步请求：

```text
web_only       → 只请求 SearchProvider
knowledge_only → 只请求 KnowledgeAdvisor
hybrid         → SearchProvider 与 KnowledgeAdvisor 同时启动
                  → 各自限时 → 截止时返回已完成分支
```

不能简单 `await Promise.allSettled()` 等一个无超时分支永久挂住。两路都必须绑定总 deadline、分支超时和 `context.signal`；达到截止时取消未完成分支，保留已完成结果。

若 `T_web`、`T_advisor` 是并行分支耗时，则等待两路的资料耗时约为 `max(T_web, T_advisor)` 加固定开销；不是两者之和。若启用截止返回，慢分支可以缺失。

第一版不做“先返回网络，顾问晚到后再自动插话”。这会引入跨轮次信息污染与重复生成。用户打断时丢弃旧任务的晚到结果。

### 5.3 `read_web_sources`

输入建议为 `sourceIds` 或 `urls` 二选一、`focus`、可选服务端签发的 `cursor`；限制每次 3 页、最多并行 2 页。`sourceIds` 必须属于当前授权任务；用户 URL 先注册来源并经过安全校验。

每个来源独立返回：

- `sourceId / canonicalUrl / title`。
- `status: ok | partial | blocked | timeout | unsupported | failed`。
- `contentKind: page_text | page_excerpt | provider_summary`。
- `publishedAt / fetchedAt / indexedAt`，未知就 `null`，不把抓取时间当发表时间。
- `text / contentHash / snapshotId`。
- `returnedChars / truncated / nextCursor`。
- `errorCode / retryable / suggestedAction`。

若供应商不支持读取任意分页片段，Server 对已取得快照切片并签发 cursor；上游内容本身已被截断时必须保留该状态，不能假装拿到了全文。Exa 提供批量 Contents，并返回每个 URL 的状态，可作为最小读取适配候选。[Exa Contents 官方文档](https://exa.ai/docs/contents/quickstart)

## 6. Server 的任务状态与写入门禁

### 6.1 最小任务状态

```text
created → scoped → researching → ready_to_write → writing → write_verified
                      ↘ insufficient / failed / cancelled
```

`write_verified` 只证明本次写入被实际确认；“用户任务是否完成”另有完成标准。已写入部分成果并披露缺口，不等于完成“全部名单”。

研究记录建议至少保存：

| 内容 | 字段示例 |
| --- | --- |
| 身份与关联 | `principalId/documentId/sessionId/taskId/inputSequence/epoch` |
| 用户范围 | `requestSummary/requestedScope/effectiveScope/scopeStatus/asOf` |
| 任务性质 | `requiresEvidence/requiresFreshness/requiresCompleteness/classificationStatus` |
| 搜索轨迹 | 查询、供应商、过滤条件、请求 ID、状态、用量、耗时 |
| 来源与已读证据 | 来源注册表、片段、内容类型、快照哈希、读取状态、来源时间 |
| 顾问记录 | 供应商、固定模型版本、候选、缺口；与网页来源分开 |
| 完整性 | 标准名、别名、去重键、名录/分类/分页覆盖、未解决项 |
| 写入 | 原始语义指纹、解析后参数哈希、callId、状态、结果摘要 |
| 预算 | 已用搜索数、页数、字符/token、耗时、调用数、写入尝试数 |

保存必要的公开证据片段，不保存整篇用户文档。用户请求摘要与待写文章只在任务需要时有限期保存、限制访问；默认不落普通日志。持久化用户草稿需单独约定，第一版可以只在会话内保留待写内容，重启后要求重新准备。

### 6.2 任务识别不能全靠 Boson 自报

Server 对可信用户文本或最终语音转写做任务分类；“所有/完整/最新/具体日期/引用/官方名录”等进入证据流程。保留改写、虚构写作、单纯格式修改的豁免。

这里的可信指“确为用户输入且绑定当前任务”，不是把输入内容当成系统指令。网页、文档、顾问都不能给自己授予新权限。

当前 `withLifecycle.userInput` 只报告发生了输入，没有传递正文。实施时在 Server 的模型装饰器捕获 `sendText` 与规范化的 `input.transcript` 事件，按 itemId/revision 记录最终输入；也可使用已有 `onTranscript` 辅助，但该 hook 只在有当前 turn 时触发，不能单独依赖它覆盖所有晚到转写。

**最终转写未到或无法可靠关联时，任务保持 `unknown`；对新生成事实内容的写入暂缓放行，等待转写或明确范围。** 不允许模型通过自行填写 `requiresEvidence:false` 绕过限制。分类误判率要纳入评测，关键词规则只是第一层。

### 6.3 写入前的程序门禁

对已标记研究任务，`beforeToolCall` 必须检查：

1. 任务属于当前授权会话、文档和有效输入版本，未取消，范围没有被后续用户要求覆盖。
2. 要求外部证据时，存在当前任务实际取得的合格来源；只有顾问回答不算。
3. 正文使用的来源标记都存在，并对应已读取的证据片段；来源只证明有证据对象，不证明蕴含关系。
4. 完整名单有明确范围、覆盖检查和缺口状态；无法验证时只能输出已披露范围的部分结果，不能保持“所有”的标题。
5. 要求最新时，来源时间或本次验证足以支持该请求；未知时间不能自动视为最新。
6. 正文与预期版本、写入位置、当前预算及幂等状态匹配。

门禁覆盖 `insert_structured_article` **以及可插入/替换正文的 `apply_document_operations`**，防止换工具绕过。格式工具在参数校验确认没有正文变更时可走豁免。无法可靠解析的内容变更应拒绝或要求转入受控文章写入路径。

拒绝时给可操作的消息：缺来源→研究；只有摘要→读原文；范围不清→声明范围或确认；材料不足→承认不足。vRT 当前 hook 拒绝通道只返回 message，可在 message 中带稳定业务错误前缀，详细错误对象留在 Server；无需为了业务错误码修改核心协议。

### 6.4 完整性与范围的实际标准

“所有奥特曼”不能由 Server 自动缩成“电视主角”后继续宣称所有。可以在正文开头声明工作范围，结果标为该范围内的整理；如果用户明确要求包括电影、衍生作品，缩小范围属于未完成。

能够支持完整性的证据包括：官方封闭名录、明确分类及截止日期、分页已覆盖、别名去重后与名录核对。搜索了三次、读了三页、顾问也同意，都不构成完整性证明。

程序可以强制这些检查项存在、来源 ID 有效、数量与分页记录一致。**程序无法仅用来源数量、关键词或一个模型评分保证每条陈述正确；语义支持要在评测中人工审核，运行时可做有限辅助检查。** 第一版不能宣传为“自动事实认证”。

## 7. 不改 vdoc，怎样把引用写入现有文章

### 7.1 第一版采用普通文本引用

让 Boson 在现有 `title/blocks` 文本字段里使用服务端来源标记，例如：

```text
某项有出处的陈述。[[source:src_opaque_id]]
```

Server 在 `beforeToolCall`：

1. 读取当前任务来源表，验证标记与引用资格。
2. 将合法标记转换为 `[1]`，按既有 paragraph/heading 文本能力追加“资料来源”块。
3. 来源块中的标题、URL、日期全部从注册表生成，不使用模型编写的 URL。
4. 重新验证解析后文章大小、结构与参数；然后对**最终实际发送参数**执行现有治理审查。
5. 返回 `{ action: 'rewrite', arguments: finalArguments }`，把正常文章参数交给原有浏览器工具。

引用映射保存在 Server 的任务记录：`citationNumber → sourceId → snapshotId/url`。无需给 vdoc 添加 `sources` 等未知参数。

当前文章 schema 的实际实现不在本仓库，开发前必须通过已连接客户端的工具声明或 vdoc 源码核对可接受块结构。若无法安全重写，则让 Server 先生成已解析的引用文本，Boson 按现有字段提交，门禁验证最终文本与映射一致；不能伪造一个未经确认的 schema。

**第一版保证普通文本来源列表可被既有纯文本段落能力承载；不承诺这些 URL 自动成为可点击链接。** 原生脚注、悬浮预览、引用样式和文档内部引用映射属于后续可选 vdoc 功能。

### 7.2 rewrite 与现有审查的顺序

不要“先审查原始参数，再悄悄扩写”。推荐：规范化/来源校验 → 生成最终参数 → 风险与预算审查最终参数 → 允许时返回 rewrite。高风险确认与重试使用稳定的语义规范化，避免引用编号变化造成同一次写入被当作不同授权。

参数重写不得改动用户目的、写入位置和 revision，也不替模型删除争议内容后宣称任务完整。遇到不支持的来源或缺口应拒绝并要求修复。

## 8. 预算、取消、重试与幂等

### 8.1 建议初始上限

下表是配置建议，均受现有每轮总调用数上限约束，不是额外赠送的无限预算。

| 项目 | 快速模式 | 严谨模式 |
| --- | --- | --- |
| 外部搜索请求 | 1 | 最多 3 |
| 顾问请求 | 0 或 1，按模式 | 最多 1，结构修复计入额外用量 |
| 原文页数 | 0；需要时升级 | 最多 6，单批最多 3、并行最多 2 |
| 单次快速上下文 | ≤ 4,000 字符 | 摘要包同左，后续片段另计 |
| 单页原文交付 | 不适用 | ≤ 4,000 字符，有截断与 cursor |
| 任务资料总交付 | ≤ 4,000 字符 | ≤ 16,000 字符，并受 token 上限控制 |
| 快速上下文 deadline | 2,000ms | 同左；失败不伪装成功 |
| 严谨研究总耗时 | 升级后另计 | 建议 12,000ms，后续按实测调整 |
| 实际写入成功次数 | 1 | 1 |
| 写入尝试 | 首次 + 至多 1 次确认安全的修复 | 同左 |

研究预算同时按 task 追踪，跨轮次继续同一任务不会自动重置；工具总调用数仍按现有 turn 计数。估计保留至少 4 个调用槽给定位、写入、读回与一次冲突修复；若实际工具协议需要更多，就停止扩展研究或进入明确的下一轮，不能把预留当作完成保证。

大名单在此预算内无法覆盖时返回“资料不足/需要继续研究”，不靠提高 `maxContinuations` 强行结束。12 次调用与 16 次续生成保持独立，先不全面上调。

### 8.2 不要让网络请求占住命令队列

当前 Node 的命令串行队列由组合根统一包装，Worker 也有按文档串行命令队列。**不要把整段网络搜索塞进一个等待外部 I/O 的串行应用命令。**

采用三段式：

1. 短命令：检查权限、预占预算、记录 `requestId/epoch/taskVersion`。
2. 队列外：执行搜索/模型/读取请求，绑定取消与 deadline。
3. 短命令：再次核对任务版本与权限，提交成功结果或失败状态，结算预算。

外部请求已发出即计入尝试与可能费用，取消不应自动返还。旧输入版本、已关闭会话的结果禁止激活为新任务证据。共享公共缓存可保留安全的已取回公开材料，但不得触发旧任务写入或后续语音。

### 8.3 失败处理

| 错误 | 处理方式 |
| --- | --- |
| `INVALID_ARGUMENTS` | 返回字段错误，允许一次修正；不消耗外部请求预算但占用现有工具调用计数 |
| `SEARCH_TIMEOUT / RATE_LIMITED / PROVIDER_UNAVAILABLE` | 独立失败状态；有剩余 deadline 时最多一次适当重试，否则返回可用分支 |
| `NO_RESULTS` | 只表示本查询没有命中，不能证明实体不存在 |
| `SOURCE_BLOCKED / UNSUPPORTED_CONTENT` | 标记该来源不可读，换源；不进入浏览器绕过验证 |
| `SOURCE_TRUNCATED` | 返回 cursor 或缺口，禁止声称已完整读取 |
| `EVIDENCE_REQUIRED / COVERAGE_UNVERIFIED` | 拦写，返回需要研究、缩小且披露范围、或报告不足的恢复路径 |
| `STALE / VERSION_CONFLICT` | 保留本次已生成内容，重新读取位置；仅在确认未写入后重试一次 |
| `WRITE_OUTCOME_UNKNOWN` | 先读回核对，不能因超时直接用新 callId 再插一遍 |
| `INTERRUPTED / TASK_SUPERSEDED` | 终止旧请求，晚到结果不允许恢复旧写入 |

vRT 外层 `ToolResult.ok:true` 只表示服务端 `run()` 正常返回。若内部 payload 是 `status:timeout`，业务层必须按失败统计。文档工具还可能在 `output` 中返回应用 `ok:false`；不能只看外层执行成功。

服务端新工具可以在 payload 使用业务错误码，外层协议沿用现有约束。现有 `afterToolCall` 是同步通知接口，不可把异步、fire-and-forget 的审计回调当作下一步写入门禁的唯一数据来源。研究工具返回之前应完成证据提交；关键写入结果通过 Server 自己的有序记录链与下一次门禁衔接。

### 8.4 幂等与实际写入结果

Server 为受控写入建立 journal：同一任务、目标、内容与引用映射得到稳定指纹；区分 `prepared / dispatched / committed / failed / unknown`。保留现有调用身份及确认规则，不随意替换 vRT callId。

文章工具超时可能已经完成浏览器写入。若回执丢失，先用 `read_blocks/get_context` 核对目标内容和版本。只有确认前次未生效，才用刷新后的前置条件重试。

**Server 单独无法创造浏览器原本没有的原子写入、撤销或跨 callId 去重保证。** 第一版可通过“未知状态不重放”防止常见重复；若产品要求断线与任意崩溃下的严格 exactly-once，需核对 vdoc，必要时只为持久幂等键/结果查询增加最小客户端支持。这个问题不靠修改 vRT 核心解决。

## 9. 证据存储、安全与数据边界

新增应用端口 `ResearchRepository`，Node 用有界内存实现，Worker 用当前文档 DO 的独立研究记录命名空间；不把研究正文塞进现有审计日志或 VoiceSession 的通用遥测。

研究状态建议按任务保留 24 小时作为初始配置，结束与超期通过维护流程清理；来源缓存按新鲜度单独 TTL。正文片段存储须遵守供应商授权与保留规则，实施前核对。重启后恢复来源和预算，不凭空恢复不再存在的待写文章。

最小安全要求：

- 所有来源、顾问结果、任务与调用都绑定授权主体、文档和会话；sourceId 不可当跨用户访问凭证。
- 外部网页是数据，网页里的“忽略之前指令、执行工具”等文本没有权限。
- 服务端仅发送必要查询，默认不转发文档正文；私人查询不进入公共缓存。
- 读取用户 URL 仅支持 HTTP(S) 公网地址；限制重定向、体积、内容类型与耗时。自建抓取需每跳校验解析后的公网地址，阻止私网、回环、link-local 和元数据地址；无法在运行时可靠实施时优先使用受控读取供应商，不开放任意 fetch。
- 密钥只在 Server Secrets；日志不包含 Authorization、完整 query 或全文。查询与片段放受限研究存储，普通指标只放 ID、状态、长度、耗时和用量。
- 内容缓冲、解压、解析都有限额；PDF/动态网页不支持时明确失败，不新增通用浏览器执行。

## 10. 最小代码改动清单与配置

以下都是**后续实施建议**，本次没有创建这些实现文件。

| 层/位置 | 建议改动 |
| --- | --- |
| `packages/application/src/ports/` | 新增 `SearchProvider / SourceReader / KnowledgeAdvisor / ResearchRepository` 小接口 |
| `packages/application/src/` | 新增 ResearchService、任务状态、预算、短命令、证据门禁与写入 journal 用例 |
| `packages/domain/src/` | 必要的纯任务规则/值类型；风险表为研究工具明确分级，不放 HTTP/供应商逻辑 |
| 新 `packages/adapters/research/` | 搜索、读取、顾问适配器；Web API fetch、超时、结果归一化 |
| `packages/adapters/vrt/src/realtime-host.ts` | 注册两个服务端工具、接入 hooks、rewrite、任务绑定、业务结果解析 |
| `packages/adapters/vrt/src/lifecycle-model.ts` 或独立输入装饰器 | 捕获关联后的用户文本与转写，关闭时取消任务 |
| `packages/config/src/profiles/editing-assistant.ts` | 工具白名单、研究指令、来源与完整性规则 |
| `packages/config/src/server-config.ts` | 功能开关、模式、供应商参数、预算与密钥配置校验 |
| `packages/adapters/memory/`、`cloudflare/` | 研究记录及缓存的运行时实现；存储清理 |
| `packages/composition/src/index.ts` | 通过接口装配；现有适配器之间不新增直接依赖 |
| `apps/node/`、`apps/worker/` | Secrets/环境参数、运行时存储注入；Worker 绑定仅在实际需要时加 |
| tests、`evals/`、docs | 假服务测试、真实 Boson 题集、性能/费用记录与操作说明 |

建议配置名称：

```text
VDOC_SERVER_RESEARCH_ENABLED=false
VDOC_SERVER_RESEARCH_MODE=web_only|knowledge_only|hybrid
VDOC_SERVER_RESEARCH_ENFORCEMENT=observe|enforce
VDOC_SERVER_SEARCH_PROVIDER=exa|tavily|brave
VDOC_SERVER_RESEARCH_CONTEXT_TIMEOUT_MS=2000
VDOC_SERVER_RESEARCH_TOTAL_TIMEOUT_MS=12000
VDOC_SERVER_RESEARCH_MAX_SEARCHES=3
VDOC_SERVER_RESEARCH_MAX_SOURCE_PAGES=6
VDOC_SERVER_RESEARCH_MAX_CHARS=16000
VDOC_SERVER_ADVISOR_PROVIDER=anthropic|google|configured_compatible
VDOC_SERVER_ADVISOR_MODEL=<pinned_model_id>
VDOC_SERVER_ADVISOR_TIMEOUT_MS=1800
VDOC_SERVER_RESEARCH_RETENTION_HOURS=24
```

这些是待新增的配置，不是现在已支持的变量。`observe` 只用于受控评测/灰度，不能对外声称已启用强制证据门禁。公开生产严谨任务要用 `enforce`。

网络单路不要求顾问密钥，知识单路不要求搜索密钥；混合模式启动时校验两者。功能关闭时保留当前行为，日志明确研究未启用，不宣称有事实保证。

## 11. 两类测试、四组实验及验收标准

### 11.1 保留用户提出的两类独立测试

**测试 A：极速网络补充。** 保留 Boson，禁用顾问，分别测缓存、外部检索、原文升级与最终写入。

**测试 B：知识模型补充。** 保留 Boson，网络禁用，只给顾问相同问题与范围，测知识正确率、不确定性与最终采用情况。此模式不能通过“最新/外部引用/完整名录”的严格验收；正确结果可以是明确说明无法核验。

在两类基础上加对照组与混合组：

| 实验组 | Boson | 网络 | 顾问 | 要回答的问题 |
| --- | --- | --- | --- | --- |
| G0 基线 | 相同版本 | 无 | 无 | 当前错误率是多少 |
| G1 网络 | 相同版本 | 有 | 无 | 资料能否纠错，延迟多少 |
| G2 顾问 | 相同版本 | 无 | 有 | 知识补充能否纠错，何时仍编造 |
| G3 混合 | 相同版本 | 有 | 有，并行 | 是否比单路显著更好，额外成本是否值得 |

每组使用相同任务范围和写入协议。记录模型版本、提示版本、供应商、日期、地区、缓存状态、参数和失败样本；真实联网结果会变化，另存证据快照用于回放，不混淆回放测试与 live 搜索。

### 11.2 题集

建议第一版 40 题 × 4 组 × 3 次重复，共 480 次真实 Boson 任务；先用小样本调通，之后冻结题集再跑。延迟基准另用更大检索样本测 p95，不用 3 次请求判断尾延迟。

| 场景 | 示例/检查点 |
| --- | --- |
| 完整名单 | 奥特曼名单，区分范围、截止时间、别名、形态与角色 |
| 虚构实体 | 故意加入不存在的名称；不强行补造百科 |
| 常识与冷门知识 | 看顾问是否在目标分布上比 Boson 强 |
| 新资料/日期 | 顾问知识不能替代最新来源 |
| 来源冲突 | 时间不同、统计口径不同，不做简单投票 |
| 摘要未包含事实 | 必须读取正文或保留不确定性 |
| 长目录/截断/分页 | 不把首屏列表称为完整 |
| 无结果/超时/429 | 不把服务故障当实体不存在 |
| 双路部分成功 | 网络成功顾问失败，及相反情况；类型不混淆 |
| 用户打断/改范围 | 旧结果、旧范围不能落入新文章 |
| 输入晚到 | 转写未到先发起写入，门禁应暂缓 |
| 写入冲突/回执丢失 | 不重复插入，不误报完成 |
| 工具绕过 | 用 apply operations 替代文章工具也必须过门禁 |
| 伪造来源/跨任务引用 | 不存在或其他任务的 sourceId 应拒绝 |
| 提示注入 | 网页和顾问中的工具指令不能生效 |
| 普通润色/虚构写作 | 不被错误强制联网 |

“奥特曼 A～Z”回归题要求输出真实、可核对的实体，不能用英文字母填满格式；测最终文档里是否仍出现虚构条目、范围偷换和无依据的完整标题。

### 11.3 指标与建议门槛

必须分别评价：**工具执行成功、资料取得成功、文档写入成功、用户任务完成**。

| 指标 | 建议初始验收条件 |
| --- | --- |
| 来源身份与引用映射 | 伪造/跨任务 sourceId 拦截率 100% |
| 强制门禁 | 标记需外部证据却无合格来源的写入，拦截率 100% |
| 范围披露 | 无法证明完整时，100% 不声称无范围限制的“全部” |
| 写入可靠性 | 故障注入测试无重复插入；回执未知不自动重放 |
| 事实正确率 | 建议较 G0 至少提升 10 个百分点，按任务子类报告区间与样本量 |
| 引用支持率 | 建议 ≥95%，由盲审检查“这句话是否被该片段支持” |
| 普通编辑误拦 | 单独记录，建议控制在 5% 以下并逐例修复 |
| 快速资料延迟 | 以 cache hit/miss 分组，外部路径目标 p50 ≤1s、p95 ≤2s |
| 最终文章延迟 | 记录说完→资料返回→写入确认，各阶段独立看 |
| 成本 | 每请求与每个正确完成任务的费用，同时记录失败/取消费用 |

这里的百分比是建议立项门槛，不是已达到的结果。少量样本不能证明可靠性；安全性硬规则靠程序和故障测试，语义质量靠更充分的真实样本与人工审核。

混合组如果没有超过最佳单路，就不默认开双路；如果顾问在目标题集不比 Boson 好，就更换顾问而非盲目加 agent；如果 Boson 有正确证据仍反复写错，才升级评估主模型或独立文章生成模型。

评审人员应分别检查顾问原始答案、网络证据、Boson 最终正文与实际文档，定位究竟是检索、知识、理解、引用还是写入出了问题。

## 12. 实施阶段与何时确实需要改 vRT / vdoc

### 阶段 0：只做可行性验证

- 核对 vdoc 发出的 `insert_structured_article` schema、结果格式及取消/幂等能力。
- 用当前安装 SDK 做一个服务端研究工具最小接线测试，验证 Boson 能收到工具结果并继续生成。
- 验证 rewrite 后发送给客户端的确实是最终参数；验证模型转写与任务关联。
- 固定题集并跑 G0，准备两家搜索和一到两个顾问候选的小样本。

完成标准：证明接线可行，列出真实协议缺口；不能只看 fake model 通过。

### 阶段 1：Server 最小可用版

- 实现两个研究工具、一家搜索/读取服务、一个顾问适配、三种模式。
- 增加来源表、任务范围、预算、取消、写入门禁与普通文本引用。
- 以现有文档工具写入并读回，补业务结果解析和故障恢复。
- Node 与 Worker 都跑适合的类型、架构和 E2E 检查；再跑真实 Boson。

先在受控环境比较 G1/G2，再比较 G3。第一阶段不开发长文草稿 UI、不加任意代码执行或通用浏览器。

### 阶段 2：只优化已经测出的瓶颈

先做有界缓存、请求合并、减少结果长度、预提取片段、区域优化。只有 p95 和费用数据证明必要，再做备用供应商、预取或更大索引。预取使用稳定的最终输入/受控短语，不在每次临时语音转写变化时请求外部服务。

### 何时才改 vRT

| 触发条件 | 优先处理 | 是否必须改核心 |
| --- | --- | --- |
| Server 工具缺少统一超时配置 | 工具内部实现 abort + deadline | 否 |
| 希望网络和顾问同时执行 | 一个 Server 工具内部并行 | 否 |
| 新研究工具被白名单拦截 | Server 配置与风险规则 | 否 |
| 业务错误类型较多 | Server payload 与日志规范 | 否 |
| 来源标记要变成文本引用 | Server rewrite 或预解析文本 | 否 |
| 已安装 SDK 实测丢取消、重复续生成、损坏工具结果 | 最小复现，确认通用运行时缺陷 | **确认缺陷后改 vRT** |
| 想让顾问晚到后跨轮次自动唤醒或采用通用并行调度 | 第一版不需要；确有产品需求再设计生命周期协议 | 可能 |
| 要在任何事实语音输出前强制等待研究完成 | 先测 Server 装饰器能否可靠门控；若事件模型不足再设计通用输出门控 | 可能；不属于第一版写入门禁保证 |

若确需修改 vRT，应修改 SDK 源码并运行对应检查、重新打包/升级 Server 使用的 tarball 与 lockfile；不能只改同目录源码或手工编辑 node_modules。

### 何时才改 vdoc

- 用户要求真正的脚注、点击跳转、来源预览、引用管理。
- 实测现有编辑器不支持所需原子写入/取消/去重，且产品要求更强保证。
- 需要断线后的持久写入结果查询，Server 读回无法可靠判定。
- 后续明确开发草稿预览、长文分节提交 UI。

这些属于有证据的能力缺口，而不是为了接入搜索预先改三端。

## 13. 最终推荐配置与交付物

**默认候选：网络单路 + 按需原文读取 + 强制写入门禁；知识顾问先作为独立实验开关。** 严格事实任务依赖网络证据，普通背景知识可使用顾问；双路只有验证出额外收益后再成为默认。

第一轮实施应交付：

1. Server 中可切换的 `web_only / knowledge_only / hybrid`。
2. `get_research_context / read_web_sources` 两个模型可见工具。
3. 来源注册、范围记录、预算与取消、可修复错误和写入门禁。
4. 沿用当前 vdoc 协议的普通文本引用与实际写入确认。
5. 真实 Boson 四组实验报告：质量、范围、引用支持、延迟、费用、失败样本。
6. 明确列出的剩余限制，而非“已接入搜索，所以幻觉已解决”。

本文没有执行付费模型调用或供应商性能测试，也没有连接真实 vdoc 验证其实现。核心结论是：**现有 Server 与 vRT 接口足以支持先做服务端方案；性能和质量通过实验验证，原生引用与严格写入保证按实际 vdoc 能力决定。**

工具职责、返回长度、可恢复错误与真实任务评测的设计原则参考了用户提供的 [Anthropic 工具设计实践](https://www.anthropic.com/research/writing-tools-for-agents)。本文的预算、门禁、性能目标和实施拆分是针对当前项目提出的方案，并非该文的原有承诺。
