# vdoc-server

vdoc 的语音会话服务端：为文档签发语音会话、配置语音 Agent、审查 Agent 的每一次工具调用并留下审计记录。实时语音由 [vRealTime（vRT）](https://github.com/austinchennn/vRT) 承担，默认语音模型是 Boson Higgs Realtime；同时配置 Anthropic 密钥时默认由后台 Pi Agent 执行任务，Higgs 只负责听和说。

文档修改在浏览器中的 vdoc 里执行；读取结果进入后台模型的任务上下文，不写入普通日志或持久文档存储。服务端负责任务编排和权限审查。

架构说明见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)，关键决定见 [docs/adr](docs/adr)。

Cloudflare 的领域审计事件同时写入文档房间的 SQLite，可按会话分页查询；字段白名单、保留期与内部查询方式见 [持久审计](docs/AUDIT.md)。

## 快速开始

Node 22.19+。

```bash
npm install
npm run dev
```

开发模式下不需要任何密钥：使用脚本化的假模型（只理解文字，不理解语音）、随机签名密钥和开发用 client key `vdoc-dev-client-key-not-for-production`，启动日志会列出这些默认值。默认监听 `http://127.0.0.1:8787`。

用 Boson：

```bash
BOSON_API_KEY=... VDOC_SERVER_MODEL=boson npm run dev
```

使用后台 worker agent（需要两把密钥，不需要 OpenAI 密钥）：

```bash
BOSON_API_KEY=... ANTHROPIC_API_KEY=... VDOC_SERVER_MODEL=boson-worker npm run dev
```

本地 Node 开发模式可直接打开 `http://localhost:8787/` 测试麦克风、文字流与独立测试文档。
根目录已忽略的 `.env` 会在 `npm run dev` 启动时读取；不要把模型密钥填进浏览器。
页面仅接受本机请求，生产模式和 Cloudflare 不提供此调试入口。
这不是完整 vdoc 编辑器：支持新建/切换测试文档、直接输入、文章插入与最近一次插入的撤销；刷新会清空测试文档。

Higgs 没有任何工具：服务端拿到最终转写（或打字输入）就直接启动 Pi，Higgs 只朗读 Pi 的回复。Pi 决定所有文档工具调用并接收实际结果。
权限、确认、版本校验、客户端去重继续沿用现有通道。文字与工具参数增量沿用现有事件；
vdoc 是否显示它们取决于已有 UI。详见 [Worker agent 架构](docs/WORKER_AGENT.md)。
显式设置 `VDOC_SERVER_MODEL=boson` 可恢复旧模式。

申请一个语音会话：

```bash
curl -s -X POST http://127.0.0.1:8787/v1/documents/my-doc/voice-sessions -H "Authorization: Bearer vdoc-dev-client-key-not-for-production"
```

浏览器端用 `@vrealtime/client` 连接返回的 `realtimePath`，把 `grant.token` 作为 `auth`，并在每次重连前调用 `/grants` 换一个新令牌：

```ts
const session = await connect(`wss://voice.example.com${created.realtimePath}`, {
  auth: () => renewGrant(created.sessionId), // POST …/voice-sessions/{id}/grants
  context: { documentId, title, language: 'zh-CN', vocabulary },
  tools: documentTools,
  audio: { input: 'mic', output: 'speaker' },
});
```

## HTTP API

所有接口都要带 `Authorization: Bearer <client key>`。vdoc 的 BFF 还会带上 `X-Vdoc-User-Id`（它校验过的登录用户 ID）
和可选的 `X-Request-Id`；这两个头只在 client key 校验通过后才被采信，因此 client key 只能放在服务端，
浏览器只拿短期 grant，详见 [可信用户身份](docs/TRUSTED_USER_IDENTITY.md)。错误统一返回 `application/problem+json`，其中 `code` 字段稳定可用。

| 方法 | 路径 | 说明 |
|---|---|---|
| `POST` | `/v1/documents/{documentId}/voice-sessions` | 签发会话，返回 `sessionId`、`grant`、`realtimePath`；同一文档已有会话时默认顶替它 |
| `GET` | `/v1/documents/{documentId}/voice-sessions/{sessionId}` | 会话状态与用量 |
| `POST` | `/v1/documents/{documentId}/voice-sessions/{sessionId}/grants` | 重新签发短期授权（重连前调用） |
| `DELETE` | `/v1/documents/{documentId}/voice-sessions/{sessionId}` | 结束会话并断开实时连接 |
| `GET` (WebSocket) | `/v1/documents/{documentId}/voice-sessions/{sessionId}/realtime` | vRealTime 协议；授权放在 `hello.auth` |
| `GET` | `/healthz` | 健康检查 |

实时连接被拒绝时的关闭码：`4401` 授权无效，`4404` 会话不存在，`4410` 会话已结束。

服务端按文档隔离会话与工具权限，保留单次会话时长、轮次和工具调用限制。
不再维护跨文档并发配额、每小时创建额度或使用量结算。

## 配置

客户端可用 `session.setContext({ documentId, title, language, vocabulary })` 更新语音会话的文档上下文；重连时的 `hello.context` 也会刷新模型配置。更新沿用初始上下文的清洗与长度限制，不能切换文档，已结束会话拒绝更新。支持动态指令的模型通过公开的 `RealtimeSession.update()` 接收指令与转写提示；不支持的模型保留初始配置。上下文属于该文档的这一次语音会话，覆盖其所有实时连接；慢模型更新期间只保留最新的待处理快照。

| 变量 | 说明 |
|---|---|
| `VDOC_SERVER_ENV` | `development`（默认）、`test`、`production` |
| `VDOC_SERVER_SIGNING_KEYS` | `id:secret,…`，secret 至少 32 字符。第一把签名，全部用于验签（换钥时把新钥放第一位） |
| `VDOC_SERVER_CLIENTS` | `clientId:key,…`，key 至少 24 字符 |
| `VDOC_SERVER_ALLOW_CLIENT_ONLY` | 是否接受不带 `X-Vdoc-User-Id` 的请求。生产默认 `false`，开发与测试默认 `true`；只在迁移窗口内临时设为 `true` |
| `VDOC_SERVER_ALLOWED_ORIGINS` | 允许跨域访问的浏览器来源，逗号分隔 |
| `VDOC_SERVER_MODEL` | `boson-worker`（Higgs 单工具 + Pi 后台 agent）、`boson`（旧版直接执行）、`openai`、`cascade-claude`、`fake`，可写成 `boson:<model>`。`cascade-claude` 是语音识别 + Claude + 语音合成，默认 `claude-opus-5-5`，可写成 `cascade-claude:<Claude 模型>` |
| `VDOC_SERVER_WORKER_MODEL` | Pi 后台 Anthropic 模型，默认 `claude-sonnet-5-5`，须存在于固定版本的 Pi 模型目录 |
| `VDOC_SERVER_WORKER_TIMEOUT_MS` | 后台任务总超时，默认 90000，最大 300000；含模型生成和工具等待 |
| `VDOC_SERVER_WORKER_MAX_REQUESTS` | 后台每任务模型请求次数，默认/最大 12；实际工具仍受每轮 12 次调用的治理限制 |
| `BOSON_API_KEY` / `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` | 模型密钥。`cascade-claude` 需要 `ANTHROPIC_API_KEY`（Claude）和 `OPENAI_API_KEY`（语音识别与合成） |
| `VDOC_SERVER_CONCURRENCY` | 同一文档已有会话时：`supersede`（默认，顶替）或 `reject` |
| `VDOC_SERVER_GRANT_TTL_SECONDS` | 授权有效期，默认 60 |
| `VDOC_SERVER_MAX_SESSION_MINUTES` | 会话最长时长，默认 30 |
| `VDOC_SERVER_MAX_TURNS` | 最大轮次，默认 300 |
| `VDOC_SERVER_MAX_TOOL_CALLS_PER_TURN` | 每轮最多工具调用，默认 12 |
| `VDOC_SERVER_LOG_LEVEL` | `debug`、`info`（默认）、`warn`、`error` |
| `PORT`、`HOST` | 仅 Node，默认 `8787`、`127.0.0.1` |

生产环境缺少任何必需项时，服务会在启动时一次性列出所有问题并退出。

## 部署到 Cloudflare

每篇文档一个 Durable Object（见 [ADR 0004](docs/adr/0004-one-durable-object-per-document.md)）。
会话快照保存在 SQLite-backed Durable Object 的持久化存储中；对象或运行时重启后可恢复。
同一文档的应用命令串行执行，避免并发授权和计数更新互相覆盖。
Alarm 会结束未使用的过期授权及达到时长限制的会话，并在结束七天后清理快照，
不需要等待下一次用户请求。详见 [会话存储与生命周期](docs/CLOUDFLARE_SESSION_LIFECYCLE.md)。
两个 Wrangler 配置保留 `v1` / `v2` 历史迁移，并新增 `v3` 删除旧配额对象；
当前仅绑定文档房间。部署 `v3` 会永久删除旧配额对象数据，不影响文档房间与审计记录。

```bash
npx wrangler secret put VDOC_SERVER_SIGNING_KEYS --cwd apps/worker
```

```bash
npx wrangler secret put VDOC_SERVER_CLIENTS --cwd apps/worker
```

```bash
npx wrangler secret put BOSON_API_KEY --cwd apps/worker
```

```bash
npx wrangler secret put ANTHROPIC_API_KEY --cwd apps/worker
```

```bash
npm run deploy -w @vdoc-server/app-worker
```

本地运行 Worker：在 `apps/worker/.dev.vars` 里写入配置后执行 `npm run dev -w @vdoc-server/app-worker`。

### Workers Builds / PR 预览

在 Cloudflare 的 `vdoc-server → Settings → Builds` 中分别设置生产和非生产分支命令。
生产命令位于 **Production → Deploy command**，预览命令位于
**Previews Base → Preview command**；不要将预览命令填入左侧的 Build command。
项目根目录保持 `/`，Build command 留空：

| 用途 | 命令 |
| --- | --- |
| 生产分支部署 | `npx wrangler deploy --config apps/worker/wrangler.jsonc` |
| 非生产分支 / PR 预览 | `npx wrangler preview --config apps/worker/wrangler.jsonc` |

仓库根目录也提供 `wrangler.jsonc`，因此面板默认的 `npx wrangler preview` 可以直接运行。
根配置与 `apps/worker/wrangler.jsonc` 指向同一入口并保持配置一致，CI 测试会检查两者是否发生漂移。
上表保留显式路径，方便核对面板使用的配置；修改部署配置时需要同步两份文件。
`preview` 命令要求配置中包含 `previews`；仅配置生产部署命令不会修复 PR 预览。
修改面板中的非生产分支命令后，重试 PR 分支的构建，确认日志实际执行了带 `--config` 的命令。
保存后刷新设置页确认命令保留。如果重试日志仍显示旧命令，应通过 PR 分支的新提交触发新构建，
并再次核对日志中的 `Executing user deploy command`。
不要将 PR 预览命令改成 `deploy`，以免把未合并的代码发布到生产环境。

`previews` 显式声明变量和 `VOICE_ROOMS` 绑定；本 Worker 的 Durable Object 类没有
`script_name`，Cloudflare 为每个 Preview 创建独立的命名空间和存储。迁移声明仍保留在顶层。
预览同样启用生产级配置校验，不会回退到开发凭据或假模型。

生产 Secrets 不会自动成为预览 Secrets。需要实际测试语音接口时，在 **Previews Base**
配置独立的 `VDOC_SERVER_SIGNING_KEYS`、`VDOC_SERVER_CLIENTS`、`BOSON_API_KEY`、`ANTHROPIC_API_KEY`，
不要将密钥写进仓库。Base 密钥变更只影响之后新建的 Preview；已有 Preview 需单独更新。
`/healthz` 成功只表示 Worker 可访问，不能证明上述密钥和语音接口已验证。

可在本地或 CI 执行 `npx wrangler deploy --dry-run --config apps/worker/wrangler.jsonc`
检查打包；此命令不会发布，也不能验证 Cloudflare 账号权限和远端预览部署结果。
参见 Cloudflare 的 [预览配置](https://developers.cloudflare.com/workers/previews/configuration/)
和 [Durable Object 预览隔离](https://developers.cloudflare.com/workers/previews/resources/#durable-objects)。

## 开发

```bash
npm run check
```

依次执行类型检查（Node 与 Workers 两套）、架构依赖检查及单元、Node E2E、Durable Object 存储测试。

```bash
npm test -w @vdoc-server/app-worker
```

单独启动真实 workerd，使用临时配置、存储和假模型验证 Worker 的授权续签、WebSocket 升级、
客户端工具调用及审计、结束后断连与 `4410` 拒绝重连。无需真实密钥；CI 的独立 `worker` job 执行此命令。

轮次延迟、工具审查与执行结果会输出为带 `metrics: true` 的 JSON 指标日志，字段与采集边界见 [语音指标](docs/METRICS.md)。

### 日志查看器

```bash
npm run dev:logs   # 照常启动本地服务，同时把输出追加到 scripts/log-viewer/logs/local.jsonl
npm run logs       # 打开 http://localhost:8790
```

页面按语音会话整理本地与线上日志：顶部列出警告、错误、失败或被拒绝的工具调用，并对常见错误码给出中文解释；
点左侧会话可查看完整时间线和原始 JSON。点「连接线上实时日志」会在仓库根目录运行
`npx wrangler tail vdoc-server --format json`，需先 `npx wrangler login` 且有该 Cloudflare 账号权限；
只接收连接之后的日志，抓到的线上日志会存到 `scripts/log-viewer/logs/production.jsonl`，查看器重启后仍在。
`logs/` 已被 git 忽略。端口用 `VDOC_LOG_VIEWER_PORT` 覆盖，只监听 `127.0.0.1`。

## 包结构

```
packages/
  domain/              领域模型（零依赖）
  application/         用例与端口
  config/              配置解析与内置 Agent 配置
  composition/         组合根
  adapters/
    security/          HMAC 会话授权、API key 与可信用户鉴权
    vrt/               vRealTime 接入
    http/              HTTP API
    memory/            内存仓储与测试替身
    system/            时钟、id、日志、审计
    cloudflare/        Durable Object 存储
apps/
  node/                Node 运行时
  worker/              Cloudflare Worker 运行时
```
