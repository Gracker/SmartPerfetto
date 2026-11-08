// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {describe, expect, it} from '@jest/globals';
import {renderConclusionContractSidecar} from '../../agent/core/conclusionContract';
import type {AnalysisTurnIntent} from '../analysisTurnIntent';
import {
  buildNativeOutputCompletionPrompt,
  candidateHasAnswerBody,
} from '../runtimeConclusionProtocol';

const intent = (taskKind: AnalysisTurnIntent['taskKind']): AnalysisTurnIntent => ({
  schemaVersion: 1,
  status: 'resolved',
  source: 'semantic',
  registryFingerprint: 'registry',
  taskKind,
  sceneId: 'general',
  scope: 'bounded_question',
  recommendedComplexity: taskKind === 'acknowledgement' ? 'quick' : 'full',
  deliverable: 'answer',
  evidenceAccess: taskKind === 'acknowledgement' ? 'existing_only' : 'read_new',
});

const declaration = renderConclusionContractSidecar({
  schemaVersion: 'conclusion_contract_v1', mode: 'focused_answer', conclusions: [], clusters: [],
  evidenceChain: [], claims: [], relationProposals: [], uncertainties: [], nextSteps: [],
});

const outputLimitIssue = [{type: 'missing_check' as const, severity: 'error' as const,
  recoveryKind: 'continue_output' as const, message: 'Native output_limit'}];

describe('body-only output completion prompt', () => {
  it.each(['en', 'zh-CN'] as const)('quotes an unclosed native candidate losslessly and asks for no declaration in %s', outputLanguage => {
    const candidate = `Line one.\n<!-- smartperfetto:conclusion-contract@1\n\`\`\`json\n{"claims":[{"text":"< & >"}`;
    const prompt = buildNativeOutputCompletionPrompt({candidate, intent: intent('investigation'),
      issues: outputLimitIssue, outputLanguage});
    const line = prompt.split('\n').find(item => item.startsWith('{"schemaVersion":1,"kind":"original_native_candidate"'))!;
    expect(JSON.parse(line).body).toBe(candidate);
    expect(line).not.toMatch(/[<>&]/);
    expect(prompt).toContain('continue_output');
    // The retired declaration protocol is not requested in either language.
    const instructions = prompt.slice(0, prompt.indexOf(line));
    expect(instructions).not.toMatch(/declaration|sidecar|proofBindings|claim\.kind|smartperfetto:conclusion-contract|声明/);
  });

  it('carries the complete >8 KiB multilingual body', () => {
    const body = `开头🙂\n${'中English🙂'.repeat(1300)}\n结尾`;
    expect(Buffer.byteLength(body, 'utf8')).toBeGreaterThan(8 * 1024);
    const prompt = buildNativeOutputCompletionPrompt({candidate: body, intent: intent('investigation'),
      issues: outputLimitIssue, outputLanguage: 'zh-CN'});
    expect(prompt).toContain(JSON.stringify({schemaVersion: 1, kind: 'original_native_candidate', body}));
    expect(prompt).not.toContain('[omitted: byte budget]');
  });

  it('projects only closed turn-scope fields and excludes classifier prose and receipts', () => {
    const classified = {...intent('investigation'), reason: 'UNTRUSTED_CLASSIFIER_REASON',
      actualModel: 'private-model', finishReason: 'stop'} as AnalysisTurnIntent;
    const prompt = buildNativeOutputCompletionPrompt({candidate: 'Answer', intent: classified,
      issues: outputLimitIssue, outputLanguage: 'en'});
    expect(prompt).toContain(JSON.stringify({schemaVersion: 1, status: 'resolved', taskKind: 'investigation',
      sceneId: 'general', scope: 'bounded_question', deliverable: 'answer', evidenceAccess: 'read_new'}));
    expect(prompt).not.toContain('UNTRUSTED_CLASSIFIER_REASON');
    expect(prompt).not.toContain('private-model');
    expect(prompt).not.toContain('registry');
  });
});

describe('answer body facts', () => {
  it('treats a stray machine segment alone as no body', () => {
    expect(candidateHasAnswerBody('Answer')).toBe(true);
    expect(candidateHasAnswerBody(`Answer\n\n${declaration}`)).toBe(true);
    expect(candidateHasAnswerBody(declaration)).toBe(false);
    expect(candidateHasAnswerBody('  ')).toBe(false);
  });
});
