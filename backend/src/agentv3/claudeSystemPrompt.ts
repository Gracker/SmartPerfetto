// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import type {
  ClaudeAnalysisContext,
  ComparisonContext,
  SelectionContext,
  SelectionTrackInfo,
  TraceCompleteness,
  TracePaneSide,
  TraceSource,
} from './types';
import type { SceneType } from './sceneClassifier';
import type { ArchitectureInfo } from '../agent/detectors/types';
import type { DetectedFocusApp } from './focusAppDetector';
import { formatDurationNs } from './focusAppDetector';
import {
  buildPlanTemplateTriggerContext,
  resolveActiveConditionalPlanRequirements,
} from './scenePlanTemplates';
import {
  getFinalReportContract,
  getStrategyContent,
  loadPromptTemplate,
  loadSelectionTemplate,
  renderTemplate,
} from './strategyLoader';
import {loadCodeReferenceContractPrompt} from '../services/codebase/codeReferenceContract';
import {loadSourceUseDecisionPrompt} from '../services/codebase/sourceUseDecision';
import { DEFAULT_OUTPUT_LANGUAGE, localize, type OutputLanguage } from './outputLanguage';
import {
  QUICK_TRIAGE_MAX_CHINESE_CHARS,
  QUICK_TRIAGE_MAX_CLAIMS,
  QUICK_TRIAGE_MAX_FACT_BULLETS,
} from './quickAnswerContract';

/**
 * Rough token estimate for mixed Chinese/English text.
 * Chinese characters are ~1.5 tokens each; English words ~1.3 tokens.
 * This approximation is sufficient for budget enforcement.
 */
export function estimatePromptTokens(text: string): number {
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

/** M2 hard gate: full-mode system prompt target after core/detail split. */
export const MAX_PROMPT_TOKENS = 12_000;
/** M2 hard gate: always-injected scene strategy core budget. */
export const MAX_SCENE_CORE_TOKENS = 4_000;
/**
 * Budget for the non-droppable architecture plan-requirement section. It is
 * paid on every full-mode run of an affected scene, so it has to stay small
 * enough not to evict the droppable context sections.
 *
 * Sized against the widest real branch set — Flutter TextureView activates two
 * required skills — with calls rendered in their literal `expectedCalls` shape.
 * The shorthand form is cheaper but induces `skillId` on tools that reject it,
 * which costs a whole plan round trip.
 */
export const MAX_PLAN_ARCHITECTURE_REQUIREMENT_TOKENS = 240;

function buildOutputLanguageSection(language: OutputLanguage): string {
  const templateName = language === 'en' ? 'prompt-language-en' : 'prompt-language-zh';
  return loadPromptTemplate(templateName)
    ?? loadPromptTemplate('prompt-language-zh')
    ?? '';
}

function formatSelectionSource(sel: SelectionContext): string {
  if (sel.kind === 'track_event') return 'Perfetto slice selection';
  if (sel.source === 'visible_window') return 'current visible timeline window';
  return 'Perfetto area/time-range selection';
}

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
  const scoped = focusApps.some(app => app.scopeStartNs !== undefined && app.scopeEndNs !== undefined);
  const scopeText = scoped ? '当前选区/范围内' : 'trace 期间';
  const appLines = focusApps.map((app, i) => {
    const marker = i === 0 ? ' **(主焦点)** ' : ' ';
    const countLabel = isFrameMode
      ? `${app.switchCount} 帧`
      : `切换 ${app.switchCount} 次`;
    const scopeRef = app.scopeStartNs !== undefined && app.scopeEndNs !== undefined
      ? `；scope_start_ns=${app.scopeStartNs}，scope_end_ns=${app.scopeEndNs}`
      : '';
    const evidenceRef = app.evidenceRefId
      ? `；source_ref=\`Runtime focus app detection\`，evidence_ref_id=\`${app.evidenceRefId}\`，row_index=${app.evidenceRowIndex ?? i}，columns=package_name/foreground_duration_ns/foreground_count${scopeRef}`
      : '';
    return `- \`${app.packageName}\`${marker}— 前台时长 ${formatDurationNs(app.totalDurationNs)}，${countLabel}${evidenceRef}`;
  });
  return `## 焦点应用\n\n以下应用在${scopeText}处于前台：\n${appLines.join('\n')}\n\n默认分析第一个（主焦点）应用。调用 Skill 时，使用 process_name="${focusApps[0].packageName}" 作为参数；系统会在进程级 Skill 执行前自动做身份准入和参数重写。如果准入返回 ambiguous/blocked，先查看候选进程或澄清目标，不要继续基于未验证包名下结论。`;
}

interface SceneStrategySections {
  core: string;
  reportContract: string;
}

function buildFinalReportContractSection(sceneType: SceneType | undefined): string {
  const contract = getFinalReportContract(sceneType || 'general');
  if (!contract || contract.requiredSections.length === 0) return '';

  return '### Final Report Contract（最终报告必检项）\n\n' +
    '最终报告必须满足以下场景交付结构；标注条件触发的项目只在用户问题涉及对应证据面时校验：\n' +
    contract.requiredSections
      .filter(requirement => requirement.required !== false)
      .map((requirement, index) => {
        const description = requirement.description ? `：${requirement.description}` : '';
        const triggerNote = requirement.triggerPatterns.length > 0 ? '（条件触发）' : '';
        return `${index + 1}. ${requirement.label}${triggerNote}${description}`;
      })
      .join('\n');
}

function buildSceneStrategySections(sceneType: SceneType | undefined): SceneStrategySections {
  const content = getStrategyContent(sceneType || 'general')
    || getStrategyContent('general')
    || '';

  const core = content
    ? '### 场景策略（必须严格遵循）\n\n' +
    '---\n\n' +
    content
    : '';

  return {
    core,
    reportContract: buildFinalReportContractSection(sceneType),
  };
}

/**
 * Build a system prompt section describing the user's current Perfetto UI selection.
 * This guides Claude to scope SQL queries and analysis to the selected region.
 */
export function buildSelectionContextSection(sel: SelectionContext): string {
  if (sel.kind === 'area') {
    const template = loadSelectionTemplate('area');
    if (!template) return '';

    // Track tags are selection identity only. Descriptive facts must come from
    // backend-owned trace queries before they are used as evidence.
    let trackSummary = '';
    if (sel.tracks && sel.tracks.length > 0) {
      const maxTrackIdentities = 16;
      const lines = sel.tracks
        .slice(0, maxTrackIdentities)
        .map((track: SelectionTrackInfo) => {
          const tags = [
            ...(track.utid !== undefined ? [`utid=${track.utid}`] : []),
            ...(track.upid !== undefined ? [`upid=${track.upid}`] : []),
            ...(track.cpu !== undefined ? [`cpu=${track.cpu}`] : []),
          ];
          return tags.length > 0 ? tags.join(',') : `uri=${track.uri}`;
        });
      if (sel.tracks.length > maxTrackIdentities) {
        lines.push(`+${sel.tracks.length - maxTrackIdentities} omitted`);
      }
      trackSummary = `\nTrack scope IDs: ${lines.join('; ')}`;
    }

    return renderTemplate(template, {
      startNs: sel.startNs,
      endNs: sel.endNs,
      durationMs: sel.durationNs ? (sel.durationNs / 1e6).toFixed(2) : '未知',
      trackCount: sel.trackCount ?? '未知',
      trackSummary,
      sourceLabel: formatSelectionSource(sel),
    });
  }

  if (sel.kind === 'track_event') {
    const template = loadSelectionTemplate('slice');
    if (!template) return '';

    return renderTemplate(template, {
      eventId: sel.eventId,
      trackUri: sel.trackUri ?? '未知',
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
function buildComparisonContextSection(
  ctx: ComparisonContext,
  currentPackageName: string | undefined,
  outputLanguage: OutputLanguage,
): string {
  const template = loadPromptTemplate(
    outputLanguage === 'en' ? 'comparison-context-en' : 'comparison-context',
  );
  const currentTraceLabel = comparisonTraceDisplayLabel(ctx, 'current', outputLanguage);
  const referenceTraceLabel = comparisonTraceDisplayLabel(ctx, 'reference', outputLanguage);
  const vars = {
    currentTraceLabel,
    referenceTraceLabel,
    currentPackageName: currentPackageName || localize(outputLanguage, '未知包名', 'unknown package'),
    referencePackageName: ctx.referencePackageName || localize(outputLanguage, '未知包名', 'unknown package'),
    tracePairMapping: buildTracePairMappingSection(ctx, outputLanguage),
    packageAlignment: buildPackageAlignmentSection(ctx, currentPackageName, outputLanguage),
    referenceArchitecture: buildReferenceArchitectureSection(ctx, outputLanguage),
    capabilityAlignment: buildCapabilityAlignmentSection(ctx, outputLanguage),
  };
  return template ? renderTemplate(template, vars) : '';
}

function comparisonTraceDisplayLabel(
  ctx: ComparisonContext,
  traceSide: TraceSource,
  outputLanguage: OutputLanguage,
): string {
  const pane = ctx.tracePairContext?.panes.find(item => item.traceSide === traceSide);
  const role = traceSide === 'current'
    ? localize(outputLanguage, '基线 Trace', 'Baseline trace')
    : localize(outputLanguage, '对比 Trace', 'Comparison trace');
  return pane ? `${tracePaneSideLabel(pane.side, outputLanguage)}/${role}` : role;
}

function buildTracePairMappingSection(
  ctx: ComparisonContext,
  outputLanguage: OutputLanguage,
): string {
  const pair = ctx.tracePairContext;
  if (!pair) return '';
  const lines = [
    localize(outputLanguage, '### 窗口映射', '### Pane mapping'),
    localize(
      outputLanguage,
      `- 布局: ${pair.layout === 'vertical' ? '上下' : '左右'}`,
      `- Layout: ${pair.layout === 'vertical' ? 'top/bottom' : 'left/right'}`,
    ),
  ];
  if (pair.workspaceOpen !== undefined) {
    lines.push(localize(
      outputLanguage,
      `- 同页双窗: ${pair.workspaceOpen ? '已打开' : '未打开'}`,
      `- Same-page dual panes: ${pair.workspaceOpen ? 'open' : 'not open'}`,
    ));
  }
  if (pair.splitPercent !== undefined) {
    lines.push(localize(
      outputLanguage,
      `- 分割比例: 基线窗口 ${pair.splitPercent}%`,
      `- Split ratio: baseline pane ${pair.splitPercent}%`,
    ));
  }
  if (pair.maximizedTraceSide) {
    lines.push(localize(
      outputLanguage,
      `- 最大化: ${pair.maximizedTraceSide === 'current' ? '基线 Trace' : '对比 Trace'}`,
      `- Maximized: ${pair.maximizedTraceSide === 'current' ? 'baseline trace' : 'comparison trace'}`,
    ));
  }
  if (pair.minimizedTraceSides && pair.minimizedTraceSides.length > 0) {
    const minimized = pair.minimizedTraceSides
      .map(traceSide => traceSide === 'current'
        ? localize(outputLanguage, '基线 Trace', 'baseline trace')
        : localize(outputLanguage, '对比 Trace', 'comparison trace'))
      .join(localize(outputLanguage, '、', ', '));
    lines.push(localize(outputLanguage, `- 最小化: ${minimized}`, `- Minimized: ${minimized}`));
  }
  for (const pane of pair.panes) {
    const role = pane.traceSide === 'current'
      ? localize(outputLanguage, '基线 Trace', 'Baseline trace')
      : localize(outputLanguage, '对比 Trace', 'Comparison trace');
    const active = pane.active ? localize(outputLanguage, '，当前焦点', ', active') : '';
    const visualState = pane.visualState === 'context_only'
      ? localize(outputLanguage, '，后端上下文', ', backend context')
      : localize(outputLanguage, '，可视窗口', ', visible pane');
    lines.push(`- ${tracePaneSideLabel(pane.side, outputLanguage)}: ${role}${pane.traceName ? ` (${pane.traceName})` : ''}${active}${visualState}`);
  }
  if (pair.aliases) {
    const currentAliases = Object.entries(pair.aliases)
      .filter(([, traceSide]) => traceSide === 'current')
      .map(([alias]) => alias)
      .slice(0, 8);
    const referenceAliases = Object.entries(pair.aliases)
      .filter(([, traceSide]) => traceSide === 'reference')
      .map(([alias]) => alias)
      .slice(0, 8);
    if (currentAliases.length > 0 || referenceAliases.length > 0) {
      lines.push(localize(
        outputLanguage,
        `- 指代别名: 基线 Trace=${currentAliases.join('/') || '无'}；对比 Trace=${referenceAliases.join('/') || '无'}`,
        `- Trace aliases: baseline=${currentAliases.join('/') || 'none'}; comparison=${referenceAliases.join('/') || 'none'}`,
      ));
    }
  }
  return `\n\n${lines.join('\n')}`;
}

function buildPackageAlignmentSection(
  ctx: ComparisonContext,
  currentPackageName: string | undefined,
  outputLanguage: OutputLanguage,
): string {
  if (!currentPackageName || !ctx.referencePackageName) return '';
  if (currentPackageName === ctx.referencePackageName) {
    return localize(
      outputLanguage,
      `\n- **包名对齐**: 相同 (${currentPackageName})`,
      `\n- **Package alignment**: same (${currentPackageName})`,
    );
  }
  const zh = [
    `\n- **包名对齐**: 不同，当前=${currentPackageName}, 参考=${ctx.referencePackageName}`,
    '- 注意：对比不同应用的 Trace 时，部分指标可能不具可比性',
  ].join('\n');
  const en = [
    `\n- **Package alignment**: different, current=${currentPackageName}, reference=${ctx.referencePackageName}`,
    '- Caution: some metrics are not comparable across traces from different applications',
  ].join('\n');
  return localize(outputLanguage, zh, en);
}

function buildReferenceArchitectureSection(
  ctx: ComparisonContext,
  outputLanguage: OutputLanguage,
): string {
  return ctx.referenceArchitecture
    ? localize(
        outputLanguage,
        `\n- **参考 Trace 架构**: ${ctx.referenceArchitecture.type}`,
        `\n- **Reference trace architecture**: ${ctx.referenceArchitecture.type}`,
      )
    : '';
}

function buildCapabilityAlignmentSection(
  ctx: ComparisonContext,
  outputLanguage: OutputLanguage,
): string {
  if (ctx.commonCapabilities.length === 0 && !ctx.capabilityDiff) return '';
  const lines = [
    '',
    localize(outputLanguage, '### 能力对齐', '### Capability alignment'),
    ctx.commonCapabilities.length > 0
      ? localize(
          outputLanguage,
          `- **共有表/视图**: ${ctx.commonCapabilities.length} 个，可安全对比`,
          `- **Shared tables/views**: ${ctx.commonCapabilities.length}; safe to compare`,
        )
      : localize(
          outputLanguage,
          '- **共有表/视图**: 0 个，不可直接对比',
          '- **Shared tables/views**: 0; do not compare directly',
        ),
  ];
  if (ctx.capabilityDiff) {
    if (ctx.capabilityDiff.currentOnly.length > 0) {
      lines.push(localize(
        outputLanguage,
        `- **仅当前 Trace 有**: ${summarizeCapabilityList(ctx.capabilityDiff.currentOnly)}`,
        `- **Current trace only**: ${summarizeCapabilityList(ctx.capabilityDiff.currentOnly)}`,
      ));
    }
    if (ctx.capabilityDiff.referenceOnly.length > 0) {
      lines.push(localize(
        outputLanguage,
        `- **仅参考 Trace 有**: ${summarizeCapabilityList(ctx.capabilityDiff.referenceOnly)}`,
        `- **Reference trace only**: ${summarizeCapabilityList(ctx.capabilityDiff.referenceOnly)}`,
      ));
    }
  }
  return lines.join('\n');
}

function summarizeCapabilityList(capabilities: string[]): string {
  const visible = capabilities.slice(0, 5).join(', ');
  return capabilities.length > 5 ? `${visible}...` : visible;
}


function tracePaneSideLabel(side: TracePaneSide, outputLanguage: OutputLanguage): string {
  switch (side) {
    case 'left':
      return localize(outputLanguage, '左侧', 'Left');
    case 'right':
      return localize(outputLanguage, '右侧', 'Right');
    case 'top':
      return localize(outputLanguage, '上方', 'Top');
    case 'bottom':
      return localize(outputLanguage, '下方', 'Bottom');
  }
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

/**
 * Tier classification for cache-aware prompt assembly:
 *   1 — STATIC: never changes within process lifetime (role, output format)
 *   2 — PER-TRACE: stable for the lifetime of one trace (architecture,
 *       focus apps, completeness, knowledge base reference)
 *   3 — PER-QUERY: stable while the same scene is analysed (methodology,
 *       sub-agent guidance)
 *   4 — PER-INTERACTION: dynamic, changes every query (selection,
 *       comparison, conversation context, history, plan history)
 */
export type PromptTier = 1 | 2 | 3 | 4;

export interface PromptSegment {
  tier: PromptTier;
  /** Stable identifier for tests + logging (e.g. "role", "architecture"). */
  label: string;
  content: string;
  /** Whether the section may be dropped under token pressure. */
  droppable: boolean;
  /** Whether the section may be shortened under token pressure. */
  truncatable?: boolean;
  /** Character count after budget enforcement. */
  charCount: number;
  /** Rough token count after budget enforcement. */
  estimatedTokens: number;
  /** Character count before truncation, when truncation happened. */
  originalCharCount?: number;
  /** Rough token count before truncation, when truncation happened. */
  originalEstimatedTokens?: number;
  /** True when this segment was shortened to satisfy the prompt budget. */
  truncated?: boolean;
}

export interface SystemPromptParts {
  /** Joined Tier 1+2+3 — the cache-friendly prefix. */
  stablePrefix: string;
  /** Joined Tier 4 — varies every query. */
  volatileSuffix: string;
  /** Final string (`stablePrefix + '\n\n' + volatileSuffix` when both non-empty). */
  fullPrompt: string;
  /** Section-level breakdown after budget enforcement. */
  segments: PromptSegment[];
  /** Labels of sections dropped to fit the token budget. */
  droppedLabels: string[];
  /** Labels of sections truncated to fit the token budget. */
  truncatedLabels: string[];
}

function joinSegments(segments: PromptSegment[], tierFilter?: (segment: PromptSegment) => boolean): string {
  return segments
    .filter(segment => segment.content.length > 0)
    .filter(segment => tierFilter ? tierFilter(segment) : true)
    .map(segment => segment.content)
    .join('\n\n');
}

function joinSegmentsWithReplacement(
  segments: PromptSegment[],
  replacementIndex: number,
  replacementContent: string,
): string {
  return segments
    .map((segment, index) => index === replacementIndex ? replacementContent : segment.content)
    .filter(content => content.length > 0)
    .join('\n\n');
}

/**
 * Index of `placeholder` in the template body, ignoring occurrences inside HTML
 * comments.
 *
 * Template headers document their variables in a comment block, so the literal
 * placeholder usually appears there first. Splitting on that occurrence injects
 * the scene core *inside* the comment and pushes the methodology preamble after
 * it — the exact inversion this helper exists to prevent.
 */
function findPlaceholderOutsideComments(template: string, placeholder: string): number {
  let searchFrom = 0;
  for (;;) {
    const index = template.indexOf(placeholder, searchFrom);
    if (index < 0) return -1;
    const commentOpen = template.lastIndexOf('<!--', index);
    if (commentOpen < 0) return index;
    const commentClose = template.indexOf('-->', commentOpen);
    if (commentClose > index) {
      // Inside a closed comment: resume searching after it.
      searchFrom = commentClose + '-->'.length;
      continue;
    }
    // An unterminated comment swallows the rest of the template.
    if (commentClose < 0) return -1;
    return index;
  }
}

export function splitMethodologyTemplate(template: string): { beforeSceneStrategy: string; afterSceneStrategy: string } {
  const placeholder = '{{sceneStrategy}}';
  const placeholderIndex = findPlaceholderOutsideComments(template, placeholder);
  if (placeholderIndex < 0) {
    return { beforeSceneStrategy: template.trim(), afterSceneStrategy: '' };
  }
  return {
    beforeSceneStrategy: template.slice(0, placeholderIndex).trim(),
    afterSceneStrategy: template.slice(placeholderIndex + placeholder.length).trim(),
  };
}

function nearestMarkdownBoundary(text: string): string {
  const minBoundary = Math.min(800, Math.floor(text.length * 0.25));
  const boundaries = [
    text.lastIndexOf('\n### '),
    text.lastIndexOf('\n#### '),
    text.lastIndexOf('\n\n'),
  ].filter(index => index > minBoundary);
  if (boundaries.length === 0) return text.trimEnd();
  return text.slice(0, Math.max(...boundaries)).trimEnd();
}

export interface SystemPromptBuildOptions {
  /**
   * Enabled by default in M2 after strategy core/detail split. Tests can turn
   * it off to inspect raw strategy-core size.
   */
  truncateSceneCore?: boolean;
}

/**
 * Build the assembled prompt + structured segment metadata.
 * `buildSystemPrompt()` is now a thin wrapper around this.
 */

/**
 * Tell the model which architecture-conditional calls its plan must declare,
 * before it submits — the requirement is fully determined by the detected
 * architecture plus strategy frontmatter, so learning it from a plan rejection
 * costs a guaranteed provider round trip on every such run.
 *
 * The mapping itself is never restated here; it comes from the same resolver
 * the plan gate uses.
 */
function buildPlanArchitectureRequirementSection(
  sceneType: SceneType | undefined,
  architecture: ArchitectureInfo | undefined,
  userQuery: string | undefined,
): string {
  if (!sceneType) return '';
  const requirements = resolveActiveConditionalPlanRequirements(
    sceneType,
    buildPlanTemplateTriggerContext(userQuery, architecture),
  );
  if (requirements.length === 0) return '';
  const template = loadPromptTemplate('plan-architecture-requirements');
  if (!template) return '';
  const lines = requirements.map(requirement => {
    // Render the literal expectedCalls shape. A shorthand like
    // `invoke_skill(id)` invites the model to attach skillId to tools that do
    // not accept one, which the gate then rejects on its own rule.
    const calls = requirement.requiredExpectedCalls
      .map(call => (call.skillId
        ? `{"tool":"${call.tool}","skillId":"${call.skillId}"}`
        : `{"tool":"${call.tool}"}`))
      .join(' ');
    const mandatory = requirement.waivable ? '' : '（不可豁免）';
    return `- ${requirement.aspectId}${mandatory}: ${calls}`;
  });
  return renderTemplate(template, { requirements: lines.join('\n') });
}

/**
 * Drop developer-facing HTML comments before a section becomes prompt text.
 *
 * Template headers carry SPDX, copyright, and "which variables exist" notes.
 * They mean nothing to the model and measurably cost ~400 tokens of a budget
 * whose worst-case headroom is under 100, which is enough to push real context
 * (trace completeness, pattern hints) out of the prompt.
 *
 * Runs at assembly, not at load: marker comments such as
 * `<!-- tool-description:start -->` are consumed by their own loaders before
 * the content ever reaches a prompt segment.
 */
export function stripTemplateComments(content: string): string {
  return content
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function buildSystemPromptParts(
  context: ClaudeAnalysisContext,
  maxTokens?: number,
  options: SystemPromptBuildOptions = {},
): SystemPromptParts {
  const effectiveMaxTokens = maxTokens ?? MAX_PROMPT_TOKENS;
  const shouldTruncateSceneCore = options.truncateSceneCore ?? true;
  const segments: PromptSegment[] = [];

  const push = (
    tier: PromptTier,
    label: string,
    content: string,
    droppable = false,
    opts: { truncatable?: boolean } = {},
  ): void => {
    const stripped = stripTemplateComments(content);
    if (!stripped) return;
    content = stripped;
    segments.push({
      tier,
      label,
      content,
      droppable,
      ...(opts.truncatable ? { truncatable: true } : {}),
      charCount: content.length,
      estimatedTokens: estimatePromptTokens(content),
    });
  };

  const replaceSegmentContent = (index: number, content: string, truncated = false): void => {
    const segment = segments[index];
    if (!segment) return;
    if (truncated && !segment.truncated) {
      segment.originalCharCount = segment.charCount;
      segment.originalEstimatedTokens = segment.estimatedTokens;
      segment.truncated = true;
    }
    segment.content = content;
    segment.charCount = content.length;
    segment.estimatedTokens = estimatePromptTokens(content);
  };

  const truncateSegmentToTokenBudget = (index: number, tokenBudget: number): boolean => {
    const segment = segments[index];
    if (!segment || !segment.truncatable || segment.estimatedTokens <= tokenBudget) return false;
    const originalContent = segment.content;
    let bestFit = '';
    let low = 0;
    let high = originalContent.length;

    while (low <= high) {
      const mid = Math.floor((low + high) / 2);
      const candidate = originalContent.slice(0, mid).trimEnd();
      if (estimatePromptTokens(candidate) <= tokenBudget) {
        bestFit = candidate;
        low = mid + 1;
      } else {
        high = mid - 1;
      }
    }

    const boundedFit = bestFit ? nearestMarkdownBoundary(bestFit) : '';
    replaceSegmentContent(index, boundedFit, boundedFit.length < originalContent.length);
    return Boolean(segments[index]?.truncated);
  };

  // ── Tier 1: STATIC ───────────────────────────────────────────────────────
  const outputLanguage = context.outputLanguage ?? DEFAULT_OUTPUT_LANGUAGE;

  const roleContent = loadPromptTemplate('prompt-role');
  push(1, 'role', roleContent ?? '# 角色\n\n你是 SmartPerfetto 的 Android 性能分析专家。');

  const outputLanguageSection = buildOutputLanguageSection(outputLanguage);
  if (outputLanguageSection) push(1, 'output_language', outputLanguageSection);

  const outputFormat = loadPromptTemplate('prompt-output-format');
  if (outputFormat) push(1, 'output_format', outputFormat);

  // Retrieval tools are available even without a private codebase selection
  // (for example public AOSP/blog knowledge), so this boundary must always be
  // present and must never be dropped by prompt-budget truncation.
  const retrievedContextSafety = loadPromptTemplate('retrieved-context-safety');
  if (!retrievedContextSafety) {
    throw new Error('Missing required retrieved-context-safety prompt template');
  }
  push(1, 'retrieved_context_safety', retrievedContextSafety);

  // ── Tier 2: PER-TRACE STABLE ─────────────────────────────────────────────
  if (context.architecture) {
    push(2, 'architecture', buildArchitectureSection(context.architecture, context.packageName, true));
  } else if (context.packageName) {
    push(2, 'architecture', `## 当前 Trace 信息\n\n- **包名**: ${context.packageName}\n- **架构**: 未检测（建议先调用 detect_architecture）`);
  }

  // Not droppable and not truncatable: if the budget silently removed it, the
  // first submit_plan would go back to being rejected by construction.
  push(2, 'plan_architecture_requirements', buildPlanArchitectureRequirementSection(
    context.sceneType,
    context.architecture,
    context.query,
  ));

  if (context.focusApps && context.focusApps.length > 0) {
    push(2, 'focus_apps', buildFocusAppSection(context.focusApps, context.focusMethod));
  }

  if (context.traceCompleteness) {
    const completenessSection = buildCompletenessSection(context.traceCompleteness);
    if (completenessSection) push(2, 'trace_completeness', completenessSection, true);
  }

  // ── HarmonyOS context injection ──
  if (context.traceOs === 'harmonyos') {
    const harmonyRendering = loadPromptTemplate('knowledge-harmonyos-rendering');
    if (harmonyRendering) push(2, 'harmonyos_rendering', harmonyRendering, true);

    const harmonyTools = loadPromptTemplate('knowledge-harmonyos-tools');
    if (harmonyTools) push(2, 'harmonyos_tools', harmonyTools, true);

    // Override the role section for HarmonyOS traces
    push(2, 'harmonyos_override', '## 重要：HarmonyOS Trace 分析注意事项\n\n' +
      '此 trace 来自 HarmonyOS 设备，通过 hitrace --text 采集，由 trace_processor_shell 解析为标准 ftrace 格式。关键特征：\n' +
      '- 渲染架构为 App → RS (RenderService) → GPU 三级流水线，无 SurfaceFlinger\n' +
      '- HarmonyOS 独有的 tracing_mark_write 标签：`ace::`、`ArkTS`、`RSRender`、`FFRT`、`H:` 前缀等\n' +
      '- 使用 `hdc` 和 `hitrace` 采集 trace（非 `adb` + `perfetto`）\n' +
      '- 标准 Perfetto SQL 表（slice, counter, sched 等）均可正常使用，分析方式与 Android 一致');
  }

  if (context.knowledgeBaseContext) {
    push(
      2,
      'knowledge_base',
      `## Perfetto SQL 知识库参考\n\n${context.knowledgeBaseContext}\n> 以上是根据用户问题从官方 Perfetto SQL stdlib 索引中匹配到的相关表/视图/函数。写 execute_sql 查询时可参考这些定义。`,
      true,
    );
  }

  // ── Tier 3: PER-QUERY ────────────────────────────────────────────────────
  const methodologyTemplate = loadPromptTemplate('prompt-methodology');
  const sceneStrategySections = buildSceneStrategySections(context.sceneType);
  if (methodologyTemplate) {
    const methodologyParts = splitMethodologyTemplate(methodologyTemplate);
    const beforeSceneStrategy = renderTemplate(methodologyParts.beforeSceneStrategy, {});
    const afterSceneStrategy = renderTemplate(methodologyParts.afterSceneStrategy, {});
    push(3, 'base_methodology', beforeSceneStrategy);
    push(3, 'scene_strategy_core', sceneStrategySections.core, false, { truncatable: true });
    push(3, 'report_contract', sceneStrategySections.reportContract);
    push(3, 'base_methodology_reference', afterSceneStrategy);
  } else {
    push(3, 'base_methodology', '## 分析方法论');
    push(3, 'scene_strategy_core', sceneStrategySections.core, false, { truncatable: true });
    push(3, 'report_contract', sceneStrategySections.reportContract);
  }

  if (context.codeAwareMode && context.codeAwareMode !== 'off' && context.codebaseIds && context.codebaseIds.length > 0) {
    const codeAwareTemplate = loadPromptTemplate('code-aware');
    if (codeAwareTemplate) {
      push(3, 'code_aware', renderTemplate(codeAwareTemplate, {
        codeAwareMode: context.codeAwareMode,
        codebaseIds: context.codebaseIds.join(', '),
      }), false, { truncatable: true });
    }
    const sourceUseDecision = loadSourceUseDecisionPrompt({
      codeAwareMode: context.codeAwareMode,
      codebaseIds: context.codebaseIds,
      outputLanguage,
    });
    if (sourceUseDecision) push(3, 'source_use_decision', sourceUseDecision);
    push(3, 'code_reference_contract', loadCodeReferenceContractPrompt(outputLanguage));
  }

  if (context.sceneType === 'multi_trace_result_comparison') {
    const comparisonResultMethodology = loadPromptTemplate('comparison-result-methodology');
    if (comparisonResultMethodology) {
      push(3, 'comparison_result_methodology', comparisonResultMethodology);
    }
  }

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

    push(
      3,
      'sub_agents',
      `## 子代理协作\n\n可用子代理：${context.availableAgents.map(a => `\`${a}\``).join('、')}\n\n### 何时委托 vs 直接调用\n- **委托**：需要从 ≥2 个不同域并行收集证据时（如帧分析 + CPU/内存系统上下文）\n- **直接调用**：单域查询（1-2 个工具调用即可完成）直接自己调用，不委托\n- **绝不委托**的情况：只需 1 个 invoke_skill 或 1 条 SQL；已经持有该域数据；ANR 场景（2-skill pipeline）\n\n### 委托规则\n1. **子代理只收集证据**，最终诊断和结论由你做出\n2. **委托时必须告知**：时间范围（start_ts/end_ts）、目标包名（process_name）、具体收集目标\n3. **不要重复收集**：你已调用的 Skill，不再委托子代理调用\n4. **子代理返回空或失败**：忽略该证据，基于已有数据继续分析，不要卡住\n${parallelGuidance}`,
      true,
    );
  }

  // ── Tier 4: PER-INTERACTION DYNAMIC ──────────────────────────────────────
  // User selection — never droppable; user's explicit intent.
  if (context.selectionContext) {
    push(4, 'selection_context', buildSelectionContextSection(context.selectionContext), false, { truncatable: true });
  }

  if (context.comparison) {
    push(
      4,
      'comparison_context',
      buildComparisonContextSection(context.comparison, context.packageName, outputLanguage),
      false,
      {truncatable: true},
    );
    const compMethodology = loadPromptTemplate('comparison-methodology');
    if (compMethodology) push(4, 'comparison_methodology', compMethodology, false, { truncatable: true });
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
      const sortedNotes = [...context.analysisNotes]
        .sort((a, b) => (a.priority === 'high' ? 0 : 1) - (b.priority === 'high' ? 0 : 1))
        .slice(0, 10);
      const noteLines = sortedNotes
        .map(n => `- [${sectionLabels[n.section] || n.section}] ${n.priority === 'high' ? '⚠️ ' : ''}${n.content}`)
        .join('\n');
      const omitted = context.analysisNotes.length - sortedNotes.length;
      contextParts.push(`### 分析笔记${omitted > 0 ? ` (显示 ${sortedNotes.length}/${context.analysisNotes.length})` : ''}\n${noteLines}\n\n以上是你之前记录的分析笔记。利用这些笔记继续分析，避免重复工作。`);
    }

    if (context.previousFindings && context.previousFindings.length > 0) {
      const findingSummary = context.previousFindings
        .slice(0, 10)
        .map(f => `- [${f.severity.toUpperCase()}] ${f.title}: ${f.description.substring(0, 100)}`)
        .join('\n');
      contextParts.push(`### 之前的分析发现\n${findingSummary}\n\n用户的新问题可能引用上面的发现。在之前结果的基础上继续深入分析，避免重复已知结论。`);
    }

    if (context.entityContext) {
      contextParts.push(`### 已知实体（可用于 drill-down 引用）\n${context.entityContext}`);
    }

    if (context.conversationSummary) {
      contextParts.push(`### 对话摘要\n${context.conversationSummary}`);
    }

    push(4, 'conversation_context', contextParts.join('\n\n'), false, { truncatable: true });
  }

  if (context.sqlErrorFixPairs && context.sqlErrorFixPairs.length > 0) {
    const pairLines = context.sqlErrorFixPairs.slice(0, 10).map((p, i) =>
      `${i + 1}. ERROR: \`${p.errorMessage.substring(0, 100)}\`\n   BAD: \`${p.errorSql.substring(0, 150)}\`\n   FIX: \`${p.fixedSql.substring(0, 150)}\``,
    ).join('\n');
    push(4, 'sql_error_pairs', `## SQL 踩坑记录（避免重复犯错）\n\n${pairLines}`, true);
  }

  if (context.patternContext) {
    push(4, 'pattern_context', context.patternContext, true);
  }

  if (context.negativePatternContext) {
    push(4, 'negative_pattern_context', context.negativePatternContext, true);
  }

  if (context.caseBackgroundContext) {
    push(4, 'case_background_context', context.caseBackgroundContext, true);
  }

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
    push(
      4,
      'plan_history',
      `## 历史分析计划\n\n以下是近几轮对话的分析计划，供参考以避免重复分析：\n\n${plansSummary}\n\n> 你可以在新计划中引用之前的发现，或对未完成的阶段进行补充分析。也可以使用 \`recall_patterns\` 查询跨会话的历史分析经验。`,
      true,
    );
  }

  // ── Budget enforcement: drop low-priority sections by label ──────────────
  const droppedLabels: string[] = [];
  // Drop priority order — lowest value first.
  const dropOrder: string[] = [
    'knowledge_base',
    'trace_completeness',
    'pattern_context',
    'negative_pattern_context',
    'case_background_context',
    'sql_error_pairs',
    'sub_agents',
    'plan_history',
  ];
  const truncatedLabels: string[] = [];
  if (shouldTruncateSceneCore) {
    const sceneCoreIndex = segments.findIndex(s => s.label === 'scene_strategy_core' && s.truncatable);
    if (sceneCoreIndex >= 0 && truncateSegmentToTokenBudget(sceneCoreIndex, MAX_SCENE_CORE_TOKENS)) {
      truncatedLabels.push('scene_strategy_core');
    }
  }
  let prompt = joinSegments(segments);
  let tokens = estimatePromptTokens(prompt);

  if (tokens > effectiveMaxTokens) {
    for (const label of dropOrder) {
      if (tokens <= effectiveMaxTokens) break;
      const idx = segments.findIndex(s => s.label === label);
      if (idx >= 0) {
        segments.splice(idx, 1);
        droppedLabels.push(label);
        prompt = joinSegments(segments);
        tokens = estimatePromptTokens(prompt);
      }
    }
    if (tokens > effectiveMaxTokens && shouldTruncateSceneCore) {
      const idx = segments.findIndex(s => s.label === 'scene_strategy_core' && s.truncatable);
      if (idx >= 0) {
        const originalContent = segments[idx].content;
        let bestFit = '';
        let low = 0;
        let high = originalContent.length;

        while (low <= high) {
          const mid = Math.floor((low + high) / 2);
          const candidate = originalContent.slice(0, mid).trimEnd();
          const candidateTokens = estimatePromptTokens(joinSegmentsWithReplacement(segments, idx, candidate));
          if (candidateTokens <= effectiveMaxTokens) {
            bestFit = candidate;
            low = mid + 1;
          } else {
            high = mid - 1;
          }
        }

        const boundedFit = bestFit ? nearestMarkdownBoundary(bestFit) : '';
        replaceSegmentContent(idx, boundedFit, boundedFit.length < originalContent.length);
        if (segments[idx].truncated && !truncatedLabels.includes('scene_strategy_core')) {
          truncatedLabels.push('scene_strategy_core');
        }
        prompt = joinSegments(segments);
        tokens = estimatePromptTokens(prompt);
      }
    }
    if (tokens > effectiveMaxTokens) {
      const dynamicCaps: Array<{ label: string; tokenBudget: number }> = [
        { label: 'selection_context', tokenBudget: 1_000 },
        { label: 'conversation_context', tokenBudget: 1_000 },
        { label: 'comparison_context', tokenBudget: 800 },
        { label: 'comparison_methodology', tokenBudget: 800 },
        { label: 'code_aware', tokenBudget: 700 },
      ];
      for (const { label, tokenBudget } of dynamicCaps) {
        if (tokens <= effectiveMaxTokens) break;
        const idx = segments.findIndex(s => s.label === label && s.truncatable);
        if (idx >= 0 && truncateSegmentToTokenBudget(idx, tokenBudget)) {
          if (!truncatedLabels.includes(label)) truncatedLabels.push(label);
          prompt = joinSegments(segments);
          tokens = estimatePromptTokens(prompt);
        }
      }
    }
    if (tokens > effectiveMaxTokens) {
      throw new Error(`[SystemPrompt] Prompt exceeds hard budget after trimming: ~${tokens} tokens (budget: ${effectiveMaxTokens})`);
    }
  }

  const stablePrefix = joinSegments(segments, s => s.tier <= 3);
  const volatileSuffix = joinSegments(segments, s => s.tier === 4);

  return {
    stablePrefix,
    volatileSuffix,
    fullPrompt: prompt,
    segments,
    droppedLabels,
    truncatedLabels,
  };
}

/**
 * Build the assembled system prompt string. Thin wrapper around
 * {@link buildSystemPromptParts} that returns just the joined prompt —
 * 100% byte-compatible with the pre-Phase-1.2 implementation.
 */
export function buildSystemPrompt(context: ClaudeAnalysisContext, maxTokens?: number): string {
  return buildSystemPromptParts(context, maxTokens).fullPrompt;
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
  selectionContext?: SelectionContext;
  runtimeEvidenceContext?: string;
  quickMemoryContext?: string;
  /** Perfetto SQL definitions matched to the question; keeps quick SQL targeted. */
  knowledgeBaseContext?: string;
  outputLanguage?: OutputLanguage;
  codeAwareMode?: ClaudeAnalysisContext['codeAwareMode'];
  codebaseIds?: string[];
}): string {
  const template = loadPromptTemplate('prompt-quick');
  if (!template) {
    return '你是 Android 性能 trace 分析专家。请简洁直接地回答用户的问题。';
  }

  const outputLanguageSection = buildOutputLanguageSection(opts.outputLanguage ?? DEFAULT_OUTPUT_LANGUAGE);

  const architectureContext = opts.architecture
    ? buildArchitectureSection(opts.architecture, opts.packageName, false)
    : opts.packageName ? `## 当前 Trace 信息\n\n- **包名**: ${opts.packageName}` : '';

  const focusAppContext = opts.focusApps && opts.focusApps.length > 0
    ? buildFocusAppSection(opts.focusApps, opts.focusMethod)
    : '';

  const selectionSection = opts.selectionContext
    ? buildSelectionContextSection(opts.selectionContext)
    : '';

  const sqlDefinitionsTemplate = opts.knowledgeBaseContext
    ? loadPromptTemplate('prompt-quick-sql-definitions')
    : undefined;
  const knowledgeBaseSection = sqlDefinitionsTemplate
    ? renderTemplate(sqlDefinitionsTemplate, {definitions: opts.knowledgeBaseContext ?? ''})
    : '';
  const prompt = renderTemplate(template, {
    outputLanguageSection,
    architectureContext,
    focusAppContext,
    runtimeEvidenceContext: opts.runtimeEvidenceContext ?? '',
    knowledgeBaseSection,
    selectionSection,
    quickMemoryContext: opts.quickMemoryContext ?? '',
    quickTriageMaxChineseChars: QUICK_TRIAGE_MAX_CHINESE_CHARS,
    quickTriageMaxFactBullets: QUICK_TRIAGE_MAX_FACT_BULLETS,
    quickTriageMaxClaims: QUICK_TRIAGE_MAX_CLAIMS,
  });
  const sourceUseDecision = loadSourceUseDecisionPrompt({
    codeAwareMode: opts.codeAwareMode,
    codebaseIds: opts.codebaseIds,
    outputLanguage: opts.outputLanguage,
  });
  if (!sourceUseDecision) return prompt;
  return [
    prompt,
    sourceUseDecision,
    loadCodeReferenceContractPrompt(opts.outputLanguage ?? DEFAULT_OUTPUT_LANGUAGE),
  ].join('\n\n');
}
