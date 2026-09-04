// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {
  formatToolResultNarration,
  toolResultIsFailure,
} from '../toolNarration';
import {
  formatPlanPhaseTransition,
  planPhaseUpdatedContent,
  readPlanPhaseUpdateOrigin,
} from '../planPhaseEvents';

/** MCP results reach the runtimes wrapped in a content-block envelope. */
function mcpResult(body: unknown) {
  return [{type: 'text', text: JSON.stringify(body)}];
}

describe('formatToolResultNarration', () => {
  it('describes a SQL result by row count instead of dumping JSON', () => {
    const text = formatToolResultNarration({
      toolName: 'mcp__smartperfetto__execute_sql',
      result: mcpResult({success: true, mode: 'summary', totalRows: 376}),
    });
    expect(text).toBe('SQL 返回 376 行（已摘要）');
    expect(text).not.toContain('{');
  });

  it('names the artifact and its shape', () => {
    const text = formatToolResultNarration({
      toolName: 'fetch_artifact',
      args: {id: 'art-8'},
      result: mcpResult({
        success: true,
        detail: 'rows',
        id: 'art-8',
        columns: ['jank_type', 'count'],
        rows: [{}, {}, {}],
      }),
    });
    expect(text).toBe('取回 artifact art-8：3 行 / 2 列');
  });

  it('falls back to the call arguments when the result omits its target', () => {
    const text = formatToolResultNarration({
      toolName: 'fetch_artifact',
      args: {id: 'art-25'},
      result: mcpResult({success: true, detail: 'rows', rows: [[1], [2]]}),
    });
    expect(text).toContain('art-25');
    expect(text).toContain('2 行');
  });

  it('says summary when the fetch was a summary rather than rows', () => {
    expect(formatToolResultNarration({
      toolName: 'fetch_artifact',
      result: mcpResult({success: true, detail: 'summary', id: 'art-11', columns: new Array(72).fill('c')}),
    })).toBe('取回 artifact 摘要 art-11：72 列');
  });

  it('stays silent when the artifact result carries no shape', () => {
    expect(formatToolResultNarration({
      toolName: 'fetch_artifact',
      args: {id: 'art-25'},
      result: mcpResult({success: true, detail: 'rows'}),
    })).toBe('');
  });

  it.each([
    ['content-block array', (b: unknown) => mcpResult(b)],
    ['serialized array', (b: unknown) => JSON.stringify(mcpResult(b))],
    ['mcp envelope', (b: unknown) => ({content: mcpResult(b)})],
    ['serialized envelope', (b: unknown) => JSON.stringify({content: mcpResult(b)})],
    ['plain object', (b: unknown) => b],
  ])('reads the same result through the %s wrapper each runtime uses', (_label, wrap) => {
    const body = {success: true, detail: 'rows', id: 'art-11', columns: ['a', 'b'], rows: [[1], [2], [3]]};
    expect(formatToolResultNarration({
      toolName: 'fetch_artifact',
      result: wrap(body),
    })).toBe('取回 artifact art-11：3 行 / 2 列');
  });

  it('reports the detected architecture and confidence', () => {
    const text = formatToolResultNarration({
      toolName: 'detect_architecture',
      result: mcpResult({type: 'STANDARD', confidence: 0.3684210526315789}),
    });
    expect(text).toBe('识别为 STANDARD 渲染架构（置信度 0.37）');
  });

  it('reports hypothesis convergence', () => {
    const text = formatToolResultNarration({
      toolName: 'resolve_hypothesis',
      result: mcpResult({
        success: true,
        hypothesisId: 'h1',
        status: 'confirmed',
        unresolvedCount: 0,
      }),
    });
    expect(text).toBe('假设 h1 收敛为 confirmed，剩余待验证 0 条');
  });

  it('says nothing for invoke_skill, which the skill engine already reports', () => {
    expect(formatToolResultNarration({
      toolName: 'invoke_skill',
      args: {skillId: 'scrolling_analysis'},
      result: mcpResult({success: true, skillId: 'scrolling_analysis', displayResults: [{}, {}]}),
    })).toBe('');
  });

  it('returns empty rather than guessing at an unknown tool', () => {
    expect(formatToolResultNarration({
      toolName: 'some_future_tool',
      result: mcpResult({success: true, anything: 1}),
    })).toBe('');
  });

  it('narrates a failure body', () => {
    const text = formatToolResultNarration({
      toolName: 'execute_sql',
      result: mcpResult({success: false, error: 'no such table: foo'}),
    });
    expect(text).toBe('execute_sql 失败：no such table: foo');
  });

  it('narrates a runtime-reported failure even when the body looks fine', () => {
    const text = formatToolResultNarration({
      toolName: 'execute_sql',
      result: mcpResult({success: true}),
      isError: true,
    });
    expect(text).toContain('失败');
  });

  it.each([
    ['a trailing phase reminder', (body: string) => `${body}\n\n**Reminder**: stay on p1.`],
    ['a notes prefix and reasoning nudge', (body: string) => `Notes: prior turn said X.\n${body}\nThink first.`],
  ])('reads JSON wrapped in %s', (_label, wrap) => {
    // invoke_skill and fetch_artifact deliberately surround their JSON with
    // guidance text; a whole-string parse silently dropped those results.
    const body = JSON.stringify({success: true, detail: 'rows', id: 'art-8', columns: ['a', 'b'], rows: [[1], [2]]});
    expect(formatToolResultNarration({
      toolName: 'fetch_artifact',
      result: [{type: 'text', text: wrap(body)}],
    })).toBe('取回 artifact art-8：2 行 / 2 列');
  });

  it('is not confused by braces inside JSON string values', () => {
    expect(formatToolResultNarration({
      toolName: 'execute_sql',
      result: [{type: 'text', text: `${JSON.stringify({success: true, totalRows: 5, note: 'has } and { inside'})} trailing`}],
    })).toBe('SQL 返回 5 行');
  });

  it('never emits raw JSON when the payload was truncated mid-object', () => {
    // summarizeExternalToolResult truncates by bytes, so a downstream parse can
    // fail. The narrator must stay silent rather than leak the fragment.
    const truncated = '[{"type":"text","text":"{\\"success\\":true,\\"skillId\\":\\"scroll';
    const text = formatToolResultNarration({toolName: 'invoke_skill', result: truncated});
    expect(text).toBe('');
  });

  it('emits English when the output language is English', () => {
    const text = formatToolResultNarration({
      toolName: 'execute_sql',
      result: mcpResult({success: true, totalRows: 12}),
      language: 'en',
    });
    expect(text).toBe('SQL returned 12 rows');
  });
});

describe('toolResultIsFailure', () => {
  it('trusts the runtime error flag', () => {
    expect(toolResultIsFailure({toolName: 'x', result: mcpResult({success: true}), isError: true})).toBe(true);
  });

  it('reads success:false out of the MCP envelope', () => {
    expect(toolResultIsFailure({toolName: 'x', result: mcpResult({success: false})})).toBe(true);
  });

  it('treats a normal result as success', () => {
    expect(toolResultIsFailure({toolName: 'x', result: mcpResult({success: true})})).toBe(false);
  });
});

describe('plan phase transition contract', () => {
  it('requires an explicit origin on every emitted payload', () => {
    const content = planPhaseUpdatedContent({
      phaseId: 'p1',
      phaseName: '概览与架构信号',
      status: 'in_progress',
      summary: '检测渲染架构',
      origin: 'auto',
    });
    expect(content.origin).toBe('auto');
    expect(content.summary).toBe('检测渲染架构');
  });

  it('only accepts the two known origins', () => {
    expect(readPlanPhaseUpdateOrigin('auto')).toBe('auto');
    expect(readPlanPhaseUpdateOrigin('model')).toBe('model');
    expect(readPlanPhaseUpdateOrigin('自动')).toBeUndefined();
    expect(readPlanPhaseUpdateOrigin(undefined)).toBeUndefined();
  });

  it.each([
    ['in_progress', '进入阶段「概览」'],
    ['completed', '完成阶段「概览」：读架构'],
    ['pending', '阶段「概览」退回待补证：读架构'],
    ['skipped', '跳过阶段「概览」：读架构'],
  ])('renders %s with its own wording', (status, expected) => {
    expect(formatPlanPhaseTransition({
      phaseId: 'p1',
      phaseName: '概览',
      status,
      summary: '读架构',
    })).toBe(expected);
  });

  it('stays neutral for a status it does not know', () => {
    const text = formatPlanPhaseTransition({phaseId: 'p1', phaseName: '概览', status: 'blocked'});
    expect(text).toBe('阶段「概览」状态更新为 blocked');
  });

  it('falls back to the phase id when the name is missing', () => {
    expect(formatPlanPhaseTransition({phaseId: 'p2', status: 'completed'})).toBe('完成阶段「p2」');
  });
});

describe('tool call narration coverage', () => {
  /**
   * A tool with no narration case prints "调用工具 recall_similar_case", which is
   * the mechanical line this layer exists to prevent. Registering a tool and
   * forgetting the sentence is easy; this test makes it loud.
   */
  it('narrates every tool registered with the MCP server', () => {
    const fs = require('fs') as typeof import('fs');
    const path = require('path') as typeof import('path');

    const serverSource = fs.readFileSync(
      path.join(__dirname, '..', 'claudeMcpServer.ts'),
      'utf8',
    );
    const registered = new Set(
      [...serverSource.matchAll(/registry\.register(?:Sdk|Shared)?\(\s*[A-Za-z0-9_]+,\s*'([a-z_]+)'/g)]
        .map((match) => match[1]),
    );
    expect(registered.size).toBeGreaterThan(30);

    const narrationSource = fs.readFileSync(
      path.join(__dirname, '..', 'toolNarration.ts'),
      'utf8',
    );
    const callSection = narrationSource.slice(
      narrationSource.indexOf('export function formatToolCallNarration'),
      narrationSource.indexOf('export function looksLikeGenericToolMessage'),
    );
    const narrated = new Set(
      [...callSection.matchAll(/case '([a-z_]+)'/g)].map((match) => match[1]),
    );

    const missing = [...registered].filter((tool) => !narrated.has(tool)).sort();
    expect(missing).toEqual([]);
  });
});

describe('privacy canary', () => {
  const {projectToolResultForExternalSurface, isSensitiveRagToolName} =
    require('../../services/rag/toolResultProjectionFilter') as typeof import('../../services/rag/toolResultProjectionFilter');

  /**
   * Narration must run on the externally projected result, never the raw MCP
   * payload. Codebase-aware runs carry user source through these tools, and the
   * timeline is a public SSE surface.
   */
  it('emits nothing for a sensitive tool once its result is projected', () => {
    const rawWithSource = [{
      type: 'text',
      text: JSON.stringify({
        success: true,
        message: 'void Choreographer::doFrame() { SECRET_SOURCE_LINE(); }',
        chunks: [{content: 'private static final String KEY = "SECRET_SOURCE_LINE";'}],
      }),
    }];

    for (const toolName of ['read_codebase_file', 'search_codebase', 'lookup_app_source']) {
      const projected = projectToolResultForExternalSurface(toolName, rawWithSource);
      const text = formatToolResultNarration({toolName, result: projected});
      expect(text).not.toContain('SECRET_SOURCE_LINE');
      expect(text).not.toContain('Choreographer::doFrame');
    }
  });

  it('keeps the sensitive tool list non-empty so this canary means something', () => {
    expect(isSensitiveRagToolName('read_codebase_file')).toBe(true);
  });
});

describe('list_skills result shapes', () => {
  it('counts the quick-mode object shape', () => {
    expect(formatToolResultNarration({
      toolName: 'list_skills',
      result: [{type: 'text', text: JSON.stringify({matched: 12, skills: [{id: 'a'}, {id: 'b'}]})}],
    })).toBe('技能目录返回 12 项');
  });

  it('counts the full-mode bare array shape', () => {
    // Full mode returns the catalog directly rather than wrapping it.
    expect(formatToolResultNarration({
      toolName: 'list_skills',
      result: [{type: 'text', text: JSON.stringify([{id: 'a'}, {id: 'b'}, {id: 'c'}])}],
    })).toBe('技能目录返回 3 项');
  });
});

describe('failure detection across the projection boundary', () => {
  const {projectToolResultForExternalSurface} =
    require('../../services/rag/toolResultProjectionFilter') as typeof import('../../services/rag/toolResultProjectionFilter');

  /**
   * A sensitive tool's projection is a rejection envelope with no `success`
   * field. Deciding failure after projection therefore reported a failed
   * source lookup as an ordinary success, and the step vanished from the
   * timeline instead of showing that the lookup did not work.
   */
  it('sees a sensitive tool failure that projection erases', () => {
    const rawFailure = [{type: 'text', text: JSON.stringify({success: false, error: 'codebase not registered'})}];

    const projected = projectToolResultForExternalSurface('read_codebase_file', rawFailure);
    expect(toolResultIsFailure({toolName: 'read_codebase_file', result: projected})).toBe(false);
    expect(toolResultIsFailure({toolName: 'read_codebase_file', result: rawFailure})).toBe(true);
  });

  it('reads a failure flag off the result envelope itself', () => {
    expect(toolResultIsFailure({
      toolName: 'invoke_skill',
      result: {content: [{type: 'text', text: '{"success":true}'}], isError: true},
    })).toBe(true);
  });

  it('reads isError from inside the tool body', () => {
    expect(toolResultIsFailure({
      toolName: 'invoke_skill',
      result: [{type: 'text', text: JSON.stringify({isError: true})}],
    })).toBe(true);
  });
});

describe('policy refusal vs tool malfunction', () => {
  const {isPolicyRefusalResult} = require('../toolNarration') as typeof import('../toolNarration');

  /**
   * Around thirty MCP handlers answer a disallowed call with
   * `{success:false, action_required}`. Counting those as malfunctions let one
   * budget refusal plus two plan-phase refusals trip a 60%-of-5 circuit
   * breaker whose remedy is to tell the model to simplify its scope.
   */
  it.each([
    ['an exhausted per-phase tool budget', {
      success: false,
      error: 'phase_tool_budget_exhausted',
      action_required: 'close_phase_or_revise_plan',
    }],
    ['a phase closed without its expected evidence', {
      success: false,
      error: 'missing expected calls',
      action_required: 'run_expected_calls_or_explain_unavailability',
    }],
    ['an artifact read that must summarize first', {
      success: false,
      error: 'summary_required_before_rows',
      action_required: 'fetch_artifact',
    }],
  ])('recognises %s as a refusal', (_label, body) => {
    expect(isPolicyRefusalResult([{type: 'text', text: JSON.stringify(body)}])).toBe(true);
  });

  it('does not call a genuine tool failure a refusal', () => {
    expect(isPolicyRefusalResult([{
      type: 'text',
      text: JSON.stringify({success: false, error: 'no such table: foo'}),
    }])).toBe(false);
  });

  it('does not call a successful result a refusal', () => {
    expect(isPolicyRefusalResult([{
      type: 'text',
      text: JSON.stringify({success: true, action_required: 'fetch_artifact'}),
    }])).toBe(false);
  });

  it('reads a refusal through the isError channel too', () => {
    expect(isPolicyRefusalResult({
      content: [{type: 'text', text: JSON.stringify({isError: true, action_required: 'submit_plan'})}],
    })).toBe(true);
  });

  it('ignores an empty action_required', () => {
    expect(isPolicyRefusalResult([{
      type: 'text',
      text: JSON.stringify({success: false, action_required: '   '}),
    }])).toBe(false);
  });
});
