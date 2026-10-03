// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {afterAll, afterEach, beforeAll, describe, expect, it, jest} from '@jest/globals';
import {EventEmitter} from 'events';
import express from 'express';
import fs from 'fs';
import os from 'os';
import path from 'path';
import request from 'supertest';
import ts from 'typescript';
import agentRoutes, {
  agentRoutesPrivacyProjectionTestSeam,
  agentRoutesReceiptTestSeam,
  agentRoutesCancellationTestSeam,
} from '../agentRoutes';
import {
  clearCodeAwareOutputGuards,
  registerCodeAwareCanary,
  sanitizeCodeAwareText,
} from '../../services/security/codeAwareOutputRegistry';
import {ENTERPRISE_FEATURE_FLAG_ENV} from '../../config';
import {ENTERPRISE_DB_PATH_ENV, openEnterpriseDb} from '../../services/enterpriseDb';
import {resetAnalysisRunStoreForTests} from '../../services/analysisRunStore';
import {resetAgentEventStoreForTests} from '../../services/agentEventStore';
import {routeAdaptiveEvidencePreflight} from '../../agentRuntime/adaptiveEvidenceRouter';
import {createDataEnvelope} from '../../types/dataContract';
import * as claimPreparation from '../../services/evidence/analysisRelationPreparation';
import * as qualityGate from '../../services/finalResultQualityGate';
import * as finalizer from '../../services/finalizeAnalysisResult';
import * as reportRoutes from '../reportRoutes';
import * as snapshots from '../../services/analysisResultSnapshotPipeline';
import * as eventStore from '../../services/agentEventStore';
import * as traceMetadataStore from '../../services/traceMetadataStore';
import {SessionPersistenceService} from '../../services/sessionPersistenceService';
import {registerAgentReportRoutes} from '../agentReportRoutes';
import {analysisDeliveryFingerprint} from '../../types/analysisDelivery';

const sessionId = 'private-route-projection';

function completedSnapshotInputFromRoute(): ts.ObjectLiteralExpression | undefined {
  const routePath = path.resolve(__dirname, '../agentRoutes.ts');
  const sourceText = fs.readFileSync(routePath, 'utf8');
  const sourceFile = ts.createSourceFile(
    routePath,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const finalizer = sourceFile.statements.find(
    (statement): statement is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(statement) &&
      statement.name?.text === 'ensureCompletedAnalysisFinalArtifacts',
  );
  if (!finalizer) return undefined;

  let snapshotInput: ts.ObjectLiteralExpression | undefined;
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'persistCompletedAnalysisResultSnapshot' &&
      ts.isObjectLiteralExpression(node.arguments[0])
    ) {
      snapshotInput = node.arguments[0];
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(finalizer);
  return snapshotInput;
}

afterEach(() => {clearCodeAwareOutputGuards(sessionId); jest.restoreAllMocks();});

describe('agent route private projections', () => {
  it.each([false, true])('uses native completion and delivery state consistently in SSE, turn history and report (qualityFailure=%s)', qualityFailure => {
    const conclusion = 'The original completed candidate remains available.';
    const result = {sessionId, success: !qualityFailure, conclusion, findings: [], hypotheses: [], confidence: 0.8,
      rounds: 1, totalDurationMs: 1, terminationMessage: qualityFailure ? 'The current claim is not supported by trace evidence.' : 'PRIVATE_DISCARDED_ATTEMPT_ERROR',
      ...(qualityFailure ? {partial: true, terminationReason: 'quality_gate_failed' as const} : {}),
      completion: {schemaVersion: 1 as const, runtimeKind: 'openai-agents-sdk' as const, status: 'completed' as const,
        runId: 'termination-run', attemptId: 'attempt-original', candidateRef: 'candidate-original',
        conclusionFingerprint: analysisDeliveryFingerprint(conclusion)}};
    const session = {sessionId, traceId: 'trace', query: 'original query', status: 'completed', createdAt: 1,
      tenantId: 'tenant', workspaceId: 'workspace', userId: 'user', codeAwareMode: 'provider_send', codebaseIds: ['app'],
      outputLanguage: 'en', result, hypotheses: [], dataEnvelopes: [], scenes: [],
      completedAnalysisFinalArtifacts: {}, logger: {warn: () => {}}, runSequence: 1} as any;
    const events = agentRoutesPrivacyProjectionTestSeam.ensureCompletedAnalysisSseEvents(session);
    const completed = events.find(event => event.eventType === 'analysis_completed');
    expect(completed).toBeDefined();
    const payload = JSON.parse(completed!.eventData).data;
    const turn = agentRoutesPrivacyProjectionTestSeam.buildTurnSummary({id: 'turn', turnIndex: 1, timestamp: 1,
      query: 'original query', completed: true, result: {...result, message: conclusion}} as any, sessionId, 'en');
    const get = jest.fn();
    registerAgentReportRoutes({get} as any, {getSession: () => session, recoverResultForSessionIfNeeded: () => result,
      buildClientFindings: () => [], buildSessionResultContract: () => ({})});
    const response = {json: jest.fn(), status: jest.fn().mockReturnThis()};
    const handler = get.mock.calls[0][1] as (req: any, res: any) => void;
    handler({params: {sessionId}, requestContext: {tenantId: 'tenant', workspaceId: 'workspace', userId: 'user'}}, response);
    const report = (response.json.mock.calls[0][0] as any).report;
    for (const message of [payload.terminationMessage, turn.terminationMessage, report.summary.terminationMessage]) {
      if (qualityFailure) expect(message).toBe('The current claim is not supported by trace evidence.');
      else expect(message).toBeUndefined();
      expect(message ?? '').not.toContain('did not complete');
      expect(message ?? '').not.toContain('PRIVATE_DISCARDED_ATTEMPT_ERROR');
    }
    for (const body of [payload.conclusion, turn.conclusionPreview, report.summary.conclusion]) {
      if (qualityFailure) {
        expect(body).toBe(conclusion);
      } else expect(body).toBe(conclusion);
      expect(body).not.toContain('did not complete');
    }
  });
  it.each(['live', 'snapshot'] as const)('rejects mismatched %s result run attribution during read recovery', location => {
    const id = `http-read-run-${location}`;
    const stored = {sessionId: id, success: true, conclusion: 'prior result', findings: [], hypotheses: [],
      rounds: 1, confidence: 1, totalDurationMs: 1, completion: {runId: 'run-current'},
      analysisReceipt: {runId: 'run-prior'}};
    const session = {sessionId: id, activeRun: {runId: 'run-current'},
      ...(location === 'live' ? {result: stored} : {})} as any;
    const persistence = SessionPersistenceService.getInstance();
    jest.spyOn(persistence, 'loadSessionStateSnapshot').mockReturnValue({sessionId: id,
      lastRun: {runId: 'run-current'}, finalResult: stored} as any);
    jest.spyOn(persistence, 'getSession').mockReturnValue(null);
    const before = JSON.stringify(session);
    expect(agentRoutesPrivacyProjectionTestSeam.recoverResultForSessionIfNeeded(id, session)).toBeNull();
    expect(JSON.stringify(session)).toBe(before);
  });

  it.each(['completed', 'failed', 'cancelled', 'quota_exceeded', undefined])(
    'preserves stored terminal status %s without inventing a legacy status', terminalRunStatus => {
      const session = {sessionId, codeAwareMode: 'provider_send', codebaseIds: ['cb-private']} as any;
      const eventData = JSON.stringify({data: {conclusion: '', terminalRunStatus}});
      const projected = agentRoutesPrivacyProjectionTestSeam.sanitizePersistedAnalysisCompletedEvent(
        session, {eventType: 'analysis_completed', eventData} as any,
      );
      expect(JSON.parse(projected.eventData).data.terminalRunStatus).toBe(terminalRunStatus);
    },
  );

  it('keeps the original failed claim through completed HTTP payload reconstruction and replay', () => {
    const claims = [{
      id: 'http-wrong-ttid', text: 'TTID=9999ms', kind: 'numeric',
      references: [{evidenceRefId: 'data:http-ttid', rowIndex: 0, column: 'ttid_ms', value: 9999}],
    }];
    const session = {
      sessionId: 'http-claim-fidelity', traceId: 'trace-http', query: '核对 TTID',
      runSequence: 2, providerId: null, scenes: [], hypotheses: [],
      dataEnvelopes: [createDataEnvelope({columns: ['ttid_ms'], rows: [[1912]]}, {
        type: 'skill_result', source: 'startup_analysis', title: '启动概览',
        evidenceRefId: 'data:http-ttid', traceId: 'trace-http', traceSide: 'current',
      })],
      result: {
        sessionId: 'http-claim-fidelity', success: true, findings: [], hypotheses: [],
        conclusion: 'TTID=9999ms，事件计数1912次。', confidence: 0.9, rounds: 1, totalDurationMs: 1,
        partial: true,
        claimVerificationResult: {schemaVersion: 'claim_verifier@2', policy: 'record_only',
          status: 'failed', passed: false, checkedClaimCount: 1, unsupportedClaimCount: 1,
          claimResults: [{claimId: 'http-wrong-ttid', status: 'unsupported', issues: []}], issues: []},
        conclusionContract: {
          schemaVersion: 'conclusion_contract_v1', mode: 'focused_answer',
          conclusions: [{rank: 1, statement: 'TTID=9999ms'}], claims,
          clusters: [], evidenceChain: [], uncertainties: [], nextSteps: [],
        },
      },
      // Final verification is stored by the write path, never recomputed by a read.
      completedAnalysisFinalArtifacts: {receiptReference: {runManifestId: 'manifest-http-claim-fidelity'}},
    } as any;

    const before = JSON.stringify(session);
    const verify = jest.spyOn(claimPreparation, 'runPreparedAnalysisClaimVerification');
    const gate = jest.spyOn(qualityGate, 'applyFinalResultQualityGate');
    const finalize = jest.spyOn(finalizer, 'finalizeAnalysisResult');
    const report = jest.spyOn(reportRoutes, 'persistReport');
    const snapshot = jest.spyOn(snapshots, 'persistCompletedAnalysisResultSnapshot');
    const persistEvent = jest.spyOn(eventStore, 'persistSerializedAgentEvent');
    const once = agentRoutesPrivacyProjectionTestSeam.ensureCompletedAnalysisResultPayload(session);
    const replay = agentRoutesPrivacyProjectionTestSeam.ensureCompletedAnalysisResultPayload(session);
    expect(JSON.stringify(session)).toBe(before);
    for (const operation of [verify, gate, finalize, report, snapshot, persistEvent]) expect(operation).not.toHaveBeenCalled();
    expect(once?.normalizedConclusionContract?.claims).toEqual(claims);
    expect(replay?.normalizedConclusionContract?.claims).toEqual(claims);
    expect(replay?.qualityArtifacts.claimVerificationResult).toMatchObject({status: 'failed', passed: false});
    expect(replay?.result.partial).toBe(true);
    expect(replay?.result.claimVerificationResult?.claimResults.map(claim => claim.claimId)).toEqual(['http-wrong-ttid']);
  });

  it('safely projects stored source metadata without borrowing a current-run accessor', () => {
    const fabricated = {
      schemaVersion: 'conclusion_contract_v1',
      mode: 'focused_answer',
      conclusions: [],
      clusters: [],
      evidenceChain: [],
      claims: [{id: 'claim-stale', text: 'trace fact', references: []}],
      sourceUseDecision: {
        schemaVersion: 'source_use_decision@1',
        codeAwareMode: 'provider_send',
        selectedCodebaseIds: ['stale-app'],
        status: 'corroborated',
        attemptedTools: ['read_codebase_file'],
        queriedCodebaseIds: ['stale-app'],
        usedCodebaseIds: ['stale-app'],
        references: [{
          referenceId: 'stale-lookup',
          codebaseId: 'stale-app',
          filePath: 'src/Stale.kt',
          lookupKind: 'body',
          rootPath: '/Users/chris/SECRET_STALE_ROOT',
          snippet: 'SECRET_STALE_SNIPPET',
          query: 'SECRET_STALE_QUERY',
        }],
      },
      sourceReferences: [{
        referenceId: 'stale-lookup',
        codebaseId: 'stale-app',
        filePath: 'src/Stale.kt',
        lookupKind: 'body',
      }],
      sourceClaimBindings: [{
        claimId: 'claim-stale',
        mechanismStatus: 'corroborated',
        sourceReferenceIds: ['stale-lookup'],
        traceEvidenceRefIds: ['trace-stale'],
        reason: 'SECRET_STALE_REASON',
      }],
      uncertainties: [],
      nextSteps: [],
    };
    const projected = (
      agentRoutesPrivacyProjectionTestSeam.analysisCompletedData as (
        data: any,
        actualSourceUseDecision?: unknown,
      ) => any
    )({
      conclusion: 'trace-only conclusion',
      conclusionContract: fabricated,
      findings: [],
    }, undefined);

    expect(projected.conclusion).toBe('trace-only conclusion');
    expect(projected.conclusionContract.claims).toEqual(fabricated.claims);
    expect(projected).not.toHaveProperty('deliveryAssurance');
    expect(JSON.stringify(projected)).not.toContain('SECRET_');
    expect(JSON.stringify(projected)).not.toContain('/Users/chris');

    const persisted = agentRoutesPrivacyProjectionTestSeam.sanitizePersistedAnalysisCompletedEvent(
      {
        sessionId: 'session-stale-no-accessor',
        query: 'trace-only query',
        traceId: 'trace-stale-no-accessor',
        codeAwareMode: 'provider_send',
        codebaseIds: ['stale-app'],
        dataEnvelopes: [],
      } as any,
      {
        eventType: 'analysis_completed',
        eventData: JSON.stringify({
          type: 'analysis_completed',
          data: {
            privateProjectionVersion: 1,
            conclusion: 'trace-only conclusion',
            conclusionContract: fabricated,
            findings: [],
          },
          timestamp: 1,
        }),
        createdAt: 1,
      } as any,
    );
    const persistedContract = JSON.parse(persisted.eventData).data.conclusionContract;
    expect(persistedContract?.claims).toBeDefined();
    expect(JSON.parse(persisted.eventData).data.deliveryAssurance).toBeUndefined();
    expect(persisted.eventData).not.toContain('SECRET_');
    expect(persisted.eventData).not.toContain('/Users/chris');
  });

  it('passes the durable actual source decision into completed snapshot persistence', () => {
    const snapshotInput = completedSnapshotInputFromRoute();
    const sourceUseDecision = snapshotInput?.properties.find(
      (property): property is ts.PropertyAssignment =>
        ts.isPropertyAssignment(property) &&
        property.name.getText() === 'sourceUseDecision',
    );

    expect(snapshotInput).toBeDefined();
    expect(sourceUseDecision?.initializer.getText()).toBe(
      'durableResultForClient.sourceUseDecision',
    );
  });

  it('whitelists stored capability attribution in private persisted SSE projection', () => {
    const canary = '/private/SSE_CAPABILITY_CANARY';
    const hash = 'a'.repeat(64);
    const session = {
      sessionId,
      query: 'private analysis',
      codeAwareMode: 'provider_send',
      codebaseIds: ['cb-private'],
    } as any;
    const projected = agentRoutesPrivacyProjectionTestSeam.sanitizePersistedAnalysisCompletedEvent(
      session,
      {
        eventType: 'analysis_completed',
        eventData: JSON.stringify({data: {
          success: true,
          conclusion: 'safe conclusion',
          analysisReceipt: {
            schemaVersion: 2,
            runManifestId: 'run-manifest-safe',
            runId: 'run-safe',
            sessionId,
            traceId: 'trace-safe',
            mode: 'full',
            resolvedMode: 'full',
            providerId: null,
            generatedAt: 1,
            traceEvidence: {sqlCount: 0, skillCount: 0, dataEnvelopeCount: 0, artifactCount: 0, evidenceRefCount: 0},
            nonEvidenceContext: {frontendPrequeryCount: 0, memoryHintCount: 0, conversationContextCount: 0, strategyHintCount: 0},
            claimAudit: {totalClaims: 0, verifiedClaims: 0, unsupportedClaims: 0, uncertainClaims: 0},
            qualityGates: {finalReportContract: 'not_applicable', claimVerification: 'not_applicable', identityResolution: 'not_applicable'},
            outputs: {reportError: canary, cliTurnPath: canary},
            capabilityManifest: {
              schemaVersion: 'capability_manifest_attribution@1',
              resolution: {
                status: 'ready',
                manifestId: `capability_manifest:${hash}`,
                contentHash: hash,
                manifestSchemaVersion: 'capability_manifest@1',
                traceFingerprintSha256: 'b'.repeat(64),
                traceProcessor: {source: 'bundled', gitRevision: 'c'.repeat(40), localPath: canary},
                rpcEndpoint: canary,
              },
              probeCache: {hits: 1, misses: 0, bypasses: 0, localPath: canary},
              localPath: canary,
            },
          },
        }}),
      } as any,
    );

    const projectedData = JSON.parse(projected.eventData).data;
    expect(JSON.stringify(projectedData)).not.toContain(canary);
    expect(projectedData.analysisReceipt.capabilityManifest).toEqual(expect.objectContaining({
      schemaVersion: 'capability_manifest_attribution@1',
      resolution: expect.objectContaining({
        manifestId: `capability_manifest:${hash}`,
      }),
    }));
    expect(projectedData.analysisReceipt.outputs).toEqual({});
  });

  it('carries sealed RunManifest capability attribution into the HTTP receipt', () => {
    const capabilityManifest = {
      schemaVersion: 'capability_manifest_attribution@1',
      resolution: {
        status: 'unavailable',
        reason: 'identity_resolution_failed',
        detailCode: 'file_identity_changed',
      },
      probeCache: {hits: 0, misses: 0, bypasses: 1},
    } as const;
    const adaptiveRouting = routeAdaptiveEvidencePreflight({
      requestedMode: 'auto',
      resolvedMode: 'quick',
      classifierIntent: 'deterministic_direct_evidence',
      classifierSource: 'hard_rule',
      hardObligations: [],
    });
    const reference = agentRoutesReceiptTestSeam.runManifestReceiptReference({
      runManifestId: 'manifest-http-capability',
      capabilityManifest,
      adaptiveRouting,
    });
    const receipt = agentRoutesReceiptTestSeam.buildAnalysisReceiptForReference(reference, {
      session: {sessionId: 'session-http-capability', traceId: 'trace-http-capability'},
      result: {
        sessionId: 'session-http-capability',
        success: true,
        findings: [],
        hypotheses: [],
        conclusion: 'ok',
        confidence: 1,
        rounds: 1,
        totalDurationMs: 1,
      },
      generatedAt: 1,
    });

    expect(receipt).toEqual(expect.objectContaining({
      schemaVersion: 2,
      runManifestId: 'manifest-http-capability',
      capabilityManifest,
      adaptiveRouting,
    }));
  });

  it('reports private feedback as locally stored without public projection', () => {
    expect(agentRoutesPrivacyProjectionTestSeam.privateFeedbackResponse({
      durable: true,
    })).toEqual({
      success: true,
      schemaVersion: 1,
      durableFeedbackStored: true,
      storageDisposition: 'stored_private_local',
      patternStatus: null,
      caseCandidateFeedbackAdded: null,
    });
  });

  it('scrubs model-authored state before retiring an authorization-changed session', () => {
    const canary = 'PRIVATE_AUTH_CHANGE_CANARY';
    const session = {
      sessionId,
      traceId: 'trace-private',
      query: canary,
      agentQuery: canary,
      result: {conclusion: canary},
      error: canary,
      hypotheses: [{description: canary}],
      scenes: [{name: canary}],
      trackEvents: [{name: canary}],
      sceneStoryReport: {summary: canary},
      stateTimeline: {lane: [{label: canary}]},
      laneAvailability: {lane: 'available'},
      agentDialogue: [{content: canary}],
      dataEnvelopes: [{data: canary}],
      agentResponses: [{response: canary}],
      claimSupport: [{claimId: canary}],
      claimVerificationResult: {summary: canary},
      identityResolutions: [{displayName: canary}],
      conversationSteps: [{text: canary}],
      queryHistory: [{query: canary}],
      conclusionHistory: [{conclusion: canary}],
      comparisonReportSection: {summary: canary},
      codebaseIds: [canary],
      knowledgeSourceIds: [canary],
      analysisContextFingerprint: canary,
      activeRun: {query: canary},
      lastRun: {query: canary},
      runRegistry: {run: {query: canary}},
      runSseState: {run: {sseEventBuffer: [{eventData: canary}]}},
      sseEventBuffer: [{eventData: canary}],
      sseEventSeq: 99,
    } as any;

    agentRoutesPrivacyProjectionTestSeam.scrubAuthorizationChangedSession(session);

    expect(JSON.stringify(session)).not.toContain(canary);
    expect(session.query).toMatch(/原始内容未持久化|original content not persisted/);
    expect(session.sseEventBuffer).toEqual([]);
    expect(session.sseEventSeq).toBe(0);
  });

  it('blocks late private output while authorization-change cleanup is still running', async () => {
    const canary = 'PRIVATE_LATE_CLEANUP_CANARY';
    const orchestrator = new EventEmitter() as any;
    const delivered: unknown[] = [];
    let cleanupProjection = '';
    const updateHandler = (update: unknown) => delivered.push(update);
    orchestrator.on('update', updateHandler);
    orchestrator.cleanupSession = async () => {
      orchestrator.emit('update', {type: 'answer_token', content: canary});
      cleanupProjection = sanitizeCodeAwareText(sessionId, canary);
    };
    registerCodeAwareCanary(sessionId, canary);
    const session = {
      sessionId,
      orchestrator,
      orchestratorUpdateHandler: updateHandler,
    } as any;

    await agentRoutesPrivacyProjectionTestSeam.retireAuthorizationChangedSession(
      sessionId,
      session,
      updateHandler as any,
    );

    expect(delivered).toEqual([]);
    expect(cleanupProjection).not.toContain(canary);
    expect(sanitizeCodeAwareText(sessionId, canary)).not.toContain(canary);
    expect(session.orchestratorUpdateHandler).toBeUndefined();
  });

  it('never returns the raw private query in an SSE connected payload', () => {
    const canary = 'PRIVATE_CONNECTED_QUERY_CANARY';
    const projected = agentRoutesPrivacyProjectionTestSeam.connectedStreamQuery({
      query: canary,
      outputLanguage: 'en',
      codeAwareMode: 'provider_send',
      codebaseIds: ['cb-private'],
    } as any, {
      query: `run ${canary}`,
    } as any);

    expect(projected).not.toContain(canary);
    expect(projected).toContain('original content not persisted');
  });

  it('removes private query, intent, and quality artifacts from turn list and detail payloads', () => {
    const canary = 'PRIVATE_TURN_CANARY';
    registerCodeAwareCanary(sessionId, canary);
    const turn = {
      id: 'turn-1',
      turnIndex: 1,
      timestamp: 123,
      query: `query ${canary}`,
      intent: {primaryGoal: canary, followUpType: canary, aspects: [canary]},
      completed: true,
      findings: [{title: canary}],
      result: {
        success: true,
        message: `conclusion ${canary}`,
        confidence: 0.8,
        conclusionContract: {claims: [canary]},
        claimSupport: [{claimId: canary}],
        claimVerificationResult: {status: canary},
        identityResolutions: [{identityRefId: canary}],
      },
    } as any;

    const summary = agentRoutesPrivacyProjectionTestSeam.buildTurnSummary(turn, sessionId);
    const detail = agentRoutesPrivacyProjectionTestSeam.buildTurnDetail(turn, sessionId);

    expect(JSON.stringify({summary, detail})).not.toContain(canary);
    expect(summary.query).toMatch(/原始内容未持久化|original content not persisted/);
    expect(summary.intent).toEqual({primaryGoal: '', followUpType: 'initial', aspects: []});
    expect(summary.findingCount).toBe(1);
    expect(detail.findings).toHaveLength(1);
    expect(detail.result).toHaveProperty('claimSupport');
    // An unknown status is not a verifier receipt to preserve or reinterpret.
    expect(detail.result?.claimVerificationResult).toBeUndefined();
    expect(detail.result).toHaveProperty('identityResolutions');
    expect(JSON.stringify(detail)).not.toContain(canary);
  });

  it.each([
    ['malformed', '{PRIVATE_REPLAY_CANARY'],
    ['empty conclusion', JSON.stringify({data: {
      success: true,
      conclusion: '',
      analysisReceipt: {outputs: {reportError: 'PRIVATE_REPLAY_CANARY'}},
      claimSupport: [{claimId: 'PRIVATE_REPLAY_CANARY'}],
      resultContract: {
        dataEnvelopes: [{data: {queryReview: 'PRIVATE_REPLAY_CANARY'}}],
      },
    }})],
  ])('fails closed for %s persisted analysis_completed events', (_name, eventData) => {
    const session = {
      sessionId,
      query: 'PRIVATE_REPLAY_QUERY_CANARY',
      codeAwareMode: 'provider_send',
      codebaseIds: ['cb-private'],
    } as any;
    const projected = agentRoutesPrivacyProjectionTestSeam.sanitizePersistedAnalysisCompletedEvent(
      session,
      {eventType: 'analysis_completed', eventData} as any,
    );

    expect(JSON.stringify(projected)).not.toContain('PRIVATE_REPLAY_CANARY');
    const data = JSON.parse(projected.eventData).data;
    expect(data.conclusion)
      .toMatch(/未生成可显示|No analysis conclusion/);
    expect(data.resultContract).toBeUndefined();
  });

  it('drops untrusted investigation metadata from persisted private SSE without relying on live redaction guards', () => {
    const secret = 'UNREGISTERED_PRIVATE_INVESTIGATION_SECRET';
    const session = {sessionId, codeAwareMode: 'provider_send', codebaseIds: ['cb-private']} as any;
    const hash = analysisDeliveryFingerprint('retained');
    const eventData = JSON.stringify({data: {success: true, conclusion: 'Stored conclusion',
      investigationAssessment: {schemaVersion: 1, status: 'checked', binding: {
        candidateRef: 'candidate', runId: 'run', attemptId: 'attempt', conclusionFingerprint: hash,
        conclusionContractFingerprint: hash, evidenceFingerprint: hash, requirementsFingerprint: hash,
        registryFingerprint: 'registry', intentFingerprint: hash, ledgerFingerprint: hash, evidenceRecordsFingerprint: hash},
        requirements: [{requirementId: secret, domain: secret, applicability: 'applicable', coverage: 'covered',
          evidenceStatus: 'observed', acquisition: 'observed', scopeMatch: 'matched',
          contentLocations: [{start: 0, end: 3}], evidenceRecordIds: [secret]}],
        evidenceRecords: [{recordId: secret, captureId: secret, rowIndex: 0, evidenceRefId: secret,
          artifactId: secret, sourceToolCallId: secret, skillId: 'system', stepId: 'summary',
          definitionFingerprint: hash, selectedSqlHash: hash, traceId: secret, traceSide: 'current',
          originRunId: secret, origin: 'current_run', domain: 'frequency', metricId: 'system.cpu.frequency',
          status: 'observed', window: {start: 0, end: 100}, value: secret}]},
      deliveryAssurance: {schemaVersion: 1, entry: 'new_finalization', completion: 'passed', claims: 'passed',
        source: 'passed', identity: 'passed', report: 'passed', investigation: 'passed', investigationEvidence: 'passed'},
    }});
    const projected = agentRoutesPrivacyProjectionTestSeam.sanitizePersistedAnalysisCompletedEvent(
      session, {eventType: 'analysis_completed', eventData} as any);
    const data = JSON.parse(projected.eventData).data;
    expect(data.investigationAssessment).toBeUndefined();
    expect(data.deliveryAssurance).toBeUndefined();
    expect(projected.eventData).not.toContain(secret);
    expect(data.success).toBe(false);
  });

  it('persists generic private run metadata and projected replay events in enterprise SQLite', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'private-route-db-'));
    const originalEnterprise = process.env[ENTERPRISE_FEATURE_FLAG_ENV];
    const originalDbPath = process.env[ENTERPRISE_DB_PATH_ENV];
    process.env[ENTERPRISE_FEATURE_FLAG_ENV] = 'true';
    process.env[ENTERPRISE_DB_PATH_ENV] = path.join(tmpDir, 'enterprise.sqlite');
    const canary = 'PRIVATE_RUNTIME_DB_CANARY';
    registerCodeAwareCanary(sessionId, canary);
    const session = {
      sessionId,
      traceId: 'trace-private-runtime',
      tenantId: 'tenant-private-runtime',
      workspaceId: 'workspace-private-runtime',
      userId: 'user-private-runtime',
      query: `query ${canary}`,
      codeAwareMode: 'provider_send',
      codebaseIds: ['cb-private'],
      activeRun: {
        runId: 'run-private-runtime',
        requestId: 'request-private-runtime',
        sequence: 1,
        query: `run query ${canary}`,
        startedAt: 1,
        status: 'running',
      },
      logger: {warn: () => undefined},
    } as any;

    try {
      agentRoutesPrivacyProjectionTestSeam.persistSessionRunState(
        session,
        'failed',
        `error ${canary}`,
      );
      const rawEvent = {
          cursor: 1,
          eventType: 'analysis_completed',
          eventData: JSON.stringify({
            privateTopLevelCanary: canary,
            data: {
              success: true,
              conclusion: `conclusion ${canary}`,
              claimSupport: [{claimId: canary}],
              unknownPrivateField: canary,
            },
          }),
          createdAt: 2,
        } as any;
      agentRoutesPrivacyProjectionTestSeam.persistBufferedAgentEvent(session, rawEvent);

      const db = openEnterpriseDb();
      try {
        const graph = {
          run: db.prepare('SELECT question, error_json FROM analysis_runs WHERE id = ?')
            .get('run-private-runtime'),
          session: db.prepare('SELECT title FROM analysis_sessions WHERE id = ?')
            .get(sessionId),
          events: db.prepare('SELECT payload_json FROM agent_events WHERE run_id = ?')
            .all('run-private-runtime'),
        };
        expect(JSON.stringify(graph)).not.toContain(canary);
        expect((graph.run as any).question)
          .toMatch(/原始内容未持久化|original content not persisted/);
      } finally {
        db.close();
      }
    } finally {
      resetAnalysisRunStoreForTests();
      resetAgentEventStoreForTests();
      if (originalEnterprise === undefined) delete process.env[ENTERPRISE_FEATURE_FLAG_ENV];
      else process.env[ENTERPRISE_FEATURE_FLAG_ENV] = originalEnterprise;
      if (originalDbPath === undefined) delete process.env[ENTERPRISE_DB_PATH_ENV];
      else process.env[ENTERPRISE_DB_PATH_ENV] = originalDbPath;
      fs.rmSync(tmpDir, {recursive: true, force: true});
    }
  });

  it('persists only completed M10 source evidence outside enterprise mode', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'm10-source-db-'));
    const originalEnterprise = process.env[ENTERPRISE_FEATURE_FLAG_ENV];
    const originalDbPath = process.env[ENTERPRISE_DB_PATH_ENV];
    process.env[ENTERPRISE_FEATURE_FLAG_ENV] = 'false';
    process.env[ENTERPRISE_DB_PATH_ENV] = path.join(tmpDir, 'local.sqlite');
    const session = {
      sessionId: 'local-m10-session',
      traceId: 'local-m10-trace',
      tenantId: 'default-dev-tenant',
      workspaceId: 'default-workspace',
      userId: 'dev-user-123',
      query: 'analyze local trace',
      activeRun: {
        runId: 'local-m10-run',
        requestId: 'local-m10-request',
        sequence: 1,
        query: 'analyze local trace',
        startedAt: 1,
        status: 'completed',
      },
      logger: {warn: () => undefined},
    } as any;

    try {
      agentRoutesPrivacyProjectionTestSeam.persistBufferedAgentEvent(
        session,
        {
          cursor: 1,
          eventType: 'progress',
          eventData: JSON.stringify({data: {phase: 'completed'}}),
          createdAt: 1,
        },
      );
      agentRoutesPrivacyProjectionTestSeam.persistBufferedAgentEvent(
        session,
        {
          cursor: 2,
          eventType: 'analysis_completed',
          eventData: JSON.stringify({
            type: 'analysis_completed',
            data: {
              conclusion: 'No ANR was found.',
              analysisReceipt: {
                schemaVersion: 2,
                runId: 'local-m10-run',
                sessionId: 'local-m10-session',
                runManifestId: 'local-m10-manifest',
                outputs: {},
              },
            },
          }),
          createdAt: 2,
        },
      );

      const db = openEnterpriseDb();
      try {
        expect(db.prepare(`
          SELECT event_type AS eventType
          FROM agent_events
          WHERE run_id = ?
          ORDER BY cursor
        `).all('local-m10-run')).toEqual([
          {eventType: 'analysis_completed'},
        ]);
      } finally {
        db.close();
      }
    } finally {
      resetAnalysisRunStoreForTests();
      resetAgentEventStoreForTests();
      if (originalEnterprise === undefined) {
        delete process.env[ENTERPRISE_FEATURE_FLAG_ENV];
      } else {
        process.env[ENTERPRISE_FEATURE_FLAG_ENV] = originalEnterprise;
      }
      if (originalDbPath === undefined) {
        delete process.env[ENTERPRISE_DB_PATH_ENV];
      } else {
        process.env[ENTERPRISE_DB_PATH_ENV] = originalDbPath;
      }
      fs.rmSync(tmpDir, {recursive: true, force: true});
    }
  });

  describe('scene reconstruction status compatibility endpoint', () => {
    const canary = 'PRIVATE_SCENE_STATUS_CANARY';
    const credential = 'sk-scenestatusfallback0123456789';
    const owner = {tenantId: 'tenant-scene-status', workspaceId: 'workspace-scene-status', userId: 'user-scene-status'};
    const envKeys = ['SMARTPERFETTO_API_KEY', 'SMARTPERFETTO_SSO_TRUSTED_HEADERS', ENTERPRISE_FEATURE_FLAG_ENV] as const;
    const originalEnv = new Map(envKeys.map(key => [key, process.env[key]]));
    const sessionIds: string[] = [];
    const app = express();
    app.use(express.json());
    app.use('/api/agent/v1', agentRoutes);
    const get = (url: string) => request(app).get(`/api/agent/v1${url}`)
      .set('X-SmartPerfetto-SSO-User-Id', owner.userId)
      .set('X-SmartPerfetto-SSO-Email', 'scene-status@example.test')
      .set('X-SmartPerfetto-SSO-Tenant-Id', owner.tenantId)
      .set('X-SmartPerfetto-SSO-Workspace-Id', owner.workspaceId)
      .set('X-SmartPerfetto-SSO-Roles', 'analyst')
      .set('X-SmartPerfetto-SSO-Scopes', 'trace:read,agent:run,report:read');
    // A session without a scene timeline takes the endpoint's fallback branch:
    // any owned ordinary analysis, or a scene run that committed no segment.
    const addSession = (id: string, privateKnowledge: boolean, fields: Record<string, unknown>) => {
      sessionIds.push(id);
      if (privateKnowledge) registerCodeAwareCanary(id, canary);
      agentRoutesCancellationTestSeam.setSession(id, {sessionId: id, traceId: `trace-${id}`, query: 'why is it slow',
        createdAt: 1, lastActivityAt: 1, ...owner, outputLanguage: 'en',
        ...(privateKnowledge ? {codeAwareMode: 'provider_send', codebaseIds: ['cb-private']} : {}),
        scenes: [], hypotheses: [], dataEnvelopes: [], sseClients: [], sseEventBuffer: [], sseEventSeq: 0,
        logger: {info: () => {}, warn: () => {}, error: () => {}}, ...fields} as any);
    };

    beforeAll(() => {
      delete process.env.SMARTPERFETTO_API_KEY;
      process.env.SMARTPERFETTO_SSO_TRUSTED_HEADERS = 'true';
      process.env[ENTERPRISE_FEATURE_FLAG_ENV] = 'false';
    });
    afterEach(() => {
      for (const id of sessionIds.splice(0)) {
        agentRoutesCancellationTestSeam.deleteSession(id);
        clearCodeAwareOutputGuards(id);
      }
    });
    afterAll(() => {
      for (const [key, value] of originalEnv) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
    });

    it.each([true, false])('serves the same projected body as the ordinary status (private=%s)', async privateKnowledge => {
      const id = `scene-status-body-${privateKnowledge}`;
      const conclusion = `Main thread blocked ${canary}; token ${credential}; evidence ev_0123456789ab.`;
      addSession(id, privateKnowledge, {status: 'completed', result: {sessionId: id, success: true, conclusion,
        findings: [], hypotheses: [], confidence: 0.7, rounds: 1, totalDurationMs: 5}});
      const scene = await get(`/scene-reconstruct/${id}/status`);
      const ordinary = await get(`/${id}/status`);
      expect(scene.status).toBe(200);
      expect(ordinary.status).toBe(200);
      expect(scene.body.result.narrative).toBe(ordinary.body.result.conclusion);
      if (privateKnowledge) {
        expect(JSON.stringify(scene.body)).not.toContain(canary);
        expect(JSON.stringify(scene.body)).not.toContain(credential);
      } else {
        expect(scene.body.result.narrative).toBe(conclusion);
      }
    });

    it.each([true, false])('serves the owner-projected scene timeline from /tracks (private=%s)', async privateKnowledge => {
      const id = `scene-tracks-timeline-${privateKnowledge}`;
      const unresolved = `segment window unresolved near ${canary}; token ${credential}`;
      const sceneTimeline = {schemaVersion: 'scene_timeline@1', runId: 'run-scene', sessionId: id,
        traceId: `trace-${id}`, revision: 1, status: 'partial', coverage: {status: 'complete'},
        segments: [], unresolved: [unresolved], diagnostics: []};
      addSession(id, privateKnowledge, {status: 'completed', result: {sessionId: id, success: true,
        conclusion: 'Scene timeline', findings: [], hypotheses: [], confidence: 0.7, rounds: 1, totalDurationMs: 5,
        sceneTimeline}});
      // A scene-timeline session must still own a readable trace.
      jest.spyOn(traceMetadataStore, 'readTraceMetadataForContext')
        .mockResolvedValue({id: `trace-${id}`} as Awaited<ReturnType<typeof traceMetadataStore.readTraceMetadataForContext>>);
      const tracks = await get(`/scene-reconstruct/${id}/tracks`);
      const status = await get(`/scene-reconstruct/${id}/status`);
      expect(tracks.status).toBe(200);
      expect(tracks.body.sceneTimeline).toEqual(status.body.result.sceneTimeline);
      if (privateKnowledge) {
        expect(JSON.stringify(tracks.body)).not.toContain(canary);
        expect(JSON.stringify(tracks.body)).not.toContain(credential);
        expect(tracks.body.sceneTimeline.diagnostics).toContainEqual({code: 'scene_output_projection_restricted'});
      } else {
        expect(tracks.body.sceneTimeline.unresolved).toEqual([unresolved]);
      }
    });

    it('does not serve a stored result that belongs to another run', async () => {
      const id = 'scene-status-other-run';
      const run = {runId: 'run-current', requestId: 'request-current', sequence: 2, query: 'q', startedAt: 1,
        status: 'completed'};
      addSession(id, false, {status: 'completed', lastRun: run, runRegistry: {[run.runId]: run},
        result: {sessionId: id, success: true, conclusion: 'An earlier run answer', findings: [], hypotheses: [],
          confidence: 0.7, rounds: 1, totalDurationMs: 5, completion: {runId: 'run-earlier'}}});
      const scene = await get(`/scene-reconstruct/${id}/status`);
      expect(scene.status).toBe(200);
      expect(scene.body.result).toBeUndefined();
    });

    it('projects a stored raw failure message on every read surface', async () => {
      const id = 'scene-status-private-failure';
      addSession(id, true, {status: 'failed', error: `lease failed ${canary} ${credential}`});
      const scene = await get(`/scene-reconstruct/${id}/status`);
      const ordinary = await get(`/${id}/status`);
      const stream = await get(`/${id}/stream`);
      expect(scene.body.error).toEqual(expect.any(String));
      expect(scene.body.error).toBe(ordinary.body.error);
      for (const text of [JSON.stringify(scene.body), JSON.stringify(ordinary.body), stream.text]) {
        expect(text).not.toContain(canary);
        expect(text).not.toContain(credential);
      }
      expect(stream.text).toContain('event: error');
    });
  });
});
