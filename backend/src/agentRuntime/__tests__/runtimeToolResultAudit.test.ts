// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {describe, expect, it, jest} from '@jest/globals';

import {DEFAULT_EXTERNAL_TOOL_RESULT_MAX_CHARS, summarizeExternalToolResult} from '../runtimeLimits';
import {createRuntimeToolResult} from '../runtimeToolResult';
import {
  RuntimeToolResultAuditRecorder,
  describeRuntimeToolFailure,
  describeRuntimeToolResultHandoff,
  projectToolResultAuditForPrivateRun,
} from '../runtimeToolResultAudit';

const SECRET_ROW_VALUE = 'SECRET_ROW_VALUE_4242';

/** Shaped like invoke_skill: a large body, then the hint, then notes/nudge decoration. */
function invokeSkillResult(overrides: {planPhaseId?: string; vendor?: string} = {}) {
  return createRuntimeToolResult({
    success: true,
    skillId: 'startup_analysis',
    displayResults: [{
      stepId: 'launch_slices',
      data: {rows: Array.from({length: 200}, (_, index) => [index, `${SECRET_ROW_VALUE}-${index}`])},
    }],
    partial: undefined,
    vendorOverride: {
      vendor: overrides.vendor ?? 'xiaomi',
      displayName: 'Xiaomi HyperOS',
      additionalStepIds: ['miui_boost', 'miui_freeze'],
    },
  }, {
    facts: {success: true, planPhaseId: overrides.planPhaseId ?? 'phase_1'},
    decorate: text => `Skill notes: read the launch phases first.\n\n${text}\n[reasoning nudge]`,
  });
}

describe('describeRuntimeToolResultHandoff', () => {
  it('keeps a hint the transport copy loses', () => {
    const result = invokeSkillResult();
    const transported = summarizeExternalToolResult(result);
    expect(transported.length).toBeLessThanOrEqual(DEFAULT_EXTERNAL_TOOL_RESULT_MAX_CHARS);
    expect(transported).not.toContain('vendorOverride');

    const entry = describeRuntimeToolResultHandoff('invoke_skill', result, {toolCallId: 'call_1'});
    expect(entry).toEqual({
      toolName: 'invoke_skill',
      toolCallId: 'call_1',
      skillId: 'startup_analysis',
      outcome: 'returned',
      facts: {success: true, planPhaseIdPresent: true},
      content: {
        textBlocks: 1,
        otherBlocks: 0,
        chars: result.content[0].text.length,
        bytes: Buffer.byteLength(result.content[0].text, 'utf8'),
      },
      // `partial: undefined` never reaches the text, so it is not reported.
      payloadFields: {vendorOverride: 'verbatim'},
      vendorOverride: {vendor: 'xiaomi', additionalStepCount: 2},
    });
    expect(entry.content!.chars).toBeGreaterThan(DEFAULT_EXTERNAL_TOOL_RESULT_MAX_CHARS);
  });

  it('copies no payload values or model-authored ids', () => {
    const serialized = JSON.stringify(describeRuntimeToolResultHandoff('invoke_skill', invokeSkillResult({
      planPhaseId: 'phase_named_after_SecretClass',
    })));
    for (const value of [SECRET_ROW_VALUE, 'Xiaomi HyperOS', 'miui_boost', 'Skill notes', 'SecretClass']) {
      expect(serialized).not.toContain(value);
    }
  });

  it('reports a field as unproven when the text does not carry it verbatim', () => {
    const result = {
      ...invokeSkillResult(),
      content: [{type: 'text' as const, text: JSON.stringify({vendorOverride: {vendor: 'xiaomi'}}, null, 2)}],
    };
    expect(describeRuntimeToolResultHandoff('invoke_skill', result).payloadFields)
      .toEqual({vendorOverride: 'unproven'});
  });

  it('omits identifiers that are not bounded registry ids', () => {
    const entry = describeRuntimeToolResultHandoff('invoke_skill', invokeSkillResult({vendor: 'vendor with spaces'}), {
      toolCallId: 'id with spaces',
    });
    expect(entry.toolCallId).toBeUndefined();
    expect(entry.vendorOverride).toEqual({additionalStepCount: 2});
    expect(describeRuntimeToolResultHandoff('drop table; --', {content: []}).toolName)
      .toBe('unrecorded_tool_name');
  });

  it('describes legacy text results, error envelopes, cancellation and failures', () => {
    expect(describeRuntimeToolResultHandoff('execute_sql', {
      isError: true,
      content: [{type: 'text', text: 'boom'}, {type: 'image', data: 'x'}],
    })).toEqual({
      toolName: 'execute_sql',
      outcome: 'returned',
      isError: true,
      content: {textBlocks: 1, otherBlocks: 1, chars: 4, bytes: 4},
    });
    expect(describeRuntimeToolResultHandoff('execute_sql', undefined, {cancelled: true}))
      .toEqual({toolName: 'execute_sql', outcome: 'cancelled'});
    expect(describeRuntimeToolFailure('execute_sql')).toEqual({toolName: 'execute_sql', outcome: 'threw'});
    expect(describeRuntimeToolFailure('execute_sql', {cancelled: true}))
      .toEqual({toolName: 'execute_sql', outcome: 'cancelled'});
  });

  it('never throws on hostile results', () => {
    const hostile = {
      get content(): unknown { throw new Error('getter'); },
    };
    expect(describeRuntimeToolResultHandoff('invoke_skill', hostile))
      .toEqual({toolName: 'invoke_skill', outcome: 'returned'});
  });
});

describe('RuntimeToolResultAuditRecorder', () => {
  it('keeps completion order, bounds entries and ignores records after sealing', () => {
    const recorder = new RuntimeToolResultAuditRecorder();
    expect(recorder.hasRecordedData).toBe(false);
    recorder.record(() => describeRuntimeToolFailure('b_tool'));
    recorder.record(() => describeRuntimeToolFailure('a_tool'));
    const skipped = jest.fn(() => describeRuntimeToolFailure('c_tool'));
    for (let index = 2; index < 513; index += 1) recorder.record(index < 512 ? () => describeRuntimeToolFailure('x_tool') : skipped);
    const receipt = recorder.seal();
    expect(receipt.results.slice(0, 2)).toEqual([
      {toolName: 'b_tool', outcome: 'threw'},
      {toolName: 'a_tool', outcome: 'threw'},
    ]);
    expect(receipt.results).toHaveLength(512);
    expect(receipt.truncated).toBe(1);
    // A dropped entry is never described.
    expect(skipped).not.toHaveBeenCalled();
    recorder.record(skipped);
    expect(recorder.seal()).toBe(receipt);
    expect(skipped).not.toHaveBeenCalled();
    expect(Object.isFrozen(receipt.results)).toBe(true);
  });

  it('drops an entry it cannot describe or canonicalize instead of throwing', () => {
    const recorder = new RuntimeToolResultAuditRecorder();
    recorder.record(() => ({toolName: 'x_tool', outcome: 'returned', isError: undefined}) as never);
    recorder.record(() => {
      throw new Error('describe failed');
    });
    recorder.record(() => describeRuntimeToolFailure('y_tool'));
    expect(recorder.seal()).toEqual({
      schemaVersion: 1,
      results: [{toolName: 'y_tool', outcome: 'threw'}],
      truncated: 2,
    });
  });

  it('drops skill ids for a private run', () => {
    const recorder = new RuntimeToolResultAuditRecorder();
    recorder.record(() => describeRuntimeToolResultHandoff('invoke_skill', invokeSkillResult()));
    const projected = projectToolResultAuditForPrivateRun(recorder.seal());
    expect(projected.results[0].skillId).toBeUndefined();
    expect(projected.results[0].payloadFields).toEqual({vendorOverride: 'verbatim'});
  });
});
