# vRealTime 0.2.0 integration

> Historical report: cross-document principal quotas and usage settlement have since been removed. Quota rejection/lease tests and billing-delta acceptance items below describe the earlier implementation, not the current contract. Current behavior is documented in TRUSTED_USER_IDENTITY.md and AUDIT.md.

The realtime adapter and both runtime test clients use the published 0.2.0 packages. Keep `@vrealtime/server`, `core`, `boson`, `openai`, `openai-compatible`, `protocol`, `testing`, and `client` on the same release. Application workspace packages retain their existing versions.

## Protocol and lifecycle

- The application HTTP session/grant routes and `vg1` grant format are unchanged. A new grant is requested before each SDK reconnect; the voice session ID remains distinct from the SDK transport session ID.
- The 0.2.0 Hub and client negotiate `tool-stream-v1` and `global-tool-ids-v1`. Lifecycle progress does not execute document edits: only the final client `tool.call` invokes the registered tool.
- Provider call IDs may be reused across responses. The SDK emits distinct public IDs and maps results back to the original provider IDs. Policy hooks and audit events continue to receive the SDK public ID.
- Reconnecting within the configured resume window restores the same model session, capabilities and in-flight calls. It must not rerun a tool or allocate another voice session.
- An interrupt aborts the active client tool immediately. A late successful return cannot replace its `INTERRUPTED` outcome.
- No user-identity or quota-schema changes are part of this dependency upgrade. Existing principal quotas and durable audit stay in place.

## Verification

```sh
npm ci --no-audit --no-fund
npm run check
npm test -w @vdoc-server/app-worker
WRANGLER_SEND_METRICS=false npx --no-install wrangler deploy --dry-run --outdir /tmp/vdoc-sdk-worker-bundle
```

`apps/node/test/sdk-lifecycle.test.ts` uses real HTTP/WebSocket transport with the real 0.2.0 client and Hub. Only the upstream model is scripted. It verifies negotiated stream events, repeated provider IDs, grant renewal/resume without a second model or repeated tool execution, and interrupt cancellation.

Existing Node, workerd, quota, context-update and audit tests remain required. Passing scripted-model tests does not validate real-provider credentials, microphone capture, Chinese recognition accuracy or production latency.

## Integration and rollout

The tested base is `0f40e19`, which already includes PRs #18, #19, #20, #21 and #22. Their context, audit, metrics, workerd and quota implementations do not need another merge. The historical PostgreSQL PR #10 is outside the SDK upgrade scope; the older workerd PR #9 is not a prerequisite for the already merged #21 path.

Pair this release with the VDoc browser SDK 0.2.0 dependency change from vdoc#98 and its document-engine regression checks. This upgrade does not require storage migrations. Deploy the tested server and client pair through the existing release process. For rollback, restore the previous tested package manifests and lockfiles together, rebuild, and restart sessions as needed; preserve existing quota and audit behavior.

These changes and tests do not by themselves publish either repository or deploy production.
