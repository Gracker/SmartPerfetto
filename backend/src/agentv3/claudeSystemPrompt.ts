// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import type { ClaudeAnalysisContext, ComparisonContext, SelectionContext, SelectionTrackInfo, TraceCompleteness } from './types';
import type { SceneType } from './sceneClassifier';
import type { ArchitectureInfo } from '../agent/detectors/types';
import type { DetectedFocusApp } from './focusAppDetector';
import { formatDurationNs } from './focusAppDetector';
import { getStrategyContent, loadPromptTemplate, loadSelectionTemplate, renderTemplate } from './strategyLoader';

/**
 * Rough token estimate for mixed Chinese/English text.
 * Chinese characters are ~1.5 tokens each; English words ~1.3 tokens.
 * This approximation is sufficient for budget enforcement.
 */
function estimateTokens(text: string): number {
  let tokens = 0;
  for (const char of text) {
    // CJK characters: ~1.5 tokens each
    if (char.charCodeAt(0) > 0x2E80) {
      tokens += 1.5;
    } else {
      tokens += 0.3; // ASCII chars ~0.3 tokens average (space, punctuation, letters)
    }
  }
  return Math.ceil(tokens);
}

/** Maximum system prompt token budget. Sections are progressively dropped if exceeded. */
const MAX_PROMPT_TOKENS = 4500;

/**
 * Build architecture description section. Used by both full and quick prompts.
 * @param detailed When true, includes Compose/WebView details and loads arch-specific guidance template.
 */
function buildArchitectureSection(
  arch: ArchitectureInfo,
  packageName?: string,
  detailed = true,
): string {
  let desc = `## 当前 Trace 架构\n\n- **渲染架构**: ${arch.type} (置信度: ${(arch.confidence * 100).toFixed(0)}%)`;
  if (arch.flutter) {
    desc += `\n- **Flutter 引擎**: ${arch.flutter.engine}`;
    desc += `\n- **Flutter Surface**: ${arch.flutter.surfaceType}`;
    if (arch.flutter.surfaceType === 'SURFACEVIEW') {
      desc += ` — 单出图管线: 1.ui → 1.raster → BufferQueue → SurfaceFlinger`;
    } else if (arch.flutter.surfaceType === 'TEXTUREVIEW') {
      desc += ` — 双出图管线: 1.ui → 1.raster(光栅化) → JNISurfaceTexture(纹理桥接) → RenderThread(updateTexImage + composite)`;
    }
    if (detailed && arch.flutter.versionHint) desc += ` (${arch.flutter.versionHint})`;
    if (detailed && arch.flutter.newThreadModel) desc += ` — 新线程模型`;
  }
  if (detailed && arch.compose) {
    desc += `\n- **Compose**: recomposition=${arch.compose.hasRecomposition}, lazyLists=${arch.compose.hasLazyLists}, hybrid=${arch.compose.isHybridView}`;
  }
  if (detailed && arch.webview) {
    desc += `\n- **WebView**: ${arch.webview.engine}, surface=${arch.webview.surfaceType}`;
  }
  if (packageName) desc += `\n- **包名**: ${packageName}`;
  if (detailed) {
    const archGuidance = loadPromptTemplate('arch-' + arch.type.toLowerCase());
    if (archGuidance) desc += '\n\n' + archGuidance;
  }
  return desc;
}

/** Build focus app list section. Used by both full and quick prompts. */
function buildFocusAppSection(
  focusApps: DetectedFocusApp[],
  focusMethod?: 'battery_stats' | 'oom_adj' | 'frame_timeline' | 'none',
): string {
  const isFrameMode = focusMethod === 'frame_timeline';
  const appLines = focusApps.map((app, i) => {
    const marker = i === 0 ? ' **(主焦点)** ' : ' ';
    const countLabel = isFrameMode
      ? `${app.switchCount} 帧`
      : `切换 ${app.switchCount} 次`;
    return `- \`${app.packageName}\`${marker}— 前台时长 ${formatDurationNs(app.totalDurationNs)}，${countLabel}`;
  });
  return `## 焦点应用\n\n以下应用在 trace 期间处于前台：\n${appLines.join('\n')}\n\n默认分析第一个（主焦点）应用。调用 Skill 时，使用 process_name="${focusApps[0].packageName}" 作为参数。`;
}

/**
 * Build scene-specific strategy section based on classified scene type.
 * Strategy content is loaded from external Markdown files in `backend/strategies/`.
 * Only injects the relevant strategy, saving ~3500 tokens for non-scrolling queries.
 */
function buildSceneStrategySection(sceneType: SceneType | undefined): string {
  const content = getStrategyContent(sceneType || 'general')
    || getStrategyContent('general')
    || '';
  if (!content) return '';

  return '### 场景策略（必须严格遵循）\n\n' +
    '对于以下常见场景，已有验证过的分析流水线。**必须完整执行所有阶段**，不可跳过。\n\n---\n\n' +
    content;
}

/**
 * Build a system prompt section describing the user's current Perfetto UI selection.
 * This guides Claude to scope SQL queries and analysis to the selected region.
 */
function buildSelectionContextSection(sel: SelectionContext): string {
  if (sel.kind === 'area') {
    const template = loadSelectionTemplate('area');
    if (!template) return '';

    // Build track summary from structured data
    let trackSummary = '';
    if (sel.tracks && sel.tracks.length > 0) {
      const meaningful = sel.tracks.filter(
        (t: SelectionTrackInfo) => t.threadName || t.processName || t.cpu !== undefined,
      );
      if (meaningful.length > 0) {
        const byProcess = new Map<string, string[]>();
        const cpuTracks: number[] = [];
        for (const t of meaningful) {
          if (t.cpu !== undefined) { cpuTracks.push(t.cpu); continue; }
          const procKey = t.processName
            ? `${t.processName}(pid=${t.pid ?? '?'})`
            : '(unknown process)';
          const threadLabel = t.threadName ? `${t.threadName}(tid=${t.tid ?? '?'})` : null;
          if (!byProcess.has(procKey)) byProcess.set(procKey, []);
          if (threadLabel) byProcess.get(procKey)!.push(threadLabel);
        }
        const lines: string[] = [];
        for (const [proc, threads] of byProcess) {
          lines.push(threads.length > 0 ? `  - ${proc}: ${threads.join(', ')}` : `  - ${proc}`);
        }
        if (cpuTracks.length > 0) {
          lines.push(`  - CPU cores: ${cpuTracks.sort((a, b) => a - b).join(', ')}`);
        }
        trackSummary = `\n选中的 Track:\n${lines.join('\n')}`;
      }
    }

    return renderTemplate(template, {
      startNs: sel.startNs,
      endNs: sel.endNs,
      durationMs: sel.durationNs ? (sel.durationNs / 1e6).toFixed(2) : '未知',
      trackCount: sel.trackCount ?? '未知',
      trackSummary,
    });
  }

  if (sel.kind === 'track_event') {
    const template = loadSelectionTemplate('slice');
    if (!template) return '';

    return renderTemplate(template, {
      eventId: sel.eventId,
      ts: sel.ts,
      durationStr: sel.dur !== undefined ? `${(sel.dur / 1e6).toFixed(2)} ms` : '未知',
      sliceEnd: sel.dur !== undefined ? `${sel.ts}+${sel.dur}` : `${sel.ts}`,
    });
  }

  return '';
}

/**
 * Build the system prompt for a Claude analysis session.
 * @param context Analysis context with all injected data
 * @param maxTokens Override the default token budget (default: 4500).
 *   Use a lower value (e.g., 3000) during correction retries to leave
 *   more room for SDK conversation history after auto-compact.
 */
/**
 * Build comparison context section for dual-trace analysis.
 * Injected into system prompt when comparison mode is active (orthogonal to scene type).
 */
function buildComparisonContextSection(ctx: ComparisonContext, currentPackageName?: string): string {
  const lines: string[] = ['## 对比模式\n'];
  lines.push('你正在进行**双 Trace 对比分析**。两个 Trace 已加载，你可以同时查询两侧数据。\n');

  // Trace identity
  lines.push('### Trace 身份');
  lines.push(`- **当前 Trace**: ${currentPackageName || '未知包名'}`);
  lines.push(`- **参考 Trace**: ${ctx.referencePackageName || '未知包名'}`);

  // Package alignment warning
  if (currentPackageName && ctx.referencePackageName) {
    if (currentPackageName === ctx.referencePackageName) {
      lines.push(`- **包名对齐**: ✅ 相同 (${currentPackageName})`);
    } else {
      lines.push(`- **包名对齐**: ⚠️ 不同 — 当前=${currentPackageName}, 参考=${ctx.referencePackageName}`);
      lines.push('  - 注意：对比不同应用的 Trace 时，部分指标可能不具可比性');
    }
  }

  // Architecture comparison
  if (ctx.referenceArchitecture) {
    lines.push(`- **参考 Trace 架构**: ${ctx.referenceArchitecture.type}`);
  }

  // Capability alignment
  if (ctx.commonCapabilities.length > 0) {
    lines.push(`\n### 能力对齐`);
    lines.push(`- **共有表/视图**: ${ctx.commonCapabilities.length} 个 — 可安全对比`);
    if (ctx.capabilityDiff) {
      if (ctx.capabilityDiff.currentOnly.length > 0) {
        lines.push(`- **仅当前 Trace 有**: ${ctx.capabilityDiff.currentOnly.slice(0, 5).join(', ')}${ctx.capabilityDiff.currentOnly.length > 5 ? '...' : ''}`);
      }
      if (ctx.capabilityDiff.referenceOnly.length > 0) {
        lines.push(`- **仅参考 Trace 有**: ${ctx.capabilityDiff.referenceOnly.slice(0, 5).join(', ')}${ctx.capabilityDiff.referenceOnly.length > 5 ? '...' : ''}`);
      }
    }
  }

  // Available tools
  lines.push(`\n### 对比工具`);
  lines.push('- `compare_skill(skillId, params)` — 在两个 Trace 上并行运行同一 Skill，返回对比结果 + schema 对齐信息');
  lines.push('- `execute_sql_on(trace, sql)` — 在指定 Trace 上执行 SQL（"current" 或 "reference"）');
  lines.push('- `get_comparison_context()` — 获取两个 Trace 的元数据和能力对齐信息');
  lines.push('- 默认 `execute_sql` 和 `invoke_skill` 仍然作用于**当前 Trace**\n');

  // Analysis rules
  lines.push('### 对比分析规则');
  lines.push('1. **首先调用 `get_comparison_context()`** 确认两个 Trace 的可比性');
  lines.push('2. 数值对比必须标注**归一化方式**（绝对值 / 百分比 / 相对于总时长）');
  lines.push('3. 只在共有能力（commonCapabilities）范围内做定量对比');
  lines.push('4. 所有数据引用必须标注来源：[当前 Trace] 或 [参考 Trace]');
  lines.push('5. 结论格式：先列 delta 表（指标 | 当前值 | 参考值 | 变化），再分析根因');

  return lines.join('\n');
}

/**
 * Build a compact data completeness section for the system prompt.
 * Only reports missing/insufficient capabilities — available ones are omitted to save tokens.
 * The agent can use `lookup_knowledge("data-sources")` for detailed capture guidance.
 */
function buildCompletenessSection(completeness: TraceCompleteness): string {
  const lines: string[] = ['## Trace 数据完整度'];

  const totalProbed = completeness.available.length
    + completeness.missingConfig.length
    + completeness.notApplicable.length
    + completeness.insufficient.length;
  lines.push(`\n已探测 ${totalProbed} 项分析能力，${completeness.available.length} 项数据就绪。`);

  // Only report actionable items (missing config + insufficient)
  if (completeness.missingConfig.length > 0) {
    lines.push('\n### 数据缺失（可能需要调整 Trace 配置）');
    for (const cap of completeness.missingConfig) {
      lines.push(`- **${cap.displayName}** (${cap.id}): ${cap.reason}`);
    }
    lines.push('\n> 使用 `lookup_knowledge("data-sources")` 获取各项的详细采集配置指南。');
  }

  if (completeness.insufficient.length > 0) {
    lines.push('\n### 数据不足（可能 trace 时长不够或场景未发生）');
    for (const cap of completeness.insufficient) {
      lines.push(`- **${cap.displayName}**: ${cap.reason}`);
    }
  }

  // Only include the section if there are actionable items
  if (completeness.missingConfig.length === 0 && completeness.insufficient.length === 0) {
    return '';
  }

  lines.push('\n### 输出要求');
  lines.push('当分析结论涉及缺失数据的能力时，在结论末尾添加**「数据采集建议」**小节，为用户列出具体的 Perfetto 配置调整建议。');

  return lines.join('\n');
}

export function buildSystemPrompt(context: ClaudeAnalysisContext, maxTokens?: number): string {
  const effectiveMaxTokens = maxTokens ?? MAX_PROMPT_TOKENS;
  const sections: string[] = [];

  // ── Section ordering rationale ───────────────────────────────────────────
  // Anthropic API auto-caches system prompts >1024 tokens via prefix matching.
  // Sections are ordered STATIC → PER-TRACE → PER-QUERY → DYNAMIC so that
  // the stable prefix is as long as possible across multi-turn conversations:
  //   Same trace + same scene: ~4000 tokens cached (~80% savings)
  //   Same trace + different scene: ~800 tokens cached (~18% savings)
  //   Different trace: ~400 tokens cached (~8% savings)
  // ─────────────────────────────────────────────────────────────────────────

  // ── Tier 1: STATIC (never changes within process lifetime) ──

  const roleContent = loadPromptTemplate('prompt-role');
  sections.push(roleContent ?? '# 角色\n\n你是 SmartPerfetto 的 Android 性能分析专家。');

  const outputFormat = loadPromptTemplate('prompt-output-format');
  if (outputFormat) sections.push(outputFormat);

  // ── Tier 2: PER-TRACE STABLE (changes between traces, stable within a trace) ──

  if (context.architecture) {
    sections.push(buildArchitectureSection(context.architecture, context.packageName, true));
  } else if (context.packageName) {
    sections.push(`## 当前 Trace 信息\n\n- **包名**: ${context.packageName}\n- **架构**: 未检测（建议先调用 detect_architecture）`);
  }

  if (context.focusApps && context.focusApps.length > 0) {
    sections.push(buildFocusAppSection(context.focusApps, context.focusMethod));
  }

  // Trace data completeness (stable per trace — important for analysis scoping)
  if (context.traceCompleteness) {
    const completenessSection = buildCompletenessSection(context.traceCompleteness);
    if (completenessSection) sections.push(completenessSection);
  }

  if (context.knowledgeBaseContext) {
    sections.push(`## Perfetto SQL 知识库参考

${context.knowledgeBaseContext}
> 以上是根据用户问题从官方 Perfetto SQL stdlib 索引中匹配到的相关表/视图/函数。写 execute_sql 查询时可参考这些定义。`);
  }

  // ── Tier 3: PER-QUERY (changes when scene/query changes) ──

  // Scene-specific strategy injection (progressive disclosure)
  const sceneStrategy = buildSceneStrategySection(context.sceneType);

  const methodologyTemplate = loadPromptTemplate('prompt-methodology');
  sections.push(methodologyTemplate
    ? renderTemplate(methodologyTemplate, { sceneStrategy })
    : `## 分析方法论\n\n${sceneStrategy}`);

  // Sub-agent collaboration guidance (only when sub-agents are enabled)
  if (context.availableAgents && context.availableAgents.length > 0) {
    const hasSystemExpert = context.availableAgents.includes('system-expert');
    const isScrolling = context.sceneType === 'scrolling';

    let parallelGuidance = '';
    if (isScrolling && hasSystemExpert) {
      parallelGuidance = `
### 滑动场景并行证据收集
滑动分析时，你应该**并行**收集帧渲染证据和系统上下文：
- **你（编排者）直接执行** Phase 1：\`invoke_skill("scrolling_analysis", ...)\` 获取帧列表和根因分类
- **同时委托 system-expert**：收集 CPU 频率/调度、热降频、内存压力等系统上下文
  - 委托时告诉它时间范围和包名，让它调用 cpu_analysis, thermal_throttling, memory_analysis
- Phase 1 完成后，结合 system-expert 的系统证据 + scrolling_analysis 的帧根因分类，选择代表帧做 Phase 2 深钻
- 这样可以节省 2-3 轮往返，同时让结论更有系统上下文支撑`;
    }

    sections.push(`## 子代理协作

可用子代理：${context.availableAgents.map(a => `\`${a}\``).join('、')}

### 何时委托 vs 直接调用
- **委托**：需要从 ≥2 个不同域并行收集证据时（如帧分析 + CPU/内存系统上下文）
- **直接调用**：单域查询（1-2 个工具调用即可完成）直接自己调用，不委托
- **绝不委托**的情况：只需 1 个 invoke_skill 或 1 条 SQL；已经持有该域数据；ANR 场景（2-skill pipeline）

### 委托规则
1. **子代理只收集证据**，最终诊断和结论由你做出
2. **委托时必须告知**：时间范围（start_ts/end_ts）、目标包名（process_name）、具体收集目标
3. **不要重复收集**：你已调用的 Skill，不再委托子代理调用
4. **子代理返回空或失败**：忽略该证据，基于已有数据继续分析，不要卡住
${parallelGuidance}`);
  }

  // ── Tier 4: PER-INTERACTION DYNAMIC (changes every query) ──

  // User selection context — scopes analysis to a specific time range or slice.
  // Intentionally NOT in droppableSections: selection is user's explicit intent and must never be dropped.
  if (context.selectionContext) {
    sections.push(buildSelectionContextSection(context.selectionContext));
  }

  // Comparison mode context — orthogonal to scene type, injected when referenceTraceId is present
  if (context.comparison) {
    sections.push(buildComparisonContextSection(context.comparison, context.packageName));

    // Load comparison methodology template (additive to scene strategy)
    const compMethodology = loadPromptTemplate('comparison-methodology');
    if (compMethodology) {
      sections.push(compMethodology);
    }
  }

  const hasConversationContext = (context.previousFindings && context.previousFindings.length > 0)
    || context.entityContext
    || context.conversationSummary
    || (context.analysisNotes && context.analysisNotes.length > 0);

  if (hasConversationContext) {
    const contextParts: string[] = ['## 对话上下文'];

    if (context.analysisNotes && context.analysisNotes.length > 0) {
      const sectionLabels: Record<string, string> = {
        hypothesis: '假设', finding: '发现', observation: '观察', next_step: '下一步',
      };
      // P1-3: Limit injected notes to 10 (sorted by priority) to cap token usage at ~650 tokens.
      // Full 20 notes would consume ~1300 tokens, crowding the 4500-token budget.
      const sortedNotes = [...context.analysisNotes]
        .sort((a, b) => (a.priority === 'high' ? 0 : 1) - (b.priority === 'high' ? 0 : 1))
        .slice(0, 10);
      const noteLines = sortedNotes
        .map(n => `- [${sectionLabels[n.section] || n.section}] ${n.priority === 'high' ? '⚠️ ' : ''}${n.content}`)
        .join('\n');
      const omitted = context.analysisNotes.length - sortedNotes.length;
      contextParts.push(`### 分析笔记${omitted > 0 ? ` (显示 ${sortedNotes.length}/${context.analysisNotes.length})` : ''}
${noteLines}

以上是你之前记录的分析笔记。利用这些笔记继续分析，避免重复工作。`);
    }

    if (context.previousFindings && context.previousFindings.length > 0) {
      const findingSummary = context.previousFindings
        .slice(0, 10)
        .map(f => `- [${f.severity.toUpperCase()}] ${f.title}: ${f.description.substring(0, 100)}`)
        .join('\n');
      contextParts.push(`### 之前的分析发现
${findingSummary}

用户的新问题可能引用上面的发现。在之前结果的基础上继续深入分析，避免重复已知结论。`);
    }

    if (context.entityContext) {
      contextParts.push(`### 已知实体（可用于 drill-down 引用）
${context.entityContext}`);
    }

    if (context.conversationSummary) {
      contextParts.push(`### 对话摘要
${context.conversationSummary}`);
    }

    sections.push(contextParts.join('\n\n'));
  }

  // Skill catalog removed from system prompt — Claude can use `list_skills` tool on demand.
  // This saves ~2000 tokens for general queries. Scene-specific strategies already name
  // the relevant skills directly.

  if (context.sqlErrorFixPairs && context.sqlErrorFixPairs.length > 0) {
    // Whole section is droppable under token pressure (see L477), so the cap
    // can be generous in normal operation.
    const pairLines = context.sqlErrorFixPairs.slice(0, 10).map((p, i) =>
      `${i + 1}. ERROR: \`${p.errorMessage.substring(0, 100)}\`\n   BAD: \`${p.errorSql.substring(0, 150)}\`\n   FIX: \`${p.fixedSql.substring(0, 150)}\``
    ).join('\n');
    sections.push(`## SQL 踩坑记录（避免重复犯错）\n\n${pairLines}`);
  }

  // P2-2: Cross-session analysis pattern memory
  if (context.patternContext) {
    sections.push(context.patternContext);
  }

  // P1: Cross-session negative pattern memory (what failed before)
  if (context.negativePatternContext) {
    sections.push(context.negativePatternContext);
  }

  // P1-B1: Recent plan history for deeper cross-turn context (up to 3 plans)
  const allPlans: Array<{ plan: typeof context.previousPlan; label: string }> = [];
  if (context.planHistory) {
    context.planHistory.forEach((p, i) => allPlans.push({ plan: p, label: `第 ${i + 1} 轮` }));
  }
  if (context.previousPlan) {
    allPlans.push({ plan: context.previousPlan, label: '上一轮' });
  }
  if (allPlans.length > 0) {
    const plansSummary = allPlans.map(({ plan, label }) => {
      const phasesSummary = plan!.phases.map(p => {
        const statusLabel = p.status === 'completed' ? '✓' : p.status === 'skipped' ? '⊘' : '○';
        const summary = p.summary ? ` — ${p.summary}` : '';
        return `    ${statusLabel} ${p.name}${summary}`;
      }).join('\n');
      return `### ${label}分析计划\n${phasesSummary}\n  成功标准: ${plan!.successCriteria}`;
    }).join('\n\n');
    sections.push(`## 历史分析计划

以下是近几轮对话的分析计划，供参考以避免重复分析：

${plansSummary}

> 你可以在新计划中引用之前的发现，或对未完成的阶段进行补充分析。也可以使用 \`recall_patterns\` 查询跨会话的历史分析经验。`);
  }

  // P1-2: Enforce token budget by progressively dropping low-priority sections.
  // Drop order: knowledge base (Claude can use lookup_sql_schema) → SQL error pairs →
  // sub-agent guidance → conversation summary subsection
  let prompt = sections.join('\n\n');
  let tokens = estimateTokens(prompt);

  if (tokens > effectiveMaxTokens) {
    // Drop full sections by their opening text marker (lowest value first)
    const droppableSections = [
      '## Perfetto SQL 知识库参考',  // Claude can use lookup_sql_schema tool instead
      '## Trace 数据完整度',          // Helpful guidance but agent can still detect gaps at runtime
      '## 历史分析经验',              // Pattern memory — helpful but not critical
      '## 历史踩坑记录',              // Negative memory — important but droppable under pressure
      '## SQL 踩坑记录',              // Nice-to-have, not critical
      '## 子代理协作',                 // Only useful when sub-agents enabled
      '## 历史分析计划',              // P2-3: Plan history is supplementary context, droppable under pressure
    ];
    for (const marker of droppableSections) {
      if (tokens <= effectiveMaxTokens) break;
      const idx = sections.findIndex(s => s.startsWith(marker));
      if (idx >= 0) {
        sections.splice(idx, 1);
        prompt = sections.join('\n\n');
        tokens = estimateTokens(prompt);
      }
    }
    if (tokens > effectiveMaxTokens) {
      console.warn(`[SystemPrompt] Prompt exceeds budget after trimming: ~${tokens} tokens (budget: ${effectiveMaxTokens})`);
    }
  }

  return prompt;
}

/**
 * Build a minimal system prompt for quick (factual) queries.
 * Loads the prompt-quick template and injects architecture + focus app context.
 * Target: ~1500 tokens — much smaller than the full 4500-token prompt.
 */
export function buildQuickSystemPrompt(opts: {
  architecture?: ArchitectureInfo;
  packageName?: string;
  focusApps?: DetectedFocusApp[];
  focusMethod?: 'battery_stats' | 'oom_adj' | 'frame_timeline' | 'none';
}): string {
  const template = loadPromptTemplate('prompt-quick');
  if (!template) {
    return '你是 Android 性能 trace 分析专家。请简洁直接地回答用户的问题。';
  }

  const architectureContext = opts.architecture
    ? buildArchitectureSection(opts.architecture, opts.packageName, false)
    : opts.packageName ? `## 当前 Trace 信息\n\n- **包名**: ${opts.packageName}` : '';

  const focusAppContext = opts.focusApps && opts.focusApps.length > 0
    ? buildFocusAppSection(opts.focusApps, opts.focusMethod)
    : '';

  return renderTemplate(template, { architectureContext, focusAppContext });
}