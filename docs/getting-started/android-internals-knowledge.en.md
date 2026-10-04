# Using The Android Internals Wiki As A Knowledge Base

[English](android-internals-knowledge.en.md) | [中文](android-internals-knowledge.md)

The [Android Internals Wiki](https://github.com/Gracker/android-internals-wiki)
(AIW) is a public collection of Android system-mechanism and performance-analysis
material. SmartPerfetto no longer bundles it and no longer has a connector made
only for it. Register the AIW `src/` folder as a **document knowledge base** and
it follows the same path as your own team documents: the same retrieval, the
same two tools (`search_knowledge` / `read_knowledge_section`), the same
`kb:path#Lstart-Lend` citations, and the same privacy rules.

A knowledge base supplies background, not trace evidence. What happened in this
trace must still be proven by current-trace evidence such as Skills and SQL; a
statement based only on the knowledge base is labelled as such.

## 1. Get The Content

```bash
git clone https://github.com/Gracker/android-internals-wiki.git
```

AIW content is dual-licensed `CC-BY-NC-SA-4.0 OR LicenseRef-AIW-Commercial`.
Commercial use needs a separate written commercial license. The rights
acknowledgement you give at registration states that you may use the
documents; it does not grant a license.

## 2. Register It As A Document Knowledge Base

Register only the `src/` folder. The repository root also holds build scripts
and generated output, which lower retrieval quality.

Web UI: open "Manage…" from the context control in the AI Assistant composer,
choose the `android-internals-wiki/src` folder under "Document knowledge bases",
review which files will be indexed or skipped, then register and index it. Name
it `Android Internals Wiki` and describe its coverage (for example "Android
system mechanisms and performance analysis: startup, rendering, Binder,
scheduling, memory, GC, locks, and IO"); the model uses the description to
decide when to search it.

CLI:

```bash
smp knowledge register ./android-internals-wiki/src --accept-rights \
  --name "Android Internals Wiki" \
  --description "Android system mechanisms and performance analysis: startup, rendering, Binder, scheduling, memory, GC, locks, and IO" \
  --send-to-provider
smp knowledge reindex eks_xxx
smp knowledge search eks_xxx "Choreographer doFrame" --top-k 5
```

Server deployments that do not use the local folder picker must add the folder
to `SMARTPERFETTO_KNOWLEDGE_ROOTS`; Docker must mount it read-only first. After
`git pull`, reindex. The previous generation keeps serving running analyses
until the new one is ready.

## 3. Use It In An Analysis

Tick the knowledge base in the composer's context control, or pass
`--knowledge-source-id eks_xxx` in the CLI. Only a knowledge base with a rights
acknowledgement, provider consent, and an active index can be selected, and the
selection applies per turn; registered knowledge bases are never enabled
implicitly.

The model searches when it meets an unfamiliar thread, slice, module, internal
term, or known issue; it does not scan in bulk. In measured runs (DeepSeek,
startup, scrolling, and mechanism-explanation questions) it searched on its own
only in some runs. If you want an answer grounded in AIW, say so in the
question. Citations, the delivery record (`knowledge_use@1`), and the report's
"cited internal material" section are described in
[CLI Reference · Document Knowledge Bases](../reference/cli.en.md#document-knowledge-bases).

## Migrating From Earlier Versions

- **The built-in Knowledge Pack is removed.** The `smp knowledge-pack` command,
  the `SMARTPERFETTO_AIW_PACK_*` environment variables, the
  `androidInternalsKnowledgePack` field of `/health`, and the doctor Pack line
  are gone. Releases no longer carry a Pack snapshot or check for Pack updates in
  the background. In measured runs the model almost never called it (the only
  unprompted call in historical sessions retrieved an unrelated article), so its
  package size, background updates, and second citation contract bought no
  accuracy. Previously downloaded Pack versions remain under
  `knowledge-packs/android-internals/` in the backend data directory and can be
  deleted by hand.
- **The legacy Wiki connector is retired.** Wikis registered through
  `/api/rag/android-internals/*` are still listed among knowledge bases, marked
  retired, and can no longer be selected (an analysis is refused with
  `ANALYSIS_CONTEXT_SOURCE_RETIRED`); those endpoints now answer 410. Delete the
  old entry and register `src/` as a document knowledge base as above.
- Pack background references recorded in earlier sessions, reports, and
  snapshots are kept and still shown; new analyses no longer produce them.
