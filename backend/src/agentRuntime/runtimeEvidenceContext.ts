// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {runAllowedTraces} from './runtimeTraceAttachment';
import type {AnalysisOptions} from '../agent/core/orchestratorTypes';
import {ArtifactStore} from '../agentv3/artifactStore';
import {
  assertCurrentAnalysisContextAuthorization,
  buildAnalysisContextAuthorizationFingerprint,
} from '../services/resolvedAnalysisContext';
import {resolveKnowledgeScope} from '../services/scopedKnowledgeStore';
import type {EvidenceReadView} from '../services/evidence/evidenceReadView';

export interface RuntimeEvidenceScopeInput {
  logicalSessionId: string;
  traceId: string;
  options: AnalysisOptions;
}

export interface RuntimeEvidenceRunInput {
  runtimeSessionId: string;
  runId: string;
  signal: AbortSignal;
  assertAuthorized(): void;
}

export interface RuntimeEvidenceBinding<T extends AnalysisOptions = AnalysisOptions> {
  readonly options: T;
  /** Bounded locator metadata from retained execution captures, never a proof. */
  describeArtifacts(): Promise<RuntimeEvidenceArtifactCatalog>;
  /** Release after product finalization; never clears another run's evidence. */
  release(): void;
}

export interface RuntimeEvidenceArtifactDescriptor {
  artifactId: string;
  skillId: string;
  title: string;
  traceId: string;
  traceSide: 'current' | 'reference';
  rowCount: number;
  columns: readonly string[];
  columnCount: number;
}

export interface RuntimeEvidenceArtifactCatalog {
  readonly artifacts: readonly RuntimeEvidenceArtifactDescriptor[];
  readonly omittedArtifactCount: number;
}

export interface RuntimeEvidenceContext {
  /** Includes a fresh authorization check, not just the supplied fingerprint. */
  matches(input: RuntimeEvidenceScopeInput): boolean;
  bind<T extends AnalysisOptions>(options: T, run: RuntimeEvidenceRunInput): RuntimeEvidenceBinding<T>;
  /** Product session cleanup or scope change permanently revokes this store. */
  dispose(): void;
}

function captureScope(input: RuntimeEvidenceScopeInput) {
  if (!input.logicalSessionId.trim() || !input.traceId.trim()) throw new Error('runtime_evidence_scope_invalid');
  const selection = {
    codeAwareMode: input.options.codeAwareMode,
    codebaseIds: input.options.codebaseIds ? [...input.options.codebaseIds] : undefined,
    knowledgeSourceIds: input.options.knowledgeSourceIds ? [...input.options.knowledgeSourceIds] : undefined,
  };
  const resolved = resolveKnowledgeScope(input.options);
  const owner = {tenantId: resolved.tenantId, workspaceId: resolved.workspaceId, userId: resolved.userId};
  const fingerprint = input.options.analysisContextFingerprint ??
    buildAnalysisContextAuthorizationFingerprint(selection, owner);
  assertCurrentAnalysisContextAuthorization(selection, owner, fingerprint);
  return {
    logicalSessionId: input.logicalSessionId,
    traceId: input.traceId,
    referenceTraceId: input.options.referenceTraceId,
    selection, owner, fingerprint,
    key: JSON.stringify([input.logicalSessionId, input.traceId, input.options.referenceTraceId ?? null,
      owner.tenantId, owner.workspaceId, owner.userId ?? null, fingerprint]),
  };
}

type Scope = ReturnType<typeof captureScope>;
interface ContextState {
  readonly scope: Scope;
  readonly store: ArtifactStore;
  revoked: boolean;
  current?: RunState;
}
interface RunState {
  readonly context: ContextState;
  readonly input: RuntimeEvidenceRunInput;
  released: boolean;
  store?: ArtifactStore;
}

// Enumerable symbols survive internal options spreads, but never JSON or snapshots.
const evidenceBinding = Symbol('runtimeEvidenceBinding');
const issuedBindings = new WeakMap<object, RunState>();
const issuedFacades = new WeakSet<object>();
type BoundOptions = AnalysisOptions & {[evidenceBinding]?: object};

function disposeContext(context: ContextState): void {
  context.revoked = true;
  if (context.current) context.current.released = true;
  context.current = undefined;
  context.store.clear();
}

function assertScopeAuthorized(context: ContextState): void {
  if (context.revoked) throw new Error('runtime_evidence_context_revoked');
  try {
    const {selection, owner, fingerprint} = context.scope;
    assertCurrentAnalysisContextAuthorization(selection, owner, fingerprint);
  } catch (error) {
    disposeContext(context);
    throw error;
  }
}

function assertRunActive(run: RunState): void {
  const checkLease = () => {
    if (run.released || run.context.current !== run) {
      throw new DOMException('Runtime evidence run is no longer active', 'AbortError');
    }
    run.input.signal.throwIfAborted();
  };
  checkLease();
  assertScopeAuthorized(run.context);
  run.input.assertAuthorized();
  checkLease();
}

async function describeRunArtifacts(run: RunState): Promise<RuntimeEvidenceArtifactCatalog> {
  assertRunActive(run);
  const {store, scope} = run.context;
  // The original Store serializes shallow references; do not copy its row data.
  const ids = store.serialize().map(artifact => artifact.id).reverse();
  const view = store.createEvidenceReadView({ownerKey: scope.key,
    allowedTraces: runAllowedTraces({currentTraceId: scope.traceId, referenceTraceId: scope.referenceTraceId})});
  const resolutions = await view.resolveReferences(ids.map(artifactId => ({key: artifactId,
    reference: {artifactId}, requiredColumns: []})), run.input.signal);
  assertRunActive(run);
  const artifacts: RuntimeEvidenceArtifactDescriptor[] = [];
  let bytes = 0;
  for (const resolution of resolutions) {
    if (resolution.status !== 'resolved') continue;
    const {record} = resolution;
    if (!record.meta.artifactId || !record.meta.traceId ||
      (record.meta.traceSide !== 'current' && record.meta.traceSide !== 'reference')) continue;
    const descriptor: RuntimeEvidenceArtifactDescriptor = {
      artifactId: record.meta.artifactId,
      skillId: (record.meta.skillId ?? record.meta.source).slice(0, 200),
      title: record.display.title.slice(0, 200),
      traceId: record.meta.traceId, traceSide: record.meta.traceSide,
      rowCount: record.totalRowCount,
      columns: record.columns.slice(0, 8).filter(column => column.length <= 128),
      columnCount: record.columns.length,
    };
    const size = Buffer.byteLength(JSON.stringify(descriptor), 'utf8');
    if (bytes + size > 16_384) continue;
    bytes += size;
    Object.freeze(descriptor.columns);
    artifacts.push(Object.freeze(descriptor));
  }
  return Object.freeze({artifacts: Object.freeze(artifacts), omittedArtifactCount: ids.length - artifacts.length});
}

/**
 * Own this handle in the product session, separately from physical SDK sessions.
 * Keep the binding active until finalization settles, then release it and clean
 * up that physical runtime session. Dispose the context when the product session
 * ends or its scope changes. No snapshot can recreate the retained witnesses.
 */
export function createRuntimeEvidenceContext(input: RuntimeEvidenceScopeInput): RuntimeEvidenceContext {
  const context: ContextState = {scope: captureScope(input), store: new ArtifactStore(), revoked: false};
  return Object.freeze({
    matches(candidate: RuntimeEvidenceScopeInput) {
      try {
        assertScopeAuthorized(context);
        return context.scope.key === captureScope(candidate).key;
      } catch { return false; }
    },
    bind<T extends AnalysisOptions>(options: T, input: RuntimeEvidenceRunInput): RuntimeEvidenceBinding<T> {
      assertScopeAuthorized(context);
      if (context.scope.key !== captureScope({logicalSessionId: context.scope.logicalSessionId,
        traceId: context.scope.traceId, options}).key || !input.runtimeSessionId.trim() || !input.runId.trim() ||
        (options.runId !== undefined && options.runId !== input.runId)) {
        throw new Error('runtime_evidence_binding_scope_mismatch');
      }
      input.signal.throwIfAborted();
      input.assertAuthorized();
      if (context.current) context.current.released = true;
      const run: RunState = {context, input: {...input}, released: false};
      context.current = run;
      const token = Object.freeze({});
      issuedBindings.set(token, run);
      const bound = {...options, runId: input.runId, [evidenceBinding]: token};
      return Object.freeze({options: bound, describeArtifacts: () => describeRunArtifacts(run), release() {
        run.released = true;
        if (context.current === run) context.current = undefined;
      }});
    },
    dispose() { disposeContext(context); },
  });
}

/** Guard every public entrypoint and detach mutable display data from callers. */
function createRunStore(run: RunState): ArtifactStore {
  const store = run.context.store;
  const access = <T>(operation: () => T): T => {
    assertRunActive(run);
    return operation();
  };
  const facade = Object.freeze({
    store: (...args: Parameters<ArtifactStore['store']>) => access(() => store.store(structuredClone(args[0]))),
    registerEvidenceCapture: (...args: Parameters<ArtifactStore['registerEvidenceCapture']>) =>
      access(() => store.registerEvidenceCapture(args[0], args[1], {...structuredClone(args[2]), originRunId: run.input.runId})),
    registerStandaloneEvidenceCapture: (...args: Parameters<ArtifactStore['registerStandaloneEvidenceCapture']>) =>
      access(() => store.registerStandaloneEvidenceCapture(args[0], {...structuredClone(args[1]), originRunId: run.input.runId})),
    observeInvestigationTool: (...args: Parameters<ArtifactStore['observeInvestigationTool']>) =>
      access(() => store.observeInvestigationTool(args[0], run.input.runId)),
    updateQueryReview: (...args: Parameters<ArtifactStore['updateQueryReview']>) =>
      access(() => store.updateQueryReview(args[0], structuredClone(args[1]))),
    get: (...args: Parameters<ArtifactStore['get']>) => access(() => structuredClone(store.get(...args))),
    generateSummary: (...args: Parameters<ArtifactStore['generateSummary']>) =>
      access(() => structuredClone(store.generateSummary(...args))),
    generateCompactSummary: (...args: Parameters<ArtifactStore['generateCompactSummary']>) =>
      access(() => structuredClone(store.generateCompactSummary(...args))),
    fetch: (...args: Parameters<ArtifactStore['fetch']>) => access(() => structuredClone(store.fetch(...args))),
    get size() { return access(() => store.size); },
    serialize: () => access(() => structuredClone(store.serialize())),
    clear: () => access(() => store.clear()),
    createEvidenceReadView: (...args: Parameters<ArtifactStore['createEvidenceReadView']>): EvidenceReadView => access(() => {
      const scope = run.context.scope;
      if (args[0].allowedTraces.some(trace => trace.traceId !==
        (trace.traceSide === 'current' ? scope.traceId : scope.referenceTraceId))) {
        throw new Error('runtime_evidence_read_scope_mismatch');
      }
      // ArtifactStore fixes the admitted capture set here, before any async read.
      const view = store.createEvidenceReadView({...args[0], currentRunId: run.input.runId});
      return Object.freeze({
        investigationEvidence() {
          assertRunActive(run);
          const snapshot = view.investigationEvidence?.();
          assertRunActive(run);
          if (!snapshot) throw new Error('investigation_evidence_unavailable');
          return snapshot;
        },
        async resolveReferences(requests, signal) {
        assertRunActive(run);
        const result = await view.resolveReferences(requests, signal);
        assertRunActive(run);
        // Preserve issued resolution identity for the verifier's WeakMap.
        return result;
      }} satisfies EvidenceReadView);
    }),
  } satisfies Pick<ArtifactStore, keyof ArtifactStore>);
  // Existing consumers type the public store surface as its concrete class.
  // The facade has no inherited fields or reflective access to its backing Maps.
  issuedFacades.add(facade);
  return facade as ArtifactStore;
}

/** Only a live product-issued binding can select a store across physical runs. */
export function resolveRuntimeEvidenceStore(options: AnalysisOptions,
  actual: {sessionId: string; traceId: string}, fallback: () => ArtifactStore): ArtifactStore {
  if (!Object.prototype.hasOwnProperty.call(options, evidenceBinding)) {
    const store = fallback();
    if (issuedFacades.has(store)) throw new Error('runtime_evidence_binding_required');
    return store;
  }
  const token = (options as BoundOptions)[evidenceBinding];
  const run = token && issuedBindings.get(token);
  if (!run) throw new Error('runtime_evidence_binding_invalid');
  assertRunActive(run);
  if (run.input.runtimeSessionId !== actual.sessionId || run.input.runId !== options.runId ||
    run.context.scope.key !== captureScope({logicalSessionId: run.context.scope.logicalSessionId,
      traceId: actual.traceId, options}).key) {
    throw new Error('runtime_evidence_binding_scope_mismatch');
  }
  return run.store ??= createRunStore(run);
}
