# Platform Compatibility And Verification Boundaries

[English](platform-compatibility.en.md) | [中文](platform-compatibility.md)

<!-- i18n-headings: paired -->

SmartPerfetto has four distribution/runtime families, with additional product
entry points inside those families. Host OS, actual runtime OS, and release
evidence are not interchangeable. Docker Desktop on macOS still runs a Linux
container, and a cross-built Windows archive is not evidence that the archive
started successfully on Windows.

| Entry | Recommended host / target | CPU architecture boundary | Runtime bundled | Update path | Current evidence category |
|---|---|---|---|---|---|
| Source Web (`./start.sh`) | macOS and Linux; use WSL2 for native Windows development | Constrained by Node.js 24, Go, and current native dependencies | No; uses host Node.js and prepares the pinned trace processor | Synchronize Git, then restart | Source build, readiness, and repository gates |
| npm CLI (`smp`) | macOS, Linux, or Windows shells supported by Node.js 24 | Linux x64, macOS arm64, and Windows x64 bundle trace processor; other hosts use a pinned download and may be unsupported | CLI runtime is in the npm package; no Web launcher | Install an explicit newer npm version | npm pack contract plus real empty-directory install smoke |
| Docker image | Any Docker host that can run the compatible Linux container; the actual runtime is Linux | Published images are `linux/amd64` and `linux/arm64` | Yes; Node, backend, committed UI, and pinned trace processor | Pull an explicit tag and recreate the container | Image build/health plus published tag/manifest acceptance |
| Portable archive | Windows 10 / Windows Server 2016 or newer on x64, macOS arm64 13.5+, or Linux x64 glibc 2.34+ on the matching target; musl systems such as Alpine are unsupported | Each archive supports only the target declared by its filename and manifest; Windows and macOS minimum versions are recorded in the manifest, and macOS also follows the packaged `LSMinimumSystemVersion` | Yes; launcher, Node, native dependencies, backend, committed UI, and pinned trace processor | Download the new archive and follow platform data migration/retention guidance | Static package contract + full-payload ELF/Mach-O minimum-version audit + matching-target exact-archive runtime smoke + GitHub release acceptance |

## Evidence Categories

1. **Packaged/static contract** verifies version, target, manifest, layout,
   pinned dependencies, and static signatures. It finds malformed archives but
   does not prove target-OS startup.
2. **Target-native runtime smoke** runs the same final bytes on the declared
   OS/architecture and checks `127.0.0.1` health, bundled runtimes, a minimal
   trace-processor query, controlled shutdown, and port release.
3. **Published-surface acceptance** verifies immutable versions, remote
   digests, tag/manifests, or empty-directory installs on the distribution
   surface. A local build cannot substitute for this evidence.

When one layer is missing, report only the layers that were actually completed.
A Windows/Linux cross-build is not a Windows/Linux runtime smoke, and the
Docker host OS is not the container target.

## Network Binding Boundary

Source Web binds both services to IPv4 loopback `127.0.0.1` by default. A
maintainer can explicitly expose the source frontend with
`SMARTPERFETTO_FRONTEND_BIND_HOST`; doing so changes the local security
boundary, regardless of whether logs or access URLs still use loopback. The
portable launcher fixes both service bind hosts to `127.0.0.1` instead of
inheriting ambient bind-host variables, so provider and trace data are not
accidentally exposed. Docker binds to `0.0.0.0` inside the container, while
the compose publish host controls host exposure and defaults to host
`127.0.0.1`.

## Sources Of Truth

- Installation and first run: [Quick Start](../getting-started/quick-start.en.md)
- Node, providers, and deployment configuration: [Configuration](../getting-started/configuration.en.md)
- npm CLI platforms and fallback: [CLI](cli.en.md)
- Portable targets, data directories, and migration: [Portable Packaging](portable-packaging.en.md)
- Release order and published-surface acceptance: [Release](release.en.md)
- Agent/maintainer verification gates: [Testing Rules](../../.claude/rules/testing.md)
- UI/CLI update notices and distribution-specific actions: [Application Updates](../../README.md#application-updates)

Application update checks report an available version and the recommended
action. They do not replace a running source checkout, npm package, Docker
container, or portable directory.
