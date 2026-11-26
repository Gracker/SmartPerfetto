// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {TEACHING_LIMITS} from '../config/teaching.config';
import {
  parseCandidates, parseFeatures, transformPinInstruction, validateConfidence,
  type ActiveProcess, type PipelineDetectionResult,
  type PinInstructionResponse, type TeachingContentResponse,
} from '../types/teaching.types';
import {getPipelineDocService} from './pipelineDocService';
import {matchesPipelineTarget, pipelineSkillLoader} from './pipelineSkillLoader';

export interface PipelineBundle {
  detection: PipelineDetectionResult;
  requestedTeachingPipelineId?: string;
  teachingContent: TeachingContentResponse | null;
  pinInstructions: PinInstructionResponse[];
  activeRenderingProcesses: ActiveProcess[];
  docPath: string;
}

/** Both the pipeline Skill step and the teaching API's raw-row fallback use this projection. */
export function buildPipelineTeachingBundle(
  row: Record<string, unknown> | null,
  activeRenderingProcesses: ActiveProcess[],
  traceRequirements: Record<string, unknown> | null,
  {explicitPipelineId, packageName}: {explicitPipelineId?: string; packageName?: string} = {},
): PipelineBundle {
  const selectedId = String(row?.primary_pipeline_id ?? '');
  const entry = matchesPipelineTarget(row?.target_process, packageName)
    ? pipelineSkillLoader.getObservedPipelineEntry(selectedId, row?.primary_basis) : null;
  const detected = entry !== null;
  const primaryPipelineId = detected ? selectedId : 'UNKNOWN';
  const primaryRenderingTypeId = entry?.rendering_type_id ?? 'UNKNOWN';
  const primaryConfidence = detected ? validateConfidence(row?.primary_confidence, 0) : 0;
  const cardId = explicitPipelineId || primaryPipelineId;
  const teachingContent = getPipelineDocService().getTeachingContent(cardId);
  const pinInstructions = (detected && cardId === selectedId ? pipelineSkillLoader.getAutoPinInstructions(cardId) : [])
    .slice(0, TEACHING_LIMITS.maxPinInstructions)
    .map(instruction => {
      const pin = transformPinInstruction(instruction, activeRenderingProcesses);
      if (pin.smartPin && !pin.skipPin) {
        pin.reason = `${instruction.reason} (${activeRenderingProcesses.length} 活跃进程)`;
      }
      return pin;
    });
  const traceRequirementsMissing = Object.values(traceRequirements || {})
    .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    .map(value => value.trim());
  return {
    detection: {
      detected,
      primaryPipelineId,
      primaryRenderingTypeId,
      primaryConfidence,
      candidates: detected ? parseCandidates(row?.candidates_list, TEACHING_LIMITS.maxCandidates) : [],
      renderingTypeCandidates: detected ? parseCandidates(row?.rendering_type_candidates_list, TEACHING_LIMITS.maxCandidates) : [],
      relatedRenderingTypes: detected ? pipelineSkillLoader.resolveRelatedRenderingTypes(
        parseCandidates(row?.related_rendering_type_candidates_list, TEACHING_LIMITS.maxCandidates)) : [],
      features: detected ? parseFeatures(row?.features_list) : [],
      traceRequirementsMissing,
    },
    ...(explicitPipelineId ? {requestedTeachingPipelineId: explicitPipelineId} : {}),
    teachingContent,
    pinInstructions,
    activeRenderingProcesses,
    docPath: teachingContent?.docPath ?? '',
  };
}
