// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import { createRenderer, parseOutputFormat, parseTextJsonFormat } from '../renderer';

describe('CLI renderer', () => {
  test.each(['json', 'ndjson'] as const)('preserves scene report references in %s completion', format => {
    const sceneReport = {schemaVersion: 'scene_report_ref@1' as const, reportId: 'scene-v3-cli', sessionId: 'session',
      traceId: 'trace', runId: 'run', revision: 2, expiresAt: Date.now() + 60_000, manifestSha256: 'a'.repeat(64)};
    const output = captureStdout(() => {
      const renderer = createRenderer({verbose: false, useColor: false, format});
      renderer.printConclusion('body', {});
      renderer.printCompletion({sessionId: 'session', sessionDir: '/tmp/session', reportPath: '/tmp/session/report.html',
        sceneReport, sceneReportStatus: 'partial'});
    });
    const records = output.trim().split('\n').map(line => JSON.parse(line));
    expect(records[records.length - 1]).toMatchObject({sceneReport, sceneReportStatus: 'partial'});
  });
  test('text completion calls a scene result partial and links the authorized report endpoint', () => {
    const output = captureStdout(() => {
      const renderer = createRenderer({verbose: false, useColor: false, format: 'text'});
      renderer.printCompletion({sessionId: 'session', sessionDir: '/tmp/session', reportPath: '/tmp/session/report.html',
        sceneReportStatus: 'partial', sceneReport: {schemaVersion: 'scene_report_ref@1', reportId: 'scene-v3-cli', sessionId: 'session',
          traceId: 'trace', runId: 'run', revision: 2, expiresAt: Date.now() + 60_000, manifestSha256: 'a'.repeat(64)}});
    });
    expect(output).toMatch(/部分结果|partial result/);
    expect(output).toContain('/api/agent/v1/scene-reconstruct/report/scene-v3-cli');
  });
  test('text prints the provisional answer at once and the verdict later without repeating the body', () => {
    const output = captureStdout(() => {
      const renderer = createRenderer({verbose: false, useColor: false, format: 'text'});
      renderer.printProvisionalConclusion?.('Answer body line.');
      renderer.printConclusion('Answer body line.', {claimVerification: {status: 'partial', totalClaimCount: 1,
        verifiedClaimCount: 0, notCheckedReason: 'cancelled_by_user'}});
      renderer.printCompletion({sessionId: 's', sessionDir: '/tmp/s', reportPath: '/tmp/s/report.html',
        deliveryVerdict: 'unverified'});
    });
    expect(output.split('Answer body line.')).toHaveLength(2);
    expect(output.indexOf('Answer body line.')).toBeLessThan(output.indexOf('已按用户要求停止语义复核'));
    expect(output).toMatch(/正在核验|verification in progress/);
    expect(output).toContain('~ session');
  });

  test('text reprints a body that changed after the provisional answer', () => {
    const output = captureStdout(() => {
      const renderer = createRenderer({verbose: false, useColor: false, format: 'text'});
      renderer.printProvisionalConclusion?.('Answer body.');
      renderer.printConclusion('Answer body.\n\nQuality notice.', {});
    });
    expect(output).toContain('Quality notice.');
  });

  test.each(['json', 'ndjson'] as const)('%s output never carries the provisional answer', format => {
    const output = captureStdout(() => {
      const renderer = createRenderer({verbose: false, useColor: false, format});
      renderer.printProvisionalConclusion?.('provisional body');
      renderer.printConclusion('final body', {});
      renderer.printCompletion({sessionId: 's', sessionDir: '/tmp/s', reportPath: '/tmp/s/report.html'});
    });
    expect(output).not.toContain('provisional body');
  });

  test('renders one JSON object after completion', () => {
    const analysisEvidence = evidenceBundle();
    const output = captureStdout(() => {
      const renderer = createRenderer({ verbose: false, useColor: false, format: 'json' });
      renderer.onEvent({ type: 'progress', content: { phase: 'x', message: 'ignored' } } as any);
      renderer.printConclusion('done', { confidence: 0.8, rounds: 2, durationMs: 1234, analysisEvidence });
      renderer.printCompletion({ sessionId: 's1', sessionDir: '/tmp/s1', reportPath: '/tmp/s1/report.html' });
    });

    const parsed = JSON.parse(output);
    expect(parsed).toMatchObject({
      ok: true,
      sessionId: 's1',
      conclusion: 'done',
      confidence: 0.8,
      rounds: 2,
      durationMs: 1234,
      analysisEvidence,
    });
  });

  test('keeps investigation deficits separate from machine completion', () => {
    const output = captureStdout(() => {
      const renderer = createRenderer({verbose: false, useColor: false, format: 'json'});
      renderer.printConclusion('done', {investigationAssurance: {investigation: 'passed', investigationEvidence: 'coverage_incomplete'}});
      renderer.printCompletion({sessionId: 'system', sessionDir: '/tmp/system', reportPath: '/tmp/system/report.html', success: true});
    });
    expect(JSON.parse(output)).toMatchObject({ok: true, conclusion: 'done',
      investigationAssurance: {investigation: 'passed', investigationEvidence: 'coverage_incomplete'}});
  });

  test('renders NDJSON event, conclusion, and completion records', () => {
    const output = captureStdout(() => {
      const renderer = createRenderer({ verbose: false, useColor: false, format: 'ndjson' });
      renderer.onEvent({ type: 'progress', content: { phase: 'load', message: 'loading' } } as any);
      renderer.printConclusion('done', { confidence: 0.9 });
      renderer.printCompletion({ sessionId: 's2', sessionDir: '/tmp/s2', reportPath: '/tmp/s2/report.html' });
    });

    const lines = output.trim().split('\n').map((line) => JSON.parse(line));
    expect(lines).toHaveLength(3);
    expect(lines[0]).toMatchObject({ type: 'event', eventType: 'progress' });
    expect(lines[1]).toMatchObject({ type: 'conclusion', conclusion: 'done', confidence: 0.9 });
    expect(lines[2]).toMatchObject({ type: 'complete', ok: true, sessionId: 's2' });
  });

  test('machine conclusion includes deterministic verifier verdict', () => {
    const analysisEvidence = evidenceBundle();
    const output = captureStdout(() => {
      const renderer = createRenderer({ verbose: false, useColor: false, format: 'ndjson' });
      renderer.printConclusion('done', {
        confidence: 0.9,
        claimVerification: {
          status: 'passed',
          checkedClaimCount: 1,
          unsupportedClaimCount: 0,
          issueCount: 0,
        },
        analysisEvidence,
      });
    });

    expect(JSON.parse(output)).toMatchObject({
      type: 'conclusion',
      conclusion: 'done',
      claimVerification: {
        status: 'passed',
        checkedClaimCount: 1,
      },
      analysisEvidence,
    });
  });

  test('text output renders every claim issue and source binding exactly once', () => {
    const output = captureStdout(() => {
      const renderer = createRenderer({verbose: false, useColor: false, format: 'text'});
      renderer.printConclusion('done', {analysisEvidence: evidenceBundle()});
    });

    expect(output.match(/## 证据详情|## Evidence details/g)).toHaveLength(1);
    expect(output).toContain('issue-9');
    expect(output).toContain('source-binding-21');
    expect(output).toContain('evidence-ref-declared');
    expect(output).toContain('native-anchor');
  });

  test('machine completion reflects failed analysis status', () => {
    const output = captureStdout(() => {
      const renderer = createRenderer({ verbose: false, useColor: false, format: 'json' });
      renderer.printConclusion('failed', { confidence: 0.1 });
      renderer.printCompletion({
        sessionId: 's3',
        sessionDir: '/tmp/s3',
        reportPath: '/tmp/s3/report.html',
        success: false,
      });
    });

    expect(JSON.parse(output)).toMatchObject({ ok: false, sessionId: 's3' });
  });

  test('text completion suggests valid follow-up commands', () => {
    const output = captureStdout(() => {
      const renderer = createRenderer({ verbose: false, useColor: false, format: 'text' });
      renderer.printCompletion({
        sessionId: 's4',
        sessionDir: '/tmp/s4',
        reportPath: '/tmp/s4/report.html',
      });
    });

    expect(output).toContain('smp ask s4 "..."');
    expect(output).toContain('smp repl --resume s4');
    expect(output).not.toContain('smp resume s4');
  });

  test('rejects unknown output formats', () => {
    expect(() => parseOutputFormat('xml')).toThrow('Invalid --format value');
  });

  test('explains a quality failure without claiming that a narrative is missing', () => {
    const output = captureStdout(() => {
      const renderer = createRenderer({verbose: false, useColor: false});
      renderer.printConclusion('Evidence and limitations are present.', {});
      renderer.printCompletion({sessionId: 'gate', sessionDir: '/tmp/gate', reportPath: '/tmp/gate/report.html',
        partial: true, hasConclusion: true, terminationReason: 'quality_gate_failed',
        terminationMessage: '13 claims have invalid declarations or bindings.'});
    });
    expect(output).toMatch(/已有正文，但未通过质量校验|a narrative is available, but quality checks did not pass/);
    expect(output).toContain('13 claims have invalid declarations or bindings.');
    expect(output).not.toContain('结果为部分内容');
  });

  test('states that no deliverable was produced when a turn cap has no body', () => {
    const output = captureStdout(() => {
      const renderer = createRenderer({verbose: false, useColor: false});
      renderer.printConclusion('   ', {confidence: 0});
      renderer.printCompletion({sessionId: 'empty', sessionDir: '/tmp/empty', reportPath: '/tmp/empty/report.html',
        partial: true, hasConclusion: false, terminationReason: 'max_turns'});
    });
    expect(output).toMatch(/未生成可交付结论|without a deliverable conclusion/);
    expect(output).toContain('max_turns');
    expect(output).not.toContain('(空)');
    expect(output).not.toContain('结果为部分内容');
  });

  test.each(['json', 'ndjson'] as const)('preserves termination diagnostics in %s', format => {
    const output = captureStdout(() => {
      const renderer = createRenderer({verbose: false, useColor: false, format});
      renderer.printConclusion('', {});
      renderer.printCompletion({sessionId: 'empty', sessionDir: '/tmp/empty', reportPath: '/tmp/empty/report.html',
        partial: true, hasConclusion: false, terminationReason: 'max_turns', terminationMessage: 'Turn budget exhausted.'});
    });
    const records = output.trim().split('\n').map(line => JSON.parse(line));
    expect(records[records.length - 1]).toMatchObject({partial: true, hasConclusion: false,
      terminationReason: 'max_turns', terminationMessage: 'Turn budget exhausted.'});
  });

  test('rejects ndjson for text/json-only commands', () => {
    expect(parseTextJsonFormat('json')).toBe('json');
    expect(() => parseTextJsonFormat('ndjson')).toThrow('Expected text or json');
  });
});

function captureStdout(fn: () => void): string {
  const original = process.stdout.write;
  const originalConsoleLog = console.log;
  let output = '';
  (process.stdout.write as any) = (chunk: any) => {
    output += Buffer.isBuffer(chunk) ? chunk.toString('utf-8') : String(chunk);
    return true;
  };
  console.log = (...values: unknown[]) => {
    output += `${values.map(String).join(' ')}\n`;
  };
  try {
    fn();
  } finally {
    process.stdout.write = original;
    console.log = originalConsoleLog;
  }
  return output;
}

function evidenceBundle(): any {
  return {
    schemaVersion: 'cli_analysis_evidence@1',
    binding: {
      sessionId: 's1',
      turn: 1,
      conclusionFingerprint: 'a'.repeat(64),
      turnMarkdownFingerprint: 'b'.repeat(64),
      candidate: null,
    },
    evidenceFingerprint: 'c'.repeat(64),
    evidence: {
      conclusionBindingEligibility: 'eligible',
      claims: [{id: 'claim-1', text: 'declared', references: [{evidenceRefId: 'evidence-ref-declared'}]}],
      claimSupport: [{
        claimId: 'claim-1', kind: 'categorical', text: 'declared', supportLevel: 'verified',
        anchors: [{anchorId: 'native-anchor'}],
      }],
      claimVerificationResult: {
        schemaVersion: 'claim_verifier@2', status: 'failed', policy: 'record_only', passed: false,
        checkedClaimCount: 1, unsupportedClaimCount: 1,
        claimResults: [{claimId: 'claim-1', status: 'unsupported', referenceResults: [{status: 'missing'}]}],
        issues: Array.from({length: 9}, (_, index) => ({
          claimId: 'claim-1', severity: 'error', code: `issue-${index + 1}`, message: `issue-${index + 1}`,
        })),
      },
      identityResolutions: [],
      investigationAssessment: null,
      deliveryAssurance: null,
      sourceUseDecision: null,
      sourceReferences: [],
      sourceClaimBindings: Array.from({length: 21}, (_, index) => ({
        claimId: `source-binding-${index + 1}`,
        mechanismStatus: 'compatible',
        sourceReferenceIds: [`source-${index + 1}`],
        traceEvidenceRefIds: [`trace-${index + 1}`],
      })),
    },
  };
}
