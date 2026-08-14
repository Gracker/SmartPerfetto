# Application Updates

[English](application-updates.en.md) | [中文](application-updates.md)

<!-- i18n-headings: paired -->

SmartPerfetto checks public release metadata and reports when a newer build is
available. Update checks are notification-only: they never install a package,
replace files, edit a source checkout, restart a container, or change the
running application without an explicit user action.

## What The Update Check Reports

The result identifies the current build, detected distribution, release
channel, latest matching version, last check time, and recommended action.
Stable Docker releases use immutable SemVer tags; the mutable `nightly` tag is
shown only when that channel was selected explicitly.

## User Interfaces

### Web UI

The AI Assistant banner and **Settings → Application Update** show the current
status and the action for the detected distribution. Use **Check now** to
refresh public release metadata explicitly.

### CLI

The npm CLI exposes the same status:

```bash
smp update check
smp update check --format json
```

Interactive text commands may print a rate-limited update reminder to stderr
after they finish. CI, redirected output, machine-readable commands, help,
version output, and the `update` command itself do not receive an extra
reminder. See the [CLI Reference](../reference/cli.en.md#application-updates)
for the complete command contract.

## Distribution-Specific Actions

| Distribution | Recommended action |
|---|---|
| npm CLI | Run the displayed `npm install -g` command. |
| Docker stable | Pin the displayed immutable SemVer tag, then pull and recreate the service. |
| Docker nightly | Continue with the mutable `nightly` tag only when that channel was chosen explicitly. |
| Portable package | Download the matching target asset and verify the displayed SHA256 when GitHub exposes one. |
| Source checkout | Inspect the linked commit or release, then update through the normal Git workflow. |

Portable updates do not overwrite an existing installation or user-data
directory. Follow the platform guide before replacing a package or moving
data: [Windows Guide](windows.en.md) or
[Portable Packaging](../reference/portable-packaging.en.md).

## Disable Update Checks

Set the following environment variable before launch to disable application
update checks and reminders:

```bash
SMARTPERFETTO_UPDATE_CHECK=off
```

## Related References

- [CLI update command](../reference/cli.en.md#application-updates)
- [Update API](../reference/api.en.md#application-updates)
- [Platform Compatibility](../reference/platform-compatibility.en.md)
