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

Publish the npm CLI:

```bash
npm whoami
npm --prefix backend run cli:pack-check
cd backend
npm publish --access public
cd ..
npm view @gracker/smartperfetto version --json
```

After npm publish succeeds, run a real install smoke from an empty directory:

```bash
npm install @gracker/smartperfetto@<version>
./node_modules/.bin/smp --version
./node_modules/.bin/smartperfetto --help
./node_modules/.bin/smp doctor --format json
./node_modules/.bin/smp knowledge-pack status --format json
```

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
npm run release:portable -- <version> --skip-build --no-draft \
  --smoke-evidence-dir dist/portable/smoke-evidence
gh release view v<version> --json tagName,isDraft,assets
```

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

`release:portable` is always draft-first: it uploads and verifies the target
commit, title, and all three asset names, sizes, and GitHub digests before
`--no-draft` makes the release public. Public releases and assets are immutable;
a repeated run performs strict read-only verification and exits idempotently
only when everything matches.

Finally, verify that generated outputs were not staged:

```bash
git status --short --branch
```

## Release Invariants

- Root `package.json` is the version source; `npm run version:set -- <version>` must synchronize all four version files.
- The npm package name is `@gracker/smartperfetto`, and it must expose both `smp` and `smartperfetto`.
- Published npm versions are immutable. If package contents or runtime behavior are wrong, fix and publish the next patch version.
- Public portable releases must not use `--allow-dirty`.
- `--skip-build` is only valid for packages just built from the same version and commit.
- `--no-draft` may publish only the complete default three-platform set; it
  cannot publish a single target or partial set.
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
