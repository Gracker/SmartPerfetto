// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {describe, expect, it, jest} from '@jest/globals';
import {renderConclusionContractSidecar} from '../../agent/core/conclusionContract';
import type {AnalysisTurnIntent} from '../analysisTurnIntent';
import {
  acceptNativeDeclarationCompletion,
  buildNativeDeclarationCompletionPrompt,
  buildNativeOutputCompletionPrompt,
  buildRelationProposalRecoveryPromptFragment,
  nativeDeclarationBodyCanFitOutput,
  requestNativeDeclarationCompletion,
  recoverNativeDeclarationPayload,
  INVALID_NATIVE_DECLARATION,
} from '../runtimeConclusionProtocol';
import {buildCandidateProtocolDiagnostic, inspectCandidateProtocol} from '../../services/canonicalAnalysisResult';
import failures from '../../../tests/fixtures/pifix/declaration-failure-variants.json';
import anrExtended from '../../../tests/fixtures/pifix/anr-extended.json';
import scrollLocation from '../../../tests/fixtures/location-verdict/scroll.json';

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

  describe('persisted scroll declaration failure', () => {
    it.each(['en', 'zh-CN'] as const)('supplies first-submission schema in %s and keeps strict acceptance', outputLanguage => {
      expect(scrollLocation.diagnostics.map(item => [item.candidateIndex, item.status])).toEqual([
        [1, 'absent'], [2, 'invalid'], [1, 'absent'],
      ]);
      expect(scrollLocation.diagnostics[1]).toMatchObject({claimCount: 72, semanticClaimCount: 72,
        details: [{field: '$.clusters[]', reason: 'wrong_type', expected: 'object', actual: 'string'}]});
      const request = requestNativeDeclarationCompletion({intent: intent('investigation'), completion: {status: 'completed'},
        candidate: scrollLocation.body, remainingDeliveryTurns: 1})!;
      const prompt = buildNativeDeclarationCompletionPrompt({request, intent: intent('investigation'), outputLanguage});
      expect(prompt).toContain('clusters');
      expect(prompt).toContain('proofBindings');
      expect(prompt).toContain('endpointColumn');
      expect(prompt).toContain('proofColumn');
      expect(prompt).toContain('semantics.numeric');
      expect(prompt).toContain('numeric_presentation@1');
      const payload = recoverNativeDeclarationPayload(contract([claim('a')])) as Record<string, unknown>;
      // The rejected JSON was not persisted; reconstruct only the observed failure classes.
      const broken = {...payload, clusters: ['shorthand topic'], relationProposals: [{explanation: 'not a schema field'}]};
      expect(acceptNativeDeclarationCompletion({request, completion: {status: 'completed'}, candidate: JSON.stringify(broken)}))
        .toBeUndefined();
      const accepted = acceptNativeDeclarationCompletion({request, completion: {status: 'completed'}, candidate: JSON.stringify(payload)})!;
      expect(inspectCandidateProtocol(accepted).canonicalBody.trim()).toBe(scrollLocation.body.trim());
      expect(inspectCandidateProtocol(accepted).sidecar.contract!.claims).toHaveLength(1);
      const malformedNumeric = recoverNativeDeclarationPayload(contract([claim('a', {semantics: {...semantics,
        numeric: {operator: 'eq', value: 9, unit: 'ms', tolerance: 1}}})]));
      const partial = acceptNativeDeclarationCompletion({request, completion: {status: 'completed'},
        candidate: JSON.stringify(malformedNumeric)})!;
      expect(buildCandidateProtocolDiagnostic(inspectCandidateProtocol(partial), 'native', 2))
        .toMatchObject({status: 'partially_valid', invalidClaimCount: 1,
          claimDiagnostics: [{field: 'semantics.numeric', subreason: 'shape'}]});
    });
  });

  it.each(['en', 'zh-CN'] as const)('passes a closed framing location to the existing single repair in %s', outputLanguage => {
    const invalid = contract([claim('a')]).replace('```json', '```JSON');
    const candidate = `${body}\n\n${invalid}`;
    const request = repair(candidate)!;
    expect(request.diagnostic.framingDiagnostic).toEqual({field: 'opening_fence', reason: 'not_exact', line: 6});
    expect(request.diagnostic).toMatchObject({claimCount: 1, semanticClaimCount: 1, sourceBindingCount: 0});
    const prompt = buildNativeDeclarationCompletionPrompt({request, intent: intent('investigation'), outputLanguage});
    expect(prompt).toContain(JSON.stringify(request.diagnostic.framingDiagnostic));
    expect(request.rejectedDeclaration).toContain('```JSON');
    expect(request.originalBody).toBe(body);
    const replacement = contract([claim('a')]);
    const payload = recoverNativeDeclarationPayload(replacement);
    const accepted = acceptNativeDeclarationCompletion({request, completion: {status: 'completed'}, candidate: JSON.stringify(payload)});
    expect(accepted).toBeDefined();
    expect(inspectCandidateProtocol(accepted!).canonicalBody.trimEnd()).toBe(body);
    expect(recoverNativeDeclarationPayload(accepted!)).toEqual(payload);
    expect(acceptNativeDeclarationCompletion({request, completion: {status: 'completed'},
      candidate: JSON.stringify(payload).slice(0, -1)})).toBeUndefined();
  });

  it.each(['en', 'zh-CN'] as const)('quotes an unclosed native candidate losslessly and checks the complete output schema in %s', outputLanguage => {
    const candidate = `${body}\n<!-- smartperfetto:conclusion-contract@1\n\`\`\`json\n{"claims":[{"text":"< & >"}`;
    const prompt = buildNativeOutputCompletionPrompt({candidate,
      diagnostic: buildCandidateProtocolDiagnostic(inspectCandidateProtocol(candidate), 'native', 1),
      intent: intent('investigation'), issues: [{type: 'missing_check', severity: 'error', recoveryKind: 'continue_output',
        message: 'Native output_limit'}], outputLanguage});
    const line = prompt.split('\n').find(item => item.startsWith('{"schemaVersion":1,"kind":"original_native_candidate"'))!;
    expect(JSON.parse(line).body).toBe(candidate);
    expect(line).not.toMatch(/[<>&]/);
    expect(prompt).toContain('continue_output');
    expect(prompt).toContain('statement');
    expect(prompt).toContain('claim.kind');
    expect(prompt).toContain('proofBindings');
    expect(prompt).toContain('endpointColumn');
    expect(prompt).toContain('proofColumn');
    expect(prompt).toContain(outputLanguage === 'en' ? 'compactly' : '紧凑序列化');
  });

  it.each(failures)('repairs the $runtime $reconstructedVariant failure class without admitting malformed bytes', sample => {
    const good = contract([claim('a'), claim('b')]);
    let malformed = good;
    let corrected = good;
    switch (sample.reconstructedVariant) {
      case 'json-fence-space': malformed = good.replace('```json', '```json '); break;
      case 'closing-fence-space': malformed = good.replace('\n```\n', '\n``` \n'); break;
      case 'four-backtick-pair': malformed = good.replace('```json', '````json').replace('\n```\n', '\n````\n'); break;
      case 'no-fences': malformed = good.replace('```json\n', '').replace('\n```\n', '\n'); break;
      case 'blank-before-fence': malformed = good.replace('```json', '\n```json'); break;
      case 'closing-comment-space': malformed = good + '   '; break;
      case 'uppercase-json': malformed = good.replace('```json', '```JSON'); break;
      case 'payload-comment-close':
        corrected = contract([claim('a', {text: 'Literal --> data.'}), claim('b')]);
        malformed = corrected.replace(/\\u002d\\u002d\\u003e|--\\u003e/g, '-->');
        // The renderer may escape all HTML-significant characters instead.
        malformed = malformed.replace(/--\\u003E/g, '-->').replace(/\\u003e/g, '>');
        break;
      case 'json-trailing-comma': malformed = good.replace('"schemaVersion":', ',"schemaVersion":'); break;
      case 'invalid-subject':
      case 'invalid-proof-bindings': {
        const proposal = {schemaVersion: 'evidence_relation_candidate@1', id: 'proposal:lock', kind: 'lock_owner',
          direction: 'subject_to_object', subject: {evidenceRefId: 'evidence:subject'},
          object: {evidenceRefId: 'evidence:object'}, proof: {evidenceRefId: 'evidence:proof'}};
        const base = {schemaVersion: 'conclusion_contract_v1', mode: 'focused_answer', conclusions: [],
          clusters: [], evidenceChain: [], claims: [claim('a'), claim('b')], uncertainties: [], nextSteps: []};
        malformed = renderConclusionContractSidecar({...base, relationProposals: [{...proposal,
          ...(sample.reconstructedVariant === 'invalid-subject' ? {subject: {rowIndex: 0}} : {
            proofBindings: {subject: {endpointColumn: 'tid', proofColumn: 'owner_tid'}}})}]} as any);
        corrected = renderConclusionContractSidecar({...base, relationProposals: [{...proposal,
          proofBindings: {subject: {endpointColumn: 'tid', proofColumn: 'owner_tid'},
            object: {endpointColumn: 'tid', proofColumn: 'waiter_tid'}}}]} as any);
        break;
      }
    }
    const rejectedCandidate = `${body}\n\n${malformed}`;
    if (sample.observedIssue === 'invalid_relation_proposal') {
      // A single invalid proposal is item-scoped (plan A.1): the declaration
      // delivers as partially valid with the proposal dropped, and no repair is
      // spent on it (a repair must fix at least one claim, plan A.3).
      const inspected = inspectCandidateProtocol(rejectedCandidate);
      expect(inspected).toMatchObject({status: 'partially_valid',
        sidecar: {bindingEligibility: 'eligible', issues: expect.arrayContaining([{code: 'invalid_relation_proposal',
          path: expect.any(String), relationProposalDiagnostic: {scope: 'item', ordinal: 1,
            reason: sample.reconstructedVariant === 'invalid-subject' ? 'invalid_subject' : 'invalid_proof_bindings'}}])}});
      expect(inspected.sidecar.contract?.relationProposals).toEqual([]);
      expect(inspected.sidecar.contract?.claims?.map(claim => claim.id)).toEqual(['a', 'b']);
      expect(inspected.canonicalBody.trim()).toBe(body);
      expect(repair(rejectedCandidate)).toBeUndefined();
      return;
    }
    expect(inspectCandidateProtocol(rejectedCandidate)).toMatchObject({status: 'invalid',
      sidecar: {bindingEligibility: 'ineligible', issues: expect.arrayContaining([{code: sample.observedIssue, path: expect.any(String)}])}});
    const request = repair(rejectedCandidate)!;
    expect(request).toBeDefined();
    if (sample.observedIssue !== 'invalid_json') {
      expect(request.declaredClaimIds).toEqual(['a', 'b']);
      expect(request.diagnostic.claimCount).toBe(2);
      expect(acceptNativeDeclarationCompletion({request, completion: {status: 'completed'}, candidate: contract([claim('a')])}))
        .toBeUndefined();
    }
    const accepted = acceptNativeDeclarationCompletion({request, completion: {status: 'completed'}, candidate: corrected})!;
    expect(inspectCandidateProtocol(accepted)).toMatchObject({status: 'valid', sidecar: {bindingEligibility: 'eligible'}});
    expect(inspectCandidateProtocol(accepted).canonicalBody.trim()).toBe(body);
    if (sample.observedIssue === 'invalid_framing') {
      const reframed = acceptNativeDeclarationCompletion({request, completion: {status: 'completed'}, candidate: malformed})!;
      expect(inspectCandidateProtocol(reframed)).toMatchObject({status: 'valid', sidecar: {bindingEligibility: 'eligible'}});
      expect(inspectCandidateProtocol(reframed).sidecar.rawPayload).toEqual(recoverNativeDeclarationPayload(malformed));
      expect(inspectCandidateProtocol(reframed).canonicalBody.trim()).toBe(body);
      // Formatting acceptance does not mutate the native diagnostic or parser.
      expect(inspectCandidateProtocol(malformed).sidecar.issues).toContainEqual({code: 'invalid_framing', path: '$'});
    }
    const prompt = buildNativeDeclarationCompletionPrompt({request, intent: intent('investigation'), outputLanguage: 'en'});
    expect(prompt).toContain('one complete JSON object');
    expect(prompt).toContain(sample.observedIssue);
  });

  it('does not mistake the actual unheaded pifix ANR answer for claims-only delivery', () => {
    const actual = `${anrExtended.body}\n\n${contract(anrExtended.claims)}`;
    expect(inspectCandidateProtocol(actual)).toMatchObject({status: 'valid'});
    expect(inspectCandidateProtocol(actual).canonicalBody.trim()).toContain('3 个 ANR 事件');
    expect(repair(actual)).toBeUndefined();
  });

  it('rejects a repaired declaration when the immutable body plus sidecar exceeds the output cap', () => {
    const request = repair(`${body}\n\n${rejected}`)!;
    const corrected = contract([claim('a'), claim('b')]);
    expect(acceptNativeDeclarationCompletion({request, completion: {status: 'completed'}, candidate: corrected,
      outputByteLimit: Buffer.byteLength(corrected, 'utf8')})).toBeUndefined();
  });

  it.each(['label', 'unmatched-fence', 'lone-fence', 'trailing-prose', 'two-objects', 'unclosed-json', 'unclosed-comment',
    'duplicate', 'code-example', 'quotation'] as const)('does not recover ambiguous declaration data: %s', variant => {
    const good = contract([claim('a')]);
    const malformedFrame = good.replace('```json', '```json ');
    const candidates = {
      label: malformedFrame.replace('```json', '```javascript'),
      'unmatched-fence': malformedFrame.replace('```json', '````json'),
      'lone-fence': malformedFrame.replace('\n```\n', '\n'),
      'trailing-prose': malformedFrame.replace('\n```\n', '\nExtra prose\n```\n'),
      'two-objects': malformedFrame.replace('\n```\n', '\n{}\n```\n'),
      'unclosed-json': malformedFrame.replace(/\n}\n```/, '\n```'),
      'unclosed-comment': malformedFrame.slice(0, malformedFrame.lastIndexOf('-->')),
      duplicate: `${good}\n${good}`,
      'code-example': `\`\`\`\`text\n${good}\n\`\`\`\``,
      quotation: good.split('\n').map(line => `> ${line}`).join('\n'),
    };
    expect(recoverNativeDeclarationPayload(candidates[variant])).toBeUndefined();
    expect(acceptNativeDeclarationCompletion({request: repair(`${body}\n${rejected}`)!,
      completion: {status: 'completed'}, candidate: candidates[variant]})).toBeUndefined();
    if (variant !== 'code-example' && variant !== 'quotation') expect(repair(`${body}\n${candidates[variant]}`)).toBeUndefined();
  });

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

  it('reframes complete JSON without changing exact numeric propositions, literal data or the original body', () => {
    const exactClaim = claim('a', {text: 'Captured <value> --> 9007199254740993 ns.',
      semantics: {...semantics, numeric: {operator: 'eq', value: '9007199254740993', unit: 'ns'}}});
    const valid = contract([exactClaim]);
    const malformed = valid.replace('```json', '```JSON ');
    const request = repair(`${body}\n${malformed}`)!;
    expect(request.diagnostic.issueCodes).toEqual(['invalid_framing']);
    const accepted = acceptNativeDeclarationCompletion({request, completion: {status: 'completed'},
      candidate: `Edited completion prose.\n${malformed}`})!;
    const inspected = inspectCandidateProtocol(accepted);
    expect(inspected.status).toBe('valid');
    expect(inspected.canonicalBody.trim()).toBe(body);
    expect(inspected.sidecar.rawPayload).toEqual(inspectCandidateProtocol(valid).sidecar.rawPayload);
    const altered = contract([claim('a', {...exactClaim,
      semantics: {...semantics, numeric: {operator: 'eq', value: '9007199254740992', unit: 'ns'}}})]);
    expect(acceptNativeDeclarationCompletion({request, completion: {status: 'completed'},
      candidate: altered.replace('```json', '```JSON ')})).toBeUndefined();
  });

  it('repairs quarantined reserved framing only while preserving all original claim and proposal fingerprints', () => {
    const exactClaim = claim('a', {semantics: {...semantics, numeric: {operator: 'eq', value: 7, unit: 'ns'}}});
    const proposal = {schemaVersion: 'evidence_relation_candidate@1', id: 'proposal:ratio', kind: 'derived',
      direction: 'subject_to_object', subject: {evidenceRefId: 'data:subject', rowIndex: 0, column: 'running_ns', value: 5},
      object: {evidenceRefId: 'data:object', rowIndex: 0, column: 'wall_ns', value: 10}, metricColumn: 'running_ns', value: 0.5, unit: 'ratio'};
    const payload = {...inspectCandidateProtocol(contract([exactClaim, claim('b')])).sidecar.rawPayload as Record<string, unknown>,
      relationProposals: [proposal]};
    const malformed = `<!-- smartperfetto:conclusion_contract@1\n${JSON.stringify(payload)}\n-->`;
    const original = `${body}\n${malformed}`;
    const inspected = inspectCandidateProtocol(original);
    expect(inspected).toMatchObject({status: 'invalid', canonicalBody: `${body}\n`,
      sidecar: {bindingEligibility: 'ineligible', rawPayload: payload, issues: [{code: 'invalid_framing', path: '$'}]}});
    expect(inspected.sidecar.contract).toBeUndefined();
    expect(recoverNativeDeclarationPayload(original)).toEqual(payload);
    const request = repair(original)!;
    expect(request.declaredClaimIds).toEqual(['a', 'b']);
    expect(request.declaredRelationIds).toEqual(['proposal:ratio']);
    const accepted = acceptNativeDeclarationCompletion({request, completion: {status: 'completed'}, candidate: JSON.stringify(payload)})!;
    expect(inspectCandidateProtocol(accepted)).toMatchObject({status: 'valid', canonicalBody: expect.stringContaining(body),
      sidecar: {rawPayload: payload}});
    for (const changed of [
      {...payload, claims: [claim('b')]},
      {...payload, claims: [claim('a', {semantics: {...semantics, numeric: {operator: 'eq', value: 8, unit: 'ns'}}}), claim('b')]},
      {...payload, relationProposals: []},
      {...payload, relationProposals: [{...proposal, value: 0.6}]},
    ]) expect(acceptNativeDeclarationCompletion({request, completion: {status: 'completed'}, candidate: JSON.stringify(changed)})).toBeUndefined();
    expect(inspectCandidateProtocol(original).status).toBe('invalid');
  });

  it('keeps root validation and both output limits after transport reframing', () => {
    const valid = contract([claim('a'), claim('b')]);
    const malformed = valid.replace('```json\n', '').replace('\n```\n', '\n');
    const request = repair(`${body}\n${malformed}`)!;
    const invalidRoot = malformed.replace('"focused_answer"', '"invalid_mode"');
    expect(acceptNativeDeclarationCompletion({request, completion: {status: 'completed'}, candidate: invalidRoot}))
      .toBeUndefined();
    const completion = JSON.stringify(recoverNativeDeclarationPayload(malformed));
    const shortFrame = `<!-- smartperfetto:conclusion-contract@1\n${completion}\n-->`;
    expect(acceptNativeDeclarationCompletion({request, completion: {status: 'completed'}, candidate: shortFrame,
      outputByteLimit: Buffer.byteLength(shortFrame, 'utf8')})).toBeUndefined();
    const reframed = acceptNativeDeclarationCompletion({request, completion: {status: 'completed'}, candidate: shortFrame})!;
    expect(acceptNativeDeclarationCompletion({request, completion: {status: 'completed'}, candidate: shortFrame,
      outputByteLimit: Buffer.byteLength(reframed, 'utf8') - 1})).toBeUndefined();
  });

  it.each(['en', 'zh-CN'] as const)('locates invalid JSON without copying parser messages into diagnostics in %s', outputLanguage => {
    const payload = '{"private":"🔐秘密 CANARY"}, {"claims":[]}';
    const malformed = `<!-- smartperfetto:conclusion-contract@1\r\n\`\`\`json\r\n${payload}\r\n\`\`\`\r\n-->`;
    const request = repair(`${body}\n${malformed}`)!;
    const log = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      const prompt = buildNativeDeclarationCompletionPrompt({request, intent: intent('investigation'), outputLanguage});
      const diagnosticLine = prompt.split('\n').find(line => line.startsWith('{"payloadChars":'))!;
      expect(JSON.parse(diagnosticLine)).toEqual({payloadChars: payload.length, offsetUtf16: payload.indexOf(',')});
      expect(diagnosticLine).not.toContain('CANARY');
      expect(log.mock.calls.map(call => String(call[0]))).toEqual([
        `[DeclarationRepair] JSON syntax: payloadChars=${payload.length} offsetUtf16=${payload.indexOf(',')}`,
      ]);
      expect(prompt).toContain(outputLanguage === 'en' ? 'outside strings' : '字符串外');
      expect(prompt).toContain(outputLanguage === 'en' ? 'without truncation or omissions' : '不截断、不删减');
      // Diagnostics do not turn malformed bytes into an accepted declaration.
      expect(acceptNativeDeclarationCompletion({request, completion: {status: 'completed'}, candidate: malformed})).toBeUndefined();
    } finally { log.mockRestore(); }
  });

  it('omits a position when the parser reports only an unrecognized token with private text', () => {
    const payload = 'PRIVATE_CANARY at position 1';
    const malformed = `<!-- smartperfetto:conclusion-contract@1\n\`\`\`json\n${payload}\n\`\`\`\n-->`;
    const request = repair(`${body}\n${malformed}`)!;
    const log = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      const prompt = buildNativeDeclarationCompletionPrompt({request, intent: intent('investigation'), outputLanguage: 'en'});
      const diagnosticLine = prompt.split('\n').find(line => line.startsWith('{"payloadChars":'))!;
      expect(JSON.parse(diagnosticLine)).toEqual({payloadChars: payload.length});
      expect(log.mock.calls.map(call => String(call[0])).join('\n')).not.toContain('PRIVATE_CANARY');
    } finally { log.mockRestore(); }
  });

  it('accepts compact JSON with the same claim values and immutable body', () => {
    const request = repair(`${body}\n${rejected}`)!;
    const expanded = contract([claim('a'), claim('b')]);
    const payload = inspectCandidateProtocol(expanded).sidecar.rawPayload;
    const compact = `<!-- smartperfetto:conclusion-contract@1\n\`\`\`json\n${JSON.stringify(payload)}\n\`\`\`\n-->`;
    const accepted = acceptNativeDeclarationCompletion({request, completion: {status: 'completed'}, candidate: compact})!;
    expect(inspectCandidateProtocol(accepted).sidecar.rawPayload).toEqual(payload);
    expect(inspectCandidateProtocol(accepted).canonicalBody.trim()).toBe(body);
  });

  it.each(['missing', 'partial'] as const)('admits a complete bare JSON %s declaration through the unchanged sidecar parser', kind => {
    const valid = claim('a', {text: 'Literal <data> --> 9007199254740993 ns.',
      semantics: {...semantics, numeric: {operator: 'eq', value: '9007199254740993', unit: 'ns'}}});
    const original = kind === 'missing' ? body : `${body}\n${contract([valid,
      claim('b', {semantics: {...semantics, scope: {population: 'everywhere'}}})])}`;
    const request = repair(original)!;
    const corrected = contract([valid, claim('b')]);
    const payload = inspectCandidateProtocol(corrected).sidecar.rawPayload;
    const bareJson = JSON.stringify(payload);
    const accepted = acceptNativeDeclarationCompletion({request, completion: {status: 'completed'},
      candidate: ` \n${bareJson}\n `})!;
    const inspected = inspectCandidateProtocol(accepted);
    expect(inspected.status).toBe('valid');
    expect(inspected.canonicalBody.trim()).toBe(body);
    expect(inspected.sidecar.rawPayload).toEqual(payload);
    expect(accepted).not.toContain('Literal <data> -->');
    // Bare JSON transport is scoped to this completion, never ordinary native admission.
    expect(inspectCandidateProtocol(bareJson).sidecar.status).toBe('absent');
  });

  it.each(['truncated', 'trailing-prose', 'two-objects', 'array', 'fenced', 'root-invalid', 'changed-value', 'dropped-claim',
    'duplicate-claim'] as const)('rejects unsafe bare JSON declaration transport: %s', variant => {
    const preserved = claim('a', {semantics: {...semantics, numeric: {operator: 'eq', value: 2, unit: 'ns'}}});
    const request = repair(`${body}\n${contract([preserved,
      claim('b', {semantics: {...semantics, scope: {population: 'everywhere'}}})])}`)!;
    const valid = JSON.stringify(inspectCandidateProtocol(contract([preserved, claim('b')])).sidecar.rawPayload);
    const candidates = {
      truncated: valid.slice(0, -1), 'trailing-prose': `${valid}\nDone.`, 'two-objects': `${valid}\n{}`,
      array: `[${valid}]`, fenced: `\`\`\`json\n${valid}\n\`\`\``,
      'root-invalid': valid.replace('"focused_answer"', '"broken"'),
      'changed-value': JSON.stringify(inspectCandidateProtocol(contract([claim('a',
        {semantics: {...semantics, numeric: {operator: 'eq', value: 3, unit: 'ns'}}}), claim('b')])).sidecar.rawPayload),
      'dropped-claim': JSON.stringify(inspectCandidateProtocol(contract([claim('b')])).sidecar.rawPayload),
      'duplicate-claim': JSON.stringify(inspectCandidateProtocol(contract([preserved, claim('b'), preserved])).sidecar.rawPayload),
    };
    expect(acceptNativeDeclarationCompletion({request, completion: {status: 'completed'}, candidate: candidates[variant]}))
      .toBeUndefined();
  });

  it('checks bare JSON transport, server framing and joined body against the same output cap', () => {
    const request = repair(`${body}\n${rejected}`)!;
    const bareJson = JSON.stringify(inspectCandidateProtocol(contract([claim('a'), claim('b')])).sidecar.rawPayload);
    const accepted = acceptNativeDeclarationCompletion({request, completion: {status: 'completed'}, candidate: bareJson})!;
    for (const cap of [Buffer.byteLength(bareJson) - 1, Buffer.byteLength(bareJson), Buffer.byteLength(accepted) - 1]) {
      expect(acceptNativeDeclarationCompletion({request, completion: {status: 'completed'}, candidate: bareJson,
        outputByteLimit: cap})).toBeUndefined();
    }
  });

  it.each(['en', 'zh-CN'] as const)('requests bare JSON transport rather than a model-owned frame in %s', outputLanguage => {
    const prompt = buildNativeDeclarationCompletionPrompt({request: repair(`${body}\n${rejected}`)!,
      intent: intent('investigation'), outputLanguage});
    expect(prompt).toContain(outputLanguage === 'en' ? 'one complete JSON object' : '一个完整 JSON 对象');
    expect(prompt).toContain(outputLanguage === 'en' ? 'server supplies the final HTML sidecar frame' : '外壳由服务端生成');
    expect(prompt).toContain(outputLanguage === 'en' ? 'without HTML comments, Markdown fences' : '不带 HTML 注释、Markdown fence');
  });

  it('delivers the original body with a repaired declaration that keeps every declared claim', () => {
    const request = repair(`${body}\n\n${rejected}`)!;
    const accept = (candidate: string) => acceptNativeDeclarationCompletion({request, completion: {status: 'completed'}, candidate});
    const repaired = contract([claim('a'), claim('b')]);
    // The completion supplies only the declaration; the product attaches it to the body.
    expect(accept(repaired)).toBe(`${body}\n\n${repaired}`);
    expect(accept(`${body}\n\n${repaired}`)).toBe(`${body}\n\n${repaired}`);
    expect(accept(contract([claim('a')]))).toBeUndefined();
    expect(accept(rejected)).toBeUndefined();
  });

  it('never delivers prose a completion adds around its declaration', () => {
    const request = repair(`${body}\n\n${rejected}`)!;
    const repaired = contract([claim('a'), claim('b')]);
    const log = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      expect(acceptNativeDeclarationCompletion({request, completion: {status: 'completed'},
        candidate: `${body} Edited CANARY_EDIT.\n\n${repaired}`})).toBe(`${body}\n\n${repaired}`);
      const lines = log.mock.calls.map(call => String(call[0]));
      expect(lines).toEqual([`[DeclarationRepair] completion prose discarded: request=invalid_declaration ` +
        `proseChars=${body.length + ' Edited CANARY_EDIT.'.length} originalChars=${body.length}`]);
    } finally {
      log.mockRestore();
    }
  });

  it('logs why a completion was rejected in closed vocabulary, never the model text', () => {
    // rooted_lock_monitor: a valid 14-claim completion was dropped with no record of the reason.
    const original = '决定性证据:SF 主线程阻塞 33ms,等待 HWC。';
    const request = requestNativeDeclarationCompletion({intent: intent('investigation'), completion: {status: 'completed'},
      candidate: original, remainingDeliveryTurns: 1})!;
    const log = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      const invalid = contract([claim('a')]).replace('"schemaVersion"', '"schemaVersion" HWC_CANARY_OOPS');
      expect(acceptNativeDeclarationCompletion({request, completion: {status: 'completed'},
        candidate: `${original}\n\n${invalid}`})).toBeUndefined();
      expect(acceptNativeDeclarationCompletion({request, completion: {status: 'unknown'},
        candidate: `${original}\n\n${contract([claim('a')])}`})).toBeUndefined();
      expect(acceptNativeDeclarationCompletion({request, completion: {status: 'incomplete', reason: 'output_limit'},
        candidate: contract([claim('a')])})).toBeUndefined();
      const lines = log.mock.calls.map(call => String(call[0]));
      expect(lines).toEqual([
        '[DeclarationRepair] completion rejected: request=missing_declaration reason=declaration_not_valid ' +
          'repaired=invalid sidecar=invalid issues=invalid_json claimDiagnostics=none',
        '[DeclarationRepair] completion rejected: request=missing_declaration reason=completion_not_completed completion=unknown',
        '[DeclarationRepair] completion rejected: request=missing_declaration reason=completion_not_completed ' +
          'completion=incomplete nativeReason=output_limit',
      ]);
      expect(lines.join('\n')).not.toContain('HWC');
    } finally {
      log.mockRestore();
    }
  });

  it('logs a requested repair by claim position and schema field only', () => {
    const log = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      repair(`${body}\n\n${rejected}`);
      expect(log.mock.calls.map(call => String(call[0]))).toEqual([
        '[DeclarationRepair] requested: reason=invalid_declaration issues=invalid_semantics claims=2 ' +
          'claimDiagnostics=2:invalid_semantics:semantics.scope.population',
      ]);
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

  it('treats a blank id as an unrepairable invalid entry and still delivers the valid claim', () => {
    const candidate = `${body}\n\n${contract([claim('a'), claim('', {semantics})])}`;
    // A no-id invalid claim is not a repair target (plan A.3): nothing repairable remains.
    expect(repair(candidate)).toBeUndefined();
    const inspected = inspectCandidateProtocol(candidate);
    expect(inspected.status).toBe('partially_valid');
    expect(inspected.sidecar.contract?.claims?.map(claim => [claim.id, claim.valid]))
      .toEqual([['a', undefined], ['', false]]);
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
      conclusions: [], clusters: [], evidenceChain: [], claims: [claim('b', {semantics: {...semantics,
        scope: {population: 'everywhere'}}})], uncertainties: [], nextSteps: [],
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

  it('attaches a valid declaration to the original body, including need_input', () => {
    for (const mode of ['focused_answer', 'need_input'] as const) {
      const originalBody = mode === 'need_input' ? 'Which trace should I inspect?' : 'Measured value: 42 ms.';
      const request = requestNativeDeclarationCompletion({
        intent: intent('investigation'), completion: {status: 'completed'}, candidate: originalBody, remainingDeliveryTurns: 1,
      })!;
      const expected = `${originalBody}\n\n${declaration(mode)}`;
      expect(acceptNativeDeclarationCompletion({request, completion: {status: 'completed'},
        candidate: declaration(mode)})).toBe(expected);
      // An unchanged echo is already the candidate.
      expect(acceptNativeDeclarationCompletion({request, completion: {status: 'completed'},
        candidate: `${originalBody}\n${declaration(mode)}`})).toBe(`${originalBody}\n${declaration(mode)}`);
      expect(inspectCandidateProtocol(expected)).toMatchObject({status: 'valid', canonicalBody: `${originalBody}\n\n`});
    }
  });

  it.each([
    ['middle edit', 'Measured value: 43 ms.\n'],
    ['line-ending edit', 'first\nsecond\n'],
    ['truncated body', 'Measured value:\n'],
  ])('keeps the original body over a %s', (_name, repairedBody) => {
    const originalBody = _name === 'line-ending edit' ? 'first\r\nsecond\r\n' : 'Measured value: 42 ms.';
    const request = requestNativeDeclarationCompletion({
      intent: intent('investigation'), completion: {status: 'completed'}, candidate: originalBody, remainingDeliveryTurns: 1,
    })!;
    const log = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      expect(acceptNativeDeclarationCompletion({request, completion: {status: 'completed'},
        candidate: `${repairedBody}${declaration()}`})).toBe(`${originalBody.trim()}\n\n${declaration()}`);
    } finally {
      log.mockRestore();
    }
  });

  it.each([
    ['unclosed ordinary comment', '<!-- smartperfetto:conclusion-ledger {"claims": []}'],
    ['unclosed Markdown fence', '```json\n{"claims": []}'],
  ])('keeps an accepted repair outside an %s in the original body', (_name, tail) => {
    // Minimal reproduction of b20-cpu_runnable_starvation's captured boundary:
    // a non-protocol comment in the original body swallowed the appended repair.
    const originalBody = `Measured value: 42 ms.\n\n${tail}`;
    expect(inspectCandidateProtocol(originalBody).status).toBe('absent');
    const request = requestNativeDeclarationCompletion({intent: intent('investigation'),
      completion: {status: 'completed'}, candidate: originalBody, remainingDeliveryTurns: 1})!;
    expect(inspectCandidateProtocol(`${originalBody}\n\n${declaration()}`).status).toBe('absent');
    const accepted = acceptNativeDeclarationCompletion({request, completion: {status: 'completed'},
      candidate: declaration()})!;
    expect(inspectCandidateProtocol(accepted).status).toBe('valid');
    expect(inspectCandidateProtocol(accepted).canonicalBody.trim()).toBe(originalBody);
    expect(inspectCandidateProtocol(accepted).sidecar.rawPayload)
      .toEqual(inspectCandidateProtocol(declaration()).sidecar.rawPayload);
    expect(acceptNativeDeclarationCompletion({request, completion: {status: 'completed'},
      candidate: declaration(), outputByteLimit: Buffer.byteLength(accepted) - 1})).toBeUndefined();
  });

  it('rejects a completion without a declaration', () => {
    const request = requestNativeDeclarationCompletion({
      intent: intent('investigation'), completion: {status: 'completed'}, candidate: 'Measured value: 42 ms.', remainingDeliveryTurns: 1,
    })!;
    expect(acceptNativeDeclarationCompletion({request, completion: {status: 'completed'},
      candidate: 'Measured value: 42 ms.'})).toBeUndefined();
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

  // Plan 2 A.3: the per-item acceptance matrix for repairing a partially valid
  // declaration. `rejected` carries one invalid claim (b, id-bearing) and one
  // valid claim (a), so a repair is requested and must satisfy every condition.
  describe('partial repair acceptance matrix', () => {
    const repairRequest = () => repair(`${body}\n\n${rejected}`)!;
    const accept = (request: ReturnType<typeof repairRequest>, candidate: string) => {
      const log = jest.spyOn(console, 'log').mockImplementation(() => undefined);
      try {
        return acceptNativeDeclarationCompletion({request, completion: {status: 'completed'}, candidate});
      } finally {
        log.mockRestore();
      }
    };
    const rejectionReason = (candidate: string, original: string = `${body}\n\n${rejected}`): string | undefined => {
      const request = repair(original)!;
      const log = jest.spyOn(console, 'log').mockImplementation(() => undefined);
      try {
        acceptNativeDeclarationCompletion({request, completion: {status: 'completed'}, candidate});
        const line = log.mock.calls.map(call => String(call[0])).find(item => item.includes('completion rejected'));
        return line?.match(/reason=(\S+)/)?.[1];
      } finally {
        log.mockRestore();
      }
    };

    it('requests the repair listing only id-bearing invalid claims', () => {
      const request = repair(`${body}\n\n${contract([claim('a'), claim('b', {semantics: {...semantics, scope: {population: 'everywhere'}}}),
        claim('c', {id: '', semantics: {...semantics, scope: {population: 'nowhere'}}})])}`)!;
      expect(request.diagnostic.claimDiagnostics?.map(detail => detail.ordinal)).toEqual([2]);
      expect(request.originalRootInvalid).toBe(false);
    });

    it('accepts a repair that fixes the invalid claim and keeps the valid one byte-for-byte', () => {
      const request = repairRequest();
      const fixed = contract([claim('a'), claim('b')]);
      const accepted = accept(request, fixed);
      expect(accepted).toBe(`${body}\n\n${fixed}`);
      expect(inspectCandidateProtocol(accepted!).status).toBe('valid');
    });

    it('accepts a repair that fixes one claim while another stays invalid', () => {
      const twoInvalid = contract([claim('a'), claim('b', {semantics: {...semantics, scope: {population: 'elsewhere'}}}),
        claim('c', {semantics: {...semantics, scope: {population: 'nowhere'}}})]);
      const request = repair(`${body}\n\n${twoInvalid}`)!;
      const partiallyFixed = contract([claim('a'), claim('b'), claim('c', {semantics: {...semantics,
        scope: {population: 'nowhere'}}})]);
      const accepted = accept(request, partiallyFixed);
      expect(accepted).toBe(`${body}\n\n${partiallyFixed}`);
      // The merged candidate is itself partially valid: claim c stays unverified, never hidden.
      const inspected = inspectCandidateProtocol(accepted!);
      expect(inspected.status).toBe('partially_valid');
      expect(inspected.sidecar.contract?.claims?.map(claim => [claim.id, claim.valid]))
        .toEqual([['a', undefined], ['b', undefined], ['c', false]]);
    });

    it('rejects a repair that fixes no invalid claim', () => {
      const stillBroken = renderConclusionContractSidecar({schemaVersion: 'conclusion_contract_v1',
        mode: 'focused_answer', conclusions: [], clusters: [], evidenceChain: [],
        claims: [claim('a'), claim('b', {semantics: {...semantics, scope: {population: 'elsewhere'}}})],
        uncertainties: [], nextSteps: []} as any);
      // Still one invalid claim — no fewer than the original — so the matrix
      // rejects it: a repair must fix at least one claim (plan A.3 condition 4).
      expect(rejectionReason(stillBroken)).toBe('invalid_claims_not_reduced');
    });

    it('rejects a repair that drops a valid claim', () => {
      expect(rejectionReason(contract([claim('b')]))).toBe('claim_ids_changed');
      expect(rejectionReason(contract([claim('b')]).replace('```json', '```JSON '))).toBe('claim_ids_changed');
    });

    it('rejects a repair that adds a new claim id', () => {
      expect(rejectionReason(contract([claim('a'), claim('b'), claim('c')]))).toBe('claim_ids_changed');
    });

    it('rejects a repair that changes a valid claim\'s semantics', () => {
      expect(rejectionReason(contract([claim('a', {text: 'a holds. Edited.'}), claim('b')])))
        .toBe('valid_claim_changed');
      expect(rejectionReason(contract([claim('a', {kind: 'categorical'}), claim('b')])))
        .toBe('valid_claim_changed');
    });

    it('rejects a repair with duplicate normalized claim content', () => {
      expect(rejectionReason(contract([claim('a'), claim('b', {id: 'a', text: 'a holds.'})])))
        .toBe('declaration_not_valid');
      expect(rejectionReason(contract([claim('a'), claim('b', {text: 'a holds.'})])))
        .toBe('duplicate_claim_content');
    });

    it('prevents declaration repair from changing a valid numeric display binding', () => {
      const presentation = {schemaVersion: 'numeric_presentation@1', unit: 'ms', decimalPlaces: 1,
        rounding: 'half_away_from_zero', quotes: [{text: '32.6 ms'}]};
      const numeric = {operator: 'eq', value: 32.576, unit: 'ms', presentation};
      const valid = claim('a', {semantics: {...semantics, numeric}});
      const request = repair(`${body}\n\n${contract([valid,
        claim('b', {semantics: {...semantics, scope: {population: 'elsewhere'}}})])}`)!;
      expect(accept(request, contract([valid, claim('b')]))).toBeDefined();
      const changed = claim('a', {semantics: {...semantics, numeric: {...numeric,
        presentation: {...presentation, quotes: [{text: '32.7 ms'}]}}}});
      expect(accept(request, contract([changed, claim('b')]))).toBeUndefined();
    });

    it('rejects a repair whose own root is invalid', () => {
      expect(rejectionReason(rejected)).toBe('invalid_claims_not_reduced');
      const brokenRoot = contract([claim('a'), claim('b')]).replace('"mode": "focused_answer"', '"mode": "broken"');
      // A root-invalid sidecar never reaches the matrix: the outer gate rejects it.
      expect(rejectionReason(brokenRoot)).toBe('declaration_not_valid');
    });

    it('matches relation proposals by raw position with preserved identity', () => {
      const proposal = {schemaVersion: 'evidence_relation_candidate@1', id: 'proposal:lock', kind: 'lock_owner',
        direction: 'subject_to_object', subject: {evidenceRefId: 'evidence:subject'},
        object: {evidenceRefId: 'evidence:object'}, proof: {evidenceRefId: 'evidence:proof'}};
      const base = (relations: unknown[], claims: unknown[]) => renderConclusionContractSidecar({
        schemaVersion: 'conclusion_contract_v1', mode: 'focused_answer', conclusions: [], clusters: [],
        evidenceChain: [], claims, uncertainties: [], nextSteps: [], relationProposals: relations} as any);
      const original = `${body}\n\n${base([proposal],
        [claim('a'), claim('b', {semantics: {...semantics, scope: {population: 'everywhere'}}})])}`;
      const request = repair(original)!;
      // Fixing the claim while keeping the valid proposal in place is accepted.
      const fixed = base([proposal], [claim('a'), claim('b')]);
      expect(accept(request, fixed)).toBe(`${body}\n\n${fixed}`);
      const bare = JSON.stringify(inspectCandidateProtocol(fixed).sidecar.rawPayload);
      expect(inspectCandidateProtocol(accept(request, bare)!).sidecar.rawPayload)
        .toEqual(inspectCandidateProtocol(fixed).sidecar.rawPayload);
      const framed = accept(request, fixed.replace('```json', '```JSON '))!;
      expect(inspectCandidateProtocol(framed).sidecar.rawPayload).toEqual(inspectCandidateProtocol(fixed).sidecar.rawPayload);
      // Changing the originally-valid proposal's semantics is rejected.
      expect(rejectionReason(base([{...proposal, kind: 'wakeup'}], [claim('a'), claim('b')]), original))
        .toBe('valid_proposal_changed');
      expect(rejectionReason(JSON.stringify(inspectCandidateProtocol(base([{...proposal, kind: 'wakeup'}],
        [claim('a'), claim('b')])).sidecar.rawPayload), original)).toBe('valid_proposal_changed');
      expect(rejectionReason(base([{...proposal, kind: 'wakeup'}], [claim('a'), claim('b')])
        .replace('```json', '```JSON '), original)).toBe('valid_proposal_changed');
      // Dropping the proposal (fewer positions) is rejected.
      expect(rejectionReason(base([], [claim('a'), claim('b')]), original)).toBe('relation_positions_changed');
      expect(rejectionReason(JSON.stringify(inspectCandidateProtocol(base([], [claim('a'), claim('b')]))
        .sidecar.rawPayload), original)).toBe('relation_positions_changed');
      expect(rejectionReason(base([], [claim('a'), claim('b')]).replace('```json', '```JSON '), original))
        .toBe('relation_positions_changed');
    });

    it('lets an invalid proposal be fixed only under its preserved id or resolvable identity', () => {
      const withId = {id: 'proposal:lock', kind: 'lock_owner', direction: 'subject_to_object',
        subject: {evidenceRefId: 'evidence:subject'}, object: {evidenceRefId: 'evidence:object'}};
      const base = (relations: unknown[], claims: unknown[]) => renderConclusionContractSidecar({
        schemaVersion: 'conclusion_contract_v1', mode: 'focused_answer', conclusions: [], clusters: [],
        evidenceChain: [], claims, uncertainties: [], nextSteps: [], relationProposals: relations} as any);
      const brokenClaims = [claim('a'), claim('b', {semantics: {...semantics, scope: {population: 'everywhere'}}})];
      const original = `${body}\n\n${base([{...withId, id: 'not-a-proposal-id'}], brokenClaims)}`;
      const request = repair(original)!;
      // The unresolvable id may be fixed: identity is the resolvable semantic subset.
      const fixedId = base([{...withId}], [claim('a'), claim('b')]);
      expect(accept(request, fixedId)).toBe(`${body}\n\n${fixedId}`);
      expect(accept(request, base([{...withId, id: 'proposal:other'}], [claim('a'), claim('b')])))
        .toBe(`${body}\n\n${base([{...withId, id: 'proposal:other'}], [claim('a'), claim('b')])}`);
      // A usable id on the invalid entry must survive the repair unchanged.
      const idOriginal = `${body}\n\n${base([{...withId, direction: 'sideways'}], brokenClaims)}`;
      expect(rejectionReason(base([{...withId, id: 'proposal:other', direction: 'subject_to_object'}],
        [claim('a'), claim('b')]), idOriginal)).toBe('proposal_id_changed');
      // A resolvable semantic field the repair changed is rejected.
      expect(rejectionReason(base([{...withId, id: 'proposal:lock', kind: 'wakeup'}], [claim('a'), claim('b')]), original))
        .toBe('proposal_identity_changed');
      // An entry with no resolvable kind/subject is not a repair target: fixing
      // the claim is still accepted, but "repairing" that entry is rejected.
      const unrepairableOriginal = `${body}\n\n${base([{PRIVATE_KEY: 1}], brokenClaims)}`;
      expect(repair(unrepairableOriginal)).toBeDefined();
      expect(accept(repair(unrepairableOriginal)!, base([{...withId}], [claim('a'), claim('b')])))
        .toBeUndefined();
      expect(rejectionReason(base([{...withId}], [claim('a'), claim('b')]), unrepairableOriginal))
        .toBe('unrepairable_proposal_changed');
      const proposalOnlyUnrepairable = `${body}\n\n${base([{PRIVATE_KEY: 1}], [claim('a'), claim('b')])}`;
      expect(repair(proposalOnlyUnrepairable)).toBeUndefined();
    });
  });
});
