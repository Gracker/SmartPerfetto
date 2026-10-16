# Release Rules

Read the maintained [Release Runbook](../../docs/reference/release.md) and
[Portable Packaging](../../docs/reference/portable-packaging.md) for executable
steps. [testing](testing.md) owns detailed static/native/exact-archive contracts.
These rules are the acceptance boundaries, not a second copy of that runbook.

## Release Surfaces and Versions

Source, npm CLI, Docker and portable archives are separate deliveries; one pass
proves none of the others. npm requires host Node.js `>=24 <25`; portable bundles
pinned Node 24; Docker needs no host Node or host Claude login.

Root `package.json` is the project version source. Use `npm run version:set --
<version>` to synchronize root/backend package and lockfiles, update CHANGELOG,
then `npm run version:sync -- --check`. Never hand-update only one mirror.
Published versions/assets are immutable; runtime bugs require a verified next
patch, not mutation of an existing public artifact.

## Public Release Sequence

1. Inspect/fetch live main/tags, registry and existing release state; start from
   clean up-to-date main with supported Node 24. Run required local `verify:pr`
   and change-specific acceptance before landing; reuse unchanged evidence only
   within the identity/environment bounds in [testing](testing.md).
2. Synchronize version/CHANGELOG, commit/push main and exact release tag. npm
   preflight uses backend `cli:pack-check` and `cli:e2e` without publish credentials.
3. Build portable packages once from that exact clean release commit, using
   reviewed runtime/processor pins and macOS post-notarization, post-staple final zip.
   Verify
   manifest/version/target/commit/dirty state and safe final archive contents.
4. Upload a draft using `release:portable -- <version> --skip-build`. Bind remote
   release target/title and immutable asset IDs/names/sizes/sha256 digests to those
   bytes. Native-smoke exact final archives on matching Windows/macOS/Linux;
   use hosted `portable-exact-archive-smoke.yml` from default branch with numeric
   release ID and `selection=all` when needed.
5. Download the successful combined evidence artifact by producing run ID, then
   promote through `release:portable -- <version> --skip-build --no-draft` with
   its `--smoke-evidence-dir`, `--smoke-attestation` and `--smoke-run-id` (or the
   admitted local-native evidence path). Do not assemble verified contexts by hand.
6. Wait for npm Trusted Publishing and Docker workflow terminal results, verify
   registry install and remote dual-architecture manifest/tags. Recheck clean Git
   status; generated packages/caches stay untracked. Report each delivery separately.

## Exact Portable Identity and Lifecycle

- All three assets/top-level directories are versioned
  `smartperfetto-v<version>-windows-x64.zip`, `-macos-arm64.zip`,
  `-linux-x64.tar.gz`. Public manifest `gitDirty` is false and `gitCommit` is the
  exact release target; dirty evidence cannot promote. `--skip-build` requires
  freshly verified matching version/commit bytes, never stale local packages.
- Build once, then runtime-smoke and upload the same final archive bytes.
  Promote those bytes; never rebuild after smoke.
  Use exact archive names/sizes/hashes, source-versus-packaged processor hashes,
  fixed Node archive/executable-content pins from `node-runtime-pin.env`, and
  target native dependency/compatibility validation. Never choose moving latest.
- Archive safety must apply to final bytes, not staging alone: bounded listing/
  extraction, no traversal/links/collisions/diagnostics/macOS metadata. Linux tar
  creation uses `create-portable-tar.sh` to suppress xattrs/AppleDouble and must
  list/extract cleanly with target GNU tar.
- Cross-compiles/static signatures are structure evidence, not target startup.
  Matching-OS native smoke needs isolated data/ports, explicit IPv4 loopback health,
  bundled runtime/processor operation, graceful contained shutdown, no surviving
  descendants/listeners, preserved failure logs and schema-v2 bound receipts.
  [Exact archive gate](testing.md#exact-portable-archive-runtime-gate) is mandatory.
- Hosted gate SHA and release commit are separate trust roots. Only fixed gate
  code validates/downloads/collects; native jobs execute release archives, never
  a release source checkout. Write credentials stay in trusted prepare/download/
  collect jobs; native release code receives at most read access, never those
  credentials. Collection rechecks unchanged draft and all target provenance.
- Only successful `selection=all` yields complete public-eligible attestation.
  Partial/old-schema/stale/edited summaries cannot promote. Promotion re-fetches
  current repository/default branch, completed run and combined artifact, checks
  artifact digest, byte-compares local evidence, binds its gate SHA to clean HEAD
  and rehashes exact archives. `--release-commit` may bind a locally available full
  ancestor draft SHA to a newer clean gate, never change the release identity.
- `--no-draft` only changes an existing complete draft's flag. No release creation,
  metadata edit, upload or clobber; compare release and every asset ID/state/name/
  size/digest before and after. Public releases are read-only: idempotent verification
  may exit successfully but cannot replace/edit assets. Missing native targets keep
  a draft unless the user explicitly accepts a visible named verification gap;
  such a downgrade is never complete all-platform acceptance.

## macOS Signing

Public macOS requires `SMARTPERFETTO_MACOS_SIGN_IDENTITY` and Keychain alias
`SMARTPERFETTO_MACOS_NOTARY_PROFILE`, Developer ID/Hardened Runtime, Accepted
Apple notarization receipt inside final archive, staple validation, Gatekeeper
Notarized Developer ID and actual launch. Ad-hoc signing is local/draft only.
Find nested code by Mach-O magic, sign inside-out, never force/deep as a shortcut.
Re-signing preserves only upstream identifier/entitlements.
Do not add JIT entitlements to arbitrary unsigned Mach-O binaries. Final verification checks every Mach-O signature and
required Node/Claude entitlements. Keep Keychain key material outside the repo.

## npm Trusted Publishing

- Backend package is `@gracker/smartperfetto`, with both `smp`/`smartperfetto` bins,
  supported engine, all runtime assets and exact repository URL
  `https://github.com/Gracker/SmartPerfetto` for provenance. Build/pack from backend;
  missing bins/assets, wrong version or engine block publication.
- Normal publication is `.github/workflows/npm-publish.yml`, bound in npm to the
  exact repository/workflow on GitHub-hosted Node24. No NPM_TOKEN/NODE_AUTH_TOKEN,
  repository secrets or registry auth. Package/tests have no `id-token: write`;
  only isolated publish consumes hash-bound tarball with OIDC, without checkout
  or execution of release source.
- Event/recovery rejects draft/prerelease/non-SemVer, nonfull target SHA,
  tag/target/package mismatches and commits outside main ancestry. Manual recovery
  requires default branch and numeric public release ID. Existing immutable npm
  version is idempotent only when registry integrity equals the produced tarball.
- Propagation is credential-free, capped backoff and timeout; different/malformed
  integrity fails immediately. If only propagation failed, rerun failed jobs,
  not successful publishing. Missing event may dispatch the same workflow by ID.
  Interactive fallback is explicit emergency work from backend (`npm publish
  --access public`), never `npm --prefix backend publish`.
- Verify public `npm view` version/integrity, then install exact version in an empty
  directory under supported Node24 without npm credentials. Smoke both bins/help,
  `smp doctor --format json`, actual native modules/SDK binary and packaged processor.
  Publish command success alone is not registry/install acceptance.

## Docker, Secrets and Faults

Version tags publish SemVer, latest and sha tags; scheduled/manual main publishes
opt-in nightly. When included/affected, wait for workflow success then inspect
remote tag/digest equality and linux amd64/arm64 manifest. Source/npm/portable
success cannot prove Docker delivery. Compose defaults latest with explicit tag
override; Docker/startup/frontend/processor/provider changes need the Docker gate.

Never commit/echo tokens, provider keys or temporary npm auth. Prefer OIDC; keep
permitted fallback auth in normal external stores. A publicly exposed credential
needs rotation. Post-publication runtime/package faults require the next patch;
stop promotion of a broken candidate, record the blocker and verify a superseding
release. Documentation-only corrections may land normally.
