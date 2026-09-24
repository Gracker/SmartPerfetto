// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {
  formatToolResultNarration,
  toolResultIsFailure,
  isPolicyRefusalResult,
} from '../toolNarration';
import {
  formatPlanPhaseTransition,
  planPhaseUpdatedContent,
  readPlanPhaseUpdateOrigin,
} from '../planPhaseEvents';
import {createRuntimeToolResult, readRuntimeToolResultFacts} from '../../agentRuntime/runtimeToolResult';

/** MCP results reach the runtimes wrapped in a content-block envelope. */
function mcpResult(body: unknown) {
  return [{type: 'text', text: JSON.stringify(body)}];
}

describe('formatToolResultNarration', () => {
  it('keeps the historical incompleteness visible without quoting its private body', () => {
    for (const privateContext of [false, true]) {
      expect(formatToolResultNarration({toolName: 'read_session_history', privateContext,
        result: mcpResult({success: true, kind: 'turn', partial: true, text: 'SECRET_HISTORY_CANARY'})}))
        .toBe('这轮历史结果尚未完整完成，已保留其限制供继续核查');
    }
  });
  it.each([true, undefined])('does not overwrite typed success=%s with a legacy failure field', success => {
    const result = createRuntimeToolResult({success: false, error: 'old failure', action_required: 'retry'}, {
      facts: success === undefined ? {} : {success},
    });
    expect(formatToolResultNarration({toolName: 'invoke_skill', result})).toBe('');
    expect(isPolicyRefusalResult(result)).toBe(false);
  });
  it('says nothing for a SQL query that returned rows', () => {
    // The dispatch line already stated what the query is for; a row count does
    // not tell the reader whether it worked out.
    expect(formatToolResultNarration({
      toolName: 'mcp__smartperfetto__execute_sql',
      result: mcpResult({success: true, mode: 'summary', totalRows: 376}),
    })).toBe('');
  });

  it('reports a SQL query that matched nothing, which forces a new approach', () => {
    expect(formatToolResultNarration({
      toolName: 'execute_sql',
      result: mcpResult({success: true, totalRows: 0}),
    })).toBe('SQL 未查到匹配数据');
  });

  it('says nothing for an artifact fetch that returned rows', () => {
    expect(formatToolResultNarration({
      toolName: 'fetch_artifact',
      args: {id: 'art-8'},
      result: mcpResult({
        success: true,
        detail: 'rows',
        id: 'art-8',
        columns: ['jank_type', 'count'],
        rows: [{}, {}, {}],
      }),
    })).toBe('');
  });

  it('reports an empty artifact', () => {
    expect(formatToolResultNarration({
      toolName: 'fetch_artifact',
      args: {id: 'art-8'},
      result: mcpResult({success: true, detail: 'rows', id: 'art-8', rows: []}),
    })).toBe('该 artifact 没有数据行');
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
    const body = {success: true, detail: 'rows', id: 'art-11', rows: []};
    expect(formatToolResultNarration({
      toolName: 'fetch_artifact',
      result: wrap(body),
    })).toBe('该 artifact 没有数据行');
  });

  it('reports the detected architecture and confidence', () => {
    const text = formatToolResultNarration({
      toolName: 'detect_architecture',
      result: mcpResult({type: 'STANDARD', confidence: 0.3684210526315789}),
    });
    expect(text).toBe('识别为 STANDARD 渲染架构（置信度 0.37）');
  });

  it('says nothing when the wait chain came back with waits to read', () => {
    // The dispatch line already named the thread and window; the breakdown is
    // in the data envelope, not in one more timeline line.
    expect(formatToolResultNarration({
      toolName: 'analyze_wait_chain',
      result: mcpResult({success: true, available: true, waitingMs: 4.2, topWaits: [{durationMs: 4.2}]}),
    })).toBe('');
  });

  it('says an idle wait is idle, and names the peer a chain ends in', () => {
    expect(formatToolResultNarration({
      toolName: 'analyze_wait_chain',
      result: mcpResult({success: true, available: true, waitingMs: 13596, topWaits: [{durationMs: 3002}],
        anomalies: [{id: 'idle_wait', severity: 'info'}]}),
    })).toBe('这段等待位于两个 slice 之间，更像线程空闲而不是卡顿耗时');
    expect(formatToolResultNarration({
      toolName: 'analyze_wait_chain',
      language: 'en',
      result: mcpResult({success: true, available: true, waitingMs: 30, topWaits: [{durationMs: 25}],
        anomalies: [{id: 'task_too_long', severity: 'critical'}, {id: 'peer_event_wait', severity: 'warning'}],
        longestEventWait: {processName: 'com.demo', threadName: 'OkHttp Dispatch',
          wakeSourceClass: 'network_receive_candidate'}}),
    })).toBe('The chain ends in com.demo / OkHttp Dispatch waiting for an external event (network-receive candidate); that is the blocker to follow');
  });

  it.each([
    ['selector_conflict', {}, 'thread_state_id 不属于指定的线程或区间，需要去掉它或改用它所属的线程'],
    ['no_thread_state_in_window', {candidates: [{processName: 'com.demo', threadName: 'main'}]},
      '该线程在区间内没有调度数据，需要换一个有数据的线程，如 com.demo / main'],
    ['ambiguous_thread_selection', {}, '线程选择匹配到多个线程，需要用 tid 或 utid 指定其中一个'],
    ['missing_window', {}, '缺少分析区间，需要同时给出 start_ts 和 end_ts'],
  ])('says what a wait-chain refusal (%s) asks the caller to change', (error, extra, expected) => {
    expect(formatToolResultNarration({
      toolName: 'analyze_wait_chain',
      isError: true,
      result: mcpResult({success: false, error, action_required: 'x', ...extra}),
    })).toBe(expected);
  });

  it('keeps the generic failure line for a wait-chain failure that is not a refusal', () => {
    expect(formatToolResultNarration({
      toolName: 'analyze_wait_chain',
      isError: true,
      result: mcpResult({success: false, error: 'trace processor went away'}),
    })).toBe('analyze_wait_chain 失败：trace processor went away');
  });

  it.each([
    ['task_state_running', '该线程在这段区间一直在运行，没有等待链可追'],
    ['no_waiting_time', '所选区间内没有等待时间，没有等待链可追'],
    ['no_critical_path_stack', '这段区间取不到等待链，trace 可能缺少 sched_waking'],
    ['wait_open_at_trace_end', '这段等待到 trace 结束都没有结束，没有唤醒者可追'],
  ])('reports an unavailable wait chain (%s), which sends the model elsewhere', (reason, expected) => {
    expect(formatToolResultNarration({
      toolName: 'analyze_wait_chain',
      result: mcpResult({success: true, available: false, unavailableReason: reason}),
    })).toBe(expected);
  });

  it('does not blame sched_waking for a window that has no waiting time', () => {
    expect(formatToolResultNarration({
      toolName: 'analyze_wait_chain',
      language: 'en',
      result: mcpResult({success: true, available: false, unavailableReason: 'no_waiting_time'}),
    })).toBe('The selected window has no waiting time; there is no wait chain to follow');
  });

  it('reports a window with no sleeping or uninterruptible time', () => {
    expect(formatToolResultNarration({
      toolName: 'analyze_wait_chain',
      result: mcpResult({success: true, available: true, waitingMs: 0, topWaits: []}),
    })).toBe('该线程在这段区间没有睡眠或不可中断等待');
  });

  it('stays silent when the wait chain result carries no state breakdown', () => {
    expect(formatToolResultNarration({
      toolName: 'analyze_wait_chain',
      result: mcpResult({success: true, available: true}),
    })).toBe('');
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

  it.each([
    ['invoke_skill', {success: true, skillId: 'scrolling_analysis', displayResults: [{}, {}]}],
    ['submit_plan', {success: true, phases: [{}, {}]}],
    ['submit_hypothesis', {success: true, hypothesisId: 'h1', statement: 'x'}],
    ['flag_uncertainty', {success: true, flagCount: 1}],
    ['list_skills', {matched: 12, skills: [{}]}],
    ['write_analysis_note', {success: true, section: 'finding'}],
  ])('says nothing for %s, whose dispatch line already said it', (toolName, body) => {
    expect(formatToolResultNarration({toolName, result: mcpResult(body)})).toBe('');
  });

  it('reports only the plan becoming complete, not each phase update', () => {
    expect(formatToolResultNarration({
      toolName: 'update_plan_phase',
      args: {phaseId: 'p2', status: 'completed'},
      result: mcpResult({success: true}),
    })).toBe('');
    expect(formatToolResultNarration({
      toolName: 'update_plan_phase',
      args: {phaseId: 'p2', status: 'completed'},
      result: mcpResult({success: true, allPhasesComplete: true}),
    })).toBe('全部计划阶段已完成');
  });

  it.each([
    ['lookup_knowledge', 'results'],
    ['lookup_aosp_source', 'results'],
    ['lookup_app_source', 'results'],
    ['lookup_kernel_source', 'results'],
    ['lookup_oem_sdk', 'results'],
    ['query_code_graph', 'references'],
    ['search_codebase', 'chunks'],
    ['recall_similar_case', 'cases'],
    ['resolve_symbol', 'candidates'],
  ])('reports %s finding nothing, using its own %s field', (toolName, field) => {
    expect(formatToolResultNarration({
      toolName,
      result: mcpResult({success: true, [field]: []}),
    })).toBe('未查到相关资料');
    expect(formatToolResultNarration({
      toolName,
      result: mcpResult({success: true, [field]: [{}, {}]}),
    })).toBe('');
  });

  it('does not announce a failed lookup when the body has no hit list at all', () => {
    expect(formatToolResultNarration({
      toolName: 'lookup_knowledge',
      result: mcpResult({success: true, note: 'served from cache'}),
    })).toBe('');
  });

  it('does not treat an empty array on a non-retrieval tool as a failed lookup', () => {
    expect(formatToolResultNarration({
      toolName: 'invoke_skill',
      result: mcpResult({success: true, results: []}),
    })).toBe('');
  });

  it('keeps the retrieval set in step with the registry', () => {
    const fs = require('fs') as typeof import('fs');
    const path = require('path') as typeof import('path');
    const serverSource = fs.readFileSync(path.join(__dirname, '..', 'claudeMcpServer.ts'), 'utf8');
    const registered = [...serverSource.matchAll(/registry\.register(?:Sdk|Shared)?\(\s*[A-Za-z0-9_]+,\s*'([a-z_]+)'/g)]
      .map((match) => match[1]);
    // Every registered tool whose job is to come back with hits must report
    // finding nothing; otherwise the result that should redirect the model is
    // the one line we drop.
    const retrievalShaped = registered.filter((tool) =>
      /^(lookup_|search_|query_|recall_)/.test(tool) && tool !== 'query_trace');
    const narrationSource = fs.readFileSync(path.join(__dirname, '..', 'toolNarration.ts'), 'utf8');
    const setBlock = narrationSource.slice(
      narrationSource.indexOf('const RETRIEVAL_TOOLS'),
      narrationSource.indexOf('function retrievalHitCount'),
    );
    const missing = retrievalShaped.filter((tool) => !setBlock.includes(`'${tool}'`)).sort();
    expect(missing).toEqual([]);
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
  ])('reads producer facts before decoration with %s', (_label, wrap) => {
    const body = {success: true, detail: 'rows', id: 'art-8', rows: []};
    expect(formatToolResultNarration({
      toolName: 'fetch_artifact',
      result: createRuntimeToolResult(body, {decorate: wrap}),
    })).toBe('该 artifact 没有数据行');
  });

  it('does not narrate a failure from ordinary explanation quoting an earlier JSON result', () => {
    expect(formatToolResultNarration({
      toolName: 'invoke_skill', result: 'A previous response used {"success":false}. This explains its format.',
    })).toBe('');
  });

  it('is not confused by braces inside JSON string values', () => {
    expect(formatToolResultNarration({
      toolName: 'execute_sql',
      result: [{type: 'text', text: `${JSON.stringify({success: true, totalRows: 0, note: 'has } and { inside'})} trailing`}],
    })).toBe('SQL 未查到匹配数据');
  });

  it('never emits raw JSON when the payload was truncated mid-object', () => {
    // summarizeExternalToolResult truncates by bytes, so a downstream parse can
    // fail. The narrator must stay silent rather than leak the fragment.
    const truncated = '[{"type":"text","text":"{\\"success\\":true,\\"skillId\\":\\"scroll';
    const text = formatToolResultNarration({toolName: 'invoke_skill', result: truncated});
    expect(text).toBe('');
  });

  it('emits English when the output language is English', () => {
    expect(formatToolResultNarration({
      toolName: 'execute_sql',
      result: mcpResult({success: true, totalRows: 0}),
      language: 'en',
    })).toBe('SQL matched no rows');
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


describe('failure detection across the projection boundary', () => {
  const {projectToolResultForExternalSurface} =
    require('../../services/rag/toolResultProjectionFilter') as typeof import('../../services/rag/toolResultProjectionFilter');

  it('preserves tool failure after private error text is projected away', () => {
    const rawFailure = [{type: 'text', text: JSON.stringify({success: false, error: 'codebase not registered'})}];

    const projected = projectToolResultForExternalSurface('read_codebase_file', rawFailure);
    expect(toolResultIsFailure({toolName: 'read_codebase_file', result: projected})).toBe(true);
    expect(toolResultIsFailure({toolName: 'read_codebase_file', result: rawFailure})).toBe(true);
  });

  it.each([true, false, undefined])('projects every raw wrapper away while preserving success=%s', success => {
    const raw = createRuntimeToolResult({
      reference: {referenceId: 'ref1', codebaseId: 'cb1', filePath: 'STRUCTURED_PATH_CANARY', text: 'STRUCTURED_TEXT_CANARY'},
    }, {facts: {planPhaseId: 'p1', ...(success === undefined ? {} : {success})}});
    raw.content[0].text = 'CONTENT_CANARY';
    const wrapped = {content: [{type: 'text', text: 'OUTER_CONTENT_CANARY'}], details: raw};
    for (const input of [raw, wrapped, JSON.stringify(wrapped)]) {
      const projected = projectToolResultForExternalSurface('mcp__smartperfetto__read_codebase_file', input);
      expect(JSON.stringify(projected)).not.toMatch(/CANARY/);
      expect(readRuntimeToolResultFacts(projected)).toEqual({planPhaseId: 'p1', ...(success === undefined ? {} : {success})});
    }
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

describe('what a phase transition line spends its words on', () => {
  it('shows only the reason the phase closed, not the recap behind it', () => {
    // The stored summary carries the evidence recap and the phase goal for the
    // report and the plan record. In the process view those repeat the evidence
    // lines and the plan line that surround them.
    const stored = '模型未给出完成摘要，按已收集证据自动收口。本阶段已产生 18 个证据表'
      + '（来源：scrolling_analysis）：洞见摘要、初始化 CPU 拓扑等 14 个。'
      + '阶段目标：建立全量掉帧口径。已进入后续阶段「根因深钻」。';
    const line = formatPlanPhaseTransition({
      phaseId: 'p1',
      phaseName: '概览与掉帧分布',
      status: 'completed',
      summary: stored,
    });
    expect(line).toBe('完成阶段「概览与掉帧分布」：模型未给出完成摘要，按已收集证据自动收口。');
    expect(line).not.toContain('证据表');
    expect(line).not.toContain('阶段目标');
  });

  it('keeps a short summary whole', () => {
    expect(formatPlanPhaseTransition({
      phaseId: 'p1',
      phaseName: '概览',
      status: 'pending',
      summary: '仍缺少关键工具证据。',
    })).toBe('阶段「概览」退回待补证：仍缺少关键工具证据。');
  });

  it('handles a summary with no sentence terminator', () => {
    expect(formatPlanPhaseTransition({
      phaseId: 'p1',
      phaseName: '概览',
      status: 'completed',
      summary: '证据已足',
    })).toBe('完成阶段「概览」：证据已足');
  });
});

describe('leading-sentence trimming', () => {
  it('does not cut a decimal in half', () => {
    expect(formatPlanPhaseTransition({
      phaseId: 'p1',
      phaseName: '概览',
      status: 'completed',
      summary: '主线程 animation 59.31ms 是唯一热点。后续细节见报告。',
    })).toBe('完成阶段「概览」：主线程 animation 59.31ms 是唯一热点。');
  });

  it('ends an English sentence on its period', () => {
    expect(formatPlanPhaseTransition({
      phaseId: 'p1',
      phaseName: 'Overview',
      status: 'completed',
      summary: 'The model gave no summary. Evidence recap follows.',
    }, 'en')).toBe('Completed phase "Overview": The model gave no summary.');
  });
});
