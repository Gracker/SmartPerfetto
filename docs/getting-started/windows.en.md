# Windows Setup And Run Guide

<!-- i18n-headings: paired -->

[English](windows.en.md) | [中文](windows.md)

This is the canonical Windows user path from download through troubleshooting.
Maintainer packaging and release contracts live in
[Windows Packaging](../reference/windows-exe.en.md); shared Provider fields live in
[Configuration](configuration.en.md).

## Check Before You Start

- Most Windows users should choose the **windows-x64 portable archive**. It does not require
  a separate Node.js, Git, Python, or Docker installation.
- Only an x64 archive is published today. There is no native Windows ARM64 artifact.
- The package manifest has a technical floor of Windows 10 / Windows Server 2016. Current
  final-archive automation runs on GitHub-hosted Windows Server 2025 x64. Windows 11 x64
  that is still in support is recommended for desktop use; a technical floor is not proof
  that every older desktop release has been manually accepted.
- Docker Desktop with the WSL2 backend is an alternative for container deployment. Use WSL2
  or another development environment only when working from source.

## 1. Download And Verify

1. Open the [official Latest Release](https://github.com/Gracker/SmartPerfetto/releases/latest).
2. Download **smartperfetto-vVERSION-windows-x64.zip**. Do not download Source code (zip);
   that archive is not the runnable Windows package.
3. Open PowerShell in the download directory:

        Get-FileHash .\smartperfetto-vVERSION-windows-x64.zip -Algorithm SHA256

4. Compare the result with the SHA256 digest shown for the asset on the Release page.
   Do not run the file when its name, version, or digest differs.

## 2. Extract The Complete Archive

Right-click the zip in Explorer and choose Extract All. Do not run from the zip preview and
do not copy only SmartPerfetto.exe. The backend, frontend, Node.js, and native runtimes are
part of the same directory tree.

Use a short, normal, user-writable local path, for example:

    C:\Apps\SmartPerfetto\vX.Y.Z

For first troubleshooting, avoid Program Files, network drives, and OneDrive-synchronized
directories. Spaces and non-ASCII names are supported, but retry from a short ASCII path
when security software or an older extraction tool reports an error.

## 3. SmartScreen And Defender

The current public Windows launcher is not Authenticode-signed. Windows may show Unknown
Publisher, a SmartScreen “Windows protected your PC” message, or an enterprise policy may
block execution. This is a known release gap; SHA256 verification does not replace signing.

- Continue only when the file came from the official Release and its SHA256 matches.
- Do not disable Microsoft Defender globally or create a broad folder exclusion.
- If Defender quarantines a file, verify its source and digest first. Redownload instead of
  restoring a file whose identity cannot be confirmed.
- On a managed computer, contact IT or use Docker in an approved environment. Do not bypass
  AppLocker, WDAC, or enterprise EDR policy.

See Microsoft’s
[SmartScreen reputation documentation](https://learn.microsoft.com/windows/apps/package-and-deploy/smartscreen-reputation).

## 4. First Start

Double-click SmartPerfetto.exe in the extracted directory. To preserve the full error, open
PowerShell in that directory:

    .\SmartPerfetto.exe

The launcher prints:

    SmartPerfetto is running.
    Open: http://127.0.0.1:ACTUAL_PORT

Keep the launcher window open and use the actual Open: URL. The default frontend port is
10000, but the launcher selects another free port when it is occupied. A browser-open
failure does not mean startup failed; copy the URL manually. Services bind to 127.0.0.1
and do not listen on the LAN by default.

## 5. Configure And Activate A Provider

Open **AI Assistant Settings → Providers**:

1. Choose the Provider that matches your account. Treat the provider console as authoritative
   for protocol, Base URL, and model IDs.
2. Enter the **Provider API Key**. The backend auth token on the Connection page is not a
   model-provider key; it is needed only when an operator configured SMARTPERFETTO_API_KEY.
3. Check the runtime. Claude/Anthropic-compatible providers usually use the Claude Agent SDK;
   OpenAI/OpenAI-compatible providers usually use the OpenAI Agents SDK.
4. Save the Provider.
5. Run the connection test. Check Base URL, model IDs, protocol, proxy, and system time first
   when it fails.
6. Activate the Provider. Saving without activating keeps the previous active provider or
   the env fallback in effect.

Ordinary portable profiles are stored under
**%LOCALAPPDATA%\SmartPerfetto\providers**. This change does not move that default store to
DPAPI. Protect the Windows account and data directory, and do not upload that directory
publicly. When Windows enterprise database mode uses the local encrypted SecretStore, its
master key is protected with current-user DPAPI; an operator-configured master/server secret
still follows deployment configuration.

See [Configuration](configuration.en.md) for all fields and precedence rules.

## 6. Complete The First Analysis

1. Open the UI URL printed by the launcher.
2. Load a known-good Perfetto trace.
3. Open AI Assistant and start with one tightly scoped question.
4. Confirm that SQL/Skill evidence, a conclusion, and the report entry are available.

The timeline UI can open without a Provider, but model-backed analysis is rejected. Use a
small shareable sample for the first check instead of the only copy of a large production
trace.

## 7. Data, Credentials, And Logs

Standard mode keeps mutable data outside the extracted application directory:

    %LOCALAPPDATA%\SmartPerfetto\
      backend\
      providers\
      uploads\
      user\
      logs\
      env

- providers: local Provider profiles and related state.
- uploads: uploaded traces, which may contain sensitive data.
- user: upgrade-surviving user state.
- logs\backend.log and logs\frontend.log: troubleshooting logs.
- env: optional scripted Provider environment variables.

SMARTPERFETTO_PORTABLE_MODE=1 moves data and logs beside the executable. The user then owns
permissions, backup, and upgrades, and both automatic and explicit migration are disabled.

## 8. Stop, Restart, And Ports

- Stop cleanly with Ctrl+C in the launcher and wait for backend and frontend exit.
- Restart only after the previous launcher window has exited.
- Do not run several instances from the same extracted directory.
- Set SMARTPERFETTO_BACKEND_PORT and SMARTPERFETTO_FRONTEND_PORT before startup only when
  fixed ports are required. Without fixed values, the launcher selects free ports.
- A Windows Job Object cleans child processes when the console closes, the user signs out, or
  the machine shuts down. If a port remains occupied, follow the troubleshooting path.

## 9. Update, Back Up, And Migrate

Extract a new zip into a new directory. Do not overwrite the old application directory.
Standard-mode data lives under LOCALAPPDATA, so removing an old program directory does not
remove user data.

Stop SmartPerfetto and create a backup before updating:

    $source = "$env:LOCALAPPDATA\SmartPerfetto"
    $backup = "$env:LOCALAPPDATA\SmartPerfetto.backup-$(Get-Date -Format yyyyMMdd-HHmmss)"
    Copy-Item $source $backup -Recurse

Older releases could store data in a package-local data directory. On the first standard
start, the launcher copies from the current package or the newest strictly older sibling
and preserves the source. To select a source, run this before the first standard start and
before the destination exists:

    .\SmartPerfetto.exe --migrate-from "C:\path\to\old-package"

If **%LOCALAPPDATA%\SmartPerfetto** already exists, explicit migration fails while preserving
both source and destination. It never merges or overwrites. Back up and decide which copy is
authoritative before moving the destination and retrying. A rollback does not auto-import
from a newer sibling, but an older binary may still not understand a newer data schema.

## 10. Uninstall And Remove All Data

Deleting only the extracted application directory uninstalls the program and keeps
LOCALAPPDATA. For a complete removal:

1. Stop with Ctrl+C and close every SmartPerfetto window.
2. Back up traces, Provider configuration, and reports that must be retained.
3. Delete the application directory.
4. Delete **%LOCALAPPDATA%\SmartPerfetto** only after confirming no data is needed. This
   cannot be recovered by SmartPerfetto.

## Windows Troubleshooting

### The Browser Did Not Open Or The Page Is Unreachable

Check for SmartPerfetto is running. and open the actual Open: URL manually. Do not assume
the port is 10000. If the launcher exited, run .\SmartPerfetto.exe from PowerShell to retain
the error.

### The Backend Did Not Become Ready

Read the latest logs:

    Get-Content "$env:LOCALAPPDATA\SmartPerfetto\logs\backend.log" -Tail 200
    Get-Content "$env:LOCALAPPDATA\SmartPerfetto\logs\frontend.log" -Tail 200

When a bundled file is missing, remove the extracted directory and use Extract All on the
verified zip again. Do not mix node.exe, .node files, or trace_processor_shell.exe from
different versions.

### The Provider Was Saved But Analysis Does Not Run

Confirm that the Provider test passed and that the profile is active. Check runtime, Base URL,
model IDs, protocol, and proxy. The Connection backend token cannot replace a Provider API
key. Corporate proxies or TLS interception may require an administrator-provided trusted CA;
do not disable TLS verification.

### SmartScreen, Defender, Or Enterprise Policy Blocks The App

Verify the official Release and SHA256 again. Contact IT when managed policy offers no
approved continue path. Do not modify the registry, disable Defender, or bypass policy.

### Migration Says The Destination Already Exists

This is overwrite protection. Do not delete the destination immediately. Stop the app, back
up LOCALAPPDATA, compare the old source and current destination, then move the destination
before retrying. --migrate-from is unavailable while SMARTPERFETTO_PORTABLE_MODE or
SMARTPERFETTO_PORTABLE_DATA_DIR is active.

### Enterprise SecretStore Or DPAPI Fails

DPAPI is bound to the current Windows user and machine. Changing accounts, copying data to
another machine, or policy blocking Windows PowerShell/DPAPI can prevent enterprise local
SecretStore decryption. Do not delete .master-key.dpapi. Restore the original account/machine,
or have the deployment operator recover with the backed-up explicit master/server secret.

## Pre-Release Windows QA Checklist

Automation does not replace desktop acceptance. Before a public release, manually check:

- Windows 11 x64 under a standard non-admin account; test each older version that is promised.
- Explorer Extract All and PowerShell Expand-Archive.
- English/non-ASCII usernames, spaces, short paths, and a long-path boundary.
- Actual SmartScreen, Defender, and managed-security prompts.
- Edge, Chrome, Firefox, no default browser, and a busy default port.
- Provider Create → Save → Test → Activate and persistence after restart.
- Small trace load, AI analysis, and report generation.
- Package-local migration, an existing destination, upgrade, and rollback.
- Ctrl+C and console close cleanup, including child processes and released ports.

## Frequently Asked Questions

### Why Is The Zip Large

It includes Node.js 24, the backend, prebuilt Perfetto UI, target-native dependencies, Agent
runtimes, and a pinned trace_processor_shell, so these runtimes do not need separate installs.

### Can Windows ARM64 Run It

There is no native Windows ARM64 artifact or acceptance commitment. System emulation of the
x64 build is outside the current release verification boundary.

### Why Is The URL Not On Port 10000

The launcher selects another port when the default is busy. Always use the printed Open: URL.

### Does Deleting The Program Directory Delete Data

Not in standard mode; data stays under LOCALAPPDATA. True portable mode keeps data beside the
program, so back it up before deleting that directory.

### May I Disable Defender

No. Verify the official source and SHA256, and contact IT when managed policy blocks execution.
The release chain still needs Authenticode and timestamping to improve identity and reputation.

## What To Include In A Bug Report

Include the Windows version and OS build, x64/ARM64, admin status, asset filename and SHA256,
path type, complete launcher error, the final 200 lines from both logs, the actual Open: port,
and which Provider save/test/activate step failed.

Remove API keys, Authorization headers, cookies, corporate domains, usernames, trace content,
and personal path components. Do not upload traces, providers.json, env, .master-key.dpapi, or
the entire LOCALAPPDATA directory by default.
