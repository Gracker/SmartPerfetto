<!--
SPDX-License-Identifier: AGPL-3.0-or-later
Copyright (C) 2024-2026 Gracker (Chris)
This file is part of SmartPerfetto. See LICENSE for details.
-->

# Windows EXE Packaging

[English](windows-exe.en.md) | [中文](windows-exe.md)

The Windows distribution is not a single-file binary. `SmartPerfetto.exe` is a
launcher placed next to the Windows Node.js 24 runtime, Windows native
`node_modules`, the pre-built Perfetto UI, backend runtime files, and the pinned
`trace_processor_shell.exe`. Users extract the zip and double-click
`SmartPerfetto.exe`; they do not need Docker or a local Node.js install.

## Maintainer Build Flow

The root `package.json` is the project version source. `backend/package.json`
and both `package-lock.json` files are synchronized by script; do not hand-edit
only one of them.

Prerequisites:

- macOS, Linux, or WSL2 build environment.
- Node.js 24 LTS. The script uses `scripts/node-env.sh` and tries nvm/fnm first.
- Go toolchain for cross-compiling the Windows launcher.
- `curl`, `rsync`, `unzip`, and `zip`.
- Access to npm registry, nodejs.org, and the Perfetto LUCI artifact bucket, or equivalent mirrors.

Build command:

```bash
npm run package:windows-exe
```

Outputs:

```text
dist/windows-exe/smartperfetto-v1.0.1-windows-x64/SmartPerfetto.exe
dist/windows-exe/smartperfetto-v1.0.1-windows-x64.zip
```

The script:

1. Activates Node.js 24 and verifies backend dependencies for the build host.
2. Runs `cd backend && npm run build`.
3. Copies `backend/dist`, `backend/skills`, `backend/strategies`, `backend/sql`, `backend/data`, `backend/public`, and the root `frontend/` pre-built bundle.
4. Installs Windows x64 production dependencies in the package directory with `npm ci --omit=dev --include=optional --os=win32 --cpu=x64`.
5. Verifies the Windows `better-sqlite3` native module and `@anthropic-ai/claude-agent-sdk-win32-x64/claude.exe`.
6. Downloads and verifies the Node.js 24 Windows x64 zip.
7. Downloads and verifies `v54.0/windows-amd64/trace_processor_shell.exe`.
8. Cross-compiles the Go launcher as `SmartPerfetto.exe`.
9. Writes `PACKAGE-MANIFEST.json` with the version, zip top-level directory,
   git commit, dirty status, Node runtime, and trace processor pin.
10. Writes the zip archive and verifies the filename, top-level directory,
    package version, and manifest.

## Release Flow

Before publishing a normal release, synchronize and commit the version:

```bash
npm run version:set -- 1.0.1
git add package.json package-lock.json backend/package.json backend/package-lock.json
git commit -m "chore: release v1.0.1"
```

Then publish:

```bash
npm run release:windows-exe -- 1.0.1
```

The script:

1. Verifies that the version is already synchronized into the root `package.json`, root `package-lock.json`,
   `backend/package.json`, and `backend/package-lock.json`.
2. Refuses to upload a release package from a dirty worktree unless
   `--allow-dirty` is explicit.
3. Rebuilds the Windows x64 zip.
4. Verifies the zip filename, top-level directory, package version, manifest
   commit, and dirty status.
5. Generates release notes with the zip SHA256, size, and target commit.
6. Creates or updates GitHub Release `v1.0.1`, and points the release tag target
   at the target commit.
7. Uploads a versioned asset name such as `smartperfetto-v1.0.1-windows-x64.zip`,
   so users can distinguish offline packages from different releases.

By default, the script creates a draft release. After a real Windows smoke test,
publish it in the GitHub UI. To publish immediately:

```bash
npm run release:windows-exe -- 1.0.1 --no-draft
```

Uploading a release package requires a clean git worktree by default, so the
release tag does not point at source with a different version from the zip. Add
`--allow-dirty` only for draft/test uploads where local uncommitted changes are
intentional.

To synchronize versions without publishing:

```bash
npm run version:set -- 1.0.1
npm run version:sync -- --check
```

## User Run Flow

1. Extract `smartperfetto-v1.0.1-windows-x64.zip` to a normal local path such as `C:\SmartPerfetto`.
2. Double-click `SmartPerfetto.exe`.
3. The browser usually opens automatically. If it does not, open [http://localhost:10000](http://localhost:10000).
4. AI analysis needs a Provider profile in the UI, or env credentials in `backend\.env`. To use env credentials, copy `backend\.env.example` to `backend\.env`, edit one provider block, and restart `SmartPerfetto.exe`.
5. Keep the launcher window open while using SmartPerfetto. Press `Ctrl+C` to stop the backend, frontend, and trace processor child processes.

## Verification

A non-Windows build host can verify package structure, backend type/build
health, and dependency presence, but it cannot execute the Windows native smoke.
Before public release, run this on a real Windows x64 machine:

```powershell
Expand-Archive .\smartperfetto-v1.0.1-windows-x64.zip -DestinationPath C:\SmartPerfettoSmoke
C:\SmartPerfettoSmoke\smartperfetto-v1.0.1-windows-x64\SmartPerfetto.exe
```

Then check:

- [http://localhost:10000](http://localhost:10000) opens the Perfetto UI.
- [http://localhost:3000/health](http://localhost:3000/health) returns `status: "OK"`.
- Uploading a small trace starts `trace_processor_shell.exe` in the backend log.

## Limits

- The current package target is Windows x64 only.
- This is an extract-and-run directory, not a single-file portable executable; do not distribute only `SmartPerfetto.exe`.
- The script does not code-sign the launcher. Add signing after zip generation if a public release needs lower Windows SmartScreen friction.
