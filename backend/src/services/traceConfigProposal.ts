// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import { createHash } from 'crypto';
import {
  getCapturePreset,
  isConcreteCaptureApp,
  renderAndroidTraceConfig,
  resolveCaptureBufferSizeKb,
  resolveCaptureDataSources,
  type CapturePresetDefinition,
  type CapturePresetId,
} from './traceCaptureConfig';
import { localize, parseOutputLanguage, type OutputLanguage } from '../agentv3/outputLanguage';

export type TraceConfigProposalConfidence = 'high' | 'medium' | 'low';

export interface TraceConfigProposalInput {
  request: string;
  app?: string;
  durationSeconds?: number;
  categories?: string[];
  cuj?: string;
  outputLanguage?: OutputLanguage;
  now?: Date;
}

export interface TraceConfigProposalCommand {
  config: string[];
  capture: string[];
}

export interface TraceConfigProposalV1 {
  schemaVersion: 1;
  proposalId: string;
  createdAt: string;
  source: 'deterministic';
  target: 'android';
  request: string;
  app: string;
  preset: CapturePresetId;
  presetLabel: string;
  intent: CapturePresetDefinition['intent'];
  confidence: TraceConfigProposalConfidence;
  rationale: string[];
  warnings: string[];
  blockedDangerousOptions: string[];
  command: TraceConfigProposalCommand;
  config: {
    textproto: string;
    dataSources: string[];
    ftraceEvents: string[];
    atraceCategories: string[];
    durationSeconds: number;
    bufferSizeKb: number;
  };
}

interface IntentRule {
  preset: CapturePresetId;
  confidence: TraceConfigProposalConfidence;
  requiredKeywords?: string[];
  keywords: string[];
}

interface RuleMatch {
  rule: IntentRule;
  score: number;
  matches: string[];
}

const INTENT_RULES: IntentRule[] = [
  {
    preset: 'camera',
    confidence: 'high',
    requiredKeywords: [
      'camera', 'camera2', 'camerax', 'cameraserver', 'camera hal',
      '摄像头', '相机', '取景器',
    ],
    keywords: [
      'open camera', 'camera open', 'camera startup', 'first preview',
      'preview frame', 'capture request', 'capture result', 'hal3',
      '打开相机', '相机启动', '首帧预览', '预览首帧', '拍照延迟',
    ],
  },
  {
    preset: 'startup',
    confidence: 'high',
    keywords: [
      'startup',
      'start up',
      'cold start',
      'launch',
      'first frame',
      'first-frame',
      'app start',
      '启动',
      '冷启动',
      '首帧',
      '打开应用',
    ],
  },
  {
    preset: 'scrolling',
    confidence: 'high',
    keywords: [
      'scroll',
      'scrolling',
      'jank',
      'frame',
      'dropped frame',
      'stutter',
      'fling',
      '滑动',
      '滚动',
      '卡顿',
      '掉帧',
      '帧率',
    ],
  },
  {
    preset: 'anr',
    confidence: 'high',
    keywords: [
      'anr',
      'not responding',
      'input timeout',
      'main thread block',
      'main-thread block',
      '主线程',
      '无响应',
      '卡死',
    ],
  },
  {
    // Heap dumps profile one process, so this needs --app; without one the
    // proposal keeps the system-wide memory preset. Bare "leak" stays on the
    // memory rule: wakelock, fd, and binder leaks are not heap questions.
    preset: 'memory-profile',
    confidence: 'high',
    requiredKeywords: [
      'heap dump', 'heapdump', 'hprof', 'java heap', 'heap graph',
      'heap profile', 'heapprofd', 'memory leak', 'heap leak', 'leakcanary',
      '内存泄漏', '内存泄露', '堆转储', '堆快照', 'java 堆', 'java堆',
    ],
    keywords: [
      'native heap', 'allocation', 'retained', 'dominator', 'growth',
      '分配', '增长', '持续上涨',
    ],
  },
  {
    preset: 'memory',
    confidence: 'high',
    keywords: [
      'memory',
      'mem',
      'heap',
      'gc',
      'lmk',
      'oom',
      'leak',
      '内存',
      '泄漏',
      '回收',
    ],
  },
  {
    preset: 'power',
    confidence: 'high',
    keywords: [
      'power',
      'battery',
      'battery drain',
      'thermal',
      'wakelock',
      'wake lock',
      'energy',
      '耗电',
      '电量',
      '功耗',
      '温度',
      '发热',
      '限频',
      '降频',
      '温控',
      'throttling',
      'frequency limit',
    ],
  },
  {
    preset: 'game',
    confidence: 'medium',
    keywords: [
      'gpu',
      'render',
      'rendering',
      'game',
      'surfaceflinger',
      'hwc',
      '游戏',
      '渲染',
      '图形',
    ],
  },
  {
    preset: 'cpu',
    confidence: 'medium',
    keywords: [
      'cpu',
      'scheduler',
      'sched',
      'thread state',
      'blocked reason',
      '线程',
      '调度',
    ],
  },
  {
    preset: 'full',
    confidence: 'medium',
    keywords: [
      'full diagnostic',
      'everything',
      'all signals',
      'maximum coverage',
      'comprehensive',
      '全量',
      '全部',
      '完整',
    ],
  },
  {
    preset: 'overview',
    confidence: 'medium',
    keywords: [
      'overview',
      'generic',
      'general',
      'first pass',
      'not sure',
      '默认',
      '通用',
      '先看一下',
    ],
  },
];

const DOMAIN_MATCH_BONUS = Math.max(
  ...INTENT_RULES
    .filter(rule => !rule.requiredKeywords)
    .map(rule => rule.keywords.length),
) + 1;

const DANGEROUS_OPTION_PATTERNS: Array<{
  option: string;
  pattern: RegExp;
  warningZh: string;
  warningEn: string;
}> = [
  {
    option: 'no_guardrails',
    pattern: /\b(no[- ]?guardrails|disable guardrails|without guardrails)\b/i,
    warningZh: '请求提到了禁用 guardrails；该提案会保持 guardrails 启用。',
    warningEn: 'Request mentioned disabling guardrails; the proposal keeps guardrails enabled.',
  },
  {
    option: 'kill_stale',
    pattern: /\b(kill stale|kill perfetto|kill traced|force kill)\b/i,
    warningZh: '请求提到了终止残留 tracing 进程；该提案不会包含 --kill-stale。',
    warningEn: 'Request mentioned killing stale tracing processes; the proposal does not include --kill-stale.',
  },
  {
    option: 'sideload_tracebox',
    pattern: /\b(sideload|tracebox)\b/i,
    warningZh: '请求提到了 sideload tracebox；该提案会把 sideload 保留为录制时的显式选择。',
    warningEn: 'Request mentioned sideloading tracebox; the proposal leaves sideloading as an explicit capture-time choice.',
  },
];

export function buildTraceConfigProposal(input: TraceConfigProposalInput): TraceConfigProposalV1 {
  const outputLanguage = input.outputLanguage ?? parseOutputLanguage(process.env.SMARTPERFETTO_OUTPUT_LANGUAGE);
  const request = normalizeRequest(input.request);
  if (!request) {
    throw new Error('request is required');
  }

  const match = classifyRequest(request);
  const app = normalizeApp(input.app);
  const matchedPreset = getCapturePreset(match.rule.preset);
  // An app-profile preset needs one concrete app; without it the proposal
  // uses the preset's system-wide fallback so it still renders a valid config.
  const needsAppFallback = Boolean(matchedPreset.requirements) && !isConcreteCaptureApp(app);
  const preset = needsAppFallback && matchedPreset.requirements
    ? getCapturePreset(matchedPreset.requirements.appFallbackPreset)
    : matchedPreset;
  const requestedDurationSeconds = normalizeDuration(input.durationSeconds, preset.defaultDurationSeconds);
  const durationSeconds = Math.max(requestedDurationSeconds, preset.requirements?.minDurationSeconds ?? 0);
  const categories = normalizeCategories(input.categories);
  const dataSources = resolveCaptureDataSources(preset, { packageName: app, cuj: input.cuj });
  const bufferSizeKb = resolveCaptureBufferSizeKb(preset, durationSeconds);
  const blockedDangerousOptions = detectDangerousOptions(request);
  const warnings = buildWarnings({
    request,
    app,
    preset,
    blockedDangerousOptions,
    outputLanguage,
  });
  if (durationSeconds !== requestedDurationSeconds) {
    warnings.push(localize(
      outputLanguage,
      `${preset.id} 至少需要 ${durationSeconds} 秒，采集时长已从 ${requestedDurationSeconds} 秒调整为 ${durationSeconds} 秒。`,
      `${preset.id} needs at least ${durationSeconds} s; the capture duration was raised from ${requestedDurationSeconds} s to ${durationSeconds} s.`,
    ));
  }
  const textproto = renderAndroidTraceConfig({
    target: 'android',
    preset: preset.id,
    app,
    durationSeconds,
    extraAtraceCategories: categories,
    cuj: input.cuj,
  });
  const createdAt = (input.now ?? new Date()).toISOString();
  const proposalSeed = JSON.stringify({
    request,
    app,
    preset: preset.id,
    durationSeconds,
    categories,
    cuj: input.cuj ?? '',
  });

  return {
    schemaVersion: 1,
    proposalId: `tcp_${createHash('sha256').update(proposalSeed).digest('hex').slice(0, 16)}`,
    createdAt,
    source: 'deterministic',
    target: 'android',
    request,
    app,
    preset: preset.id,
    presetLabel: preset.label,
    intent: preset.intent,
    confidence: needsAppFallback ? 'medium' : confidenceForMatch(match),
    rationale: [
      rationaleForPreset(preset, outputLanguage),
      ...(needsAppFallback
        ? [localize(
            outputLanguage,
            `请求匹配 ${matchedPreset.id}，它只剖析一个明确的 app 进程；未提供具体的 --app，因此回退到系统级 ${preset.id} 预设。传入 --app <package> 才能使用 ${matchedPreset.id}。`,
            `The request matches ${matchedPreset.id}, which profiles one concrete app process; no concrete --app was given, so the proposal falls back to the system-wide ${preset.id} preset. Pass --app <package> to use ${matchedPreset.id}.`,
          )]
        : []),
      localize(
        outputLanguage,
        `匹配 ${match.matches.length} 个关键词：${match.matches.join(', ') || 'fallback overview'}。`,
        `Matched ${match.matches.length} keyword(s): ${match.matches.join(', ') || 'fallback overview'}.`,
      ),
      localize(
        outputLanguage,
        '该提案没有副作用，只渲染 Perfetto textproto 预览。',
        'The proposal is side-effect free and only renders a Perfetto textproto preview.',
      ),
    ],
    warnings,
    blockedDangerousOptions,
    command: buildCommands({
      preset: preset.id,
      app,
      durationSeconds,
      categories,
      cuj: input.cuj,
    }),
    config: {
      textproto,
      dataSources,
      ftraceEvents: [...preset.ftraceEvents],
      atraceCategories: unique([...preset.atraceCategories, ...categories]),
      durationSeconds,
      bufferSizeKb,
    },
  };
}

// The preset definition is the single source for what a capture covers; the
// proposal rationale is that description, not a second hand-written copy.
function rationaleForPreset(preset: CapturePresetDefinition, outputLanguage: OutputLanguage): string {
  return localize(outputLanguage, preset.descriptionZh, preset.description);
}

function normalizeRequest(value: string): string {
  return value.trim().replace(/\s+/g, ' ');
}

function normalizeApp(value: string | undefined): string {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : '*';
}

function normalizeDuration(value: number | undefined, fallback: number): number {
  const duration = value ?? fallback;
  if (!Number.isFinite(duration) || duration <= 0) {
    throw new Error('durationSeconds must be a positive number');
  }
  return duration;
}

function normalizeCategories(values: string[] | undefined): string[] {
  return unique((values ?? []).map(value => value.trim()).filter(Boolean));
}

function classifyRequest(request: string): RuleMatch {
  const normalized = request.toLowerCase();
  let best: RuleMatch | undefined;
  for (const rule of INTENT_RULES) {
    const requiredMatches = (rule.requiredKeywords ?? [])
      .filter(keyword => normalized.includes(keyword.toLowerCase()));
    if (rule.requiredKeywords && requiredMatches.length === 0) continue;
    const keywordMatches = rule.keywords
      .filter(keyword => normalized.includes(keyword.toLowerCase()));
    const matches = unique([...requiredMatches, ...keywordMatches]);
    const score = keywordMatches.length
      + (requiredMatches.length > 0 ? DOMAIN_MATCH_BONUS : 0);
    if (!best || score > best.score) {
      best = { rule, score, matches };
    }
  }
  if (best && best.score > 0) return best;
  const overview = INTENT_RULES[INTENT_RULES.length - 1];
  return { rule: overview, score: 0, matches: [] };
}

function confidenceForMatch(match: RuleMatch): TraceConfigProposalConfidence {
  if (match.score === 0) return 'low';
  return match.rule.confidence;
}

function detectDangerousOptions(request: string): string[] {
  return DANGEROUS_OPTION_PATTERNS
    .filter(entry => entry.pattern.test(request))
    .map(entry => entry.option);
}

function buildWarnings(input: {
  request: string;
  app: string;
  preset: CapturePresetDefinition;
  blockedDangerousOptions: string[];
  outputLanguage: OutputLanguage;
}): string[] {
  const warnings: string[] = [];
  if (input.app === '*') {
    warnings.push(localize(
      input.outputLanguage,
      '未提供 app 包名；生成的配置会用 atrace_apps: "*" 覆盖所有 app。',
      'No app package was provided; generated config targets all apps with atrace_apps: "*".',
    ));
  }
  for (const note of input.preset.requirements?.notes ?? []) {
    warnings.push(localize(input.outputLanguage, note.zh, note.en));
  }
  if (input.preset.id === 'full') {
    warnings.push(localize(
      input.outputLanguage,
      'Full diagnostic capture 开销较高；调查目标明确时优先使用更窄的 preset。',
      'Full diagnostic capture is high overhead; prefer a narrower preset when the investigation target is known.',
    ));
  }
  for (const entry of DANGEROUS_OPTION_PATTERNS) {
    if (input.blockedDangerousOptions.includes(entry.option)) {
      warnings.push(localize(input.outputLanguage, entry.warningZh, entry.warningEn));
    }
  }
  if (/\b(all categories|every category|all atrace|全部分类)\b/i.test(input.request)) {
    warnings.push(localize(
      input.outputLanguage,
      '请求提到了宽泛 atrace categories；除非显式传入 --categories，否则提案会使用所选 preset 的 categories。',
      'Request mentioned broad atrace categories; the proposal uses the selected preset categories unless --categories is provided explicitly.',
    ));
  }
  return warnings;
}

function buildCommands(input: {
  preset: CapturePresetId;
  app: string;
  durationSeconds: number;
  categories: string[];
  cuj?: string;
}): TraceConfigProposalCommand {
  const commonArgs = [
    '--preset',
    input.preset,
    '--app',
    input.app,
    '--duration',
    String(input.durationSeconds),
    ...(input.cuj ? ['--cuj', input.cuj] : []),
    ...input.categories.flatMap(category => ['--categories', category]),
  ];
  return {
    config: ['smp', 'capture', 'config', ...commonArgs],
    capture: ['smp', 'capture', 'android', ...commonArgs, '--out', '<trace.perfetto-trace>'],
  };
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}
