// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import fs from 'node:fs';
import type {Server} from 'node:http';
import os from 'node:os';
import path from 'node:path';

import express from 'express';

import {parseConclusionContractDeclaration, type ConclusionContract} from '../agent/core/conclusionContract';
import type {AnalysisResult} from '../agent/core/orchestratorTypes';
import {createClaudeMcpServer} from '../agentv3/claudeMcpServer';
import {ArtifactStore} from '../agentv3/artifactStore';
import {DEFAULT_DEV_USER_ID, DEFAULT_TENANT_ID, DEFAULT_WORKSPACE_ID} from '../utils/localDevIdentity';
import {createRagAdminRoutes} from '../routes/ragAdminRoutes';
import {CodebaseManagementService} from '../services/codebase/codebaseManagementService';
import {CodebaseRegistry} from '../services/codebase/codebaseRegistry';
import {CodeLookupLedger} from '../services/codebase/codeLookupLedger';
import {PathSecurityGate} from '../services/codebase/pathSecurityGate';
import {
  finalizeSourceAwareAnalysisResult,
  finalizeOwnerSourceAwareAnalysisResultWithProjection,
  verifySourceClaimBindings,
} from '../services/codebase/sourceClaimVerifier';
import {
  isBodyLookupKind,
  type SourceReferenceV1,
  type SourceUseDecisionV1,
} from '../services/codebase/sourceUseDecision';
import {RagStore} from '../services/ragStore';
import {clearCodeAwareOutputGuards} from '../services/security/codeAwareOutputRegistry';
import {projectCodeAwareStreamingUpdate, projectOwnerCodeAwareStreamingUpdate} from '../services/security/codeAwareStreamingUpdateProjection';
import {runClaimVerification} from '../services/verifier/claimVerificationRunner';
import {prepareClaimEvidence} from '../services/evidence/claimEvidencePreparation';
import {captureEvidenceTable} from '../services/evidence/evidenceCapture';
import {buildTraceProcessorQueryProvenance} from '../services/traceProcessorConnectionModel';
import {getTraceProcessorPath} from '../services/workingTraceProcessor';
import {DeterministicFixtureSourceAccessService} from '../testSupport/deterministicFixtureSourceAccess';
import {createDataEnvelope} from '../types/dataContract';
import {
  parseArgs as parseAgentSseArgs,
  setupAnalysisContext,
  type AnalysisContextSetupResult,
} from './verifyAgentSseScrolling';

export const DETERMINISTIC_EVIDENCE_KIND = 'deterministic_fixture' as const;

type QueryKind = 'autonomous-diagnosis' | 'quantitative-only' | 'explicit-source-location';
type MatrixCondition = 'A0' | 'A1' | 'A2' | 'A3' | 'A4';

export interface ConstructedSourceGroundTruth {
  marker: string;
  firstFrameMarker: string;
  relativeSourcePath: string;
  symbol: string;
  lineRange: {start: number; end: number};
  callChain: string[];
  actionableSeam: string;
  compatibility: {
    buildLink: 'synthetic_constructed_pair_only';
    causalStatus: 'candidate';
    baseAndroidStartupLinked: false;
  };
  sourceLines: {
    beginLine: number;
    policyLine: number;
    readLine: number;
    endLine: number;
    callerLine: number;
    firstFrameBegin: number;
    firstFrameCaller: number;
  };
  traceFacts: {
    marker: string;
    occurrence: true;
    process: string;
    thread: string;
    atNs: number;
    durationNs: number;
    selectedThreadStateNs: {Running: number; D: number; total: number};
    firstFrame: {
      marker: string;
      process: string;
      thread: string;
      atNs: number;
      durationNs: number;
      markerEndsBeforeStart: true;
    };
  };
  trace: {
    baseCaseId: string;
    materialization: 'committed-base-plus-overlay';
    baseSha256: string;
    overlaySha256: string;
    outputSha256: string;
    runtimeRevision: string;
  };
}

export interface SemanticQuery {
  id: string;
  kind: QueryKind;
  text: string;
}

interface ActualTraceFacts {
  occurrenceCount: number;
  marker: string;
  durationNs: number;
  process: string;
  thread: string;
}

interface SourceFacts {
  exactRelativeFile: boolean;
  exactSymbol: boolean;
  exactLine: boolean;
  callChainMapped: boolean;
  traceMarkerMapped: boolean;
  actionableSeam: boolean;
}

interface SourceHarness {
  sessionId: string;
  sourceUse: {getSourceUseDecision(): SourceUseDecisionV1 | undefined};
  invoke(name: string, args?: Record<string, unknown>): Promise<unknown>;
}

interface RagHarness {
  baseUrl: string;
  registry: CodebaseRegistry;
  store: RagStore;
  close(): Promise<void>;
}

export interface DeterministicVerificationSummary {
  schemaVersion: 'code_aware_semantic_delta_summary@2';
  evidenceKind: typeof DETERMINISTIC_EVIDENCE_KIND;
  realProviderAcceptance: false;
  semanticCoverage: {status: 'INCONCLUSIVE'; uncoveredFacets: string[]};
  passedMeaning: 'deterministic_assertions_only';
  passed: boolean;
  queryCount: number;
  conditionCount: number;
  groundTruth: ConstructedSourceGroundTruth;
  traceFacts: ActualTraceFacts;
  queries: Array<SemanticQuery & {sourceUseDecision?: SourceUseDecisionV1}>;
  conditions: Record<MatrixCondition, Record<string, unknown>>;
  sse: {
    rawSourceCanarySuppressed: boolean;
    ownerSourceVisible: boolean;
    analysisCompletionSourceAttached: boolean;
  };
  runtimeProof: {
    gate: 'src/agentRuntime/__tests__/sourceUseResultAttachment.test.ts';
    status: 'invoked_by_registered_command';
  };
  surfaceProof: {
    gate: 'src/services/__tests__/sourceProvenanceSurfaces.test.ts';
    status: 'invoked_by_registered_command';
    surfaces: ['report', 'cli', 'snapshot', 'web_receipt'];
  };
}

const CONDITIONS: readonly MatrixCondition[] = ['A0', 'A1', 'A2', 'A3', 'A4'];
const QUERIES: readonly SemanticQuery[] = [
  {
    id: 'autonomous-diagnosis',
    kind: 'autonomous-diagnosis',
    text: '诊断这次启动变慢的主要机制，区分本次 Trace 事实与源码机制解释。',
  },
  {
    id: 'quantitative-only',
    kind: 'quantitative-only',
    text: 'Trace 中 StartupHooks.initializeOnMainThread#before-first-frame-sync-policy 这个标记区间持续多久？只回答 Trace 中的量化事实。',
  },
  {
    id: 'explicit-source-location',
    kind: 'explicit-source-location',
    text: '指出本次启动标记对应的源码位置、调用链和最小可操作修改点。',
  },
];
const KNOWLEDGE_SCOPE = {
  tenantId: DEFAULT_TENANT_ID,
  workspaceId: DEFAULT_WORKSPACE_ID,
  userId: DEFAULT_DEV_USER_ID,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function sha256File(filePath: string): string {
  return createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`Invalid constructed source ground truth field: ${field}`);
  }
  return value;
}

function requireSha(value: unknown, field: string): string {
  const sha = requireString(value, field);
  if (!/^[a-f0-9]{64}$/.test(sha)) {
    throw new Error(`Invalid constructed source ground truth SHA: ${field}`);
  }
  return sha;
}

function queryMaterializedTrace(
  tracePath: string,
  expected: ConstructedSourceGroundTruth['traceFacts'],
): ActualTraceFacts {
  const marker = expected.marker.replace(/'/g, "''");
  const query = [
    "SELECT CAST(COUNT(*) AS TEXT) || '|' || CAST(MIN(s.dur) AS TEXT) || '|' ||",
    "MIN(t.name) || '|' || MIN(p.name) AS source_analysis_facts",
    'FROM slice s',
    'JOIN thread_track tt ON s.track_id = tt.id',
    'JOIN thread t USING(utid)',
    'JOIN process p USING(upid)',
    `WHERE s.name = '${marker}'`,
  ].join(' ');
  const result = spawnSync(getTraceProcessorPath(), ['query', tracePath, query], {
    encoding: 'utf8',
    maxBuffer: 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error('Constructed source trace facts could not be queried through trace_processor');
  }
  const row = result.stdout
    .split(/\r?\n/)
    .map(line => line.trim().replace(/^"|"$/g, ''))
    .find(line => /^\d+\|\d+\|/.test(line));
  if (!row) throw new Error('trace_processor did not return constructed source facts');
  const [occurrenceText, durationText, thread, process] = row.split('|');
  const actual: ActualTraceFacts = {
    occurrenceCount: Number(occurrenceText),
    marker: expected.marker,
    durationNs: Number(durationText),
    thread,
    process,
  };
  if (
    actual.occurrenceCount !== 1 ||
    actual.durationNs !== expected.durationNs ||
    actual.thread !== expected.thread ||
    actual.process !== expected.process
  ) {
    throw new Error('Constructed source trace facts do not match generated ground truth');
  }
  return actual;
}

export function loadConstructedSourceGroundTruth(repoRoot: string): ConstructedSourceGroundTruth {
  const caseDir = path.join(repoRoot, 'Trace/constructed/source-analysis-semantic');
  const expected = JSON.parse(fs.readFileSync(
    path.join(caseDir, 'analysis/expected.json'),
    'utf8',
  )) as Record<string, unknown>;
  const raw = expected.source_trace_ground_truth;
  if (!isRecord(raw) || !isRecord(raw.lineRange) || !isRecord(raw.compatibility) ||
      !isRecord(raw.sourceLines) || !isRecord(raw.traceFacts) || !isRecord(raw.traceFacts.selectedThreadStateNs) ||
      !isRecord(raw.traceFacts.firstFrame) || !isRecord(raw.trace)) {
    throw new Error('Missing generated source_trace_ground_truth');
  }
  const lineStart = Number(raw.lineRange.start);
  const lineEnd = Number(raw.lineRange.end);
  const durationNs = Number(raw.traceFacts.durationNs);
  const markerAtNs = Number(raw.traceFacts.atNs);
  const selectedThreadStateNs = {
    Running: Number(raw.traceFacts.selectedThreadStateNs.Running),
    D: Number(raw.traceFacts.selectedThreadStateNs.D),
    total: Number(raw.traceFacts.selectedThreadStateNs.total),
  };
  const firstFrameAtNs = Number(raw.traceFacts.firstFrame.atNs);
  const firstFrameDurationNs = Number(raw.traceFacts.firstFrame.durationNs);
  if (!Number.isInteger(lineStart) || lineStart <= 0 || !Number.isInteger(lineEnd) || lineEnd < lineStart) {
    throw new Error('Invalid generated source line range');
  }
  if (!Number.isSafeInteger(markerAtNs) || markerAtNs < 0 || !Number.isSafeInteger(durationNs) ||
      durationNs <= 0 || raw.traceFacts.occurrence !== true) {
    throw new Error('Invalid generated trace facts');
  }
  if (Object.values(selectedThreadStateNs).some(value => !Number.isSafeInteger(value) || value < 0) ||
      selectedThreadStateNs.Running + selectedThreadStateNs.D !== selectedThreadStateNs.total ||
      selectedThreadStateNs.total !== durationNs || !Number.isSafeInteger(firstFrameAtNs) || firstFrameAtNs <= 0 ||
      !Number.isSafeInteger(firstFrameDurationNs) || firstFrameDurationNs <= 0 ||
      markerAtNs + durationNs >= firstFrameAtNs ||
      raw.traceFacts.firstFrame.markerEndsBeforeStart !== true) {
    throw new Error('Invalid generated source trace interval contract');
  }
  const expectedSourceLineKeys = ['beginLine', 'callerLine', 'endLine', 'firstFrameBegin', 'firstFrameCaller',
    'policyLine', 'readLine'];
  const sourceLineEntries = Object.entries(raw.sourceLines);
  if (sourceLineEntries.map(([key]) => key).sort().join('|') !== expectedSourceLineKeys.join('|') ||
      sourceLineEntries.some(([, value]) => !Number.isInteger(Number(value)) || Number(value) <= 0)) {
    throw new Error('Invalid generated executable source line contract');
  }
  const groundTruth: ConstructedSourceGroundTruth = {
    marker: requireString(raw.marker, 'marker'),
    firstFrameMarker: requireString(raw.firstFrameMarker, 'firstFrameMarker'),
    relativeSourcePath: requireString(raw.relativeSourcePath, 'relativeSourcePath'),
    symbol: requireString(raw.symbol, 'symbol'),
    lineRange: {start: lineStart, end: lineEnd},
    callChain: Array.isArray(raw.callChain)
      ? raw.callChain.map((entry, index) => requireString(entry, `callChain[${index}]`))
      : [],
    actionableSeam: requireString(raw.actionableSeam, 'actionableSeam'),
    compatibility: {
      buildLink: requireString(raw.compatibility.buildLink, 'compatibility.buildLink') as 'synthetic_constructed_pair_only',
      causalStatus: requireString(raw.compatibility.causalStatus, 'compatibility.causalStatus') as 'candidate',
      baseAndroidStartupLinked: false,
    },
    sourceLines: Object.fromEntries(sourceLineEntries.map(([key, value]) => [key, Number(value)])) as ConstructedSourceGroundTruth['sourceLines'],
    traceFacts: {
      marker: requireString(raw.traceFacts.marker, 'traceFacts.marker'),
      occurrence: true,
      process: requireString(raw.traceFacts.process, 'traceFacts.process'),
      thread: requireString(raw.traceFacts.thread, 'traceFacts.thread'),
      atNs: markerAtNs,
      durationNs,
      selectedThreadStateNs,
      firstFrame: {
        marker: requireString(raw.traceFacts.firstFrame.marker, 'traceFacts.firstFrame.marker'),
        process: requireString(raw.traceFacts.firstFrame.process, 'traceFacts.firstFrame.process'),
        thread: requireString(raw.traceFacts.firstFrame.thread, 'traceFacts.firstFrame.thread'),
        atNs: firstFrameAtNs,
        durationNs: firstFrameDurationNs,
        markerEndsBeforeStart: true,
      },
    },
    trace: {
      baseCaseId: requireString(raw.trace.baseCaseId, 'trace.baseCaseId'),
      materialization: requireString(
        raw.trace.materialization,
        'trace.materialization',
      ) as 'committed-base-plus-overlay',
      baseSha256: requireSha(raw.trace.baseSha256, 'trace.baseSha256'),
      overlaySha256: requireSha(raw.trace.overlaySha256, 'trace.overlaySha256'),
      outputSha256: requireSha(raw.trace.outputSha256, 'trace.outputSha256'),
      runtimeRevision: requireString(raw.trace.runtimeRevision, 'trace.runtimeRevision'),
    },
  };
  if (groundTruth.trace.materialization !== 'committed-base-plus-overlay') {
    throw new Error('Constructed source ground truth must use committed-base-plus-overlay');
  }
  if (groundTruth.compatibility.buildLink !== 'synthetic_constructed_pair_only' ||
      groundTruth.compatibility.causalStatus !== 'candidate' || raw.compatibility.baseAndroidStartupLinked !== false ||
      groundTruth.traceFacts.marker !== groundTruth.marker ||
      groundTruth.traceFacts.firstFrame.marker !== groundTruth.firstFrameMarker ||
      groundTruth.traceFacts.firstFrame.process !== groundTruth.traceFacts.process ||
      groundTruth.traceFacts.firstFrame.thread !== groundTruth.traceFacts.thread) {
    throw new Error('Constructed source ground truth overstates source/trace compatibility');
  }
  if (groundTruth.callChain.join('|') !== [
    'Application.onCreate', 'StartupHooks.initializeOnMainThread',
    'StartupHooks.readStartupPolicySynchronously', 'File.readText',
  ].join('|') || groundTruth.sourceLines.beginLine <= groundTruth.lineRange.start ||
      groundTruth.sourceLines.policyLine <= groundTruth.sourceLines.beginLine ||
      groundTruth.sourceLines.endLine <= groundTruth.sourceLines.policyLine ||
      groundTruth.sourceLines.readLine <= groundTruth.sourceLines.endLine ||
      groundTruth.sourceLines.readLine > groundTruth.lineRange.end ||
      groundTruth.sourceLines.callerLine <= groundTruth.lineRange.end ||
      groundTruth.sourceLines.firstFrameBegin <= groundTruth.lineRange.end ||
      groundTruth.sourceLines.firstFrameCaller <= groundTruth.sourceLines.firstFrameBegin) {
    throw new Error('Constructed source ground truth does not bind the executable mechanism');
  }
  const overlayPath = path.join(caseDir, 'trace.overlay.pftrace');
  if (sha256File(overlayPath) !== groundTruth.trace.overlaySha256) {
    throw new Error('Constructed source overlay SHA does not match generated ground truth');
  }
  const generatedTracePath = path.join(
    repoRoot,
    'Trace/.generated/constructed/source-analysis-semantic/trace.pftrace',
  );
  if (sha256File(generatedTracePath) !== groundTruth.trace.outputSha256) {
    throw new Error('Constructed source output SHA does not match generated ground truth');
  }
  queryMaterializedTrace(generatedTracePath, groundTruth.traceFacts);
  return groundTruth;
}

async function startRagHarness(input: {
  stateRoot: string;
  allowedRoots: string[];
}): Promise<RagHarness> {
  const store = new RagStore(path.join(input.stateRoot, 'rag.json'));
  const registry = new CodebaseRegistry(path.join(input.stateRoot, 'codebases.json'));
  const gate = new PathSecurityGate({allowlistRoots: input.allowedRoots});
  const codebaseManagementService = new CodebaseManagementService({registry, store, gate});
  const app = express();
  app.use(express.json({limit: '5mb'}));
  app.use('/api/rag', createRagAdminRoutes(store, {
    registry,
    gate,
    codebaseManagementService,
  }));
  const server = await new Promise<Server>((resolve, reject) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
    listening.once('error', reject);
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    await new Promise<void>(resolve => server.close(() => resolve()));
    throw new Error('Could not resolve deterministic RAG harness address');
  }
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    registry,
    store,
    close: () => new Promise<void>((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve());
    }),
  };
}

function parseToolResult(value: unknown): unknown {
  if (!isRecord(value) || !Array.isArray(value.content)) return value;
  const text = value.content
    .filter(isRecord)
    .find(candidate => candidate.type === 'text' && typeof candidate.text === 'string')?.text;
  if (typeof text !== 'string') return value;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function createSourceHarness(input: {
  sessionId: string;
  userQuery: string;
  codeAwareMode: 'metadata_only' | 'provider_send';
  codebaseId: string;
  registry: CodebaseRegistry;
  store: RagStore;
  stateRoot: string;
}): SourceHarness {
  const mcp = createClaudeMcpServer({
    traceId: `trace-${input.sessionId}`,
    userQuery: input.userQuery,
    traceProcessorService: {
      query: async () => ({columns: [], rows: [], durationMs: 0}),
    },
    skillExecutor: {
      execute: async () => ({
        skillId: 'semantic-delta-fixture',
        success: true,
        displayResults: [],
        diagnostics: [],
        executionTimeMs: 0,
      }),
      replaceRegisteredSkills: () => undefined,
      registerSkills: () => undefined,
      registerSkill: () => undefined,
      setFragmentRegistry: () => undefined,
      setRunManifestAttributionSink: () => undefined,
    },
    analysisNotes: [],
    hypotheses: [],
    uncertaintyFlags: [],
    watchdogWarning: {current: null},
    artifactStore: new ArtifactStore(),
    codeAwareMode: input.codeAwareMode,
    codebaseIds: [input.codebaseId],
    codebaseRegistry: input.registry,
    onDemandSourceAccess: new DeterministicFixtureSourceAccessService(input.registry),
    ragStore: input.store,
    codeLookupLedger: new CodeLookupLedger(
      input.sessionId,
      20,
      path.join(input.stateRoot, `${input.sessionId}.jsonl`),
    ),
    knowledgeScope: KNOWLEDGE_SCOPE,
    sessionId: input.sessionId,
    lightweight: true,
    conversationTraceAttached: true,
  } as any);
  return {
    sessionId: input.sessionId,
    sourceUse: mcp.sourceUse,
    async invoke(name, args = {}) {
      const definition = mcp.toolDefinitions.find(candidate => candidate.name === name);
      if (!definition) throw new Error(`Deterministic source handler not found: ${name}`);
      return parseToolResult(await definition.shared.handler(args, {}));
    },
  };
}

async function setupCodebase(
  harness: RagHarness,
  rootPath: string,
  mode: 'register-only' | 'register-and-index',
  codeAwareMode: 'metadata_only' | 'provider_send',
): Promise<AnalysisContextSetupResult['codebases'][number]> {
  const options = parseAgentSseArgs([
    '--setup-codebase-root', rootPath,
    '--setup-codebase-mode', mode,
    '--code-aware', codeAwareMode,
  ]);
  const setup = await setupAnalysisContext(harness.baseUrl, options);
  const codebase = setup.codebases[0];
  if (!codebase) throw new Error(`Missing audited ${mode} setup result`);
  return codebase;
}

async function collectSourceEvidence(input: {
  harness: SourceHarness;
  groundTruth: ConstructedSourceGroundTruth;
  indexed: boolean;
}): Promise<{
  decision: SourceUseDecisionV1;
  sourceFacts: SourceFacts;
  exactReference: SourceReferenceV1;
  rawSourceText: string;
  indexedReference?: SourceReferenceV1;
}> {
  const symbolSegments = input.groundTruth.symbol.split('.');
  const shortSymbol = symbolSegments[symbolSegments.length - 1] ?? input.groundTruth.symbol;
  const search = await input.harness.invoke('search_codebase', {
    query: shortSymbol,
    max_results: 8,
  });
  if (!isRecord(search) || search.success !== true) {
    throw new Error('Actual search_codebase handler did not succeed');
  }
  let indexedPayload: unknown;
  if (input.indexed) {
    const indexed = await input.harness.invoke('lookup_app_source', {
      query: input.groundTruth.marker,
      max_results: 8,
    });
    if (!isRecord(indexed) || indexed.success !== true) {
      throw new Error('Actual lookup_app_source handler did not succeed');
    }
    indexedPayload = indexed.result;
  }
  const exactRead = await input.harness.invoke('read_codebase_file', {
    file_path: path.basename(input.groundTruth.relativeSourcePath),
    start_line: input.groundTruth.lineRange.start,
    max_lines: input.groundTruth.lineRange.end - input.groundTruth.lineRange.start + 1,
  });
  const seamRead = await input.harness.invoke('read_codebase_file', {
    file_path: path.basename(input.groundTruth.relativeSourcePath),
    start_line: input.groundTruth.lineRange.start,
    max_lines: input.groundTruth.lineRange.end - input.groundTruth.lineRange.start + 9,
  });
  const callSiteSearch = await input.harness.invoke('search_codebase', {
    query: 'onCreate',
    max_results: 8,
  });
  const callSiteRead = await input.harness.invoke('read_codebase_file', {
    file_path: path.basename(input.groundTruth.relativeSourcePath),
    start_line: input.groundTruth.lineRange.start + 8,
    max_lines: input.groundTruth.lineRange.end - input.groundTruth.lineRange.start + 9,
  });
  const handlerText = JSON.stringify({search, exactRead, seamRead, callSiteSearch, callSiteRead});
  const decision = input.harness.sourceUse.getSourceUseDecision();
  if (!decision || decision.status !== 'corroborated') {
    throw new Error('Actual source handlers did not produce a corroborated decision');
  }
  const filePath = path.basename(input.groundTruth.relativeSourcePath);
  const returnedReferences = isRecord(exactRead) && Array.isArray(exactRead.sourceReferences)
    ? exactRead.sourceReferences as SourceReferenceV1[] : [];
  const exactReference = returnedReferences.find(reference =>
    reference.filePath === filePath &&
    reference.lineRange?.start === input.groundTruth.lineRange.start &&
    reference.lineRange.end === input.groundTruth.lineRange.end &&
    isBodyLookupKind(reference.lookupKind));
  if (!exactReference) throw new Error('Actual source handlers did not return the exact CodeRef');
  const indexedReference = isRecord(indexedPayload) && Array.isArray(indexedPayload.sourceReferences)
    ? (indexedPayload.sourceReferences as SourceReferenceV1[]).find(reference => reference.lookupKind === 'indexed')
    : undefined;
  if (input.indexed && !indexedReference) {
    throw new Error('Indexed setup did not produce an indexed CodeRef');
  }
  // The model reads one line-numbered body; its numbers must be the window's
  // real lines, and the raw text under them is what echo checks look for.
  const numberedText = isRecord(exactRead) && isRecord(exactRead.reference) &&
    typeof exactRead.reference.numberedText === 'string'
    ? exactRead.reference.numberedText
    : '';
  const numberedLines = numberedText ? numberedText.split('\n') : [];
  const numberedLinesMatchWindow = numberedLines.length ===
    input.groundTruth.lineRange.end - input.groundTruth.lineRange.start + 1 &&
    numberedLines.every((line, index) => line.startsWith(`${input.groundTruth.lineRange.start + index}: `));
  if (!numberedLinesMatchWindow) {
    throw new Error('Actual read handler did not number the returned lines with the window lines');
  }
  if (isRecord(exactRead) && isRecord(exactRead.reference) && 'text' in exactRead.reference) {
    throw new Error('Actual read handler returned the source body twice');
  }
  const rawSourceText = numberedLines.map(line => line.replace(/^\d+: /, '')).join('\n');
  const sourceFacts: SourceFacts = {
    exactRelativeFile: exactReference.filePath === filePath,
    exactSymbol: handlerText.includes(`fun ${shortSymbol}`),
    exactLine: exactReference.lineRange?.start === input.groundTruth.lineRange.start &&
      exactReference.lineRange.end === input.groundTruth.lineRange.end,
    callChainMapped: handlerText.includes('fun onCreate') &&
      handlerText.includes('StartupHooks.initializeOnMainThread(policyFile)') &&
      handlerText.includes('val startupPolicy = readStartupPolicySynchronously(policyFile)') &&
      handlerText.includes('policyFile.readText()'),
    traceMarkerMapped: handlerText.includes(input.groundTruth.marker) &&
      handlerText.includes('Trace.beginSection(TRACE_SOURCE_MARKER)') &&
      handlerText.includes('Trace.endSection()'),
    actionableSeam: handlerText.includes('readStartupPolicySynchronously') &&
      handlerText.includes('FIRST_FRAME_TRACE_MARKER'),
  };
  if (!Object.values(sourceFacts).every(Boolean)) {
    throw new Error(`Actual source handlers did not prove every semantic fact: ${JSON.stringify(sourceFacts)}`);
  }
  return {decision, sourceFacts, exactReference, rawSourceText, indexedReference};
}

async function verifyTraceSourceBinding(input: {
  sourceUse: SourceUseDecisionV1;
  sourceReference: SourceReferenceV1;
  traceFacts: ActualTraceFacts;
  wrongReference?: SourceReferenceV1;
}) {
  const evidenceRefId = 'data:source-analysis:marker';
  const claimId = 'claim-source-analysis-marker';
  const boundReference = input.wrongReference ?? input.sourceReference;
  const reference = {evidenceRefId, rowIndex: 0, column: 'duration_ns', value: input.traceFacts.durationNs};
  const declaration: ConclusionContract = {
    schemaVersion: 'conclusion_contract_v1',
    mode: 'focused_answer',
    conclusions: [{rank: 1, statement: 'The source reference is compatible with the captured trace marker.'}],
    clusters: [],
    evidenceChain: [{conclusionId: claimId, text: 'Verified trace marker occurrence.'}],
    claims: [{
      id: claimId,
      kind: 'numeric',
      text: `The constructed startup marker lasted ${input.traceFacts.durationNs} ns.`,
      references: [reference],
      semantics: {schemaVersion: 'claim_semantics@1', predicate: 'numeric.cell', polarity: 'affirmed',
        discourse: 'asserted', quantifier: 'one', modality: 'certain',
        scope: {population: 'cited_rows', subjectRefs: [reference]},
        numeric: {operator: 'eq', value: input.traceFacts.durationNs, unit: 'ns'}},
    }],
    sourceReferences: [boundReference],
    sourceClaimBindings: [{
      claimId,
      sourceReferenceIds: [boundReference.id],
      traceEvidenceRefIds: [evidenceRefId],
    }],
    uncertainties: [],
    nextSteps: [],
  };
  const contract = parseConclusionContractDeclaration(declaration).contract;
  if (!contract || contract.bindingEligibility !== 'eligible') throw new Error('Invalid source trace fixture declaration');
  // These primitives were read by queryMaterializedTrace, not copied from the
  // expected fixture. Capture precedes every presentation/verification projection.
  const rawTable = {
    columns: ['occurrence_count', 'marker', 'duration_ns', 'thread_name', 'process_name'],
    rows: [[
      input.traceFacts.occurrenceCount,
      input.traceFacts.marker,
      input.traceFacts.durationNs,
      input.traceFacts.thread,
      input.traceFacts.process,
    ]],
  };
  const witness = captureEvidenceTable(rawTable, {duration_ns: {unit: 'ns',
    origin: {kind: 'native_producer', definitionFingerprint: sha256File(__filename)}}});
  const store = new ArtifactStore();
  const artifactId = store.store({skillId: 'semantic-delta-fixture', title: 'Constructed source marker occurrence',
    data: rawTable, sourceToolCallId: 'trace_processor:source-analysis-marker',
    traceProvenance: buildTraceProcessorQueryProvenance({traceId: 'source-analysis-semantic', traceSide: 'current'}),
    scopeProvenance: {version: 'process_scope_evidence@1', entries: [{role: 'target',
      scope: {mode: 'unscoped', traceId: 'source-analysis-semantic', traceSide: 'current'},
      fields: rawTable.columns, availability: 'available'}]}});
  if (!store.registerEvidenceCapture(artifactId, witness, {evidenceRefId})) throw new Error('Source fixture capture registration failed');
  const readView = store.createEvidenceReadView({ownerKey: 'deterministic-source-fixture',
    allowedTraces: [{traceId: 'source-analysis-semantic', traceSide: 'current'}]});
  const envelope = createDataEnvelope(rawTable, {
    type: 'sql_result',
    source: 'trace_processor',
    title: 'Constructed source marker occurrence',
    evidenceRefId,
    sourceToolCallId: 'trace_processor:source-analysis-marker',
    traceId: 'source-analysis-semantic',
    traceSide: 'current',
  });
  const preparedEvidence = await prepareClaimEvidence({conclusionContract: contract, evidenceReadView: readView});
  const claimVerification = runClaimVerification({
    conclusionContract: contract,
    dataEnvelopes: [envelope],
    preparedEvidence,
    policy: 'block',
  });
  // The answer cites the bound location, so the claim's visible text can be checked.
  const range = boundReference.lineRange;
  const body = `The startup marker is emitted at ${boundReference.filePath}:L${range?.start ?? 1}-L${range?.end ?? 1} ` +
    `and lasted ${input.traceFacts.durationNs} ns.`;
  const sourceClaimVerification = verifySourceClaimBindings({
    conclusionContract: contract,
    actualSourceUseDecision: input.sourceUse,
    matchedTraceEvidenceRefIdsByClaimId: claimVerification.matchedTraceEvidenceRefIdsByClaimId,
    body,
  });
  // A CodeRef with no same-claim Trace evidence is a source explanation only.
  const codeRefOnlyOccurrence = verifySourceClaimBindings({
    conclusionContract: {...contract, sourceClaimBindings: contract.sourceClaimBindings?.map(binding =>
      ({...binding, traceEvidenceRefIds: []}))},
    actualSourceUseDecision: input.sourceUse,
    matchedTraceEvidenceRefIdsByClaimId: claimVerification.matchedTraceEvidenceRefIdsByClaimId,
    body,
  });
  const wrongDeclaration = structuredClone(declaration);
  wrongDeclaration.claims![0].semantics!.numeric!.value = input.traceFacts.durationNs + 1;
  wrongDeclaration.claims![0].text = `The constructed startup marker lasted ${input.traceFacts.durationNs + 1} ns.`;
  const wrongContract = parseConclusionContractDeclaration(wrongDeclaration).contract!;
  const wrongPrepared = await prepareClaimEvidence({conclusionContract: wrongContract, evidenceReadView: readView});
  const wrongNumericVerification = runClaimVerification({conclusionContract: wrongContract, preparedEvidence: wrongPrepared});
  return {claimVerification, sourceClaimVerification, codeRefOnlyOccurrence, wrongNumericVerification,
    originalWrongClaim: wrongContract.claims![0],
    finiteProofPassed: claimVerification.claimVerificationResult.claimResults.length === 1 &&
      claimVerification.claimVerificationResult.claimResults[0].deterministicProof?.status === 'proved' &&
      claimVerification.claimVerificationResult.claimResults[0].propositionCoverage?.status === 'complete',
    semanticCoverage: 'INCONCLUSIVE' as const};
}

function createSseEvidence(input: {
  harness: SourceHarness;
  rawSourceText: string;
}): DeterministicVerificationSummary['sse'] {
  if (!input.rawSourceText) throw new Error('Actual source handler did not return source body text');
  const answer = projectCodeAwareStreamingUpdate(
    input.harness.sessionId,
    {type: 'answer_token', content: input.rawSourceText, timestamp: 1},
    true,
    'en',
  );
  const result: AnalysisResult = {
    sessionId: input.harness.sessionId,
    success: true,
    findings: [],
    hypotheses: [],
    conclusion: input.rawSourceText,
    confidence: 0.8,
    rounds: 1,
    totalDurationMs: 1,
  };
  const ownerAnswer = projectOwnerCodeAwareStreamingUpdate(input.harness.sessionId,
    {type: 'answer_token', content: input.rawSourceText, timestamp: 1}, true, 'en');
  const ownerFinal = finalizeOwnerSourceAwareAnalysisResultWithProjection({...result}, input.harness.sourceUse).result;
  const finalized = finalizeSourceAwareAnalysisResult(result, input.harness.sourceUse);
  const projected = JSON.stringify({answer, finalized});
  return {
    rawSourceCanarySuppressed: !projected.includes(input.rawSourceText),
    ownerSourceVisible: ownerAnswer?.content === input.rawSourceText &&
      ownerFinal.conclusion.includes(input.rawSourceText),
    analysisCompletionSourceAttached:
      finalized.sourceUseDecision?.status === 'corroborated' &&
      Boolean(finalized.sourceReferences?.length),
  };
}

function writeJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), {recursive: true});
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

export async function runDeterministicSemanticDeltaVerification(input: {
  repoRoot: string;
  outputDir: string;
}): Promise<DeterministicVerificationSummary> {
  const groundTruth = loadConstructedSourceGroundTruth(input.repoRoot);
  const tracePath = path.join(
    input.repoRoot,
    'Trace/.generated/constructed/source-analysis-semantic/trace.pftrace',
  );
  const traceFacts = queryMaterializedTrace(tracePath, groundTruth.traceFacts);
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'semantic-delta-state-'));
  const unrelatedRoot = path.join(stateRoot, 'unrelated-app');
  fs.mkdirSync(unrelatedRoot, {recursive: true});
  fs.writeFileSync(
    path.join(unrelatedRoot, 'ForeignHooks.kt'),
    'package unrelated\nobject ForeignHooks { fun unrelated() = Unit }\n',
  );
  const sourceRoot = path.join(
    input.repoRoot,
    path.dirname(groundTruth.relativeSourcePath),
  );
  const previousCodebaseRoots = process.env.SMARTPERFETTO_CODEBASE_ROOTS;
  process.env.SMARTPERFETTO_CODEBASE_ROOTS = [sourceRoot, unrelatedRoot].join(path.delimiter);
  let ragHarness: RagHarness | undefined;
  const sessions: string[] = [];
  try {
    ragHarness = await startRagHarness({stateRoot, allowedRoots: [sourceRoot, unrelatedRoot]});
    const a1Setup = await setupCodebase(ragHarness, sourceRoot, 'register-only', 'metadata_only');
    const a1Harness = createSourceHarness({
      sessionId: 'semantic-delta-a1',
      userQuery: QUERIES[0].text,
      codeAwareMode: 'metadata_only',
      codebaseId: a1Setup.codebaseId,
      registry: ragHarness.registry,
      store: ragHarness.store,
      stateRoot,
    });
    sessions.push(a1Harness.sessionId);
    const a1Read = await a1Harness.invoke('read_codebase_file', {
      file_path: path.basename(groundTruth.relativeSourcePath),
      start_line: groundTruth.lineRange.start,
      end_line: groundTruth.lineRange.end,
    });
    if (!isRecord(a1Read) || a1Read.success !== true) {
      throw new Error('Actual metadata-only source handler did not succeed');
    }
    const a1Decision = a1Harness.sourceUse.getSourceUseDecision();
    if (!a1Decision || a1Decision.status !== 'located') {
      throw new Error('Actual metadata-only source handler did not produce located provenance');
    }

    const a2Setup = await setupCodebase(ragHarness, sourceRoot, 'register-only', 'provider_send');
    const a2Harness = createSourceHarness({
      sessionId: 'semantic-delta-a2',
      userQuery: QUERIES[0].text,
      codeAwareMode: 'provider_send',
      codebaseId: a2Setup.codebaseId,
      registry: ragHarness.registry,
      store: ragHarness.store,
      stateRoot,
    });
    sessions.push(a2Harness.sessionId);
    const a2 = await collectSourceEvidence({harness: a2Harness, groundTruth, indexed: false});
    const a2Verification = await verifyTraceSourceBinding({
      sourceUse: a2.decision,
      sourceReference: a2.exactReference,
      traceFacts,
    });

    const quantitativeHarness = createSourceHarness({
      sessionId: 'semantic-delta-quantitative',
      userQuery: QUERIES[1].text,
      codeAwareMode: 'provider_send',
      codebaseId: a2Setup.codebaseId,
      registry: ragHarness.registry,
      store: ragHarness.store,
      stateRoot,
    });
    sessions.push(quantitativeHarness.sessionId);
    // This fixture deliberately makes no source call: a trace-only answer
    // leaves the source audit at its initial state.
    const quantitativeDecision = quantitativeHarness.sourceUse.getSourceUseDecision();
    if (!quantitativeDecision) throw new Error('Source harness audit state is unavailable');

    const a3Setup = await setupCodebase(ragHarness, sourceRoot, 'register-and-index', 'provider_send');
    const a3Harness = createSourceHarness({
      sessionId: 'semantic-delta-a3',
      userQuery: QUERIES[2].text,
      codeAwareMode: 'provider_send',
      codebaseId: a3Setup.codebaseId,
      registry: ragHarness.registry,
      store: ragHarness.store,
      stateRoot,
    });
    sessions.push(a3Harness.sessionId);
    const a3 = await collectSourceEvidence({harness: a3Harness, groundTruth, indexed: true});
    const a3Verification = await verifyTraceSourceBinding({
      sourceUse: a3.decision,
      sourceReference: a3.exactReference,
      traceFacts,
    });

    const a4Setup = await setupCodebase(ragHarness, unrelatedRoot, 'register-only', 'provider_send');
    const a4Harness = createSourceHarness({
      sessionId: 'semantic-delta-a4',
      userQuery: QUERIES[2].text,
      codeAwareMode: 'provider_send',
      codebaseId: a4Setup.codebaseId,
      registry: ragHarness.registry,
      store: ragHarness.store,
      stateRoot,
    });
    sessions.push(a4Harness.sessionId);
    const a4Search = await a4Harness.invoke('search_codebase', {
      query: groundTruth.marker,
      max_results: 8,
    });
    if (!isRecord(a4Search) || a4Search.success !== true) {
      throw new Error('Actual A4 foreign-source search did not complete');
    }
    const a4Decision = a4Harness.sourceUse.getSourceUseDecision();
    if (!a4Decision) throw new Error('Actual A4 source search did not produce a decision');
    const a4Verification = await verifyTraceSourceBinding({
      sourceUse: a4Decision,
      sourceReference: a2.exactReference,
      wrongReference: a2.exactReference,
      traceFacts,
    });

    const sse = createSseEvidence({harness: a2Harness, rawSourceText: a2.rawSourceText});
    const conditions: DeterministicVerificationSummary['conditions'] = {
      A0: {
        occurrenceAuthority: 'trace_processor',
        codeReferenceProvesOccurrence: false,
        traceFacts,
        sourceUse: {codeAwareMode: 'off', status: 'trace_only'},
      },
      A1: {setup: a1Setup, sourceUse: a1Decision},
      A2: {setup: a2Setup, sourceUse: a2.decision, sourceFacts: a2.sourceFacts, ...a2Verification},
      A3: {
        setup: a3Setup,
        sourceUse: a3.decision,
        indexedReference: a3.indexedReference,
        sourceFacts: a3.sourceFacts,
        ...a3Verification,
      },
      A4: {
        setup: a4Setup,
        sourceUse: a4Decision,
        wrongReferenceRejected: a4Verification.sourceClaimVerification.status === 'failed',
        sourceClaimVerification: a4Verification.sourceClaimVerification,
      },
    };
    const passed = [a2Verification, a3Verification].every(verification =>
      verification.finiteProofPassed && verification.claimVerification.claimVerificationResult.status === 'partial' &&
      verification.wrongNumericVerification.claimVerificationResult.status === 'failed' &&
      verification.sourceClaimVerification.status === 'passed' &&
      verification.codeRefOnlyOccurrence.status !== 'passed') &&
      a4Verification.sourceClaimVerification.status === 'failed' &&
      a4Decision.references.length === 0 &&
      quantitativeDecision.attemptedTools.length === 0 &&
      quantitativeDecision.references.length === 0 &&
      Object.values(sse).every(Boolean);
    const summary: DeterministicVerificationSummary = {
      schemaVersion: 'code_aware_semantic_delta_summary@2',
      evidenceKind: DETERMINISTIC_EVIDENCE_KIND,
      realProviderAcceptance: false,
      semanticCoverage: {status: 'INCONCLUSIVE', uncoveredFacets: ['model prose and declaration consistency', 'native source execution mechanism']},
      passedMeaning: 'deterministic_assertions_only',
      passed,
      queryCount: QUERIES.length,
      conditionCount: CONDITIONS.length,
      groundTruth,
      traceFacts,
      queries: QUERIES.map(query => query.kind === 'quantitative-only'
        ? {...query, sourceUseDecision: quantitativeDecision}
        : {...query}),
      conditions,
      sse,
      runtimeProof: {
        gate: 'src/agentRuntime/__tests__/sourceUseResultAttachment.test.ts',
        status: 'invoked_by_registered_command',
      },
      surfaceProof: {
        gate: 'src/services/__tests__/sourceProvenanceSurfaces.test.ts',
        status: 'invoked_by_registered_command',
        surfaces: ['report', 'cli', 'snapshot', 'web_receipt'],
      },
    };
    const serialized = JSON.stringify(summary);
    if (
      serialized.includes(sourceRoot) ||
      serialized.includes(a2.rawSourceText) ||
      serialized.includes('val startupPolicy =')
    ) {
      throw new Error('Deterministic semantic evidence leaked private source content or roots');
    }
    writeJson(path.join(input.outputDir, 'deterministic-summary.json'), summary);
    return summary;
  } finally {
    for (const sessionId of sessions) clearCodeAwareOutputGuards(sessionId);
    await ragHarness?.close();
    if (previousCodebaseRoots === undefined) {
      delete process.env.SMARTPERFETTO_CODEBASE_ROOTS;
    } else {
      process.env.SMARTPERFETTO_CODEBASE_ROOTS = previousCodebaseRoots;
    }
    fs.rmSync(stateRoot, {recursive: true, force: true});
  }
}

function parseOutputDir(argv: string[]): string {
  if (argv.length === 0) {
    return path.resolve(process.cwd(), 'test-output/code-aware-semantic-delta');
  }
  if (argv.length === 2 && argv[0] === '--output-dir' && argv[1]) {
    return path.resolve(process.cwd(), argv[1]);
  }
  throw new Error('Usage: verifyCodeAwareSemanticDelta.ts [--output-dir <path>]');
}

if (require.main === module) {
  const outputDir = parseOutputDir(process.argv.slice(2));
  const repoRoot = path.resolve(__dirname, '../../..');
  void runDeterministicSemanticDeltaVerification({repoRoot, outputDir})
    .then(summary => {
      console.log(JSON.stringify(summary, null, 2));
      if (!summary.passed) process.exitCode = 1;
    })
    .catch(error => {
      console.error(error instanceof Error ? error.message : error);
      process.exitCode = 1;
    });
}
