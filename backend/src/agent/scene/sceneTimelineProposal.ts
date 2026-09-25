// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)

import {evidenceCaptureHash, freezeEvidenceValue, getCapturedAnchorFacts} from '../../services/evidence/evidenceCapture';
import {bindReadResolutionToAnchor, isIssuedEvidenceReadResolution, type EvidenceReadResolution,
  type EvidenceReadRequest} from '../../services/evidence/evidenceReadView';
import {assertSceneRunActive, mutateSceneRun, type SceneRunContext, type SceneRunState} from './sceneRunContext';
import {sceneCellValueMatches, sceneTimelineProposalEnvelopeSchema, sceneTimelineSegmentSchema, type SceneTimelineSegment, type SceneProposalResult,
  type SceneDiagnostic, type SceneRejectedGroup, type SceneSegmentAssessment, type SceneFiniteCheck,
  type SceneEvidenceExcerpt} from './sceneTimelineContract';
import {captureSceneScanCoverage} from './sceneScanCoverage';
import {recordSceneCommit, recordSceneProposalAttempt} from './sceneProposalPacing';
import {isPlainObject as isRecord} from '../../utils/llmJson';

export const SCENE_FINITE_RULE_VERSION = 'scene_finite@1';
const SAFE_REFERENCE_FAILURE_REASONS = new Set([
  'multiple_evidence_records', 'identifier_conflict', 'evidence_not_retained', 'execution_witness_mismatch',
  'trace_capture_mismatch', 'trace_outside_read_scope', 'execution_witness_unavailable', 'execution_unavailable',
  'execution_skipped', 'duplicate_evidence_columns', 'invalid_metadata_locator', 'invalid_row_index', 'invalid_row_selector',
  'row_selector_not_unique', 'row_selector_not_found', 'row_index_selector_conflict', 'row_locator_required',
  'row_index_out_of_range', 'required_column_missing', 'unsupported_raw_cell',
]);
const byteSize = (value: unknown) => Buffer.byteLength(JSON.stringify(value), 'utf8');
const sameObject = (a: SceneTimelineSegment, b: SceneTimelineSegment) => a.object.kind === b.object.kind && a.object.key === b.object.key && a.object.machineId === b.object.machineId;
const contentHash = (segment: SceneTimelineSegment) => evidenceCaptureHash({rule: SCENE_FINITE_RULE_VERSION, segment});
const MAX_DETAIL_CHARS = 320;
const MAX_REJECTED_GROUPS = 32;
const MAX_GROUP_DIAGNOSTICS = 16;
function failure(state: SceneRunState, diagnostics: SceneDiagnostic[], rejectedGroups?: SceneRejectedGroup[]): SceneProposalResult {
  // Keep actionable terminal diagnostics bounded; failed requests are not retained as candidates.
  const bounded = diagnostics.slice(0, state.limits.maxDiagnostics);
  state.diagnostics = bounded;
  return freezeEvidenceValue({accepted: false, revision: state.revision, diagnostics: bounded,
    ...(rejectedGroups?.length ? {rejectedGroups} : {})});
}
function exactNanoseconds(value: unknown, unit: string | undefined): bigint | undefined {
  const scale = unit === 'ns' ? 1n : unit === 'us' ? 1000n : unit === 'ms' ? 1_000_000n : unit === 's' ? 1_000_000_000n : undefined;
  if (scale === undefined || (typeof value !== 'string' && typeof value !== 'number') ||
      (typeof value === 'number' && !Number.isSafeInteger(value))) return undefined;
  const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(String(value));
  if (!match || match[2].length + (match[3]?.length || 0) > 80) return undefined;
  const denominator = 10n ** BigInt(match[3]?.length || 0);
  const scaled = BigInt(`${match[1]}${match[2]}${match[3] || ''}`) * scale;
  return scaled % denominator === 0n ? scaled / denominator : undefined;
}
function checkBoundary(segment: SceneTimelineSegment, edge: 'start' | 'end', reads: readonly EvidenceReadResolution[],
  state: SceneRunState): SceneFiniteCheck {
  const boundary = segment.boundaries[edge];
  const wanted = edge === 'start' ? segment.startNs : segment.endNs;
  const predicate = `time.${edge}_cell_equals_boundary`;
  if (boundary.source === 'trace_bound') return {predicate, status:
    wanted === state.options.traceBounds[edge === 'start' ? 'startNs' : 'endNs'] ? 'passed' : 'contradicted'};
  if (boundary.source !== 'evidence' || boundary.evidenceIndex === undefined || !boundary.column) {
    return {predicate, status: 'unknown', reason: 'boundary_not_observed'};
  }
  const read = reads[boundary.evidenceIndex];
  if (!read || read.status !== 'resolved' || !read.row) return {predicate, status: 'unknown', reason: 'boundary_evidence_unavailable'};
  const field = read.record.fields[boundary.column];
  if (!field || !['skill_literal', 'native_producer'].includes(field.origin.kind) ||
      !field.origin.definitionFingerprint?.trim() || field.clock !== 'trace_monotonic' ||
      !['start', 'end'].includes(field.timeRole || '')) return {predicate, status: 'unknown', reason: 'producer_time_semantics_unavailable'};
  const observed = exactNanoseconds(read.row[boundary.column], field.unit);
  return observed === undefined ? {predicate, status: 'unknown', reason: 'inexact_or_unsupported_time_unit'} :
    {predicate, status: observed === BigInt(wanted) ? 'passed' : 'contradicted'};
}
function exactIdentity(value: unknown): string | undefined {
  if (typeof value === 'number') return Number.isSafeInteger(value) && value >= 0 ? String(value) : undefined;
  return typeof value === 'string' && /^(0|[1-9]\d*)$/.test(value) && value.length <= 40 ? value : undefined;
}
function checkObject(segment: SceneTimelineSegment, reads: readonly EvidenceReadResolution[], state: SceneRunState): SceneFiniteCheck {
  const matches: boolean[] = [];
  for (const read of reads) {
    if (read.status !== 'resolved' || !read.row) continue;
    const declared = Object.entries(read.record.fields).filter(([, field]) =>
      ['skill_literal', 'native_producer'].includes(field.origin.kind) && field.origin.definitionFingerprint?.trim());
    const machines = declared.filter(([, field]) => field.identityRole === 'machine_id')
      .map(([column]) => exactIdentity(read.row![column])).filter(value => value !== undefined);
    // A machine-local CPU identifier is not trace-global. Explicit machine claims also need evidence.
    if ((segment.object.kind === 'cpu' && segment.object.machineId === undefined) ||
        (segment.object.machineId !== undefined && !machines.includes(segment.object.machineId))) continue;
    for (const [column, field] of declared) {
      const value = exactIdentity(read.row[column]);
      if (field.identityRole === segment.object.kind && value !== undefined) matches.push(value === segment.object.key);
    }
    const anchor = {context: {traceId: state.options.traceId, traceSide: 'current'}};
    bindReadResolutionToAnchor(anchor, read);
    const row = getCapturedAnchorFacts(anchor)?.nativeRow;
    if (row?.relation === segment.object.kind && exactIdentity(row.id) !== undefined) matches.push(String(row.id) === segment.object.key);
  }
  return {predicate: 'identity.cited_object_observed', status: matches.length ?
    matches.some(Boolean) ? 'passed' : 'contradicted' : 'unknown',
    ...(!matches.length ? {reason: 'producer_identity_semantics_unavailable'} : {})};
}
type JsonRecord = Record<string, unknown>;
function omitAbsent(value: JsonRecord, keys: readonly string[], blankStrings: boolean): JsonRecord {
  const copy: JsonRecord = {...value};
  for (const key of keys) {
    const item = copy[key];
    if (item === null || (blankStrings && typeof item === 'string' && !item.trim())) delete copy[key];
  }
  return copy;
}
function normalizeSegment(value: unknown): unknown {
  if (!isRecord(value)) return value;
  const segment = omitAbsent(value, ['dependencies', 'supersedes'], false);
  if (isRecord(segment.object)) segment.object = omitAbsent(segment.object, ['machineId'], true);
  if (Array.isArray(segment.evidenceRefs)) segment.evidenceRefs = segment.evidenceRefs.map(reference => isRecord(reference)
    ? omitAbsent(reference, ['evidenceRefId', 'artifactId', 'sourceToolCallId', 'column'], true) : reference);
  if (isRecord(segment.boundaries)) {
    const boundaries = {...segment.boundaries};
    for (const edge of ['start', 'end'] as const) {
      const boundary = boundaries[edge];
      if (isRecord(boundary)) boundaries[edge] = omitAbsent(boundary, ['evidenceIndex', 'column'], true);
    }
    segment.boundaries = boundaries;
  }
  return segment;
}
/**
 * Representation only: an explicit null or a blank identifier means "not
 * supplied". Tool schemas advertise optional fields that strict-mode clients
 * fill with null. `value: null` keeps its meaning (the cell is NULL), and no
 * required field is ever defaulted.
 */
function normalizeSceneProposalInput(input: unknown): unknown {
  if (!isRecord(input)) return input;
  const envelope = omitAbsent(input, ['removeSegmentIds', 'unresolved'], false);
  if (Array.isArray(envelope.segments)) envelope.segments = envelope.segments.map(normalizeSegment);
  return envelope;
}

export {sceneCellValueMatches};
const jsonType = (value: unknown) => value === null ? 'null' : typeof value;
function boundedDetail(parts: readonly string[]): string {
  const text = parts.filter(Boolean).join('; ');
  return text.length <= MAX_DETAIL_CHARS ? text : `${text.slice(0, MAX_DETAIL_CHARS - 1)}…`;
}
const REFERENCE_REPAIR: Readonly<Record<string, string>> = {
  identifier_conflict: 'cite exactly one identifier (evidenceRefId or artifactId) from the same tool result',
  multiple_evidence_records: 'cite the evidenceRefId of the specific result',
  evidence_not_retained: 'evicted from bounded retention or never issued; reacquire current-run evidence with a narrower query',
  row_index_out_of_range: 'rowIndex is artifact-wide: use sampleRowIndices or page offset + position',
  invalid_row_index: 'rowIndex is artifact-wide: use sampleRowIndices or page offset + position',
  row_locator_required: 'supply the artifact-wide rowIndex of the cited row',
  required_column_missing: 'cite an existing column, query a real end column, or mark the boundary inferred',
  execution_skipped: 'the step was skipped because its condition was not met and observed nothing; cite a result whose query ran',
};
function referenceFailureDetail(read: Extract<EvidenceReadResolution, {reason: string}>, requiredColumns: readonly string[]): string {
  const safe = SAFE_REFERENCE_FAILURE_REASONS.has(read.reason);
  const reason = safe ? read.reason : 'reference_unavailable';
  const detail = safe ? read.locatorDetail : undefined;
  const repair = REFERENCE_REPAIR[reason] ?? 'reacquire current-run evidence and resubmit.';
  const fixed = [reason,
    requiredColumns.length ? `requiredColumns: ${JSON.stringify(requiredColumns)}` : '',
    detail?.matchedFields?.length ? `matched: ${detail.matchedFields.join(',')}` : '',
    detail?.conflictingFields?.length ? `conflicting: ${detail.conflictingFields.join(',')}` : '',
    detail?.rowCount !== undefined ? `rowCount: ${detail.rowCount}` : '', repair];
  if (!detail?.availableColumns?.length) return boundedDetail(fixed);
  // Column names are schema, not cell values; keep the repair text and trim the list to fit.
  const room = MAX_DETAIL_CHARS - boundedDetail(fixed).length - '; availableColumns: '.length;
  const columns: string[] = [];
  for (const column of detail.availableColumns) {
    if (JSON.stringify([...columns, column]).length > room) break;
    columns.push(column);
  }
  return boundedDetail([...fixed.slice(0, -1), `availableColumns: ${JSON.stringify(columns)}`, repair]);
}
const issueText = (issues: readonly {path: PropertyKey[]; message: string}[], prefix = '') => boundedDetail(
  issues.slice(0, 12).map(issue => `${[prefix, ...issue.path.map(String)].filter(Boolean).join('.')}: ${issue.message}`));

interface IncomingItem {
  index: number; key: string; id?: string; segment?: SceneTimelineSegment; issues?: string;
  dependencies: readonly string[]; supersedes: readonly string[];
  /** Submitted edge entries, duplicates included: the resource charge. */
  edgeCount: number;
}
const strings = (value: unknown): string[] => Array.isArray(value)
  ? value.filter((item): item is string => typeof item === 'string').map(item => item.trim()).filter(Boolean) : [];
function parseIncoming(raw: unknown, index: number): IncomingItem {
  const parsed = sceneTimelineSegmentSchema.safeParse(raw);
  if (parsed.success) return {index, key: parsed.data.id, id: parsed.data.id, segment: parsed.data,
    dependencies: [...new Set(parsed.data.dependencies)], supersedes: [...new Set(parsed.data.supersedes)],
    edgeCount: parsed.data.dependencies.length + parsed.data.supersedes.length};
  // An invalid member still names what it would have touched, so it rejects the right group.
  const record = isRecord(raw) ? raw : {};
  const id = typeof record.id === 'string' && record.id.trim() ? record.id.trim() : undefined;
  const dependencies = id ? strings(record.dependencies) : [];
  const supersedes = id ? strings(record.supersedes) : [];
  return {index, key: id ?? `#${index}`, id, issues: issueText(parsed.error.issues, `segments.${index}`),
    dependencies, supersedes, edgeCount: dependencies.length + supersedes.length};
}
/** A copy of the map without removed ids and the parents the given segments supersede. */
function withoutReplaced<T>(map: ReadonlyMap<string, T>, removals: readonly string[], items: readonly IncomingItem[]): Map<string, T> {
  const copy = new Map(map);
  removals.forEach(id => copy.delete(id));
  items.forEach(item => item.supersedes.forEach(parent => copy.delete(parent)));
  return copy;
}
class ChangeGroups {
  private readonly parents = new Map<string, string>();
  find(key: string): string {
    let root = key;
    while (this.parents.has(root) && this.parents.get(root) !== root) root = this.parents.get(root)!;
    if (!this.parents.has(root)) this.parents.set(root, root);
    for (let node = key; node !== root;) {const next = this.parents.get(node)!; this.parents.set(node, root); node = next;}
    return root;
  }
  union(a: string, b: string): void {
    const left = this.find(a); const right = this.find(b);
    if (left !== right) this.parents.set(left, right);
  }
}

/**
 * Active run tool handler. Mutations are atomic across async evidence reads.
 *
 * A request commits in atomic change groups. Nodes whose content or dependency
 * fingerprint this request can change (incoming, removed and superseded ids,
 * and everything that reaches them over committed or incoming dependency
 * edges) are connected into groups; supersedes parents join their children.
 * No node outside a group depends on it in old or new form, so rejecting one
 * group leaves every other group's closure and fingerprints unchanged and the
 * request is evaluated once. A rejected group keeps its committed versions and
 * lineage and applies none of its changes. Shared state limits are checked on
 * the final map before commit.
 */
export async function proposeSceneTimeline(handle: SceneRunContext, input: unknown): Promise<SceneProposalResult> {
  return mutateSceneRun(handle, async state => {
    let inputBytes: number;
    try {inputBytes = byteSize(input);} catch {return failure(state, [{code: 'invalid_proposal_json'}]);}
    if (inputBytes > state.limits.maxProposalBytes) return failure(state, [{code: 'scene_byte_budget_exhausted'}]);
    const envelope = sceneTimelineProposalEnvelopeSchema.safeParse(normalizeSceneProposalInput(input));
    if (!envelope.success) return failure(state, [{code: 'invalid_proposal', detail: issueText(envelope.error.issues)}]);
    const proposal = envelope.data;
    const items = proposal.segments.map(parseIncoming);
    const fingerprint = evidenceCaptureHash({...proposal,
      segments: items.map((item, index) => item.segment ?? proposal.segments[index])});
    // Replay precedes cumulative budgets: a committed request always replays its own result.
    const replay = state.proposals.get(proposal.proposalId);
    if (replay) return replay.fingerprint === fingerprint ? replay.result : failure(state, [{code: 'proposal_id_content_conflict'}]);
    if (items.length) recordSceneProposalAttempt(state.pacing);
    if (state.consumed.bytes + inputBytes > state.limits.maxRunBytes) return failure(state, [{code: 'scene_byte_budget_exhausted'}]);
    if (proposal.baseRevision !== state.revision) return failure(state, [{code: 'stale_base_revision'}]);
    if (state.revision >= state.limits.maxRevisions) return failure(state, [{code: 'scene_revision_budget_exhausted'}]);
    if (state.consumed.candidates + items.length > state.limits.maxRunCandidates) {
      return failure(state, [{code: 'scene_cumulative_candidate_budget_exhausted'}]);
    }
    const requestEdges = items.reduce((total, item) => total + item.edgeCount, 0);
    if (state.consumed.dependencyEdges + requestEdges > state.limits.maxDependencyEdges) {
      return failure(state, [{code: 'scene_dependency_budget_exhausted'}]);
    }
    state.consumed.candidates += items.length;
    state.consumed.bytes += inputBytes;
    const identified = items.filter(item => item.id !== undefined);
    const incoming = new Map(identified.map(item => [item.id!, item]));
    if (incoming.size !== identified.length) return failure(state, [{code: 'duplicate_segment_id'}]);
    const removed = new Set(proposal.removeSegmentIds);
    const invalidRemovals = [...removed].filter(id => !state.segments.has(id) || incoming.has(id));
    if (invalidRemovals.length) {
      return failure(state, invalidRemovals.map(id => ({code: 'invalid_segment_removal', segmentId: id})));
    }

    // Affected nodes: every id that can reach a changed id over committed (old) or incoming (new) edges.
    const committed = new Map([...state.segments].map(([id, value]) => [id, value.segment]));
    const changedIds = new Set<string>([...incoming.keys(), ...removed, ...items.flatMap(item => item.supersedes)]);
    const dependents = new Map<string, Set<string>>();
    const addEdge = (from: string, to: string) => {
      const set = dependents.get(to) ?? new Set<string>();
      set.add(from); dependents.set(to, set);
    };
    for (const [id, segment] of committed) segment.dependencies.forEach(dependency => addEdge(id, dependency));
    for (const item of incoming.values()) item.dependencies.forEach(dependency => addEdge(item.id!, dependency));
    const affected = new Set(changedIds);
    for (const queue = [...changedIds]; queue.length;) {
      for (const dependent of dependents.get(queue.pop()!) ?? []) {
        if (!affected.has(dependent)) {affected.add(dependent); queue.push(dependent);}
      }
    }
    const groups = new ChangeGroups();
    for (const [to, from] of dependents) if (affected.has(to)) from.forEach(id => groups.union(id, to));
    for (const item of incoming.values()) item.supersedes.forEach(parent => groups.union(item.id!, parent));
    const rejected = new Map<string, SceneDiagnostic[]>();
    const reject = (key: string, diagnostic: SceneDiagnostic) => {
      const root = groups.find(key);
      const list = rejected.get(root) ?? [];
      if (list.length < MAX_GROUP_DIAGNOSTICS) list.push(diagnostic);
      rejected.set(root, list);
    };
    const isRejected = (key: string) => rejected.has(groups.find(key));

    for (const item of items) {
      const segment = item.segment;
      if (!segment) {
        reject(item.key, {code: 'invalid_segment', ...(item.id ? {segmentId: item.id} : {}), detail: item.issues});
        continue;
      }
      if (BigInt(segment.startNs) > BigInt(segment.endNs) || BigInt(segment.startNs) < BigInt(state.options.traceBounds.startNs) ||
          BigInt(segment.endNs) > BigInt(state.options.traceBounds.endNs)) reject(item.key, {code: 'segment_outside_trace', segmentId: segment.id});
      for (const parent of segment.supersedes) {
        const priorLineage = state.segments.get(segment.id)?.segment.supersedes || [];
        const historical = priorLineage.includes(parent) ? [...state.proposals.values()]
          .flatMap(entry => entry.result.segments || []).find(entry => entry.segment.id === parent)?.segment : undefined;
        const old = state.segments.get(parent)?.segment || historical;
        if (!old || parent === segment.id || incoming.has(parent) || !sameObject(old, segment) ||
            BigInt(segment.startNs) > BigInt(old.endNs) || BigInt(segment.endNs) < BigInt(old.startNs)) {
          reject(item.key, {code: 'invalid_supersedes', segmentId: segment.id, detail: parent});
        }
      }
      for (const edge of [segment.boundaries.start, segment.boundaries.end]) {
        if (edge.source === 'evidence' && (edge.evidenceIndex === undefined || !edge.column || edge.evidenceIndex >= segment.evidenceRefs.length)) {
          reject(item.key, {code: 'invalid_boundary_reference', segmentId: segment.id,
            detail: 'an evidence boundary needs evidenceIndex < evidenceRefs.length and an existing column'});
        }
      }
    }

    // Groups rejected so far never enter the tentative map; later rejections are isolated by construction.
    const applied = [...incoming.values()].filter(item => item.segment && !isRejected(item.key));
    const tentative = withoutReplaced(committed, [...removed].filter(id => !isRejected(id)), applied);
    applied.forEach(item => tentative.set(item.id!, item.segment!));
    // An unaffected node's closure is unchanged by construction; reuse its issued fingerprint.
    const hashes = new Map<string, string | null>([...state.segments]
      .filter(([id]) => !affected.has(id)).map(([id, previous]) => [id, previous.dependencyFingerprint]));
    const contents = new Map<string, string>();
    const contentOf = (id: string, segment: SceneTimelineSegment) => {
      if (!contents.has(id)) contents.set(id, contentHash(segment));
      return contents.get(id)!;
    };
    const visiting = new Set<string>();
    const dependencyFailures = new Map<string, SceneDiagnostic>();
    const fingerprintOf = (id: string): string | null => {
      if (hashes.has(id)) return hashes.get(id)!;
      const segment = tentative.get(id);
      if (!segment || visiting.has(id)) return null;
      visiting.add(id);
      const parts: [string, string][] = [];
      for (const parent of [...new Set(segment.dependencies)].sort()) {
        const value = fingerprintOf(parent);
        if (value === null && !dependencyFailures.has(id)) dependencyFailures.set(id, tentative.has(parent)
          ? {code: 'dependency_cycle', segmentId: id, detail: parent} : {code: 'dependency_missing', segmentId: id, detail: parent});
        parts.push([parent, value ?? '']);
      }
      visiting.delete(id);
      const value = dependencyFailures.has(id) ? null : evidenceCaptureHash({content: contentOf(id, segment), dependencies: parts});
      hashes.set(id, value);
      return value;
    };
    for (const id of tentative.keys()) {
      if (fingerprintOf(id) === null && affected.has(id) && !isRejected(id)) reject(id, dependencyFailures.get(id)!);
    }
    const reusable = (id: string) => {
      const previous = state.segments.get(id);
      return Boolean(previous?.referencesResolved && previous.dependencyFingerprint === hashes.get(id));
    };
    // A live node is unaffected (a retry of an earlier incomplete read) or in a group still accepted.
    const isLive = (id: string) => !affected.has(id) || !isRejected(id);
    const toAssess = [...tentative.keys()].filter(id => !reusable(id) && hashes.get(id) && isLive(id));
    const referenceCount = toAssess.reduce((total, id) => total + tentative.get(id)!.evidenceRefs.length, 0);
    if (referenceCount > state.limits.maxRequestReferences || state.consumed.references + referenceCount > state.limits.maxRunReferences) {
      return failure(state, [{code: 'scene_reference_budget_exhausted'}]);
    }
    if (state.consumed.receipts + toAssess.length > state.limits.maxReceipts) return failure(state, [{code: 'scene_receipt_budget_exhausted'}]);
    const requests: (EvidenceReadRequest & {segmentId: string; referenceIndex: number})[] = toAssess.flatMap(id => {
      const segment = tentative.get(id)!;
      return segment.evidenceRefs.map((reference, index) => ({
        key: JSON.stringify([id, index]), segmentId: id, referenceIndex: index, reference, requiredColumns: [...new Set([
          ...(reference.column ? [reference.column] : []), ...[segment.boundaries.start, segment.boundaries.end]
            .filter(edge => edge.evidenceIndex === index && edge.column).map(edge => edge.column!),
        ])],
      }));
    });
    const reads = new Map<string, EvidenceReadResolution>();
    const failedRetries = new Set<string>();
    const fail = (segmentId: string, diagnostic: SceneDiagnostic) => {
      if (affected.has(segmentId)) reject(segmentId, diagnostic); else failedRetries.add(segmentId);
    };
    // Each chunk takes a fresh bounded view, admitting newly captured evidence without increasing ordinary finalization limits.
    for (let start = 0; start < requests.length; start += state.limits.maxReferencesPerRead) {
      assertSceneRunActive(state);
      const chunk = requests.slice(start, start + state.limits.maxReferencesPerRead);
      state.consumed.references += chunk.length;
      let resolutions: readonly EvidenceReadResolution[];
      try {resolutions = await state.options.createEvidenceReadView().resolveReferences(chunk, state.options.signal);}
      catch {assertSceneRunActive(state); return failure(state, [{code: 'scene_evidence_read_failed', detail: 'Reacquire evidence during the active analysis run.'}]);}
      assertSceneRunActive(state);
      for (const request of chunk) {
        // Only caller-provided coordinates are returned; never echo a captured value or foreign scope.
        const column = request.reference.column;
        const location = {segmentId: request.segmentId, referenceIndex: request.referenceIndex,
          ...(column ? {detail: `column: ${column}`} : {})};
        const matches = resolutions.filter(read => read.key === request.key);
        if (matches.length !== 1) {
          fail(request.segmentId, {code: 'invalid_evidence_resolution', ...location});
          continue;
        }
        const read = matches[0];
        if (read.status === 'resolved') {
          if (!isIssuedEvidenceReadResolution(read) || read.record.originRunId !== state.options.runId ||
              read.record.meta.traceId !== state.options.traceId || read.record.meta.traceSide !== 'current' || !read.row ||
              read.originalRowIndex === undefined) {
            fail(request.segmentId, {code: 'evidence_scope_or_witness_mismatch', ...location});
            continue;
          }
          if (column && request.reference.value !== undefined && !sceneCellValueMatches(read.row[column], request.reference.value)) {
            fail(request.segmentId, {code: 'evidence_value_mismatch', ...location,
              detail: `column: ${column}; captured type: ${jsonType(read.row[column])}`});
            continue;
          }
        } else if (read.status !== 'incomplete') {
          fail(request.segmentId, {code: 'evidence_reference_rejected', ...location,
            detail: referenceFailureDetail(read, request.requiredColumns)});
          continue;
        }
        reads.set(request.key, read);
      }
    }

    const submitted = items.length > 0 || removed.size > 0;
    const liveItems = applied.filter(item => !isRejected(item.key));
    const liveRemovals = [...removed].filter(id => !isRejected(id));
    const rejectedGroups: SceneRejectedGroup[] = [...rejected].slice(0, MAX_REJECTED_GROUPS).map(([root, diagnostics]) => {
      const members = items.filter(item => groups.find(item.key) === root);
      return {segmentIds: members.flatMap(item => item.id === undefined ? [] : [item.id]),
        segmentIndices: members.map(item => item.index),
        removedSegmentIds: [...removed].filter(id => groups.find(id) === root), diagnostics};
    });
    const rejectedDiagnostics = rejectedGroups.flatMap(group => group.diagnostics);
    if (submitted && !liveItems.length && !liveRemovals.length) return failure(state, rejectedDiagnostics, rejectedGroups);

    let receiptBytes = 0;
    const assessed = new Map<string, SceneSegmentAssessment>();
    for (const id of toAssess) {
      if (failedRetries.has(id) || !isLive(id)) continue;
      const segment = tentative.get(id)!;
      const resolved = segment.evidenceRefs.map((_, index) => reads.get(JSON.stringify([id, index]))!);
      const evidence: SceneEvidenceExcerpt[] = resolved.flatMap((read, referenceIndex) => read.status === 'resolved' ? [{
        captureId: read.record.captureId, originalRowIndex: read.originalRowIndex!, referenceIndex,
        fingerprint: evidenceCaptureHash({record: read.record, row: read.row, rowIndex: read.originalRowIndex}),
        source: {originRunId: read.record.originRunId!, artifactId: read.record.meta.artifactId,
          evidenceRefId: read.record.meta.evidenceRefId, sourceToolCallId: read.record.meta.sourceToolCallId,
          skillId: read.record.meta.skillId, stepId: read.record.meta.stepId, queryHash: read.record.meta.queryHash},
        row: read.row!, fields: read.record.fields,
      }] : []);
      const checks = [checkBoundary(segment, 'start', resolved, state), checkBoundary(segment, 'end', resolved, state),
        checkObject(segment, resolved, state), {predicate: 'story.semantic', status: 'unknown' as const, reason: 'unsupported_semantic_predicate'}];
      const localDiagnostics: SceneDiagnostic[] = resolved.flatMap((read, referenceIndex) => read.status !== 'resolved'
        ? [{code: 'evidence_read_incomplete', segmentId: segment.id, referenceIndex, detail: read.reason}] : []);
      if (!resolved.length) localDiagnostics.push({code: 'no_segment_evidence', segmentId: segment.id});
      checks.filter(check => check.status === 'contradicted').forEach(check => localDiagnostics.push({code: 'finite_check_contradicted',
        segmentId: segment.id, detail: check.predicate}));
      const assessment: SceneSegmentAssessment = freezeEvidenceValue({segment, contentFingerprint: contentOf(id, segment),
        dependencyFingerprint: hashes.get(id)!, issuedRevision: state.revision + 1,
        referencesResolved: resolved.length > 0 && resolved.every(read => read.status === 'resolved'), semanticStatus: 'unverified',
        checks, evidence, diagnostics: localDiagnostics});
      receiptBytes += byteSize(assessment);
      assessed.set(id, assessment);
    }
    const next = withoutReplaced(state.segments, liveRemovals, liveItems);
    for (const [id, assessment] of assessed) next.set(id, assessment);
    // Isolation covers dependency closure, not shared limits: check the map that would actually commit.
    if (next.size > state.limits.maxSegments) return failure(state, [{code: 'scene_candidate_budget_exhausted'}]);
    if (state.consumed.bytes + receiptBytes > state.limits.maxRunBytes) return failure(state, [{code: 'scene_byte_budget_exhausted'}]);
    assertSceneRunActive(state);
    state.consumed.bytes += receiptBytes;
    captureSceneScanCoverage(handle);
    assertSceneRunActive(state);
    state.consumed.receipts += assessed.size;
    state.consumed.dependencyEdges += liveItems.reduce((total, item) => total + item.edgeCount, 0);
    state.segments = next; state.revision += 1; state.unresolved = freezeEvidenceValue(proposal.unresolved);
    state.diagnostics = rejectedDiagnostics.slice(0, state.limits.maxDiagnostics);
    recordSceneCommit(state.pacing, next.size);
    const result = freezeEvidenceValue({accepted: true, revision: state.revision, diagnostics: [...next.values()].flatMap(item => item.diagnostics),
      segments: [...next.values()], removedSegmentIds: liveRemovals, ...(rejectedGroups.length ? {rejectedGroups} : {})});
    state.proposals.set(proposal.proposalId, {fingerprint, result});
    return result;
  });
}

/** What the model can do about a rejection; read failures are malfunctions and get none. */
export function sceneProposalActionRequired(result: SceneProposalResult): string | undefined {
  if (result.accepted) return undefined;
  const codes = result.diagnostics.map(item => item.code);
  if (codes.some(code => code === 'scene_evidence_read_failed')) return undefined;
  return codes.some(code => /^scene_.*budget_exhausted$/.test(code)) ? 'deliver_with_last_scene_revision' : 'repair_scene_proposal';
}
