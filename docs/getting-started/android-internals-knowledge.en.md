# Android Internals Knowledge Pack And Private Knowledge

[English](android-internals-knowledge.en.md) | [中文](android-internals-knowledge.md)

SmartPerfetto ships a signed, version-locked public Android Internals Knowledge
Pack by default. Users do not need the maintainer's local checkout or access to
the private `android-internals-wiki` repository. npm, Docker, and portable
artifacts carry the same verified snapshot. The runtime can independently update
it through TUF and retains the last known good version if validation fails.

Operators may separately register a local `android-internals-wiki` checkout they
are authorized to use. That private path keeps its path allowlist, rights
acknowledgement, and provider privacy consent; it does not weaken the public
Pack boundary.

Both paths provide Android background explanations only. A knowledge hit cannot
prove the root cause in the current trace. Diagnoses still require current-trace
evidence from `execute_sql`, `invoke_skill`, or an equivalent evidence tool.

## Built-in Public Knowledge Pack

- Every AIW `master` change builds a candidate. A scheduled job rebuilds from an
  exact SHA at 00:30 Asia/Shanghai and promotes changed public content.
- Body content under `src/` is not filtered by workflow state or review queue:
  draft, review, finalized, deprecated, and metadata-incomplete bodies are all
  included. Navigation files such as `README.md`/`SUMMARY.md` and explicitly
  generated reports are excluded.
- Strict frontmatter results, Task 6/Task 9, queue, and status remain in the
  audit but no longer grant or block body inclusion. Invalid metadata uses
  stable title/path fallbacks; files whose body boundary cannot be recovered
  safely fail closed.
- An unchanged public-content fingerprint is a successful no-op. Changed content
  receives an immutable `YYYY.MM.DD.N` version.
- The public distribution repository contains TUF metadata, compressed SQLite,
  an audit summary, and licenses—not Markdown sources, review logs, queues, or
  raw local paths. Private-context lines are redacted as whole lines, and a
  high-confidence secret blocks the entire publication.
- A session pins `contentVersion + contentFingerprint`. A background update
  never silently switches an active session; emergency revocation requires a
  new analysis context.
- The model receives budgeted, secret-redacted snippets. Logs and SSE retain
  citation metadata and snippet hashes only.

Inspect or update it with:

```bash
smp knowledge-pack status
smp knowledge-pack update --check
smp knowledge-pack update
```

The default worker checks once per day. Use
`SMARTPERFETTO_AIW_PACK_UPDATE_MODE=check|off`, or pin an installed,
non-revoked version with `SMARTPERFETTO_AIW_PACK_PIN`. Mirrors can set
`SMARTPERFETTO_AIW_PACK_METADATA_BASE_URL` and
`SMARTPERFETTO_AIW_PACK_TARGET_BASE_URL`.

Pack content is dual-licensed under
`CC-BY-NC-SA-4.0 OR LicenseRef-AIW-Commercial`. Possessing the Pack does not
grant commercial rights; commercial use requires separate written
authorization. Each Pack carries the complete licenses and attribution.

## Private Checkout Security And License Boundaries

- Paths are denied by default. Only Markdown below `SMARTPERFETTO_KNOWLEDGE_ROOTS` can be previewed or indexed.
- `rightsAcknowledged` is the operator's separate acknowledgement that they have the right to use the checkout; it grants no license. The connector records `CC-BY-NC-SA-4.0`. Commercial use requires the operator to obtain applicable authorization.
- `sendToProvider` is a distinct, revocable privacy consent. Setting it to `false` immediately fails closed for new indexing and retrieval.
- Every analysis must explicitly select source ids through `options.knowledgeSourceIds`. The registry also rechecks tenant/workspace/user scope, rights, consent, and the active generation.
- The model receives only budgeted, secret-redacted hits. SSE and logs project chunk ids, hashes, lengths, licenses, attribution, and trust metadata; ordinary `/chunks/:id` and `/search` admin reads do not return private Wiki chunks at all.
- Only strictly parsed `finalized` or legacy `verified` articles are retrievable. Review, draft, deprecated, duplicate, and metadata-error rows remain auditable but are not normal explanation sources.

## 1. Allow The Local Path

For source runs, add an absolute path to `backend/.env`:

```bash
SMARTPERFETTO_KNOWLEDGE_ROOTS=/absolute/path/to/android-internals-wiki
```

For Docker, mount the checkout read-only and use its container path:

```yaml
services:
  smartperfetto:
    volumes:
      - /host/android-internals-wiki:/knowledge/android-internals-wiki:ro
    environment:
      SMARTPERFETTO_KNOWLEDGE_ROOTS: /knowledge/android-internals-wiki
```

Separate multiple roots with the platform path delimiter (`:` on macOS/Linux, `;` on Windows), then restart the backend.

## 2. Preview, Register, And Index

These `/api/rag` endpoints require a Bearer token in shared deployments and the corresponding codebase read/manage permission.

```bash
curl -X POST http://localhost:3000/api/rag/android-internals/preview \
  -H 'Content-Type: application/json' \
  -d '{"rootPath":"/absolute/path/to/android-internals-wiki"}'

curl -X POST http://localhost:3000/api/rag/android-internals/sources \
  -H 'Content-Type: application/json' \
  -d '{
    "rootPath":"/absolute/path/to/android-internals-wiki",
    "displayName":"Android Internals Wiki",
    "rightsAcknowledged":true,
    "sendToProvider":true
  }'

curl -X POST http://localhost:3000/api/rag/android-internals/sources/<sourceId>/reindex
```

Reindexing uses a staged generation. The registry switches the active generation only after all chunks are written and counted, then removes older and failed staged generations for that source. Cleanup failure does not roll back the already usable generation; the response reports `cleanup.status=failed` for operator follow-up. Source identity records the Git revision, accepted-content fingerprint, and dirty state so local edits cannot be mislabeled as a clean commit.

## 3. Enable It For One Analysis

`knowledgeSourceIds` is a per-request capability; SmartPerfetto never enables every registered source implicitly:

```bash
curl -X POST http://localhost:3000/api/agent/v1/analyze \
  -H 'Content-Type: application/json' \
  -d '{
    "traceId":"trace-id",
    "query":"Explain this Handler callback in MessageQueue terms and separate background knowledge from trace evidence",
    "options":{
      "analysisMode":"full",
      "knowledgeSourceIds":["<sourceId>"]
    }
  }'
```

In full mode, the agent uses the existing `lookup_blog_knowledge` tool with `source=android_internals_wiki` and the same `knowledge_source_id`. A missing request allowlist, scope mismatch, revoked consent, or missing active generation produces an unavailable result instead of falling back to unauthorized content.

## 4. Audit, Revoke, And Clear

```bash
curl http://localhost:3000/api/rag/android-internals/sources
curl http://localhost:3000/api/rag/android-internals/sources/<sourceId>/audit

curl -X PATCH http://localhost:3000/api/rag/android-internals/sources/<sourceId>/consent \
  -H 'Content-Type: application/json' \
  -d '{"sendToProvider":false}'

curl -X DELETE http://localhost:3000/api/rag/android-internals/sources/<sourceId>/index
```

The audit returns one metadata-only disposition row per official article. Clear deactivates the source generation and removes all staged and old-generation chunks while retaining registration. Local JSON mode stores the index in backend data/log state; enterprise mode uses the scoped knowledge store. Neither mode writes the cache into Git.

## 5. Full-Corpus Skill Audit

Maintainers can audit the checkout without registering or indexing prose:

```bash
cd backend
npm run knowledge:android-internals:audit -- \
  --repo /absolute/path/to/android-internals-wiki \
  --output /tmp/android-internals-audit.json
```

The audit applies the official `src/**/*.md` article rule and assigns every article one disposition:

- `validated_trace_skill`: article path, observable claim, Skill id, and real fixture assertion all match.
- `candidate_skill_match`: live Skill metadata matches, but a real semantic assertion is still missing.
- `explanation_only` / `non_perfetto`: background only or outside Perfetto scope.
- `deferred_missing_schema_or_fixture`: no portable schema or fixture yet.
- `metadata_error` / `duplicate_or_superseded`: excluded from normal retrieval.

The CLI prints aggregate counts only. A full article-level report is written only to the operator-selected external path and should not be committed to SmartPerfetto.
