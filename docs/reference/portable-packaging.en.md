<!--
SPDX-License-Identifier: AGPL-3.0-or-later
Copyright (C) 2024-2026 Gracker (Chris)
This file is part of SmartPerfetto. See LICENSE for details.
-->

# Portable Packaging

[English](portable-packaging.en.md) | [中文](portable-packaging.md)

<!-- i18n-headings: paired -->

SmartPerfetto portable packages are not single-file binaries. The launcher starts
the bundled Node.js 24 runtime, backend, pre-built Perfetto UI, and pinned
`trace_processor_shell`, plus the signed Android Internals Knowledge Pack.

Current release assets:

- `smartperfetto-v<version>-windows-x64.zip` (Windows 10 / Windows Server 2016
  or newer on x64)
- `smartperfetto-v<version>-macos-arm64.zip` (macOS 13.5 or newer on Apple
  silicon)
- `smartperfetto-v<version>-linux-x64.tar.gz` (glibc 2.34 or newer on x64;
  musl-based distributions such as Alpine Linux are unsupported)

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
# Run this command once on each matching Windows x64, macOS arm64, and Linux x64 target.
node scripts/smoke-portable-archive.cjs --asset <final-archive> --target <target> \
  --version <version> --commit <commit> --public-release \
  --output-dir dist/portable/smoke-evidence/<target>
# When a target machine is unavailable, run against the existing draft from the default branch:
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
```

`package:portable` reads the exact Node.js version, target archive SHA-256
values, and executable-content digests from `scripts/node-runtime-pin.env`
instead of selecting the latest runtime during a build. For macOS, that digest
normalizes only code-signature-dependent Mach-O fields so Developer ID
re-signing cannot mask changed executable content. A Node runtime update must
review and update those pins. The command builds all three target packages and
verifies schema v3
manifests, including distribution, channel, target, commit, and signing mode.
`traceProcessor` records both the pinned upstream `sourceSha256` and the
post-signing archive-byte `sha256`, keeping supply-chain provenance separate
from final-artifact verification. `release:portable --skip-build` only reuses
packages just built from the same version and commit. Public promotion
validates each target's native host, archive name, size, SHA256, commit,
health, runtime probes, and lifecycle receipt from the smoke summary. Missing
evidence or bytes that do not match the pending upload stop the release.
Every smoke `--output-dir` must be a fresh path that does not already exist.
Success atomically creates `smoke-summary.json`; failure writes
`smoke-failure.json` instead, so a rerun uses a new directory and cannot
overwrite earlier evidence.

The hosted workflow accepts only release commits that contain the current
schema-v2 lifecycle smoke contract and downloads by immutable release ID and
asset ID. It re-fetches GitHub metadata after download and after smoke, then
runs both the release-commit verifier and the fixed default-branch verifier.
`windows-linux` and single-target selections are partial diagnostics and
cannot promote a release. Only a successful `selection=all` run with the
Developer ID-signed, notarized, stapled final macOS zip can produce candidate
`promotion-evidence/` in the combined artifact. Download the whole combined
artifact by its successful run ID and pass its `promotion-evidence/`, sibling
`portable-smoke-attestation.json`, and that run ID together to the release
command. Promotion re-fetches the Actions run and uniquely named combined
artifact, verifies the downloaded zip against GitHub's artifact SHA-256, and
byte-binds the local evidence; do not assemble individual job artifacts by
hand.

The release script always creates or reuses a draft first. After upload it
verifies the target commit, title, asset names, sizes, and GitHub `sha256:`
digests. `--no-draft` is a strict promotion-only path: the draft and all three
assets must already exist. It does not create a release, edit title/target,
upload, or `--clobber` assets; it compares the release ID plus every asset ID,
state, name, size, and digest before and after changing only the draft flag.
If the smoke/promotion gate was hardened after the draft bytes were built, run
from the newer clean gate checkout with
`--release-commit <draft-target-full-sha>`. The script accepts only an ancestor
of the gate commit, and package, evidence, and remote target checks remain
bound to that release SHA.
`--no-draft` requires
all three default targets; a partial target set cannot be published. An already
published release is read-only: the script verifies the exact three-platform
set and exits idempotently when it matches, without clobbering, editing, or
replacing assets. Do not use `--skip-build` unless those same-version,
same-commit packages were just built.

Single-target draft candidate (not independently promotable):

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
The packager also runs `notarytool info` for the same submission, requires
`Accepted`, and writes only a minimal `NOTARIZATION-RECEIPT.json` into the final
zip. The notary profile is a local `notarytool` Keychain credential alias, not
a provisioning profile. Keep the API private key out of the repository and
release logs.

Packaging discovers nested native code by Mach-O file magic rather than file
extension or executable mode, then signs each Mach-O inside-out. Re-signing an
upstream-signed Node/Claude runtime preserves only its existing identifier and
entitlements. Do not inject JIT entitlements into arbitrary unsigned Mach-O
files or replace this flow with `codesign --force --deep`. The final zip
verifier checks every Mach-O signature and the required Node/Claude runtime
entitlements.

## User Data Directories

Windows user operations are authoritative in the
[Windows Setup And Run Guide](../getting-started/windows.en.md). This section defines the
packaging and operations path contract only.

- Windows: `%LOCALAPPDATA%\SmartPerfetto` is the data root. It directly contains
  `backend/`, `providers/`, `uploads/`, `user/`, `logs/`, and `env`; there is no extra
  `data/` layer.
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
SmartPerfetto.exe --migrate-from "C:\path\to\old-package"
```

Run explicit migration before the first standard start and before the destination exists.
An existing destination makes the command fail without merging or overwriting; source and
destination are preserved. Automatic sibling discovery selects only the newest version that
is strictly older than the current package. It skips conservatively when the current package
version cannot be parsed.

Set `SMARTPERFETTO_PORTABLE_MODE=1` only when data must intentionally travel
beside the package. That mode keeps package-local `data/` and `logs/` and
disables automatic and explicit migration. Use `SMARTPERFETTO_PORTABLE_DATA_DIR` to override
the full portable data root for tests or operations; it also disables migration. The launcher
derives backend, Provider, uploads, and user paths from that root. Do not use
`SMARTPERFETTO_BACKEND_DATA_DIR` as a portable-root override.

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
test the final zip recreated after notarization and stapling. The current
compatibility floors are Windows 10 / Windows Server 2016 or newer on x64,
macOS arm64 13.5+, and Linux x64 glibc 2.34+. The static verifier scans every
packaged Mach-O/ELF and rejects native requirements above the manifest/
Info.plist declaration.

Run the shared smoke command on the OS/architecture declared by the archive:

```bash
node scripts/smoke-portable-archive.cjs \
  --asset "<final-archive>" \
  --target "<windows-x64|macos-arm64|linux-x64>" \
  --version "<version>" \
  --commit "<release-commit>" \
  --public-release \
  --output-dir "<evidence-dir>"
```

For local pre-commit validation of uncommitted code only, explicitly add
`--allow-dirty`. It cannot be combined with `--public-release`, and its result
cannot be promoted. A public release must still build once and smoke from the
exact clean commit.

The command first applies safe archive path/link checks and the static verifier,
then starts the launcher from those same archive bytes. It uses isolated data
and log directories, explicit `127.0.0.1` health, bundled Node/Claude/OpenCode
commands, and a minimal trace-processor query. It requests auditable graceful
shutdown through launcher `--shutdown-file`; `--lifecycle-receipt` records
process containment, child PIDs, exit codes, escalation, and port release.
Windows must establish a kill-on-close Job Object, while macOS/Linux services
use independent process groups. Launcher/backend/frontend logs are preserved
on failure. The command rejects a host that does not match `--target`.
On Windows it also loads `better-sqlite3` and `sodium-native`, runs a local Provider
Create/Activate/Get/Cleanup lifecycle, and uses packaged backend code to exercise DPAPI
SecretStore put/get/reopen. The default Provider path and enterprise SecretStore remain two
separate pieces of evidence.
`--public-release` produces public-promotion evidence and also
checks Developer ID, Gatekeeper, the notarization staple, and the `Accepted`
notary receipt on macOS. Omit it only for draft-package smoke.

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
