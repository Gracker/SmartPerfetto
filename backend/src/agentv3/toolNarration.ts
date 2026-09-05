// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import { DEFAULT_OUTPUT_LANGUAGE, localize, type OutputLanguage } from './outputLanguage';
import type { TracePaneSide, TracePairContext, TraceSource } from './types';

const MCP_PREFIX = 'mcp__smartperfetto__';
const MAX_MESSAGE_CHARS = 220;
const MAX_PLAN_MESSAGE_CHARS = 560;
const MAX_SQL_MESSAGE_CHARS = 300;

export interface ToolNarrationOptions {
  tracePairContext?: TracePairContext;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? parsed as Record<string, unknown>
        : {};
    } catch {
      return {};
    }
  }
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function flatten(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function shorten(value: string, max = MAX_MESSAGE_CHARS): string {
  const flat = flatten(value);
  return flat.length > max ? `${flat.slice(0, max - 3)}...` : flat;
}

function shortToolName(toolName: string): string {
  const cleaned = toolName.startsWith(MCP_PREFIX)
    ? toolName.slice(MCP_PREFIX.length)
    : toolName;
  return cleaned.replace(/^smartperfetto__/, '');
}

function normalizeTraceSource(value: string): TraceSource {
  return value === 'reference' ? 'reference' : 'current';
}

function tracePaneLabel(side: TracePaneSide, language: OutputLanguage): string {
  switch (side) {
    case 'left':
      return localize(language, '左侧', 'left pane');
    case 'right':
      return localize(language, '右侧', 'right pane');
    case 'top':
      return localize(language, '上方', 'top pane');
    case 'bottom':
      return localize(language, '下方', 'bottom pane');
  }
}

function traceRoleLabel(traceSide: TraceSource, language: OutputLanguage): string {
  return traceSide === 'reference'
    ? localize(language, '对比 Trace', 'comparison trace')
    : localize(language, '基线 Trace', 'baseline trace');
}

function comparisonTraceLabel(
  traceSide: TraceSource,
  language: OutputLanguage,
  options: ToolNarrationOptions,
): string {
  const pane = options.tracePairContext?.panes.find(item => item.traceSide === traceSide);
  const role = traceRoleLabel(traceSide, language);
  return pane ? `${tracePaneLabel(pane.side, language)}/${role}` : role;
}

function parseArray(value: unknown): Record<string, unknown>[] {
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed)
        ? parsed.filter((item) => item && typeof item === 'object' && !Array.isArray(item)) as Record<string, unknown>[]
        : [];
    } catch {
      return [];
    }
  }
  return Array.isArray(value)
    ? value.filter((item) => item && typeof item === 'object' && !Array.isArray(item)) as Record<string, unknown>[]
    : [];
}

function paramSummary(params: unknown): string {
  const paramRecord = asRecord(params);
  const entries = Object.entries(paramRecord)
    .filter(([, value]) => value !== undefined && value !== null && value !== '')
    .slice(0, 4)
    .map(([key, value]) => {
      if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
        return `${key}=${String(value)}`;
      }
      return key;
    });
  return entries.join(', ');
}

function phaseSummary(phases: Record<string, unknown>[]): string {
  const conclusionPhases = phases.filter(isConclusionLikePhase);
  const orderedPhases = conclusionPhases.length > 0
    ? [
        ...phases.filter(phase => !isConclusionLikePhase(phase)),
        ...conclusionPhases,
      ]
    : phases;

  return orderedPhases
    .map((phase) => {
      const id = readString(phase.id);
      const name = readString(phase.name);
      const goal = readString(phase.goal);
      const label = [id, name].filter(Boolean).join(' ');
      return goal ? `${label || '阶段'}: ${goal}` : (label || '阶段');
    })
    .filter(Boolean)
    .join('；');
}

function isConclusionLikePhase(phase: Record<string, unknown>): boolean {
  const text = [
    readString(phase.id),
    readString(phase.name),
    readString(phase.goal),
  ].join(' ').toLowerCase();
  return /(综合结论|最终结论|结论输出|输出结论|输出最终报告|最终报告|综合报告|final conclusion|conclusion|final report|write final answer)/i
    .test(text);
}

function leadingSqlComment(sql: string): string {
  const lines = sql
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean);
  const comments: string[] = [];
  for (const line of lines) {
    const match = line.match(/^--\s*(.+)$/);
    if (!match) break;
    comments.push(match[1].trim());
  }
  return comments.join('；');
}

function quotedSqlTerms(sql: string, max = 3): string[] {
  const terms = new Set<string>();
  const pattern = /\b(?:GLOB|LIKE|=)\s*'([^']{2,80})'/gi;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(sql)) && terms.size < max) {
    const cleaned = match[1].replace(/[*%]/g, '').trim();
    if (cleaned) terms.add(cleaned);
  }
  return [...terms];
}

function sqlIntent(sql: string, language: OutputLanguage): string {
  const comment = leadingSqlComment(sql);
  if (comment) return comment;

  const lower = sql.toLowerCase();
  const terms = quotedSqlTerms(sql);
  const termText = terms.length > 0
    ? localize(language, `（过滤: ${terms.join(', ')}）`, ` (filters: ${terms.join(', ')})`)
    : '';

  if (/actual_frame_timeline_slice/.test(lower) &&
    /min\s*\(\s*ts\s*\)/.test(lower) &&
    /max\s*\(\s*ts\s*\+\s*dur\s*\)/.test(lower)) {
    return localize(language, '获取 FrameTimeline 的 Trace 时间边界和帧数量', 'get FrameTimeline trace time bounds and frame count');
  }
  if (/actual_frame_timeline|expected_frame_timeline/.test(lower) && /jank/.test(lower)) {
    return localize(language, `统计帧耗时、掉帧类型和 FrameTimeline 证据${termText}`, `summarize frame duration, jank type, and FrameTimeline evidence${termText}`);
  }
  if (/\bthread_state\b/.test(lower)) {
    return localize(language, `验证目标时间窗内线程 Running/Sleeping/IO 等状态分布${termText}`, `verify thread-state distribution such as Running/Sleeping/IO in the target window${termText}`);
  }
  if (/\bthread_slice\b|\bslice\b/.test(lower) && /webview|chromium|v8|crrenderermain|parsehtml|layout|drawgl/.test(lower)) {
    return localize(language, `验证 WebView/Chromium/V8 相关 slice 耗时和线程归属${termText}`, `verify WebView/Chromium/V8 slice duration and thread ownership${termText}`);
  }
  if (/\bthread_slice\b/.test(lower) && /self_dur|dur|order\s+by/.test(lower)) {
    return localize(language, `定位目标线程或进程内的热点 slice 耗时${termText}`, `find hot slice durations in the target thread or process${termText}`);
  }
  if (/\bsched_slice\b|\bcpu_counter_track\b|\bcounter\b/.test(lower)) {
    return localize(language, `验证 CPU 调度、频率或计数器数据${termText}`, `verify CPU scheduling, frequency, or counter data${termText}`);
  }

  const hint = sqlTableHint(sql, language);
  return hint
    ? localize(language, `查询 ${hint} 来验证具体数据${termText}`, `query ${hint} to verify specific data${termText}`)
    : localize(language, '补充验证 Skill 未直接覆盖的数据', 'verify data not directly covered by a Skill');
}

function sqlTableHint(sql: string, language: OutputLanguage): string {
  const tableMatch = sql.match(/\bfrom\s+([a-zA-Z0-9_]+)/i);
  const table = tableMatch?.[1] || '';
  const tableHints: Record<string, { zh: string; en: string }> = {
    actual_frame_timeline_slice: { zh: '实际帧时间线', en: 'actual frame timeline' },
    actual_frame_timeline_event: { zh: '实际帧时间线', en: 'actual frame timeline' },
    expected_frame_timeline_event: { zh: '预期帧时间线', en: 'expected frame timeline' },
    frame_slice: { zh: '帧 Slice', en: 'frame slices' },
    slice: { zh: 'Trace Slice', en: 'trace slices' },
    thread_state: { zh: '线程状态', en: 'thread states' },
    thread: { zh: '线程信息', en: 'thread metadata' },
    process: { zh: '进程信息', en: 'process metadata' },
    counter: { zh: '计数器', en: 'counters' },
    sched_slice: { zh: 'CPU 调度', en: 'CPU scheduling' },
    android_launches: { zh: '应用启动', en: 'app launches' },
    android_app_process_starts: { zh: '进程启动', en: 'process starts' },
    cpu_counter_track: { zh: 'CPU 频率', en: 'CPU frequency' },
    gpu_counter_track: { zh: 'GPU 频率', en: 'GPU frequency' },
    memory_counter: { zh: '内存计数', en: 'memory counters' },
    android_binder_transaction: { zh: 'Binder 事务', en: 'Binder transactions' },
  };
  const hint = tableHints[table]
    ? localize(language, tableHints[table].zh, tableHints[table].en)
    : table;
  return hint;
}

function skillPurpose(skillId: string, language: OutputLanguage): string {
  const id = skillId.toLowerCase();
  const exact: Record<string, { zh: string; en: string }> = {
    startup_analysis: {
      zh: '定位启动事件、阶段耗时和候选慢点',
      en: 'identify launch events, phase timing, and slow candidates',
    },
    startup_detail: {
      zh: '下钻单次启动的主线程、调度和阻塞细节',
      en: 'drill into one launch with main-thread, scheduling, and blocking details',
    },
    startup_slow_reasons: {
      zh: '验证启动慢的可疑原因',
      en: 'check likely causes of slow startup',
    },
    scrolling_analysis: {
      zh: '统计滑动会话、帧率、掉帧帧和卡顿分布',
      en: 'summarize scroll sessions, frame rate, jank frames, and jank distribution',
    },
    jank_frame_detail: {
      zh: '下钻单帧卡顿的执行链路和根因线索',
      en: 'drill into one janky frame and its root-cause clues',
    },
    frame_blocking_calls: {
      zh: '检查卡顿帧内与主线程/渲染线程重叠的阻塞调用',
      en: 'inspect blocking calls overlapping the UI and render threads in janky frames',
    },
    lock_binder_wait: {
      zh: '下钻主线程锁等待、Binder 等待和唤醒链证据',
      en: 'drill into main-thread lock waits, Binder waits, and waker-chain evidence',
    },
    frame_production_gap: {
      zh: '检测帧生产链路缺口，确认 UI、RenderThread 或 SF 哪一段没有产出帧',
      en: 'detect frame production gaps and localize whether UI, RenderThread, or SF missed output',
    },
    batch_frame_root_cause: {
      zh: '批量分类掉帧根因，统计各 reason_code 占比和代表帧',
      en: 'classify janky-frame root causes in bulk and summarize reason-code distribution',
    },
    process_identity_resolver: {
      zh: '确认目标进程/包名，避免查错进程',
      en: 'resolve the target process/package to avoid querying the wrong process',
    },
  };
  if (exact[id]) return localize(language, exact[id].zh, exact[id].en);

  const patternHints: Array<[RegExp, { zh: string; en: string }]> = [
    [/binder/, { zh: '分析 Binder 调用、阻塞和跨进程延迟', en: 'analyze Binder calls, blocking, and IPC latency' }],
    [/sched|cpu/, { zh: '分析 CPU 调度、Runnable 等待和大小核分配', en: 'analyze CPU scheduling, runnable waits, and core placement' }],
    [/memory|lmk|gc/, { zh: '分析内存、GC 或 LMK 压力', en: 'analyze memory, GC, or LMK pressure' }],
    [/(^|_)(io|file|database)(_|$)/, { zh: '分析 I/O、文件或数据库耗时', en: 'analyze I/O, file, or database latency' }],
    [/thermal|power|battery|wattson/, { zh: '分析温度、功耗或电池相关证据', en: 'analyze thermal, power, or battery evidence' }],
    [/frame|jank|scroll|choreographer/, { zh: '分析帧渲染和卡顿相关证据', en: 'analyze frame rendering and jank evidence' }],
  ];
  for (const [pattern, text] of patternHints) {
    if (pattern.test(id)) return localize(language, text.zh, text.en);
  }
  return localize(language, '获取结构化证据，支撑后续诊断', 'collect structured evidence for the diagnosis');
}

export function formatToolCallNarration(
  rawToolName: string,
  rawArgs: unknown,
  language: OutputLanguage = DEFAULT_OUTPUT_LANGUAGE,
  options: ToolNarrationOptions = {},
): string {
  const toolName = shortToolName(readString(rawToolName) || 'unknown');
  const args = asRecord(rawArgs);

  switch (toolName) {
    case 'submit_plan': {
      const objective = readString(args.objective);
      const phases = parseArray(args.phases);
      const summary = phaseSummary(phases);
      const detail = summary || objective;
      return shorten(detail
        ? localize(language, `制定分析计划：${detail}`, `Create analysis plan: ${detail}`)
        : localize(language, '制定分析计划：明确要收集的证据和验证顺序', 'Create analysis plan: define evidence and validation order'),
      MAX_PLAN_MESSAGE_CHARS);
    }
    case 'update_plan_phase': {
      const phaseId = readString(args.phaseId || args.id) || 'phase';
      const status = readString(args.status) || readString(args.state) || 'updated';
      const summary = readString(args.summary || args.evidence || args.evidenceSummary);
      return shorten(summary
        ? localize(language, `推进计划阶段 ${phaseId} -> ${status}：${summary}`, `Update plan phase ${phaseId} -> ${status}: ${summary}`)
        : localize(language, `推进计划阶段 ${phaseId} -> ${status}`, `Update plan phase ${phaseId} -> ${status}`));
    }
    case 'revise_plan': {
      const phases = parseArray(args.updatedPhases || args.phases);
      const summary = phaseSummary(phases);
      const reason = readString(args.reason);
      return shorten(summary || reason
        ? localize(language, `修订分析计划：${summary || reason}`, `Revise analysis plan: ${summary || reason}`)
        : localize(language, '修订分析计划：根据已发现证据调整后续步骤', 'Revise analysis plan: adjust next steps based on evidence'));
    }
    case 'invoke_skill': {
      const skillId = readString(args.skillId) || readString(args.skill) || 'unknown_skill';
      const purpose = skillPurpose(skillId, language);
      const params = paramSummary(args.params);
      const paramsText = params
        ? localize(language, `；参数：${params}`, `; params: ${params}`)
        : '';
      return shorten(localize(
        language,
        `调用 Skill ${skillId}：${purpose}${paramsText}`,
        `Run Skill ${skillId}: ${purpose}${paramsText}`,
      ));
    }
    case 'execute_sql': {
      const sql = readString(args.sql);
      const intent = sqlIntent(sql, language);
      return shorten(localize(language, `执行 SQL：${intent}`, `Run SQL: ${intent}`), MAX_SQL_MESSAGE_CHARS);
    }
    case 'execute_sql_on': {
      const trace = normalizeTraceSource(readString(args.trace) || readString(args.traceSide));
      const sql = readString(args.sql);
      const intent = sqlIntent(sql, language);
      const traceLabel = comparisonTraceLabel(trace, language, options);
      return shorten(
        localize(language, `执行对比 SQL：在${traceLabel}${intent}，验证两条 Trace 的差异`, `Run comparison SQL on the ${traceLabel}: ${intent}; verify trace differences`),
        MAX_SQL_MESSAGE_CHARS,
      );
    }
    case 'compare_skill': {
      const skillId = readString(args.skillId) || readString(args.skill) || 'unknown_skill';
      const purpose = skillPurpose(skillId, language);
      const params = paramSummary(args.params);
      const paramsText = params
        ? localize(language, `；参数：${params}`, `; params: ${params}`)
        : '';
      const currentTraceLabel = comparisonTraceLabel('current', language, options);
      const referenceTraceLabel = comparisonTraceLabel('reference', language, options);
      return shorten(localize(
        language,
        `对比 Skill ${skillId}：在 ${currentTraceLabel} 和 ${referenceTraceLabel} 上同时${purpose}${paramsText}`,
        `Compare Skill ${skillId}: ${purpose} on both ${currentTraceLabel} and ${referenceTraceLabel}${paramsText}`,
      ));
    }
    case 'get_comparison_context':
      return localize(
        language,
        '读取对比上下文：确认基线 Trace 和对比 Trace 的应用、设备和能力是否可比',
        'Read comparison context: check app, device, and capability alignment for both traces',
      );
    case 'resolve_hypothesis': {
      const status = readString(args.status) || readString(args.resolution);
      const evidence = readString(args.evidence || args.reason || args.summary);
      return shorten(evidence
        ? localize(language, `收敛假设为 ${status || 'resolved'}：${evidence}`, `Resolve hypothesis as ${status || 'resolved'}: ${evidence}`)
        : localize(language, `收敛假设为 ${status || 'resolved'}：根据已收集证据更新判断`, `Resolve hypothesis as ${status || 'resolved'}: update judgment from collected evidence`));
    }
    case 'flag_uncertainty': {
      const reason = readString(args.reason || args.description);
      return shorten(reason
        ? localize(language, `标记不确定性：${reason}`, `Flag uncertainty: ${reason}`)
        : localize(language, '标记不确定性：说明当前结论还缺哪类证据', 'Flag uncertainty: note which evidence is still missing'));
    }
    case 'fetch_artifact': {
      const artifactId = readString(args.artifactId || args.id) || '?';
      const detail = readString(args.detail || args.level) || 'rows';
      const purpose = readString(args.purpose || args.reason || args.why);
      return shorten(purpose
        ? localize(
          language,
          `读取 artifact ${artifactId} 的 ${detail} 详情：${purpose}`,
          `Fetch ${detail} details from artifact ${artifactId}: ${purpose}`,
        )
        : localize(
          language,
          `读取 artifact ${artifactId} 的 ${detail} 详情：核对前面 Skill 生成的完整证据行`,
          `Fetch ${detail} details from artifact ${artifactId}: inspect full evidence rows from a previous Skill`,
        ));
    }
    case 'list_skills':
      return localize(language, '查询可用 Skill 列表：选择合适的数据采集工具', 'List available Skills: choose an evidence collection tool');
    case 'detect_architecture':
      return localize(language, '检测渲染架构：判断后续该按哪条渲染链路分析', 'Detect rendering architecture: choose the rendering pipeline to analyze');
    case 'lookup_sql_schema': {
      const keyword = readString(args.keyword || args.table || args.query);
      return shorten(keyword
        ? localize(language, `查询 SQL 表结构：${keyword}`, `Look up SQL schema: ${keyword}`)
        : localize(language, '查询 SQL 表结构：确认字段和可用表', 'Look up SQL schema: confirm fields and available tables'));
    }
    case 'write_analysis_note': {
      const section = readString(args.section);
      return shorten(section
        ? localize(language, `记录分析笔记：${section}`, `Write analysis note: ${section}`)
        : localize(language, '记录分析笔记：保留后续结论需要的中间判断', 'Write analysis note: keep an intermediate judgment for the conclusion'));
    }
    case 'query_perfetto_source': {
      const keyword = readString(args.keyword || args.query);
      return shorten(keyword
        ? localize(language, `搜索 Perfetto 源码：${keyword}`, `Search Perfetto source: ${keyword}`)
        : localize(language, '搜索 Perfetto 源码：确认表/函数的官方语义', 'Search Perfetto source: confirm official table/function semantics'));
    }
    case 'lookup_knowledge': {
      const topic = readString(args.topic || args.query || args.keyword);
      return shorten(topic
        ? localize(language, `读取知识库：${topic}，用于校准当前诊断解释`, `Read knowledge base: ${topic} to calibrate the diagnosis`)
        : localize(language, '读取知识库：校准当前诊断解释', 'Read knowledge base: calibrate the current diagnosis'));
    }
    case 'submit_hypothesis': {
      const statement = readString(args.statement);
      return shorten(statement
        ? localize(language, `提出假设：${statement}`, `Propose hypothesis: ${statement}`)
        : localize(language, '提出假设：给出待验证的根因解释', 'Propose hypothesis: state a root cause to verify'));
    }
    case 'search_codebase': {
      const query = readString(args.query);
      return shorten(query
        ? localize(language, `搜索源码：${query}，确认 trace 现象对应的实现`, `Search source: ${query} to find the implementation behind the trace behaviour`)
        : localize(language, '搜索源码：确认 trace 现象对应的实现', 'Search source: find the implementation behind the trace behaviour'));
    }
    case 'read_codebase_file': {
      const filePath = readString(args.file_path || args.filePath);
      const startLine = readString(args.start_line || args.startLine);
      const location = filePath
        ? `${filePath}${startLine ? `:${startLine}` : ''}`
        : '';
      return shorten(location
        ? localize(language, `读取源码 ${location}：核对具体实现`, `Read source ${location}: check the actual implementation`)
        : localize(language, '读取源码：核对具体实现', 'Read source: check the actual implementation'));
    }
    case 'query_code_graph': {
      const query = readString(args.query);
      return shorten(query
        ? localize(language, `查询调用关系：${query}`, `Query the call graph: ${query}`)
        : localize(language, '查询调用关系：确认代码路径如何被触发', 'Query the call graph: see how the code path is reached'));
    }
    case 'inspect_code_symbol': {
      const symbol = readString(args.symbol);
      return shorten(symbol
        ? localize(language, `展开符号 ${symbol}：看它的定义和上下游`, `Inspect symbol ${symbol}: definition plus callers and callees`)
        : localize(language, '展开符号：看它的定义和上下游', 'Inspect symbol: definition plus callers and callees'));
    }
    case 'resolve_symbol': {
      const symbol = readString(args.symbol);
      const kind = readString(args.kind);
      const kindText = kind ? localize(language, `（${kind} 域）`, ` (${kind} domain)`) : '';
      return shorten(symbol
        ? localize(language, `解析符号 ${symbol}${kindText}：定位它在源码中的位置`, `Resolve symbol ${symbol}${kindText}: locate it in source`)
        : localize(language, '解析符号：定位它在源码中的位置', 'Resolve symbol: locate it in source'));
    }
    case 'lookup_app_source':
    case 'lookup_aosp_source':
    case 'lookup_kernel_source':
    case 'lookup_oem_sdk': {
      const query = readString(args.query || args.symbol);
      const layer = toolName === 'lookup_kernel_source'
        ? localize(language, '内核', 'kernel')
        : toolName === 'lookup_aosp_source'
          ? localize(language, 'AOSP', 'AOSP')
          : toolName === 'lookup_oem_sdk'
            ? localize(language, '厂商 SDK', 'OEM SDK')
            : localize(language, '应用', 'app');
      return shorten(query
        ? localize(language, `查阅${layer}源码：${query}，确认这段行为的实现机制`, `Look up ${layer} source: ${query} to confirm the mechanism behind this behaviour`)
        : localize(language, `查阅${layer}源码：确认这段行为的实现机制`, `Look up ${layer} source: confirm the mechanism behind this behaviour`));
    }
    case 'propose_patch': {
      const problem = readString(args.problem);
      return shorten(problem
        ? localize(language, `起草修复方案：${problem}`, `Draft a fix: ${problem}`)
        : localize(language, '起草修复方案：把根因转成可落地的改动', 'Draft a fix: turn the root cause into an actionable change'));
    }
    case 'list_codebases':
      return shorten(localize(language, '列出可用源码库：确认哪些实现可以查', 'List available codebases: see which implementations can be inspected'));
    case 'record_source_use_decision': {
      const status = readString(args.status);
      const reason = readString(args.reason);
      const detail = [status, reason].filter(Boolean).join(localize(language, '，', ', '));
      return shorten(detail
        ? localize(language, `记录源码使用结论：${detail}`, `Record source-use decision: ${detail}`)
        : localize(language, '记录源码使用结论：说明源码是否参与了本次判断', 'Record source-use decision: state whether source informed this analysis'));
    }
    case 'recall_similar_case': {
      const scene = readString(args.scene) || readString(args.cuj);
      return shorten(scene
        ? localize(language, `检索相似历史案例：${scene}，看这类问题以前怎么定位`, `Recall similar past cases: ${scene}, to see how this class of problem was diagnosed before`)
        : localize(language, '检索相似历史案例：看这类问题以前怎么定位', 'Recall similar past cases: see how this class of problem was diagnosed before'));
    }
    case 'recall_similar_result': {
      const snapshotId = readString(args.snapshot_id || args.snapshotId);
      return shorten(snapshotId
        ? localize(language, `对照历史分析结果 ${snapshotId}`, `Compare against past analysis result ${snapshotId}`)
        : localize(language, '对照历史分析结果：看同类 trace 的结论', 'Compare against past analysis results for similar traces'));
    }
    case 'recall_patterns': {
      const keywords = readString(args.keywords);
      return shorten(keywords
        ? localize(language, `回忆已知模式：${keywords}`, `Recall known patterns: ${keywords}`)
        : localize(language, '回忆已知模式：复用以前验证过的判断', 'Recall known patterns: reuse previously validated judgments'));
    }
    case 'recall_project_memory': {
      const tags = readString(args.tags) || readString(args.project_key || args.projectKey);
      return shorten(tags
        ? localize(language, `读取项目记忆：${tags}`, `Read project memory: ${tags}`)
        : localize(language, '读取项目记忆：带上这个项目已知的背景', 'Read project memory: bring in known context for this project'));
    }
    case 'lookup_baseline': {
      const baselineId = readString(args.baseline_id || args.baselineId)
        || readString(args.cuj)
        || readString(args.app_id || args.appId);
      return shorten(baselineId
        ? localize(language, `读取基线 ${baselineId}：判断当前数值是否异常`, `Read baseline ${baselineId}: decide whether the current numbers are abnormal`)
        : localize(language, '读取基线：判断当前数值是否异常', 'Read baseline: decide whether the current numbers are abnormal'));
    }
    case 'compare_baselines': {
      const base = readString(args.base_baseline_id || args.baseBaselineId);
      const candidate = readString(args.candidate_baseline_id || args.candidateBaselineId);
      return shorten(base && candidate
        ? localize(language, `对比基线 ${base} 与 ${candidate}：定位回归`, `Compare baselines ${base} and ${candidate} to locate the regression`)
        : localize(language, '对比基线：定位回归', 'Compare baselines to locate the regression'));
    }
    case 'list_stdlib_modules': {
      const namespace = readString(args.namespace);
      return shorten(namespace
        ? localize(language, `列出 stdlib 模块：${namespace}`, `List stdlib modules: ${namespace}`)
        : localize(language, '列出 stdlib 模块：确认可以直接用的官方能力', 'List stdlib modules: see which official helpers are available'));
    }
    case 'lookup_strategy_detail': {
      const scene = readString(args.scene);
      return shorten(scene
        ? localize(language, `读取 ${scene} 场景方法论：确认这类问题的标准判据`, `Read the ${scene} methodology: confirm the standard criteria for this problem class`)
        : localize(language, '读取场景方法论：确认这类问题的标准判据', 'Read the scene methodology: confirm the standard criteria for this problem class'));
    }
    case 'lookup_blog_knowledge': {
      const query = readString(args.query);
      return shorten(query
        ? localize(language, `检索外部知识：${query}`, `Search external knowledge: ${query}`)
        : localize(language, '检索外部知识：补充官方文档之外的解释', 'Search external knowledge: add context beyond the official docs'));
    }
    default:
      return shorten(localize(language, `调用工具 ${toolName}`, `Call tool ${toolName}`));
  }
}

export function looksLikeGenericToolMessage(message: string): boolean {
  const text = flatten(message).toLowerCase();
  if (!text) return true;
  return /^调用工具[:：]\s*/.test(text) ||
    /^call tool[:：]\s*/.test(text) ||
    /^调用\s+(mcp__smartperfetto__)?[a-z0-9_]+$/.test(text);
}

// =============================================================================
// Tool result narration
//
// `formatToolCallNarration` explains what a tool call is *for*. This is its
// other half: what the call actually returned. Without it every runtime fell
// back to `summarizeExternalToolResult`, which is a byte truncator rather than
// a summary, so the timeline showed truncated JSON where a sentence belongs.
//
// The input must already be projected for external surfaces. Runtimes call
// `projectToolResultForExternalSurface` before this; narrating a raw MCP result
// would leak private source and knowledge content onto the SSE stream.
// =============================================================================

export interface ToolResultNarrationInput {
  toolName: string;
  /** Arguments of the originating call. Many results do not echo their target. */
  args?: unknown;
  /** Externally projected tool result. Never the raw MCP payload. */
  result: unknown;
  /** Runtime-reported failure, independent of any `success` field in the body. */
  isError?: boolean;
  language?: OutputLanguage;
}

const MAX_RESULT_UNWRAP_DEPTH = 6;

/**
 * Parse JSON that may be wrapped in prose.
 *
 * Several MCP tools deliberately surround their JSON with guidance text — the
 * skill notes prefix and reasoning nudge around `invoke_skill`, the active
 * phase reminder appended to `fetch_artifact` rows. A whole-string parse fails
 * on those, which is why row fetches produced no timeline line while summary
 * fetches did. Scan for the first balanced object or array instead.
 */
function parseEmbeddedJson(value: string): unknown | undefined {
  const text = value.trim();
  if (!text) return undefined;

  const start = text.search(/[{[]/);
  if (start < 0) return undefined;

  const opener = text[start];
  const closer = opener === '{' ? '}' : ']';
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < text.length; i += 1) {
    const char = text[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === '\\') {
      escaped = true;
      continue;
    }
    if (char === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (char === opener) depth += 1;
    else if (char === closer) {
      depth -= 1;
      if (depth === 0) {
        try {
          return JSON.parse(text.slice(start, i + 1));
        } catch {
          return undefined;
        }
      }
    }
  }
  return undefined;
}

function unwrapContentBlocks(value: unknown): unknown {
  if (!Array.isArray(value)) return value;
  for (const entry of value) {
    const record = entry && typeof entry === 'object' ? entry as Record<string, unknown> : undefined;
    if (record && typeof record.text === 'string') return record.text;
  }
  return value;
}

/**
 * Unwrap whatever envelope this runtime happens to use so the narrator sees the
 * tool's own object.
 *
 * The four runtimes deliver the same MCP result in three different shapes: the
 * content-block array itself, that array already serialized to a string, and
 * the `{content: [...]}` envelope. Handling only one of them silently produced
 * shapeless lines like "取回 artifact art-11" with no row or column count.
 *
 * Returns `{}` when nothing parses — including a payload truncated mid-JSON,
 * which is exactly why narration has to happen where the object is intact.
 */
function readToolResultBody(result: unknown): Record<string, unknown> {
  let current: unknown = result;
  for (let depth = 0; depth < MAX_RESULT_UNWRAP_DEPTH; depth += 1) {
    if (typeof current === 'string') {
      const parsed = parseEmbeddedJson(current);
      if (parsed === undefined) return {};
      current = parsed;
      continue;
    }
    if (Array.isArray(current)) {
      const unwrapped = unwrapContentBlocks(current);
      if (unwrapped === current) {
        // A bare array is the payload, not an envelope: `list_skills` in full
        // mode returns the catalog directly. Expose it as a countable field.
        return {items: current};
      }
      current = unwrapped;
      continue;
    }
    if (current && typeof current === 'object') {
      const record = current as Record<string, unknown>;
      if (Array.isArray(record.content) || typeof record.content === 'string') {
        current = record.content;
        continue;
      }
      return record;
    }
    return {};
  }
  return {};
}

function readCount(value: unknown): number | undefined {
  const count = typeof value === 'number'
    ? value
    : Array.isArray(value)
      ? value.length
      : undefined;
  return typeof count === 'number' && Number.isFinite(count) ? count : undefined;
}

function readErrorText(body: Record<string, unknown>): string {
  return readString(body.error) || readString(body.message) || readString(body.reason);
}

function narrateToolFailure(
  toolName: string,
  body: Record<string, unknown>,
  language: OutputLanguage,
): string {
  const detail = readErrorText(body);
  return shorten(detail
    ? localize(language, `${toolName} 失败：${detail}`, `${toolName} failed: ${detail}`)
    : localize(language, `${toolName} 失败`, `${toolName} failed`));
}

/**
 * True when a tool result reports failure.
 *
 * Read this from the **raw** result, before `projectToolResultForExternalSurface`
 * runs: a sensitive tool's projection is replaced wholesale by a rejection
 * envelope that carries no `success` field, so a failed source lookup would
 * otherwise be reported as an ordinary success and vanish from the timeline.
 * The failure flag is a boolean, not content, so carrying it across the
 * projection boundary discloses nothing.
 */
export function toolResultIsFailure(input: ToolResultNarrationInput): boolean {
  if (input.isError === true) return true;
  const value = input.result;
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    if (record.isError === true) return true;
  }
  const body = readToolResultBody(value);
  return body.success === false || body.isError === true;
}

/**
 * True when a result is the system refusing the call, not the tool breaking.
 *
 * Around thirty MCP handlers answer a disallowed call with
 * `{success: false, action_required: '<what to do instead>'}` — an exhausted
 * per-phase tool budget, a plan phase closed without its expected evidence, an
 * artifact read that must fetch a summary first. Those are governance
 * decisions. `action_required` is the distinguishing field: a tool that
 * genuinely failed has no instruction to offer.
 *
 * The distinction matters because failure-rate monitoring treats them as
 * malfunctions. In a real run, one budget refusal plus two plan-phase
 * refusals were enough to trip the 60%-of-5 circuit breaker, whose remedy is
 * to tell the model to simplify its scope — the system manufacturing evidence
 * that the model is failing, then shrinking its room because of it.
 */
export function isPolicyRefusalResult(result: unknown): boolean {
  const body = readToolResultBody(result);
  if (body.success !== false && body.isError !== true) return false;
  return typeof body.action_required === 'string' && body.action_required.trim().length > 0;
}

/**
 * Tools whose whole job is to come back with hits.
 *
 * For these, how many hits is bookkeeping but *no* hits is an outcome: it is
 * the result that forces the model to look somewhere else. Enumerating the
 * tools rather than sniffing the body keeps a skill or SQL result that happens
 * to carry an empty array from being announced as a failed lookup. A coverage
 * test keeps this set in step with the registry.
 */
const RETRIEVAL_TOOLS: ReadonlySet<string> = new Set([
  'lookup_sql_schema',
  'lookup_knowledge',
  'lookup_blog_knowledge',
  'lookup_strategy_detail',
  'lookup_app_source',
  'lookup_aosp_source',
  'lookup_kernel_source',
  'lookup_oem_sdk',
  'lookup_baseline',
  'query_perfetto_source',
  'query_code_graph',
  'search_codebase',
  'inspect_code_symbol',
  'resolve_symbol',
  'recall_similar_case',
  'recall_similar_result',
  'recall_patterns',
  'recall_project_memory',
  'list_stdlib_modules',
  'list_codebases',
]);

/**
 * Hits across the field names these tools actually use. `query_code_graph`
 * answers with `references`, the source lookups with `results`, others with
 * `chunks` or `matches`; missing every one of them means we cannot tell, which
 * is not the same as zero.
 */
function retrievalHitCount(body: Record<string, unknown>): number | undefined {
  const counts = ['results', 'references', 'chunks', 'matches', 'entries', 'hits', 'items', 'skills', 'cases', 'candidates']
    .map((field) => readCount(body[field]))
    .filter((count): count is number => count !== undefined);
  return counts.length === 0 ? undefined : Math.max(...counts);
}

export function formatToolResultNarration(input: ToolResultNarrationInput): string {
  const language = input.language ?? DEFAULT_OUTPUT_LANGUAGE;
  const toolName = shortToolName(readString(input.toolName) || 'unknown');
  const args = asRecord(input.args);
  const body = readToolResultBody(input.result);

  if (input.isError === true || body.success === false) {
    return narrateToolFailure(toolName, body, language);
  }

  // Nothing parsed and no call context to fall back on.
  if (Object.keys(body).length === 0 && Object.keys(args).length === 0) return '';

  switch (toolName) {
    case 'execute_sql':
    case 'execute_sql_on': {
      // The dispatch line already said what the query is for. A row count does
      // not tell the reader whether it worked out — an empty result does, and
      // it is the case that forces the model to change approach.
      const rows = readCount(body.totalRows) ?? readCount(body.rowCount) ?? readCount(body.rows);
      return rows === 0
        ? localize(language, 'SQL 未查到匹配数据', 'SQL matched no rows')
        : '';
    }
    case 'fetch_artifact': {
      const rows = readCount(body.rows) ?? readCount(body.totalRows);
      return rows === 0
        ? localize(language, '该 artifact 没有数据行', 'That artifact has no rows')
        : '';
    }
    case 'detect_architecture': {
      // A genuine outcome: the dispatch could not know which pipeline it is.
      const type = readString(body.type);
      if (!type) return '';
      const confidence = typeof body.confidence === 'number' && Number.isFinite(body.confidence)
        ? body.confidence
        : undefined;
      const confidenceText = confidence !== undefined
        ? localize(language, `（置信度 ${confidence.toFixed(2)}）`, ` (confidence ${confidence.toFixed(2)})`)
        : '';
      return shorten(localize(
        language,
        `识别为 ${type} 渲染架构${confidenceText}`,
        `Detected ${type} rendering architecture${confidenceText}`,
      ));
    }
    case 'resolve_hypothesis': {
      // The verdict is the outcome; the dispatch only proposed it.
      const id = readString(body.hypothesisId) || readString(args.hypothesisId);
      const status = readString(body.status) || readString(args.status);
      if (!status) return '';
      const unresolved = readCount(body.unresolvedCount);
      const unresolvedText = unresolved !== undefined
        ? localize(language, `，剩余待验证 ${unresolved} 条`, `, ${unresolved} still unresolved`)
        : '';
      const idText = id ? ` ${id}` : '';
      return shorten(localize(
        language,
        `假设${idText} 收敛为 ${status}${unresolvedText}`,
        `Hypothesis${idText} resolved as ${status}${unresolvedText}`,
      ));
    }
    case 'update_plan_phase':
      // The dispatch names the phase and the target status. Only the plan
      // becoming complete is news.
      return body.allPhasesComplete === true
        ? localize(language, '全部计划阶段已完成', 'All plan phases complete')
        : '';
    case 'invoke_skill':
    case 'submit_plan':
    case 'revise_plan':
    case 'submit_hypothesis':
    case 'flag_uncertainty':
    case 'list_skills':
    case 'write_analysis_note':
    case 'record_source_use_decision':
      // These restate their own dispatch line. The skill engine reports its own
      // completion, and the `data` event lists the evidence that arrived.
      return '';
    default:
      if (RETRIEVAL_TOOLS.has(toolName)) {
        return retrievalHitCount(body) === 0
          ? localize(language, '未查到相关资料', 'No matching reference material')
          : '';
      }
      // No outcome we can state honestly. The caller drops the step rather
      // than printing a line that only repeats the call above it.
      return '';
  }
}
