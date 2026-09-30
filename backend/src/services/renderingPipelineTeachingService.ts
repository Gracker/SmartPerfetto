// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {loadCriticalPathChain} from './criticalPathAnalyzer';
import { warningText } from './criticalPathText';
import { resolveDirectWaker, type WakerChainResult } from './criticalPathWakerChain';
import { getPipelineDocService } from './pipelineDocService';
import {
  ensurePipelineSkillsInitialized,
  pipelineSkillLoader,
  type PinInstruction,
} from './pipelineSkillLoader';
import { SkillExecutor } from './skillEngine/skillExecutor';
import { ensureSkillRegistryInitialized, skillRegistry } from './skillEngine/skillLoader';
import type { SkillExecutionResult, StepResult } from './skillEngine/types';
import {
  getTraceProcessorService,
  type TraceProcessorService,
} from './traceProcessorService';
import {
  assertQuerySucceeded,
  rowsToObjects,
  nsToMs,
  toNumber,
  toOptionalString,
} from '../utils/traceProcessorRowUtils';
import {
  parseCandidates,
  parseFeatures,
  transformPinInstruction,
  validateActiveProcesses,
  validateConfidence,
  type ActiveProcess,
  type ObservedFlow,
  type ObservedFlowCriticalTask,
  type ObservedFlowDependency,
  type ObservedFlowEvent,
  type ObservedFlowLane,
  type ObservedFlowLaneRole,
  type ObservedFlowTrackHint,
  type PipelineDetectionResult,
  type PinInstructionResponse,
  type RawPinInstruction,
  type RenderingPipelineSubvariants,
  type TeachingContentResponse,
  type TeachingDetectionResponse,
  type TeachingOverlayPlan,
  type TeachingPipelineRequest,
  type TeachingPipelineResponse,
  type TeachingPinPlan,
  type TeachingWarning,
} from '../types/teaching.types';
import {
  TEACHING_DEFAULTS,
  TEACHING_LIMITS,
  TEACHING_STEP_IDS,
} from '../config/teaching.config';
import type {CriticalPathSegment} from '../types/criticalPathContract';

interface PipelineBundle {
  detection: PipelineDetectionResult;
  teachingContent: TeachingContentResponse | null;
  pinInstructions: PinInstructionResponse[];
  activeRenderingProcesses: ActiveProcess[];
  docPath: string;
}

interface DetectionBundleResult {
  bundle: PipelineBundle;
  subvariants: RenderingPipelineSubvariants;
  warnings: TeachingWarning[];
}

interface ObservedFlowBuildResult {
  observedFlow: ObservedFlow;
  queryWarnings: string[];
}

interface CriticalTaskBuildResult {
  criticalTasks: ObservedFlowCriticalTask[];
  warnings: string[];
}

interface TimeRange {
  startTs: number;
  endTs: number;
  source: string;
}

interface ObservedEventRow {
  ts: number;
  dur: number;
  name: string;
  trackId?: number;
  utid?: number;
  upid?: number;
  threadName?: string;
  processName?: string;
  stage: string;
}

/** The thread_state row a rendering event is attributed to: the row it overlaps most. */
interface RootStateRow {
  eventId: string;
  eventLaneId?: string;
  threadStateId?: number;
  ts: number;
  dur: number;
  utid?: number;
  state?: string;
  threadName?: string;
  processName?: string;
}

const DEFAULT_SUBVARIANTS: RenderingPipelineSubvariants = {
  buffer_mode: 'UNKNOWN',
  flutter_engine: 'N/A',
  webview_mode: 'N/A',
  game_engine: 'N/A',
};

const OBSERVED_SOURCE_PRIORITY = [
  'selection',
  'visible_window',
  'package_or_process_hint',
  'active_rendering_process_fallback',
];

const DEFAULT_KEY_SLICE_NAMES = [
  'Choreographer#doFrame',
  'performTraversals',
  'DrawFrame',
  'syncFrameState',
  'dequeueBuffer',
  'queueBuffer',
  'BLASTBufferQueue',
  'setTransactionState',
  'applyTransaction',
  'latchBuffer',
  'eglSwapBuffers',
  'vkQueuePresent',
  'DrawGL',
  'DrawFunctor',
  'onMessageReceived',
  'FrameTimeline',
  'present',
  'HWC',
];

const POINT_SELECTION_CONTEXT_NS = 50_000_000;
const MAX_CRITICAL_TASK_ROOTS = 6;
const MAX_CRITICAL_PATH_SEGMENTS_PER_ROOT = 12;
const MAX_CRITICAL_TASKS = 40;

const PRODUCER_PIPELINE_PATTERNS: Array<{
  test: RegExp;
  title: string;
  role: ObservedFlowLaneRole;
}> = [
  { test: /WEBVIEW|CHROME/i, title: 'WebView/Chromium producer', role: 'producer' },
  { test: /FLUTTER|IMPELLER/i, title: 'Flutter producer', role: 'producer' },
  { test: /RN_|REACT_NATIVE|SKIA_RENDERER/i, title: 'React Native producer', role: 'producer' },
  { test: /TEXTUREVIEW/i, title: 'TextureView producer', role: 'producer' },
  { test: /SURFACEVIEW/i, title: 'SurfaceView producer', role: 'producer' },
  { test: /OPENGL|VULKAN|ANGLE|GAME/i, title: 'GL/Vulkan producer', role: 'producer' },
  { test: /CAMERA|VIDEO|IMAGEREADER|HARDWARE_BUFFER/i, title: 'Media producer', role: 'producer' },
];

function teachingWarning(
  code: string,
  severity: TeachingWarning['severity'],
  message: string,
  source: TeachingWarning['source']
): TeachingWarning {
  return { code, severity, message, source };
}

function sqlLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function sqlLikeLiteral(value: string): string {
  return sqlLiteral(`%${value.replace(/[\\%_]/g, (match) => `\\${match}`)}%`);
}

function safeNumber(value: unknown): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const parsed = toNumber(value, Number.NaN);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function normalizeSubvariants(rawResults: Record<string, StepResult> | undefined): RenderingPipelineSubvariants {
  const step = rawResults?.subvariants;
  const row = Array.isArray(step?.data) && step.data.length > 0
    ? (step.data[0] as Record<string, unknown>)
    : null;
  if (!row) return DEFAULT_SUBVARIANTS;
  return {
    buffer_mode: String(row.buffer_mode ?? DEFAULT_SUBVARIANTS.buffer_mode),
    flutter_engine: String(row.flutter_engine ?? DEFAULT_SUBVARIANTS.flutter_engine),
    webview_mode: String(row.webview_mode ?? DEFAULT_SUBVARIANTS.webview_mode),
    game_engine: String(row.game_engine ?? DEFAULT_SUBVARIANTS.game_engine),
  };
}

function normalizeActiveProcesses(raw: unknown): ActiveProcess[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((row) => {
      const item = row as Record<string, unknown>;
      const processName = String(item.processName ?? item.process_name ?? item.name ?? '').trim();
      if (!processName) return null;
      return {
        upid: toNumber(item.upid, 0),
        processName,
        frameCount: toNumber(item.frameCount ?? item.frame_count ?? item.count, 0),
        renderThreadTid: toNumber(item.renderThreadTid ?? item.render_thread_tid ?? item.tid, 0),
      };
    })
    .filter((value): value is ActiveProcess => value !== null);
}

function normalizePinInstructions(raw: unknown): PinInstructionResponse[] {
  if (!Array.isArray(raw)) return [];
  const instructions: PinInstructionResponse[] = [];
  for (const row of raw) {
    const item = row as Record<string, unknown>;
    const pattern = toOptionalString(item.pattern);
    const matchBy = toOptionalString(item.matchBy ?? item.match_by);
    const reason = toOptionalString(item.reason);
    if (!pattern || !matchBy || !reason) continue;

    const instruction: PinInstructionResponse = {
      pattern,
      matchBy: matchBy as PinInstructionResponse['matchBy'],
      priority: toNumber(item.priority, 0),
      reason,
    };
    if (item.expand !== undefined) {
      instruction.expand = Boolean(item.expand);
    }
    if (item.mainThreadOnly !== undefined || item.main_thread_only !== undefined) {
      instruction.mainThreadOnly = Boolean(item.mainThreadOnly ?? item.main_thread_only);
    }
    if (item.smartPin !== undefined) {
      instruction.smartPin = Boolean(item.smartPin);
    }
    if (item.skipPin !== undefined) {
      instruction.skipPin = Boolean(item.skipPin);
    }
    if (Array.isArray(item.activeProcessNames)) {
      instruction.activeProcessNames = item.activeProcessNames.map((name) => String(name));
    }
    instructions.push(instruction);
  }
  return instructions;
}

function buildDetectionResponse(
  detection: PipelineDetectionResult,
  subvariants: RenderingPipelineSubvariants
): TeachingDetectionResponse {
  const renderingType = pipelineSkillLoader.getRenderingType(detection.primaryRenderingTypeId);
  return {
    detected: detection.detected,
    primaryPipelineId: detection.primaryPipelineId,
    primaryRenderingTypeId: detection.primaryRenderingTypeId,
    primaryConfidence: detection.primaryConfidence,
    primary_pipeline: {
      id: detection.primaryPipelineId,
      confidence: detection.primaryConfidence,
    },
    renderingType: {
      id: detection.primaryRenderingTypeId,
      docPath: renderingType
        ? `rendering_pipelines/${renderingType.document}`
        : pipelineSkillLoader.getDefaultSelection().docPath,
    },
    candidates: detection.candidates,
    renderingTypeCandidates: detection.renderingTypeCandidates,
    relatedRenderingTypes: detection.relatedRenderingTypes,
    features: detection.features,
    subvariants,
    traceRequirementsMissing: detection.traceRequirementsMissing,
    trace_requirements_missing: detection.traceRequirementsMissing,
  };
}

function fallbackTeachingContent(primaryPipelineId: string, docPath: string): TeachingContentResponse {
  return {
    title: `渲染管线: ${primaryPipelineId}`,
    summary: '未找到对应的文档内容。',
    mermaidBlocks: [],
    threadRoles: [],
    keySlices: [],
    docPath,
  };
}

function normalizeKeySliceName(name: string): string {
  return name
    .replace(/\s*\((hint|optional|可选).*?\)\s*/gi, '')
    .trim();
}

function collectKeySliceNames(teachingContent: TeachingContentResponse | null): string[] {
  const names = new Set<string>();
  for (const name of DEFAULT_KEY_SLICE_NAMES) {
    names.add(normalizeKeySliceName(name));
  }
  for (const name of teachingContent?.keySlices || []) {
    const normalized = normalizeKeySliceName(String(name));
    if (normalized) names.add(normalized);
  }
  return Array.from(names).filter(Boolean);
}

function extractTimeRange(input: TeachingPipelineRequest): TimeRange | undefined {
  const selection = input.selectionContext || {};
  const visibleWindow = input.visibleWindow || {};

  const selectionStart = safeNumber(selection.startTs ?? selection.start ?? selection.ts);
  const selectionDur = safeNumber(selection.dur ?? selection.duration);
  const selectionEnd = safeNumber(selection.endTs ?? selection.end);
  if (selectionStart !== undefined && (selectionEnd !== undefined || selectionDur !== undefined)) {
    const rawEnd = selectionEnd ?? selectionStart + Math.max(selectionDur || 0, 0);
    return {
      startTs: selectionStart,
      endTs: rawEnd > selectionStart ? rawEnd : selectionStart + POINT_SELECTION_CONTEXT_NS,
      source: 'selection',
    };
  }

  const visibleStart = safeNumber(
    visibleWindow.startTs ?? visibleWindow.start ?? visibleWindow.visibleStartTs ?? visibleWindow.visibleStart
  );
  const visibleEnd = safeNumber(
    visibleWindow.endTs ?? visibleWindow.end ?? visibleWindow.visibleEndTs ?? visibleWindow.visibleEnd
  );
  if (visibleStart !== undefined && visibleEnd !== undefined && visibleEnd > visibleStart) {
    return { startTs: visibleStart, endTs: visibleEnd, source: 'visible_window' };
  }

  const requestStart = safeNumber(input.startTs);
  const requestEnd = safeNumber(input.endTs);
  if (requestStart !== undefined && requestEnd !== undefined && requestEnd > requestStart) {
    return { startTs: requestStart, endTs: requestEnd, source: 'request' };
  }

  return undefined;
}

function stageFromRow(row: Record<string, unknown>): string {
  const stage = toOptionalString(row.stage);
  if (stage) return stage;
  const name = String(row.name ?? '').toLowerCase();
  const threadName = String(row.thread_name ?? '').toLowerCase();
  const processName = String(row.process_name ?? '').toLowerCase();
  if (name.includes('choreographer') || name.includes('traversal')) return 'app_frame';
  if (threadName === 'renderthread' || name.includes('drawframe') || name.includes('syncframestate')) {
    return 'render_thread';
  }
  if (name.includes('queuebuffer') || name.includes('blast') || name.includes('transaction')) {
    return 'buffer_queue_transaction';
  }
  if (processName.includes('surfaceflinger') || name.includes('latchbuffer')) {
    return 'surfaceflinger_composition';
  }
  if (threadName.includes('hwc') || name.includes('present')) return 'present';
  return 'producer';
}

function roleForStage(stage: string, processName?: string, threadName?: string): ObservedFlowLaneRole {
  const processLower = (processName || '').toLowerCase();
  const threadLower = (threadName || '').toLowerCase();
  if (stage === 'app_frame') return 'app';
  if (stage === 'render_thread') return 'render_thread';
  if (stage === 'buffer_queue_transaction') return 'buffer_queue';
  if (stage === 'surfaceflinger_composition') return 'surfaceflinger';
  if (stage === 'present') return 'hwc_present';
  if (processLower.includes('surfaceflinger')) return 'surfaceflinger';
  if (threadLower.includes('hwc')) return 'hwc_present';
  return 'producer';
}

function laneIdFor(role: ObservedFlowLaneRole, processName?: string, threadName?: string, suffix?: string): string {
  const stable = [role, processName, threadName, suffix]
    .filter(Boolean)
    .join(':')
    .replace(/[^a-zA-Z0-9_-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toLowerCase();
  return stable || role;
}

function laneTitle(role: ObservedFlowLaneRole, processName?: string, threadName?: string): string {
  if (role === 'app') return `${processName || 'App'} main`;
  if (role === 'render_thread') return `${processName || 'App'} RenderThread`;
  if (role === 'buffer_queue') return 'BufferQueue / Transaction';
  if (role === 'surfaceflinger') return 'SurfaceFlinger';
  if (role === 'hwc_present') return 'HWC / present';
  if (role === 'critical_task') return `Critical task: ${threadName || processName || 'scheduler edge'}`;
  return threadName || processName || 'Producer';
}

function makeTrackHint(
  role: ObservedFlowLaneRole,
  processName?: string,
  threadName?: string
): ObservedFlowTrackHint | undefined {
  if (threadName) {
    return {
      matchBy: 'thread',
      pattern: threadName,
      processName,
      threadName,
      mainThreadOnly: role === 'app',
    };
  }
  if (processName) {
    return {
      matchBy: 'process',
      pattern: processName,
      processName,
    };
  }
  if (role === 'surfaceflinger') {
    return { matchBy: 'process', pattern: 'surfaceflinger', processName: 'surfaceflinger' };
  }
  return undefined;
}

function sortLaneRole(role: ObservedFlowLaneRole): number {
  return {
    app: 0,
    render_thread: 1,
    producer: 2,
    buffer_queue: 3,
    surfaceflinger: 4,
    hwc_present: 5,
    critical_task: 6,
    unknown: 7,
  }[role];
}

function sameLaneOwner(
  lane: ObservedFlowLane,
  processName?: string,
  threadName?: string
): boolean {
  return lane.processName === processName && lane.threadName === threadName;
}

function taskOwnerLabel(task: ObservedFlowCriticalTask): string {
  return [task.processName, task.threadName].filter(Boolean).join(' / ') || task.name || 'critical task';
}

export class RenderingPipelineTeachingService {
  constructor(
    private readonly traceProcessorService: TraceProcessorService = getTraceProcessorService()
  ) {}

  async analyze(input: TeachingPipelineRequest): Promise<TeachingPipelineResponse> {
    const detectionBundle = await this.loadDetectionBundle(input);
    const detection = buildDetectionResponse(
      detectionBundle.bundle.detection,
      detectionBundle.subvariants
    );
    const teachingContent =
      detectionBundle.bundle.teachingContent ||
      fallbackTeachingContent(detection.primaryPipelineId, detectionBundle.bundle.docPath);
    const observed = await this.buildObservedFlow(input, detectionBundle.bundle, detection);
    const pinPlan = this.buildPinPlan(detectionBundle.bundle.pinInstructions, observed.observedFlow);
    const overlayPlan = this.buildOverlayPlan(teachingContent, observed.observedFlow);
    const warnings = this.buildWarnings(
      detectionBundle,
      observed.observedFlow,
      observed.queryWarnings,
      teachingContent,
      pinPlan,
      overlayPlan
    );

    return {
      success: true,
      schemaVersion: 'teaching.pipeline.v2',
      detection,
      observedFlow: observed.observedFlow,
      teaching: teachingContent,
      teachingContent,
      pinPlan,
      overlayPlan,
      warnings,
      pinInstructions: detectionBundle.bundle.pinInstructions,
      activeRenderingProcesses: detectionBundle.bundle.activeRenderingProcesses,
    };
  }

  private async loadDetectionBundle(input: TeachingPipelineRequest): Promise<DetectionBundleResult> {
    await ensurePipelineSkillsInitialized();
    await ensureSkillRegistryInitialized();

    const skillExecutor = new SkillExecutor(this.traceProcessorService);
    skillExecutor.registerSkills(skillRegistry.getAllSkills());

    const result = await skillExecutor.execute('rendering_pipeline_detection', input.traceId, {
      package: input.packageName || input.processName || '',
    });

    if (!result.success) {
      throw new Error(result.error || 'Pipeline detection failed');
    }

    const subvariants = normalizeSubvariants(result.rawResults);
    const pipelineBundle = this.extractPipelineBundle(result);
    if (pipelineBundle) {
      return {
        bundle: pipelineBundle,
        subvariants,
        warnings: [],
      };
    }

    return {
      bundle: await this.buildFallbackBundle(result),
      subvariants,
      warnings: [
        teachingWarning(
          'PIPELINE_BUNDLE_MISSING',
          'warning',
          'rendering_pipeline_detection did not return pipeline_bundle; used legacy fallback parsing.',
          'detection'
        ),
      ],
    };
  }

  private extractPipelineBundle(result: SkillExecutionResult): PipelineBundle | null {
    const defaultSelection = pipelineSkillLoader.getDefaultSelection();
    const data = result.rawResults?.pipeline_bundle?.data;
    if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
    const bundle = data as Record<string, unknown>;
    const detectionRaw = bundle.detection as Record<string, unknown> | undefined;
    if (!detectionRaw || typeof detectionRaw.primaryPipelineId !== 'string') return null;

    const primaryPipelineId = String(detectionRaw.primaryPipelineId || defaultSelection.pipelineId);
    const primaryConfidence = validateConfidence(
      detectionRaw.primaryConfidence,
      TEACHING_DEFAULTS.confidence
    );
    const detection: PipelineDetectionResult = {
      detected: detectionRaw.detected !== false,
      primaryPipelineId,
      primaryRenderingTypeId: String(
        detectionRaw.primaryRenderingTypeId ||
        pipelineSkillLoader.getPipelineCatalogEntry(primaryPipelineId)?.rendering_type_id ||
        defaultSelection.renderingTypeId
      ),
      primaryConfidence,
      candidates: Array.isArray(detectionRaw.candidates)
        ? parseCandidates(detectionRaw.candidates, TEACHING_LIMITS.maxCandidates)
        : [{ id: primaryPipelineId, confidence: primaryConfidence }],
      renderingTypeCandidates: Array.isArray(detectionRaw.renderingTypeCandidates)
        ? parseCandidates(detectionRaw.renderingTypeCandidates, TEACHING_LIMITS.maxCandidates)
        : [],
      relatedRenderingTypes: Array.isArray(detectionRaw.relatedRenderingTypes)
        ? pipelineSkillLoader.resolveRelatedRenderingTypes(
            parseCandidates(
              detectionRaw.relatedRenderingTypes,
              TEACHING_LIMITS.maxCandidates,
            ),
          )
        : [],
      features: Array.isArray(detectionRaw.features) ? parseFeatures(detectionRaw.features) : [],
      traceRequirementsMissing: Array.isArray(detectionRaw.traceRequirementsMissing)
        ? detectionRaw.traceRequirementsMissing.map((value) => String(value))
        : [],
    };

    return {
      detection,
      teachingContent: this.normalizeTeachingContent(bundle.teachingContent, bundle.docPath),
      pinInstructions: normalizePinInstructions(bundle.pinInstructions),
      activeRenderingProcesses: normalizeActiveProcesses(bundle.activeRenderingProcesses),
      docPath: String(bundle.docPath || defaultSelection.docPath),
    };
  }

  private async buildFallbackBundle(result: SkillExecutionResult): Promise<PipelineBundle> {
    const defaultSelection = pipelineSkillLoader.getDefaultSelection();
    const rawResults = result.rawResults || {};
    const pipelineRow = this.firstObjectRow(rawResults.determine_pipeline);
    const traceRequirementsRow = this.firstObjectRow(rawResults.trace_requirements);
    const activeRenderingProcesses = validateActiveProcesses(rawResults[TEACHING_STEP_IDS.activeProcesses]);

    const primaryPipelineId = String(
      pipelineRow?.primary_pipeline_id || defaultSelection.pipelineId
    );
    const primaryConfidence = validateConfidence(
      pipelineRow?.primary_confidence,
      TEACHING_DEFAULTS.confidence
    );
    const candidates = pipelineRow?.candidates_list
      ? parseCandidates(pipelineRow.candidates_list, TEACHING_LIMITS.maxCandidates)
      : [{ id: primaryPipelineId, confidence: primaryConfidence }];
    const primaryRenderingTypeId = String(
      pipelineRow?.primary_rendering_type_id ||
      pipelineSkillLoader.getPipelineCatalogEntry(primaryPipelineId)?.rendering_type_id ||
      defaultSelection.renderingTypeId
    );
    const renderingTypeCandidates = pipelineRow?.rendering_type_candidates_list
      ? parseCandidates(
          pipelineRow.rendering_type_candidates_list,
          TEACHING_LIMITS.maxCandidates
        )
      : [{ id: primaryRenderingTypeId, confidence: primaryConfidence }];
    const relatedRenderingTypes = pipelineSkillLoader.resolveRelatedRenderingTypes(
      parseCandidates(
        pipelineRow?.related_rendering_type_candidates_list,
        TEACHING_LIMITS.maxCandidates,
      ),
    );
    const features = parseFeatures(pipelineRow?.features_list);
    const traceRequirementsMissing = traceRequirementsRow
      ? Object.values(traceRequirementsRow)
          .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
          .map((value) => value.trim())
      : [];
    const docPath = String(pipelineRow?.doc_path || defaultSelection.docPath);

    const mdTeaching = getPipelineDocService().getTeachingContent(primaryPipelineId);
    const teachingContent = mdTeaching
      ? {
          title: mdTeaching.title,
          summary: mdTeaching.summary,
          mermaidBlocks: mdTeaching.mermaidBlocks,
          threadRoles: mdTeaching.threadRoles,
          keySlices: mdTeaching.keySlices,
          docPath: mdTeaching.docPath,
        }
      : null;

    const smartFilterConfigs = pipelineSkillLoader.getSmartFilterConfigs(primaryPipelineId);
    const pinInstructions = pipelineSkillLoader
      .getAutoPinInstructions(primaryPipelineId)
      .slice(0, TEACHING_LIMITS.maxPinInstructions)
      .map((inst: PinInstruction) => {
        const hasSmartFilter = inst.smart_filter?.enabled ?? smartFilterConfigs.has(inst.pattern);
        const rawInstruction: RawPinInstruction = {
          pattern: inst.pattern,
          match_by: inst.match_by,
          priority: inst.priority,
          reason: inst.reason,
          expand: inst.expand,
          main_thread_only: inst.main_thread_only,
          smart_filter: hasSmartFilter ? (inst.smart_filter || { enabled: true }) : undefined,
        };
        const transformed = transformPinInstruction(rawInstruction, activeRenderingProcesses);
        if (transformed.smartPin && !transformed.skipPin) {
          transformed.reason = `${inst.reason} (${activeRenderingProcesses.length} 活跃进程)`;
        }
        return transformed;
      });

    return {
      detection: {
        detected: !!pipelineRow,
        primaryPipelineId,
        primaryRenderingTypeId,
        primaryConfidence,
        candidates,
        renderingTypeCandidates,
        relatedRenderingTypes,
        features,
        traceRequirementsMissing,
      },
      teachingContent,
      pinInstructions,
      activeRenderingProcesses,
      docPath,
    };
  }

  private firstObjectRow(step: StepResult | undefined): Record<string, unknown> | null {
    if (!step?.data) return null;
    if (Array.isArray(step.data)) {
      const row = step.data.find((item) => item && typeof item === 'object' && !Array.isArray(item));
      return row ? (row as Record<string, unknown>) : null;
    }
    if (typeof step.data === 'object') return step.data as Record<string, unknown>;
    return null;
  }

  private normalizeTeachingContent(raw: unknown, docPath: unknown): TeachingContentResponse | null {
    if (!raw || typeof raw !== 'object') return null;
    const content = raw as Record<string, unknown>;
    const title = toOptionalString(content.title);
    if (!title) return null;
    return {
      title,
      summary: String(content.summary || ''),
      mermaidBlocks: Array.isArray(content.mermaidBlocks)
        ? content.mermaidBlocks.map((block) => String(block))
        : [],
      threadRoles: Array.isArray(content.threadRoles)
        ? content.threadRoles.map((role) => {
            const item = role as Record<string, unknown>;
            return {
              thread: String(item.thread || ''),
              responsibility: String(item.responsibility || ''),
              traceTag: item.traceTag === undefined ? undefined : String(item.traceTag),
            };
          })
        : [],
      keySlices: Array.isArray(content.keySlices)
        ? content.keySlices.map((sliceName) => String(sliceName))
        : [],
      docPath: String(content.docPath || docPath || ''),
    };
  }

  private async buildObservedFlow(
    input: TeachingPipelineRequest,
    bundle: PipelineBundle,
    detection: TeachingDetectionResponse
  ): Promise<ObservedFlowBuildResult> {
    const timeRange = extractTimeRange(input);
    const keySliceNames = collectKeySliceNames(bundle.teachingContent);
    const fallbackProcess = bundle.activeRenderingProcesses[0]?.processName;
    const effectiveProcessName =
      input.packageName || input.processName || fallbackProcess || undefined;
    const fallbackUsed = !input.packageName && !input.processName && fallbackProcess
      ? 'active_rendering_process'
      : undefined;
    const queryWarnings: string[] = [];
    let rows: ObservedEventRow[] = [];

    try {
      rows = await this.queryObservedEventRows(
        input.traceId,
        keySliceNames,
        effectiveProcessName,
        timeRange
      );
    } catch (error: any) {
      queryWarnings.push(`Observed flow query failed: ${error?.message || error}`);
    }

    const events = rows.map((row, index) => ({
      id: `event-${index + 1}-${row.ts}`,
      stage: row.stage,
      name: row.name,
      ts: row.ts,
      dur: row.dur,
      durMs: nsToMs(row.dur),
      processName: row.processName,
      threadName: row.threadName,
      trackId: row.trackId,
      utid: row.utid,
      upid: row.upid,
      evidenceSource: 'observed_slice_query',
      confidence: 0.9,
    }));
    let lanes = this.buildLanes(input, bundle, detection, events);
    let eventsWithLanes = events.map((event) => ({
      ...event,
      laneId: this.matchEventLane(event, lanes),
    }));
    const criticalTaskResult = await this.buildCriticalTasks(input.traceId, eventsWithLanes);
    lanes = this.mergeCriticalTaskLanes(lanes, criticalTaskResult.criticalTasks);
    const criticalTasks = criticalTaskResult.criticalTasks.map((task) => ({
      ...task,
      laneId: task.laneId || this.matchOwnerLane(task.processName, task.threadName, lanes),
    }));
    eventsWithLanes = eventsWithLanes.map((event) => {
      const directTask = criticalTasks.find((task) =>
        task.rootEventId === event.id && task.kind === 'direct_wakeup'
      );
      return directTask
        ? {
            ...event,
            threadStateId: directTask.threadStateId,
            criticalTaskId: directTask.id,
          }
        : event;
    });
    const dependencies = this.buildDependencies(lanes, eventsWithLanes, criticalTasks);
    const missingSignals = this.computeMissingSignals(eventsWithLanes, lanes, bundle, criticalTasks);
    const completenessWarnings = [...queryWarnings];
    completenessWarnings.push(...criticalTaskResult.warnings);
    if (eventsWithLanes.length === 0) {
      completenessWarnings.push('No key rendering slices were observed for the current context.');
    }
    if (fallbackUsed) {
      completenessWarnings.push(`No package/process hint was provided; used ${fallbackProcess} as fallback.`);
    }
    const completenessLevel = eventsWithLanes.length >= 5 && missingSignals.length <= 1
      ? 'high'
      : eventsWithLanes.length > 0
        ? 'medium'
        : 'low';

    return {
      observedFlow: {
        schemaVersion: 'observed-flow.v1',
        context: {
          traceId: input.traceId,
          packageName: input.packageName,
          processName: input.processName || effectiveProcessName,
          timeRange,
          selection: input.selectionContext,
          sourcePriority: OBSERVED_SOURCE_PRIORITY,
          fallbackUsed,
        },
        lanes,
        events: eventsWithLanes,
        dependencies,
        criticalTasks,
        completeness: {
          level: completenessLevel,
          missingSignals,
          warnings: completenessWarnings,
        },
      },
      queryWarnings,
    };
  }

  private async queryObservedEventRows(
    traceId: string,
    keySliceNames: string[],
    processName: string | undefined,
    timeRange: TimeRange | undefined
  ): Promise<ObservedEventRow[]> {
    const exactNames = keySliceNames.map(normalizeKeySliceName).filter(Boolean);
    const exactClause = exactNames.length > 0
      ? `s.name IN (${exactNames.map(sqlLiteral).join(', ')})`
      : '0';
    const likeFragments = [
      'Choreographer',
      'DrawFrame',
      'syncFrameState',
      'performTraversals',
      'queueBuffer',
      'dequeueBuffer',
      'BLASTBufferQueue',
      'Transaction',
      'latchBuffer',
      'eglSwapBuffers',
      'vkQueuePresent',
      'DrawGL',
      'DrawFunctor',
      'FrameTimeline',
      'present',
      'HWC',
    ];
    const likeClause = likeFragments
      .map((fragment) => `s.name LIKE ${sqlLikeLiteral(fragment)} ESCAPE '\\'`)
      .join(' OR ');
    const timeClause = timeRange
      ? `AND s.ts >= ${timeRange.startTs} AND s.ts < ${timeRange.endTs}`
      : '';
    const processClause = processName
      ? `AND (
          p.name = ${sqlLiteral(processName)}
          OR p.name LIKE ${sqlLikeLiteral(processName)} ESCAPE '\\'
          OR p.name LIKE '%surfaceflinger%'
          OR p.name = 'system_server'
        )`
      : '';
    const sql = `
      SELECT
        s.ts AS ts,
        s.dur AS dur,
        s.name AS name,
        s.track_id AS track_id,
        tt.utid AS utid,
        t.upid AS upid,
        t.name AS thread_name,
        p.name AS process_name,
        CASE
          WHEN lower(s.name) LIKE '%choreographer%doframe%' OR lower(s.name) LIKE '%traversal%' THEN 'app_frame'
          WHEN t.name = 'RenderThread' OR lower(s.name) LIKE '%drawframe%' OR lower(s.name) LIKE '%syncframestate%' THEN 'render_thread'
          WHEN lower(s.name) LIKE '%queuebuffer%' OR lower(s.name) LIKE '%dequeuebuffer%' OR lower(s.name) LIKE '%blast%' OR lower(s.name) LIKE '%transaction%' THEN 'buffer_queue_transaction'
          WHEN lower(p.name) LIKE '%surfaceflinger%' OR lower(s.name) LIKE '%latchbuffer%' THEN 'surfaceflinger_composition'
          WHEN lower(t.name) LIKE '%hwc%' OR lower(s.name) LIKE '%present%' THEN 'present'
          ELSE 'producer'
        END AS stage
      FROM slice s
      LEFT JOIN thread_track tt ON s.track_id = tt.id
      LEFT JOIN thread t ON tt.utid = t.utid
      LEFT JOIN process p ON t.upid = p.upid
      WHERE s.dur > 0
        ${timeClause}
        ${processClause}
        AND (${exactClause} OR ${likeClause})
      ORDER BY s.ts
      LIMIT 200
    `;

    const result = await this.traceProcessorService.query(traceId, sql);
    return rowsToObjects(result).map((row) => {
      const stage = stageFromRow(row);
      return {
        ts: toNumber(row.ts, 0),
        dur: toNumber(row.dur, 0),
        name: String(row.name || ''),
        trackId: safeNumber(row.track_id),
        utid: safeNumber(row.utid),
        upid: safeNumber(row.upid),
        threadName: toOptionalString(row.thread_name) || undefined,
        processName: toOptionalString(row.process_name) || undefined,
        stage,
      };
    });
  }

  private buildLanes(
    input: TeachingPipelineRequest,
    bundle: PipelineBundle,
    detection: TeachingDetectionResponse,
    events: ObservedFlowEvent[]
  ): ObservedFlowLane[] {
    const lanes = new Map<string, ObservedFlowLane>();
    const pipelineIds = detection.candidates.length > 0
      ? detection.candidates.map((candidate) => candidate.id)
      : [detection.primaryPipelineId];

    const addLane = (
      role: ObservedFlowLaneRole,
      processName: string | undefined,
      threadName: string | undefined,
      confidence: number,
      evidenceSource: string,
      title?: string,
      suffix?: string
    ) => {
      const id = laneIdFor(role, processName, threadName, suffix);
      const existing = lanes.get(id);
      if (existing) {
        existing.confidence = Math.max(existing.confidence, confidence);
        return;
      }
      lanes.set(id, {
        id,
        role,
        title: title || laneTitle(role, processName, threadName),
        processName,
        threadName,
        trackHint: makeTrackHint(role, processName, threadName),
        pipelineIds,
        confidence,
        evidenceSource,
      });
    };

    for (const process of bundle.activeRenderingProcesses) {
      addLane('app', process.processName, 'main', 0.75, 'active_rendering_processes');
      if (process.renderThreadTid > 0) {
        addLane('render_thread', process.processName, 'RenderThread', 0.75, 'active_rendering_processes');
      }
    }

    for (const event of events) {
      const role = roleForStage(event.stage, event.processName, event.threadName);
      addLane(role, event.processName, event.threadName, 0.9, 'observed_slice_query');
    }

    const detectionText = [
      detection.primaryPipelineId,
      ...detection.candidates.map((candidate) => candidate.id),
      ...detection.features.map((feature) => feature.name),
    ].join(' ');
    for (const pattern of PRODUCER_PIPELINE_PATTERNS) {
      if (!pattern.test.test(detectionText)) continue;
      addLane(
        pattern.role,
        input.packageName || input.processName || bundle.activeRenderingProcesses[0]?.processName,
        undefined,
        0.55,
        'detection_features',
        pattern.title,
        pattern.title
      );
    }

    return Array.from(lanes.values()).sort((a, b) => {
      const roleDiff = sortLaneRole(a.role) - sortLaneRole(b.role);
      if (roleDiff !== 0) return roleDiff;
      return a.title.localeCompare(b.title);
    });
  }

  private matchEventLane(event: ObservedFlowEvent, lanes: ObservedFlowLane[]): string | undefined {
    const role = roleForStage(event.stage, event.processName, event.threadName);
    const exact = lanes.find((lane) =>
      lane.role === role &&
      lane.processName === event.processName &&
      lane.threadName === event.threadName
    );
    if (exact) return exact.id;
    const roleMatch = lanes.find((lane) => lane.role === role);
    return roleMatch?.id;
  }

  private async buildCriticalTasks(
    traceId: string,
    events: ObservedFlowEvent[]
  ): Promise<CriticalTaskBuildResult> {
    const roots = this.selectCriticalTaskRoots(events);
    if (roots.length === 0) return { criticalTasks: [], warnings: [] };

    const warnings: string[] = [];
    const criticalTasks: ObservedFlowCriticalTask[] = [];

    // L2 of the critical-path engine: the direct waker of each root's row,
    // read from the wakeup row (the R/R+ row before a Running row or after a
    // sleep), never from the row itself.
    try {
      const rootRows = await this.queryRootStateRows(traceId, roots);
      for (const row of rootRows) {
        if (row.threadStateId === undefined) continue;
        const waker = await resolveDirectWaker(this.traceProcessorService, traceId, {
          threadStateId: row.threadStateId,
        });
        const failure = waker.warnings.find((warning) => warning.code === 'waker_query_failed');
        if (failure) warnings.push(`Scheduler wakeup query failed: ${warningText(failure, 'en')}`);
        criticalTasks.push(this.buildDirectWakeupTask(row, waker));
      }
    } catch (error: any) {
      warnings.push(`Scheduler wakeup query failed: ${error?.message || error}`);
    }

    // L1 of the critical-path engine: each root's chain of other threads.
    try {
      for (const root of roots) {
        const chain = await loadCriticalPathChain(
          this.traceProcessorService,
          traceId,
          {
            utid: Math.trunc(root.utid || 0),
            startTs: Math.trunc(root.ts),
            dur: Math.trunc(root.dur),
            threadName: root.threadName,
          },
          { maxSegments: MAX_CRITICAL_PATH_SEGMENTS_PER_ROOT }
        );
        criticalTasks.push(...this.buildCriticalPathTasks(root, chain.segments));
      }
    } catch (error: any) {
      warnings.push(`Official critical path query failed: ${error?.message || error}`);
    }

    const deduped = new Map<string, ObservedFlowCriticalTask>();
    for (const task of criticalTasks) {
      deduped.set(task.id, task);
    }
    const result = Array.from(deduped.values()).slice(0, MAX_CRITICAL_TASKS);
    if (result.length === 0) {
      warnings.push('No scheduler wakeup or official critical path rows were observed for key rendering events.');
    }
    return { criticalTasks: result, warnings };
  }

  private selectCriticalTaskRoots(events: ObservedFlowEvent[]): ObservedFlowEvent[] {
    const stagePriority: Record<string, number> = {
      app_frame: 0,
      render_thread: 1,
      producer: 2,
      buffer_queue_transaction: 3,
      surfaceflinger_composition: 4,
      present: 5,
    };
    const seenLaneIds = new Set<string>();
    const roots: ObservedFlowEvent[] = [];
    const candidates = events
      .filter((event) => event.utid !== undefined && event.dur > 0)
      .sort((a, b) =>
        (stagePriority[a.stage] ?? 99) - (stagePriority[b.stage] ?? 99) ||
        a.ts - b.ts
      );
    for (const event of candidates) {
      const key = event.laneId || `${event.processName}:${event.threadName}:${event.utid}`;
      if (seenLaneIds.has(key)) continue;
      seenLaneIds.add(key);
      roots.push(event);
      if (roots.length >= MAX_CRITICAL_TASK_ROOTS) break;
    }
    return roots;
  }

  private async queryRootStateRows(
    traceId: string,
    roots: ObservedFlowEvent[]
  ): Promise<RootStateRow[]> {
    const values = roots
      .map((event) =>
        `(${sqlLiteral(event.id)}, ${event.laneId ? sqlLiteral(event.laneId) : 'NULL'}, ${Math.trunc(event.ts)}, ${Math.trunc(event.ts + event.dur)}, ${Math.trunc(event.utid || 0)})`
      )
      .join(',\n        ');
    const sql = `
      WITH root_events(event_id, lane_id, event_ts, event_end, event_utid) AS (
        VALUES
        ${values}
      ),
      candidate_state AS (
        SELECT
          root_events.event_id,
          root_events.lane_id,
          target.id AS thread_state_id,
          target.ts,
          target.dur,
          target.utid,
          target.state,
          thread.name AS thread_name,
          process.name AS process_name,
          max(0, min(target.ts + target.dur, root_events.event_end) - max(target.ts, root_events.event_ts)) AS overlap_ns,
          abs(target.ts - root_events.event_ts) AS start_distance
        FROM root_events
        JOIN thread_state AS target
          ON target.utid = root_events.event_utid
         AND target.dur > 0
         AND target.ts <= root_events.event_end
         AND target.ts + target.dur >= root_events.event_ts
        LEFT JOIN thread USING(utid)
        LEFT JOIN process USING(upid)
      ),
      ranked_state AS (
        SELECT
          *,
          row_number() OVER (
            PARTITION BY event_id
            ORDER BY overlap_ns DESC, start_distance ASC, ts DESC
          ) AS rn
        FROM candidate_state
      )
      SELECT event_id, lane_id, thread_state_id, ts, dur, utid, state, thread_name, process_name
      FROM ranked_state
      WHERE rn = 1
      ORDER BY ts
    `;

    const result = assertQuerySucceeded(await this.traceProcessorService.query(traceId, sql));
    return rowsToObjects(result).map((row) => ({
      eventId: String(row.event_id || ''),
      eventLaneId: toOptionalString(row.lane_id) || undefined,
      threadStateId: safeNumber(row.thread_state_id),
      ts: toNumber(row.ts, 0),
      dur: toNumber(row.dur, 0),
      utid: safeNumber(row.utid),
      state: toOptionalString(row.state) || undefined,
      threadName: toOptionalString(row.thread_name) || undefined,
      processName: toOptionalString(row.process_name) || undefined,
    }));
  }

  private buildDirectWakeupTask(row: RootStateRow, waker: WakerChainResult): ObservedFlowCriticalTask {
    const hop = waker.hop;
    return {
      id: `critical-task-wakeup-${row.eventId}`,
      kind: 'direct_wakeup',
      rootEventId: row.eventId,
      rootLaneId: row.eventLaneId,
      laneId: row.eventLaneId,
      name: hop
        ? `direct waker: ${hop.threadName || hop.processName || hop.kind}`
        : 'direct waker: not recorded',
      ts: row.ts,
      dur: row.dur,
      durMs: nsToMs(row.dur),
      processName: row.processName,
      threadName: row.threadName,
      utid: row.utid,
      threadStateId: row.threadStateId,
      state: row.state,
      waker: hop
        ? {
            threadStateId: hop.threadStateId ?? undefined,
            utid: hop.utid ?? undefined,
            processName: hop.processName ?? undefined,
            threadName: hop.threadName ?? undefined,
            state: hop.state ?? undefined,
            irqContext: hop.irqContext,
            kind: hop.kind,
          }
        : undefined,
      evidenceSource: 'thread_state_waker_id',
      confidence: hop ? 0.85 : 0.55,
    };
  }

  private buildCriticalPathTasks(
    root: ObservedFlowEvent,
    segments: CriticalPathSegment[]
  ): ObservedFlowCriticalTask[] {
    return segments
      .filter((segment) => segment.dur > 0)
      .map((segment, index) => ({
        id: `critical-task-path-${root.id}-${index + 1}-${segment.startTs}`,
        kind: 'critical_path_segment' as const,
        rootEventId: root.id,
        rootLaneId: root.laneId,
        name: segment.slices[0] || segment.state || segment.threadName || 'official critical path segment',
        ts: segment.startTs,
        dur: segment.dur,
        durMs: segment.durationMs,
        processName: segment.processName ?? undefined,
        threadName: segment.threadName ?? undefined,
        utid: segment.utid,
        threadStateId: segment.threadStateId ?? undefined,
        state: segment.state ?? undefined,
        evidenceSource: 'official_critical_path_stack',
        confidence: 0.8,
      }))
      .sort((a, b) => a.ts - b.ts || b.dur - a.dur);
  }

  private mergeCriticalTaskLanes(
    lanes: ObservedFlowLane[],
    criticalTasks: ObservedFlowCriticalTask[]
  ): ObservedFlowLane[] {
    const merged = new Map(lanes.map((lane) => [lane.id, lane]));
    const addCriticalLane = (processName?: string, threadName?: string) => {
      if (!processName && !threadName) return;
      const existing = Array.from(merged.values()).find((lane) => sameLaneOwner(lane, processName, threadName));
      if (existing) return;
      const id = laneIdFor('critical_task', processName, threadName);
      if (merged.has(id)) return;
      merged.set(id, {
        id,
        role: 'critical_task',
        title: laneTitle('critical_task', processName, threadName),
        processName,
        threadName,
        trackHint: makeTrackHint('critical_task', processName, threadName),
        pipelineIds: [],
        confidence: 0.72,
        evidenceSource: 'official_critical_path_or_wakeup',
      });
    };

    for (const task of criticalTasks) {
      addCriticalLane(task.processName, task.threadName);
      addCriticalLane(task.waker?.processName, task.waker?.threadName);
    }

    return Array.from(merged.values()).sort((a, b) => {
      const roleDiff = sortLaneRole(a.role) - sortLaneRole(b.role);
      if (roleDiff !== 0) return roleDiff;
      return a.title.localeCompare(b.title);
    });
  }

  private matchOwnerLane(
    processName: string | undefined,
    threadName: string | undefined,
    lanes: ObservedFlowLane[]
  ): string | undefined {
    const exact = lanes.find((lane) => sameLaneOwner(lane, processName, threadName));
    if (exact) return exact.id;
    if (threadName) {
      const threadMatch = lanes.find((lane) => lane.threadName === threadName);
      if (threadMatch) return threadMatch.id;
    }
    if (processName) {
      const processMatch = lanes.find((lane) => lane.processName === processName);
      if (processMatch) return processMatch.id;
    }
    return undefined;
  }

  private buildDependencies(
    lanes: ObservedFlowLane[],
    events: ObservedFlowEvent[],
    criticalTasks: ObservedFlowCriticalTask[]
  ): ObservedFlowDependency[] {
    const dependencies: ObservedFlowDependency[] = [];
    const firstByRole = (role: ObservedFlowLaneRole) => lanes.find((lane) => lane.role === role);
    const pairs: Array<[ObservedFlowLaneRole, ObservedFlowLaneRole, ObservedFlowDependency['relation']]> = [
      ['app', 'render_thread', 'produces_to'],
      ['render_thread', 'producer', 'overlaps_with'],
      ['producer', 'buffer_queue', 'produces_to'],
      ['render_thread', 'buffer_queue', 'produces_to'],
      ['buffer_queue', 'surfaceflinger', 'composes_to'],
      ['surfaceflinger', 'hwc_present', 'presents_to'],
    ];

    for (const [fromRole, toRole, relation] of pairs) {
      const from = firstByRole(fromRole);
      const to = firstByRole(toRole);
      if (!from || !to || from.id === to.id) continue;
      if (!this.hasObservedDependencyEvidence(from.id, to.id, events, relation)) continue;
      dependencies.push({
        fromLaneId: from.id,
        toLaneId: to.id,
        relation,
        confidence: 0.65,
        evidenceSource: 'observed_event_order',
      });
    }

    dependencies.push(...this.buildWakeupDependencies(lanes, criticalTasks));
    dependencies.push(...this.buildCriticalPathDependencies(lanes, criticalTasks));

    const seen = new Set<string>();
    return dependencies.filter((dependency) => {
      const key = [
        dependency.fromLaneId,
        dependency.toLaneId,
        dependency.relation,
        dependency.fromTaskId,
        dependency.toTaskId,
      ].join(':');
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  private buildWakeupDependencies(
    lanes: ObservedFlowLane[],
    criticalTasks: ObservedFlowCriticalTask[]
  ): ObservedFlowDependency[] {
    const dependencies: ObservedFlowDependency[] = [];
    for (const task of criticalTasks) {
      if (task.kind !== 'direct_wakeup' || !task.waker || !task.rootLaneId) continue;
      const fromLaneId = this.matchOwnerLane(task.waker.processName, task.waker.threadName, lanes);
      const toLaneId = task.rootLaneId;
      if (!fromLaneId || fromLaneId === toLaneId) continue;
      dependencies.push({
        fromLaneId,
        toLaneId,
        relation: 'wakes_to',
        confidence: task.confidence,
        evidenceSource: 'thread_state_waker_id',
        toEventId: task.rootEventId,
        fromTaskId: task.waker.threadStateId ? `thread_state:${task.waker.threadStateId}` : undefined,
        toTaskId: task.threadStateId ? `thread_state:${task.threadStateId}` : task.id,
        detail: `${task.waker.kind || 'thread'} wakeup -> ${taskOwnerLabel(task)}`,
      });
    }
    return dependencies;
  }

  private buildCriticalPathDependencies(
    lanes: ObservedFlowLane[],
    criticalTasks: ObservedFlowCriticalTask[]
  ): ObservedFlowDependency[] {
    const dependencies: ObservedFlowDependency[] = [];
    for (const task of criticalTasks) {
      if (task.kind !== 'critical_path_segment' || !task.rootLaneId) continue;
      const fromLaneId = this.matchOwnerLane(task.processName, task.threadName, lanes);
      const toLaneId = task.rootLaneId;
      if (!fromLaneId || fromLaneId === toLaneId) continue;
      dependencies.push({
        fromLaneId,
        toLaneId,
        relation: 'critical_path_to',
        confidence: task.confidence,
        evidenceSource: 'official_critical_path_stack',
        toEventId: task.rootEventId,
        fromTaskId: task.id,
        detail: `${taskOwnerLabel(task)} is on the official critical path for the rendering event.`,
      });
    }
    return dependencies;
  }

  private hasObservedDependencyEvidence(
    fromLaneId: string,
    toLaneId: string,
    events: ObservedFlowEvent[],
    relation: ObservedFlowDependency['relation']
  ): boolean {
    const fromEvents = events.filter((event) => event.laneId === fromLaneId);
    const toEvents = events.filter((event) => event.laneId === toLaneId);
    if (!fromEvents.length || !toEvents.length) return false;

    return fromEvents.some((from) => {
      const fromEnd = from.ts + Math.max(from.dur, 0);
      return toEvents.some((to) => {
        const toEnd = to.ts + Math.max(to.dur, 0);
        const overlaps = from.ts < toEnd && to.ts < fromEnd;
        if (relation === 'overlaps_with') return overlaps;
        return overlaps || from.ts <= to.ts;
      });
    });
  }

  private computeMissingSignals(
    events: ObservedFlowEvent[],
    lanes: ObservedFlowLane[],
    bundle: PipelineBundle,
    criticalTasks: ObservedFlowCriticalTask[] = []
  ): string[] {
    const missing: string[] = [];
    const hasStage = (stage: string) => events.some((event) => event.stage === stage);
    const hasRole = (role: ObservedFlowLaneRole) => lanes.some((lane) => lane.role === role);

    if (!hasStage('app_frame') && !hasRole('app')) {
      missing.push('app main frame slices');
    }
    if (!hasStage('render_thread') && !hasRole('render_thread')) {
      missing.push('RenderThread draw slices');
    }
    if (!hasStage('surfaceflinger_composition') && !hasRole('surfaceflinger')) {
      missing.push('SurfaceFlinger composition slices');
    }
    if (!hasStage('present') && !hasRole('hwc_present')) {
      missing.push('HWC/present fence slices');
    }
    if (events.length > 0 && criticalTasks.length === 0) {
      missing.push('sched critical path / wakeup relationships');
    }
    for (const requirement of bundle.detection.traceRequirementsMissing) {
      missing.push(requirement);
    }
    return Array.from(new Set(missing));
  }

  private buildPinPlan(
    instructions: PinInstructionResponse[],
    observedFlow: ObservedFlow
  ): TeachingPinPlan {
    const expectedTrackHints = observedFlow.lanes
      .map((lane) => lane.trackHint)
      .filter((hint): hint is ObservedFlowTrackHint => hint !== undefined);
    const warnings: string[] = [];
    if (instructions.length === 0) {
      warnings.push('No pin instructions were produced for this pipeline.');
    }
    if (expectedTrackHints.length === 0) {
      warnings.push('No observed lanes have concrete track hints.');
    }
    const status: TeachingPinPlan['status'] =
      instructions.length === 0
        ? 'empty'
        : expectedTrackHints.length === 0
          ? 'partial'
          : 'planned';

    return {
      status,
      instructions,
      expectedLaneIds: observedFlow.lanes.map((lane) => lane.id),
      expectedTrackHints,
      summary:
        status === 'planned'
          ? `${instructions.length} pin instructions planned for ${expectedTrackHints.length} observed lanes.`
          : warnings[0] || 'Pin plan is incomplete.',
      warnings,
    };
  }

  private buildOverlayPlan(
    teachingContent: TeachingContentResponse,
    observedFlow: ObservedFlow
  ): TeachingOverlayPlan {
    const keySliceNames = collectKeySliceNames(teachingContent);
    const eventIds = observedFlow.events.map((event) => event.id);
    const warnings: string[] = [];
    if (eventIds.length === 0) {
      warnings.push('No observed events are available for timeline overlay.');
    }
    const status: TeachingOverlayPlan['status'] = eventIds.length > 0 ? 'ready' : 'empty';
    return {
      status,
      skillId: 'pipeline_key_slices_overlay',
      eventIds,
      keySliceNames,
      timeRange: observedFlow.context.timeRange,
      summary:
        status === 'ready'
          ? `${eventIds.length} observed events ready for overlay.`
          : 'Overlay has no observed events for the current context.',
      warnings,
    };
  }

  private buildWarnings(
    detectionBundle: DetectionBundleResult,
    observedFlow: ObservedFlow,
    queryWarnings: string[],
    teachingContent: TeachingContentResponse,
    pinPlan: TeachingPinPlan,
    overlayPlan: TeachingOverlayPlan
  ): TeachingWarning[] {
    const warnings: TeachingWarning[] = [...detectionBundle.warnings];
    const detection = detectionBundle.bundle.detection;
    if (detection.primaryConfidence < 0.6) {
      warnings.push(
        teachingWarning(
          'LOW_PIPELINE_CONFIDENCE',
          'warning',
          `Primary pipeline confidence is ${Math.round(detection.primaryConfidence * 100)}%.`,
          'detection'
        )
      );
    }
    for (const missing of detection.traceRequirementsMissing) {
      warnings.push(teachingWarning('TRACE_REQUIREMENT_MISSING', 'warning', missing, 'detection'));
    }
    for (const message of queryWarnings) {
      warnings.push(teachingWarning('OBSERVED_FLOW_QUERY_WARNING', 'warning', message, 'observed_flow'));
    }
    for (const message of observedFlow.completeness.warnings) {
      warnings.push(teachingWarning('OBSERVED_FLOW_INCOMPLETE', 'info', message, 'observed_flow'));
    }
    if (observedFlow.events.length === 0) {
      warnings.push(
        teachingWarning(
          'NO_OBSERVED_EVENTS',
          'warning',
          'No real key rendering events were found; teaching content is explanatory only for this trace context.',
          'observed_flow'
        )
      );
    }
    if (!teachingContent.keySlices.length) {
      warnings.push(
        teachingWarning(
          'TEACHING_KEY_SLICES_EMPTY',
          'info',
          'Teaching content has no key slice list; overlay used default rendering slice names.',
          'teaching'
        )
      );
    }
    for (const message of pinPlan.warnings) {
      warnings.push(teachingWarning('PIN_PLAN_WARNING', 'info', message, 'pin'));
    }
    for (const message of overlayPlan.warnings) {
      warnings.push(teachingWarning('OVERLAY_PLAN_WARNING', 'info', message, 'overlay'));
    }

    const seen = new Set<string>();
    return warnings.filter((warning) => {
      const key = `${warning.code}:${warning.message}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }
}
