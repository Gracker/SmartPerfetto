// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {describe, it, expect} from '@jest/globals';
import fs from 'fs';
import path from 'path';
import ts from 'typescript';
import {
  ANALYSIS_COMPLETED_PUBLIC_TYPE_PATHS,
  analysisCompletedContractFragment,
  analysisCompletedPublicTypeFragment,
  conclusionContractFragment,
  criticalPathContractFragment,
} from '../../../scripts/frontendContractFragments';
import {CRITICAL_PATH_HINT_CODES, CRITICAL_PATH_MODULE_IDS} from '../criticalPathContract';
import {
  buildColumnDefinitions,
  createDataEnvelope,
  displayResultToEnvelope,
  envelopeToDisplayResult,
  inferColumnDefinition,
  validateDataEnvelope,
  type AnalysisCompletedEvent,
} from '../dataContract';
import {copyScopeProvenance, identityForScopeEvidence, mergeScopeProvenance, outsideTargetScopeFields, scopeMetadata,
  scopeProvenanceForFields, type EvidenceScopeProvenanceV1, type IdentityResolutionV1} from '../identityContract';

describe('DataEnvelope process scope provenance', () => {
  const provenance: EvidenceScopeProvenanceV1 = { version: 'process_scope_evidence@1', entries: [
    { role: 'target', scope: { mode: 'exact_upid', traceId: 'trace', traceSide: 'current', upid: 42 }, fields: ['frames'] },
    { role: 'global_context', scope: { mode: 'unscoped', traceId: 'trace', traceSide: 'current' }, fields: ['refresh_rate'] },
  ] };
  it('roundtrips mixed field roles without claiming that the entire table is exact target evidence', () => {
    const envelope = displayResultToEnvelope({ stepId: 'mixed', title: 'Mixed', level: 'summary', layer: 'overview',
      format: 'table', data: { columns: ['frames', 'refresh_rate'], rows: [[3, 60]] }, scopeProvenance: provenance }, 'skill');
    expect(envelope.meta.evidenceRole).toBe('mixed');
    expect(envelope.meta.appliedProcessScope).toBeUndefined();
    expect(envelopeToDisplayResult(envelope).scopeProvenance).toEqual(provenance);
    expect(validateDataEnvelope(envelope)).toEqual([]);
    envelope.meta.traceId = 'other-trace';
    expect(validateDataEnvelope(envelope)).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: 'meta.scopeProvenance' }),
    ]));
  });

  const invalidMarker: EvidenceScopeProvenanceV1 = {version: 'process_scope_evidence@1', entries: [], invalid: true};
  const identity: IdentityResolutionV1 = {version: 'identity_contract@1', identityRefId: 'identity:42',
    target: {traceId: 'trace', traceSide: 'current', upid: 42, source: 'skill_param'},
    status: 'verified', processes: [], threads: [], warnings: []};
  const scopedEntry = {...provenance.entries[0], scope: {...provenance.entries[0].scope, identityRefId: identity.identityRefId}};
  const malformedEntries: Array<[string, unknown]> = [
    ['fields string', {...scopedEntry, fields: 'frames'}],
    ['mixed field values', {...scopedEntry, fields: ['frames', 7]}],
    ['empty field name', {...scopedEntry, fields: ['frames', ' ']}],
    ['bad availability', {...scopedEntry, availability: 'maybe'}],
    ['bad relative scope', {...scopedEntry, relativeTo: {mode: 'exact_upid'}}],
    ['cross-trace relative scope', {...scopedEntry, relativeTo: {...scopedEntry.scope, traceId: 'other'}}],
    ['bad role', {...scopedEntry, role: 'other'}],
    ['empty trace id', {...scopedEntry, scope: {...scopedEntry.scope, traceId: ''}}],
    ['bad trace side', {...scopedEntry, scope: {...scopedEntry.scope, traceSide: 'other'}}],
    ['bad upid', {...scopedEntry, scope: {...scopedEntry.scope, upid: 0}}],
    ['named without name', {...scopedEntry, scope: {mode: 'named', traceId: 'trace', traceSide: 'current'}}],
    ['unscoped with upid', {...scopedEntry, scope: {...scopedEntry.scope, mode: 'unscoped'}}],
    ['null source step', {...scopedEntry, sourceStepId: null}],
    ['empty identity ref', {...scopedEntry, scope: {...scopedEntry.scope, identityRefId: ''}}],
    ['bad reason', {...scopedEntry, reason: 7}],
    ['unknown property', {...scopedEntry, field: 'frames'}],
  ];

  it.each(malformedEntries)('retains invalid %s through raw validation, construction and projections', (_label, entry) => {
    // A valid first entry must not survive by silently dropping a later bad one.
    const malformed = {version: 'process_scope_evidence@1', entries: [scopedEntry, entry]} as EvidenceScopeProvenanceV1;
    const raw = createDataEnvelope({columns: ['frames'], rows: [[3]]}, {type: 'skill_result', source: 'test', title: 'Scope'});
    raw.meta.scopeProvenance = malformed;
    expect(validateDataEnvelope(raw)).toEqual(expect.arrayContaining([expect.objectContaining({path: 'meta.scopeProvenance'})]));
    const built = createDataEnvelope(raw.data, {type: 'skill_result', source: 'test', title: 'Scope',
      scopeProvenance: malformed, identityResolution: identity});
    expect(built.meta.scopeProvenance).toEqual(invalidMarker);
    expect(built.meta.appliedProcessScope).toBeUndefined();
    expect(built.meta.evidenceRole).toBeUndefined();
    const restored = JSON.parse(JSON.stringify(built));
    expect(envelopeToDisplayResult(restored).scopeProvenance).toEqual(invalidMarker);
    expect(validateDataEnvelope(restored)).toEqual(expect.arrayContaining([expect.objectContaining({path: 'meta.scopeProvenance'})]));
    expect(mergeScopeProvenance([provenance, malformed])).toEqual(invalidMarker);
    expect(scopeProvenanceForFields(malformed, ['frames'])).toEqual(invalidMarker);
    expect(identityForScopeEvidence(malformed, identity)).toBeUndefined();
    expect(identityForScopeEvidence(restored.meta.scopeProvenance, identity)).toBeUndefined();
    expect({...scopeMetadata({version: 'process_scope_evidence@1', entries: [scopedEntry]}),
      ...scopeMetadata(malformed)}.appliedProcessScope).toBeUndefined();
  });

  it.each([null, {}, {version: 'other', entries: []}, {version: 'process_scope_evidence@1', entries: 'bad'},
    {version: 'process_scope_evidence@1', entries: [], invalid: false}])('keeps present malformed metadata distinct from absence: %j', malformed => {
    expect(copyScopeProvenance(malformed)).toEqual(invalidMarker);
    expect(mergeScopeProvenance([undefined, malformed])).toEqual(invalidMarker);
    expect(identityForScopeEvidence(malformed, identity)).toBeUndefined();
  });

  it('preserves valid field intersections and explicit empty scope without legacy fallback', () => {
    const global = scopeProvenanceForFields(provenance, ['refresh_rate']);
    expect(global?.entries).toEqual([provenance.entries[1]]);
    expect(identityForScopeEvidence(global, identity)).toBeUndefined();
    const empty = scopeProvenanceForFields(provenance, ['unknown']);
    expect(empty).toEqual({version: 'process_scope_evidence@1', entries: []});
    expect(mergeScopeProvenance([empty, undefined])).toEqual(empty);
    expect(scopeMetadata(empty).evidenceRole).toBeUndefined();
    expect(identityForScopeEvidence(empty, identity)).toBeUndefined();
    expect(identityForScopeEvidence(undefined, identity)).toBe(identity);
    expect(copyScopeProvenance(undefined)).toBeUndefined();
    expect(scopeMetadata({version: 'process_scope_evidence@1', entries: [{...scopedEntry, fields: []}]}).appliedProcessScope).toBeUndefined();
    expect(copyScopeProvenance({version: 'process_scope_evidence@1', entries: [{...scopedEntry, reason: undefined}]}))
      .toEqual({version: 'process_scope_evidence@1', entries: [scopedEntry]});
  });

  it('marks a field outside the target only from a positive non-target declaration', () => {
    const outsideTarget = outsideTargetScopeFields(provenance);
    expect(outsideTarget('frames')).toBe(false);
    expect(outsideTarget('refresh_rate')).toBe(true);
    const peer = {...provenance.entries[1], role: 'peer_context' as const, fields: undefined};
    expect(outsideTargetScopeFields({version: provenance.version, entries: [peer]})('any_field')).toBe(true);
    // Legacy and unlisted fields keep their old reading; invalid provenance asserts nothing.
    expect(outsideTargetScopeFields(undefined)('frames')).toBe(false);
    expect(outsideTarget('unknown')).toBe(false);
    expect(outsideTargetScopeFields({version: 'process_scope_evidence@1', entries: 'bad'})('frames')).toBe(false);
  });
});

describe('dataContract column inference', () => {
  it('accepts historical omissions and the full finalized public event metadata', () => {
    const candidate = {runId: 'run', attemptId: 'attempt', candidateRef: 'candidate', conclusionFingerprint: 'body-fingerprint'};
    const historical: AnalysisCompletedEvent['data'] = {findings: []};
    const current: AnalysisCompletedEvent['data'] = {
      findings: [], success: false, terminalRunStatus: 'failed', conclusion: 'Original body',
      turnIntent: {schemaVersion: 1, status: 'unavailable', source: 'fallback', registryFingerprint: 'registry',
        taskKind: 'investigation', sceneId: 'general', scope: 'bounded_question', recommendedComplexity: 'quick',
        deliverable: 'answer', evidenceAccess: 'existing_only'},
      completion: {...candidate, schemaVersion: 1, runtimeKind: 'openai-agents-sdk', status: 'failed', reason: 'provider_error'},
      outputOrigin: 'sdk_final',
      runtimeAppendix: {schemaVersion: 1, origin: 'runtime_fallback', sourceCandidate: candidate, text: 'Runtime note'},
      reportAssessment: {schemaVersion: 1, binding: {...candidate, conclusionContractFingerprint: 'contract',
        evidenceFingerprint: 'evidence', requirementsFingerprint: 'requirements', registryFingerprint: 'registry',
        intentFingerprint: 'intent'}, status: 'not_checked', requirements: []},
      deliveryAssurance: {schemaVersion: 1, entry: 'new_finalization', completion: 'failed', claims: 'not_checked',
        source: 'not_applicable', identity: 'not_applicable', report: 'not_checked'},
      sourceUseDecision: {schemaVersion: 'source_use_decision@1', codeAwareMode: 'metadata_only', status: 'pending',
        selectedCodebaseIds: ['source'], queriedCodebaseIds: [], usedCodebaseIds: [], attemptedTools: [], references: []},
      sourceClaimVerificationResult: {schemaVersion: 'source_claim_verifier@1', status: 'not_checked', bindings: [], issues: []},
    };
    expect(JSON.parse(JSON.stringify(historical))).toEqual({findings: []});
    expect(JSON.parse(JSON.stringify(current))).toEqual(current);
    const cancelled: AnalysisCompletedEvent['data'] = {findings: [], terminalRunStatus: 'cancelled'};
    expect(cancelled.terminalRunStatus).toBe('cancelled');
  });

  it('generates only reachable public type declarations and resolves their constant type queries', () => {
    const source = fs.readFileSync(path.resolve(__dirname, '../dataContract.ts'), 'utf8');
    const fragment = analysisCompletedPublicTypeFragment(source, ANALYSIS_COMPLETED_PUBLIC_TYPE_PATHS.map(sourcePath =>
      fs.readFileSync(path.resolve(__dirname, '../../', sourcePath), 'utf8')));
    const parsed = ts.createSourceFile('public-types.ts', fragment, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    expect(parsed.statements.every(statement => ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement))).toBe(true);
    const names = parsed.statements.map(statement => (statement as ts.InterfaceDeclaration).name.text);
    expect(names).toEqual(expect.arrayContaining(['AnalysisTurnIntent', 'AnalysisCompletion', 'AgentRuntimeKind',
      'AnalysisCandidateIdentity', 'AnalysisReportBinding', 'AnalysisReportRequirementAssessment',
      'AnalysisDeliveryAssurance', 'SourceUseDecisionV1', 'SourceClaimVerificationResult', 'SourceClaimBindingV1',
      'StoredSourceClaimVerificationResult', 'LegacySourceClaimVerificationResultV1', 'SourceCitationV1']));
    expect(names).not.toEqual(expect.arrayContaining(['CurrentAnalysisDeliveryContext']));
    expect(fragment).not.toContain('typeof ');
    expect(fragment).not.toContain('WeakMap');
    expect(fragment).not.toContain('node:');
    const event = analysisCompletedContractFragment(source);
    expect(event).not.toContain('import(');
    expect(event).toContain('completion?: AnalysisCompletion;');
    // A replayed historical event may carry a result stored before claims were judged per claim.
    expect(event).toContain('sourceClaimVerificationResult?: StoredSourceClaimVerificationResult;');
  });

  it('spells out const-backed unions and drops private helpers in the contract fragments', () => {
    const criticalPath = criticalPathContractFragment(
      fs.readFileSync(path.resolve(__dirname, '../criticalPathContract.ts'), 'utf8'));
    expect(criticalPath).not.toContain('typeof ');
    expect(criticalPath).not.toMatch(/export const /);
    expect(criticalPath).toContain(`export type CriticalPathModuleId = ${CRITICAL_PATH_MODULE_IDS.map(id => `'${id}'`).join(' | ')};`);
    expect(criticalPath).toContain(`export type CriticalPathHintCode = ${CRITICAL_PATH_HINT_CODES.map(id => `'${id}'`).join(' | ')};`);
    expect(criticalPath).toContain('export interface CriticalPathAnalyzeResponse {');

    const conclusion = conclusionContractFragment(
      fs.readFileSync(path.resolve(__dirname, '../../agent/core/conclusionContract.ts'), 'utf8'));
    expect(conclusion).not.toContain('typeof ');
    expect(conclusion).toMatch(/export type ConclusionClaimDiagnosticCode = 'invalid_claim' \| /);
    expect(conclusion).toMatch(/export type ConclusionClaimDiagnosticField =\s+'claim' \| /);
    // A module-private parser helper has no reader in the frontend.
    expect(conclusion).not.toContain('ClaimSemanticsResult');

    expect(() => criticalPathContractFragment('export type Broken = (typeof MISSING)[number];'))
      .toThrow('MISSING is not a declared string list or table');
  });

  it('infers start timestamp columns as range-navigable', () => {
    const start = inferColumnDefinition('start_ts');

    expect(start.type).toBe('timestamp');
    expect(start.clickAction).toBe('navigate_range');
    expect(start.durationColumn).toBe('dur_str');
    expect(start.unit).toBe('ns');
  });

  it('infers end timestamp columns as point-navigable', () => {
    const end = inferColumnDefinition('end_ts');

    expect(end.type).toBe('timestamp');
    expect(end.clickAction).toBe('navigate_timeline');
    expect(end.durationColumn).toBeUndefined();
    expect(end.unit).toBe('ns');
  });

  it('infers explicit duration suffix units correctly', () => {
    const durMs = inferColumnDefinition('dur_ms');
    const durUs = inferColumnDefinition('dur_us');
    const durNs = inferColumnDefinition('dur_ns');

    expect(durMs.type).toBe('duration');
    expect(durMs.format).toBe('duration_ms');
    expect(durMs.unit).toBe('ms');

    expect(durUs.type).toBe('duration');
    expect(durUs.format).toBe('duration_ms');
    expect(durUs.unit).toBe('us');

    expect(durNs.type).toBe('duration');
    expect(durNs.format).toBe('duration_ms');
    expect(durNs.unit).toBe('ns');
  });

  it('does not misclassify refresh_rate as percentage', () => {
    const refreshRate = inferColumnDefinition('refresh_rate');

    expect(refreshRate.type).not.toBe('percentage');
  });

  it('normalizes invalid display values when creating envelopes', () => {
    const env = createDataEnvelope(
      {columns: ['value'], rows: [[1]]},
      {
        type: 'skill_result',
        source: 'test:rows',
        title: 'Rows',
        layer: 'duration' as any,
        format: 'detail' as any,
        level: 'list' as any,
      },
    );

    expect(env.display.layer).toBe('list');
    expect(env.display.format).toBe('table');
    expect(env.display.level).toBe('detail');
    expect(validateDataEnvelope(env)).toEqual([]);
  });

  it('keeps stable evidence and trace metadata on created envelopes', () => {
    const env = createDataEnvelope(
      {columns: ['value'], rows: [[1]]},
      {
        type: 'sql_result',
        source: 'execute_sql',
        title: 'Rows',
        evidenceRefId: 'data:sql:current:trace_hash:query_hash',
        traceSide: 'current',
        traceId: 'trace-a',
        queryHash: 'query_hash',
        sourceToolCallId: 'execute_sql:1:params_hash',
        paramsHash: 'params_hash',
        planPhaseId: 'phase-1',
        planPhaseTitle: 'Collect evidence',
        planPhaseGoal: 'Query frame stats',
        planPhaseAttribution: 'active',
        planPhaseWarning: 'phase matched',
        toolNarration: '执行 SQL：查询帧数据',
        producerReason: '验证本阶段帧耗时数据',
        intent: 'ad_hoc_sql_verification',
      },
    );

    expect(env.meta).toEqual(expect.objectContaining({
      evidenceRefId: 'data:sql:current:trace_hash:query_hash',
      traceSide: 'current',
      traceId: 'trace-a',
      queryHash: 'query_hash',
      sourceToolCallId: 'execute_sql:1:params_hash',
      paramsHash: 'params_hash',
      planPhaseId: 'phase-1',
      planPhaseTitle: 'Collect evidence',
      planPhaseGoal: 'Query frame stats',
      planPhaseAttribution: 'active',
      planPhaseWarning: 'phase matched',
      toolNarration: '执行 SQL：查询帧数据',
      producerReason: '验证本阶段帧耗时数据',
      intent: 'ad_hoc_sql_verification',
    }));
    expect(validateDataEnvelope(env)).toEqual([]);
  });

  it('sanitizes invalid explicit column definitions before DataEnvelope output', () => {
    const columns = buildColumnDefinitions(['ts', 'value'], [
      {
        name: 'ts',
        type: 'bad_type' as any,
        format: 'bad_format' as any,
        clickAction: 'bad_action' as any,
        unit: 'frames' as any,
        width: 'giant' as any,
      },
      {
        name: 'value',
        type: 'number',
        width: 'narrow',
      },
    ]);

    expect(columns[0]).toMatchObject({
      name: 'ts',
      type: 'timestamp',
      format: 'timestamp_relative',
      clickAction: 'navigate_range',
      unit: 'ns',
    });
    expect((columns[0] as any).width).toBeUndefined();
    expect(columns[1]).toMatchObject({
      name: 'value',
      type: 'number',
      width: 'narrow',
    });
  });

  it('keeps DisplayResult to DataEnvelope conversion valid even with invalid display metadata', () => {
    const env = displayResultToEnvelope({
      stepId: 'rows',
      title: 'Rows',
      layer: 'bytes' as any,
      level: 'overview' as any,
      format: 'detail' as any,
      data: {columns: ['ts'], rows: [[123]]},
      columnDefinitions: [
        {
          name: 'ts',
          type: 'bad_type',
          format: 'bad_format',
          clickAction: 'bad_action',
        },
      ],
      metadataConfig: {fields: ['process_name', 123]},
    } as any, 'test_skill', undefined);

    expect(env.display.layer).toBe('list');
    expect(env.display.format).toBe('table');
    expect(env.display.level).toBe('detail');
    expect(env.display.metadataFields).toEqual(['process_name']);
    expect(validateDataEnvelope(env)).toEqual([]);
  });

  it('rejects malformed display columns and metadata fields during validation', () => {
    const env = createDataEnvelope(
      {columns: ['value'], rows: [[1]]},
      {
        type: 'skill_result',
        source: 'test:rows',
        title: 'Rows',
      },
    );

    (env.display as any).columns = {name: 'value'};
    (env.display as any).metadataFields = ['process_name', 42];

    const errors = validateDataEnvelope(env);
    expect(errors.map(error => error.path)).toEqual(
      expect.arrayContaining(['display.columns', 'display.metadataFields[1]']),
    );
  });
});

describe('dataContract envelope validation', () => {
  const makeValidEnvelope = () => createDataEnvelope(
    {columns: ['value'], rows: [[1]]},
    {
      type: 'skill_result',
      source: 'test:validation',
      title: 'Validation rows',
    },
  );

  it.each([null, undefined, false, true, 42, 'envelope', []])(
    'rejects non-object envelope input %# without throwing',
    (value) => {
      expect(validateDataEnvelope(value)).toEqual([
        expect.objectContaining({path: ''}),
      ]);
    },
  );

  it.each([
    ['meta', null],
    ['meta', []],
    ['meta', 'metadata'],
    ['meta', 1],
    ['meta', true],
    ['display', null],
    ['display', []],
    ['display', 'display'],
    ['display', 1],
    ['display', true],
  ])('rejects non-object %s containers', (field, value) => {
    const envelope = makeValidEnvelope() as any;
    envelope[field] = value;

    expect(validateDataEnvelope(envelope)).toEqual(
      expect.arrayContaining([expect.objectContaining({path: field})]),
    );
  });

  it.each(['skill_result', 'sql_result', 'ai_response', 'diagnostic', 'chart'])(
    'accepts the supported meta.type value %s',
    (type) => {
      const envelope = makeValidEnvelope() as any;
      envelope.meta.type = type;

      expect(validateDataEnvelope(envelope)).toEqual([]);
    },
  );

  it.each(['unknown_result', '', 1, null])(
    'rejects meta.type value outside the DataEnvelope union: %p',
    (type) => {
      const envelope = makeValidEnvelope() as any;
      envelope.meta.type = type;

      expect(validateDataEnvelope(envelope)).toEqual(
        expect.arrayContaining([expect.objectContaining({path: 'meta.type'})]),
      );
    },
  );

  it.each([
    ['meta.source', 'source', ''],
    ['meta.source', 'source', '   '],
    ['meta.source', 'source', 7],
    ['meta.source', 'source', null],
    ['meta.version', 'version', ''],
    ['meta.version', 'version', '   '],
    ['meta.version', 'version', 2],
    ['meta.version', 'version', null],
    ['display.title', 'title', ''],
    ['display.title', 'title', '   '],
    ['display.title', 'title', 9],
    ['display.title', 'title', null],
  ])('rejects non-string or blank %s', (pathName, field, value) => {
    const envelope = makeValidEnvelope() as any;
    const container = pathName.startsWith('meta.') ? envelope.meta : envelope.display;
    container[field] = value;

    expect(validateDataEnvelope(envelope)).toEqual(
      expect.arrayContaining([expect.objectContaining({path: pathName})]),
    );
  });

  it.each([-1, Number.NaN, Number.POSITIVE_INFINITY, '0', null, undefined])(
    'rejects invalid meta.timestamp value %p',
    (timestamp) => {
      const envelope = makeValidEnvelope() as any;
      envelope.meta.timestamp = timestamp;

      expect(validateDataEnvelope(envelope)).toEqual(
        expect.arrayContaining([expect.objectContaining({path: 'meta.timestamp'})]),
      );
    },
  );

  it('accepts zero as a valid meta.timestamp', () => {
    const envelope = makeValidEnvelope();
    envelope.meta.timestamp = 0;

    expect(validateDataEnvelope(envelope)).toEqual([]);
  });

  it.each([null, undefined, [], 'payload', 1, true])(
    'rejects non-object data payload %p',
    (data) => {
      const envelope = makeValidEnvelope() as any;
      envelope.data = data;

      expect(validateDataEnvelope(envelope)).toEqual(
        expect.arrayContaining([expect.objectContaining({path: 'data'})]),
      );
    },
  );
});
