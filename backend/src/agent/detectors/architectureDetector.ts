// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

/**
 * Architecture Detector
 *
 * Delegates to the YAML skill `rendering_pipeline_detection` as the single
 * source of truth for architecture detection (24-type fine-grained detection).
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
  pipelineSkillLoader,
} from '../../services/pipelineSkillLoader';
import {
  rethrowIfTraceProcessorQueryCancelled,
  throwIfTraceProcessorQueryCancelled,
} from '../../services/traceProcessorCancellation';

// =============================================================================
// Catalog-backed pipeline ID -> ArchitectureInfo.type mapping
// =============================================================================

export function resolvePipelineArchitectureType(pipelineId: string): RenderingArchitectureType {
  return pipelineSkillLoader.getPipelineCatalogEntry(pipelineId)?.architecture_type || 'STANDARD';
}

// =============================================================================
// Core detection via YAML skill
// =============================================================================

/**
 * Detect rendering architecture by executing the `rendering_pipeline_detection`
 * YAML skill.  Falls back to STANDARD with 0.5 confidence on any error.
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

    if (!result.success) {
      console.warn('[detectArchitectureViaSkill] Skill failed:', result.error);
      return createDefaultResult();
    }

    // Extract step results via rawResults (keyed by step id)
    const pipelineRow = extractFirstRow(result.rawResults, 'determine_pipeline');
    const subvariantRow = extractFirstRow(result.rawResults, 'subvariants');

    const pipelineId: string =
      pipelineRow?.primary_pipeline_id || pipelineSkillLoader.getDefaultSelection().pipelineId;
    const confidence: number = typeof pipelineRow?.primary_confidence === 'number'
      ? pipelineRow.primary_confidence
      : 0.5;

    const type = resolvePipelineArchitectureType(pipelineId);

    const info: ArchitectureInfo = {
      type,
      confidence,
      evidence: parseCandidates(pipelineRow?.candidates_list).map(c => ({
        type: 'slice' as const,
        value: c.id,
        weight: c.confidence,
      })),
      additionalInfo: {
        pipelineId,
        featuresList: pipelineRow?.features_list,
        docPath: pipelineRow?.doc_path,
      },
    };

    // Type-specific extras
    if (type === 'FLUTTER') {
      const flutterEngine = subvariantRow?.flutter_engine;
      info.flutter = {
        engine: flutterEngine === 'IMPELLER' ? 'IMPELLER'
              : flutterEngine === 'SKIA' ? 'SKIA'
              : 'UNKNOWN',
        surfaceType: pipelineId.includes('SURFACEVIEW') ? 'SURFACEVIEW'
                   : pipelineId.includes('TEXTUREVIEW') ? 'TEXTUREVIEW'
                   : 'UNKNOWN',
      };
    }

    if (type === 'WEBVIEW') {
      const webviewMode: string = subvariantRow?.webview_mode || '';
      info.webview = {
        engine: webviewMode === 'TEXTUREVIEW_CUSTOM' ? 'X5' : 'CHROMIUM',
        surfaceType: webviewMode === 'SURFACE_CONTROL' ? 'SURFACECONTROL'
                   : webviewMode === 'GL_FUNCTOR' ? 'TEXTUREVIEW'
                   : webviewMode === 'SURFACEVIEW_WRAPPER' ? 'SURFACEVIEW'
                   : 'UNKNOWN',
      };
    }

    if (type === 'COMPOSE') {
      info.compose = {
        hasRecomposition: true,
        hasLazyLists: false,
        isHybridView: false,
        features: [],
      };
    }

    console.log(`[detectArchitectureViaSkill] Detected: ${type} (${pipelineId}) confidence=${confidence.toFixed(2)}`);
    return info;
  } catch (err) {
    rethrowIfTraceProcessorQueryCancelled(err);
    console.warn('[detectArchitectureViaSkill] Failed, returning default:', (err as Error).message);
    return createDefaultResult();
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

function createDefaultResult(): ArchitectureInfo {
  return {
    type: 'STANDARD',
    confidence: 0.5,
    evidence: [
      {
        type: 'slice',
        value: 'Default assumption',
        weight: 0.5,
        source: 'No specific architecture detected, assuming standard Android',
      },
    ],
  };
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
