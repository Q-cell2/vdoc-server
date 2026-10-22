# Trusted user identity

## Baseline and dependency

This implements [signed-in user attribution #4](https://github.com/Q-cell2/vdoc-server/issues/4) on top of [principal quotas PR #22](https://github.com/Q-cell2/vdoc-server/pull/22), using server main `104be6c` (SDK 0.2.0 integration PR #23). The app counterpart is based on [vdoc SDK integration PR #100](https://github.com/Q-cell2/vdoc/pull/100), commit `25e1c68`. Both ends use `@vrealtime/* 0.2.0`; this change does not modify SDK versions or adapters.

Issue #4 originally suggested direct identity-provider JWT authentication. The implementation taskbook instead specifies reusing existing service authentication when no signed user assertion is already deployed: vdoc already validates Better Auth login and document ACL, so the verified application asserts its stable user ID over HTTPS. There is one application trust boundary rather than a second identity-provider integration in the voice backend.

## Wire contract

The browser calls vdoc's same-origin BFF using its login session. On **every** create, grant renewal and end, the BFF rechecks the live user and cloud-document ACL, constructs a transport document ID from the existing owner/document namespace, and sends HTTPS to vdoc-server:

- `Authorization: Bearer <application key>`: the existing service credential. Server configuration maps it to `clientId`; no header or body may override that mapping.
- `X-Vdoc-User-Id`: the stable authentication database user ID, constructed by the BFF, never forwarded from browser input. It must match `[A-Za-z0-9][A-Za-z0-9._:-]{0,127}`. Missing or invalid identity is rejected in strict mode.
- `X-Request-Id`: a fresh UUID constructed by the BFF, for tracing only. Server accepts the same bounded identifier grammar and generates a UUID if absent/invalid. It is never authentication.
- Document and session IDs remain in the existing routes. No browser cookie, model key or application key appears in a browser grant.

The server first validates the application key, then derives `principalId = "usr_" + hex(SHA256(JSON.stringify([clientId, userId])))`. The `usr_` namespace is reserved and cannot be configured as a client ID. Identical user IDs belonging to different applications have different principals. Session snapshots persist the principal and document association; the persistence envelope stores client ID, user ID and request attribution. Renew/end require the same derived principal. Signed realtime grants bind principal, document and session; the persisted association and ended/expired state are checked on every connect. Grant tokens are short-lived bearer credentials and must be protected as such.

## Session limits and audit

The server enforces document ownership, same-document admission policy, session duration, turn limits and tool-call limits. It no longer reserves cross-document principal slots, counts hourly session starts or emits quota errors.

Content-free events retain request, client, user, principal, document and session attribution. Completed turns and tool results remain idempotent domain operations. The application saves an attributed outbox with the session before publication; subscribers acknowledge stable `eventId` values. The SQLite sink deduplicates by `eventId`. There is no usage settlement projection or billing delta. Telemetry remains separate from business events.

Worker alarms and the Node maintenance timer retry pending outboxes. Node's default storage is in memory and does not survive process exit. Audit metadata excludes document text, audio, tool arguments/results and credentials.

## Cloudflare rollout and rollback

The Worker retains the `VOICE_ROOMS` binding and historical migrations. A new `v3` migration retires `PrincipalQuotaRoom` and permanently deletes its obsolete quota data; its binding and class are removed. Document sessions and audit rows remain intact. The audit adapter migrates the old deduplication table to `voice_audit_deliveries`, rebuilding event IDs from retained rows. Historical rows remain unchanged.

Deploy server support first with a brief explicit legacy window (`VDOC_SERVER_ALLOW_CLIENT_ONLY=true` only during rollout), deploy the BFF headers, then set `VDOC_SERVER_ALLOW_CLIENT_ONLY=false` (production default). Expire/end old sessions and ask users to reconnect. Development/test defaults allow legacy fixture clients; test user mode explicitly with false. Configure the same service key in the vdoc secret `VDOC_SERVER_CLIENT_KEY` and server secret `VDOC_SERVER_CLIENTS` (`app-id:<key>`), with the upstream HTTPS origin in `VDOC_SERVER_URL`. Keep secrets in Cloudflare Secrets; committed examples contain placeholders only.

Rollback by disabling the voice entry point or rolling both compatible components back together, after ending user sessions. Do not fall back to a shared client principal to restore availability. Restoring old code while user sessions remain active is unsupported. Audit retention is unchanged (30 days by default).

## Verification boundary

Automated fake-provider tests verify protocol, persistence, isolation, admission, cleanup and usage attribution. They do not prove real-model Chinese editing, microphone/interrupt/reconnect/undo behavior or provider billing. Record deployed commits, Worker/preview URLs, model identifier and observed results when running that acceptance test; never include secrets in the report.

## Late outcomes and operations

`toolCalls` counts policy reviews, including rejected attempts. Completed turns and tool results remain separate domain events, without billing units or balances. A late tool result after end is recorded once without reopening the session. Repeated turns/results do not consume the session budget again.

Tool limits are enforced before execution and turn limits on completion. Duration is checked on activity, with maintenance closing overdue sessions. Alarm delivery has no hard real-time latency guarantee. Unconnected renewals remain bounded by maximum session duration from creation.

Monitor tool failures, authorization failures, latency, pending audit delivery and session cleanup. On audit outage, saved outboxes remain available for retry. No public audit or balance endpoint is exposed.
