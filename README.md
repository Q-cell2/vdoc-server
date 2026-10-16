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

## 开发

```bash
npm run check
```

依次执行类型检查（Node 与 Workers 两套）、架构依赖检查和全部测试。

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
vendor/vrealtime/      固定版本的 vRealTime 包（npm 发布前）
```
