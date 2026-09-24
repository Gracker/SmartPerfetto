// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {describe, expect, it, jest} from '@jest/globals';
import {renderConclusionContractSidecar} from '../../agent/core/conclusionContract';
import type {AnalysisTurnIntent} from '../analysisTurnIntent';
import {
  acceptNativeDeclarationCompletion,
  buildNativeDeclarationCompletionPrompt,
  buildRelationProposalRecoveryPromptFragment,
  nativeDeclarationBodyCanFitOutput,
  requestNativeDeclarationCompletion,
  INVALID_NATIVE_DECLARATION,
} from '../runtimeConclusionProtocol';
import {buildCandidateProtocolDiagnostic, inspectCandidateProtocol} from '../../services/canonicalAnalysisResult';

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

const declaration = (mode: 'focused_answer' | 'need_input' = 'focused_answer') =>
  renderConclusionContractSidecar({
    schemaVersion: 'conclusion_contract_v1',
    mode,
    conclusions: [],
    clusters: [],
    evidenceChain: [],
    claims: [],
    relationProposals: [],
    uncertainties: [],
    nextSteps: [],
  });

describe('runtime native declaration completion', () => {
  const semantics = {schemaVersion: 'claim_semantics@1', predicate: 'numeric.cell', polarity: 'affirmed',
    discourse: 'asserted', quantifier: 'one', modality: 'certain', scope: {population: 'cited_rows'}};
  const claim = (id: string, extra: Record<string, unknown> = {}) =>
    ({id, kind: 'numeric', text: `${id} holds.`, references: [], semantics, ...extra});
  const contract = (claims: unknown[]) => renderConclusionContractSidecar({schemaVersion: 'conclusion_contract_v1',
    mode: 'focused_answer', conclusions: [], clusters: [], evidenceChain: [], claims, uncertainties: [], nextSteps: []} as any);
  const body = 'Line one.\n\nLine two.';
  const rejected = contract([claim('a'), claim('b', {semantics: {...semantics, scope: {population: 'everywhere'}}})]);
  const repair = (candidate: string, repairInvalid = true) => requestNativeDeclarationCompletion({
    intent: intent('investigation'), completion: {status: 'completed'}, candidate, remainingDeliveryTurns: 1, repairInvalid});

  it('offers one repair for a well-framed rejected declaration, with the body and the declaration kept apart', () => {
    const request = repair(`${body}\n\n${rejected}`)!;
    expect(request).toMatchObject({reason: INVALID_NATIVE_DECLARATION, originalBody: body});
    expect(request.rejectedDeclaration).toContain('everywhere');
    expect(request.diagnostic.claimDiagnostics).toEqual([{ordinal: 2, code: 'invalid_semantics', field: 'semantics.scope.population'}]);
    expect(repair(`${body}\n\n${rejected}`, false)).toBeUndefined();
    // A framing failure can truncate the body, so it keeps the existing path.
    expect(repair(`${body}\n\n${rejected}\n\n${rejected}`)).toBeUndefined();
    expect(repair(`${body}\n\n${rejected.slice(0, rejected.lastIndexOf('-->'))}`)).toBeUndefined();
    const prompt = buildNativeDeclarationCompletionPrompt({request, intent: intent('investigation'), outputLanguage: 'en'});
    expect(prompt).toContain('invalid_declaration');
    expect(prompt).toContain('rejected_declaration');
    expect(prompt).toContain('"ordinal":2');
  });

  it('accepts a repair only when it keeps the body and every declared claim', () => {
    const request = repair(`${body}\n\n${rejected}`)!;
    const accept = (candidate: string) => acceptNativeDeclarationCompletion({request, completion: {status: 'completed'}, candidate});
    expect(accept(`${body}\n\n${contract([claim('a'), claim('b')])}`)).toBeDefined();
    expect(accept(`${body}\n\n${contract([claim('a')])}`)).toBeUndefined();
    expect(accept(`${body} Edited.\n\n${contract([claim('a'), claim('b')])}`)).toBeUndefined();
    expect(accept(`${body}\n\n${rejected}`)).toBeUndefined();
  });

  it('logs why a completion was rejected in closed vocabulary, never the model text', () => {
    // rooted_lock_monitor: a valid 14-claim completion was dropped with no record of the reason.
    const original = '决定性证据:SF 主线程阻塞 33ms,等待 HWC。';
    const request = requestNativeDeclarationCompletion({intent: intent('investigation'), completion: {status: 'completed'},
      candidate: original, remainingDeliveryTurns: 1})!;
    const log = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      const fullWidth = original.replace(':', '：').replace(',', '，');
      expect(acceptNativeDeclarationCompletion({request, completion: {status: 'completed'},
        candidate: `${fullWidth}\n\n${contract([claim('a')])}`})).toBeUndefined();
      expect(acceptNativeDeclarationCompletion({request, completion: {status: 'unknown'},
        candidate: `${original}\n\n${contract([claim('a')])}`})).toBeUndefined();
      const lines = log.mock.calls.map(call => String(call[0]));
      expect(lines).toEqual([
        '[DeclarationRepair] completion rejected: request=missing_declaration reason=body_changed ' +
          `originalChars=${original.length} repairedChars=${original.length} firstDifference=5 nfkcEqual=true`,
        '[DeclarationRepair] completion rejected: request=missing_declaration reason=completion_not_completed completion=unknown',
      ]);
      expect(lines.join('\n')).not.toContain('HWC');
    } finally {
      log.mockRestore();
    }
  });

  it.each(['en', 'zh-CN'] as const)('asks a %s repair to pass the full protocol, not only the listed fields', outputLanguage => {
    const prompt = buildNativeDeclarationCompletionPrompt({request: repair(`${body}\n\n${rejected}`)!,
      intent: intent('investigation'), outputLanguage});
    expect(prompt).toContain('24');
    expect(prompt).toContain(outputLanguage === 'en' ? 'must pass the full protocol' : '必须通过完整协议校验');
  });

  it('rejects a repair that swaps a declared claim for another one', () => {
    const request = repair(`${body}\n\n${rejected}`)!;
    expect(request.declaredClaimIds).toEqual(['a', 'b']);
    expect(acceptNativeDeclarationCompletion({request, completion: {status: 'completed'},
      candidate: `${body}\n\n${contract([claim('a'), claim('c')])}`})).toBeUndefined();
  });

  it('does not bind a repair to a blank id the parser itself rejects', () => {
    const request = repair(`${body}\n\n${contract([claim('a'), claim('', {semantics})])}`)!;
    expect(request.declaredClaimIds).toEqual(['a']);
    expect(request.diagnostic.claimDiagnostics).toEqual([{ordinal: 2, code: 'invalid_claim', field: 'id'}]);
    expect(acceptNativeDeclarationCompletion({request, completion: {status: 'completed'},
      candidate: `${body}\n\n${contract([claim('a'), claim('b')])}`})).toBeDefined();
  });

  it('repairs a well-framed declaration whose JSON does not parse, without a claim baseline', () => {
    const broken = rejected.replace('"claims"', '"claims" oops');
    const request = repair(`${body}\n\n${broken}`)!;
    expect(request).toMatchObject({reason: INVALID_NATIVE_DECLARATION, originalBody: body, declaredClaimIds: []});
    expect(request.diagnostic.issueCodes).toEqual(['invalid_json']);
    expect(acceptNativeDeclarationCompletion({request, completion: {status: 'completed'},
      candidate: `${body}\n\n${contract([claim('a')])}`})).toBeDefined();
  });

  it('lists at most 24 failing claims', () => {
    const many = contract(Array.from({length: 30}, (_, index) => claim(`c${index}`, {semantics: {...semantics, polarity: 'maybe'}})));
    const request = repair(`${body}\n\n${many}`)!;
    expect(request.diagnostic.claimDiagnostics).toHaveLength(24);
    expect(request.diagnostic.claimDiagnostics![23]).toEqual({ordinal: 24, code: 'invalid_semantics', field: 'semantics.polarity'});
    expect(request.diagnostic.issueCount).toBe(30);
  });

  it('adds exact relation guidance to a rejected declaration repair', () => {
    const invalidRelation = renderConclusionContractSidecar({schemaVersion: 'conclusion_contract_v1', mode: 'focused_answer',
      conclusions: [], clusters: [], evidenceChain: [], claims: [claim('a')], uncertainties: [], nextSteps: [],
      relationProposals: [{kind: 'overlap'}]} as any);
    const request = repair(`${body}\n\n${invalidRelation}`)!;
    expect(request.reason).toBe(INVALID_NATIVE_DECLARATION);
    expect(buildNativeDeclarationCompletionPrompt({request, intent: intent('investigation'), outputLanguage: 'zh-CN'}))
      .toContain('proofBindings');
  });

  it.each(['en', 'zh-CN'] as const)('loads exact relation schema only for a sanitized invalid relation in %s', outputLanguage => {
    const invalid = renderConclusionContractSidecar({...JSON.parse(JSON.stringify({
      schemaVersion: 'conclusion_contract_v1', mode: 'focused_answer', conclusions: [], clusters: [],
      evidenceChain: [], claims: [], uncertainties: [], nextSteps: [],
    })), relationProposals: [{PRIVATE_RELATION_KEY_CANARY: 'PRIVATE_RELATION_VALUE_CANARY'}]} as any);
    const diagnostic = buildCandidateProtocolDiagnostic(inspectCandidateProtocol(invalid), 'native', 1);
    const fragment = buildRelationProposalRecoveryPromptFragment(diagnostic, outputLanguage);
    expect(fragment).toContain('proofBindings');
    expect(fragment).toContain('endpointColumn');
    expect(fragment).toContain('current_minus_reference');
    expect(fragment).toContain('proposal:[A-Za-z0-9]');
    expect(fragment).toContain(outputLanguage === 'en' ? 'cannot be null' : '不能是 null');
    expect(fragment).not.toContain('PRIVATE_RELATION_');

    const absent = buildCandidateProtocolDiagnostic(inspectCandidateProtocol('ordinary answer'), 'native', 1);
    expect(buildRelationProposalRecoveryPromptFragment(absent, outputLanguage)).toBe('');
    expect(buildRelationProposalRecoveryPromptFragment({...diagnostic,
      relationProposalDiagnostics: [{scope: 'item', ordinal: 25, reason: 'invalid_id'}]} as any, outputLanguage)).toBe('');
  });

  it.each(['fact', 'investigation', 'comparison'] as const)(
    'requests one completion for a completed undeclared %s candidate', taskKind => {
      expect(requestNativeDeclarationCompletion({
        intent: intent(taskKind), completion: {status: 'completed'}, candidate: 'Answer', remainingDeliveryTurns: 1,
      })).toMatchObject({reason: 'missing_declaration', originalBody: 'Answer', diagnostic: {status: 'absent'}});
    },
  );

  it('exempts typed acknowledgements and rejects ineligible candidates without reading prose intent', () => {
    for (const input of [
      {intent: intent('acknowledgement'), completion: {status: 'completed' as const}, candidate: '42 ms', remainingDeliveryTurns: 1},
      {intent: intent('fact'), completion: {status: 'incomplete' as const}, candidate: 'Answer', remainingDeliveryTurns: 1},
      {intent: intent('fact'), completion: {status: 'completed' as const}, candidate: '', remainingDeliveryTurns: 1},
      {intent: intent('fact'), completion: {status: 'completed' as const}, candidate: `Answer\n${declaration()}`, remainingDeliveryTurns: 1},
      {intent: intent('fact'), completion: {status: 'completed' as const}, candidate: 'Answer', remainingDeliveryTurns: 0},
    ]) expect(requestNativeDeclarationCompletion(input)).toBeUndefined();
  });

  it('carries the complete >8 KiB multilingual body in the dedicated prompt', () => {
    const body = `开头🙂\n${'中English🙂'.repeat(1300)}\n结尾`;
    expect(Buffer.byteLength(body, 'utf8')).toBeGreaterThan(8 * 1024);
    const request = requestNativeDeclarationCompletion({
      intent: intent('investigation'), completion: {status: 'completed'}, candidate: body, remainingDeliveryTurns: 1,
    })!;
    const prompt = buildNativeDeclarationCompletionPrompt({request, intent: intent('investigation'), outputLanguage: 'zh-CN'});
    const encoded = JSON.stringify({schemaVersion: 1, kind: 'original_native_candidate', body});
    expect(prompt).toContain(encoded);
    expect(prompt).toContain('missing_declaration');
    expect(prompt).not.toContain('[omitted: byte budget]');
  });

  it('projects only closed turn-scope fields and excludes classifier prose and receipts', () => {
    const classified = {...intent('investigation'), reason: 'UNTRUSTED_CLASSIFIER_REASON',
      actualModel: 'private-model', finishReason: 'stop'};
    const request = requestNativeDeclarationCompletion({
      intent: classified, completion: {status: 'completed'}, candidate: 'Answer', remainingDeliveryTurns: 1,
    })!;
    const prompt = buildNativeDeclarationCompletionPrompt({request, intent: classified, outputLanguage: 'en'});
    expect(prompt).toContain(JSON.stringify({schemaVersion: 1, status: 'resolved', taskKind: 'investigation',
      sceneId: 'general', scope: 'bounded_question', deliverable: 'answer', evidenceAccess: 'read_new'}));
    expect(prompt).not.toContain('UNTRUSTED_CLASSIFIER_REASON');
    expect(prompt).not.toContain('private-model');
    expect(prompt).not.toContain('registry');
  });

  it('accepts a valid full candidate with an unchanged body, including need_input', () => {
    for (const mode of ['focused_answer', 'need_input'] as const) {
      const originalBody = mode === 'need_input' ? 'Which trace should I inspect?' : 'Measured value: 42 ms.';
      const request = requestNativeDeclarationCompletion({
        intent: intent('investigation'), completion: {status: 'completed'}, candidate: originalBody, remainingDeliveryTurns: 1,
      })!;
      const candidate = `${originalBody}\n${declaration(mode)}`;
      expect(acceptNativeDeclarationCompletion({request, completion: {status: 'completed'}, candidate})).toBe(candidate);
    }
  });

  it.each([
    ['middle edit', 'Measured value: 43 ms.\n'],
    ['line-ending edit', 'first\nsecond\n'],
    ['truncated body', 'Measured value:'],
    ['absent declaration', 'Measured value: 42 ms.'],
  ])('rejects %s', (_name, repairedBody) => {
    const originalBody = _name === 'line-ending edit' ? 'first\r\nsecond\r\n' : 'Measured value: 42 ms.';
    const request = requestNativeDeclarationCompletion({
      intent: intent('investigation'), completion: {status: 'completed'}, candidate: originalBody, remainingDeliveryTurns: 1,
    })!;
    const candidate = _name === 'absent declaration' ? repairedBody : `${repairedBody}${declaration()}`;
    expect(acceptNativeDeclarationCompletion({request, completion: {status: 'completed'}, candidate})).toBeUndefined();
  });

  it('rejects invalid, failed and incomplete repairs', () => {
    const request = requestNativeDeclarationCompletion({
      intent: intent('fact'), completion: {status: 'completed'}, candidate: 'Answer', remainingDeliveryTurns: 1,
    })!;
    const invalid = 'Answer\n<!-- smartperfetto:conclusion-contract@1\n```json\nnull\n```\n-->';
    expect(acceptNativeDeclarationCompletion({request, completion: {status: 'completed'}, candidate: invalid})).toBeUndefined();
    for (const status of ['incomplete', 'failed', 'cancelled', 'unknown'] as const) {
      expect(acceptNativeDeclarationCompletion({request, completion: {status}, candidate: `Answer\n${declaration()}`})).toBeUndefined();
    }
  });

  it('checks existing output limits without truncating the body', () => {
    expect(nativeDeclarationBodyCanFitOutput('中文', 7)).toBe(true);
    expect(nativeDeclarationBodyCanFitOutput('中文', 6)).toBe(false);
    expect(nativeDeclarationBodyCanFitOutput('any length', undefined)).toBe(true);
    expect(nativeDeclarationBodyCanFitOutput('body', 0)).toBe(false);
  });

  it('accepts the exact output cap and rejects the same complete candidate one byte over it', () => {
    const originalBody = 'x'.repeat(100);
    const request = requestNativeDeclarationCompletion({
      intent: intent('fact'), completion: {status: 'completed'}, candidate: originalBody, remainingDeliveryTurns: 1,
    })!;
    const candidate = `${originalBody}\n${declaration()}`;
    const candidateBytes = Buffer.byteLength(candidate, 'utf8');
    expect(nativeDeclarationBodyCanFitOutput(originalBody, candidateBytes)).toBe(true);
    expect(acceptNativeDeclarationCompletion({request, completion: {status: 'completed'}, candidate,
      outputByteLimit: candidateBytes})).toBe(candidate);
    expect(acceptNativeDeclarationCompletion({request, completion: {status: 'completed'}, candidate,
      outputByteLimit: candidateBytes - 1}))
      .toBeUndefined();
  });
});
