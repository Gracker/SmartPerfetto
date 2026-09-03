// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  buildFollowUpVerificationChecks,
  parseArgs as parseAgentSseArgs,
  setupAnalysisContext,
} from '../verifyAgentSseScrolling';
import {
  DETERMINISTIC_EVIDENCE_KIND,
  loadConstructedSourceGroundTruth,
  runDeterministicSemanticDeltaVerification,
} from '../verifyCodeAwareSemanticDelta';

const repoRoot = path.resolve(__dirname, '../../../..');
const sourceRoot = path.join(repoRoot, 'backend/tests/e2e/context-fixtures/app');

describe('register-only Agent SSE setup', () => {
  it('applies non-partial, verifier, and degraded checks to follow-up runs', () => {
    const options = parseAgentSseArgs([
      '--follow-up-query', '只解释上一轮证据',
      '--require-non-partial',
      '--require-claim-verifier-ok',
      '--forbid-degraded-fallback', 'final_result_quality_gate',
    ]);
    const summary = {
      progressCount: 1,
      conclusionCount: 0,
      analysisCompletedConclusionChars: 1209,
      terminalEvent: 'analysis_completed',
      errorEvents: [],
      planSubmittedCount: 0,
      requiredTextMatches: {},
      toolCallCounts: {},
      degradedFallbackCounts: {},
      analysisCompletedPartial: false,
      claimVerifierStatus: 'passed',
      claimVerifierPassed: true,
      claimVerifierUnsupportedClaimCount: 0,
    } as any;

    expect(Object.values(buildFollowUpVerificationChecks(summary, options)).every(Boolean))
      .toBe(true);

    const failedChecks = buildFollowUpVerificationChecks({
      ...summary,
      degradedFallbackCounts: {final_result_quality_gate: 1},
      analysisCompletedPartial: true,
      claimVerifierStatus: 'partial',
      claimVerifierPassed: false,
      claimVerifierUnsupportedClaimCount: 1,
    }, options);
    expect(failedChecks).toEqual(expect.objectContaining({
      'followUpForbidsDegradedFallback:final_result_quality_gate': false,
      followUpAnalysisCompletedNotPartial: false,
      followUpClaimVerifierPassed: false,
      followUpClaimVerifierHasNoUnsupportedClaims: false,
    }));
  });

  it('defaults a follow-up to auto without changing the initial requested mode', () => {
    const options = parseAgentSseArgs(['--mode', 'full', '--follow-up-query', '只解释上一轮证据']);
    expect(options.analysisMode).toBe('full');
    expect(options.followUpAnalysisMode).toBe('auto');
  });

  it('accepts an explicit per-turn follow-up mode override', () => {
    const options = parseAgentSseArgs([
      '--mode', 'full',
      '--follow-up-query', '重新生成完整报告',
      '--follow-up-mode', 'full',
    ]);
    expect(options.followUpAnalysisMode).toBe('full');
  });

  it('requires a codebase root when setup mode is explicit', () => {
    expect(() => parseAgentSseArgs([
      '--setup-codebase-mode',
      'register-only',
    ])).toThrow('--setup-codebase-mode requires --setup-codebase-root');
  });

  it('proves register-only state from the post-registration audit without reindexing', async () => {
    const options = parseAgentSseArgs([
      '--setup-codebase-root',
      sourceRoot,
      '--setup-codebase-mode',
      'register-only',
    ]);
    const routes: string[] = [];
    const request = jest.fn(async (
      _baseUrl: string,
      route: string,
      _body?: Record<string, unknown>,
      method?: 'GET' | 'POST',
    ) => {
      routes.push(`${method ?? 'POST'} ${route}`);
      if (route.endsWith('/audit')) {
        return {
          success: true,
          audit: {
            codebaseId: 'cb-register-only',
            activeIndexState: 'none',
            chunkCount: 0,
          },
        };
      }
      return {success: true, codebase: {codebaseId: 'cb-register-only'}};
    });

    const result = await setupAnalysisContext('http://127.0.0.1:1', options, request);

    expect(routes).toEqual([
      'POST /api/rag/codebases/register',
      'GET /api/rag/codebases/cb-register-only/audit',
    ]);
    expect(routes.some(route => route.includes('/reindex'))).toBe(false);
    expect(result.codebases).toEqual([{
      codebaseId: 'cb-register-only',
      setupMode: 'register-only',
      chunkCount: 0,
      activeIndexState: 'none',
      activeGeneration: undefined,
      pendingGeneration: false,
      reindexRequests: 0,
    }]);
  });

  it('rejects a lying reindex response when the post-reindex audit is still inactive', async () => {
    const options = parseAgentSseArgs(['--setup-codebase-root', sourceRoot]);
    const request = jest.fn(async (
      _baseUrl: string,
      route: string,
      _body?: Record<string, unknown>,
      _method?: 'GET' | 'POST',
    ) => {
      if (route.endsWith('/reindex')) {
        return {success: true, result: {chunksAdded: 7, generation: 'claimed-active'}};
      }
      if (route.endsWith('/audit')) {
        return {
          success: true,
          audit: {
            codebaseId: 'cb-indexed',
            activeIndexState: 'none',
            chunkCount: 0,
          },
        };
      }
      return {success: true, codebase: {codebaseId: 'cb-indexed'}};
    });

    await expect(setupAnalysisContext('http://127.0.0.1:1', options, request))
      .rejects.toThrow('register-and-index setup did not produce an active audited index');
  });
});

describe('constructed source/trace ground truth', () => {
  it('is generator-owned and hash-binds the exact fixture marker, symbol, line, and trace', () => {
    const groundTruth = loadConstructedSourceGroundTruth(repoRoot);
    const source = fs.readFileSync(path.join(repoRoot, groundTruth.relativeSourcePath), 'utf8');
    const sourceLines = source.split(/\r?\n/);
    const caseDefinition = JSON.parse(fs.readFileSync(
      path.join(repoRoot, 'Trace/constructed/source-analysis-semantic/case.json'),
      'utf8',
    )) as Record<string, any>;

    expect(source).toContain(`TRACE_SOURCE_MARKER = "${groundTruth.marker}"`);
    expect(sourceLines[groundTruth.lineRange.start - 1]).toContain('fun initializeOnMainThread');
    expect(groundTruth).toMatchObject({
      relativeSourcePath: 'backend/tests/e2e/context-fixtures/app/StartupHooks.kt',
      symbol: 'StartupHooks.initializeOnMainThread',
      callChain: [
        'Application.onCreate',
        'StartupHooks.initializeOnMainThread',
        'synchronous startup policy check',
      ],
      trace: {
        materialization: 'committed-base-plus-overlay',
        overlaySha256: caseDefinition.trace.sha256,
      },
    });
    expect(groundTruth.trace.outputSha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it('registers clean-checkout preparation and the existing Task 7 runtime gate', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'backend/package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    };
    expect(pkg.scripts['prepare:code-aware-semantic-delta']).toBe(
      'npm run trace-processor:ensure && npm run trace:materialize',
    );
    expect(pkg.scripts['test:code-aware-semantic-delta']).toContain(
      'src/agentRuntime/__tests__/sourceUseResultAttachment.test.ts',
    );
    expect(pkg.scripts['test:code-aware-semantic-delta']).toContain(
      'npm run prepare:code-aware-semantic-delta',
    );
    expect(pkg.scripts['verify:code-aware-semantic-delta']).toContain(
      'npm run prepare:code-aware-semantic-delta',
    );
    expect(pkg.scripts['verify:code-aware-semantic-delta']).toContain(
      'src/services/__tests__/sourceProvenanceSurfaces.test.ts',
    );
  });
});

describe('deterministic code-aware semantic delta', () => {
  it('derives A0-A4 from real trace, audit, source handlers, SSE projection, and verifiers', async () => {
    const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'semantic-delta-'));
    try {
      const summary = await runDeterministicSemanticDeltaVerification({repoRoot, outputDir}) as any;

      expect(summary).not.toHaveProperty('runtimes');
      expect(summary).not.toHaveProperty('surfaces');
      expect(summary).not.toHaveProperty('blockedSurfaces');
      expect(summary).toMatchObject({
        schemaVersion: 'code_aware_semantic_delta_summary@2',
        evidenceKind: DETERMINISTIC_EVIDENCE_KIND,
        realProviderAcceptance: false,
        passed: true,
        queryCount: 3,
        surfaceProof: {
          gate: 'src/services/__tests__/sourceProvenanceSurfaces.test.ts',
          status: 'invoked_by_registered_command',
          surfaces: ['report', 'cli', 'snapshot', 'web_receipt'],
        },
        runtimeProof: {
          gate: 'src/agentRuntime/__tests__/sourceUseResultAttachment.test.ts',
          status: 'invoked_by_registered_command',
        },
      });

      expect(summary.traceFacts).toMatchObject({
        occurrenceCount: 1,
        marker: summary.groundTruth.marker,
        durationNs: summary.groundTruth.traceFacts.durationNs,
        process: summary.groundTruth.traceFacts.process,
        thread: summary.groundTruth.traceFacts.thread,
      });
      expect(summary.conditions.A0.setup).toBeUndefined();
      for (const condition of ['A1', 'A2'] as const) {
        expect(summary.conditions[condition].setup).toMatchObject({
          setupMode: 'register-only',
          chunkCount: 0,
          activeIndexState: 'none',
          activeGeneration: undefined,
          pendingGeneration: false,
          reindexRequests: 0,
        });
      }
      expect(summary.conditions.A3.setup).toMatchObject({
        setupMode: 'register-and-index',
        activeIndexState: 'active',
        reindexRequests: 1,
      });
      expect(summary.conditions.A3.setup.chunkCount).toBeGreaterThan(0);
      expect(summary.conditions.A3.setup.activeGeneration).toEqual(expect.any(String));

      for (const condition of ['A2', 'A3'] as const) {
        expect(summary.conditions[condition].sourceUse).toMatchObject({
          status: 'corroborated',
          references: expect.arrayContaining([expect.objectContaining({
            filePath: 'StartupHooks.kt',
            lineRange: {start: summary.groundTruth.lineRange.start, end: summary.groundTruth.lineRange.end},
          })]),
        });
        expect(summary.conditions[condition].sourceFacts).toMatchObject({
          exactRelativeFile: true,
          exactSymbol: true,
          exactLine: true,
          callChainMapped: true,
          traceMarkerMapped: true,
          actionableSeam: true,
        });
        expect(summary.conditions[condition].claimVerification.claimVerificationResult.status)
          .toBe('passed');
        expect(summary.conditions[condition].sourceClaimVerification.status).toBe('passed');
        expect(summary.conditions[condition].codeRefOnlyOccurrence.status).not.toBe('passed');
      }

      expect(summary.conditions.A4).toMatchObject({
        wrongReferenceRejected: true,
        sourceClaimVerification: {
          status: 'failed',
          issues: expect.arrayContaining([
            expect.objectContaining({code: 'source_reference_outside_selection'}),
          ]),
        },
      });
      expect(summary.queries.find((query: any) => query.kind === 'quantitative-only')).toMatchObject({
        sourceUseDecision: {
          status: 'not_needed',
          attemptedTools: [],
          references: [],
        },
      });
      expect(summary.sse).toMatchObject({
        rawSourceCanarySuppressed: true,
        analysisCompletionSourceAttached: true,
      });
      expect(JSON.stringify(summary)).not.toContain(sourceRoot);
      expect(JSON.stringify(summary)).not.toContain('val startupPolicy =');
      expect(fs.existsSync(path.join(outputDir, 'deterministic-summary.json'))).toBe(true);
    } finally {
      fs.rmSync(outputDir, {recursive: true, force: true});
    }
  });
});

describe('real-provider semantic delta wrapper contract', () => {
  const wrapper = require('../../../scripts/run-deepseek-agent-e2e.cjs') as {
    parseArgs?: (argv: string[]) => Record<string, unknown>;
    semanticDeltaQueries?: () => Array<Record<string, unknown>>;
    semanticConditionArgs?: (
      query: Record<string, unknown>,
      condition: string,
      outputPath: string,
      timeoutMs: number,
    ) => string[];
    evaluateSemanticConditionReport?: (input: Record<string, unknown>) => Record<string, any>;
    realProviderAvailability?: (
      runtime: string,
      env?: Record<string, string | undefined>,
      fileExists?: (filePath: string) => boolean,
    ) => Record<string, unknown>;
  };

  it('parses repeat five and exposes all three observable query classes', () => {
    expect(wrapper.parseArgs?.([
      '--suite',
      'code-aware-semantic-delta',
      '--runtime',
      'all',
      '--repeat',
      '5',
      '--output-dir',
      'test-output/code-aware-semantic-delta/real-provider',
    ])).toMatchObject({
      suite: 'code-aware-semantic-delta',
      runtime: 'all',
      repeat: 5,
      outputDir: expect.stringContaining('test-output/code-aware-semantic-delta/real-provider'),
    });
    expect(wrapper.semanticDeltaQueries?.().map(query => query.kind)).toEqual([
      'autonomous-diagnosis',
      'quantitative-only',
      'explicit-source-location',
    ]);
  });

  it('keeps Claude independently available when local Claude auth exists', () => {
    expect(wrapper.realProviderAvailability?.(
      'claude-agent-sdk',
      {CLAUDE_CODE_OAUTH_TOKEN: 'present'},
      () => false,
    )).toMatchObject({available: true});
  });

  it('makes A0 source leakage an explicit failure instead of missing-key evidence', () => {
    const query = wrapper.semanticDeltaQueries?.()[0];
    expect(query).toBeDefined();
    const args = wrapper.semanticConditionArgs?.(query!, 'A0', 'a0.json', 1_000);
    expect(args).toBeDefined();
    const forbidden = args!
      .map((arg, index) => arg === '--forbid-text' ? args![index + 1] : undefined)
      .filter(Boolean);
    expect(forbidden).toEqual(expect.arrayContaining([
      'backend/tests/e2e/context-fixtures/app/StartupHooks.kt',
      'StartupHooks.kt',
      'StartupHooks.initializeOnMainThread',
      'Application.onCreate',
      'avoid synchronous disk I/O before first frame',
      '[Code:',
    ]));

    const evaluated = wrapper.evaluateSemanticConditionReport?.({
      query,
      condition: 'A0',
      sourceRoot,
      report: {
        passed: true,
        analysisContext: {codebaseIds: []},
        summary: {
          requiredTextMatches: {
            'StartupHooks.initializeOnMainThread#before-first-frame-sync-policy': true,
          },
          forbiddenTextMatches: {'StartupHooks.kt': true},
          claimVerifierStatus: 'passed',
          claimVerifierPassed: true,
          claimVerifierCheckedClaimCount: 1,
          claimVerifierUnsupportedClaimCount: 0,
          toolCallCounts: {},
        },
      },
    });
    expect(evaluated).toMatchObject({sourceLeakFree: false});
  });

  it('rejects marker repetition without verified trace claims or source bindings', () => {
    const [query] = wrapper.semanticDeltaQueries?.() ?? [];
    const markerOnly = wrapper.evaluateSemanticConditionReport?.({
      query,
      condition: 'A0',
      sourceRoot,
      report: {
        passed: true,
        analysisContext: {codebaseIds: []},
        summary: {
          requiredTextMatches: {
            'StartupHooks.initializeOnMainThread#before-first-frame-sync-policy': true,
          },
          forbiddenTextMatches: {},
          toolCallCounts: {},
        },
      },
    });
    expect(markerOnly).toMatchObject({traceFactPassed: false});

    const sourceBindingFailed = wrapper.evaluateSemanticConditionReport?.({
      query,
      condition: 'A2',
      sourceRoot,
      report: {
        passed: true,
        analysisContext: {setup: {codebases: [{
          setupMode: 'register-only',
          chunkCount: 0,
          activeIndexState: 'none',
          pendingGeneration: false,
          reindexRequests: 0,
        }]}},
        summary: {
          requiredTextMatches: {
            'StartupHooks.initializeOnMainThread#before-first-frame-sync-policy': true,
            'StartupHooks.kt': true,
            'StartupHooks.initializeOnMainThread': true,
            'Application.onCreate': true,
            'avoid synchronous disk I/O before first frame': true,
          },
          forbiddenTextMatches: {},
          claimVerifierStatus: 'passed',
          claimVerifierPassed: true,
          claimVerifierCheckedClaimCount: 1,
          claimVerifierUnsupportedClaimCount: 0,
          conclusionHasConcreteCodeRefs: true,
          analysisCompletedSourceUseStatus: 'corroborated',
          analysisCompletedSourceReferenceCount: 1,
          analysisCompletedSourceBindingCount: 1,
          analysisCompletedSourceClaimVerifierStatus: 'failed',
          analysisCompletedSourceMechanismStatuses: ['corroborated'],
          analysisCompletedSourceReferenceMembershipPassed: false,
          toolCallCounts: {search_codebase: 1, read_codebase_file: 1},
        },
      },
    });
    expect(sourceBindingFailed).toMatchObject({sourceSemanticPassed: false});
  });

  it('records every missing Qoder authentication boundary without calling it a pass', () => {
    expect(wrapper.realProviderAvailability?.('qoder-agent-sdk', {}, () => false)).toEqual({
      available: false,
      reason:
        'DEEPSEEK_API_KEY_OR_OPENAI_API_KEY_MISSING;QODER_PERSONAL_ACCESS_TOKEN_OR_QODERCLI_PATH_MISSING',
    });
  });
});
