# Use Your Own Device And Team Knowledge

[English](private-knowledge.en.md) | [中文](private-knowledge.md)

Add definitions of device-specific tags, trace passages, thread responsibilities,
version differences and known issues as **document knowledge bases**. They are
independent of source code access; no source checkout or source-text mode is
needed. Knowledge helps explain names and mechanisms; what happened, how long it
took and whether it caused jank still require current-trace SQL/Skill evidence.

## Prepare Documents

Place documents in a folder accessible to the backend machine. Export documents
from a phone first; there is no direct phone knowledge-base connection or sync.
Supported formats are `.md .markdown .mdx .txt .rst .adoc .html .htm`; PDF is not
indexed directly. Use the full tag as a heading and describe meaning, parameters,
device/system version and applicability, for example:

```markdown
# ExamplePhone render tags (example)

## VendorFrameCommit
Applies to: ExamplePhone, system version 3.x.
Meaning: the render thread submits this frame's layers; not proof of presentation.
Parameter: frameId is the application frame number.
Diagnosis: check actual fence waits and FrameTimeline for delays.
```

This is an example definition, not a fact about a real device. Accurate documents
and clear applicability reduce guesses; stale or conflicting documents can also
mislead. Reindex after changing files.

## Use It On The Web

1. Open the context control beside the AI Assistant composer → "Manage…" →
   "Document knowledge bases" → "Add a folder".
2. Give it a name and coverage description, preview indexed/skipped files,
   acknowledge your rights and review the AI-service disclosure.
3. Register and index it, then allow matching text to be sent to the configured
   AI service. Try searching for a full tag first.
4. Select the knowledge base in the context control for this turn, then ask,
   for example: "Use the device docs to explain VendorFrameCommit, then check
   whether it relates to jank in this trace."

Registration does not select a base. Rights acknowledgement, provider-send
consent and an active index are required. Knowledge selection is independent of
the source switch. A remote backend cannot read the browser machine's folders;
Docker needs a mounted folder, and manually entered paths must be within
`SMARTPERFETTO_KNOWLEDGE_ROOTS`.

## Use It In The CLI

```bash
smp knowledge preview ./device-docs
smp knowledge register ./device-docs --accept-rights \
  --name "Device tag notes" --description "Device/version-specific tags, parameters and trace passage explanations" \
  --send-to-provider
smp knowledge reindex <registered-sourceId>
smp knowledge search <sourceId> "VendorFrameCommit" --top-k 5
smp analyze ./trace.pftrace --knowledge-source-id <sourceId> \
  --query "Explain VendorFrameCommit using the device docs and check this trace"
```

Replace placeholders such as `<sourceId>` with the registration's returned ID.
CLI and Web use separate data directories by default; a CLI registration does
not automatically appear in the Web list. See [CLI Configuration](../reference/cli.en.md).

## See Retrieval And Citations

The model searches with `search_knowledge` and reads relevant sections with
`read_knowledge_section`. Full-name/phrase matches rank first, with subword and
Chinese-term recall retained. This is full-text retrieval; it does not
automatically resolve every synonym. Excerpts show only the start of a chunk;
section reads may be needed. Budget limits, no matches, version conflicts and
partial reads cannot be presented as confirmed knowledge.

Answers cite «Title › Section» with `kb:relative/path#Lstart-Lend`. "Knowledge
use" below an answer shows:

- **Delivered passages**: references actually sent to the model this turn;
  retrieval does not mean the answer used them.
- **Answer citations**: locations written in the answer, with an explicit
  "No knowledge citations in the answer" when none were cited. Expand for text
  delivered, located only, not returned, or ambiguous matches across bases.
  These statuses check location and delivery, not factual correctness or causality.

Local history receipts store counts only. Answer citations and quotations may
remain in local analysis history, HTML reports, CLI artifacts and snapshots;
the report's internal-knowledge section retains location checks. Missing delivery
records mean not recorded, never zero use.

## Private Content Boundaries

Local indexes are owner/workspace-scoped. Each run searches only its explicitly
selected, authorized bases at pinned index versions. Matching passages are sent
to the configured AI service, including an internal company service; this does
not guarantee that text never leaves the machine. AI-service retention depends
on its configuration and policy; local results may retain quotations. Revocation
or deletion stops later access, leaves the original folder intact and cannot
recall text already sent.

Document instructions grant no tool authority and knowledge citations are not
trace evidence. Public system material follows the same path; see
[Android Internals Wiki](android-internals-knowledge.en.md).
