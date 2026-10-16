// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { registerFocusAppEvidence } from '../focusAppEvidence';
import { buildFocusAppPromptData, resolveFocusAppTarget, type FocusAppEvidenceLocator } from '../focusAppTarget';
import { createRuntimeEvidenceContext, resolveRuntimeEvidenceStore, type RuntimeEvidenceContext } from '../runtimeEvidenceContext';
import { ArtifactStore } from '../../agentv3/artifactStore';
import type { FocusAppDetectionResult } from '../../agentv3/focusAppDetector';
import type { AnalysisOptions } from '../../agent/core/orchestratorTypes';
import { parseConclusionContractDeclaration, type ConclusionContract } from '../../agent/core/conclusionContract';
import { prepareClaimEvidence } from '../../services/evidence/claimEvidencePreparation';
import { runClaimVerification } from '../../services/verifier/claimVerificationRunner';

describe('registerFocusAppEvidence', () => {
  const contexts: RuntimeEvidenceContext[] = [];
  afterEach(() => { contexts.splice(0).forEach(context => context.dispose()); });
  const options: AnalysisOptions = {tenantId: 'focus-tenant', workspaceId: 'focus-workspace', userId: 'focus-user'};
  const confident = (overrides: Partial<FocusAppDetectionResult> = {}): FocusAppDetectionResult => ({
    method: 'oom_adj', confidence: 'high', primaryApp: 'com.example.focus',
    apps: [{packageName: 'com.example.focus', totalDurationNs: 9_000_000, switchCount: 2, score: 40},
      {packageName: 'com.example.other', totalDurationNs: 1_000_000, switchCount: 1, score: 10}],
    ...overrides,
  });
  const readScope = {ownerKey: 'owner', allowedTraces: [{traceId: 'trace', traceSide: 'current' as const}]};

  /** One logical session; each call binds a new run whose facade stamps `originRunId`. */
  function session() {
    const context = createRuntimeEvidenceContext({logicalSessionId: 'conversation', traceId: 'trace', options});
    contexts.push(context);
    return (runId: string) => {
      const sessionId = `runtime:${runId}`;
      const binding = context.bind(options, {runtimeSessionId: sessionId, runId, signal: new AbortController().signal,
        assertAuthorized() {}});
      return resolveRuntimeEvidenceStore({...binding.options}, {sessionId, traceId: 'trace'}, () => {
        throw new Error('A live issued binding must not use the fallback');
      });
    };
  }

  function register(focusResult: FocusAppDetectionResult | undefined, store: Pick<ArtifactStore, 'registerStandaloneEvidenceCapture'>) {
    return registerFocusAppEvidence({store, traceId: 'trace', focusResult, focusTarget: resolveFocusAppTarget({focusResult})});
  }

  const packageCell = (evidence: FocusAppEvidenceLocator, value?: string) => ({evidenceRefId: evidence.evidenceRefId,
    sourceToolCallId: evidence.sourceToolCallId, rowIndex: 0, column: 'package_name', ...(value ? {value} : {})});

  it('registers one discrete current-run row through the run facade and renders its locator', async () => {
    const store = session()('run-1');
    const target = register(confident(), store);
    expect(target.evidence).toEqual({
      evidenceRefId: expect.stringMatching(/^data:focus_app:current:[a-f0-9]{12}$/),
      sourceToolCallId: expect.stringMatching(/^runtime-focus-app:[a-f0-9]{12}$/), rowIndex: 0,
      row: {package_name: 'com.example.focus', detection_method: 'oom_adj', detection_confidence: 'high'},
    });
    expect(buildFocusAppPromptData(target)).toMatchObject({primary: 'com.example.focus', evidence: target.evidence});
    const [resolution] = await store.createEvidenceReadView({...readScope, currentRunId: 'run-1'}).resolveReferences([{
      key: 'focus', requiredColumns: [], reference: packageCell(target.evidence!)}]);
    expect(resolution).toMatchObject({status: 'resolved', originalRowIndex: 0, record: {
      originRunId: 'run-1', totalRowCount: 1, columns: ['package_name', 'detection_method', 'detection_confidence'],
      meta: {source: 'runtime_focus_detection', traceId: 'trace', traceSide: 'current', executionStatus: 'observed'},
    }});
    if (resolution.status !== 'resolved') throw new Error('unreachable');
    // A fixed producer with no unit on any field: the row proves identity, never a duration.
    const fields = Object.values(resolution.record.fields);
    expect(fields).toHaveLength(3);
    expect(new Set(fields.map(field => field.origin.definitionFingerprint)).size).toBe(1);
    expect(fields.every(field => field.origin.kind === 'native_producer' && field.unit === undefined)).toBe(true);
  });

  it.each([
    ['com.example.focus', 'proved'],
    ['com.example.other', 'rejected'],
  ] as const)('proves a captured.cell claim on the package cell only for the detected value (%s)', async (value, expected) => {
    const store = session()('run-claim');
    const ref = packageCell(register(confident(), store).evidence!, value);
    const raw: ConclusionContract = {schemaVersion: 'conclusion_contract_v1', mode: 'focused_answer', conclusions: [],
      clusters: [], evidenceChain: [], uncertainties: [], nextSteps: [], claims: [{id: 'focus', kind: 'identity',
        text: `The detector's primary app for this window is ${value}.`, references: [ref], semantics: {
          schemaVersion: 'claim_semantics@1', predicate: 'captured.cell', polarity: 'affirmed', discourse: 'asserted',
          quantifier: 'one', modality: 'certain', scope: {population: 'cited_rows', subjectRefs: [ref]}}}]};
    const parsed = parseConclusionContractDeclaration(raw);
    expect(parsed.issues).toEqual([]);
    const preparedEvidence = await prepareClaimEvidence({conclusionContract: parsed.contract, bindingEligibility: 'eligible',
      evidenceReadView: store.createEvidenceReadView({...readScope, currentRunId: 'run-claim'})});
    const [claim] = runClaimVerification({conclusionContract: parsed.contract, preparedEvidence,
      bindingEligibility: 'eligible'}).claimVerificationResult.claimResults;
    expect(claim.deterministicProof).toMatchObject({kind: 'captured_cell', status: expected});
    expect(claim.referenceCells?.[0]?.status).toBe(expected === 'proved' ? 'matched' : 'value_mismatch');
  });

  it('re-issues the same locator for the same detection and keeps the first record untouched', async () => {
    const run = session();
    const earlier = run('run-a');
    const first = register(confident(), earlier).evidence!;
    const [captured] = await earlier.createEvidenceReadView({...readScope, currentRunId: 'run-a'}).resolveReferences([
      {key: 'earlier', requiredColumns: [], reference: packageCell(first)}]);
    if (captured.status !== 'resolved') throw new Error(`first run could not read its capture: ${captured.status}`);
    const latest = run('run-b');
    const second = register(confident(), latest).evidence!;
    expect(second).toEqual(first);
    const resolutions = await latest.createEvidenceReadView({...readScope, currentRunId: 'run-b'}).resolveReferences([
      {key: 'by-ref', requiredColumns: [], reference: {evidenceRefId: second.evidenceRefId, rowIndex: 0, column: 'package_name'}},
      {key: 'by-locator', requiredColumns: [], reference: packageCell(second)},
    ]);
    // One record, never re-attributed: the same capture, owned by the run that captured it.
    const retained = expect.objectContaining({status: 'resolved',
      record: expect.objectContaining({originRunId: 'run-a', captureId: captured.record.captureId})});
    expect(resolutions).toEqual([retained, retained]);
  });

  it('issues a different locator for a different detection', () => {
    const store = new ArtifactStore();
    const locators = [confident(), confident({method: 'battery_stats'}), confident({confidence: 'medium'}),
      confident({timeRange: {startNs: 1, endNs: 2}})].map(result => register(result, store).evidence!.evidenceRefId);
    expect(new Set(locators).size).toBe(locators.length);
  });

  it.each([
    ['an ambiguous ranking', confident({confidence: 'ambiguous', primaryApp: undefined})],
    ['a primary without confidence', confident({confidence: undefined})],
    ['no primary app', confident({primaryApp: undefined})],
    ['no detection at all', undefined],
  ])('registers nothing and issues no locator for %s', (_label, focusResult) => {
    const store = {registerStandaloneEvidenceCapture: jest.fn(() => true)};
    const target = register(focusResult, store as unknown as ArtifactStore);
    expect(target.evidence).toBeUndefined();
    expect(buildFocusAppPromptData(target)?.evidence).toBeUndefined();
    expect(store.registerStandaloneEvidenceCapture).not.toHaveBeenCalled();
  });

  it('returns the target unchanged when the store refuses the capture', () => {
    const store = {registerStandaloneEvidenceCapture: jest.fn(() => false)};
    const focusResult = confident();
    const focusTarget = resolveFocusAppTarget({focusResult});
    expect(registerFocusAppEvidence({store: store as unknown as ArtifactStore, traceId: 'trace', focusResult, focusTarget}))
      .toBe(focusTarget);
  });
});
