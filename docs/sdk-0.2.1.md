# vRealTime 0.2.1

All server adapter and runtime-test `@vrealtime/*` dependencies use the published npm release 0.2.1. The release includes vRT #75's stop-reason contract and bounded turn continuations. Existing `maxContinuations: 16`, tool governance and turn telemetry remain in force.

The unreleased `vendor/vrt` tarballs, root file dependencies and dependency overrides are removed. `npm ci` installs the exact registry artifacts recorded by integrity in the lockfile. Deploying the server bundles those installed packages; it does not load code from the sibling vRT checkout at runtime.

Future vRT merges do not update an installed or deployed server automatically. Publish a new SDK version, update the server manifests and lockfile together, run validation, and deploy the resulting server build. Do not reuse a published version number for changed artifacts.

No application transport or tool schema changes are introduced here. Server runtime integration suites now use 0.2.1 clients; a live browser/Boson session has not been exercised as part of this dependency migration.
