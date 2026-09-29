// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import express from 'express';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import request from 'supertest';

import {parseConclusionContractDeclaration, type ConclusionContract} from '../../agent/core/conclusionContract';
import type {AnalysisResult} from '../../agent/core/orchestratorTypes';
import {attachFinalizationContext, takeFinalizationContext} from '../../agentRuntime/analysisFinalizationContext';
import {ArtifactStore} from '../../agentv3/artifactStore';
import {buildStrategyRegistrySnapshotFromDefinitions, getRegisteredScenes} from '../../agentv3/strategyLoader';
import type {RunTurnOutput} from '../../cli-user/services/cliAnalyzeService';
import {commitTurnOutputs} from '../../cli-user/services/turnPersistence';
import {runShowCommand} from '../../cli-user/commands/show';
import {runReportExportCommand} from '../../cli-user/commands/report';
import {computePaths, ensureLayout, ensureSessionLayout, sessionPaths} from '../../cli-user/io/paths';
import type {Renderer} from '../../cli-user/repl/renderer';
import {
  authenticate,
  DEFAULT_DEV_USER_ID,
  DEFAULT_TENANT_ID,
} from '../../middleware/auth';
import {
  bindWorkspaceRouteContext,
  requireWorkspaceRouteContext,
} from '../../middleware/workspaceRouteContext';
import analysisResultRoutes from '../../routes/analysisResultRoutes';
import {
  agentRoutesPrivacyProjectionTestSeam,
} from '../../routes/agentRoutes';
import reportRoutes, {persistReport, reportStore} from '../../routes/reportRoutes';
import {backendLogPath} from '../../runtimePaths';
import {buildAgentDrivenReportData} from '../agentReportData';
import {persistCompletedAnalysisResultSnapshot} from '../analysisResultSnapshotPipeline';
import {sanitizeSourceReference, sanitizeSourceUseDecision, type SourceUseDecisionV1} from '../codebase/sourceUseDecision';
import {createDataEnvelope, type DataEnvelope} from '../../types/dataContract';
import {analysisDeliveryFingerprint} from '../../types/analysisDelivery';
import {captureEvidenceTable} from '../evidence/evidenceCapture';
import {finalizeAnalysisResult} from '../finalizeAnalysisResult';
import {copyAnalysisDeliveryFields} from '../security/analysisDeliveryProjection';
import {HTMLReportGenerator} from '../htmlReportGenerator';

const originalDbPath = process.env.SMARTPERFETTO_ENTERPRISE_DB_PATH;

function rendererStub(): Renderer {
  return {
    format: 'text',
    onEvent: () => undefined,
    printError: () => undefined,
    printConclusion: () => undefined,
    printCompletion: () => undefined,
    printLine: () => undefined,
  } as unknown as Renderer;
}

function normalizedDecision(value: any) {
  return {
    schemaVersion: value.schemaVersion,
    codeAwareMode: value.codeAwareMode,
    selectedCodebaseIds: value.selectedCodebaseIds,
    queriedCodebaseIds: value.queriedCodebaseIds,
    usedCodebaseIds: value.usedCodebaseIds,
    status: value.status,
    coverageComplete: value.coverageComplete,
  };
}

function normalizedBindings(value: any) {
  return (value || []).map((binding: any) => ({
    claimId: binding.claimId,
    mechanismStatus: binding.mechanismStatus,
    sourceReferenceIds: binding.sourceReferenceIds,
    traceEvidenceRefIds: binding.traceEvidenceRefIds,
  }));
}

function analysisResultApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use(
    '/api/workspaces/:workspaceId/analysis-results',
    bindWorkspaceRouteContext,
    authenticate,
    requireWorkspaceRouteContext,
    analysisResultRoutes,
  );
  return app;
}

async function finalizeCurrentSurfaceFixture(draft: AnalysisResult, envelope: DataEnvelope, sourceUse: SourceUseDecisionV1) {
  const runId = 'run-source-surfaces';
  const traceId = 'trace-source-surfaces';
  const store = new ArtifactStore();
  store.registerStandaloneEvidenceCapture(captureEvidenceTable(envelope.data, {
    blocked_ms: {unit: 'ms', origin: {kind: 'native_producer', definitionFingerprint: 'source-surface-fixture'}},
  }), {meta: envelope.meta, display: envelope.display});
  const registry = buildStrategyRegistrySnapshotFromDefinitions({definitions: getRegisteredScenes(), overlayGeneration: runId});
  const candidate = {runId, attemptId: 'attempt-1', candidateRef: 'source-surfaces:1',
    conclusionFingerprint: analysisDeliveryFingerprint(draft.conclusion)};
  attachFinalizationContext(draft, {runId, sessionId: draft.sessionId, deadlineMs: Date.now() + 10_000,
    strategyRegistry: registry, traceIdentity: {currentTraceId: traceId}, sourceUse,
    turnIntent: {schemaVersion: 1, status: 'resolved', source: 'semantic', taskKind: 'fact', sceneId: 'general',
      scope: 'bounded_question', recommendedComplexity: 'quick', deliverable: 'answer', evidenceAccess: 'existing_only',
      registryFingerprint: registry.registryFingerprint},
    deliveryContext: {entry: 'runtime_draft', acceptedCandidate: candidate, outputOrigin: 'sdk_final',
      completion: {...candidate, schemaVersion: 1, status: 'completed', runtimeKind: 'openai-agents-sdk'}},
    evidenceReadView: store.createEvidenceReadView({ownerKey: runId,
      allowedTraces: [{traceId, traceSide: 'current'}]}),
    // Deterministic semantic transport fixture; the real finalizer still requires captured proof.
    dispatchText: async () => ({status: 'ok', text: JSON.stringify({schemaVersion: 'final_semantic_response@1',
      bodyCoverage: {status: 'complete', reviewedSpans: [{start: 0, end: draft.conclusion.length}]},
      claims: [{claimId: 'claim-1', consistency: 'consistent',
        contentLocations: [{start: 0, end: draft.conclusion.length, text: draft.conclusion}], issues: []}],
      omissions: [], requirements: []})}),
  });
  return finalizeAnalysisResult({result: draft, context: takeFinalizationContext(draft),
    owner: {runId, signal: new AbortController().signal, isCurrent: () => true, assertAuthorized: () => {}},
    query: 'What does the captured trace report?', dataEnvelopes: [envelope]});
}

describe('source provenance output surface matrix', () => {
  const cliSurfaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'smartperfetto-source-cli-surfaces-'));
  const cliSurfaceHome = path.join(cliSurfaceRoot, 'cli-home');
  const cliSurfaceEnv = path.join(cliSurfaceRoot, 'empty.env');
  fs.writeFileSync(cliSurfaceEnv, '', 'utf8');

  afterAll(() => fs.rmSync(cliSurfaceRoot, {recursive: true, force: true}));

  it.each(['src/main/Foo.kt', 'src/功能目录/My Feature/Foo.kt'])(
    'keeps current-run source %s across SSE, report, CLI, snapshot, and API readback', async filePath => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'smartperfetto-source-surfaces-'));
    const dbPath = path.join(tempRoot, 'enterprise.db');
    const cliHome = cliSurfaceHome;
    process.env.SMARTPERFETTO_ENTERPRISE_DB_PATH = dbPath;
    const reference = sanitizeSourceReference({
      referenceId: 'lookup-surface-1',
      codebaseId: 'safe-app',
      filePath,
      lineRange: {start: 10, end: 12},
      symbol: 'Foo.run',
      lookupKind: 'body',
    })!;
    const sourceUseDecision = {
      schemaVersion: 'source_use_decision@1' as const,
      codeAwareMode: 'provider_send' as const,
      selectedCodebaseIds: ['safe-app'],
      status: 'corroborated' as const,
      attemptedTools: ['read_codebase_file'],
      queriedCodebaseIds: ['safe-app'],
      usedCodebaseIds: ['safe-app'],
      coverageComplete: true,
      references: [{
        ...reference,
        rootPath: '/Users/chris/private-source',
        snippet: 'SECRET_SNIPPET_CANARY',
        query: 'SECRET_QUERY_CANARY',
      } as any],
    };
    const body = 'The trace reports 120 ms blocked.';
    const traceReference = {evidenceRefId: 'trace-evidence-1', rowIndex: 0, column: 'blocked_ms', value: 120};
    const declaration = parseConclusionContractDeclaration({
      schemaVersion: 'conclusion_contract_v1',
      mode: 'focused_answer',
      conclusions: [{rank: 1, statement: body}],
      clusters: [],
      evidenceChain: [],
      claims: [{
        id: 'claim-1',
        kind: 'numeric',
        text: body,
        references: [traceReference],
        semantics: {schemaVersion: 'claim_semantics@1', predicate: 'numeric.cell', polarity: 'affirmed',
          discourse: 'asserted', quantifier: 'one', modality: 'certain',
          scope: {population: 'cited_rows', subjectRefs: [traceReference]}, numeric: {operator: 'eq', value: 120, unit: 'ms'}},
      }],
      sourceUseDecision,
      sourceReferences: sourceUseDecision.references,
      sourceClaimBindings: [{
        claimId: 'claim-1',
        mechanismStatus: 'compatible',
        sourceReferenceIds: [reference.id],
        traceEvidenceRefIds: ['trace-evidence-1'],
        reason: 'SECRET_BINDING_REASON_CANARY',
      }],
      uncertainties: [],
      nextSteps: [],
    });
    const draft: AnalysisResult = {
      sessionId: 'session-source-surfaces',
      success: true,
      findings: [],
      hypotheses: [],
      conclusion: body,
      conclusionContract: declaration.contract ?? undefined,
      sourceUseDecision,
      sourceReferences: sourceUseDecision.references,
      confidence: 0.8,
      rounds: 1,
      totalDurationMs: 20,
    };
    const reportId = `source-surfaces-${Date.now()}`;

    try {
      expect(declaration.issues).toEqual([]);
      if (!declaration.contract) throw new Error('Expected a valid source-surface declaration');
      const envelope = createDataEnvelope({columns: ['blocked_ms'], rows: [[120]]}, {
        type: 'sql_result', source: 'execute_sql', title: 'Observed blocking duration',
        evidenceRefId: 'trace-evidence-1', traceId: 'trace-source-surfaces', traceSide: 'current', executionStatus: 'observed',
      });
      // The runtime-owned ledger is separate from the model's source declarations.
      const actualSourceUse = sanitizeSourceUseDecision(sourceUseDecision)!;
      const finalized = await finalizeCurrentSurfaceFixture(draft, envelope, actualSourceUse);
      const result = finalized.result;
      const contract = result.conclusionContract!;
      expect(finalized.semanticAssessment?.coverage).toMatchObject({body: 'complete', claims: 'complete'});
      expect(result.completion).toMatchObject({status: 'completed', candidateRef: 'source-surfaces:1',
        conclusionFingerprint: analysisDeliveryFingerprint(body)});
      expect(result.claimVerificationResult).toMatchObject({schemaVersion: 'claim_verifier@2', status: 'passed', passed: true,
        claimResults: [{claimId: 'claim-1', status: 'verified', deterministicProof: {status: 'proved'}}]});
      expect(result.sourceClaimVerificationResult?.bindings).toEqual([expect.objectContaining({
        claimId: 'claim-1', mechanismStatus: 'compatible', sourceReferenceIds: [reference.id], traceEvidenceRefIds: ['trace-evidence-1'],
      })]);
      expect(result.conclusion).toBe(body);
      expect(JSON.stringify(result)).not.toContain('SECRET_');
      expect(JSON.stringify(result)).not.toContain('/Users/chris/private-source');
      // JSON surfaces omit optional undefined fields; derive their expected shape
      // from the canonical result, never from another surface's projection.
      const wireResult = JSON.parse(JSON.stringify(result)) as AnalysisResult;
      const initialSseData = agentRoutesPrivacyProjectionTestSeam.analysisCompletedData({
        ...result,
        privateProjectionVersion: 1,
      }, result.sourceUseDecision);
      const sseEvent = agentRoutesPrivacyProjectionTestSeam.sanitizePersistedAnalysisCompletedEvent(
        {
          sessionId: result.sessionId,
          query: 'analyze Foo.run',
          traceId: 'trace-source-surfaces',
          codeAwareMode: 'provider_send',
          codebaseIds: ['safe-app'],
          dataEnvelopes: [envelope],
          result,
        } as any,
        {
          eventType: 'analysis_completed',
          eventData: JSON.stringify({
            type: 'analysis_completed',
            data: initialSseData,
            timestamp: 1,
          }),
          createdAt: 1,
        } as any,
      );
      const sseResult = JSON.parse(sseEvent.eventData).data;
      const sseContract = sseResult.conclusionContract;
      expect(sseResult).toMatchObject({success: true, conclusion: body,
        completion: wireResult.completion, claimVerificationResult: wireResult.claimVerificationResult});
      expect(JSON.stringify(initialSseData)).not.toContain('/Users/chris/private-source');
      expect(JSON.stringify(initialSseData)).not.toContain('SECRET_');

      const reportData = buildAgentDrivenReportData({
        session: {
          sessionId: result.sessionId,
          traceId: 'trace-source-surfaces',
          query: 'analyze Foo.run',
          codeAwareMode: 'provider_send',
          codebaseIds: ['safe-app'],
          outputLanguage: 'en',
          orchestrator: {},
          hypotheses: [],
          agentDialogue: [],
          conversationSteps: [],
          dataEnvelopes: [envelope],
          agentResponses: [],
          runSequence: 1,
          _lastSnapshot: {
            codebaseSnapshot: [{
              codebaseId: 'safe-app',
              displayName: 'Safe App',
              kind: 'app_source',
              indexGeneration: 1,
            }],
            codeLookupSummary: {
              lookupCount: 1,
              patchCount: 0,
              referencedCodebaseIds: ['safe-app'],
              usedCodebaseIds: ['safe-app'],
            },
          },
        } as any,
        result,
      });
      expect(reportData.result.claimVerificationResult).toEqual(result.claimVerificationResult);
      const html = new HTMLReportGenerator().generateAgentDrivenHTML(reportData);
      expect(html).toContain(filePath);
      expect(sseContract.sourceUseDecision.references[0]).toMatchObject({filePath, lineRange: {start: 10, end: 12}});
      persistReport(reportId, {
        html,
        generatedAt: 1,
        sessionId: result.sessionId,
        runId: 'run-source-surfaces',
        traceId: 'trace-source-surfaces',
        privateContext: {codebase: true, knowledge: false},
      });

      const paths = computePaths(cliHome);
      ensureLayout(paths);
      const sp = sessionPaths(paths, result.sessionId);
      ensureSessionLayout(sp);
      const cliResult: RunTurnOutput = {
        sessionId: result.sessionId,
        traceId: 'trace-source-surfaces',
        codeAwareMode: 'provider_send',
        privateKnowledge: true,
        reportHtml: html,
        result,
      };
      commitTurnOutputs({
        paths,
        sp,
        renderer: rendererStub(),
        sessionId: result.sessionId,
        turn: 1,
        query: 'analyze Foo.run',
        result: cliResult,
        config: {
          sessionId: result.sessionId,
          backendSessionId: result.sessionId,
          tracePath: '/tmp/trace.perfetto-trace',
          traceId: 'trace-source-surfaces',
          createdAt: 1,
          lastTurnAt: 2,
          turnCount: 1,
        },
        turnMarkdown: '# Turn 1\n\n## Conclusion\n\n' + body + '\n',
        indexEntry: {
          sessionId: result.sessionId,
          createdAt: 1,
          lastTurnAt: 2,
          tracePath: '/tmp/trace.perfetto-trace',
          traceFilename: 'trace.perfetto-trace',
          firstQuery: 'analyze Foo.run',
          turnCount: 1,
          status: 'completed',
        },
      });
      const cliDecision = JSON.parse(fs.readFileSync(
        path.join(sp.turnsDir, '001.source-use-decision.json'),
        'utf8',
      ));
      const cliBindings = JSON.parse(fs.readFileSync(
        path.join(sp.turnsDir, '001.source-claim-bindings.json'),
        'utf8',
      ));
      const cliVerification = JSON.parse(fs.readFileSync(path.join(sp.turnsDir, '001.claim-verification.json'), 'utf8'));
      expect(cliVerification).toEqual(wireResult.claimVerificationResult);
      const cliEvidence = JSON.parse(fs.readFileSync(path.join(sp.turnsDir, '001.analysis-evidence.json'), 'utf8'));
      expect(cliEvidence.evidence).not.toBeNull();
      const canonicalTurnBody = '# Turn 1\n\n## Conclusion\n\n' + body + '\n';
      expect(fs.readFileSync(path.join(sp.turnsDir, '001.md'), 'utf8')).toBe(canonicalTurnBody);
      const cliMarkdownExport = path.join(tempRoot, 'cli-export.md');
      const consoleLog = jest.spyOn(console, 'log').mockImplementation(() => undefined);
      let cliShow = '';
      try {
        expect(await runShowCommand({sessionId: result.sessionId, open: false, envFile: cliSurfaceEnv, sessionDir: cliHome})).toBe(0);
        cliShow = consoleLog.mock.calls.map(call => String(call[0])).join('\n');
        expect(await runReportExportCommand({sessionId: result.sessionId, format: 'md', out: cliMarkdownExport,
          envFile: cliSurfaceEnv, sessionDir: cliHome})).toBe(0);
      } finally {
        consoleLog.mockRestore();
      }
      const cliMarkdown = fs.readFileSync(cliMarkdownExport, 'utf8');
      for (const rendered of [cliShow, cliMarkdown]) {
        expect(rendered).toContain('source_use_decision@1');
        expect(rendered).toContain(reference.id);
        expect(rendered).toContain(filePath);
        expect(rendered).toContain('claim-1');
        expect(rendered).toContain('compatible');
        expect(rendered).not.toContain('/Users/chris/private-source');
        expect(rendered).not.toContain('SECRET_');
      }

      const snapshot = persistCompletedAnalysisResultSnapshot({
        tenantId: DEFAULT_TENANT_ID,
        workspaceId: 'workspace-source-surfaces',
        userId: DEFAULT_DEV_USER_ID,
        traceId: 'trace-source-surfaces',
        sessionId: result.sessionId,
        runId: 'run-source-surfaces',
        reportId,
        query: 'analyze Foo.run',
        conclusion: result.conclusion,
        conclusionContract: contract,
        ...copyAnalysisDeliveryFields(result),
        sourceUseDecision: result.sourceUseDecision,
        sourceClaimVerificationResult: result.sourceClaimVerificationResult,
        success: result.success,
        claimSupport: result.claimSupport,
        claimVerificationResult: result.claimVerificationResult,
        identityResolutions: result.identityResolutions,
        dataEnvelopes: [envelope],
        privateContext: {codebase: true, knowledge: false},
        outputLanguage: 'en',
        confidence: result.confidence,
      });
      expect(snapshot).not.toBeNull();
      const snapshotContract = snapshot!.conclusionContract as ConclusionContract;
      expect(snapshot!.claimVerificationResult).toEqual(wireResult.claimVerificationResult);
      expect(snapshot!.summary.completion).toEqual(wireResult.completion);

      const reportResponse = await request(express().use('/api/reports', reportRoutes))
        .get(`/api/reports/${reportId}`)
        .expect(200);
      const snapshotResponse = await request(analysisResultApp())
        .get(`/api/workspaces/workspace-source-surfaces/analysis-results/${snapshot!.id}`)
        .set('x-tenant-id', DEFAULT_TENANT_ID)
        .expect(200);
      const apiContract = snapshotResponse.body.snapshot.conclusionContract;
      expect(snapshotResponse.body.snapshot.claimVerificationResult).toEqual(wireResult.claimVerificationResult);
      expect(snapshotResponse.body.snapshot.summary.completion).toEqual(wireResult.completion);

      const expectedDecision = normalizedDecision(wireResult.sourceUseDecision);
      const expectedBindings = normalizedBindings(wireResult.conclusionContract?.sourceClaimBindings);
      expect(expectedBindings).toEqual([{claimId: 'claim-1', mechanismStatus: 'compatible',
        sourceReferenceIds: [reference.id], traceEvidenceRefIds: ['trace-evidence-1']}]);
      const surfaces = [
        {name: 'sse', decision: sseContract.sourceUseDecision, bindings: sseContract.sourceClaimBindings},
        {
          name: 'report-data',
          decision: reportData.sourceContext?.sourceUseDecision,
          bindings: reportData.sourceContext?.sourceClaimBindings,
        },
        {name: 'cli', decision: cliDecision, bindings: cliBindings},
        {
          name: 'snapshot',
          decision: snapshotContract.sourceUseDecision,
          bindings: snapshotContract.sourceClaimBindings,
        },
        {name: 'snapshot-api', decision: apiContract.sourceUseDecision, bindings: apiContract.sourceClaimBindings},
      ];
      for (const surface of surfaces) {
        expect({name: surface.name, value: normalizedDecision(surface.decision)})
          .toEqual({name: surface.name, value: expectedDecision});
        expect({name: surface.name, value: normalizedBindings(surface.bindings)})
          .toEqual({name: surface.name, value: expectedBindings});
      }
      expect(reportResponse.text).toContain('source_use_decision@1');
      expect(reportResponse.text).toContain(reference.id);
      const cliHtml = fs.readFileSync(path.join(sp.turnsDir, '001.html'), 'utf8');
      expect(cliHtml).toContain('source_use_decision@1');
      expect(cliHtml).toContain(reference.id);

      const durableArtifacts = JSON.stringify({
        sseResult,
        sseContract,
        reportResult: reportData.result,
        sourceContext: reportData.sourceContext,
        cliDecision,
        cliBindings,
        cliVerification,
        cliShow,
        cliMarkdown,
        snapshotContract,
        apiContract,
        reportHtml: reportResponse.text,
        cliHtml,
      });
      expect(durableArtifacts).not.toContain('/Users/chris/private-source');
      expect(durableArtifacts).not.toContain('SECRET_');
    } finally {
      if (originalDbPath === undefined) {
        delete process.env.SMARTPERFETTO_ENTERPRISE_DB_PATH;
      } else {
        process.env.SMARTPERFETTO_ENTERPRISE_DB_PATH = originalDbPath;
      }
      reportStore.delete(reportId);
      fs.rmSync(path.join(backendLogPath('reports'), `${reportId}.html`), {force: true});
      fs.rmSync(path.join(backendLogPath('reports'), `${reportId}.meta.json`), {force: true});
      fs.rmSync(tempRoot, {recursive: true, force: true});
    }
  });
});
