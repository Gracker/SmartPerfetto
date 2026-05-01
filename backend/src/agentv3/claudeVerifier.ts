// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

/**
 * Conclusion verifier for agentv3.
 * Three-layer verification:
 * 1. Heuristic checks (no LLM) — fast, always runs
 * 2. Plan adherence check — verifies Claude followed its submitted plan
 * 3. LLM verification (haiku, independent sdkQuery) — optional, validates evidence support
 *
 * When verification finds ERROR-level issues, generateCorrectionPrompt() produces
 * a prompt for a retry sdkQuery call (reflection-driven retry, P0-2).
 *
 * Enabled by default. Set CLAUDE_ENABLE_VERIFICATION=false to disable.
 */

import * as fs from 'fs';
import * as path from 'path';
import { query as sdkQuery } from '@anthropic-ai/claude-agent-sdk';
import { createSdkEnv } from './claudeConfig';
import type { Finding, StreamingUpdate } from '../agent/types';
import type { VerificationResult, VerificationIssue, AnalysisPlanV3, Hypothesis } from './types';
import { expectedToolNames } from './types';
import type { SceneType } from './sceneClassifier';
import { DEFAULT_OUTPUT_LANGUAGE, localize, type OutputLanguage } from './outputLanguage';

/** Hardcoded known misdiagnosis patterns — common false positives in performance analysis. */
const HARDCODED_MISDIAGNOSIS_PATTERNS: Array<{
  pattern: RegExp;
  type: VerificationIssue['type'];
  message: string;
}> = [
  {
    pattern: /VSync.*(?:对齐异常|misalign|偏移)/i,
    type: 'known_misdiagnosis',
    message: 'VSync 对齐异常可能是正常的 VRR (可变刷新率) 行为，需确认设备是否支持 VRR',
  },
  {
    pattern: /Buffer Stuffing.*(?:严重|critical|掉帧)/i,
    type: 'known_misdiagnosis',
    message: 'Buffer Stuffing 是管线背压问题，非 App 逻辑缺陷 — 感知掉帧率已排除 Buffer Stuffing，请勿将其等同于真实掉帧',
  },
  {
    pattern: /(?:单帧|single frame|1帧).*(?:异常|critical|严重)/i,
    type: 'known_misdiagnosis',
    message: '单帧异常不应标记为 CRITICAL — 需确认是否有模式性重复',
  },
];

// P2-G14: Learned misdiagnosis patterns — auto-extracted from verification results
interface LearnedMisdiagnosisPattern {
  /** Keywords that triggered the false positive (from the finding title/description) */
  keywords: string[];
  message: string;
  /** How many times this pattern has been confirmed as a false positive */
  occurrences: number;
  createdAt: number;
}

const LEARNED_PATTERNS_FILE = path.resolve(__dirname, '../../logs/learned_misdiagnosis_patterns.json');
const MAX_LEARNED_PATTERNS = 30;
const LEARNED_PATTERN_TTL_MS = 90 * 24 * 60 * 60 * 1000; // 90 days

function loadLearnedPatterns(): LearnedMisdiagnosisPattern[] {
  try {
    if (!fs.existsSync(LEARNED_PATTERNS_FILE)) return [];
    return JSON.parse(fs.readFileSync(LEARNED_PATTERNS_FILE, 'utf-8'));
  } catch { return []; }
}

function saveLearnedPatterns(patterns: LearnedMisdiagnosisPattern[]): void {
  try {
    const dir = path.dirname(LEARNED_PATTERNS_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const tmpFile = LEARNED_PATTERNS_FILE + '.tmp';
    fs.writeFileSync(tmpFile, JSON.stringify(patterns, null, 2));
    fs.renameSync(tmpFile, LEARNED_PATTERNS_FILE);
  } catch (err) {
    console.warn('[ClaudeVerifier] Failed to save learned patterns:', (err as Error).message);
  }
}

/**
 * Build combined misdiagnosis patterns from hardcoded + learned.
 * Learned patterns are converted to regex on-the-fly from stored keywords.
 */
function getKnownMisdiagnosisPatterns(): Array<{ pattern: RegExp; type: VerificationIssue['type']; message: string }> {
  const learned = loadLearnedPatterns();
  const cutoff = Date.now() - LEARNED_PATTERN_TTL_MS;

  const learnedAsPatterns = learned
    .filter(p => p.createdAt >= cutoff && p.occurrences >= 2) // Only use patterns seen ≥2 times
    .map(p => ({
      pattern: new RegExp(p.keywords.map(k => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*'), 'i'),
      type: 'known_misdiagnosis' as VerificationIssue['type'],
      message: `(学习) ${p.message}`,
    }));

  return [...HARDCODED_MISDIAGNOSIS_PATTERNS, ...learnedAsPatterns];
}

/**
 * P2-G14: Extract potential misdiagnosis patterns from LLM verification results.
 * When LLM verification flags a `known_misdiagnosis` or `severity_mismatch` issue,
 * extract the relevant keywords and save as a learned pattern.
 */
export function learnFromVerificationResults(
  llmIssues: VerificationIssue[],
  findings: Finding[],
): void {
  const relevantIssues = llmIssues.filter(i =>
    i.type === 'known_misdiagnosis' || i.type === 'severity_mismatch'
  );
  if (relevantIssues.length === 0) return;

  const patterns = loadLearnedPatterns();

  for (const issue of relevantIssues) {
    // Extract keywords from the issue message
    let keywords = issue.message
      .replace(/[^\w\u4e00-\u9fff\s]/g, ' ')
      .split(/\s+/)
      .filter(w => w.length >= 2)
      .slice(0, 5);

    // P2-G7: Enrich with keywords from the finding that triggered this issue
    // Provides richer semantic context for more reliable future pattern matching
    const matchedFinding = findings.find(f =>
      issue.message.includes(f.title.substring(0, 20)) ||
      (f.description && issue.message.includes(f.description.substring(0, 30)))
    );
    if (matchedFinding) {
      const findingKeywords = matchedFinding.title
        .replace(/[^\w\u4e00-\u9fff\s]/g, ' ')
        .split(/\s+/)
        .filter(w => w.length >= 2)
        .slice(0, 3);
      keywords = [...new Set([...keywords, ...findingKeywords])].slice(0, 8);
    }

    if (keywords.length < 2) continue;

    const keyStr = [...keywords].sort().join('|');
    const existing = patterns.find(p => [...p.keywords].sort().join('|') === keyStr);
    if (existing) {
      existing.occurrences++;
      existing.createdAt = Date.now();
    } else {
      patterns.push({
        keywords,
        message: issue.message.substring(0, 150),
        occurrences: 1,
        createdAt: Date.now(),
      });
    }
  }

  // Prune and save
  const cutoff = Date.now() - LEARNED_PATTERN_TTL_MS;
  const active = patterns
    .filter(p => p.createdAt >= cutoff)
    .sort((a, b) => b.occurrences - a.occurrences)
    .slice(0, MAX_LEARNED_PATTERNS);
  saveLearnedPatterns(active);
}

/**
 * Run heuristic verification on analysis findings and conclusion.
 * These checks are fast (<1ms) and require no LLM calls.
 */
export function verifyHeuristic(
  findings: Finding[],
  conclusion: string,
): VerificationIssue[] {
  const issues: VerificationIssue[] = [];

  // Check 1: CRITICAL findings without evidence
  const criticals = findings.filter(f => f.severity === 'critical');
  for (const f of criticals) {
    if (!f.evidence || f.evidence.length === 0) {
      issues.push({
        type: 'missing_evidence',
        severity: 'error',
        message: `CRITICAL 发现 "${f.title}" 缺少证据支撑`,
      });
    }
  }

  // Check 2: Too many CRITICALs (>5 is suspicious)
  if (criticals.length > 5) {
    issues.push({
      type: 'too_many_criticals',
      severity: 'warning',
      message: `发现 ${criticals.length} 个 CRITICAL 级别问题，可能存在过度标记 — 通常不超过 3-5 个`,
    });
  }

  // Check 3: Known misdiagnosis pattern matching (hardcoded + learned, P2-G14)
  const fullText = conclusion + ' ' + findings.map(f => `${f.title} ${f.description}`).join(' ');
  for (const pattern of getKnownMisdiagnosisPatterns()) {
    if (pattern.pattern.test(fullText)) {
      issues.push({
        type: pattern.type,
        severity: 'warning',
        message: pattern.message,
      });
    }
  }

  // Check 4: Conclusion mentions CRITICAL but no CRITICAL findings exist
  if (/\[CRITICAL\]/i.test(conclusion) && criticals.length === 0) {
    issues.push({
      type: 'severity_mismatch',
      severity: 'warning',
      message: '结论文本提及 CRITICAL 但结构化发现中无 CRITICAL 级别条目',
    });
  }

  // Check 5: Empty conclusion check
  if (conclusion.trim().length < 50) {
    issues.push({
      type: 'missing_reasoning',
      severity: 'error',
      message: '结论过短 (< 50 字符)，可能分析未完成',
    });
  }

  // Check 6: CRITICAL/HIGH findings must have causal reasoning (P0-G2: enhanced reasoning checks)
  const highSeverity = findings.filter(f => f.severity === 'critical' || f.severity === 'high');
  for (const f of highSeverity) {
    const desc = f.description || '';
    // 6a: Duration data without causal analysis — removed desc.length < 100 limit
    // (long descriptions without causal reasoning are still a problem)
    const hasDuration = /\d+(\.\d+)?\s*ms/i.test(desc);
    const hasCausalKeywords = /因为|导致|由于|caused|because|blocked|阻塞|锁|频率|CPU|IO|GC|Binder|等待|竞争|饥饿|调度|抢占|延迟|回收|编译|内存|泄漏|瓶颈/i.test(desc);
    if (hasDuration && !hasCausalKeywords) {
      issues.push({
        type: 'missing_reasoning',
        severity: 'warning',
        message: `[${f.severity.toUpperCase()}] "${f.title}" 只报告了耗时但缺少根因分析（WHY）`,
      });
    }

    // 6b: CRITICAL findings with quantitative data but no comparison baseline
    // (e.g., "50ms" without saying compared to what threshold/normal value)
    if (f.severity === 'critical') {
      const hasQuantitative = /\d+(\.\d+)?\s*(ms|%|MB|KB|次|帧|fps)/i.test(desc);
      const hasBaseline = /预期|正常|阈值|expected|threshold|baseline|对比|应该|超过|低于|高于|compared|vs|相比/i.test(desc);
      if (hasQuantitative && !hasBaseline) {
        issues.push({
          type: 'missing_reasoning',
          severity: 'warning',
          message: `[CRITICAL] "${f.title}" 引用了量化数据但缺少对比基准（与正常值/阈值的比较）`,
        });
      }
    }

    // 6d (P1-G3): Long descriptions with multiple metrics but shallow causal reasoning
    // (listing symptoms without connecting them via causal chain)
    if (desc.length > 200) {
      const metricCount = (desc.match(/\d+(\.\d+)?\s*(ms|%|MB|KB|次|帧|fps)/gi) || []).length;
      const causalConnectors = (desc.match(/因为|导致|由于|caused|because|所以|因此|根因|进而|从而|bottleneck|瓶颈/gi) || []).length;
      if (metricCount >= 3 && causalConnectors <= 1) {
        issues.push({
          type: 'missing_reasoning',
          severity: 'warning',
          message: `[${f.severity.toUpperCase()}] "${f.title}" 描述了 ${metricCount} 个量化指标但缺少充分的因果连接 (仅 ${causalConnectors} 个因果连词)`,
        });
      }
    }
  }

  // Check 6e: Shallow root cause — CRITICAL/HIGH with quantitative data but no multi-level causal chain.
  // A "deep" root cause has at least 2 causal connectors showing chain reasoning (A → B → C).
  for (const f of highSeverity) {
    const desc = f.description || '';
    const hasQuantitative = /\d+(\.\d+)?\s*(ms|%|MB|KB|次|帧|fps)/i.test(desc);
    // Count distinct causal chain connectors (not just presence, but DEPTH of reasoning)
    const causalChainMarkers = (desc.match(/→|⇒|导致|因为|由于|caused by|because|进而|从而|根因|阻塞链|blocking_chain|waker|唤醒/gi) || []).length;
    // Also check for mechanistic terms that indicate deep analysis
    const mechanisticTerms = (desc.match(/futex|binder_wait|io_schedule|monitor contention|thermal|governor|ramp|pipeline|管线|调度器|GC pause|锁持有|lock hold/gi) || []).length;
    if (f.severity === 'critical' && hasQuantitative && causalChainMarkers < 2 && mechanisticTerms < 1) {
      issues.push({
        type: 'missing_reasoning',
        severity: 'warning',
        message: `[CRITICAL] "${f.title}" 缺少深层根因链 — 有量化数据但因果推理不足 2 级。建议：用 blocking_chain_analysis 或 binder_root_cause 追踪阻塞源头，用 lookup_knowledge 解释机制。`,
      });
    }
  }

  // Check 6c: Overall reasoning density — flag when most HIGH+ findings lack causal analysis
  if (highSeverity.length >= 3) {
    const withCausal = highSeverity.filter(f => {
      const desc = f.description || '';
      return /因为|导致|由于|caused|because|blocked|阻塞|瓶颈|bottleneck/i.test(desc);
    }).length;
    const causalRatio = withCausal / highSeverity.length;
    if (causalRatio < 0.5) {
      issues.push({
        type: 'missing_reasoning',
        severity: 'warning',
        message: `整体推理密度不足 — ${highSeverity.length} 个高严重度发现中仅 ${withCausal} 个包含因果分析 (${(causalRatio * 100).toFixed(0)}%)`,
      });
    }
  }

  // Check 7: Detect potential conclusion truncation.
  // Common when Claude hits output token limits — the conclusion ends mid-sentence.
  // Proper endings: sentence-final punctuation, table row, code fence, emoji checkmarks.
  const trimmedConclusion = conclusion.trim();
  if (trimmedConclusion.length > 100) {
    const lastLine = trimmedConclusion.split('\n').pop()?.trim() || '';
    if (lastLine.length > 15) {
      // Note: `|` is NOT in the char class — table rows are handled by the dedicated /^\|.*\|$/ check
      const hasProperEnding = /[。.!！?？）\]】`✅✓☑→]$/.test(lastLine) ||
                              /^```$/.test(lastLine) ||
                              /^\|.*\|$/.test(lastLine) ||
                              /^---+$/.test(lastLine);
      if (!hasProperEnding) {
        // Severity: error — triggers correction retry so the agent can complete the conclusion.
        // Truncation is a broken deliverable, not just a cosmetic issue.
        issues.push({
          type: 'truncation',
          severity: 'error',
          message: `结论文本被截断 — 最后一行不以完整语句结尾: "...${lastLine.slice(-40)}"`,
        });
      }
    }
  }

  return issues;
}

/**
 * Verify plan adherence — check if Claude completed all planned phases.
 * Returns issues for skipped phases that weren't explicitly marked as skipped.
 */
export function verifyPlanAdherence(plan: AnalysisPlanV3 | null): VerificationIssue[] {
  if (!plan) {
    // No plan submitted — planning is mandatory, trigger reflection retry
    return [{
      type: 'plan_deviation',
      severity: 'error',
      message: '未提交分析计划 — Claude 跳过了 submit_plan 步骤。必须先调用 submit_plan 提交结构化计划。',
    }];
  }

  const issues: VerificationIssue[] = [];
  const pendingPhases = plan.phases.filter(p => p.status === 'pending');

  if (pendingPhases.length > 0) {
    const phaseNames = pendingPhases.map(p => `"${p.name}" (${p.id})`).join(', ');
    // Pending phases = Claude forgot to call update_plan_phase — this is a
    // governance/bookkeeping issue, not an analysis quality problem. If the
    // analysis produced tool calls (meaning work was done), treat as WARNING
    // to avoid triggering a full correction retry that duplicates the report.
    const hasToolCalls = plan.toolCallLog.length > 0;
    issues.push({
      type: 'plan_deviation',
      severity: hasToolCalls ? 'warning' : 'error',
      message: `${pendingPhases.length} 个计划阶段未完成: ${phaseNames}`,
    });
  }

  // Check tool-to-phase matching: completed phases should have at least one matched tool call.
  // Phases that declare any expectations (legacy `expectedTools` or structured
  // `expectedCalls`) but have zero matched calls indicate the Agent skipped
  // substantive work. ERROR severity triggers a correction retry.
  const completedPhases = plan.phases.filter(p => p.status === 'completed');
  for (const phase of completedPhases) {
    const matchedCalls = plan.toolCallLog.filter(t => t.matchedPhaseId === phase.id);
    const hasExpectations =
      (phase.expectedCalls?.length ?? 0) > 0 || phase.expectedTools.length > 0;
    if (matchedCalls.length === 0 && hasExpectations) {
      const expected = expectedToolNames(phase).join(', ');
      issues.push({
        type: 'plan_deviation',
        severity: 'error',
        message: `阶段 "${phase.name}" (${phase.id}) 标记为完成但无匹配的工具调用 (预期: ${expected})。必须执行该阶段的工具调用或将其标记为 skipped。`,
      });
    }
  }

  // Phase 2.3 of v2.1: surface scene-template aspects the hard-gate gave up
  // enforcing (force-accepted after the attempt cap). Without this check the
  // agent could keep submitting incomplete plans until the cap and have the
  // gap silently swept under the rug.
  if (plan.unresolvedAspects && plan.unresolvedAspects.length > 0) {
    issues.push({
      type: 'plan_deviation',
      severity: 'error',
      message: `Plan 未覆盖场景必要 aspect（已达硬拦截尝试上限被强制接受）: ${plan.unresolvedAspects.join(', ')}。在结论中说明这些 aspect 为何无法分析，或下次重新规划时补足。`,
    });
  }

  // P2-1: Check reasoning quality — completed phases should have meaningful summaries
  const finishedPhases = plan.phases.filter(p => p.status === 'completed' || p.status === 'skipped');
  const phasesWithoutSummary = finishedPhases.filter(p => !p.summary || p.summary.length < 15);
  if (phasesWithoutSummary.length > 0 && finishedPhases.length > 1) {
    // Only warn if multiple phases exist (single-phase plans may be trivial)
    issues.push({
      type: 'missing_reasoning',
      severity: 'warning',
      message: `${phasesWithoutSummary.length} 个已完成阶段缺少推理摘要: ${phasesWithoutSummary.map(p => `"${p.name}"`).join(', ')}`,
    });
  }

  return issues;
}

/**
 * P0-G4: Verify hypothesis resolution — all formed hypotheses must be resolved before concluding.
 * Returns error-level issues for any hypotheses still in 'formed' state.
 */
export function verifyHypotheses(hypotheses: Hypothesis[]): VerificationIssue[] {
  const unresolved = hypotheses.filter(h => h.status === 'formed');
  if (unresolved.length === 0) return [];

  return [{
    type: 'unresolved_hypothesis',
    severity: 'error',
    message: `${unresolved.length} 个假设未解决: ${unresolved.map(h => `"${h.statement.substring(0, 80)}" (${h.id})`).join('; ')}。所有假设必须在结论前调用 resolve_hypothesis 标记为 confirmed 或 rejected。`,
  }];
}

/**
 * P1-G15: Scene-aware completeness verification.
 * Checks that the analysis output is topically relevant to the detected scene.
 * Returns warnings if mandatory scene-specific data is missing from findings/conclusion.
 */
export function verifySceneCompleteness(
  sceneType: SceneType,
  findings: Finding[],
  conclusion: string,
): VerificationIssue[] {
  const issues: VerificationIssue[] = [];
  const allText = (
    findings.map(f => `${f.title} ${f.description} ${f.category}`).join(' ') +
    ' ' + conclusion
  ).toLowerCase();

  switch (sceneType) {
    case 'scrolling': {
      if (!/帧|frame|jank|卡顿|掉帧|vsync|滑动/.test(allText)) {
        issues.push({
          type: 'missing_check',
          severity: 'warning',
          message: '滑动场景分析缺少帧/卡顿相关内容 — 应包含帧渲染分析和 VSync 数据',
        });
      }

      // Phase 1.9: Deep drill should be executed for major root causes
      // Require at least one REAL analysis tool (not just lookup_knowledge which only reads background docs)
      // blocking_chain_analysis/binder_root_cause/jank_frame_detail/surfaceflinger_analysis/frame_production_gap = real deep-drill skills
      // lookup_knowledge is supplementary — counts as evidence only when combined with analysis output patterns
      const hasAnalysisTool = /blocking_chain_analysis|binder_root_cause|jank_frame_detail|surfaceflinger_analysis|frame_production_gap|阻塞链.*(?:唤醒|waker|blocker)|server_dur/i.test(allText);
      const hasKnowledgeDrill = /lookup_knowledge|cpu[\.\-]scheduler|rendering[\.\-]pipeline|thermal[\.\-]throttling/i.test(allText);
      const hasDeepDrill = hasAnalysisTool || hasKnowledgeDrill;
      // Check if there are significant jank frames (the analysis mentions percentage distributions)
      const hasSignificantJank = /(?:[2-9]\d|[1-9]\d{2,})\s*帧|(?:[1-9]\d+)\s*%.*(?:freq_ramp|workload|sched_delay|lock_binder|binder_wait|thermal|sf_composition|render_thread|gc_pressure|cpu_max)/i.test(allText);
      if (hasSignificantJank && !hasDeepDrill) {
        issues.push({
          type: 'missing_check',
          severity: 'error',
          message: '滑动分析有掉帧但缺少 Phase 1.9 根因深钻 — reason_code 只是分类标签，不是真正的根因。必须对占比 >15% 的根因类别调用 blocking_chain_analysis/lookup_knowledge/binder_root_cause/jank_frame_detail/surfaceflinger_analysis 获取机制级证据，回答"WHY 这帧慢"',
        });
      }

      // Check: thermal_throttling/cpu_max_limited should mention temperature or thermal policy
      // Only fire when conclusion CLAIMS thermal as a root cause, not when it merely mentions or rules it out
      const hasThermalJank = /thermal_throttling|cpu_max_limited|温控降频|CPU限频/i.test(allText);
      const thermalRuledOut = /(?:thermal|温控|限频).*(?:已排除|完全排除|不存在|ruled out|not.*cause|未检出|无.*证据)/i.test(allText);
      // Match thermal deep-drill evidence: tool invocations or distinctive thermal output (not reason_code labels)
      const hasThermalEvidence = /invoke_skill.*thermal|lookup_knowledge.*thermal|thermal[_\s]*zone|温度.*[℃°C]|trip_point|cooling_device|freq[_\s]*cap.*policy/i.test(allText);
      if (hasThermalJank && !hasThermalEvidence && !thermalRuledOut) {
        issues.push({
          type: 'missing_check',
          severity: 'warning',
          message: '滑动分析检测到温控/限频帧但缺少机制解释 — 应调用 thermal_throttling skill 或 lookup_knowledge("thermal-throttling") 分析限频原因（thermal zone 温度 vs policy governor）',
        });
      }

      // Check: sf_composition_slow should be followed by SF analysis
      const hasSfJank = /sf_composition_slow|SF合成超时/i.test(allText);
      // Match SF deep-drill evidence: tool invocations or distinctive SF analysis output (not reason_code labels)
      const hasSfEvidence = /invoke_skill.*surfaceflinger|surfaceflinger_analysis|doComposition|rebuildLayerStacks|HWC.*(?:delay|回退|fallback)|GPU.*composition.*(?:fallback|回退)|layer.*(?:数量|count).*(?:过多|high)/i.test(allText);
      if (hasSfJank && !hasSfEvidence) {
        issues.push({
          type: 'missing_check',
          severity: 'warning',
          message: '滑动分析检测到 SF 合成超时帧但缺少 SF 深钻 — 应调用 surfaceflinger_analysis 分析 HWC/GPU 合成比例和 Layer 状态',
        });
      }

      // Check if unknown reason_code frames are analyzed when present
      const hasUnknown = /unknown.*(?:[5-9]|[1-9]\d+)\s*%|(?:[5-9]|[1-9]\d+)\s*%.*unknown|未分类.*(?:[5-9]|[1-9]\d+)\s*帧/i.test(allText);
      const hasUnknownAnalysis = /unknown.*代表帧|unknown.*分析|jank_frame_detail.*unknown|未分类.*原因/i.test(allText);
      if (hasUnknown && !hasUnknownAnalysis) {
        issues.push({
          type: 'missing_check',
          severity: 'warning',
          message: '滑动分析发现 unknown 根因帧占比较高但未对其进行代表帧分析 — 应调用 jank_frame_detail 获取更多线索',
        });
      }
      break;
    }
    case 'startup': {
      if (!/ttid|ttfd|启动|startup|launch|冷启动|温启动|热启动/.test(allText)) {
        issues.push({
          type: 'missing_check',
          severity: 'warning',
          message: '启动场景分析缺少 TTID/TTFD 数据 — 应包含启动耗时测量',
        });
      }

      // Cold-start specific checks
      // Note: do NOT include 'bindapplication' here — it appears in warm-start traces too
      // (e.g., when agent mentions bindApplication duration in a warm-start context)
      const isColdStart = /冷启动|cold\s*start|cold_start/i.test(allText);
      if (isColdStart) {
        // Phase 2.6: startup_slow_reasons cross-validation (mandatory for cold start)
        const hasSlowReasons = /startup_slow_reasons|官方.*原因|官方.*分类|dex2oat|baseline.?profile|debuggable/i.test(allText);
        if (!hasSlowReasons) {
          issues.push({
            type: 'missing_check',
            severity: 'warning',
            message: '冷启动分析缺少 Phase 2.6 官方启动慢原因交叉验证 — 应调用 startup_slow_reasons 检查 DEX2OAT/baseline profile/debuggable 等因素',
          });
        }

        // JIT analysis (mandatory mention for cold start, even if impact is minimal)
        const hasJitAnalysis = /jit|编译.*缓存|code.?cache|解释执行|interpreter/i.test(allText);
        if (!hasJitAnalysis) {
          issues.push({
            type: 'missing_check',
            severity: 'warning',
            message: '冷启动分析缺少 JIT 编译影响分析 — 应在结论中评估 JIT 编译量和大核竞争（即使影响不大也应明确排除）',
          });
        }
      }

      // Q4 heavy + missing blocking chain analysis
      // Detect Q4/Sleeping with high percentages (>=30%) in the text.
      // Use \b word boundary on "sleeping" to avoid matching non-scheduler contexts.
      const q4Keywords = /(?:q4|\bsleeping\b|睡眠|s\(sleeping\))/i;
      const highPct = /(?:[3-9]\d|[1-9]\d{2,})\s*%/;
      const hasQ4Heavy = new RegExp(`${q4Keywords.source}.*${highPct.source}|${highPct.source}.*${q4Keywords.source}`, 'i').test(allText);
      if (hasQ4Heavy) {
        const hasBlockingChain = /blocking_chain|阻塞链|waker.*thread|唤醒.*线程|唤醒者|waker_current_slice/i.test(allText);
        if (!hasBlockingChain) {
          issues.push({
            type: 'missing_check',
            severity: 'warning',
            message: '启动分析发现 Q4(Sleeping) 占比高但缺少阻塞链深钻 — 应调用 blocking_chain_analysis 追踪阻塞源头（不能仅依赖间接推断）',
          });
        }
      }

      // Root cause ID references (A1-A18, B1-B12 from knowledge-startup-root-causes)
      // Two-step match: first find a valid ID, then require nearby context words.
      // `allText` is already toLowerCased above, so the ID patterns must use
      // lowercase a/b (the previous version used uppercase A/B and silently
      // never matched — see commit history of v2.1 cleanup).
      // NOTE: Do NOT suggest lookup_knowledge in the message — loading the 41KB template
      // during a correction retry can blow up the session context and prevent report generation
      const validIdPattern = /\b(?:a(?:1[0-8]?|[2-9])|b(?:1[0-2]?|[2-9]))\b/;
      const hasIdWithContext = validIdPattern.test(allText) &&
        /(?:根因|疑似|对应|导致|阻塞|← [ab]\d).{0,30}\b(?:a(?:1[0-8]?|[2-9])|b(?:1[0-2]?|[2-9]))\b|\b(?:a(?:1[0-8]?|[2-9])|b(?:1[0-2]?|[2-9]))\b.{0,30}(?:根因|初始化|阻塞|竞争|开销|加载|压力|节流|干扰|延迟)/i.test(allText);
      if (!hasIdWithContext) {
        issues.push({
          type: 'missing_check',
          severity: 'warning',
          message: '启动分析结论缺少根因编号引用 — 在关键发现中标注根因编号（如 A2: 磁盘IO、B3: 内存压力、A5: DEX加载），便于交叉引用',
        });
      }

      // Extended SR codes (SR09-SR20) acknowledgment when detected
      // No longer requires skill name as precondition — Agent may only mention SR codes
      const hasExtendedSR = /SR(?:09|1[0-9]|20)(?!\d)/i.test(allText);
      if (hasExtendedSR) {
        // SR codes detected — verify conclusion mentions corresponding root causes
        // Primary check: root cause ID (\bA9\b etc.); secondary: domain-specific keywords
        const srToRootCause: Record<string, RegExp> = {
          'SR09': /\bA1\b|ContentProvider.*(?:过多|初始化.*[重慢长])/i,
          'SR10': /\bA9\b|SharedPreference|SP.*(?:阻塞|同步读取)/i,
          'SR11': /\bA17\b|Thread\.sleep|nanosleep|显式.*sleep/i,
          'SR12': /\bA11\b|SDK.*初始化|三方.*初始化/i,
          'SR13': /\bA14\b|native.*(?:库|lib).*(?:加载|耗时)|dlopen/i,
          'SR14': /\bA10\b|WebView.*初始化/i,
          'SR15': /\bA4\b|inflate.*(?:过[重长]|耗时)|布局.*膨胀/i,
          'SR16': /\bB4\b|热节流|thermal.*throttl/i,
          'SR17': /\bB9\b|后台.*干扰|Runnable.*(?:高|>\s*1[0-9])/i,
          'SR18': /\bB7\b|system_server.*(?:锁|contention)/i,
          'SR19': /\bB12\b|并发.*启动|boot.*storm/i,
          'SR20': /\bA8\b|数据库.*(?:IO|阻塞|初始化)|fsync.*(?:阻塞|主线程)/i,
        };
        for (const [sr, pattern] of Object.entries(srToRootCause)) {
          const srRegex = new RegExp(`${sr}(?!\\d)`, 'i');
          if (!srRegex.test(allText)) continue;
          // Skip if the SR code only appears in a negation context (排除/not hit/未命中/可排除)
          const negationPattern = new RegExp(`${sr}(?!\\d).{0,20}(?:not\\s*hit|未命中|可排除|未触发|未检出|无|排除)`, 'i');
          if (negationPattern.test(allText) && !pattern.test(allText)) continue;
          if (!pattern.test(allText)) {
            issues.push({
              type: 'missing_check',
              severity: 'warning',
              message: `${sr} 被检测到但结论中缺少对应根因分析 — 请在结论中解释该 SR code 的根因和影响`,
            });
          }
        }
      }
      break;
    }
    case 'anr': {
      if (!/anr|死锁|deadlock|阻塞|blocked|not responding|binder/.test(allText)) {
        issues.push({
          type: 'missing_check',
          severity: 'warning',
          message: 'ANR 场景分析缺少阻塞/死锁相关内容 — 应包含 ANR 原因定位',
        });
      }
      break;
    }
    case 'teaching': {
      if (!/管线|pipeline|线程|thread|slice|架构|architecture|教学|explain|说明/.test(allText)) {
        issues.push({
          type: 'missing_check',
          severity: 'warning',
          message: '教学场景分析缺少管线/线程/Slice 相关教学内容 — 应包含架构说明和关键概念解释',
        });
      }
      break;
    }
    case 'scroll_response': {
      if (!/响应|response|延迟|latency|首帧|input|输入|dispatch|瓶颈|bottleneck/.test(allText)) {
        issues.push({
          type: 'missing_check',
          severity: 'warning',
          message: '滑动响应场景分析缺少延迟分解内容 — 应包含端到端响应延迟和瓶颈定位',
        });
      }
      break;
    }
    case 'pipeline': {
      if (!/管线|pipeline|架构|architecture|检测|detect|渲染|render/.test(allText)) {
        issues.push({
          type: 'missing_check',
          severity: 'warning',
          message: '管线识别场景分析缺少管线检测内容 — 应包含渲染管线类型和架构图',
        });
      }
      break;
    }
    case 'touch_tracking': {
      if (!/跟手|tracking|input.*display|逐帧|per.frame|延迟|latency|vsync|相位/.test(allText)) {
        issues.push({
          type: 'missing_check',
          severity: 'warning',
          message: '跟手度分析缺少逐帧 Input-to-Display 延迟数据 — 应包含每帧延迟测量和 VSync 相位分析',
        });
      }
      break;
    }
    case 'game': {
      if (!/游戏|game|帧率|fps|unity|unreal|godot|cocos|gpu/.test(allText)) {
        issues.push({
          type: 'missing_check',
          severity: 'warning',
          message: '游戏性能分析缺少游戏引擎或帧率相关内容 — 应包含 FPS 分析和 GPU 状态',
        });
      }
      break;
    }
    case 'memory': {
      if (!/内存|memory|oom|lmk|泄漏|leak|gc|heap|rss|pss/.test(allText)) {
        issues.push({
          type: 'missing_check',
          severity: 'warning',
          message: '内存分析缺少内存指标相关内容 — 应包含内存使用趋势和 GC/LMK 分析',
        });
      }
      break;
    }
    case 'overview': {
      if (!/场景|scene|还原|reconstruct|概览|overview|时间线|timeline|操作/.test(allText)) {
        issues.push({
          type: 'missing_check',
          severity: 'warning',
          message: '场景概览分析缺少还原内容 — 应包含用户操作时间线和场景分类',
        });
      }
      break;
    }
    case 'interaction': {
      if (!/点击|click|tap|touch|响应|response|dispatch|handling|输入/.test(allText)) {
        issues.push({
          type: 'missing_check',
          severity: 'warning',
          message: '交互响应分析缺少点击/触摸延迟内容 — 应包含事件分发和处理延迟分析',
        });
      }
      break;
    }
  }

  return issues;
}

/**
 * Normalize LLM-returned severity to the standard 'error' | 'warning' union.
 * LLMs may return non-standard values like "critical", "high", "medium", "low", "info".
 * Without normalization, these slip through `severity === 'error'` checks and bypass
 * the correction retry logic — this was the root cause of P0-3 (truncation detected
 * but never corrected).
 */
export function normalizeLLMSeverity(raw: string): VerificationIssue['severity'] {
  const lower = (raw ?? '').toLowerCase();
  // Only 'critical' and 'error' map to 'error' (triggers correction retry).
  // 'high' maps to 'warning' — LLMs use 'high' as importance level, not action-required.
  // Mapping 'high' → 'error' caused over-correction: too many ERRORs triggered retries
  // that degraded the conclusion output.
  if (lower === 'error' || lower === 'critical') return 'error';
  return 'warning';
}

/**
 * Attempt to repair truncated JSON arrays from LLM output.
 * Handles common truncation patterns: unclosed strings, missing brackets.
 * Returns best-effort repaired JSON string.
 */
function repairTruncatedJson(json: string): string {
  let s = json.trim();

  // Remove trailing incomplete object (e.g., `{"type": "foo", "mes` → drop it)
  const lastCompleteObj = s.lastIndexOf('}');
  const lastOpenBrace = s.lastIndexOf('{');
  if (lastOpenBrace > lastCompleteObj) {
    // There's an unclosed object — remove everything from the last `{` or preceding `,`
    const cutPoint = s.lastIndexOf(',', lastOpenBrace);
    if (cutPoint > 0) {
      s = s.substring(0, cutPoint);
    } else {
      s = s.substring(0, lastOpenBrace);
    }
  }

  // Close unclosed strings: count quotes
  const quoteCount = (s.match(/(?<!\\)"/g) || []).length;
  if (quoteCount % 2 !== 0) {
    s += '"';
  }

  // Ensure array is closed
  if (!s.trimEnd().endsWith(']')) {
    // Remove trailing comma if any
    s = s.replace(/,\s*$/, '');
    s += ']';
  }

  return s;
}

/**
 * Run LLM-based verification using a lightweight model (haiku).
 * Validates evidence support, severity consistency, and completeness.
 * Returns undefined if LLM call fails (graceful degradation).
 */
export async function verifyWithLLM(
  findings: Finding[],
  conclusion: string,
  options?: { model?: string; timeoutMs?: number },
): Promise<VerificationIssue[] | undefined> {
  // Default 60s; Haiku usually finishes in 2-5s, but slower LLMs need more headroom.
  const VERIFY_TIMEOUT_MS = options?.timeoutMs ?? 60_000;
  try {
    const findingSummary = findings
      .slice(0, 15)
      .map(f => `[${f.severity.toUpperCase()}] ${f.title}: ${f.description?.substring(0, 150) || ''}`)
      .join('\n');

    const conclusionPreview = conclusion.substring(0, 3000);
    const truncationNote = conclusion.length > 3000
      ? '\n\n[... 后续内容已省略以节省验证成本，请仅验证以上部分 ...]'
      : '';

    const prompt = `你是一个 Android 性能分析验证器。请验证以下分析结论的质量。

## 发现列表
${findingSummary}

## 结论
${conclusionPreview}${truncationNote}

## 验证检查项
请逐项检查并仅报告发现的问题（如果全部通过则返回空列表）：
1. 每个 CRITICAL/HIGH 发现是否有具体数据证据（时间戳、数值等）？
2. 严重程度标记是否合理？（如单帧异常不应是 CRITICAL）
3. 是否遗漏了明显的检查项？（如提到掉帧但没分析根因）

**输出格式**：JSON 数组，每项包含 type、severity、message 字段。无问题时返回 []。
\`\`\`json
[{"type": "missing_evidence", "severity": "warning", "message": "..."}]
\`\`\``;

    const stream = sdkQuery({
      prompt,
      options: {
        model: options?.model ?? 'claude-haiku-4-5',
        maxTurns: 1,
        permissionMode: 'bypassPermissions' as const,
        allowDangerouslySkipPermissions: true,
        env: createSdkEnv(),
        stderr: (data: string) => {
          console.warn(`[ClaudeVerifier] SDK stderr: ${data.trimEnd()}`);
        },
      },
    });

    let result = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      console.warn(`[ClaudeVerifier] LLM verification timed out after ${VERIFY_TIMEOUT_MS / 1000}s`);
      try { stream.close(); } catch { /* ignore */ }
    }, VERIFY_TIMEOUT_MS);

    try {
      for await (const msg of stream) {
        if (timedOut) break;
        if (msg.type === 'result' && (msg as any).subtype === 'success') {
          result = (msg as any).result || '';
        }
      }
    } finally {
      clearTimeout(timer);
      try { stream.close(); } catch { /* ignore */ }
    }

    if (timedOut) {
      console.warn('[ClaudeVerifier] Returning undefined due to timeout (graceful degradation)');
      return undefined;
    }

    // Parse JSON from the result. LLM responses may be truncated mid-JSON,
    // so we attempt repair (close unclosed strings/brackets) before giving up.
    // Use greedy match first; fall back to `[` without closing `]` (truncated).
    const jsonMatch = result.match(/\[[\s\S]*\]/) || result.match(/\[[\s\S]+/);
    if (jsonMatch) {
      let jsonStr = jsonMatch[0];
      let parsed: VerificationIssue[];
      try {
        parsed = JSON.parse(jsonStr);
      } catch {
        // Attempt repair: close unclosed strings and brackets
        jsonStr = repairTruncatedJson(jsonStr);
        try {
          parsed = JSON.parse(jsonStr);
        } catch (repairErr) {
          console.warn('[ClaudeVerifier] JSON repair failed:', (repairErr as Error).message);
          return [];
        }
      }
      // LLM may return non-standard severity levels (e.g. "critical", "high", "medium")
      // that don't match the VerificationIssue type union ('error' | 'warning').
      // Normalize to prevent these from silently bypassing the correction retry logic
      // (which filters on severity === 'error').
      return parsed
        .filter(i => i.type && i.message)
        .map(i => ({
          ...i,
          severity: normalizeLLMSeverity(i.severity),
        }));
    }
    return [];
  } catch (err) {
    console.warn('[ClaudeVerifier] LLM verification failed (graceful degradation):', (err as Error).message);
    return undefined;
  }
}

/**
 * Detect whether a conclusion looks like an incomplete/truncated analysis
 * (e.g., just reasoning notes rather than a structured report).
 * Used to select between normal correction prompt and "generate from scratch" prompt.
 */
export function isConclusionIncomplete(conclusion: string): boolean {
  if (conclusion.length < 1000) return true;
  // A proper structured report should have markdown headings
  if (!/##\s/.test(conclusion)) return true;
  return false;
}

/**
 * Generate a correction prompt for reflection-driven retry.
 * Called when verification finds ERROR-level issues.
 *
 * When the original conclusion is clearly incomplete (just reasoning notes,
 * < 1000 chars, no structured headings), generates a stronger prompt that
 * asks for a complete report from scratch using already-collected data.
 */
export function generateCorrectionPrompt(
  issues: VerificationIssue[],
  originalConclusion: string,
  outputLanguage: OutputLanguage = DEFAULT_OUTPUT_LANGUAGE,
): string {
  const errorIssues = issues.filter(i => i.severity === 'error');
  const warningIssues = issues.filter(i => i.severity === 'warning');

  const issueList = errorIssues
    .map((i, idx) => `${idx + 1}. **[ERROR]** ${i.message}`)
    .join('\n');

  const warningList = warningIssues.length > 0
    ? localize(
      outputLanguage,
      '\n\n注意事项:\n' + warningIssues.map(i => `- ${i.message}`).join('\n'),
      '\n\nNotes:\n' + warningIssues.map(i => `- ${i.message}`).join('\n'),
    )
    : '';

  // When the conclusion is just reasoning notes (no structured headings, < 1000 chars),
  // the agent ran out of turns before generating a report. Use a stronger prompt that
  // instructs it to generate the complete report from scratch using collected data.
  if (isConclusionIncomplete(originalConclusion)) {
    if (outputLanguage === 'en') {
      return `## Verification Feedback - Final report was not generated

The analysis has collected enough data, but the final conclusion was not generated yet. The current content only contains reasoning notes.

${issueList ? `Issues to resolve:\n${issueList}\n` : ''}${warningList}

### Requirements
1. Resolve all unfinished bookkeeping first: unresolved hypotheses must call resolve_hypothesis, and unfinished phases must call update_plan_phase.
2. Then output a complete structured analysis report in English, following the system prompt output template:
   - Overview (frame count, jank count, FPS, rating)
   - Full-frame root-cause distribution table aggregated by reason_code
   - Representative-frame analysis for each major root-cause category, including quadrant state, frequency, and causal reasoning chain
   - Optimization suggestions sorted by priority
3. Use the data already collected. Do not rerun invoke_skill just to fetch overview data again.

### Existing Reasoning Context
${originalConclusion.substring(0, 2000)}

Output the complete report directly in English.`;
    }

    return `## 验证反馈 — 分析结论未生成，请输出完整报告

你的分析过程已收集了足够的数据，但**结论尚未生成**（当前仅有推理过程笔记）。

${issueList ? `待解决问题：\n${issueList}\n` : ''}${warningList}

### 要求
1. **先解决所有未完成事项**（未解决的假设请调用 resolve_hypothesis，未完成的阶段请 update_plan_phase）
2. **然后直接输出完整的结构化分析报告**，格式遵循 system prompt 中的输出模板：
   - 概览（帧数、掉帧数、帧率、评级）
   - 全帧根因分布表（按 reason_code 聚合）
   - 代表帧分析（每个根因类别的最严重帧，含四象限+频率+根因推理链）
   - 优化建议（按优先级排序）
3. **使用已收集的数据**，不需要重新调用 invoke_skill 获取概览数据

### 已有推理上下文
${originalConclusion.substring(0, 2000)}

请直接输出完整报告。`;
  }

  if (outputLanguage === 'en') {
    return `## Verification Feedback - Fix the following issues

Your analysis conclusion did not pass quality verification. The following ERROR-level issues must be fixed:

${issueList}${warningList}

### Fix Requirements
1. Re-check the analysis conclusion.
2. Fix every ERROR issue:
   - **missing_evidence**: Add concrete data evidence for CRITICAL/HIGH findings, including timestamps, numbers, or tool results.
   - **plan_deviation**: Execute unfinished plan phases or explicitly explain why they were skipped.
   - **missing_reasoning**: Produce a complete analysis conclusion.
   - **unresolved_hypothesis**: Call resolve_hypothesis and mark every unresolved hypothesis as confirmed or rejected.
3. Output the corrected complete conclusion in English.

### Original Conclusion To Fix
${originalConclusion.substring(0, 2000)}

Output only the corrected conclusion. If extra data is needed, call tools to fetch it.`;
  }

  return `## 验证反馈 — 请修正以下问题

你的分析结论未通过质量验证。以下是需要修正的 ERROR 级别问题：

${issueList}${warningList}

### 修正要求
1. 重新审视你的分析结论
2. 针对每个 ERROR 问题进行修正：
   - **missing_evidence**: 为 CRITICAL/HIGH 发现补充具体数据证据（时间戳、数值、工具调用结果）
   - **plan_deviation**: 执行未完成的计划阶段，或明确说明跳过原因
   - **missing_reasoning**: 补充完整的分析结论
   - **unresolved_hypothesis**: 调用 resolve_hypothesis 将所有未解决假设标记为 confirmed 或 rejected
3. 输出修正后的完整结论

### 原始结论（需修正）
${originalConclusion.substring(0, 2000)}

请直接输出修正后的结论，不要重复描述问题。如需额外数据，可以调用工具获取。`;
}

/**
 * Run full verification pipeline (heuristic + plan adherence + optional LLM).
 * Emits SSE warnings for any issues found.
 * Returns verification result with all issues and whether correction is needed.
 */
export async function verifyConclusion(
  findings: Finding[],
  conclusion: string,
  options: {
    emitUpdate?: (update: StreamingUpdate) => void;
    enableLLM?: boolean;
    plan?: AnalysisPlanV3 | null;
    hypotheses?: Hypothesis[];
    sceneType?: SceneType;
    /** Override model for the LLM verification call. Defaults to 'claude-haiku-4-5'. */
    lightModel?: string;
    /** Override verification LLM timeout (ms). Default: 60s. Raise for slower light models. */
    verifierTimeoutMs?: number;
    /** User-facing output language for verifier progress messages. */
    outputLanguage?: OutputLanguage;
  } = {},
): Promise<VerificationResult> {
  const startTime = Date.now();
  const { emitUpdate, enableLLM = true, plan, hypotheses, sceneType } = options;
  const outputLanguage = options.outputLanguage ?? DEFAULT_OUTPUT_LANGUAGE;

  // Layer 1: Heuristic checks
  const heuristicIssues = verifyHeuristic(findings, conclusion);

  // Layer 2: Plan adherence check
  const planIssues = verifyPlanAdherence(plan ?? null);
  heuristicIssues.push(...planIssues);

  // Layer 2.5: Hypothesis resolution check (P0-G4)
  if (hypotheses && hypotheses.length > 0) {
    const hypothesisIssues = verifyHypotheses(hypotheses);
    heuristicIssues.push(...hypothesisIssues);
  }

  // Layer 2.7: Scene completeness check (P1-G15)
  if (sceneType && sceneType !== 'general') {
    const sceneIssues = verifySceneCompleteness(sceneType, findings, conclusion);
    heuristicIssues.push(...sceneIssues);
  }

  // Layer 3: LLM verification (conditional skip — Phase 1-B optimization)
  // Skip when all heuristic/plan/hypothesis checks pass cleanly.
  // Match on issue `type` (not message text) — robust against message rewording.
  const HIGH_RISK_ISSUE_TYPES = new Set(['missing_evidence', 'missing_reasoning', 'severity_mismatch', 'truncation']);

  const hasErrors = heuristicIssues.some(i => i.severity === 'error');
  const hasHighRiskWarnings = heuristicIssues.some(i =>
    i.severity === 'warning' && HIGH_RISK_ISSUE_TYPES.has(i.type)
  );
  const evidenceCount = findings.filter(f => f.description && f.description.length > 50).length;
  const hasEnoughEvidence = evidenceCount >= 3;
  const hasCrossArtifactReasoning = conclusion.includes('对比') || conclusion.includes('综合') ||
    (conclusion.match(/art-\d+/g) || []).length > 3;

  const canSkipLLM = !hasErrors && !hasHighRiskWarnings && hasEnoughEvidence && !hasCrossArtifactReasoning;

  let llmIssues: VerificationIssue[] | undefined;
  if (enableLLM && !canSkipLLM) {
    llmIssues = await verifyWithLLM(findings, conclusion, { model: options.lightModel, timeoutMs: options.verifierTimeoutMs });
  } else if (enableLLM && canSkipLLM) {
    console.log(
      `[Verifier] LLM verification skipped: errors=${hasErrors}, highRiskWarnings=${hasHighRiskWarnings}, ` +
      `evidenceCount=${evidenceCount}, crossArtifact=${hasCrossArtifactReasoning}`,
    );
  }

  const allIssues = [...heuristicIssues, ...(llmIssues || [])];
  const passed = allIssues.filter(i => i.severity === 'error').length === 0;

  // P2-G14: Learn from LLM verification results (fire-and-forget)
  if (llmIssues && llmIssues.length > 0) {
    try { learnFromVerificationResults(llmIssues, findings); } catch { /* non-fatal */ }
  }

  // Emit SSE warnings for issues
  if (emitUpdate && allIssues.length > 0) {
    const issueMessages = allIssues
      .map(i => `[${i.severity.toUpperCase()}] ${i.message}`)
      .join('\n');
    emitUpdate({
      type: 'progress',
      content: {
        phase: 'concluding',
        message: localize(
          outputLanguage,
          `验证发现 ${allIssues.length} 个问题:\n${issueMessages}`,
          `Verification found ${allIssues.length} issue(s):\n${issueMessages}`,
        ),
      },
      timestamp: Date.now(),
    });
  }

  return {
    passed,
    heuristicIssues,
    llmIssues,
    durationMs: Date.now() - startTime,
  };
}
