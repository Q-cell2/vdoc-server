# Unreleased vRT continuation support

These three local 0.2.0 tarballs contain the stop-reason contract, bounded AgentSession
continuations, cascade finish propagation and OpenAI-compatible response mapping.
The implementation source stays in the sibling vRealTime repository.
Source commit: `03ba90c` on `codex/stop-reason-continuations`, based on upstream
`bc1903c` (includes bounded cascade history).

The root dependencies pin the tarballs directly so npm also refreshes an existing
workspace installation of the same version. Root overrides keep all transitive
consumers on those same packages. The lockfile records their SHA-512 integrity.
Use Node 22.13 or later and `npm ci` to reproduce the installation.

To refresh after changing SDK source, run `npm run pack` in vRealTime, copy
`release/vrealtime-{core,cascade,openai-compatible}-0.2.0.tgz` here, then refresh the corresponding installed packages and lock entries before
running `npm install`. npm can retain the old integrity when a tarball changes
without a version bump; verify every lockfile SHA-512 against the new bytes.
Run both repositories' type checks and tests before using a refreshed package.

After publishing a vRT version containing this implementation, upgrade all vRT
consumers together and remove the root file dependencies, overrides and this folder.
These artifacts have not been published to npm or deployed.
