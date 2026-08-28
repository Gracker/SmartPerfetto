// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import express from 'express';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import request from 'supertest';

import type {ConclusionContract} from '../../agent/core/conclusionContract';
import type {RunTurnOutput} from '../../cli-user/services/cliAnalyzeService';
import {commitTurnOutputs} from '../../cli-user/services/turnPersistence';
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
import {sanitizeSourceReference} from '../codebase/sourceUseDecision';
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

describe('source provenance output surface matrix', () => {
  it('keeps one canonical current-run decision and binding across SSE, report, CLI, snapshot, and API readback', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'smartperfetto-source-surfaces-'));
    const dbPath = path.join(tempRoot, 'enterprise.db');
    const cliHome = path.join(tempRoot, 'cli-home');
    process.env.SMARTPERFETTO_ENTERPRISE_DB_PATH = dbPath;
    const reference = sanitizeSourceReference({
      referenceId: 'lookup-surface-1',
      codebaseId: 'safe-app',
      filePath: 'src/main/Foo.kt',
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
    const contract: ConclusionContract = {
      schemaVersion: 'conclusion_contract_v1',
      mode: 'focused_answer',
      conclusions: [{rank: 1, statement: 'Foo.run is compatible with the trace.'}],
      clusters: [],
      evidenceChain: [],
      claims: [{
        id: 'claim-1',
        kind: 'causal',
        text: 'Foo.run is compatible with the trace.',
        references: [{evidenceRefId: 'trace-evidence-1'}],
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
    };
    const result = {
      sessionId: 'session-source-surfaces',
      success: true,
      findings: [],
      hypotheses: [],
      conclusion: 'Foo.run is compatible with the trace.',
      conclusionContract: contract,
      sourceUseDecision,
      sourceReferences: sourceUseDecision.references,
      claimVerificationResult: {
        schemaVersion: 'claim_verifier@1' as const,
        status: 'passed' as const,
        policy: 'record_only' as const,
        passed: true,
        checkedClaimCount: 1,
        unsupportedClaimCount: 0,
        claimResults: [{
          claimId: 'claim-1',
          status: 'verified' as const,
          referenceResults: [{evidenceRefId: 'trace-evidence-1', status: 'matched' as const}],
        }],
        issues: [],
      },
      confidence: 0.8,
      rounds: 1,
      totalDurationMs: 20,
    };
    const reportId = `source-surfaces-${Date.now()}`;

    try {
      const initialSseData = agentRoutesPrivacyProjectionTestSeam.analysisCompletedData({
        privateProjectionVersion: 1,
        conclusion: result.conclusion,
        conclusionContract: contract,
        findings: [],
        hypotheses: [],
        confidence: result.confidence,
        rounds: result.rounds,
        totalDurationMs: result.totalDurationMs,
      }, result.sourceUseDecision);
      const sseEvent = agentRoutesPrivacyProjectionTestSeam.sanitizePersistedAnalysisCompletedEvent(
        {
          sessionId: result.sessionId,
          query: 'analyze Foo.run',
          traceId: 'trace-source-surfaces',
          codeAwareMode: 'provider_send',
          codebaseIds: ['safe-app'],
          dataEnvelopes: [],
          result: {sourceUseDecision: result.sourceUseDecision},
        } as any,
        {
          eventType: 'analysis_completed',
          eventData: JSON.stringify({
            type: 'analysis_completed',
            data: {
              privateProjectionVersion: 1,
              conclusion: result.conclusion,
              conclusionContract: initialSseData.conclusionContract,
              findings: [],
              hypotheses: [],
              confidence: result.confidence,
              rounds: result.rounds,
              totalDurationMs: result.totalDurationMs,
            },
            timestamp: 1,
          }),
          createdAt: 1,
        } as any,
      );
      const sseContract = JSON.parse(sseEvent.eventData).data.conclusionContract;
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
          dataEnvelopes: [],
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
      const html = new HTMLReportGenerator().generateAgentDrivenHTML(reportData);
      persistReport(reportId, {
        html,
        generatedAt: 1,
        sessionId: result.sessionId,
        runId: 'run-source-surfaces',
        traceId: 'trace-source-surfaces',
      });

      const paths = computePaths(cliHome);
      ensureLayout(paths);
      const sp = sessionPaths(paths, result.sessionId);
      ensureSessionLayout(sp);
      const cliResult: RunTurnOutput = {
        sessionId: result.sessionId,
        traceId: 'trace-source-surfaces',
        codeAwareMode: 'provider_send',
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
        turnMarkdown: '# Turn 1\n\n## Conclusion\n\nFoo.run is compatible with the trace.\n',
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
        sourceUseDecision,
        claimVerificationResult: result.claimVerificationResult,
        confidence: result.confidence,
      });
      expect(snapshot).not.toBeNull();
      const snapshotContract = snapshot!.conclusionContract as ConclusionContract;

      const reportResponse = await request(express().use('/api/reports', reportRoutes))
        .get(`/api/reports/${reportId}`)
        .expect(200);
      const snapshotResponse = await request(analysisResultApp())
        .get(`/api/workspaces/workspace-source-surfaces/analysis-results/${snapshot!.id}`)
        .set('x-tenant-id', DEFAULT_TENANT_ID)
        .expect(200);
      const apiContract = snapshotResponse.body.snapshot.conclusionContract;

      const expectedDecision = normalizedDecision(cliDecision);
      const expectedBindings = normalizedBindings(cliBindings);
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
      expect(fs.readFileSync(path.join(sp.turnsDir, '001.md'), 'utf8'))
        .toContain('source_use_decision@1');
      const cliHtml = fs.readFileSync(path.join(sp.turnsDir, '001.html'), 'utf8');
      expect(cliHtml).toContain('source_use_decision@1');
      expect(cliHtml).toContain(reference.id);

      const durableArtifacts = JSON.stringify({
        sseContract,
        sourceContext: reportData.sourceContext,
        cliDecision,
        cliBindings,
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
