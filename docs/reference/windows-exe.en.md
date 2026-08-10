<!--
SPDX-License-Identifier: AGPL-3.0-or-later
Copyright (C) 2024-2026 Gracker (Chris)
This file is part of SmartPerfetto. See LICENSE for details.
-->

# Windows EXE Packaging

[English](windows-exe.en.md) | [中文](windows-exe.md)

<!-- i18n-headings: paired -->

> The Windows commands are compatibility entry points for the cross-platform
> portable packaging flow. See [Portable Packaging](portable-packaging.en.md)
> for the full three-platform release process.

The Windows distribution is not a single-file binary. `SmartPerfetto.exe` is a
launcher placed next to the Windows Node.js 24 runtime, Windows native
`node_modules`, the pre-built Perfetto UI, backend runtime files, and the pinned
`trace_processor_shell.exe`, plus the signed Android Internals Knowledge Pack.
Users extract the zip and double-click
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
dist/windows-exe/smartperfetto-v<version>-windows-x64/SmartPerfetto.exe
dist/windows-exe/smartperfetto-v<version>-windows-x64.zip
```

The script:

1. Activates Node.js 24 and verifies backend dependencies for the build host.
2. Runs `cd backend && npm run build`.
3. Copies `backend/dist`, `backend/skills`, `backend/strategies`, `backend/sql`,
   `backend/data`, `backend/knowledge`, `backend/public`, and the root
   `frontend/` pre-built bundle.
4. Installs Windows x64 production dependencies in the package directory with `npm ci --omit=dev --include=optional --os=win32 --cpu=x64`.
5. Verifies the Windows `better-sqlite3` native module and `@anthropic-ai/claude-agent-sdk-win32-x64/claude.exe`.
6. Downloads and verifies the Node.js 24 Windows x64 zip.
7. Downloads and verifies Windows `trace_processor_shell.exe` from
   `scripts/trace-processor-pin.env`; the version is not duplicated in docs.
8. Cross-compiles the Go launcher as `SmartPerfetto.exe`.
9. Writes `PACKAGE-MANIFEST.json` with the version, zip top-level directory,
   git commit, dirty status, Node runtime, trace processor pin, and Knowledge
   Pack.
10. Writes the zip archive and verifies the filename, top-level directory,
    package version, Knowledge Pack hashes, and manifest.

## Release Flow

Public releases should normally use the three-platform
[Portable Packaging](portable-packaging.en.md) flow and the
[Release Runbook](release.en.md). `release:windows-exe` is a compatibility
entry point for producing or uploading a Windows x64 **draft candidate**.
Public releases cannot re-publish or replace only the Windows asset.

Before publishing a normal release, synchronize and commit the version:

```bash
npm run version:set -- <version>
npm run version:sync -- --check
git add package.json package-lock.json backend/package.json backend/package-lock.json
git commit -m "chore: release v<version>"
```

Then publish:

```bash
npm run release:windows-exe -- <version>
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
6. Creates or updates GitHub Release `v<version>`, and points the release tag target
   at the target commit.
7. Uploads a versioned asset name such as `smartperfetto-v<version>-windows-x64.zip`,
   so users can distinguish offline packages from different releases.

The script creates a draft release by default. Do not publish a single-platform
draft in the GitHub UI and do not use `release:windows-exe --no-draft`. Current
promotion requires immutable Windows, macOS, and Linux final assets, all with
exact-archive smoke evidence, followed by the Release Runbook's
`release:portable --skip-build --no-draft` promotion.

Uploading a release package requires a clean git worktree by default, so the
release tag does not point at source with a different version from the zip. Add
`--allow-dirty` only for draft/test uploads where local uncommitted changes are
intentional.

To synchronize versions without publishing:

```bash
npm run version:set -- <version>
npm run version:sync -- --check
```

## User Run Flow

Download verification, complete extraction, Provider setup, updates, migration,
and troubleshooting are canonical in the
[Windows Setup And Run Guide](../getting-started/windows.en.md). This section keeps
only the launcher contract summary.

1. Extract `smartperfetto-v<version>-windows-x64.zip` to a normal local path such as `C:\SmartPerfetto`.
2. Double-click `SmartPerfetto.exe`.
3. The browser usually opens automatically. If it does not, open the launcher's printed `Frontend: http://127.0.0.1:<port>` URL (the launcher selects another port when the default is occupied).
4. AI analysis needs a Provider profile in the UI. For env credentials, write the provider configuration to `%LOCALAPPDATA%\SmartPerfetto\env` and restart `SmartPerfetto.exe`. Do not store durable credentials in the extracted package directory.
5. Keep the launcher window open while using SmartPerfetto. Press `Ctrl+C` to stop the backend, frontend, and trace processor child processes.

## Verification

A non-Windows build host can verify package structure, backend type/build
health, and dependency presence, but it cannot execute the Windows native smoke.
Regular Windows CI runs portable-launcher Go test/build and the DPAPI SecretStore
test. Public release also requires the final-archive smoke on a Windows x64 runner:

```powershell
Expand-Archive .\smartperfetto-v<version>-windows-x64.zip -DestinationPath C:\SmartPerfettoSmoke
C:\SmartPerfettoSmoke\smartperfetto-v<version>-windows-x64\SmartPerfetto.exe
```

Then check:

- The launcher's printed `http://127.0.0.1:<port>` URL opens the Perfetto UI.
- The launcher's printed backend `http://127.0.0.1:<port>/health` URL returns `status: "OK"`.
- Uploading a small trace starts `trace_processor_shell.exe` in the backend log.
- Bundled CLI `smp knowledge-pack status --format json` resolves the
  bundled/active Pack.

The launcher prefers backend `3000` and frontend `10000`, but automatically
selects another available port when a default is occupied. Use the URLs printed
by the launcher. Set `SMARTPERFETTO_BACKEND_PORT` or
`SMARTPERFETTO_FRONTEND_PORT` only when a fixed port is required; explicitly
configured ports fail fast when unavailable.

## Limits

- The current package target is Windows x64 only.
- This is an extract-and-run directory, not a single-file portable executable; do not distribute only `SmartPerfetto.exe`.
- The script does not Authenticode-sign the launcher. The only valid integration
  order is sign and timestamp → create the final zip → exact-archive smoke those
  final bytes → publish. Changing an EXE after zip creation or smoke invalidates
  the digest and acceptance evidence.
