# vdoc-server 架构

vdoc-server 是 vdoc 的语音会话服务端。它负责：谁能对哪篇文档开语音会话、语音 Agent 怎么配置、Agent 的每一次工具调用能不能执行，以及审计记录。实时语音本身由 [vRealTime（vRT）](https://github.com/austinchennn/vRT) 承担，模型是 Boson Higgs Realtime（可替换）。

**它不做的事**：不保存文档内容；不执行文档修改（工具在浏览器里的 vdoc 中执行）；不把文档内容写进日志。

## 1. 通用语言

| 术语 | 含义 |
|---|---|
| 文档（Document） | vdoc 里的一篇文档，用 `documentId` 标识。服务端只知道它的 id |
| 语音会话（Voice Session） | 一个主体就一篇文档与语音 Agent 交谈的一段时间。聚合根 |
| 主体（Principal） | 申请会话的一方：经 vdoc BFF 认证的登录用户（user），或在允许纯 client 鉴权时持有 API key 的 vdoc 安装（client） |
| 会话授权（Session Grant） | 短期有效、只针对一个会话和一篇文档的连接许可；签名令牌只是它的编码 |
| Agent 配置（Agent Profile） | Agent 怎么工作：指令模板、模型、音色、允许的工具、会话限额 |
| 工具调用（Tool Call） | 模型请求 App 执行一个工具，执行前要经过工具策略审查 |
| 风险等级（Risk） | low / medium / high，由操作风险表评估 |
| 确认（Confirmation） | 高风险修改第一次被拦下并要求询问用户；之后在**后面的轮次**里重复同一请求才放行 |
| 轮次（Turn） | 用户一次说话到 Agent 回应完毕 |
| 限额（Session Limits） | 授权有效期、会话最长时长、最大轮次数、每轮最多工具调用数 |

## 2. 限界上下文

```
┌──────────────────┐   授权指向会话    ┌──────────────────────┐
│ Access            │ ───────────────▶ │ Voice Session（核心）   │
│ Principal, Grant  │                  │ VoiceSession 聚合       │
└──────────────────┘                  │ Limits, Usage, Policy   │
                                       └──────────┬───────────┘
┌──────────────────┐   会话按配置创建            │ 审查工具调用时咨询
│ Agent Profile     │ ─────────────────────────▶ ▼
│ 指令、模型、工具清单 │                  ┌──────────────────────┐
└──────────────────┘                  │ Tool Governance        │
                                       │ 风险评估、策略责任链      │
                                       └──────────────────────┘
```

四个上下文都在 `packages/domain/src` 下，各占一个目录，通过 `index.ts` 对外暴露。

## 3. 聚合与不变量：`VoiceSession`

`VoiceSession` 是唯一的聚合根，所有修改都通过它的方法完成，每次状态变化都记录一个领域事件：

1. 一个会话只属于一个主体、一篇文档。
2. `granted → active → ended`，结束后永不重开。
3. 会话始终在限额内：没人连接的授权会过期；超过最长时长或最大轮次就结束。
4. 高风险工具调用必须在**更早的轮次**里被确认过，并且确认之后用户又有过输入（两轮确认，见 ADR 0003）。
5. 每轮工具调用有上限，防止 Agent 失控循环。

持久化用 Memento：仓储只保存 `toSnapshot()` 的纯数据，读取时 `VoiceSession.restore()`。

## 4. 分层与依赖规则

```
            apps（Node、Cloudflare Worker）          ← 运行时入口，只有它们碰 node: / cloudflare:
                         │
                    composition                     ← 组合根：唯一知道具体类的地方
             ┌───────────┼────────────┐
          adapters     config      （application、domain）
   http · vrt · security · memory · system · cloudflare
             │
        application  （用例 + 端口）
             │
           domain    （实体、值对象、领域服务；零依赖）
```

依赖只能向内。这条规则由两处保证：

- 每个包的 `package.json` 只声明允许的依赖；
- `npm run check:architecture`（[scripts/check-architecture.mjs](../scripts/check-architecture.mjs)）在 CI 中检查清单和源码 import：领域层与应用层不得依赖任何外部包，适配器之间互不依赖，`node:` 和 `cloudflare:` 只允许出现在 apps。

## 5. 包结构

| 包 | 层 | 职责 |
|---|---|---|
| `@vdoc-server/domain` | 领域 | 四个上下文的模型；零依赖 |
| `@vdoc-server/application` | 应用 | 用例（命令和查询）、端口接口、错误码、`VoiceSessionStore` 应用服务 |
| `@vdoc-server/config` | 配置 | 环境变量 → 校验后的 `ServerConfig`（启动时一次性报告所有问题）；内置的编辑助手配置 |
| `@vdoc-server/adapter-security` | 适配器 | HMAC-SHA-256 会话授权（支持换钥）、API key 鉴权（只存摘要，恒定时间比较）、可信用户鉴权（client key 通过后采信 BFF 的用户头） |
| `@vdoc-server/adapter-vrt` | 适配器 | 接入 vRealTime：模型注册表、每会话一个 Hub、hooks 接到用例、生命周期装饰器、开发用假模型 |
| `@vdoc-server/adapter-http` | 适配器 | 基于 Web 标准 `Request`/`Response` 的路由、控制器、CORS、problem+json |
| `@vdoc-server/adapter-memory` | 适配器 | 内存仓储和测试替身 |
| `@vdoc-server/adapter-system` | 适配器 | 系统时钟、随机 id、JSON 日志、审计日志、组合事件发布 |
| `@vdoc-server/adapter-cloudflare` | 适配器 | Durable Object 存储仓储（带过期清理） |
| `@vdoc-server/composition` | 组合 | `createServer()`：各运行时共用的装配 |
| `@vdoc-server/app-node` | 应用入口 | Node 进程：HTTP 桥接、`ws` 升级 |
| `@vdoc-server/app-worker` | 应用入口 | Cloudflare Worker：每篇文档一个 Durable Object |

## 6. 主要流程

```
vdoc（浏览器）                 vdoc-server                                      Boson
   │ POST /v1/documents/{doc}/voice-sessions   （Bearer client key）
   │ ───────────────────────▶ GrantVoiceSession：鉴权 → 并发策略 → 创建会话 → 签发授权
   │ ◀── 201 { sessionId, grant.token, realtimePath }
   │ WS realtimePath
   │ ───────────────────────▶ ResolveRealtimeRoute：会话存在且未结束才接受
   │ hello { auth: token, context }
   │ ───────────────────────▶ AuthorizeRealtimeConnection：验签 → 范围 → 连接
   │                          ConfigureRealtimeSession：配置 + 清洗过的文档上下文 → 指令
   │                                                                ──────────▶ session.update
   │ （语音）                                                         ◀──────── tool call
   │                          ReviewToolCall：风险评估 → 策略责任链 → allow / reject
   │ ◀── tool.call（仅放行的）                                                    
   │ ── tool.result ─────────▶ RecordToolResult（审计）               ──────────▶ function_call_output
   │                          CompleteTurn：计数、检查限额，必要时结束并挂断
   │ DELETE …/{sessionId}   或   断线超过续传窗口
   │ ───────────────────────▶ EndVoiceSession → RealtimeConnections.close()
```

## 7. 设计模式

| 模式 | 位置 | 作用 |
|---|---|---|
| 聚合 / 值对象 / 领域事件 | `VoiceSession`、`SessionGrant`、`SessionLimits`、`Usage` | 不变量集中在一处，状态变化可审计 |
| 仓储 + Memento | `VoiceSessionRepository`、`toSnapshot/restore` | 存储与模型解耦，换存储不改领域 |
| 端口与适配器 | `application/src/ports`、`packages/adapters/*` | 用例只依赖接口 |
| 命令 / 用例 | `application/src/use-cases/*` | 每个用例一个类、一个 `execute` |
| 结果对象 | `Result<T, E>` | 预期失败作为值传递，不靠异常跨层 |
| 责任链 | `ToolPolicy` + `ToolRule` | 新规则只加不改 |
| 策略 | `CallerAuthenticator`、`ModelProvider`、`ConcurrencyStrategy` | 可替换的行为 |
| 注册表 + 工厂 | `ModelRegistry`、`createApplication`、`createServer` | 新模型一行注册 |
| 装饰器 / 代理 | `withLifecycle` | 不改模型即可观察会话开关 |
| 观察者 + 组合 | `EventPublisher`、`CompositeEventPublisher` | 审计、指标等订阅者随意增加 |
| 防腐层 | `fromDomain()`、`toSessionConfig()` | 领域错误码、vRT 配置不外泄 |
| 组合根 | `@vdoc-server/composition` | 唯一知道具体类的地方 |

## 8. SOLID 对照

- **单一职责**：控制器只做 HTTP 翻译；用例只编排；规则只判断一件事。
- **开闭**：新增工具规则、模型、鉴权方式、事件订阅者都只需新增类并注册，不改已有代码。
- **里氏替换**：`DurableObjectVoiceSessionRepository` 和 `InMemoryVoiceSessionRepository` 可互换，端到端测试用后者，生产用前者。
- **接口隔离**：端口都很小（`Clock` 一个方法），`RealtimeHandlers` 只取需要的用例。
- **依赖倒置**：应用层定义端口，适配器实现；组合根负责注入。

## 9. 扩展指南

| 想做的事 | 改哪里 |
|---|---|
| 换或加一个模型（cascade-claude 是一个例子：`providers/cascade.ts`） | 在 `adapter-vrt/src/providers/` 加一个 `ModelProvider`，在 `createModelRegistry` 里注册；配置里加一个 provider 名 |
| 加一条工具规则（比如工作时间外禁止删除） | 在 `domain/src/tool-governance/rules/` 实现 `ToolRule`，用 `defaultToolPolicy().with(rule)` 组装 |
| 调整风险分级 | 改 `VDOC_RISK_TABLE`（纯数据） |
| 换一种用户鉴权（比如直接校验身份提供方的 JWT，替代 BFF 用户头） | 新写一个 `CallerAuthenticator`，在组合根替换 `TrustedUserAuthenticator` |
| 换存储（Postgres、D1） | 实现 `VoiceSessionRepository`，用快照存取 |
| 加审计或指标去向 | 实现 `EventPublisher`，通过 `createServer({ subscribers })` 传入 |
| 新运行时（Bun、Deno） | 新建 `apps/<runtime>`，复用 `createServer()`；只需桥接 HTTP 和 WebSocket |
| 新的 Agent 配置 | 在 `config/src/profiles/` 加一个工厂，注册进配置仓储 |

## 10. 安全要点

- 会话授权放在 WebSocket 的 `hello` 消息里，不放 URL；有效期默认 60 秒，客户端每次重连都向 `/grants` 重新申请。
- 签名密钥可轮换（`VDOC_SERVER_SIGNING_KEYS` 的第一把用来签名，其余只用来验签）；API key 只保存 SHA-256 摘要，比较时间恒定。
- 不属于自己的会话一律返回 404，不暴露会话是否存在。
- 文档标题、语言、词汇等上下文先清洗、限长，再以引号包裹的数据形式放进指令，防止提示词注入；指令里也明确说明文档内容不是指令。
- 审计事件只记录工具名、风险、操作类型和结果，不记录参数内容。
- 实时路由先检查会话再接受；会话已结束或不存在时接受后立刻用关闭码（4410、4404）断开，浏览器才能看到原因。
- 生产环境拒绝假模型、拒绝 `*` 来源、要求显式配置所有密钥。
