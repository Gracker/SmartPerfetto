<!--
SPDX-License-Identifier: AGPL-3.0-or-later
Copyright (C) 2024-2026 Gracker (Chris)
This file is part of SmartPerfetto. See LICENSE for details.
-->

# Release Runbook

[English](release.en.md) | [中文](release.md)

<!-- i18n-headings: paired -->

This is the maintainer-facing public release runbook. Before an LLM/agent runs
any release work, it must also read [AGENTS.md](../../AGENTS.md),
[`.claude/rules/release.md`](../../.claude/rules/release.md),
[`.claude/rules/product-surface.md`](../../.claude/rules/product-surface.md),
[`.claude/rules/git.md`](../../.claude/rules/git.md), and
[`.claude/rules/testing.md`](../../.claude/rules/testing.md).

## Release Forms

| Form | Artifact | User entry | Key boundary |
|---|---|---|---|
| npm CLI | `@gracker/smartperfetto` | `smp` / `smartperfetto` | Requires user Node.js `>=24 <25`; includes Skills/Strategies/SQL/trace processor/signed Knowledge Pack, but not the Web UI launcher |
| GitHub portable | `smartperfetto-v<version>-windows-x64.zip`, `smartperfetto-v<version>-macos-arm64.zip`, `smartperfetto-v<version>-linux-x64.tar.gz` | bundled launcher | Bundles Node.js 24, native dependencies, committed `frontend/`, pinned `trace_processor_shell`, and the signed Knowledge Pack |
| Docker Hub | Linux image built from `main` workflow | `docker compose -f docker-compose.hub.yml up -d` | Does not read host Claude Code local auth |
| Source checkout | Git repository | `./start.sh` | Normal use serves committed `frontend/`; `perfetto/` submodule is only needed for UI plugin work |

## Normal Public Release

Start from a clean, up-to-date `main`. First verify the current npm and GitHub
release state:

```bash
git status --short --branch
git fetch --tags origin
npm view @gracker/smartperfetto version --json
```

Synchronize and commit the version:

```bash
npm run version:set -- <version>
npm run version:sync -- --check
git add package.json package-lock.json backend/package.json backend/package-lock.json
git commit -m "chore: release v<version>"
git push origin main
```

Preflight the npm CLI before the public release without exposing a publish
credential:

```bash
npm --prefix backend run cli:pack-check
npm --prefix backend run cli:e2e
```

Normal npm publication is handled by the OIDC Trusted Publisher workflow at
`.github/workflows/npm-publish.yml`, without `NPM_TOKEN`. The workflow repeats
the version, pack, and CLI gates at the exact release tag, builds the tarball in
a job without OIDC, then gives a separate publish job only the hash-bound
tarball.

Publish the GitHub portable assets:

```bash
npm run package:portable
# Run on each matching target; the macOS asset must be the post-notarization, post-staple final zip
node scripts/smoke-portable-archive.cjs \
  --asset "<final-archive>" \
  --target "<windows-x64|macos-arm64|linux-x64>" \
  --version "<version>" \
  --commit "<release-commit>" \
  --public-release \
  --output-dir "dist/portable/smoke-evidence/<target>"
# When a target machine is unavailable, run the existing draft from the default branch; only all can promote.
gh workflow run portable-exact-archive-smoke.yml \
  -f release_id=<numeric-release-id> -f selection=all
gh run download <run-id> \
  --name portable-smoke-evidence-release-<numeric-release-id> \
  --dir <download-dir>
npm run release:portable -- <version> --skip-build --no-draft \
  --release-commit <draft-target-full-sha> \
  --smoke-evidence-dir <download-dir>/promotion-evidence \
  --smoke-attestation <download-dir>/portable-smoke-attestation.json \
  --smoke-run-id <run-id>
gh release view v<version> --json tagName,isDraft,assets
```

Publishing the GitHub Release automatically triggers npm Trusted Publishing.
Wait for the workflow and verify the registry. If the release event was not
delivered, recover idempotently from the default branch with the same public
release ID:

```bash
gh run list --workflow npm-publish.yml --limit 5
gh run watch <run-id> --exit-status
# recovery only
gh workflow run npm-publish.yml --ref main -f release_id=<numeric-release-id>
npm view @gracker/smartperfetto@<version> version dist.integrity --json
```

The workflow accepts only a public, non-prerelease stable SemVer release with a
full target SHA. Its tag, target, all four version fields, and `main` ancestry
must agree. An existing version is an idempotent skip only when registry
`dist.integrity` exactly matches the generated tarball. Finally, run a
credential-free install smoke in an empty directory under Node.js 24:

```bash
npm install @gracker/smartperfetto@<version>
./node_modules/.bin/smp --version
./node_modules/.bin/smartperfetto --help
./node_modules/.bin/smp doctor --format json
./node_modules/.bin/smp knowledge-pack status --format json
```

Local `npm publish` is an emergency fallback only and requires WebAuthn. Run
`npm publish --access public` from `backend/`; do not invoke publish from the
root through `--prefix`, which can target the private root package.

Portable packages use a build-once rule: test and upload the same final archive
bytes, and never rebuild after smoke. Cross-compilation, manifest/structure
checks, and static signature verification do not prove target-OS startup.
Windows, macOS, and Linux must each verify backend/frontend health through
`127.0.0.1`, bundled runtimes, a minimal trace-processor operation, graceful
shutdown, and port release. Keep the release as a draft when a target runner is
unavailable. An explicitly user-accepted gap must be named in release/hand-off
notes and must not be described as a complete all-platform smoke.
Each target's schema-v2 smoke summary also binds the final archive name, byte
size, and SHA-256. Promotion re-hashes the archive, so stale evidence or a
replaced artifact cannot pass.
`--output-dir` must name a fresh directory that does not already exist.
Successful evidence is written atomically, failures use a separate
`smoke-failure.json`, and reruns must not overwrite existing release evidence.

The hosted workflow downloads exact bytes by release ID and asset ID,
re-checks the release after download and after smoke, and runs both the release
commit verifier and a fixed default-branch verifier. `windows-linux` and
single-target runs are explicitly partial. Only an `all` run containing the
signed, notarized, stapled final macOS zip can become promotion evidence.
Download the whole combined artifact by successful run ID and pass its
`promotion-evidence/`, sibling attestation, and run ID together to promotion.
The script verifies the real Actions run and GitHub artifact digest; do not
assemble individual job evidence by hand.

`release:portable` is always draft-first: it uploads and verifies the target
commit, title, and all three asset names, sizes, and GitHub digests.
`--no-draft` only promotes an existing draft. It never creates the release,
edits title/target, uploads, or clobbers assets; before and after changing the
draft flag it compares the release ID and every asset ID, state, name, size,
and digest. Public releases and assets are immutable;
a repeated run performs strict read-only verification and exits idempotently
only when everything matches.
If the gate code is newer than the draft bytes, add
`--release-commit <draft-target-full-sha>`; only an ancestor of the current
gate commit is accepted.

Finally, verify that generated outputs were not staged:

```bash
git status --short --branch
```

## Release Invariants

- Root `package.json` is the version source; `npm run version:set -- <version>` must synchronize all four version files.
- The npm package name is `@gracker/smartperfetto`, and it must expose both `smp` and `smartperfetto`.
- npmjs.com must bind the Trusted Publisher exactly to
  `Gracker/SmartPerfetto` and `npm-publish.yml`. Only the publish job may have
  `id-token: write`, and it must not check out or execute release source.
- `workflow_dispatch` is default-branch recovery only and takes a numeric
  public release ID. An immutable-version skip must compare registry
  `dist.integrity`, not only the version string.
- Published npm versions are immutable. If package contents or runtime behavior are wrong, fix and publish the next patch version.
- Public portable releases must not use `--allow-dirty`.
- `--skip-build` is only valid for packages just built from the same version and commit.
- `--no-draft` may publish only the complete default three-platform set; it
  cannot publish a single target or partial set.
- `--no-draft` must reuse the existing exact-asset-smoked draft and cannot
  upload or replace assets.
- Public macOS packages require Developer ID, Hardened Runtime, Apple
  notarization, and a stapled ticket. Ad-hoc signing is only for local or draft
  testing.
- A published GitHub release and its asset set are read-only; never clobber,
  replace, or edit them.
- `dist/portable/`, `dist/windows-exe/`, and `.cache/smartperfetto-portable/` are generated outputs and must not be committed.
- `frontend/` is consumed by Docker, `./start.sh`, and portable packages; AI Assistant plugin UI changes must run `./scripts/update-frontend.sh`.
- If a root commit points at a new `perfetto/` submodule commit, that submodule commit must already be pushed to the Gracker fork.
- Never commit, document, or echo npm tokens, provider keys, or GitHub tokens.

## Post-Release Verification

- npm: `npm view @gracker/smartperfetto version --json` equals the new version, and an empty-directory install can run `smp doctor --format json` plus `smp knowledge-pack status --format json`.
- GitHub: `gh release view v<version>` returns a non-draft release, and all
  three asset names, sizes, target commit, and remote `sha256:` digests match
  the locally smoked archives.
- Docker: stable releases have an immutable SemVer tag plus `latest`; only the
  scheduled/manual `main` workflow updates the opt-in `nightly` tag.
- Docs: README, CLI, portable, and release docs match the real install commands, version boundary, and user entry points.
- If a major bug is found after release, stop promoting the old version, fix it with tests, publish a new patch version, and mention the superseding relationship in release notes.
