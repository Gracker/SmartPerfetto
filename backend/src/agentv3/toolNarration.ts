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
