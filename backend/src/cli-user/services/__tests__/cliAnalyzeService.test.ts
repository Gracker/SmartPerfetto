// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { createDataEnvelope } from '../../../types/dataContract';
import type { ConclusionContract } from '../../../agent/core/conclusionContract';
import { runClaimVerification } from '../../../services/verifier/claimVerificationRunner';
import {CodebaseRegistry, type CodebaseRef} from '../../../services/codebase/codebaseRegistry';
import {SymbolResolver, type ResolvedSymbolCandidate} from '../../../services/symbol/symbolResolver';
import {SessionPersistenceService} from '../../../services/sessionPersistenceService';
import {getHTMLReportGenerator} from '../../../services/htmlReportGenerator';
import {sanitizeSourceReference} from '../../../services/codebase/sourceUseDecision';
import {
  CliAnalyzeService,
  envelopesFromStreamingUpdate,
  shouldExposeLiveStreamingUpdate,
} from '../cliAnalyzeService';

describe('CliAnalyzeService streaming data collection', () => {
  it('preserves valid DataEnvelope updates without treating transport data as execution proof', () => {
    const envelope = createDataEnvelope({
      columns: ['blocked_ms'],
      rows: [[120]],
    }, {
      type: 'skill_result',
      source: 'startup_main_thread_blocking',
      title: 'Main thread blocking',
      layer: 'overview',
      format: 'table',
      evidenceRefId: 'data:skill:test',
      sourceToolCallId: 'invoke_skill:test',
      traceId: 'trace-a',
      traceSide: 'current',
    });
    const collected = envelopesFromStreamingUpdate({
      type: 'data',
      content: [envelope, { bad: 'shape' }],
      timestamp: Date.now(),
    });
    const conclusionContract: ConclusionContract = {
      schemaVersion: 'conclusion_contract_v1',
      mode: 'focused_answer',
      conclusions: [],
      clusters: [],
      evidenceChain: [],
      claims: [{
        id: 'claim-main-thread-blocked',
        kind: 'numeric',
        text: '主线程 blocked_ms 为 120',
        references: [{
          evidenceRefId: 'data:skill:test',
          sourceToolCallId: 'invoke_skill:test',
          rowIndex: 0,
          column: 'blocked_ms',
          value: 120,
        }],
      }],
      uncertainties: [],
      nextSteps: [],
      metadata: {},
    };

    const result = runClaimVerification({
      conclusionContract,
      dataEnvelopes: collected,
    });

    expect(collected).toEqual([envelope]);
    expect(collected[0].data).toEqual({columns: ['blocked_ms'], rows: [[120]]});
    expect(result.claimVerificationResult).toMatchObject({
      schemaVersion: 'claim_verifier@2', status: 'not_checked', passed: false, unsupportedClaimCount: 0,
      claimResults: [{claimId: 'claim-main-thread-blocked', status: 'not_checked'}],
    });
  });

  it('does not expose pre-verifier narrative events to live machine streams', () => {
    expect(shouldExposeLiveStreamingUpdate({
      type: 'answer_token',
      content: { token: 'draft final answer' },
      timestamp: Date.now(),
    })).toBe(false);
    expect(shouldExposeLiveStreamingUpdate({
      type: 'conclusion',
      content: { conclusion: 'draft final answer' },
      timestamp: Date.now(),
    })).toBe(false);
    expect(shouldExposeLiveStreamingUpdate({
      type: 'answer_segment_reset',
      content: { runId: 'run', attempt: 1 },
      timestamp: Date.now(),
    })).toBe(false);
    expect(shouldExposeLiveStreamingUpdate({
      type: 'data',
      content: [],
      timestamp: Date.now(),
    })).toBe(true);
  });
});

describe('CliAnalyzeService test-only fake source report', () => {
  const sourcePath = 'launch-aosp/src/main/java/com/example/launch/aosp/MainActivity.kt';
  const candidate: ResolvedSymbolCandidate = {
    chunkId: 'chunk-main-activity',
    codebaseId: 'cb-source',
    filePath: sourcePath,
    lineRange: {start: 22, end: 27},
    symbol: 'MainActivity',
    confidence: 'exact',
  };
  const envKeys = ['SMARTPERFETTO_CLI_E2E_FAKE', 'SMARTPERFETTO_CLI_E2E_FAKE_RESPONSE',
    'SMARTPERFETTO_CODE_AWARE', 'SMARTPERFETTO_OUTPUT_LANGUAGE'] as const;
  let savedEnv: Array<string | undefined>;
  let resolveApp: jest.SpiedFunction<SymbolResolver['resolveApp']>;
  let renderReport: jest.SpiedFunction<ReturnType<typeof getHTMLReportGenerator>['generateAgentDrivenHTML']>;

  beforeEach(() => {
    savedEnv = envKeys.map(key => process.env[key]);
    process.env.SMARTPERFETTO_CLI_E2E_FAKE = '1';
    process.env.SMARTPERFETTO_CLI_E2E_FAKE_RESPONSE = 'Deterministic test-only conclusion.';
    process.env.SMARTPERFETTO_CODE_AWARE = 'on';
    process.env.SMARTPERFETTO_OUTPUT_LANGUAGE = 'zh';
    jest.spyOn(SessionPersistenceService, 'getInstance').mockReturnValue({} as SessionPersistenceService);
    jest.spyOn(CodebaseRegistry.prototype, 'get').mockImplementation(codebaseId => ({
      codebaseId, rootRealpath: process.cwd(), lifecycleState: 'active', consent: {sendToProvider: true},
    } as CodebaseRef));
    resolveApp = jest.spyOn(SymbolResolver.prototype, 'resolveApp')
      .mockReturnValue({success: true, query: 'MainActivity', candidates: [candidate]});
    // Keep the real private/provenance projections and HTML renderer in this mock-runtime test.
    renderReport = jest.spyOn(getHTMLReportGenerator(), 'generateAgentDrivenHTML');
  });

  afterEach(() => {
    jest.restoreAllMocks();
    envKeys.forEach((key, index) => {
      if (savedEnv[index] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[index];
    });
  });

  function runFake(codebaseIds: string[] = ['cb-source'], codeAwareMode: 'metadata_only' | 'off' = 'metadata_only') {
    return new CliAnalyzeService().runTurn({
      traceId: 'trace-fake-source', query: 'test source locations', codeAwareMode, codebaseIds,
      turn: 1, resolveCliTurnPath: () => '/unused-test-only-turn.json',
      onEvent: jest.fn(),
    });
  }

  it('renders canonical resolver locations after private projection without claiming verification', async () => {
    resolveApp.mockReturnValue({success: true, query: 'MainActivity', candidates: [{...candidate,
      code: 'class MainActivity { SECRET_SOURCE_BODY }', rootRealpath: '/private/fake-source-root',
    } as ResolvedSymbolCandidate]});
    const output = await runFake(['cb-source', 'cb-unmatched']);
    const reference = sanitizeSourceReference({...candidate, lookupKind: 'metadata'})!;
    expect(output.privateKnowledge).toBe(true);
    expect(output.result.sourceReferences).toEqual([reference]);
    expect(output.result.sourceUseDecision).toMatchObject({
      schemaVersion: 'source_use_decision@1', codeAwareMode: 'metadata_only', status: 'located',
      selectedCodebaseIds: ['cb-source', 'cb-unmatched'], queriedCodebaseIds: ['cb-source', 'cb-unmatched'],
      usedCodebaseIds: ['cb-source'], attemptedTools: ['SymbolResolver.resolveApp'],
      coverageComplete: false, references: [reference],
    });
    expect(output.result.conclusionContract?.sourceReferences).toEqual([reference]);
    expect(output.result.conclusionContract).not.toHaveProperty('codeReferences');
    expect(output.result.conclusionContract?.claims).toEqual([]);
    expect(output.result.conclusionContract?.sourceClaimBindings ?? []).toEqual([]);
    expect(output.result.claimVerificationResult).toMatchObject({status: 'not_checked', passed: false, claimResults: []});
    expect(output.result.sourceClaimVerificationResult).toBeUndefined();
    expect(output.result.analysisReceipt).toBeUndefined();
    const reportData = renderReport.mock.calls[renderReport.mock.calls.length - 1][0];
    expect(reportData.sourceContext).toMatchObject({
      selected: [{codebaseId: 'cb-source'}, {codebaseId: 'cb-unmatched'}],
      sourceUseDecision: output.result.sourceUseDecision, sourceClaimBindings: [],
    });
    expect(reportData.result.claimVerificationResult).toEqual(output.result.claimVerificationResult);
    expect(output.reportHtml).toContain('本轮返回的源码位置');
    expect(output.reportHtml).toContain(`${sourcePath}:L22-L27`);
    expect(output.reportHtml).toContain(reference.id);
    expect(output.reportHtml).not.toContain('SECRET_SOURCE_BODY');
    expect(output.reportHtml).not.toContain('/private/fake-source-root');
    expect(output.reportHtml).not.toContain(process.cwd());
    expect(resolveApp).toHaveBeenCalledWith({symbol: 'MainActivity', codebaseId: 'cb-source', topK: 2});
  });

  it.each([
    ['missing codebase identity', {...candidate, codebaseId: undefined}],
    ['different codebase identity', {...candidate, codebaseId: 'cb-other'}],
    ['absolute source path', {...candidate, filePath: '/private/fake-source-root/MainActivity.kt'}],
    ['traversal source path', {...candidate, filePath: '../MainActivity.kt'}],
  ] as const)('rejects %s without filling in a source identity', async (_name, rejected) => {
    resolveApp.mockReturnValue({success: true, query: 'MainActivity', candidates: [rejected]});
    const output = await runFake();
    expect(output.result.sourceReferences).toEqual([]);
    expect(output.result.sourceUseDecision).toMatchObject({status: 'attempted', coverageComplete: false,
      queriedCodebaseIds: ['cb-source'], usedCodebaseIds: [], references: []});
    expect(output.reportHtml).not.toContain('本轮返回的源码位置');
    expect(output.reportHtml).not.toContain('/private/fake-source-root');
    expect(output.reportHtml).not.toContain('CodeRef MainActivity');
  });

  it('keeps an unsuccessful lookup distinct from having no selected source', async () => {
    resolveApp.mockReturnValue({success: false, query: 'MainActivity', candidates: [], degradedReason: 'no_match'});
    const output = await runFake();
    expect(output.result.sourceUseDecision).toMatchObject({selectedCodebaseIds: ['cb-source'],
      queriedCodebaseIds: ['cb-source'], usedCodebaseIds: [], status: 'attempted', coverageComplete: false});
    expect(renderReport.mock.calls[renderReport.mock.calls.length - 1][0].sourceContext?.selected)
      .toEqual([{codebaseId: 'cb-source'}]);
    expect(output.reportHtml).toContain('本次已查询 1 个源码库，但没有成功返回源码或图引用');
    expect(output.reportHtml).not.toContain('本轮返回的源码位置');
  });

  it('derives used codebases only from the final bounded canonical references', async () => {
    resolveApp.mockImplementation(({symbol, codebaseId}) => ({success: true, query: symbol!, candidates: [0, 1].map(index => ({
      ...candidate, codebaseId, symbol, chunkId: `${codebaseId}-${symbol}-${index}`,
    }))}));
    const output = await runFake(['cb-source', 'cb-truncated']);
    expect(output.result.sourceReferences).toHaveLength(8);
    expect(new Set(output.result.sourceReferences!.map(reference => reference.id)).size).toBe(8);
    expect(output.result.sourceUseDecision).toMatchObject({
      selectedCodebaseIds: ['cb-source', 'cb-truncated'], queriedCodebaseIds: ['cb-source', 'cb-truncated'],
      usedCodebaseIds: ['cb-source'], coverageComplete: false,
    });
  });

  it.each(['off', 'metadata_only'] as const)('does not create source provenance for %s with no selected source', async mode => {
    const output = await runFake([], mode);
    expect(resolveApp).not.toHaveBeenCalled();
    expect(output.result.sourceUseDecision).toBeUndefined();
    expect(output.result.sourceReferences).toBeUndefined();
    expect(renderReport.mock.calls[renderReport.mock.calls.length - 1][0].sourceContext).toBeUndefined();
    expect(output.reportHtml).not.toContain('本轮返回的源码位置');
    expect(output.result.claimVerificationResult).toMatchObject({status: 'not_checked', passed: false});
  });
});
