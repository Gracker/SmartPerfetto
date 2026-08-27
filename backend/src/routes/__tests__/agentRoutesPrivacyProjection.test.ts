// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {afterEach, describe, expect, it} from '@jest/globals';
import {EventEmitter} from 'events';
import fs from 'fs';
import os from 'os';
import path from 'path';
import ts from 'typescript';
import {
  agentRoutesPrivacyProjectionTestSeam,
  agentRoutesReceiptTestSeam,
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

afterEach(() => clearCodeAwareOutputGuards(sessionId));

describe('agent route private projections', () => {
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

  it.each([
    ['zh-CN', '## 证据索引', '关键数据来源：', '（execute_sql / ev-1）'],
    ['en', '## Evidence Index', 'Key data sources:', '(execute_sql / ev-1)'],
  ] as const)('localizes generated evidence indexes for %s', (language, heading, prefix, item) => {
    const evidenceIndex = agentRoutesPrivacyProjectionTestSeam.buildConclusionEvidenceIndex([
      {
        meta: {source: 'execute_sql', evidenceRefId: 'ev-1'},
        display: {title: 'Frame timeline'},
      } as any,
    ], 3, language);

    expect(evidenceIndex).toContain(heading);
    expect(evidenceIndex).toContain(prefix);
    expect(evidenceIndex).toContain(item);
    expect(evidenceIndex).not.toContain(language === 'en' ? '关键数据来源' : 'Key data sources');
  });

  it.each([
    '## 证据索引\n\n关键数据来源：帧时间。',
    '## Evidence Index\n\nKey data sources: frame timing.',
    'Evidence Index: frame timing',
  ])('recognizes an existing bilingual evidence index without duplicating it', (conclusion) => {
    expect(agentRoutesPrivacyProjectionTestSeam.conclusionHasEvidenceIndex(conclusion)).toBe(true);
    expect(agentRoutesPrivacyProjectionTestSeam.appendEvidenceIndexIfMissing(
      conclusion,
      [{meta: {source: 'execute_sql'}, display: {title: 'Frame timeline'}} as any],
      'en',
    )).toBe(conclusion);
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
    expect(detail.result).toHaveProperty('claimVerificationResult');
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
      .toMatch(/未能完成|did not complete/);
    expect(data.resultContract).toBeUndefined();
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
});
