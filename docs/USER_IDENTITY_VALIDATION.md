# User identity acceptance record

Date: 2026-10-19. Server baseline: `104be6cab93af71fdd2ba5c4d47578c90d4ccacd` (main, SDK integration PR #23). App implementation: [vdoc PR #101](https://github.com/Q-cell2/vdoc/pull/101), code commit `e45fae082c69cb0f23710ca625ddc87b4f00ed5a`, stacked on SDK PR #100 (`25e1c68`). Final heads are recorded in the two PRs. Both repositories use `@vrealtime/* 0.2.0`; dependency and adapter files are unchanged in this identity work.

## Automated results

| Layer | Evidence |
|---|---|
| Server checks | `npm run check`: Node/Worker typechecks, architecture boundaries, 26 test files / 143 tests passed. |
| Worker WebSocket | `npm test -w @vdoc-server/app-worker`: 6 real workerd end-to-end tests passed (fake model). |
| Worker bundle | Both root and apps/worker `wrangler deploy --dry-run` passed, without deployment or credentials. |
| App checks | 186 files / 2,502 tests passed, typecheck, lint, production build and Worker smoke passed. |
| Cross-service HTTP | `VDOC_APP_CHECKOUT=/absolute/vdoc node --import tsx scripts/check-trusted-identity.mjs`: real BFF handler to an actual Node listener, 13 upstream requests passed. Login/ACL callbacks and model are fixtures. |

The test matrix covers valid/invalid application credentials and trusted users; missing/forged browser or body identity; app/user namespaces; same-user admission across documents; A exhausted while B succeeds; concurrent contention for final slots; ownership for reads/renew/end; real user WebSocket grants with foreign/expired/tampered/ended tokens rejected; identity and usage attribution on a completed SDK turn; quota unavailable 503; cancel-on-failed-creation; ambiguous persistence or reserve acknowledgement; lease expiry; renewal/reconnect/end idempotency; maximum turns/duration; late tool outcomes after end; actual Node callback concurrency; durable SQLite audit, failed-publication recovery, stable IDs and replay deduplication; Worker restart and alarm recovery, including pending outboxes past normal session retention.

Real workerd tests use the production Worker constructors, SQLite storage, principal RPC and alarm paths. Test-only inspection/seeding methods exist only in the test bundle. Production has no public audit or storage inspection route. The Node suite uses in-memory persistence and does not claim survival of process loss.

## Reproduction

```sh
npm ci --no-audit --no-fund
npm run check
npm test -w @vdoc-server/app-worker
npx wrangler deploy --dry-run --outdir /tmp/voice-root-check
(cd apps/worker && npx wrangler deploy --dry-run --outdir /tmp/voice-worker-check)
VDOC_APP_CHECKOUT=/absolute/path/to/vdoc node --import tsx scripts/check-trusted-identity.mjs
```

Install app dependencies before the cross-service script. No external model connection or production key is needed. The script reports which fixture boundaries remain.

## Production observations and unverified acceptance

The supplied target is vdoc `https://vdoc.ink`, backend Worker name `vdoc-server`, both Production, configured provider `boson`. The provider's exact model revision and backend HTTPS domain were not supplied. Local Wrangler reports unauthenticated. Read-only probes at 2026-10-19 22:20 UTC found:

- `GET https://vdoc.ink/api/auth/get-session`: 503, sign-in not configured or temporarily unavailable.
- `GET https://vdoc.ink/api/voice-sessions?documentId=identity-check`: 503 `AUTH_UNAVAILABLE`.

These observations prove login is currently unavailable; they do not determine which particular secret or database setting is missing. No production settings, secrets, deployments, Google account sessions or documents were changed.

Still required before final acceptance: restore Google/Neon login, obtain the backend URL, deploy the paired compatible commits under the existing release process, and run two real users with their own cloud documents. Record the exact deployed commits/model and test Chinese read/edit, interruption, reconnect, undo, persistence, quota rejection, and audit usage deltas. A supplied single account is insufficient to prove live two-user isolation. Do not mark these scenarios passed based on the fake-provider suites.

## Release readiness

See [identity contract and operational runbook](TRUSTED_USER_IDENTITY.md), [secret-free local example](../apps/worker/.dev.vars.example), and the app's `docs/VOICE_USER_IDENTITY_VALIDATION.md` for Google OAuth/Neon and BFF variable names. Merge/deploy SDK PR #100 before the app identity PR. Do not merge or deploy these identity changes until the strict-auth rollout plan and login/backend configuration are ready. A brief explicit, quota-limited legacy window can be used server-first, then disabled after the BFF switches. Old sessions must expire/end and be recreated; old usage is not attributed to a guessed user. Rollback may temporarily disable voice, never unlimited/shared-user fallback.

Audit usage units are session starts per rolling hour, concurrent leases, completed turns and tool outcomes (with separate reviewed-call counts); elapsed milliseconds are not provider cost. No billing, plans or balance endpoint is implemented. Pending outbox delivery is at least once; the durable audit sink deduplicates delivery/settlement IDs and other subscribers must do the same when aggregating usage. Monitor admission failures, quota storage errors, publication failures/pending age and alarm recovery before allowing broad user traffic.
