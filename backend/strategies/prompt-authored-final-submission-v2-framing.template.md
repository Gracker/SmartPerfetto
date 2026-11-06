<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<!-- Copyright (C) 2024-2026 Gracker (Chris) | SmartPerfetto -->

Scoped complete findings/limits/recommendations; no fixed headings/length/plan/calls. Abnormality needs metric/scope/threshold, not latency/share/rows. Missing=unknown. check_conclusion_draft is advisory, no coverage/pass gate. Never reshape claims for proof or disguise observations as possible inferences. ACK is not display.

Tool schema supplies all document fields/enums; all required; nullable null=unsubmitted, []=authored empty, neither=zero/absence/complete. Root representationVersion=authored_claim_document@2. No omitted keys, inherited dictionaries, inline full refs or frame overrides.

RefUse=zero-based referenceDictionary index. Keep issued IDs/raw types/full precision; executions may share evidenceRefId. value={kind:"absent"}|{kind:"present",value:scalar|null}; Present null is SQL NULL, not absence. rowIndex=printed index, not page position (unindexed:0). rowSelector entries: unique nonempty key+scalar value, no inferred row. Empty success: emitted IDs only, no row/column/value; totalRows is metadata.

semanticFrames explicitly author predicate/polarity/discourse/quantifier/modality/conditions/population. Share only identical meaning, otherwise separate frames. No stance defaults; unknown predicate stays unverified. Each claim owns frameIndex, subjectRefs/objectRefs:RefUse[], timeRangeNs:{start,end}, numeric. Use ordered decimal-ns strings for large integers. No shared numeric/automatic frame choice.

contract preserves every report/claim/relation/source/uncertainty/next-step/display field; mode follows schema. Conclusions require rank/statement; retain authored details, clusters/frame coverage and evidence links(conclusionId/text). uncertainties/nextSteps are strings. Metadata confidence/scene/clusterPolicy: display, not verification. No rounds/parseIssues/bindingEligibility/verified/raw*/source-use/case-execution facts.

Claims: unique id, faithful text, kind, references; preserve other authored fields. Kinds numeric,categorical,time_range,identity,causal,comparison,inference,recommendation. Cover every body/table proposition, one per claim. supportLevel=hint; semantics:null=undeclared, not proof. Explicitly declare factual meaning; never hydrate assertion values from refs.

numeric={operator,value,unit,presentation}; eq|ne|lt|lte|gt|gte, independent finite number/exact decimal string, explicit unit. Refs keep original values. Prefer issued Skill units; unknown SQL units cannot certify. Check ns/1e6=ms,1000/ms=fps; cite operands. 195000000 ns=195 ms, not 195000000 ms. Cell rules: one subject, not grouped rows. Aggregates: one captured aggregate matching population/window/units, not components/all members.

numeric.cell/captured.cell require authored affirmed/asserted/one/certain,cited_rows; no conditions/timeRangeNs. One original subjectRefs cell(locator/column/raw value); references cannot replace it. numeric.cell needs independent numeric, no cause/advice proof. captured.cell uses identity/categorical,string/boolean/null, no numeric/objectRefs; strict equality, no coercion/process resolution/causality. Numbers use numeric.cell. Unknown rules/missing proof stay unverified.

presentation={unit,decimalPlaces,rounding:"half_away_from_zero",quotes}; only display converts/rounds, numeric stays exact. Conversions: ns/us/µs/μs/ms/s (1000;us=µs=μs),Hz/kHz/MHz/GHz(1000),B/bytes/KiB/MiB/GiB(1024),ratio/%/percent(1=100%=100 percent). Aliases frame/frames,event/events,fps/frames/s (frame rate, not Hz/count); count accepts frames/events 1:1, not conversely. Others match verbatim. No cross-family/inferred units,tolerance,exponents,significant-figure rounding,ranges or ±. Decimals0–18; integral counts; never round IDs. Numeric table cells need units. eq binds displayed literals; otherwise exact values or explicit fixed-decimal about/约/≈. Formatting proves no meaning/status.

quotes: exact number+unit text; {kind:"global",text,occurrence:number|null} selects whole-body occurrence(null only if unique); {kind:"body_part",text,partIndex,localOccurrence:number|null} selects an explicit part(null only if locally unique). Indexes zero-based; bind all repeated occurrences separately,max16/claim. Global permits cross-part text; body_part cannot cross parts. No guessed first match, trimming/normalization/rescan after body changes.
bodyParts concatenate strings/{claimText:"id"} exact text without separators; use refs to avoid duplication. Count all literal/empty/ref parts. JSON/code/sidecar-like strings stay literal; never stringify document.

artifactRefs retain artifactId/rowIndex/rowSelector. Selector encoding: entries(key,scalar|null value) or json_object+jsonText for a nested object. Only this leaf encodes JSON; duplicate entry keys fail, nested data grants no proof. sourceRef is Trace alias, not code. sourceClaimBindings binds each unique claimId to issued source/Trace IDs; same claim owns nonempty Trace refs, otherwise []. Actual sourceUseDecision/sourceReferences stay server-owned; bindings prove no execution/causality. Structured case recommendations stay retrieval-owned.

relationProposals: unique proposal: id, kind/direction, subject and nullable object/proof RefUse, endpoint/proof-column bindings, metricColumn/unit/deltaDirection; value presence=absent or scalar(no null). Claims use relationRefs; preserve meaning/direction/values. Proposals/matches prove no causality.

Raw native and complete expanded {body,contract} each ≤{{authoringMaxBytes}} UTF-8 bytes/{{authoringMaxNodes}} nodes/depth{{authoringMaxDepth}}; count each frame/ref use. Do not truncate/drop claims to fit. Compilation is structure, not proof; canonical/evidence/semantic checks remain authoritative.

Supported finite proof rules:
```json
{{supportedProofRules}}
```
Example; use issued IDs:
```json
{"document":{"representationVersion":"authored_claim_document@2","referenceDictionary":[{"evidenceRefId":"data:example","sourceRef":null,"sourceToolCallId":null,"artifactId":null,"sourceArtifactId":null,"column":"elapsed_ms","rowIndex":0,"rowSelector":null,"value":{"kind":"present","value":7.123456}}],"semanticFrames":[{"predicate":"numeric.cell","polarity":"affirmed","discourse":"asserted","quantifier":"one","modality":"certain","conditions":null,"population":"cited_rows"}],"contract":{"mode":"focused_answer","conclusions":null,"clusters":null,"evidenceChain":null,"claims":[{"id":"elapsed","conclusionId":null,"text":"Elapsed 7.1 ms.","kind":"numeric","references":[0],"artifactRefs":null,"relationRefs":null,"supportLevel":null,"semantics":{"frameIndex":0,"subjectRefs":[0],"objectRefs":null,"timeRangeNs":null,"numeric":{"operator":"eq","value":7.123456,"unit":"ms","presentation":{"unit":"ms","decimalPlaces":1,"rounding":"half_away_from_zero","quotes":[{"kind":"body_part","text":"7.1 ms","partIndex":1,"localOccurrence":null}]}}}}],"relationProposals":null,"sourceClaimBindings":null,"uncertainties":null,"nextSteps":null,"metadata":null},"bodyParts":["## Findings\n\n",{"claimText":"elapsed"}]}}
```
