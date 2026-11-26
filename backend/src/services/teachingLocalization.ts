// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import type {OutputLanguage} from '../agentv3/outputLanguage';
import type {
  ObservedFlowLaneRole,
  TeachingPipelineResponse,
  ThreadRoleResponse,
} from '../types/teaching.types';
import {localizedSchemaLabel} from './skillLocalization';

const HAN_RE = /\p{Script=Han}/u;

function matchesLanguage(
  value: string | undefined,
  outputLanguage: OutputLanguage,
): boolean {
  if (!value?.trim()) return false;
  return outputLanguage === 'en' ? !HAN_RE.test(value) : HAN_RE.test(value);
}

function projectedText(
  value: string | undefined,
  outputLanguage: OutputLanguage,
  zh: string,
  en: string,
): string {
  return matchesLanguage(value, outputLanguage)
    ? value!.trim()
    : outputLanguage === 'en'
      ? en
      : zh;
}

function roleResponsibility(
  role: ThreadRoleResponse,
  outputLanguage: OutputLanguage,
): string {
  const thread = role.thread || 'thread';
  return projectedText(
    role.responsibility,
    outputLanguage,
    `${thread} 在当前渲染管线中的职责。`,
    `Role of ${thread} in the current rendering pipeline.`,
  );
}

function laneTitle(
  role: ObservedFlowLaneRole,
  value: string,
  outputLanguage: OutputLanguage,
): string {
  const titles: Record<ObservedFlowLaneRole, [string, string]> = {
    app: ['应用主线程', 'App main thread'],
    render_thread: ['渲染线程', 'Render thread'],
    producer: ['图形生产者', 'Graphics producer'],
    buffer_queue: ['BufferQueue', 'BufferQueue'],
    surfaceflinger: ['SurfaceFlinger', 'SurfaceFlinger'],
    hwc_present: ['HWC 呈现', 'HWC presentation'],
    critical_task: ['关键任务', 'Critical task'],
    unknown: ['未知泳道', 'Unknown lane'],
  };
  const [zh, en] = titles[role];
  return projectedText(value, outputLanguage, zh, en);
}

function genericWarning(
  value: string,
  outputLanguage: OutputLanguage,
): string {
  return projectedText(
    value,
    outputLanguage,
    '当前渲染管线结果包含一项需要注意的完整性提示。',
    'The current rendering-pipeline result contains a completeness warning.',
  );
}

/**
 * Project presentation fields while preserving stable pipeline IDs, event
 * IDs, enum values, SQL evidence, track patterns, and Mermaid source.
 */
export function localizeTeachingPipelineResponse(
  response: TeachingPipelineResponse,
  outputLanguage: OutputLanguage,
): TeachingPipelineResponse {
  const pipelineId =
    response.detection.primaryPipelineId ||
    response.detection.primary_pipeline?.id ||
    'rendering_pipeline';
  const pipelineName = localizedSchemaLabel(pipelineId, outputLanguage);
  const sourceContent = response.teaching || response.teachingContent;
  const teaching = sourceContent
    ? {
        ...sourceContent,
        title: matchesLanguage(sourceContent.title, outputLanguage)
          ? sourceContent.title
          : outputLanguage === 'en'
            ? `${pipelineName} rendering pipeline`
            : `${pipelineName}渲染管线`,
        summary: projectedText(
          sourceContent.summary,
          outputLanguage,
          `说明 ${pipelineName} 中应用、渲染线程与系统合成之间的关键链路。`,
          `Explains the key path between the app, rendering threads, and system composition in ${pipelineName}.`,
        ),
        threadRoles: sourceContent.threadRoles.map(role => ({
          ...role,
          responsibility: roleResponsibility(role, outputLanguage),
        })),
      }
    : sourceContent;

  return {
    ...response,
    teaching,
    teachingContent: teaching,
    observedFlow: response.observedFlow
      ? {
          ...response.observedFlow,
          lanes: response.observedFlow.lanes.map(lane => ({
            ...lane,
            title: laneTitle(lane.role, lane.title, outputLanguage),
          })),
          dependencies: response.observedFlow.dependencies.map(dependency => ({
            ...dependency,
            detail: dependency.detail
              ? projectedText(
                  dependency.detail,
                  outputLanguage,
                  `${localizedSchemaLabel(dependency.relation, 'zh-CN')}关系。`,
                  `${localizedSchemaLabel(dependency.relation, 'en')} relation.`,
                )
              : dependency.detail,
          })),
          completeness: {
            ...response.observedFlow.completeness,
            missingSignals: response.observedFlow.completeness.missingSignals.map(
              signal => localizedSchemaLabel(signal, outputLanguage),
            ),
            warnings: response.observedFlow.completeness.warnings.map(warning =>
              genericWarning(warning, outputLanguage),
            ),
          },
        }
      : response.observedFlow,
    warnings: response.warnings?.map(warning => ({
      ...warning,
      message: warning.code === 'PIPELINE_UNDETERMINED' && outputLanguage === 'zh-CN'
        ? '当前 trace 缺少确认目标应用出图路径的证据。'
        : genericWarning(warning.message, outputLanguage),
    })),
    pinInstructions: response.pinInstructions.map(instruction => ({
      ...instruction,
      reason: projectedText(
        instruction.reason,
        outputLanguage,
        `固定 ${instruction.pattern} 以展示渲染管线证据。`,
        `Pin ${instruction.pattern} to display rendering-pipeline evidence.`,
      ),
    })),
    pinPlan: response.pinPlan
      ? {
          ...response.pinPlan,
          instructions: response.pinPlan.instructions.map(instruction => ({
            ...instruction,
            reason: projectedText(
              instruction.reason,
              outputLanguage,
              `固定 ${instruction.pattern} 以展示渲染管线证据。`,
              `Pin ${instruction.pattern} to display rendering-pipeline evidence.`,
            ),
          })),
          summary:
            outputLanguage === 'en'
              ? `${response.pinPlan.instructions.length} pin instructions planned.`
              : `已规划 ${response.pinPlan.instructions.length} 条 Pin 指令。`,
          warnings: response.pinPlan.warnings.map(warning =>
            genericWarning(warning, outputLanguage),
          ),
        }
      : response.pinPlan,
    overlayPlan: response.overlayPlan
      ? {
          ...response.overlayPlan,
          summary:
            outputLanguage === 'en'
              ? `${response.overlayPlan.eventIds.length} observed events are ready for overlay.`
              : `已有 ${response.overlayPlan.eventIds.length} 个观测事件可用于 Overlay。`,
          warnings: response.overlayPlan.warnings.map(warning =>
            genericWarning(warning, outputLanguage),
          ),
        }
      : response.overlayPlan,
  };
}
