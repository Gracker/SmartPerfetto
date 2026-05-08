# SmartPerfetto Documentation Center

[English](README.en.md) | [中文](README.md)

SmartPerfetto is an Android performance analysis platform built on Perfetto. This documentation center is organized for open-source users, contributors, and maintainers: first get the project running, then learn the architecture, then extend it.

## Recommended Reading Paths

| Reader | Start here | Continue with |
|---|---|---|
| First-time user | [Quick Start](getting-started/quick-start.en.md) | [Configuration Guide](getting-started/configuration.en.md), [Basic Usage](getting-started/usage.en.md), [Windows EXE Packaging](reference/windows-exe.en.md) |
| Backend API integrator | [API Reference](reference/api.en.md) | [MCP Tools Reference](reference/mcp-tools.en.md) |
| CLI or automation user | [CLI Reference](reference/cli.en.md) | [API Reference](reference/api.en.md) |
| Contributor | [Local Development](development/local-development.en.md) | [Testing and Verification](development/testing.en.md), [Contributing Guide](../CONTRIBUTING.md) |
| Skill author | [Skill System Guide](reference/skill-system.en.md) | [MCP Tools Reference](reference/mcp-tools.en.md), [Testing and Verification](development/testing.en.md) |
| Architecture reader | [Architecture Overview](architecture/overview.en.md) | [Data Contract](../backend/docs/DATA_CONTRACT_DESIGN.en.md) |
| Deployment troubleshooter | [Troubleshooting](operations/troubleshooting.en.md) | [Configuration Guide](getting-started/configuration.en.md) |

## Documentation Structure

```text
docs/
├── README.md                         # Chinese documentation entry
├── README.en.md                      # English documentation entry
├── getting-started/                  # Installation, configuration, usage
├── architecture/                     # Current architecture and authoritative design
├── features/                         # Feature-specific development docs
├── reference/                        # API, CLI, MCP, and Skill DSL references
├── development/                      # Development and verification workflow
├── operations/                       # Runtime operations and troubleshooting
├── rendering_pipelines/              # Runtime-read Android rendering pipeline knowledge
├── product/                          # External project positioning
├── archive/                          # Historical proposals, spikes, and decisions
└── images/                           # Documentation images
```

## Authoritative Docs

- Startup and runtime flow: [Quick Start](getting-started/quick-start.en.md), [Windows EXE Packaging](reference/windows-exe.en.md), and [Local Development](development/local-development.en.md).
- Provider and model configuration: [Configuration Guide](getting-started/configuration.en.md).
- Backend API: [API Reference](reference/api.en.md).
- CLI usage: [CLI Reference](reference/cli.en.md).
- MCP tools: [MCP Tools Reference](reference/mcp-tools.en.md).
- Skill DSL and layered outputs: [Skill System Guide](reference/skill-system.en.md).
- DataEnvelope and frontend/backend contracts: [Data Contract](../backend/docs/DATA_CONTRACT_DESIGN.en.md).
- Rendering pipeline summary: [Rendering Pipeline Overview](rendering_pipelines/index.en.md).

## Runtime-Read Documentation

`docs/rendering_pipelines/` is not only normal documentation. Teaching mode, pipeline detection, and some Skill results refer to these Markdown files through `doc_path: rendering_pipelines/*.md`. Moving or renaming those files requires synchronized updates to:

- `backend/skills/pipelines/*.skill.yaml`
- `backend/skills/atomic/rendering_pipeline_detection.skill.yaml`
- `backend/src/services/pipelineDocService.ts`
- `backend/src/config/teaching.config.ts`

After such a change, run at least:

```bash
cd backend
npm run validate:skills
npm run test:scene-trace-regression
```
