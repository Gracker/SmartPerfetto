# Release Rules

Read this file before any publish, package, tag, release, npm, Docker, or
portable artifact task.

## Release Surfaces

SmartPerfetto has separate release surfaces. Do not assume one successful
surface proves the others.

| Surface | Artifact | User entry | Includes | Does not include |
| --- | --- | --- | --- | --- |
| npm CLI | `@gracker/smartperfetto` | `smp`, `smartperfetto` | CLI dist, backend runtime assets, Skills, Strategies, SQL, packaged `trace_processor_shell` prebuilts for supported targets | Web UI launcher, Docker image, portable app bundle |
| GitHub portable | `smartperfetto-v<version>-windows-x64.zip`, `smartperfetto-v<version>-macos-arm64.zip`, `smartperfetto-v<version>-linux-x64.tar.gz` | bundled launcher | Node.js 24 runtime, native production dependencies, backend, committed `frontend/`, pinned `trace_processor_shell` | npm global install |
| Docker Hub | Linux container image from `main` workflow | `docker compose -f docker-compose.hub.yml up -d` | backend, committed `frontend/`, pinned trace processor, Docker volumes | host Claude Code local auth |
| Source checkout | Git repository | `./start.sh` | backend source, committed `frontend/`, optional `perfetto/` submodule for UI development | published artifact guarantees |

The npm CLI requires user-provided Node.js `>=24 <25`. Portable packages bundle
Node.js 24. Docker users do not need host Node.js. Native Windows source work
should use WSL2; native Windows users should use the portable package.

## Version Source

- Root `package.json` is the project version source.
- `npm run version:set -- <version>` must synchronize:
  - `package.json`
  - `package-lock.json`
  - `backend/package.json`
  - `backend/package-lock.json`
- Verify with `npm run version:sync -- --check`.
- Published npm versions are immutable. If a release bug escapes, fix it,
  bump the next patch version, publish a new npm version, and supersede the
  GitHub release instead of mutating the published version.

## Public Release Sequence

1. Fetch and inspect current state:
   - `git status --short --branch`
   - `git fetch --tags origin`
   - `npm view @gracker/smartperfetto version --json`
   - `gh release view v<version>` when checking an existing release
2. Start from a clean, up-to-date `main`.
3. Confirm Node.js 24 is active. Do not publish from Node 25.
4. Run the verification tier that matches the change. For release-process,
   portable, CLI packaging, runtime asset, or version-sync changes, follow
   `.claude/rules/testing.md`.
5. Bump and commit the version:
   ```bash
   npm run version:set -- <version>
   npm run version:sync -- --check
   git add package.json package-lock.json backend/package.json backend/package-lock.json
   git commit -m "chore: release v<version>"
   git push origin main
   ```
6. Preflight the npm CLI package without a publish credential:
   ```bash
   npm --prefix backend run cli:pack-check
   npm --prefix backend run cli:e2e
   ```
   The normal npm publish path is the tokenless
   `.github/workflows/npm-publish.yml` Trusted Publisher workflow. It repeats
   these checks against the exact release tag before producing the tarball.
7. Build portable GitHub assets from the exact clean release commit:
   ```bash
   npm run package:portable
   ```
   Linux `tar.gz` assets built on macOS must be created through
   `scripts/create-portable-tar.sh`, which suppresses both extended attributes
   and AppleDouble synthesis. The final archive must contain no `._*`,
   `__MACOSX`, `.DS_Store`, or `.AppleDouble` entry and must list and extract
   without diagnostics on the target's GNU tar. A staging-tree check alone
   does not prove this archive-time contract.
   Runtime-smoke the post-build final archives on their matching operating
   systems with `scripts/smoke-portable-archive.cjs` and the exact-asset
   contract in `.claude/rules/testing.md`.
   macOS smoke must use the post-notarization, post-staple final zip. Do not
   rebuild any archive after it passes runtime smoke. Store each result at
   `dist/portable/smoke-evidence/<target>/smoke-summary.json` by using
   `--public-release`. Each target output directory must be fresh and must not
   overwrite prior smoke evidence.
   When a target machine is unavailable, dispatch
   `.github/workflows/portable-exact-archive-smoke.yml` from the default branch
   with the numeric draft `release_id`. Use `selection=all` for promotion
   evidence; `windows-linux` and single-target runs are explicitly partial.
   A fixed-gate credential job downloads each immutable asset ID, re-checks
   release metadata after download, and passes the opaque bytes through a
   short-lived Actions artifact to a native smoke job with only repository
   read access. The native job must execute the smoke client from the fixed
   gate checkout against the release archive; immutable draft metadata and the
   downloaded archive supply identity and product bytes. The native job must
   not create or execute a release checkout. It then sends only raw evidence
   to a fresh collect job. That job re-checks the unchanged draft before
   downloading the raw evidence and uses the fixed gate verifier, without a
   token, to issue verified contexts while preserving the distinct gate SHA
   and release commit in a normalized
   `promotion-evidence/` directory plus
   `portable-smoke-attestation.json` in the combined artifact. Download that
   exact artifact by successful workflow run ID; do not copy individual job
   artifacts into a promotion directory by hand.
   Releases that predate the schema-v2 lifecycle smoke contract are rejected
   instead of being silently downgraded.
   Hosted promotion also re-fetches repository metadata and rejects runs from
   any branch other than GitHub's current default branch. The run gate SHA must
   exactly equal the clean promotion checkout's `HEAD`.
8. Publish those already-smoked portable assets:
   ```bash
   npm run release:portable -- <version> --skip-build --no-draft \
     --smoke-evidence-dir dist/portable/smoke-evidence
   gh release view v<version> --json tagName,isDraft,assets
   ```
   For hosted evidence, additionally pass the combined artifact and its
   producing run:
   ```bash
   gh run download <run-id> \
     --name portable-smoke-evidence-release-<release-id> \
     --dir <download-dir>
   npm run release:portable -- <version> --skip-build --no-draft \
     --release-commit <draft-target-full-sha> \
     --smoke-evidence-dir <download-dir>/promotion-evidence \
     --smoke-attestation <download-dir>/portable-smoke-attestation.json \
     --smoke-run-id <run-id>
   ```
9. Wait for the public release's npm Trusted Publishing workflow, then verify
   the registry:
   ```bash
   gh run list --workflow npm-publish.yml --limit 5
   gh run watch <run-id> --exit-status
   npm view @gracker/smartperfetto@<version> version dist.integrity --json
   ```
   The workflow accepts only a public, non-prerelease release with a full
   target SHA that matches its tag, package versions, and a commit reachable
   from `main`. It builds and tests without an OIDC credential, then gives
   `id-token: write` only to a separate job that publishes the hash-bound
   tarball. A rerun may skip an immutable version only when registry
   `dist.integrity` exactly matches that tarball. If the release event was not
   delivered, rerun the same path from the default branch by immutable public
   release ID:
   ```bash
   gh workflow run npm-publish.yml --ref main -f release_id=<numeric-release-id>
   ```
   Interactive WebAuthn publishing is an emergency fallback only. When it is
   required, publish from `backend/` with `npm publish --access public`; never
   use `npm --prefix backend publish`, which can resolve the private root
   package and fail with `EPRIVATE`.
10. Run isolated npm smoke in a temp directory under supported Node.js 24:
    ```bash
    npm install @gracker/smartperfetto@<version>
    ./node_modules/.bin/smp --version
    ./node_modules/.bin/smartperfetto --help
    ./node_modules/.bin/smp doctor --format json
    ```
    Publishing can return success before registry metadata is fully visible;
    require both `npm view` and this isolated install before calling the npm
    release done.
11. Re-check `git status --short --branch`. Generated `dist/portable/`,
   `dist/windows-exe/`, and cache outputs must not be staged.

## npm CLI Invariants

- `backend/package.json` package name is `@gracker/smartperfetto`.
- `backend/package.json.repository.url` must be exactly
  `https://github.com/Gracker/SmartPerfetto`; npm Sigstore provenance validates
  this metadata against the GitHub Actions repository identity.
- The package must expose both `smp` and `smartperfetto` bins.
- `npm --prefix backend run cli:pack-check` must verify package contents before
  publish.
- Build the releasable package from `backend/`. Trusted Publishing publishes
  the exact tarball produced by that package job. Interactive fallback must
  run from the `backend/` working directory with `npm publish --access public`;
  do not publish with `npm --prefix backend publish`.
- The packed CLI must contain runtime assets needed by `doctor`, `query`,
  `skill`, `run`, `ask`, `repl`, `compare`, and `report export`.
- Do not publish if dry-run or pack-check reports missing bin files,
  missing runtime assets, wrong version, or an unsupported Node engine.

## npm Trusted Publishing Invariants

- npmjs.com must bind `@gracker/smartperfetto` to repository
  `Gracker/SmartPerfetto` and the exact workflow filename `npm-publish.yml`.
- The workflow must use GitHub-hosted runners, Node.js 24, and an npm CLI that
  supports Trusted Publishing. It must not contain `NPM_TOKEN`,
  `NODE_AUTH_TOKEN`, registry auth material, or repository secrets.
- Release packaging and tests run without `id-token: write`. Only the publish
  job receives the OIDC permission, and that job must not check out or execute
  release source; it may consume only the hash-bound tarball artifact.
- Manual dispatch is recovery-only, takes a numeric public release ID, and
  must fail when invoked from any ref other than the default branch.
- Both event and recovery paths must reject drafts, prereleases, non-SemVer
  tags, non-full target SHAs, tag/target/version mismatches, and release commits
  that are not ancestors of `main`.
- An already-published version is idempotent only when npm registry
  `dist.integrity` exactly equals the generated tarball SRI. A mismatch is a
  hard failure, never a skip.
- Post-publish smoke must install the public exact version without user npm
  credentials and verify the supported Node boundary, CLI bins, Knowledge
  Pack, and packaged `trace_processor_shell`.

## Portable Release Invariants

- Asset names and top-level directories must be versioned:
  - `smartperfetto-v<version>-windows-x64.zip`
  - `smartperfetto-v<version>-macos-arm64.zip`
  - `smartperfetto-v<version>-linux-x64.tar.gz`
- Do not publish old unversioned asset names.
- Do not use `--allow-dirty` for public releases.
- `--skip-build` is allowed only when the existing packages were freshly built
  for the exact version and commit being released.
- Build once, then runtime-smoke and upload the same final archive bytes.
  Cross-compilation, manifest verification, archive extraction, and static
  signature checks prove structure but do not prove the packaged launcher can
  start on the target operating system.
- Resolve portable Node runtimes only from the exact version, target archive
  hashes, and executable-content digests in `scripts/node-runtime-pin.env`.
  Update that file through review; never select a moving `latest-v24.x`
  runtime during a release build.
- Before `--no-draft`, runtime-smoke the final Windows, macOS, and Linux
  archives on matching operating systems. Check backend and frontend
  `127.0.0.1` health, bundled runtimes, a minimal trace-processor operation,
  graceful shutdown, and port release as defined in `.claude/rules/testing.md`.
  Each schema-v2 smoke summary must bind the exact asset name, byte size, and
  SHA-256; promotion re-hashes the local asset and rejects any mismatch.
- If a required target runner is unavailable, keep the release as a draft.
  Publishing with an explicitly accepted gap requires user approval and a
  visible downgrade in the release/hand-off notes; never call that result a
  complete all-platform smoke.
- Portable publishing is draft-first. Upload and verify the release target,
  title, exact asset names, sizes, and GitHub `sha256:` digests before making a
  release public.
- `--no-draft` is promotion-only: the draft and all three assets must already
  exist. It must not create a release, edit release metadata, upload, or
  `--clobber` an asset. Before and after changing only the draft flag, compare
  the release ID plus every asset ID, state, name, size, and digest.
- If the gate code advanced after the draft bytes were built, run promotion
  from the newer clean gate checkout with `--release-commit <full-draft-sha>`.
  The script accepts only a locally available full SHA that is an ancestor of
  the gate commit; package, evidence, and remote target checks still bind to
  that release SHA.
- `--no-draft` requires the complete default three-target set. A partial target
  selection must remain a draft.
- A published release is read-only. Re-running the script may verify and exit
  idempotently, but must never clobber, replace, upload, or edit public assets.
- The package manifest must report `gitDirty: false` and `gitCommit` equal to
  the release target commit.
- Portable manifest schema v3 records distribution, update channel, target,
  source commit, signing mode, the pinned trace-processor source hash, and the
  post-signing packaged trace-processor hash so provenance and final artifact
  verification remain distinct.
- Ad-hoc signing is limited to local or draft macOS packages. A public macOS
  release requires `SMARTPERFETTO_MACOS_SIGN_IDENTITY` and
  `SMARTPERFETTO_MACOS_NOTARY_PROFILE`, Developer ID signing, Hardened Runtime,
  Apple notarization acceptance, a stapled ticket, Gatekeeper acceptance, and
  an actual launch smoke.
- Discover nested macOS code by Mach-O file magic, not filename extension or
  executable mode. Sign every Mach-O inside-out; do not use
  `codesign --force --deep` as a signing shortcut.
- When re-signing an already-signed bundled runtime, preserve only its upstream
  `identifier,entitlements`. Do not add JIT entitlements to arbitrary unsigned
  Mach-O files. The final zip verifier must check every Mach-O signature and
  the required Node/Claude runtime entitlements.
- A notary profile is a local Keychain credential alias, not a provisioning
  profile. Keep the API key material outside the repository and pass only the
  profile name to release automation.

## Release-Surface Acceptance

Verify only the public surfaces included in the release, but close each one
completely:

- Portable: remote tag/target, non-draft status, exact asset names/sizes, and
  GitHub `sha256:` digests must match the locally smoked archives.
- npm: wait for registry propagation, verify `npm view`, then install the
  public version in an empty directory under supported Node.js 24 and run the
  CLI smoke.
- Docker: when Docker is published or affected, wait for the workflow terminal
  state and verify the SemVer, `latest`, and `sha-*` tags plus the amd64/arm64
  manifest digest. Git tag `v1.2.3` normally maps to Docker tag `1.2.3`.

## Docker Release Notes

Docker Hub images are produced by repository workflow. Version tags publish an
immutable SemVer tag plus `latest`; schedule/manual runs on `main` publish only
the opt-in `nightly` tag. `docker-compose.hub.yml` defaults to `latest` and
accepts `SMARTPERFETTO_DOCKER_TAG` for explicit SemVer or nightly selection.
When a task changes Dockerfile, compose files, `frontend/` consumption,
trace-processor setup, provider env behavior, or startup scripts, verify the
Docker path and update Docker docs. Do not describe a manual Docker publish as
complete unless the workflow or image tag is verified.

## Secret Handling

- Never commit npm tokens, provider keys, GitHub tokens, or temporary `.npmrc`
  files.
- Do not echo tokens into logs, docs, commit messages, release notes, or final
  summaries.
- Prefer npm Trusted Publishing OIDC. Use environment variables or npm's
  normal auth store only for explicitly accepted one-off fallback work.
- If a token was pasted into a chat or terminal transcript, recommend rotation
  after the release is verified.

## Release Bug Policy

- Small documentation or release-note mistakes: fix docs, commit, push.
- Package/runtime bug after npm publish: fix, verify, bump next patch version,
  publish npm again, then publish matching portable assets.
- Major runtime regression: stop promoting the bad version, document the
  blocker, fix with targeted tests, then publish a superseding release.
