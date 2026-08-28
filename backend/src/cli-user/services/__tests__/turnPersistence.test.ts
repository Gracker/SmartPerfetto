// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, expect, it, jest } from '@jest/globals';
import { computePaths, ensureLayout, ensureSessionLayout, sessionPaths } from '../../io/paths';
import { commitTurnOutputs } from '../turnPersistence';
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
          claims: [{id: 'claim-1', text: 'Foo.run is compatible with the trace.', references: []}],
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

    try {
      commitTurnOutputs({
        paths,
        sp,
        renderer: rendererStub(),
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
      expect(markdown).toContain('source_use_decision@1');
      expect(markdown).toContain('provider_send');
      expect(markdown).toContain('corroborated');
      expect(markdown).toContain('compatible');
      expect(markdown).toContain('claim-1');
      const durableText = [storedDecision, storedBindings, markdown]
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
          outputs: {reportError: canary, cliTurnPath: canary},
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

    try {
      commitTurnOutputs({
        paths,
        sp,
        renderer: rendererStub(),
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
      expect(privateReceipt.outputs).toEqual({});
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
