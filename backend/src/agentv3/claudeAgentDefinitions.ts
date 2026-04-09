// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

/**
 * Sub-agent definitions for Claude Agent SDK.
 * Each sub-agent runs in an isolated context window, collecting domain-specific
 * evidence without polluting the orchestrator's context.
 *
 * Design principle: sub-agents collect evidence, orchestrator makes final diagnosis.
 * Only injected when CLAUDE_ENABLE_SUB_AGENTS=true (feature flag).
 *
 * v5: Fixed model IDs, scene-based gating, adjusted maxTurns,
 *     added fetch_artifact to SUB_AGENT_TOOLS.
 */

import type { AgentDefinition } from '@anthropic-ai/claude-agent-sdk';
import type { SceneType } from './sceneClassifier';
import type { ArchitectureInfo } from '../agent/detectors/types';
import { MCP_NAME_PREFIX } from './claudeMcpServer';

/** Tools that are orchestrator-only — sub-agents collect evidence, not plan/hypothesize.
 * These are excluded when deriving sub-agent tools from the full allowedTools list. */
const ORCHESTRATOR_ONLY_TOOLS = new Set([
  'submit_plan',
  'update_plan_phase',
  'revise_plan',
  'submit_hypothesis',
  'resolve_hypothesis',
  'flag_uncertainty',
  'recall_patterns',
  // Comparison tools — orchestrator-only to prevent sub-agents from breaking comparison protocol
  'compare_skill',
  'execute_sql_on',
  'get_comparison_context',
]);

/**
 * Derive sub-agent tools from the orchestrator's allowedTools.
 * This ensures adding a new MCP tool automatically propagates to sub-agents
 * unless it is explicitly listed in ORCHESTRATOR_ONLY_TOOLS.
 */
function deriveSubAgentTools(allowedTools: string[]): string[] {
  return allowedTools.filter(t => {
    const shortName = t.replace(MCP_NAME_PREFIX, '');
    return !ORCHESTRATOR_ONLY_TOOLS.has(shortName);
  });
}

/** Context injected dynamically into sub-agent prompts at runtime. */
export interface SubAgentContext {
  architecture?: ArchitectureInfo;
  packageName?: string;
  /** Full allowedTools from createClaudeMcpServer — sub-agent tools are derived from this. */
  allowedTools?: string[];
  /** Override sub-agent model shorthand. Defaults to 'sonnet'.
   *  Accepted values: 'haiku' | 'sonnet' | 'opus' | 'inherit' (inherit from orchestrator).
   *  When using a third-party proxy, the proxy maps these shorthands to actual model names. */
  subAgentModel?: AgentDefinition['model'];
}

/**
 * Build architecture-specific guidance lines for sub-agent prompts.
 * Keeps sub-agents aware of the rendering pipeline they are analyzing.
 */
function buildArchitectureGuidance(ctx?: SubAgentContext): string {
  const lines: string[] = [];

  if (ctx?.packageName) {
    lines.push(`- **目标包名**: \`${ctx.packageName}\`，调用 invoke_skill 时使用 process_name="${ctx.packageName}"`);
  }

  if (!ctx?.architecture) return lines.length > 0 ? `\n## 当前 Trace 信息\n${lines.join('\n')}` : '';

  const arch = ctx.architecture;
  lines.push(`- **渲染架构**: ${arch.type} (置信度 ${(arch.confidence * 100).toFixed(0)}%)`);

  if (arch.type === 'FLUTTER') {
    lines.push(`- **Flutter 引擎**: ${arch.flutter?.engine || 'unknown'}`);
    lines.push(`- **线程模型**: 使用 \`N.ui\` (Dart UI) 和 \`N.raster\` (GPU raster) 线程，不是标准的 MainThread/RenderThread`);
    lines.push(`- **关键 Slice**: 看 \`GPURasterizer::Draw\` (帧 GPU 耗时)，Skia 看 \`SkCanvas*\`，Impeller 看 \`Impeller*\``);
    if (arch.flutter?.newThreadModel) {
      lines.push(`- **新线程模型**: 已启用`);
    }
  } else if (arch.type === 'COMPOSE') {
    lines.push(`- **Compose**: 关注 \`Recomposer:recompose\` slice 频率和耗时`);
    if (arch.compose?.isHybridView) {
      lines.push(`- **混合模式**: View + Compose 混合渲染`);
    }
  } else if (arch.type === 'WEBVIEW') {
    lines.push(`- **WebView**: 引擎=${arch.webview?.engine || 'Chromium'}，有独立 Compositor/Renderer 线程`);
  }

  return `\n## 当前 Trace 架构\n${lines.join('\n')}`;
}

function buildFrameExpert(subAgentTools: string[], ctx?: SubAgentContext): AgentDefinition {
  const archGuidance = buildArchitectureGuidance(ctx);

  return {
    description:
      'Frame rendering and jank diagnosis expert. Delegate to this agent for scrolling/jank analysis, ' +
      'frame timeline investigation, and rendering pipeline diagnosis. Use when analyzing dropped frames, ' +
      'jank root causes, or frame-level performance.',
    prompt: `你是帧渲染与掉帧诊断专家。你的任务是收集帧级别的证据数据。
${archGuidance}

## 职责范围
- 帧渲染管线分析（MainThread → RenderThread → SurfaceFlinger）
- 掉帧/卡顿检测与根因分类
- 四象限线程状态分析
- VSync 对齐与 Buffer Stuffing 检测
- 消费端真实掉帧 vs 框架标记掉帧的区分
- GPU 渲染分析（gpu_analysis, gpu_metrics, gpu_freq_in_range, gpu_render_in_range）
- SurfaceFlinger 合成分析（surfaceflinger_analysis, sf_composition_in_range）

## 工具使用
- 优先使用 invoke_skill：scrolling_analysis, jank_frame_detail, consumer_jank_detection
- GPU 相关：gpu_analysis, gpu_metrics
- SF 相关：surfaceflinger_analysis, sf_frame_consumption
- 需要自定义查询时，先调 lookup_sql_schema 确认表/列名再写 SQL
- 调用 invoke_skill 时使用 process_name 参数

## 输出要求
- **只收集证据，不做最终诊断**
- 返回结构化数据：帧列表、根因分类、关键指标
- 使用中文输出
- 每个发现标注严重程度 [CRITICAL]/[HIGH]/[MEDIUM]/[LOW]/[INFO]`,
    tools: subAgentTools,
    model: ctx?.subAgentModel ?? 'sonnet',
    maxTurns: 8,
  };
}

function buildSystemExpert(subAgentTools: string[], ctx?: SubAgentContext): AgentDefinition {
  const archGuidance = buildArchitectureGuidance(ctx);

  return {
    description:
      'System-level performance expert. Delegate to this agent for CPU scheduling, memory/GC analysis, ' +
      'Binder IPC investigation, thermal throttling, and kernel-level diagnosis. Use when the orchestrator ' +
      'needs system context beyond frame rendering.',
    prompt: `你是系统级性能分析专家。你的任务是收集系统层面的证据数据。
${archGuidance}

## 职责范围
- CPU 调度与频率分析（大小核分布、频率升降、调度延迟）
- 内存分析（GC、LMK、页面错误、dmabuf）
- Binder IPC 分析（阻塞事务、跨进程延迟）
- 内核调度（锁竞争、IRQ、IO 阻塞）
- 热管理与降频检测

## 工具使用
- 优先使用 invoke_skill：cpu_analysis, memory_analysis, binder_analysis, scheduling_analysis
- Range-based skills：cpu_load_in_range, sched_latency_in_range, lock_contention_in_range
- 热降频：thermal_throttling, cpu_throttling_in_range
- 需要自定义查询时，先调 lookup_sql_schema 确认表/列名再写 SQL
- 调用 invoke_skill 时使用 process_name 参数

## 输出要求
- **只收集证据，不做最终诊断**
- 返回结构化数据：CPU 频率时序、内存波动、Binder 延迟分布
- 使用中文输出
- 每个发现标注严重程度 [CRITICAL]/[HIGH]/[MEDIUM]/[LOW]/[INFO]`,
    tools: subAgentTools,
    model: ctx?.subAgentModel ?? 'sonnet',
    maxTurns: 8,
  };
}

function buildStartupExpert(subAgentTools: string[], ctx?: SubAgentContext): AgentDefinition {
  const archGuidance = buildArchitectureGuidance(ctx);

  return {
    description:
      'App startup analysis expert. Delegate to this agent for cold/warm/hot start analysis, ' +
      'TTID/TTFD measurement, and startup phase breakdown.',
    prompt: `你是应用启动分析专家。你的任务是收集启动过程的证据数据。
${archGuidance}

## 职责范围
- 冷启动/温启动/热启动阶段分解
- TTID (Time To Initial Display) 和 TTFD (Time To Full Display) 测量
- 启动过程中的阻塞因素定位（ClassLoader、ContentProvider、主线程阻塞）
- 启动期间的资源竞争（CPU、IO、Binder）

## 工具使用
- 优先使用 invoke_skill：startup_analysis, startup_detail
- **不要** 调用 cpu_analysis, binder_analysis, memory_analysis, scheduling_analysis
  这些由 system-expert 负责，避免重复
- 需要自定义查询时使用 execute_sql

## 输出要求
- **只收集证据，不做最终诊断**
- 返回：各阶段耗时、阻塞因素、关键 Slice 列表
- 使用中文输出
- 每个发现标注严重程度 [CRITICAL]/[HIGH]/[MEDIUM]/[LOW]/[INFO]`,
    tools: subAgentTools,
    model: ctx?.subAgentModel ?? 'sonnet',
    maxTurns: 8,
  };
}

/**
 * Build agent definitions based on scene type and runtime context.
 * Injects architecture/packageName into sub-agent prompts dynamically.
 *
 * **Parallelism note**: The SDK `agents` option accepts multiple definitions,
 * but whether they run in parallel or serially depends on the SDK's internal
 * orchestration. As of claude-agent-sdk 0.x, the SDK decides execution order
 * based on the orchestrator model's tool calls. We design prompts assuming
 * parallel evidence collection, but actual behavior should be verified via
 * SDK logs when CLAUDE_ENABLE_SUB_AGENTS=true is enabled.
 *
 * Scene-based gating:
 * - scrolling: frame-expert + system-expert (parallel evidence collection)
 * - startup: startup-expert + system-expert (CPU freq/thermal/binder context for startup)
 * - anr: no sub-agents (2-skill pipeline, sub-agents add latency without benefit)
 * - general: frame-expert + system-expert
 */
export function buildAgentDefinitions(
  sceneType: SceneType,
  ctx?: SubAgentContext,
): Record<string, AgentDefinition> {
  // Auto-derive sub-agent tools from orchestrator's allowedTools, excluding orchestrator-only tools.
  // Falls back to empty array if allowedTools not provided (sub-agents will have no tools — safe failure).
  const subAgentTools = ctx?.allowedTools ? deriveSubAgentTools(ctx.allowedTools) : [];
  const agents: Record<string, AgentDefinition> = {};

  switch (sceneType) {
    case 'scrolling':
      agents['frame-expert'] = buildFrameExpert(subAgentTools, ctx);
      agents['system-expert'] = buildSystemExpert(subAgentTools, ctx);
      break;

    case 'startup':
      agents['startup-expert'] = buildStartupExpert(subAgentTools, ctx);
      agents['system-expert'] = buildSystemExpert(subAgentTools, ctx);
      break;

    case 'anr':
      // ANR is a 2-skill pipeline — sub-agents add latency without benefit
      break;

    case 'general':
    default:
      // For general queries, frame-expert + system-expert provide broad coverage.
      // startup-expert is omitted to avoid duplicating system-expert's CPU/Binder/Memory skills.
      // The orchestrator can still call startup_analysis directly if needed.
      agents['frame-expert'] = buildFrameExpert(subAgentTools, ctx);
      agents['system-expert'] = buildSystemExpert(subAgentTools, ctx);
      break;
  }

  return agents;
}