// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {createDataEnvelope, type DataEnvelope} from '../../../types/dataContract';
import {parseTypedConclusionContractJson} from '../../../agent/core/conclusionContract';
import {ArtifactStore} from '../../../agentv3/artifactStore';
import {resolveTraceCase} from '../../../../tests/helpers/traceCorpus';
import {SkillEvaluator} from '../../../../tests/skill-eval/runner';
import {buildTraceProcessorQueryProvenance} from '../../traceProcessorConnectionModel';
import {runClaimVerification} from '../../verifier/claimVerificationRunner';
import {buildEvidenceContract} from '../evidenceContractBuilder';
import {capturedEvidenceTable, evidenceTableFor} from '../evidenceCapture';
import {evidenceReferenceKey, prepareClaimEvidence} from '../claimEvidencePreparation';
import {produceStartupRelationCandidates} from '../startupRelationCandidateProducer';

function envelope(traceId: string, stepId: string, rows: Record<string, unknown>[]): DataEnvelope {
  return createDataEnvelope({rows: rows as any}, {
    type: 'skill_result',
    source: 'startup_analysis',
    title: stepId,
    skillId: 'startup_analysis',
    stepId,
    executionStatus: rows.length > 0 ? 'observed' : 'empty',
    evidenceRefId: `data:real:${stepId}`,
    sourceToolCallId: `invoke_skill:real:${stepId}`,
    traceId,
    traceSide: 'current',
  });
}

describe('startupRelationCandidateProducer real trace', () => {
  it('keeps real startup/Binder overlap candidate while proving a captured startup duration', async () => {
    const evaluator = new SkillEvaluator('startup_analysis');
    try {
      await evaluator.loadTrace(resolveTraceCase('android-startup-light'));
      // The evaluator exposes row projections publicly; read its actual loaded
      // trace ID here instead of substituting the corpus selector as provenance.
      const traceId = (evaluator as unknown as {traceId: string}).traceId;
      expect(typeof traceId).toBe('string');
      expect(traceId.length).toBeGreaterThan(0);
      const [startups, quality, binders] = await evaluator.executeStepSequence([
        'get_startups',
        'startup_quality',
        'main_thread_binder_blocking',
      ], {package: '', analysis_mode: 'full'});
      expect(startups.success).toBe(true);
      expect(quality.success).toBe(true);
      expect(binders.success).toBe(true);

      const dataEnvelopes = [
        envelope(traceId, 'get_startups', startups.data),
        envelope(traceId, 'main_thread_binder_blocking', binders.data),
      ];
      const candidates = produceStartupRelationCandidates(dataEnvelopes);
      const evidence = buildEvidenceContract({dataEnvelopes, relationCandidates: candidates});

      if (binders.data.length > 0) {
        expect(candidates.length).toBeGreaterThan(0);
        expect(evidence.relations).toHaveLength(candidates.length);
        for (const [index, candidate] of candidates.entries()) {
          const startup = startups.data[candidate.subject.rowIndex!];
          const binder = binders.data[candidate.object!.rowIndex!];
          for (const value of [startup.start_ts, startup.end_ts, binder.ts_str, binder.dur_str]) {
            expect(value).toMatch(/^(0|[1-9][0-9]*)$/);
          }
          const startupStart = BigInt(startup.start_ts);
          const startupEnd = BigInt(startup.end_ts);
          const binderStart = BigInt(binder.ts_str);
          const binderEnd = binderStart + BigInt(binder.dur_str);
          const overlapStart = startupStart > binderStart ? startupStart : binderStart;
          const overlapEnd = startupEnd < binderEnd ? startupEnd : binderEnd;
          expect(overlapEnd - overlapStart).toBeGreaterThan(0n);
          const relation = evidence.relations[index];
          expect(evidence.anchors.find(anchor => anchor.anchorId === relation.subjectAnchorId)?.timeRange).toEqual({
            startTs: startup.start_ts, endTs: startup.end_ts, unit: 'ns', source: 'row',
          });
          expect(evidence.anchors.find(anchor => anchor.anchorId === relation.objectAnchorId)?.timeRange).toEqual({
            startTs: binder.ts_str, endTs: String(binderEnd), unit: 'ns', source: 'row',
          });
          expect(relation).toEqual(expect.objectContaining({
            kind: 'overlap', verificationStatus: 'candidate', supportLevel: 'inference', reasonCode: 'overlap_range_missing',
          }));
        }
      } else {
        expect(candidates).toEqual([]);
        expect(evidence.relations).toEqual([]);
      }

      const deterministicPositive = [
        envelope(traceId, 'get_startups', [{start_ts: '10', end_ts: '100'}]),
        envelope(traceId, 'main_thread_binder_blocking', [{ts_str: '20', dur_str: '10'}]),
      ];
      const positiveCandidates = produceStartupRelationCandidates(deterministicPositive);
      expect(buildEvidenceContract({
        dataEnvelopes: deterministicPositive,
        relationCandidates: positiveCandidates,
      }).relations).toEqual([
        expect.objectContaining({kind: 'overlap', verificationStatus: 'candidate', reasonCode: 'overlap_range_missing'}),
      ]);
      expect(produceStartupRelationCandidates([
        envelope(traceId, 'get_startups', [{start_ts: '10', end_ts: '20'}]),
        envelope(traceId, 'main_thread_binder_blocking', [{ts_str: '20', dur_str: '10'}]),
      ])).toEqual([]);

      // Use the original atomic execution witness and literal YAML unit. No
      // ordinary row or display timestamp can manufacture interval clock proof.
      await evaluator.selectSkill('startup_events_in_range');
      const runtime = await evaluator.executeRuntimeSkill({package: ''});
      expect(runtime).toEqual(expect.objectContaining({success: true}));
      const root = runtime.rawResults?.root;
      expect(root?.success).toBe(true);
      const witness = root && evidenceTableFor(root);
      expect(witness).toBeDefined();
      const table = capturedEvidenceTable(witness!);
      expect(table).toBeDefined();
      expect(table!.unavailableReason).toBeUndefined();
      expect(table!.rows.length).toBeGreaterThan(0);
      expect(table!.fields.dur_ns).toEqual(expect.objectContaining({
        unit: 'ns', origin: expect.objectContaining({kind: 'skill_literal', skillId: 'startup_events_in_range', stepId: 'root'}),
      }));
      expect(Object.values(table!.fields).every(field => field.timeRole === undefined && field.clock === undefined)).toBe(true);
      const row = Object.fromEntries(table!.columns.map((column, index) => [column, table!.rows[0][index]]));
      for (const value of [row.start_ts, row.end_ts, row.dur_ns]) expect(value).toMatch(/^(0|[1-9][0-9]*)$/);
      expect(BigInt(row.dur_ns as string)).toBe(BigInt(row.end_ts as string) - BigInt(row.start_ts as string));
      expect(BigInt(row.dur_ns as string)).toBeGreaterThan(0n);

      const store = new ArtifactStore();
      const artifactId = store.store({skillId: runtime.skillId, stepId: 'root', data: root!.data,
        scopeProvenance: root!.scopeProvenance, identityResolution: runtime.identityResolution,
        sourceToolCallId: 'invoke_skill:real:startup_duration',
        traceProvenance: buildTraceProcessorQueryProvenance({traceId, traceSide: 'current'}),
      });
      expect(store.registerEvidenceCapture(artifactId, witness!, {evidenceRefId: 'data:real:startup_duration'})).toBe(true);
      const view = store.createEvidenceReadView({ownerKey: 'startup-relation-real-test', allowedTraces: [{traceId, traceSide: 'current'}]});
      const reference = {artifactId, rowIndex: 0, column: 'dur_ns', value: row.dur_ns as string};
      const [resolved] = await view.resolveReferences([{key: evidenceReferenceKey(reference), reference, requiredColumns: ['dur_ns']}]);
      expect(resolved).toMatchObject({status: 'resolved', originalRowIndex: 0, row: {dur_ns: row.dur_ns},
        record: {captureId: witness!.captureId, meta: {traceId, traceSide: 'current'}}});
      const declaration = parseTypedConclusionContractJson(JSON.stringify({
        schemaVersion: 'conclusion_contract_v1', mode: 'focused_answer', conclusions: [], clusters: [], evidenceChain: [],
        uncertainties: [], nextSteps: [], claims: [{id: 'startup-duration', kind: 'numeric', text: 'The captured startup duration is positive.',
          references: [reference], semantics: {schemaVersion: 'claim_semantics@1', predicate: 'numeric.cell',
            discourse: 'asserted', polarity: 'affirmed', modality: 'certain', quantifier: 'one',
            scope: {population: 'cited_rows', subjectRefs: [reference]}, numeric: {operator: 'gt', value: 0, unit: 'ns'},
          },
        }],
      }));
      expect(declaration.status).toBe('valid');
      expect(declaration.bindingEligibility).toBe('eligible');
      const preparedEvidence = await prepareClaimEvidence({conclusionContract: declaration.contract,
        bindingEligibility: declaration.bindingEligibility, evidenceReadView: view});
      const verified = runClaimVerification({conclusionContract: declaration.contract, preparedEvidence});
      expect(verified.claimVerificationResult.claimResults).toEqual([
        expect.objectContaining({claimId: 'startup-duration', referenceCells: [expect.objectContaining({status: 'matched'})],
          deterministicProof: expect.objectContaining({kind: 'numeric_cell', status: 'proved', reason: 'numeric_operator_proved'})}),
      ]);
      expect(verified.evidenceContract.relations).toEqual([]);
    } finally {
      await evaluator.cleanup();
    }
  }, 120_000);
});
