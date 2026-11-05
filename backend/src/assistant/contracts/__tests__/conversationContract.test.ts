// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {
  buildConversationPrompt,
  parseConversationResponse,
  parseConversationResponseWithProjection,
} from '../conversationContract';
import {renderConclusionContractSidecar, wrapConclusionAuthoringPayload} from '../../../agent/core/conclusionContract';

describe('conversation contract', () => {
  it.each([
    '```xml\n<tool_call><invoke name="example" /></tool_call>\n```',
    '> <invoke name="example">quoted text</invoke>',
    'The DSML tools_calling token and <invoke> tag are protocol examples.',
    '<tool_call><invoke name="example">plain text</invoke></tool_call>',
  ])('keeps answer text distinct from SDK tool events: %s', body => {
    const parsed = parseConversationResponseWithProjection(body, 'Explain the protocol');
    expect(parsed.status).toBe('absent');
    expect(parsed.machineSegments).toEqual([]);
    expect(parsed.narrative).toBe(body);
  });

  it('builds distinct attached and no-trace instructions without a short fixed budget', () => {
    const noTrace = buildConversationPrompt({
      question: '怎么定位滑动卡顿？',
      history: [],
      traceContext: {kind: 'none'},
    });
    const attached = buildConversationPrompt({
      question: '这个线程为什么阻塞？',
      history: [{role: 'user', content: '先看主线程'}],
      traceContext: {kind: 'attached', traceId: 'trace-1'},
    });

    expect(noTrace).toContain('当前没有附加 Trace');
    expect(noTrace).toContain('不要调用 Trace 工具');
    expect(attached).toContain('当前已附加 Trace（ID: trace-1）');
    expect(attached).toContain('先看主线程');
    expect(attached).toContain('historical_context');
    expect(attached).not.toMatch(/15\s*秒|两轮工具|2\s*次工具/);
  });

  it('bounds old history without truncating the current user question', () => {
    const question = 'CURRENT_QUERY_'.repeat(2_000);
    const history = Array.from({length: 60}, (_, index) => [
      {role: 'user' as const, content: `question-${index}`},
      {role: 'assistant' as const, content: `answer-${index}:` + 'x'.repeat(20_000)},
    ]).flat();
    const prompt = buildConversationPrompt({question, history, traceContext: {kind: 'none'}});
    expect(prompt).toContain(question);
    expect(prompt).toContain('question-59');
    expect(Buffer.byteLength(prompt.replace(question, ''))).toBeLessThan(18_000);
    expect(prompt).not.toContain('x'.repeat(5_000));
  });

  it('strips the control marker and returns a logical clarification pause', () => {
    expect(parseConversationResponse(
      '我可以先确认目标。\n<!-- smartperfetto:conversation-control {"kind":"needs_user_input","question":"你更关心首帧还是可交互时间？"} -->',
      '原问题',
    )).toEqual({
      kind: 'needs_user_input',
      message: '我可以先确认目标。',
      question: '你更关心首帧还是可交互时间？',
      evidence: [],
    });
  });

  it('keeps a structured full-analysis handoff without upgrading', () => {
    const outcome = parseConversationResponse(
      '这个问题需要完整诊断。\n<!-- smartperfetto:conversation-control {"kind":"recommend_full","handoff":{"question":"为什么卡顿","scope":"完整滑动场景","assumptions":["关注当前应用"],"evidence":[]}} -->',
      'fallback',
      [{id: 'ev-1', label: '帧统计'}],
    );

    expect(outcome).toMatchObject({
      kind: 'recommend_full',
      message: '这个问题需要完整诊断。',
      handoff: {
        question: '为什么卡顿',
        scope: '完整滑动场景',
        assumptions: ['关注当前应用'],
        evidence: [{id: 'ev-1', label: '帧统计'}],
      },
    });
  });

  it('only accepts handoff evidence backed by the current runtime evidence', () => {
    const authoritativeEvidence = [{
      id: 'ev-1',
      label: '真实帧统计',
      source: 'runtime-finding',
    }];
    const outcome = parseConversationResponse(
      '建议进入完整分析。\n<!-- smartperfetto:conversation-control {"kind":"recommend_full","handoff":{"question":"为什么卡顿","scope":"完整滑动场景","assumptions":[],"evidence":[{"id":"ev-1","label":"模型改写的标签","source":"model-claim"},{"id":"fake-1","label":"模型编造的证据"}]}} -->',
      'fallback',
      authoritativeEvidence,
    );

    expect(outcome).toMatchObject({
      kind: 'recommend_full',
      handoff: {evidence: authoritativeEvidence},
    });
  });

  it('falls back to runtime evidence when the handoff only requests unknown ids', () => {
    const authoritativeEvidence = [{id: 'ev-1', label: '真实帧统计'}];
    const outcome = parseConversationResponse(
      '建议进入完整分析。\n<!-- smartperfetto:conversation-control {"kind":"recommend_full","handoff":{"question":"为什么卡顿","scope":"完整滑动场景","assumptions":[],"evidence":[{"id":"fake-1","label":"模型编造的证据"}]}} -->',
      'fallback',
      authoritativeEvidence,
    );

    expect(outcome).toMatchObject({
      kind: 'recommend_full',
      handoff: {evidence: authoritativeEvidence},
    });
  });

  it('returns exact narrative and source spans independently of question display fallback', () => {
    const marker = '<!-- smartperfetto:conversation-control {"kind":"needs_user_input","question":"Choose a trace?"} -->';
    const raw = ` \r\nAn answer.  \r\n${marker}\r\n \t`;
    const parsed = parseConversationResponseWithProjection(raw, 'Fallback');
    expect(parsed.status).toBe('valid');
    expect(parsed.narrative).toBe(' \r\nAn answer.  \r\n\r\n \t');
    expect(parsed.machineSegments).toEqual([{start: raw.indexOf(marker), end: raw.indexOf(marker) + marker.length}]);
    const onlyControl = parseConversationResponseWithProjection(marker, 'Fallback');
    expect(onlyControl.narrative).toBe('');
    expect(onlyControl.outcome).toMatchObject({kind: 'needs_user_input', question: 'Choose a trace?', message: 'Choose a trace?'});
  });

  it.each([
    '```html\nMARKER\n```',
    '~~~\nMARKER\n~~~',
    '> MARKER',
    '    MARKER',
    '`MARKER`',
    'MARKER\nOrdinary narrative follows.',
  ])('keeps code, quoted and nonterminal controls as exact ordinary content: %s', frame => {
    const raw = frame.replace('MARKER', '<!-- smartperfetto:conversation-control {"kind":"needs_user_input","question":"Question?"} -->');
    expect(parseConversationResponseWithProjection(raw, 'Fallback')).toMatchObject({
      status: 'absent', narrative: raw, machineSegments: [], outcome: {kind: 'answered'},
    });
  });

  it('allows only recognized sidecar segments after a terminal control', () => {
    const sidecar = renderConclusionContractSidecar({schemaVersion: 'conclusion_contract_v1', mode: 'focused_answer',
      conclusions: [], clusters: [], evidenceChain: [], uncertainties: [], nextSteps: [], claims: []});
    const control = '<!-- smartperfetto:conversation-control {"kind":"needs_user_input","question":"Question?"} -->';
    for (const raw of [`Answer\n${control}\n${sidecar}\n`, `Answer\n${sidecar}\n${control}\n`]) {
      const parsed = parseConversationResponseWithProjection(raw, 'Fallback');
      expect(parsed.status).toBe('valid');
      expect(parsed.machineSegments).toEqual([{start: raw.indexOf(control), end: raw.indexOf(control) + control.length}]);
      expect(parsed.narrative).toBe(raw.replace(control, ''));
    }
    expect(parseConversationResponseWithProjection(`${control}\n<!-- ordinary comment -->`, 'Fallback').status).toBe('absent');
  });

  it('does not activate controls nested inside another machine declaration', () => {
    const control = '<!-- smartperfetto:conversation-control {"kind":"needs_user_input","question":"Nested?"} -->';
    const sidecar = renderConclusionContractSidecar({schemaVersion: 'conclusion_contract_v1', mode: 'focused_answer',
      conclusions: [{rank: 1, statement: control}], clusters: [], evidenceChain: [], uncertainties: [], nextSteps: []});
    expect(parseConversationResponseWithProjection(sidecar, 'Fallback')).toMatchObject({status: 'absent', narrative: sidecar});
    const authoring = wrapConclusionAuthoringPayload(control); // Invalid JSON still has explicit machine bounds.
    expect(parseConversationResponseWithProjection(authoring, 'Fallback')).toMatchObject({status: 'absent', narrative: authoring});
  });

  it('admits an external terminal control around the new authoring machine segment', () => {
    const declaration = wrapConclusionAuthoringPayload(JSON.stringify({authoringVersion: 'conclusion_authoring@1',
      referenceDictionary: [], contract: {schemaVersion: 'conclusion_contract_v1', mode: 'need_input',
        conclusions: [], clusters: [], evidenceChain: [], claims: [], uncertainties: [], nextSteps: []}}));
    const control = '<!-- smartperfetto:conversation-control {"kind":"needs_user_input","question":"Which trace?"} -->';
    for (const raw of [`Body\n${control}\n${declaration}`, `Body\n${declaration}\n${control}`]) {
      const parsed = parseConversationResponseWithProjection(raw, 'Fallback');
      expect(parsed.status).toBe('valid');
      expect(parsed.machineSegments).toEqual([{start: raw.indexOf(control), end: raw.indexOf(control) + control.length}]);
    }
  });

  it('rejects multiple controls in the terminal machine cluster without choosing a winner', () => {
    const first = '<!-- smartperfetto:conversation-control {"kind":"answered"} -->';
    const second = '<!-- smartperfetto:conversation-control {"kind":"needs_user_input","question":"Winner?"} -->';
    const sidecar = renderConclusionContractSidecar({schemaVersion: 'conclusion_contract_v1', mode: 'focused_answer',
      conclusions: [], clusters: [], evidenceChain: [], uncertainties: [], nextSteps: []});
    for (const separator of ['\n', `\n${sidecar}\n`]) {
      const raw = `Body\n${first}${separator}${second}`;
      const parsed = parseConversationResponseWithProjection(raw, 'Fallback');
      expect(parsed.status).toBe('invalid');
      expect(parsed.issues).toEqual([{code: 'duplicate_marker'}]);
      expect(parsed.outcome.kind).toBe('answered');
      expect(parsed.machineSegments).toHaveLength(2);
      expect(parsed.narrative).toBe(`Body\n${separator}`);
    }
  });

  it.each([
    ['<!-- smartperfetto:conversation-control {bad} -->', 'invalid_json'],
    ['<!-- smartperfetto:conversation-control {"kind":"needs_user_input"} -->', 'invalid_control'],
    ['<!-- smartperfetto:conversation-control {"kind":"needs_user_input"}', 'invalid_framing'],
  ])('reports malformed terminal controls without substituting a fallback body', (marker, code) => {
    const parsed = parseConversationResponseWithProjection(`Exact body\n${marker}`, 'Never the body');
    expect(parsed.status).toBe('invalid');
    expect(parsed.narrative).toBe('Exact body\n');
    expect(parsed.issues).toEqual([{code}]);
  });
});
