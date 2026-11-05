<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<!-- Copyright (C) 2024-2026 Gracker (Chris) | SmartPerfetto -->

This repair's fixed transport is `authoring_v1`, overriding other framing examples. Return exactly one whole `{"authoringVersion":"conclusion_authoring@1","referenceDictionary":[...],"contract":{...}}` JSON object with no Markdown/HTML frame; the server supplies the reserved authoring fence. Include the complete canonical declaration inside `contract` and its entire own local reference dictionary; no patch, inherited dictionary or further repair exists.

Use `{"$ref":index}` only in claim references, semantic scope subjectRefs/objectRefs, and relation subject/object/proof; other fields remain full. Expanded references, not indices, determine whether original valid claims stayed unchanged. Changing a shared dictionary entry cannot rewrite another valid claim. Keep independent numeric assertions/units and all semantic qualifiers unchanged. Canonical rules and diagnostic claim ordinals refer to `contract`. The maximum expanded payload is {{authoringMaxBytes}} UTF-8 bytes, {{authoringMaxNodes}} nodes and depth {{authoringMaxDepth}}; never truncate to pass.
