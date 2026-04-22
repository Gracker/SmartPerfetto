<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<!-- Copyright (C) 2024-2026 Gracker (Chris) | SmartPerfetto -->

# Security Policy

## Reporting a Vulnerability

SmartPerfetto processes Android performance traces, which may contain
sensitive device information (app package names, system calls, kernel
events). We take security and privacy seriously.

If you discover a vulnerability, please **do not** file a public GitHub
issue. Instead:

**Preferred**: Use GitHub's private [security advisory](https://github.com/Gracker/SmartPerfetto/security/advisories/new) reporting.

**Alternative**: Email **smartperfetto@gracker.dev** with:
- A description of the vulnerability and its impact
- Steps to reproduce (a minimal proof of concept helps)
- Your name / handle for attribution (optional)

## Response Timeline

| Phase | Target |
|-------|--------|
| Acknowledgement | Within 48 hours |
| Initial assessment | Within 7 days |
| Patch + public advisory | Within 30 days (critical) / 90 days (non-critical) |

If a vulnerability is actively being exploited, we may publish a patched
release before the full disclosure window elapses.

## Scope

**In scope:**
- SmartPerfetto backend (`backend/`)
- SmartPerfetto Perfetto plugin (`perfetto/ui/src/plugins/com.smartperfetto.AIAssistant/`)
- Skill system (`backend/skills/`)
- CI/CD workflows (`.github/workflows/`)
- Shell scripts in `scripts/` and `backend/scripts/`

**Out of scope:**
- The upstream Perfetto project (`perfetto/` submodule root) — please report
  upstream Perfetto issues to [google/perfetto](https://github.com/google/perfetto/security).
- Third-party dependencies — please report to the respective maintainers.
- Social engineering, physical attacks, DoS against our infrastructure.

## Supported Versions

SmartPerfetto is pre-1.0 and under active development. Security patches
target `main`; older tags receive fixes only on request.

| Version | Supported |
|---------|-----------|
| `main` (latest) | ✅ |
| Tagged `0.x` releases | ⚠️  Best effort |

## Our Security Practices

- **No secrets in repo**: API keys, tokens, and credentials live in `.env`
  files (gitignored) or GitHub Secrets.
- **LLM trust boundary**: User-provided trace data and AI-generated content
  never flow into SQL statements or shell commands without validation.
- **Sandboxed trace processing**: `trace_processor_shell` runs as a
  subprocess with restricted HTTP RPC ports (9100–9900).
- **Input redaction**: Logged request bodies and device properties go through
  `sanitizeLogData` before persistence (see
  `backend/src/services/sessionLogger.ts`).

## Acknowledgements

We will credit reporters in release notes unless requested otherwise.
Thank you for helping keep SmartPerfetto safe.
