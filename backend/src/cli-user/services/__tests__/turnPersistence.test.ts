// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, expect, it, jest } from '@jest/globals';
import { computePaths, ensureLayout, ensureSessionLayout, sessionPaths } from '../../io/paths';
import { commitSourceSupplementOutput, commitTurnOutputs } from '../turnPersistence';
import {loadCliAnalysisEvidence} from '../analysisResultPresentation';
import {latestCliSceneReportPath, loadCliSceneReport, turnCliSceneReportPath} from '../sceneReportReference';
import type { Renderer } from '../../repl/renderer';
import type { RunTurnOutput } from '../cliAnalyzeService';
import {clearCodeAwareOutputGuards, registerCodeAwareCanary} from '../../../services/security/codeAwareOutputRegistry';
import {routeAdaptiveEvidencePreflight} from '../../../agentRuntime/adaptiveEvidenceRouter';
import {sanitizeSourceReference} from '../../../services/codebase/sourceUseDecision';

function rendererStub(): Renderer {
  return {
    format: 'text',
    onEvent: jest.fn(),
    printError: jest.fn(),
    printConclusion: jest.fn(),
    printCompletion: jest.fn(),
    printLine: jest.fn(),
  } as unknown as Renderer;
}

describe('commitTurnOutputs', () => {
  it('persists a bound scene reference, rebinds supplements and clears latest on an ordinary next turn', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'smartperfetto-cli-scene-'));
    const paths = computePaths(home); ensureLayout(paths);
    const sessionId = 'scene-cli-session', sp = sessionPaths(paths, sessionId), renderer = rendererStub();
    const sceneReport = {schemaVersion: 'scene_report_ref@1' as const, reportId: 'scene-v3-cli', traceId: 'trace',
      sessionId, runId: 'run', revision: 1, expiresAt: Date.now() + 60_000, manifestSha256: 'a'.repeat(64)};
    const result: RunTurnOutput = {sessionId, traceId: 'trace', codeAwareMode: 'off', reportHtml: '<html>scene report</html>',
      result: {sessionId, success: true, conclusion: 'body', findings: [], hypotheses: [], confidence: 0.5, rounds: 1, totalDurationMs: 1,
        sceneReport, sceneTimeline: {schemaVersion: 'scene_timeline@1', sessionId, traceId: 'trace', runId: 'run', revision: 1,
          status: 'partial', segments: [], unresolved: ['RAW_SCENE_HISTORY_CANARY'], diagnostics: [],
          coverage: {status: 'unknown', captureStatus: 'unknown', reason: 'missing', sources: []}}}};
    const initial = '# Turn 1\n\nbody\n';
    const commit = (turn: number, markdown: string) => commitTurnOutputs({paths, sp, renderer, sessionId, turn, query: 'query', result,
      config: {sessionId, tracePath: '/tmp/trace', traceId: 'trace', createdAt: 1, lastTurnAt: turn, turnCount: turn}, turnMarkdown: markdown,
      indexEntry: {sessionId, createdAt: 1, lastTurnAt: turn, tracePath: '/tmp/trace', traceFilename: 'trace',
        firstQuery: 'query', turnCount: turn, status: 'completed'}});
    try {
      const analysisEvidence = commit(1, initial);
      expect(JSON.parse(fs.readFileSync(turnCliSceneReportPath(sp, 1), 'utf8'))).toMatchObject({status: 'available', reference: sceneReport});
      expect(renderer.printCompletion).toHaveBeenCalledWith(expect.objectContaining({sceneReport, sceneReportStatus: 'partial'}));
      expect(fs.readFileSync(sp.transcript, 'utf8')).not.toContain('RAW_SCENE_HISTORY_CANARY');
      expect(JSON.parse(fs.readFileSync(sp.transcript, 'utf8').trim()).history).not.toHaveProperty('sceneReport');
      commitSourceSupplementOutput({sp, renderer, sessionId, turn: 1, analysisEvidence,
        supplement: {message: 'Source supplement.', metrics: {searchCalls: 1, readCalls: 1, durationMs: 1}}});
      const supplemented = fs.readFileSync(path.join(sp.turnsDir, '001.md'), 'utf8');
      expect(loadCliSceneReport({sp, sessionId, turn: 1, conclusion: 'body', turnMarkdown: supplemented, latest: true}).status).toBe('available');
      delete result.result.sceneReport; delete result.result.sceneTimeline;
      commit(2, '# Turn 2\n\nbody\n');
      expect(JSON.parse(fs.readFileSync(latestCliSceneReportPath(sp), 'utf8'))).toMatchObject({status: 'none', reference: null, binding: {turn: 2}});
      expect(loadCliSceneReport({sp, sessionId, turn: 1, conclusion: 'body', turnMarkdown: supplemented}).status).toBe('available');
    } finally {fs.rmSync(home, {recursive: true, force: true});}
  });
  it('rebinds per-turn and latest evidence after appending a source supplement', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'smartperfetto-cli-source-supplement-'));
    const paths = computePaths(home);
    ensureLayout(paths);
    const sessionId = 'session-source-supplement';
    const sp = sessionPaths(paths, sessionId);
    ensureSessionLayout(sp);
    const renderer = rendererStub();
    const result: RunTurnOutput = {
      sessionId,
      traceId: 'trace-1',
      codeAwareMode: 'provider_send',
      result: {
        sessionId, success: true, findings: [], hypotheses: [], conclusion: 'Primary conclusion.',
        confidence: 0.8, rounds: 1, totalDurationMs: 1,
      },
    };
    const initialMarkdown = '# Turn 1\n\nPrimary conclusion.\n';
    try {
      const analysisEvidence = commitTurnOutputs({
        paths, sp, renderer, sessionId, turn: 1, query: 'query', result,
        config: {sessionId, tracePath: '/tmp/trace', traceId: 'trace-1', createdAt: 1, lastTurnAt: 2, turnCount: 1},
        turnMarkdown: initialMarkdown,
        indexEntry: {sessionId, createdAt: 1, lastTurnAt: 2, tracePath: '/tmp/trace', traceFilename: 'trace',
          firstQuery: 'query', turnCount: 1, status: 'completed'},
      });
      commitSourceSupplementOutput({
        sp, renderer, sessionId, turn: 1, analysisEvidence,
        supplement: {message: 'Bounded source follow-up.', metrics: {searchCalls: 1, readCalls: 2, durationMs: 3}},
      });

      const turnMarkdown = fs.readFileSync(path.join(sp.turnsDir, '001.md'), 'utf8');
      expect(turnMarkdown).toContain('Bounded source follow-up.');
      expect(loadCliAnalysisEvidence({sp, sessionId, turn: 1, conclusion: 'Primary conclusion.', turnMarkdown}))
        .toMatchObject({status: 'available'});
      expect(loadCliAnalysisEvidence({sp, sessionId, turn: 1, conclusion: 'Primary conclusion.', turnMarkdown, latest: true}))
        .toMatchObject({status: 'available'});
      expect(JSON.parse(fs.readFileSync(path.join(sp.dir, 'analysis-evidence.json'), 'utf8')))
        .toEqual(JSON.parse(fs.readFileSync(path.join(sp.turnsDir, '001.analysis-evidence.json'), 'utf8')));
    } finally {
      fs.rmSync(home, {recursive: true, force: true});
    }
  });

  it('keeps the conclusion durable when evidence projection is unavailable', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'smartperfetto-cli-evidence-unavailable-'));
    const paths = computePaths(home);
    ensureLayout(paths);
    const sessionId = 'session-evidence-unavailable';
    const sp = sessionPaths(paths, sessionId);
    ensureSessionLayout(sp);
    const renderer = rendererStub();
    const result: RunTurnOutput = {
      sessionId,
      traceId: 'trace-1',
      codeAwareMode: 'off',
      result: {
        sessionId, success: true, findings: [], hypotheses: [], conclusion: 'body remains',
        confidence: 0.5, rounds: 1, totalDurationMs: 1,
        conclusionContract: {
          schemaVersion: 'conclusion_contract_v1', mode: 'focused_answer', conclusions: [], clusters: [], evidenceChain: [],
          claims: [{text: 'claim', references: [{rowSelector: {invalid: undefined as never}}]}],
          uncertainties: [], nextSteps: [],
        },
      },
    };
    try {
      commitTurnOutputs({
        paths, sp, renderer, sessionId, turn: 1, query: 'query', result,
        config: {sessionId, tracePath: '/tmp/trace', traceId: 'trace-1', createdAt: 1, lastTurnAt: 2, turnCount: 1},
        turnMarkdown: '# Turn 1\n\nbody remains\n',
        indexEntry: {sessionId, createdAt: 1, lastTurnAt: 2, tracePath: '/tmp/trace', traceFilename: 'trace',
          firstQuery: 'query', turnCount: 1, status: 'completed'},
      });
      expect(fs.readFileSync(sp.conclusion, 'utf8')).toBe('body remains');
      expect(JSON.parse(fs.readFileSync(path.join(sp.dir, 'analysis-evidence.json'), 'utf8'))).toMatchObject({
        schemaVersion: 'cli_analysis_evidence@1', evidence: null,
        unavailableReason: 'analysis_evidence_projection_invalid',
      });
      expect(renderer.printConclusion).toHaveBeenCalledWith('body remains', expect.objectContaining({
        analysisEvidence: expect.objectContaining({evidence: null}),
      }));
    } finally {
      fs.rmSync(home, {recursive: true, force: true});
    }
  });

  it('writes analysis receipt sidecars with the CLI turn path', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'smartperfetto-cli-receipt-'));
    const paths = computePaths(home);
    ensureLayout(paths);
    const sp = sessionPaths(paths, 'session-receipt');
    ensureSessionLayout(sp);
    const result: RunTurnOutput = {
      sessionId: 'session-receipt',
      traceId: 'trace-receipt',
      codeAwareMode: 'off',
      result: {
        sessionId: 'session-receipt',
        success: true,
        findings: [],
        hypotheses: [],
        conclusion: 'ok',
        confidence: 0.8,
        rounds: 1,
        totalDurationMs: 1000,
        analysisReceipt: {
          schemaVersion: 1,
          runId: 'run-receipt',
          sessionId: 'session-receipt',
          traceId: 'trace-receipt',
          mode: 'auto',
          resolvedMode: 'full',
          adaptiveRouting: routeAdaptiveEvidencePreflight({
            requestedMode: 'auto',
            resolvedMode: 'full',
            classifierIntent: 'semantic_full',
            classifierSource: 'runtime',
            hardObligations: [],
          }),
          providerId: null,
          generatedAt: 1,
          traceEvidence: {
            sqlCount: 0,
            skillCount: 0,
            dataEnvelopeCount: 0,
            artifactCount: 0,
            evidenceRefCount: 0,
          },
          nonEvidenceContext: {
            frontendPrequeryCount: 0,
            memoryHintCount: 0,
            conversationContextCount: 0,
            strategyHintCount: 0,
          },
          claimAudit: {
            totalClaims: 0,
            verifiedClaims: 0,
            unsupportedClaims: 0,
            uncertainClaims: 0,
          },
          qualityGates: {
            finalReportContract: 'not_applicable',
            claimVerification: 'not_applicable',
            identityResolution: 'not_applicable',
          },
          outputs: {
            cliTurnPath: path.join(sp.turnsDir, '001.md'),
          },
          capabilityManifest: {
            schemaVersion: 'capability_manifest_attribution@1',
            resolution: {status: 'failed', reason: 'capability_manifest_build_failed'},
            probeCache: {hits: 0, misses: 0, bypasses: 1},
          },
        },
        uiActionProposals: [{
          schemaVersion: 1,
          id: 'ui-pin_evidence-1',
          kind: 'pin_evidence',
          title: '固定证据',
          reason: '用于后续追问',
          source: { evidenceRefId: 'ev-1' },
          payload: { evidenceRefId: 'ev-1' },
          requiresConfirmation: true,
        }],
      },
    };

    const runtimePerformance = {schemaVersion: 1 as const, phases: [], tools: [], sql: [],
      modelCalls: [{purpose: 'answer_turn' as const, startOffsetMs: 1, durationMs: 2, outcome: 'ok' as const}]};
    result.runtimePerformance = runtimePerformance;
    try {
      commitTurnOutputs({
        paths,
        sp,
        renderer: rendererStub(),
        sessionId: 'session-receipt',
        turn: 1,
        query: 'analyze',
        result,
        config: {
          sessionId: 'session-receipt',
          backendSessionId: 'session-receipt',
          tracePath: '/tmp/trace.perfetto-trace',
          traceId: 'trace-receipt',
          createdAt: 1,
          lastTurnAt: 2,
          turnCount: 1,
        },
        turnMarkdown: 'ok',
        indexEntry: {
          sessionId: 'session-receipt',
          createdAt: 1,
          lastTurnAt: 2,
          tracePath: '/tmp/trace.perfetto-trace',
          traceFilename: 'trace.perfetto-trace',
          firstQuery: 'analyze',
          turnCount: 1,
          status: 'completed',
        },
      });

      expect(JSON.parse(fs.readFileSync(path.join(sp.turnsDir, '001.investigation-assessment.json'), 'utf-8'))).toBeNull();
      expect(JSON.parse(fs.readFileSync(path.join(sp.turnsDir, '001.delivery-assurance.json'), 'utf-8'))).toBeNull();
      expect(JSON.parse(fs.readFileSync(path.join(sp.turnsDir, '001.runtime-performance.json'), 'utf-8')))
        .toEqual(runtimePerformance);
      const latest = JSON.parse(fs.readFileSync(path.join(sp.dir, 'analysis-receipt.json'), 'utf-8'));
      const turn = JSON.parse(fs.readFileSync(path.join(sp.turnsDir, '001.analysis-receipt.json'), 'utf-8'));
      const latestActions = JSON.parse(fs.readFileSync(path.join(sp.dir, 'ui-action-proposals.json'), 'utf-8'));
      const turnActions = JSON.parse(fs.readFileSync(path.join(sp.turnsDir, '001.ui-action-proposals.json'), 'utf-8'));
      expect(latest.outputs.cliTurnPath).toBe(path.join(sp.turnsDir, '001.md'));
      expect(turn.outputs.cliTurnPath).toBe(path.join(sp.turnsDir, '001.md'));
      expect(result.result.analysisReceipt?.outputs.cliTurnPath).toBe(path.join(sp.turnsDir, '001.md'));
      expect(latest.capabilityManifest).toEqual(result.result.analysisReceipt?.capabilityManifest);
      expect(turn.capabilityManifest).toEqual(result.result.analysisReceipt?.capabilityManifest);
      expect(latest.adaptiveRouting).toEqual(result.result.analysisReceipt?.adaptiveRouting);
      expect(turn.adaptiveRouting).toEqual(result.result.analysisReceipt?.adaptiveRouting);
      expect(latestActions).toEqual([expect.objectContaining({ id: 'ui-pin_evidence-1' })]);
      expect(turnActions).toEqual([expect.objectContaining({ kind: 'pin_evidence' })]);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('writes canonical per-turn source provenance into JSON and Markdown without unsafe fields', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'smartperfetto-cli-source-provenance-'));
    const paths = computePaths(home);
    ensureLayout(paths);
    const sessionId = 'session-source-provenance';
    const sp = sessionPaths(paths, sessionId);
    ensureSessionLayout(sp);
    const reference = sanitizeSourceReference({
      referenceId: 'lookup-1',
      codebaseId: 'safe-app',
      filePath: 'src/main/Foo.kt',
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
    const result: RunTurnOutput = {
      sessionId,
      traceId: 'trace-source-provenance',
      codeAwareMode: 'provider_send',
      reportHtml: '<html><body>source report</body></html>',
      result: {
        sessionId,
        success: true,
        findings: [],
        hypotheses: [],
        conclusion: 'Foo.run is compatible with the trace.',
        confidence: 0.8,
        rounds: 1,
        totalDurationMs: 20,
        sourceUseDecision,
        sourceReferences: sourceUseDecision.references,
        conclusionContract: {
          schemaVersion: 'conclusion_contract_v1',
          mode: 'focused_answer',
          conclusions: [{rank: 1, statement: 'Foo.run is compatible with the trace.'}],
          clusters: [],
          evidenceChain: [],
          claims: [{
            id: 'claim-1',
            text: 'Foo.run is compatible with the trace.',
            references: [{evidenceRefId: 'trace-evidence-1', rowIndex: 0, column: 'value', value: null}],
            rawSemantics: 'RAW_SEMANTICS_CANARY',
            rawReferences: 'RAW_REFERENCES_CANARY',
            semanticsParseIssues: [{code: 'invalid_semantics', path: 'claims[0].semantics'}],
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
        },
      },
    };

    const renderer = rendererStub();
    const originalResult = structuredClone(result.result);
    try {
      commitTurnOutputs({
        paths,
        sp,
        renderer,
        sessionId,
        turn: 1,
        query: 'analyze Foo.run',
        result,
        config: {
          sessionId,
          backendSessionId: sessionId,
          tracePath: '/tmp/trace.perfetto-trace',
          traceId: 'trace-source-provenance',
          createdAt: 1,
          lastTurnAt: 2,
          turnCount: 1,
        },
        turnMarkdown: '# Turn 1\n\n## Conclusion\n\nFoo.run is compatible with the trace.\n',
        indexEntry: {
          sessionId,
          createdAt: 1,
          lastTurnAt: 2,
          tracePath: '/tmp/trace.perfetto-trace',
          traceFilename: 'trace.perfetto-trace',
          firstQuery: 'analyze Foo.run',
          turnCount: 1,
          status: 'completed',
        },
      });

      const latestDecisionPath = path.join(sp.dir, 'source-use-decision.json');
      const latestBindingsPath = path.join(sp.dir, 'source-claim-bindings.json');
      const turnDecisionPath = path.join(sp.turnsDir, '001.source-use-decision.json');
      const turnBindingsPath = path.join(sp.turnsDir, '001.source-claim-bindings.json');
      expect(fs.existsSync(latestDecisionPath)).toBe(true);
      expect(fs.existsSync(latestBindingsPath)).toBe(true);
      expect(fs.existsSync(turnDecisionPath)).toBe(true);
      expect(fs.existsSync(turnBindingsPath)).toBe(true);
      const storedDecision = JSON.parse(fs.readFileSync(turnDecisionPath, 'utf8'));
      const storedBindings = JSON.parse(fs.readFileSync(turnBindingsPath, 'utf8'));
      expect(storedDecision).toEqual(expect.objectContaining({
        schemaVersion: 'source_use_decision@1',
        codeAwareMode: 'provider_send',
        selectedCodebaseIds: ['safe-app'],
        queriedCodebaseIds: ['safe-app'],
        usedCodebaseIds: ['safe-app'],
        status: 'corroborated',
      }));
      expect(storedBindings).toEqual([{
        claimId: 'claim-1',
        mechanismStatus: 'compatible',
        sourceReferenceIds: [reference.id],
        traceEvidenceRefIds: ['trace-evidence-1'],
      }]);
      const markdown = fs.readFileSync(path.join(sp.turnsDir, '001.md'), 'utf8');
      expect(markdown).toBe('# Turn 1\n\n## Conclusion\n\nFoo.run is compatible with the trace.\n');
      const evidence = JSON.parse(fs.readFileSync(
        path.join(sp.turnsDir, '001.analysis-evidence.json'),
        'utf8',
      ));
      expect(evidence).toMatchObject({
        schemaVersion: 'cli_analysis_evidence@1',
        binding: {sessionId, turn: 1},
        evidence: {
          claims: [{id: 'claim-1', references: [{rowIndex: 0, value: null}]}],
          sourceUseDecision: {status: 'corroborated'},
          sourceReferences: [{id: reference.id}],
          sourceClaimBindings: [{claimId: 'claim-1', mechanismStatus: 'compatible'}],
        },
      });
      expect(JSON.stringify(evidence)).not.toContain('RAW_SEMANTICS_CANARY');
      expect(JSON.stringify(evidence)).not.toContain('RAW_REFERENCES_CANARY');
      expect(JSON.parse(fs.readFileSync(path.join(sp.dir, 'analysis-evidence.json'), 'utf8'))).toEqual(evidence);
      expect(renderer.printConclusion).toHaveBeenCalledWith(
        result.result.conclusion,
        expect.objectContaining({analysisEvidence: evidence}),
      );
      expect(result.result).toEqual(originalResult);
      const durableText = [storedDecision, storedBindings, evidence, markdown]
        .map(value => JSON.stringify(value))
        .join('\n');
      expect(durableText).not.toContain('/Users/chris');
      expect(durableText).not.toContain('SECRET_');
    } finally {
      fs.rmSync(home, {recursive: true, force: true});
    }
  });

  it('keeps source-free turns unchanged and clears only stale latest provenance', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'smartperfetto-cli-source-stale-'));
    const paths = computePaths(home);
    ensureLayout(paths);
    const sessionId = 'session-source-stale';
    const sp = sessionPaths(paths, sessionId);
    ensureSessionLayout(sp);
    const sourceFree: RunTurnOutput = {
      sessionId,
      traceId: 'trace-source-stale',
      codeAwareMode: 'off',
      result: {
        sessionId,
        success: true,
        findings: [],
        hypotheses: [],
        conclusion: 'Trace-only conclusion.',
        confidence: 0.8,
        rounds: 1,
        totalDurationMs: 20,
      },
    };
    const input = (turn: number, result: RunTurnOutput, turnMarkdown: string) => ({
      paths,
      sp,
      renderer: rendererStub(),
      sessionId,
      turn,
      query: 'trace only',
      result,
      config: {
        sessionId,
        backendSessionId: sessionId,
        tracePath: '/tmp/trace.perfetto-trace',
        traceId: 'trace-source-stale',
        createdAt: 1,
        lastTurnAt: turn + 1,
        turnCount: turn,
      },
      turnMarkdown,
      indexEntry: {
        sessionId,
        createdAt: 1,
        lastTurnAt: turn + 1,
        tracePath: '/tmp/trace.perfetto-trace',
        traceFilename: 'trace.perfetto-trace',
        firstQuery: 'trace only',
        turnCount: turn,
        status: 'completed' as const,
      },
    });

    try {
      const legacyMarkdown = '# Turn 1\n\n## Conclusion\n\nTrace-only conclusion.\n';
      commitTurnOutputs(input(1, sourceFree, legacyMarkdown));
      expect(fs.readFileSync(path.join(sp.turnsDir, '001.md'), 'utf8')).toBe(legacyMarkdown);
      expect(fs.existsSync(path.join(sp.dir, 'source-use-decision.json'))).toBe(false);
      expect(fs.existsSync(path.join(sp.dir, 'source-claim-bindings.json'))).toBe(false);

      const reference = sanitizeSourceReference({
        referenceId: 'lookup-stale',
        codebaseId: 'safe-app',
        filePath: 'src/main/Foo.kt',
        lookupKind: 'body',
      })!;
      const withSource: RunTurnOutput = {
        ...sourceFree,
        codeAwareMode: 'provider_send',
        result: {
          ...sourceFree.result,
          sourceUseDecision: {
            schemaVersion: 'source_use_decision@1',
            codeAwareMode: 'provider_send',
            selectedCodebaseIds: ['safe-app'],
            status: 'located',
            attemptedTools: ['read_codebase_file'],
            queriedCodebaseIds: ['safe-app'],
            usedCodebaseIds: ['safe-app'],
            references: [reference],
          },
          conclusionContract: {
            schemaVersion: 'conclusion_contract_v1',
            mode: 'focused_answer',
            conclusions: [],
            clusters: [],
            evidenceChain: [],
            sourceUseDecision: {
              schemaVersion: 'source_use_decision@1',
              codeAwareMode: 'provider_send',
              selectedCodebaseIds: ['safe-app'],
              status: 'located',
              attemptedTools: ['read_codebase_file'],
              queriedCodebaseIds: ['safe-app'],
              usedCodebaseIds: ['safe-app'],
              references: [reference],
            },
            sourceReferences: [reference],
            uncertainties: [],
            nextSteps: [],
          },
        },
      };
      commitTurnOutputs(input(2, withSource, '# Turn 2\n\n## Conclusion\n\nSource turn.\n'));
      expect(fs.existsSync(path.join(sp.dir, 'source-use-decision.json'))).toBe(true);
      expect(fs.existsSync(path.join(sp.turnsDir, '002.source-use-decision.json'))).toBe(true);

      const sourceFreeMarkdown = '# Turn 3\n\n## Conclusion\n\nTrace-only again.\n';
      commitTurnOutputs(input(3, sourceFree, sourceFreeMarkdown));
      expect(fs.existsSync(path.join(sp.dir, 'source-use-decision.json'))).toBe(false);
      expect(fs.existsSync(path.join(sp.dir, 'source-claim-bindings.json'))).toBe(false);
      expect(fs.existsSync(path.join(sp.turnsDir, '003.source-use-decision.json'))).toBe(false);
      expect(fs.readFileSync(path.join(sp.turnsDir, '003.md'), 'utf8')).toBe(sourceFreeMarkdown);
      expect(fs.existsSync(path.join(sp.turnsDir, '002.source-use-decision.json'))).toBe(true);
    } finally {
      fs.rmSync(home, {recursive: true, force: true});
    }
  });

  it('keeps every private session artifact free of raw query, model, and quality canaries', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'smartperfetto-cli-private-'));
    const paths = computePaths(home);
    ensureLayout(paths);
    const sessionId = 'session-private-artifacts';
    const sp = sessionPaths(paths, sessionId);
    ensureSessionLayout(sp);
    const canary = 'CLI_PRIVATE_ARTIFACT_CANARY';
    registerCodeAwareCanary(sessionId, canary);
    const result: RunTurnOutput = {
      sessionId,
      traceId: 'trace-private',
      codeAwareMode: 'provider_send',
      privateKnowledge: true,
      reportHtml: `<html><body>${canary}</body></html>`,
      reportError: canary,
      result: {
        sessionId,
        success: true,
        findings: [{id: 'private', title: canary}] as any,
        hypotheses: [{description: canary}] as any,
        conclusion: `conclusion ${canary}`,
        conclusionContract: {claims: [{statement: canary}]} as any,
        claimSupport: [{claimId: canary}] as any,
        claimVerificationResult: {status: canary} as any,
        identityResolutions: [{identityRefId: canary}] as any,
        confidence: 0.8,
        rounds: 1,
        totalDurationMs: 20,
        terminationMessage: canary,
        analysisReceipt: {
          schemaVersion: 2,
          runManifestId: 'manifest-private-cli',
          runId: 'run-private-cli',
          sessionId,
          traceId: 'trace-private',
          mode: 'full',
          resolvedMode: 'full',
          providerId: null,
          generatedAt: 1,
          traceEvidence: {sqlCount: 0, skillCount: 0, dataEnvelopeCount: 0, artifactCount: 0, evidenceRefCount: 0},
          nonEvidenceContext: {frontendPrequeryCount: 0, memoryHintCount: 0, conversationContextCount: 0, strategyHintCount: 0},
          claimAudit: {totalClaims: 0, verifiedClaims: 0, unsupportedClaims: 0, uncertainClaims: 0},
          qualityGates: {finalReportContract: 'not_applicable', claimVerification: 'not_applicable', identityResolution: 'not_applicable'},
          outputs: {reportError: canary, cliTurnPath: path.join(sp.turnsDir, '001.md')},
          capabilityManifest: {
            schemaVersion: 'capability_manifest_attribution@1',
            resolution: {
              status: 'ready',
              manifestId: `capability_manifest:${'a'.repeat(64)}`,
              contentHash: 'a'.repeat(64),
              manifestSchemaVersion: 'capability_manifest@1',
              traceFingerprintSha256: 'b'.repeat(64),
              traceProcessor: {source: 'custom', binarySha256: 'c'.repeat(64), localPath: canary},
              rpcEndpoint: canary,
            },
            probeCache: {hits: 1, misses: 0, bypasses: 0, localPath: canary},
            localPath: canary,
          } as any,
        },
        uiActionProposals: [{title: canary}] as any,
      },
    };

    const renderer = rendererStub();
    try {
      commitTurnOutputs({
        paths,
        sp,
        renderer,
        sessionId,
        turn: 1,
        query: `query ${canary}`,
        result,
        config: {
          sessionId,
          backendSessionId: sessionId,
          tracePath: '/tmp/private.perfetto-trace',
          traceId: 'trace-private',
          codeAwareMode: 'provider_send',
          codebaseIds: ['private-codebase'],
          createdAt: 1,
          lastTurnAt: 2,
          turnCount: 1,
        },
        turnMarkdown: `# Turn 1\n\nquery ${canary}\n\nconclusion ${canary}`,
        indexEntry: {
          sessionId,
          createdAt: 1,
          lastTurnAt: 2,
          tracePath: '/tmp/private.perfetto-trace',
          traceFilename: 'private.perfetto-trace',
          firstQuery: `query ${canary}`,
          turnCount: 1,
          status: 'completed',
        },
      });

      const persistedText = [
        ...readTextFiles(sp.dir),
        ...readTextFiles(paths.home),
      ].join('\n');
      expect(persistedText).not.toContain(canary);
      expect(JSON.stringify(jest.mocked(renderer.printCompletion).mock.calls)).not.toContain(canary);
      expect(renderer.printCompletion).toHaveBeenCalledWith(expect.objectContaining({terminationMessage: expect.any(String)}));
      expect(persistedText).toMatch(/原始内容未持久化|original content not persisted/);
      const privateReceipt = JSON.parse(
        fs.readFileSync(path.join(sp.dir, 'analysis-receipt.json'), 'utf-8'),
      );
      expect(privateReceipt.capabilityManifest).toEqual(expect.objectContaining({
        schemaVersion: 'capability_manifest_attribution@1',
        resolution: expect.objectContaining({
          manifestId: `capability_manifest:${'a'.repeat(64)}`,
        }),
      }));
      // The owner keeps their turn path and the report error, under the owner guard.
      expect(privateReceipt.outputs).toEqual({reportError: '[REDACTED_CODE_ECHO]', cliTurnPath: path.join(sp.turnsDir, '001.md')});
    } finally {
      clearCodeAwareOutputGuards(sessionId);
      fs.rmSync(home, {recursive: true, force: true});
    }
  });
});

function readTextFiles(root: string): string[] {
  if (!fs.existsSync(root)) return [];
  const output: string[] = [];
  for (const entry of fs.readdirSync(root, {withFileTypes: true})) {
    const target = path.join(root, entry.name);
    if (entry.isDirectory()) output.push(...readTextFiles(target));
    else if (entry.isFile()) output.push(fs.readFileSync(target, 'utf-8'));
  }
  return output;
}

describe('commitTurnOutputs records a truncated run as truncated', () => {
  /**
   * A 1200s comparison that hit the hard limit was filed as `completed`, so
   * `smp list` showed it exactly like a finished run, with no marker anywhere
   * that the analysis had been cut off.
   */
  it('files a partial result as partial rather than completed', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'smartperfetto-cli-partial-'));
    const paths = computePaths(home);
    ensureLayout(paths);
    const sp = sessionPaths(paths, 'session-partial');
    ensureSessionLayout(sp);

    const result = {
      sessionId: 'session-partial',
      traceId: 'trace-partial',
      codeAwareMode: 'off',
      result: {
        sessionId: 'session-partial',
        success: true,
        findings: [],
        hypotheses: [],
        conclusion: 'partial output',
        confidence: 0.25,
        rounds: 45,
        totalDurationMs: 1206000,
        partial: true,
        terminationReason: 'timeout',
        terminationMessage: 'The request deadline elapsed.',
        conclusionContract: {uncertainties: ['Missing blocking evidence'], nextSteps: ['Inspect the blocked interval']},
      },
    } as unknown as RunTurnOutput;

    const renderer = rendererStub();
    commitTurnOutputs({
      paths,
      sp,
      renderer,
      sessionId: 'session-partial',
      turn: 1,
      query: 'compare',
      result,
      config: {
        sessionId: 'session-partial',
        backendSessionId: 'session-partial',
        tracePath: '/tmp/trace.perfetto-trace',
        traceId: 'trace-partial',
        createdAt: 1,
        lastTurnAt: 2,
        turnCount: 1,
      },
      turnMarkdown: 'partial output',
      indexEntry: {
        sessionId: 'session-partial',
        createdAt: 1,
        lastTurnAt: 2,
        tracePath: '/tmp/trace.perfetto-trace',
        traceFilename: 'trace.perfetto-trace',
        firstQuery: 'compare',
        turnCount: 1,
        status: 'completed',
      },
    });

    const index = JSON.parse(fs.readFileSync(paths.indexFile, 'utf-8'));
    expect(index.sessions['session-partial'].status).toBe('partial');
    const transcript = JSON.parse(fs.readFileSync(sp.transcript, 'utf-8').trim());
    expect(transcript.history).toMatchObject({partial: true, completionStatus: 'incomplete',
      terminationReason: 'timeout', uncertainties: ['Missing blocking evidence'],
      nextSteps: ['Inspect the blocked interval']});
    expect(renderer.printCompletion).toHaveBeenCalledWith(expect.objectContaining({
      partial: true, hasConclusion: true, terminationReason: 'timeout',
      terminationMessage: 'The request deadline elapsed.',
    }));
    fs.rmSync(home, {recursive: true, force: true});
  });
});
