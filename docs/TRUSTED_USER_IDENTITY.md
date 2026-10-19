# Trusted user identity and quotas

## Baseline and dependency

This implements [signed-in user attribution #4](https://github.com/Q-cell2/vdoc-server/issues/4) on top of [principal quotas PR #22](https://github.com/Q-cell2/vdoc-server/pull/22), using server main `104be6c` (SDK 0.2.0 integration PR #23). The app counterpart is based on [vdoc SDK integration PR #100](https://github.com/Q-cell2/vdoc/pull/100), commit `25e1c68`. Both ends use `@vrealtime/* 0.2.0`; this change does not modify SDK versions or adapters.

Issue #4 originally suggested direct identity-provider JWT authentication. The implementation taskbook instead specifies reusing existing service authentication when no signed user assertion is already deployed: vdoc already validates Better Auth login and document ACL, so the verified application asserts its stable user ID over HTTPS. There is one application trust boundary rather than a second identity-provider integration in the voice backend.

## Wire contract

The browser calls vdoc's same-origin BFF using its login session. On **every** create, grant renewal and end, the BFF rechecks the live user and cloud-document ACL, constructs a transport document ID from the existing owner/document namespace, and sends HTTPS to vdoc-server:

- `Authorization: Bearer <application key>`: the existing service credential. Server configuration maps it to `clientId`; no header or body may override that mapping.
- `X-Vdoc-User-Id`: the stable authentication database user ID, constructed by the BFF, never forwarded from browser input. It must match `[A-Za-z0-9][A-Za-z0-9._:-]{0,127}`. Missing or invalid identity is rejected in strict mode.
- `X-Request-Id`: a fresh UUID constructed by the BFF, for tracing only. Server accepts the same bounded identifier grammar and generates a UUID if absent/invalid. It is never authentication.
- Document and session IDs remain in the existing routes. No browser cookie, model key or application key appears in a browser grant.

The server first validates the application key, then derives `principalId = "usr_" + hex(SHA256(JSON.stringify([clientId, userId])))`. The `usr_` namespace is reserved and cannot be configured as a client ID. Identical user IDs belonging to different applications have different principals. Session snapshots persist principal kind, client ID, user ID, document ID and creation request ID. Renew/end require the same derived principal. Signed realtime grants bind principal, document and session; the persisted association and ended/expired state are checked on every connect. Grant tokens are short-lived bearer credentials and must be protected as such.

## Quota units and lifecycle

Existing #22 limits apply to the derived principal, across all documents/tabs: concurrent granted/active sessions, and new sessions per rolling 3,600,000 ms. A pending creation reserves both limits atomically in one principal Durable Object. Persisted creation confirms the start; a provably failed creation cancels its unconsumed reservation. A confirmed start stays in the rate window after end. Reconnect, renewal and repeated end never consume a second start. Pending reservations and concurrent slots have leases, so missed DELETE and crashes cannot occupy a slot forever. Quota RPC/storage failures return `503 QUOTA_UNAVAILABLE`; no local or shared-client fallback is used.

`429 QUOTA_EXCEEDED` includes `quotaKind` (`concurrency` or `rate`), integer `retryAfterSeconds`, and `Retry-After`. End/cleanup does not require a new reservation. Admitted sessions remain bounded by existing max duration, turns, and tool calls per turn. These are admission/activity limits, **not** money or provider-token balances. Duration is recorded in milliseconds, turns and tool calls in counts; missing provider cost is unknown, never inferred from elapsed time.

## Audit and settlement

Content-free events carry timestamp, request ID, client ID, user ID, principal ID, document ID and session association. Creation, renewal, connection, quota rejection, turns, tool outcomes and end/expiry are covered. Completed turn/call IDs are persisted for idempotency; settlement IDs identify usage events. Usage and a content-free outbox are saved in the same session snapshot before publication. Each event has a persisted monotonic event ID. Successful publication is acknowledged by a second snapshot save. Cloudflare alarms retry pending deliveries (30-second scheduling interval; platform delays/retries may add latency); ended snapshots with pending events are retained until delivered. The SQLite sink transactionally deduplicates event/settlement IDs. Other sinks can observe at-least-once delivery and must deduplicate by these IDs. Node serializes application commands and retries outboxes on subsequent commands or the explicit recovery hook, but its in-memory storage does not survive process exit; production durability guarantees apply to Workers. No audio, document text, tool arguments, cookies, keys or grants are persisted in audit metadata. Provider cost/billing settlement is not implemented by this change.

## Cloudflare rollout and rollback

The audit adapter lazily creates the additional `voice_audit_settlements` table and retention index in each existing document SQLite database. No new binding or Durable Object migration class is required: retain `VOICE_ROOMS` and `PRINCIPAL_QUOTAS` and their existing SQLite migrations. Snapshot fields and quota confirmation flags are additive; old starts without a flag are treated as confirmed. Old client sessions retain their old principal and are never relabelled as a user.

Deploy server support first with a brief explicit legacy window (`VDOC_SERVER_ALLOW_CLIENT_ONLY=true` only during rollout), deploy the BFF headers, then set `VDOC_SERVER_ALLOW_CLIENT_ONLY=false` (production default). Expire/end old sessions and ask users to reconnect. Development/test defaults allow legacy fixture clients; test user mode explicitly with false. Configure the same service key in the vdoc secret `VDOC_SERVER_CLIENT_KEY` and server secret `VDOC_SERVER_CLIENTS` (`app-id:<key>`), with the upstream HTTPS origin in `VDOC_SERVER_URL`. Keep secrets in Cloudflare Secrets; committed examples contain placeholders only.

Rollback by disabling the voice entry point or rolling both compatible components back together, after ending user sessions. Do not fall back to a shared client principal or remove quotas to restore availability. Restoring old code while user sessions remain active is unsupported. Audit retention is unchanged (30 days by default).

## Verification boundary

Automated fake-provider tests verify protocol, persistence, isolation, admission, cleanup and usage attribution. They do not prove real-model Chinese editing, microphone/interrupt/reconnect/undo behavior or provider billing. Record deployed commits, Worker/preview URLs, model identifier and observed results when running that acceptance test; never include secrets in the report.

## Missing or late usage, stopping and operations

`toolCalls` counts unique policy reviews (including rejected attempts); `tool-result` audit deltas count unique completed outcomes, and `turn` deltas count unique completed turns. They are different units and must not be added as a money balance. Replaying a completed turn/result or reconnect does not add another delta. Interruption does not refund a session start or completed work. A late tool outcome after end is attributed once without reopening the session or increasing its reviewed-call budget. Missing model metrics remain absent; no fabricated duration-to-token or price conversion is settled. There is no provider monetary allowance in #22.

The hourly start allowance stops new sessions immediately at admission; already admitted sessions may continue within their configured max turns/duration. At most the configured concurrent sessions remain in flight. Turn limits are checked on completion; tool execution is checked before each call (at most the configured calls per turn admitted). Duration is checked on use-case activity and a persisted Worker alarm closes the connection. Alarm delivery has no hard real-time latency guarantee. Unconnected grant renewals are bounded by max session duration since creation, rather than extending a slot forever.

Monitor `QUOTA_EXCEEDED` by kind, `QUOTA_UNAVAILABLE`, audit/storage request failures, pending outbox count/age via existing internal storage inspection and alarm failures, plus grant/end usage events. Public audit or quota-balance APIs are not added. On quota outage, keep admission closed and repair the binding/storage; never bypass the principal room. On audit outage, usage stays in the snapshot/outbox and publication failures remain visible; repair storage, then let alarms retry. Old node-only sessions cannot be recovered after process loss; they are development/single-process state, not a replacement for Worker durability.
