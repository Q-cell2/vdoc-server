# vdoc-server

vdoc 的语音会话服务端：为文档签发语音会话、配置语音 Agent、审查 Agent 的每一次工具调用并留下审计记录。实时语音由 [vRealTime（vRT）](https://github.com/austinchennn/vRT) 承担，默认模型是 Boson Higgs Realtime。

文档内容不经过服务器保存，文档修改在浏览器中的 vdoc 里执行；服务端只决定"能不能做"。

架构说明见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)，关键决定见 [docs/adr](docs/adr)。

## 快速开始

Node 22.13+。

```bash
npm install
npm run dev
```

开发模式下不需要任何密钥：使用脚本化的假模型（只理解文字，不理解语音）、随机签名密钥和开发用 client key `vdoc-dev-client-key-not-for-production`，启动日志会列出这些默认值。默认监听 `http://127.0.0.1:8787`。

用 Boson：

```bash
BOSON_API_KEY=... VDOC_SERVER_MODEL=boson npm run dev
```

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

所有接口都要带 `Authorization: Bearer <client key>`。错误统一返回 `application/problem+json`，其中 `code` 字段稳定可用。

| 方法 | 路径 | 说明 |
|---|---|---|
| `POST` | `/v1/documents/{documentId}/voice-sessions` | 签发会话，返回 `sessionId`、`grant`、`realtimePath`；同一文档已有会话时默认顶替它 |
| `GET` | `/v1/documents/{documentId}/voice-sessions/{sessionId}` | 会话状态与用量 |
| `POST` | `/v1/documents/{documentId}/voice-sessions/{sessionId}/grants` | 重新签发短期授权（重连前调用） |
| `DELETE` | `/v1/documents/{documentId}/voice-sessions/{sessionId}` | 结束会话并断开实时连接 |
| `GET` (WebSocket) | `/v1/documents/{documentId}/voice-sessions/{sessionId}/realtime` | vRealTime 协议；授权放在 `hello.auth` |
| `GET` | `/healthz` | 健康检查 |

实时连接被拒绝时的关闭码：`4401` 授权无效，`4404` 会话不存在，`4410` 会话已结束。

## 配置

| 变量 | 说明 |
|---|---|
| `VDOC_SERVER_ENV` | `development`（默认）、`test`、`production` |
| `VDOC_SERVER_SIGNING_KEYS` | `id:secret,…`，secret 至少 32 字符。第一把签名，全部用于验签（换钥时把新钥放第一位） |
| `VDOC_SERVER_CLIENTS` | `clientId:key,…`，key 至少 24 字符 |
| `VDOC_SERVER_ALLOWED_ORIGINS` | 允许跨域访问的浏览器来源，逗号分隔 |
| `VDOC_SERVER_MODEL` | `boson`、`openai`、`fake`，可写成 `boson:<model>` |
| `BOSON_API_KEY` / `OPENAI_API_KEY` | 模型密钥 |
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
配置独立的 `VDOC_SERVER_SIGNING_KEYS`、`VDOC_SERVER_CLIENTS`、`BOSON_API_KEY`，
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

## 包结构

```
packages/
  domain/              领域模型（零依赖）
  application/         用例与端口
  config/              配置解析与内置 Agent 配置
  composition/         组合根
  adapters/
    security/          HMAC 会话授权、API key 鉴权
    vrt/               vRealTime 接入
    http/              HTTP API
    memory/            内存仓储与测试替身
    system/            时钟、id、日志、审计
    cloudflare/        Durable Object 存储
apps/
  node/                Node 运行时
  worker/              Cloudflare Worker 运行时
```
