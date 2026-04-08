// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

/**
 * sceneStage1Runner — runs the scene_reconstruction composite skill once
 * against a trace and returns the resulting DataEnvelope list plus the
 * trace duration extracted from the trace_time_range step.
 *
 * This is the synchronous, no-LLM portion of the Scene Story pipeline.
 * Stage 1 is intentionally cheap so the Story panel can render scene chips
 * before the expensive Stage 2 deep-dives kick in.
 *
 * The runner takes its skill access via dependency injection (an `execute`
 * function and a `toEnvelopes` converter) so it can be unit-tested without
 * a real SkillExecutor.
 */

import { DataEnvelope } from '../../types/dataContract';
import { SkillExecutionResult } from '../../services/skillEngine/types';
import {
  buildDisplayedScenes,
  BuildDisplayedScenesResult,
} from './sceneIntervalBuilder';
import { DisplayedScene } from './types';

export interface Stage1RunnerDeps {
  /** Wraps SkillExecutor.execute(...). */
  execute: (
    skillId: string,
    traceId: string,
    params: Record<string, any>,
  ) => Promise<SkillExecutionResult>;
  /** Wraps the static SkillExecutor.toDataEnvelopes(...). */
  toEnvelopes: (result: SkillExecutionResult) => DataEnvelope[];
}

export interface Stage1RunResult {
  /** All envelopes the skill emitted, in the order produced. */
  envelopes: DataEnvelope[];
  /** Full DisplayedScene list (no truncation). */
  scenes: DisplayedScene[];
  /** Extracted from trace_time_range; 0 when the step is missing. */
  traceDurationSec: number;
  /** The raw skill result, kept for callers that want diagnostics or rawResults. */
  rawResult: SkillExecutionResult;
}

export class SceneStage1Runner {
  constructor(private readonly deps: Stage1RunnerDeps) {}

  /**
   * Run the scene_reconstruction skill and return scene-shaped results.
   *
   * @param traceId Backend trace identifier
   * @param onEnvelope Optional per-envelope callback so the caller can
   *   broadcast each envelope as a `data` SSE event before the full Stage 1
   *   result is returned. Errors thrown by the callback are swallowed and
   *   logged so they cannot abort the pipeline.
   */
  async run(
    traceId: string,
    onEnvelope?: (env: DataEnvelope) => void,
  ): Promise<Stage1RunResult> {
    const rawResult = await this.deps.execute('scene_reconstruction', traceId, {});

    if (!rawResult.success) {
      throw new Error(
        `scene_reconstruction skill failed: ${rawResult.error ?? 'unknown error'}`,
      );
    }

    const envelopes = this.deps.toEnvelopes(rawResult);

    if (onEnvelope) {
      for (const env of envelopes) {
        try {
          onEnvelope(env);
        } catch (err) {
          console.warn(
            '[SceneStage1Runner] onEnvelope callback threw, continuing:',
            (err as Error)?.message ?? err,
          );
        }
      }
    }

    const built: BuildDisplayedScenesResult = buildDisplayedScenes(envelopes);
    return {
      envelopes,
      scenes: built.scenes,
      traceDurationSec: built.traceDurationSec,
      rawResult,
    };
  }
}
