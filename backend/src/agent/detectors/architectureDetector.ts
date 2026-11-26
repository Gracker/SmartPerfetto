// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

/**
 * Architecture Detector
 *
 * Delegates to the YAML skill `rendering_pipeline_detection` as the single
 * source of truth for architecture detection.
 *
 * The YAML skill executes thread/slice signal collection, pipeline scoring,
 * subvariant determination, and pin instruction generation -- all in SQL.
 * This module maps the skill output back to the `ArchitectureInfo` type
 * consumed by the rest of the codebase.
 */

import {
  ArchitectureInfo,
  DetectorContext,
  RenderingArchitectureType,
} from './types';
import { createSkillExecutor } from '../../services/skillEngine/skillExecutor';
import { ensureSkillRegistryInitialized, skillRegistry } from '../../services/skillEngine/skillLoader';
import {
  resolveEffectiveSkillRegistryForRuntime,
} from '../../services/selfEvolution/effectiveRuntimeRegistryProvider';
import { parseCandidates } from '../../types/teaching.types';
import {
  ensurePipelineSkillsInitialized,
  matchesPipelineTarget,
  pipelineSkillLoader,
} from '../../services/pipelineSkillLoader';
import {
  rethrowIfTraceProcessorQueryCancelled,
  throwIfTraceProcessorQueryCancelled,
} from '../../services/traceProcessorCancellation';

// =============================================================================
// Catalog-backed pipeline ID -> ArchitectureInfo.type mapping
// =============================================================================

export function resolvePipelineArchitectureType(pipelineId: string, observedPath: unknown): RenderingArchitectureType {
  return pipelineSkillLoader.getObservedPipelineEntry(pipelineId, observedPath)?.architecture_type ?? 'UNKNOWN';
}

// =============================================================================
// Core detection via YAML skill
// =============================================================================

/**
 * Detect rendering architecture by executing the `rendering_pipeline_detection`
 * YAML skill. Failed or missing observations reject instead of inventing an architecture.
 */
export async function detectArchitectureViaSkill(
  traceProcessorService: any,
  traceId: string,
  packageName?: string,
  signal?: AbortSignal,
): Promise<ArchitectureInfo> {
  throwIfTraceProcessorQueryCancelled(signal);
  try {
    await ensurePipelineSkillsInitialized();
    const executor = createSkillExecutor(traceProcessorService);
    await ensureSkillRegistryInitialized();
    const effectiveSkillRegistry =
      resolveEffectiveSkillRegistryForRuntime(skillRegistry);
    executor.registerSkills(effectiveSkillRegistry.getAllSkills());
    executor.setFragmentRegistry(
      effectiveSkillRegistry.getFragmentCache(),
    );

    const result = await executor.execute('rendering_pipeline_detection', traceId, {
      package: packageName || '',
    }, { signal });
    throwIfTraceProcessorQueryCancelled(signal);

    if (!result.success) {
      throw new Error(result.error || 'Architecture detection skill execution failed');
    }

    // Extract step results via rawResults (keyed by step id)
    const pipelineRow = extractFirstRow(result.rawResults, 'determine_pipeline');

    if (!pipelineRow || typeof pipelineRow.primary_pipeline_id !== 'string' || !pipelineRow.primary_pipeline_id.trim()) {
      throw new Error('Architecture detection did not produce a pipeline ID');
    }
    const {primary_pipeline_id: pipelineId, primary_basis: basis, primary_confidence: share} = pipelineRow;
    const targetProcess = pipelineRow.target_process;
    const scopeMatches = matchesPipelineTarget(targetProcess, packageName);
    const type = scopeMatches ? resolvePipelineArchitectureType(pipelineId, basis) : 'UNKNOWN';
    const confidence = type !== 'UNKNOWN' && Number.isFinite(share) ? share : 0;
    const evidence: ArchitectureInfo['evidence'] = [];
    for (const metric of [
      'hwui_draw_frames', 'host_submissions', 'surfaceview_submissions',
      'texture_submissions', 'sf_host_frames', 'sf_surfaceview_frames',
      'sf_surface_latches', 'camera_latches', 'video_latches', 'webview_draw_frames',
    ]) {
      const value = pipelineRow[metric];
      if (scopeMatches && Number.isSafeInteger(value) && value >= 0) {
        evidence.push({type: 'count', metric, value, source: 'rendering_pipeline_detection/determine_pipeline'});
      }
    }
    const info: ArchitectureInfo = {
      type,
      confidence,
      evidence,
      detectorScope: {version: 1, traceId, packageName: packageName || null},
      additionalInfo: {
        pipelineId: type === 'UNKNOWN' ? 'UNKNOWN' : pipelineId,
        pipelineLabel: type === 'UNKNOWN' ? undefined : pipelineSkillLoader.getPipeline(pipelineId)?.meta.display_name,
        primaryBasis: type === 'UNKNOWN' ? 'unknown' : basis,
        confidenceMeaning: 'observed_output_share',
        targetProcess: scopeMatches ? targetProcess : undefined,
        candidates: type === 'UNKNOWN' ? [] : parseCandidates(pipelineRow.candidates_list),
        featuresList: type === 'UNKNOWN' ? undefined : pipelineRow.features_list,
        docPath: type === 'UNKNOWN' ? undefined : pipelineRow.doc_path,
      },
    };

    // Type-specific extras
    if (type === 'FLUTTER') {
      info.flutter = {
        engine: pipelineId.endsWith('_IMPELLER') ? 'IMPELLER'
              : pipelineId.endsWith('_SKIA') ? 'SKIA' : 'UNKNOWN',
        surfaceType: pipelineId.includes('SURFACEVIEW') ? 'SURFACEVIEW'
                   : pipelineId.includes('TEXTUREVIEW') ? 'TEXTUREVIEW' : 'UNKNOWN',
      };
    }

    if (type === 'WEBVIEW') {
      info.webview = {
        engine: pipelineId === 'CHROME_BROWSER_VIZ' ? 'CHROMIUM' : 'UNKNOWN',
        surfaceType: pipelineId === 'WEBVIEW_SURFACE_CONTROL' ? 'SURFACECONTROL'
                   : pipelineId === 'WEBVIEW_SURFACEVIEW_WRAPPER' ? 'SURFACEVIEW'
                   : pipelineId === 'WEBVIEW_TEXTUREVIEW_CUSTOM' ? 'TEXTUREVIEW' : 'UNKNOWN',
      };
    }

    console.log(`[detectArchitectureViaSkill] Detected: ${type} (${pipelineId}) confidence=${confidence.toFixed(2)}`);
    return info;
  } catch (err) {
    rethrowIfTraceProcessorQueryCancelled(err);
    console.warn('[detectArchitectureViaSkill] Failed:', (err as Error).message);
    throw err;
  }
}

// =============================================================================
// Helpers
// =============================================================================

/**
 * Extract the first row from a rawResults step as a key-value object.
 *
 * rawResults[stepId].data is an array of row objects when the skill executor
 * returns columnar data from SQL queries.
 */
function extractFirstRow(
  rawResults: Record<string, any> | undefined,
  stepId: string,
): Record<string, any> | undefined {
  if (!rawResults) return undefined;
  const step = rawResults[stepId];
  if (!step || !step.data) return undefined;
  const data = step.data;
  if (Array.isArray(data) && data.length > 0) {
    return data[0];
  }
  return undefined;
}

// =============================================================================
// Public API (backward-compatible)
// =============================================================================

/**
 * Architecture detector that delegates to the YAML skill.
 *
 * Preserves the `createArchitectureDetector().detect(context)` call pattern
 * used by `claudeRuntime.ts` and `claudeMcpServer.ts`.
 */
export class ArchitectureDetector {
  async detect(context: DetectorContext): Promise<ArchitectureInfo> {
    return detectArchitectureViaSkill(
      context.traceProcessorService,
      context.traceId,
      context.packageName,
      context.signal,
    );
  }
}

/**
 * Create an architecture detector instance.
 */
export function createArchitectureDetector(): ArchitectureDetector {
  return new ArchitectureDetector();
}
