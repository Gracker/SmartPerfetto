// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)

import {describe, expect, it, jest} from '@jest/globals';

jest.mock('../traceProcessorService', () => ({
  getTraceProcessorService: () => ({getTrace: () => undefined}),
}));

import {buildAgentDrivenReportData as buildRunReportData, type BuildAgentReportDataInput} from '../agentReportData';
import {resolveAnalysisPrivateContext} from '../security/analysisPrivateContext';

// These cases describe the reported run by its session selection; the marker is the one admission fixes from it.
const buildAgentDrivenReportData = (input: Omit<BuildAgentReportDataInput, 'privateContext'>) =>
  buildRunReportData({privateContext: resolveAnalysisPrivateContext(input.session), ...input});
import {HTMLReportGenerator} from '../htmlReportGenerator';
import {clearCodeAwareOutputGuards, registerCodeAwareCanary, registerOnDemandSourceLookupForEcho} from '../security/codeAwareOutputRegistry';
import {sanitizeSourceReference} from '../codebase/sourceUseDecision';
import {analysisDeliveryFingerprint} from '../../types/analysisDelivery';

describe('buildAgentDrivenReportData private knowledge projection', () => {
  const baseResult = (sessionId: string) => ({
    sessionId,
    success: true,
    findings: [],
    hypotheses: [],
    conclusion: 'Safe projected conclusion.',
    confidence: 0.8,
    rounds: 1,
    totalDurationMs: 10,
  });

  it('retains owner source commentary and evidence while filtering private canaries and raw internals', () => {
    const sessionId = 'private-report-session';
    const source = 'fun scheduleFrame() { workOnMainThread() }';
    registerOnDemandSourceLookupForEcho(sessionId, [{referenceId: 'report-source', codebaseId: 'private-app', filePath: 'Main.kt', text: source}]);
    [
      'PRIVATE_CONCLUSION_CANARY',
      'PRIVATE_FINDING_CANARY',
      'PRIVATE_RESULT_HYPOTHESIS_CANARY',
      'PRIVATE_HYPOTHESIS_CANARY',
      'PRIVATE_CLAIM_CANARY',
      'PRIVATE_VERIFICATION_CANARY',
      'PRIVATE_IDENTITY_CANARY',
      'PRIVATE_ACTION_CANARY',
      'PRIVATE_STEP_CANARY',
      'PRIVATE_HISTORY_CANARY',
    ].forEach(canary => registerCodeAwareCanary(sessionId, canary));
    const report = buildAgentDrivenReportData({
      session: {
        sessionId,
        traceId: 'trace-a',
        query: 'analyze PRIVATE_QUERY_CANARY',
        codeAwareMode: 'provider_send',
        codebaseIds: ['private-app'],
        outputLanguage: 'en',
        orchestrator: {
          getSessionNotes: () => [{content: 'PRIVATE_NOTE_CANARY'}],
          getSessionPlan: () => ({successCriteria: 'PRIVATE_PLAN_CANARY'}),
          getSessionUncertaintyFlags: () => [{description: 'PRIVATE_FLAG_CANARY'}],
        },
        hypotheses: [{description: 'PRIVATE_HYPOTHESIS_CANARY'}],
        agentDialogue: [{content: 'PRIVATE_DIALOGUE_CANARY'}],
        conversationSteps: [{text: `${source} PRIVATE_STEP_CANARY`}],
        dataEnvelopes: [{meta: {kind: 'sql'}, data: {rows: [[1]]}, display: {type: 'table'}}],
        agentResponses: [{response: 'PRIVATE_RESPONSE_CANARY'}],
        runSequence: 1,
        queryHistory: [{query: 'PRIVATE_QUERY_HISTORY_CANARY'}],
        conclusionHistory: [{conclusion: 'PRIVATE_HISTORY_CANARY'}],
        _lastSnapshot: {
          codebaseSnapshot: [{
            codebaseId: 'private-app',
            displayName: 'Private App',
            kind: 'app_source',
            indexGeneration: 1,
          }, {
            codebaseId: 'private-kernel',
            displayName: 'Private Kernel',
            kind: 'kernel_source',
            indexGeneration: 1,
          }],
          codeLookupSummary: {
            lookupCount: 2,
            patchCount: 0,
            referencedCodebaseIds: ['private-app', 'private-kernel'],
            usedCodebaseIds: ['private-app'],
          },
        },
      } as any,
      result: {
        sessionId,
        success: true,
        findings: [{id: 'finding', title: 'PRIVATE_FINDING_CANARY'}] as any,
        hypotheses: [{description: 'PRIVATE_RESULT_HYPOTHESIS_CANARY'}] as any,
        conclusion: 'safe before PRIVATE_CONCLUSION_CANARY safe after',
        conclusionContract: {claims: [{text: 'PRIVATE_CLAIM_CANARY'}]},
        claimSupport: [{claimId: 'claim-1', text: 'PRIVATE_CLAIM_CANARY'}] as any,
        claimVerificationResult: {
          schemaVersion: 'claim_verifier@2', policy: 'record_only', passed: false,
          checkedClaimCount: 0, unsupportedClaimCount: 0, claimResults: [],
          status: 'partial',
          issues: [{claimId: 'claim-1', severity: 'warning', code: 'not_checked', message: 'PRIVATE_VERIFICATION_CANARY'}],
        } as any,
        identityResolutions: [{
          version: 'identity_contract@1', target: {traceId: 'trace-a', source: 'derived'}, processes: [], threads: [],
          identityRefId: 'identity-1',
          status: 'verified',
          warnings: ['PRIVATE_IDENTITY_CANARY'],
        }] as any,
        uiActionProposals: [{
          schemaVersion: 1,
          id: 'action-1',
          kind: 'navigate_timeline',
          title: 'PRIVATE_ACTION_CANARY',
          reason: 'PRIVATE_ACTION_CANARY',
          source: {evidenceRefId: 'data:action-1'},
          payload: {ts: '100'},
          requiresConfirmation: true,
        }] as any,
        confidence: 0.8,
        rounds: 1,
        totalDurationMs: 10,
      },
    });

    expect(report.dataEnvelopes).toHaveLength(1);
    expect(report.result.findings).toHaveLength(1);
    expect(report.result.hypotheses).toHaveLength(1);
    expect(report.hypotheses).toHaveLength(1);
    expect(report.result.claimSupport).toHaveLength(1);
    expect(report.result.claimVerificationResult).toBeDefined();
    expect(report.result.identityResolutions).toHaveLength(1);
    expect(report.result.uiActionProposals).toHaveLength(1);
    expect(report.dialogue).toEqual([]);
    expect(report.conversationTimeline).toEqual([{text: expect.stringContaining(source)}]);
    expect(report.agentResponses).toEqual([]);
    expect(report.analysisNotes).toEqual([]);
    expect(report.analysisPlan).toBeNull();
    expect(report.uncertaintyFlags).toEqual([]);
    expect(report.outputLanguage).toBe('en');
    expect(report.query).toContain('Private source or knowledge analysis request');
    expect(report.sourceContext).toEqual({
      selected: [{
        codebaseId: 'private-app',
        displayName: 'Private App',
        kind: 'app_source',
      }, {
        codebaseId: 'private-kernel',
        displayName: 'Private Kernel',
        kind: 'kernel_source',
      }],
      lookupCount: 2,
      queriedCodebaseIds: ['private-app', 'private-kernel'],
      usedCodebaseIds: ['private-app'],
    });
    const html = new HTMLReportGenerator().generateAgentDrivenHTML({
      ...report,
      result: {
        sessionId,
        success: true,
        findings: [],
        hypotheses: [],
        conclusion: 'Safe projected conclusion.',
        confidence: 0.8,
        rounds: 1,
        totalDurationMs: 10,
      },
      hypotheses: [],
      dataEnvelopes: [],
      sourceContext: report.sourceContext,
    });
    expect(html).toContain('<html lang="en">');
    expect(html).toContain('SmartPerfetto Agent-Driven Analysis Report');
    expect(html).toContain('Source Context');
    expect(html).toContain('Selected');
    expect(html).toContain('Actually used/consulted');
    expect(html).toContain('Private App');
    expect(html).toContain('Private Kernel');
    expect(html).toContain('Trace, Skill, and SQL evidence remain authoritative');
    expect(JSON.stringify(report)).not.toContain('PRIVATE_');
    clearCodeAwareOutputGuards(sessionId);
  });

  it('fail-closes malicious legacy source context at the report boundary', () => {
    const sessionId = 'malicious-source-context-session';
    const report = buildAgentDrivenReportData({
      session: {
        sessionId,
        traceId: 'trace-a',
        query: 'private source query',
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
          }, {
            codebaseId: '/Users/chris/Code/SecretApp',
            displayName: 'Secret App',
            kind: 'app_source',
            indexGeneration: 1,
          }, {
            codebaseId: 'bad whitespace',
            displayName: 'Bad Space',
            kind: 'kernel_source',
            indexGeneration: 1,
          }, {
            codebaseId: 'url-name',
            displayName: 'https://example.com/source',
            kind: 'aosp',
            indexGeneration: 1,
          }, {
            codebaseId: 'bad-kind',
            displayName: 'Bad Kind',
            kind: 'unknown_kind',
            indexGeneration: 1,
          }],
          codeLookupSummary: {
            lookupCount: 5,
            patchCount: 0,
            referencedCodebaseIds: [
              'safe-app',
              '/Users/chris/Code/SecretApp',
              'bad whitespace',
              'url-name',
              'bad-kind',
            ],
            usedCodebaseIds: [
              'safe-app',
              '/Users/chris/Code/SecretApp',
              'missing-but-valid',
              'bad whitespace',
            ],
          },
        },
      } as any,
      result: baseResult(sessionId),
    });

    expect(report.sourceContext).toEqual({
      selected: [{
        codebaseId: 'safe-app',
        displayName: 'Safe App',
        kind: 'app_source',
      }, {
        codebaseId: 'url-name',
        kind: 'aosp',
      }, {
        codebaseId: 'bad-kind',
        displayName: 'Bad Kind',
      }],
      lookupCount: 5,
      queriedCodebaseIds: ['bad-kind', 'safe-app', 'url-name'],
      usedCodebaseIds: ['safe-app'],
    });

    const html = new HTMLReportGenerator().generateAgentDrivenHTML({
      ...report,
      result: baseResult(sessionId),
      hypotheses: [],
      dataEnvelopes: [],
    });
    expect(html).toContain('Safe App');
    expect(html).not.toContain('/Users/chris/Code/SecretApp');
    expect(html).not.toContain('Secret App');
    expect(html).not.toContain('Bad Space');
    expect(html).not.toContain('https://example.com/source');
    expect(JSON.stringify(report)).not.toContain('/Users/chris');
  });

  it.each(['absent', 'empty', 'unknown-claim'] as const)(
    'does not promote %s source verification bindings into report data', verificationCase => {
    const reference = sanitizeSourceReference({
      referenceId: 'lookup-1',
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
      references: [reference],
      rootPath: '/Users/chris/private-source',
      query: 'SECRET_QUERY_CANARY',
      snippet: 'SECRET_SNIPPET_CANARY',
    } as any;
    const sourceClaimBindings = [{
      claimId: 'claim-1',
      mechanismStatus: 'compatible' as const,
      sourceReferenceIds: [reference.id],
      traceEvidenceRefIds: ['trace-evidence-1'],
      reason: 'SECRET_BINDING_REASON_CANARY',
    }];
    const report = buildAgentDrivenReportData({
      session: {
        sessionId: 'source-report-session',
        traceId: 'trace-source-report',
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
      result: {
        ...baseResult('source-report-session'),
        sourceUseDecision,
        ...(verificationCase !== 'absent' ? {sourceClaimVerificationResult: {
          schemaVersion: 'source_claim_verifier@1' as const, status: 'passed' as const, issues: [],
          bindings: [{claimId: verificationCase === 'unknown-claim' ? 'unknown-claim' : 'claim-1',
            mechanismStatus: 'compatible' as const,
            sourceReferenceIds: verificationCase === 'empty' ? [] : [reference.id],
            traceEvidenceRefIds: ['trace-evidence-1']}],
        }} : {}),
        conclusionContract: {
          schemaVersion: 'conclusion_contract_v1',
          mode: 'focused_answer',
          conclusions: [{rank: 1, statement: 'Foo.run is compatible with the trace.'}],
          clusters: [],
          evidenceChain: [],
          claims: [{id: 'claim-1', text: 'Foo.run is compatible with the trace.', references: []}],
          sourceUseDecision,
          sourceReferences: [reference],
          sourceClaimBindings,
          uncertainties: [],
          nextSteps: [],
        },
      },
    });

    expect(report.sourceContext).toEqual(expect.objectContaining({
      sourceUseDecision: expect.objectContaining({
        schemaVersion: 'source_use_decision@1',
        codeAwareMode: 'provider_send',
        selectedCodebaseIds: ['safe-app'],
        queriedCodebaseIds: ['safe-app'],
        usedCodebaseIds: ['safe-app'],
        status: 'corroborated',
        coverageComplete: true,
      }),
      sourceClaimBindings: [],
    }));
    expect(JSON.stringify(report.sourceContext)).not.toContain('/Users/chris');
    expect(JSON.stringify(report.sourceContext)).not.toContain('SECRET_');
  });

  it('keeps the current final body and receipt together when history contains another turn', () => {
    const sessionId = 'report-current-body';
    const conclusion = 'Current body without a heading or terminal punctuation';
    const completion = {schemaVersion: 1 as const, runtimeKind: 'openai-agents-sdk' as const, status: 'completed' as const,
      candidateRef: 'candidate-current', runId: 'run-current', attemptId: 'attempt-current',
      conclusionFingerprint: analysisDeliveryFingerprint(conclusion)};
    const session = {sessionId, traceId: 'trace-a', query: 'current query', orchestrator: {},
      hypotheses: [], agentDialogue: [], conversationSteps: [], dataEnvelopes: [], agentResponses: [],
      runSequence: 2, conclusionHistory: [{turn: 1, conclusion: 'Prior completed report.', confidence: 1, timestamp: 1}]};
    const result = {...baseResult(sessionId), conclusion, completion,
      runtimeAppendix: {schemaVersion: 1 as const, origin: 'runtime_fallback' as const,
        sourceCandidate: completion, text: 'Separate runtime provenance.'}};
    expect(buildAgentDrivenReportData({session: session as any, result}).result).toEqual(result);
    const emptyResult = {...result, conclusion: '', completion: {...completion, status: 'unknown' as const,
      conclusionFingerprint: analysisDeliveryFingerprint('')}};
    const report = buildAgentDrivenReportData({session: session as any, result: emptyResult});
    expect(report.result.conclusion).toBe('');
    expect(report.result.completion).toEqual(emptyResult.completion);
    expect(report.result.runtimeAppendix?.text).toBe('Separate runtime provenance.');
    expect(report.conclusionHistory?.[0].conclusion).toBe('Prior completed report.');
  });
});
