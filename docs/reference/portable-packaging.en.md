<!--
SPDX-License-Identifier: AGPL-3.0-or-later
Copyright (C) 2024-2026 Gracker (Chris)
This file is part of SmartPerfetto. See LICENSE for details.
-->

# Portable Packaging

[English](portable-packaging.en.md) | [中文](portable-packaging.md)

SmartPerfetto portable packages are not single-file binaries. The launcher starts
the bundled Node.js 24 runtime, backend, pre-built Perfetto UI, and pinned
`trace_processor_shell`, plus the signed Android Internals Knowledge Pack.

Current release assets:

- `smartperfetto-v<version>-windows-x64.zip`
- `smartperfetto-v<version>-macos-arm64.zip`
- `smartperfetto-v<version>-linux-x64.tar.gz`

## Build

```bash
npm run package:portable
```

Single target:

```bash
npm run package:windows-exe
npm run package:macos-app
npm run package:linux
```

Outputs:

```text
dist/portable/smartperfetto-v<version>-windows-x64.zip
dist/portable/smartperfetto-v<version>-macos-arm64.zip
dist/portable/smartperfetto-v<version>-linux-x64.tar.gz
```

The legacy-compatible Windows command still writes:

```text
dist/windows-exe/smartperfetto-v<version>-windows-x64.zip
```

## Release

See the [Release Runbook](release.en.md) for the full public release sequence.
Portable publishing normally happens after the npm CLI is published and smoked.

Portable steps in a normal public release:

```bash
npm run version:set -- <version>
npm run version:sync -- --check
git add package.json package-lock.json backend/package.json backend/package-lock.json
git commit -m "chore: release v<version>"
git push origin main
npm --prefix backend run cli:pack-check
cd backend
npm publish --access public
cd ..
npm run package:portable
npm run release:portable -- <version> --skip-build --no-draft
```

`package:portable` builds all three target packages and verifies schema v2
manifests, including distribution, channel, target, commit, and signing mode.
`release:portable --skip-build` only reuses packages just built from the same
version and commit.

The release script always creates or reuses a draft first. After upload it
verifies the target commit, title, asset names, sizes, and GitHub `sha256:`
digests before changing the draft to a public release. `--no-draft` requires
all three default targets; a partial target set cannot be published. An already
published release is read-only: the script verifies the exact three-platform
set and exits idempotently when it matches, without clobbering, editing, or
replacing assets. Do not use `--skip-build` unless those same-version,
same-commit packages were just built.

Single-target release:

```bash
npm run release:portable -- <version> --targets macos-arm64
npm run release:windows-exe -- <version>
```

Do not use `--allow-dirty` for public releases. If a major bug is found after
npm publish, fix it and publish a new patch version instead of reusing the
already-published npm version.

## macOS Signing and Notarization

Without signing variables, the script creates an ad-hoc signed app so macOS
does not classify the bundle as damaged. Ad-hoc signing does not pass
Gatekeeper notarization checks; it is only suitable for local testing or
draft packages where users can Control-click -> Open. Public macOS releases
must configure:

```bash
export SMARTPERFETTO_MACOS_SIGN_IDENTITY="Developer ID Application: ..."
export SMARTPERFETTO_MACOS_NOTARY_PROFILE="notarytool-keychain-profile"
npm run release:portable -- <version> --targets macos-arm64
```

When a signing identity is set, the script runs `codesign --options runtime` and
strict verification. When a notary profile is set, it submits with
`xcrun notarytool submit --wait`, staples the `.app`, and recreates the zip.
The notary profile is a local `notarytool` Keychain credential alias, not a
provisioning profile. Keep the API private key out of the repository and
release logs.

Packaging discovers nested native code by Mach-O file magic rather than file
extension or executable mode, then signs each Mach-O inside-out. Re-signing an
upstream-signed Node/Claude runtime preserves only its existing identifier and
entitlements. Do not inject JIT entitlements into arbitrary unsigned Mach-O
files or replace this flow with `codesign --force --deep`. The final zip
verifier checks every Mach-O signature and the required Node/Claude runtime
entitlements.

## User Data Directories

- Windows: `data/` and `logs/` under `%LOCALAPPDATA%\SmartPerfetto`.
- macOS: `~/Library/Application Support/SmartPerfetto` and `~/Library/Logs/SmartPerfetto`.
- Linux: `${XDG_DATA_HOME:-~/.local/share}/smartperfetto` and
  `${XDG_STATE_HOME:-~/.local/state}/smartperfetto/logs`.

AI analysis should normally use Provider profiles configured in the UI. For env
credentials, create an `env` file in the platform user data directory and
restart the launcher.

On the first launch of a new Windows package, the launcher can discover an
older versioned package and safely copy its package-local `data/` into
`%LOCALAPPDATA%\SmartPerfetto`. It writes a migration receipt and atomically
switches the staged copy into place; the old directory remains untouched.
Symlinks, reparse points, and non-regular files are rejected. If automatic
discovery cannot identify the source, use:

```powershell
SmartPerfetto.exe --migrate-from C:\path\to\old-package
```

Set `SMARTPERFETTO_PORTABLE_MODE=1` only when data must intentionally travel
beside the package. That mode keeps package-local `data/` and `logs/` and
disables automatic migration. An explicit `SMARTPERFETTO_BACKEND_DATA_DIR`
also takes precedence over the default and disables automatic migration.

The bundled launcher prefers backend `3000` and frontend `10000`. If a preferred
default port is already occupied, the launcher automatically selects the next
available port and prints the actual URLs. Set `SMARTPERFETTO_BACKEND_PORT` or
`SMARTPERFETTO_FRONTEND_PORT` only when a fixed port is required; explicitly
configured ports fail fast when unavailable.

## Verification

The scripts verify package structure, version, manifest, Node runtime, target
native dependencies, the `trace_processor_shell` pin, and Knowledge Pack
lock/manifest/database/license versions and hashes. Cross-compilation,
structure checks, and static signature verification do not prove target-OS
startup. Public release uses a build-once rule: extract and smoke the same final
archive bytes that will be uploaded, and do not rebuild after smoke. macOS must
test the final zip recreated after notarization and stapling.

1. Start the bundled launcher.
2. Open the printed frontend URL, usually [http://127.0.0.1:10000](http://127.0.0.1:10000).
3. Check the printed backend health URL, usually [http://127.0.0.1:3000/health](http://127.0.0.1:3000/health).
4. Upload a small trace and confirm the platform `trace_processor_shell` starts
   in backend logs.
5. Run `smp knowledge-pack status --format json` through the bundled CLI/backend
   and confirm the bundled/active Pack is readable and not revoked.
6. Run the bundled Node.js, Claude, and OpenCode version commands when present.
7. Stop the launcher normally and confirm child processes exit and both ports
   are released.

Keep the GitHub release as a draft if the final Windows, macOS, or Linux archive
cannot be smoked on its target OS. A downgraded publish requires explicit user
acceptance and a visible untested-target note, and must not be described as a
complete all-platform smoke.
