// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import express from 'express';
import { requireRequestContext } from '../middleware/auth';
import { sendResourceNotFound } from '../services/resourceOwnership';
import { readTraceMetadataForContext } from '../services/traceMetadataStore';
import { getTraceProcessorService } from '../services/traceProcessorService';
import { getPipelineDocService } from '../services/pipelineDocService';
import {
  ensurePipelineSkillsInitialized,
  pipelineSkillLoader,
  PinInstruction,
} from '../services/pipelineSkillLoader';
import { SkillExecutor } from '../services/skillEngine/skillExecutor';
import { skillRegistry, ensureSkillRegistryInitialized } from '../services/skillEngine/skillLoader';
import {
  validateActiveProcesses,
  validateConfidence,
  parseCandidates,
  parseFeatures,
  transformPinInstruction,
  type ActiveProcess,
  type PinInstructionResponse,
  type RawPinInstruction,
} from '../types/teaching.types';
import {
  TEACHING_DEFAULTS,
  TEACHING_LIMITS,
  TEACHING_STEP_IDS,
  TEACHING_FEATURES,
} from '../config/teaching.config';

export function registerTeachingRoutes(router: express.Router): void {
  router.post('/teaching/pipeline', async (req, res) => {
    try {
      const { traceId, packageName } = req.body;

      if (!traceId) {
        return res.status(400).json({
          success: false,
          error: 'traceId is required',
        });
      }

      if (!await readTraceMetadataForContext(traceId, requireRequestContext(req))) {
        return sendResourceNotFound(res, 'Trace not found in backend');
      }

      const traceProcessorService = getTraceProcessorService();
      const trace = traceProcessorService.getTrace(traceId);
      if (!trace) {
        return res.status(404).json({
          success: false,
          error: 'Trace not found in backend',
          hint: 'Please upload the trace to the backend first',
          code: 'TRACE_NOT_UPLOADED',
        });
      }

      console.log(`[AgentRoutes] Teaching pipeline request for trace: ${traceId}`);

      console.log('[AgentRoutes] Step 1: Initializing skill registry...');
      await ensureSkillRegistryInitialized();
      console.log(
        '[AgentRoutes] Step 2: Skill registry initialized, skills count:',
        skillRegistry.getAllSkills().length
      );

      console.log('[AgentRoutes] Step 3: Creating SkillExecutor...');
      const skillExecutor = new SkillExecutor(traceProcessorService);
      skillExecutor.registerSkills(skillRegistry.getAllSkills());
      console.log('[AgentRoutes] Step 4: Skills registered');

      console.log('[AgentRoutes] Step 5: Executing rendering_pipeline_detection skill...');
      const detectionResult = await skillExecutor.execute('rendering_pipeline_detection', traceId, {
        package: packageName || '',
      });
      console.log('[AgentRoutes] Step 6: Skill execution complete, success:', detectionResult.success);

      if (!detectionResult.success) {
        console.error('[AgentRoutes] Skill execution failed:', detectionResult.error);
        return res.status(500).json({
          success: false,
          error: 'Pipeline detection failed',
          details: detectionResult.error,
        });
      }

      const rawResults = detectionResult.rawResults || {};

      const subvariantsStepResult = rawResults['subvariants'];
      const subvariantsRow =
        Array.isArray(subvariantsStepResult?.data) && subvariantsStepResult.data.length > 0
          ? (subvariantsStepResult.data[0] as Record<string, any>)
          : null;
      const subvariants = subvariantsRow
        ? {
            buffer_mode: String(subvariantsRow.buffer_mode ?? 'UNKNOWN'),
            flutter_engine: String(subvariantsRow.flutter_engine ?? 'N/A'),
            webview_mode: String(subvariantsRow.webview_mode ?? 'N/A'),
            game_engine: String(subvariantsRow.game_engine ?? 'N/A'),
          }
        : null;

      // SkillEngine vNext path: consume the first-class pipeline step result when available.
      const pipelineBundleStepResult = rawResults['pipeline_bundle'];
      const pipelineBundleData =
        pipelineBundleStepResult?.data &&
        typeof pipelineBundleStepResult.data === 'object' &&
        !Array.isArray(pipelineBundleStepResult.data)
          ? (pipelineBundleStepResult.data as Record<string, any>)
          : null;
      const pipelineBundleDetection = pipelineBundleData?.detection as Record<string, any> | undefined;

      if (pipelineBundleDetection && typeof pipelineBundleDetection.primaryPipelineId === 'string') {
        const primaryPipelineId = String(pipelineBundleDetection.primaryPipelineId || TEACHING_DEFAULTS.pipelineId);
        const primaryConfidence = validateConfidence(
          pipelineBundleDetection.primaryConfidence,
          TEACHING_DEFAULTS.confidence
        );
        const response = {
          success: true,
          detection: {
            primary_pipeline: {
              id: primaryPipelineId,
              confidence: primaryConfidence,
            },
            candidates: Array.isArray(pipelineBundleDetection.candidates)
              ? pipelineBundleDetection.candidates
              : [{ id: primaryPipelineId, confidence: primaryConfidence }],
            features: Array.isArray(pipelineBundleDetection.features)
              ? pipelineBundleDetection.features
              : [],
            subvariants: subvariants || {
              buffer_mode: 'UNKNOWN',
              flutter_engine: 'N/A',
              webview_mode: 'N/A',
              game_engine: 'N/A',
            },
            trace_requirements_missing: Array.isArray(pipelineBundleDetection.traceRequirementsMissing)
              ? pipelineBundleDetection.traceRequirementsMissing
              : [],
          },
          teaching: pipelineBundleData?.teachingContent
            ? {
                title: String((pipelineBundleData.teachingContent as any).title || `渲染管线: ${primaryPipelineId}`),
                summary: String((pipelineBundleData.teachingContent as any).summary || ''),
                mermaidBlocks: Array.isArray((pipelineBundleData.teachingContent as any).mermaidBlocks)
                  ? (pipelineBundleData.teachingContent as any).mermaidBlocks
                  : [],
                threadRoles: Array.isArray((pipelineBundleData.teachingContent as any).threadRoles)
                  ? (pipelineBundleData.teachingContent as any).threadRoles
                  : [],
                keySlices: Array.isArray((pipelineBundleData.teachingContent as any).keySlices)
                  ? (pipelineBundleData.teachingContent as any).keySlices
                  : [],
                docPath: String((pipelineBundleData.teachingContent as any).docPath || pipelineBundleData.docPath || ''),
              }
            : {
                title: `渲染管线: ${primaryPipelineId}`,
                summary: '未找到对应的文档内容。',
                mermaidBlocks: [],
                threadRoles: [],
                keySlices: [],
                docPath: String(pipelineBundleData?.docPath || TEACHING_DEFAULTS.docPath),
              },
          pinInstructions: Array.isArray(pipelineBundleData?.pinInstructions)
            ? pipelineBundleData?.pinInstructions
            : [],
          activeRenderingProcesses: Array.isArray(pipelineBundleData?.activeRenderingProcesses)
            ? pipelineBundleData.activeRenderingProcesses.map((p: any) => ({
                processName: p.processName,
                frameCount: p.frameCount,
                renderThreadTid: p.renderThreadTid,
              }))
            : [],
        };

        console.log(
          `[AgentRoutes] Teaching pipeline (SkillEngine pipeline step): ${primaryPipelineId} (${(primaryConfidence * 100).toFixed(1)}%)`
        );
        res.json(response);
        return;
      }

      const pipelineStepResult = rawResults['determine_pipeline'];
      const pipelineRow =
        Array.isArray(pipelineStepResult?.data) && pipelineStepResult.data.length > 0
          ? (pipelineStepResult.data[0] as Record<string, any>)
          : null;
      const pipelineResult = pipelineRow
        ? {
            primary_pipeline_id: String(pipelineRow.primary_pipeline_id ?? ''),
            primary_confidence: pipelineRow.primary_confidence,
            candidates_list: pipelineRow.candidates_list,
            features_list: pipelineRow.features_list,
            doc_path: pipelineRow.doc_path,
          }
        : null;

      const traceReqStepResult = rawResults['trace_requirements'];
      const traceReqRow =
        Array.isArray(traceReqStepResult?.data) && traceReqStepResult.data.length > 0
          ? (traceReqStepResult.data[0] as Record<string, any>)
          : null;
      const traceRequirementsMissing = traceReqRow
        ? Object.values(traceReqRow).filter((v: any) => typeof v === 'string' && v.trim())
        : [];

      const activeProcessesStepResult = rawResults[TEACHING_STEP_IDS.activeProcesses];
      const activeRenderingProcesses: ActiveProcess[] = TEACHING_FEATURES.useSqlValidation
        ? validateActiveProcesses(activeProcessesStepResult)
        : Array.isArray(activeProcessesStepResult?.data)
          ? activeProcessesStepResult.data
              .map((row: any) => ({
                upid:
                  typeof row?.upid === 'number' ? row.upid : parseInt(String(row?.upid ?? ''), 10) || 0,
                processName: String(row?.process_name ?? row?.processName ?? row?.name ?? ''),
                frameCount:
                  typeof row?.frame_count === 'number'
                    ? row.frame_count
                    : parseInt(String(row?.frame_count ?? row?.frameCount ?? row?.count ?? ''), 10) || 0,
                renderThreadTid:
                  typeof row?.render_thread_tid === 'number'
                    ? row.render_thread_tid
                    : parseInt(
                        String(row?.render_thread_tid ?? row?.renderThreadTid ?? row?.tid ?? ''),
                        10
                      ) || 0,
              }))
              .filter((p: ActiveProcess) => p.processName)
          : activeProcessesStepResult?.data?.rows?.map((row: unknown[]) => ({
                upid: row[0] as number,
                processName: row[1] as string,
                frameCount: row[2] as number,
                renderThreadTid: row[3] as number,
              })) || [];

      if (TEACHING_FEATURES.debugLogging) {
        console.log(
          '[AgentRoutes] Active rendering processes:',
          activeRenderingProcesses.map((p) => `${p.processName} (${p.frameCount} frames)`)
        );
      }

      const primaryPipelineId = pipelineResult?.primary_pipeline_id || TEACHING_DEFAULTS.pipelineId;
      const primaryConfidence = validateConfidence(
        pipelineResult?.primary_confidence,
        TEACHING_DEFAULTS.confidence
      );
      const candidatesList = pipelineResult?.candidates_list || '';
      const featuresList = pipelineResult?.features_list || '';
      const docPath = pipelineResult?.doc_path || TEACHING_DEFAULTS.docPath;

      const candidates = candidatesList
        ? parseCandidates(candidatesList, TEACHING_LIMITS.maxCandidates)
        : [{ id: primaryPipelineId, confidence: primaryConfidence }];

      const features = parseFeatures(featuresList);

      await ensurePipelineSkillsInitialized();

      const yamlTeaching = pipelineSkillLoader.getTeachingContent(primaryPipelineId);
      const pipelineDocService = getPipelineDocService();
      const mdTeaching = pipelineDocService.getTeachingContent(primaryPipelineId);

      const teachingContent = yamlTeaching
        ? {
            title: yamlTeaching.title,
            summary: yamlTeaching.summary,
            mermaidBlocks: yamlTeaching.mermaid ? [yamlTeaching.mermaid] : [],
            threadRoles: yamlTeaching.thread_roles.map((role) => ({
              thread: role.thread,
              responsibility: role.role + (role.description ? `: ${role.description}` : ''),
              traceTag: role.trace_tags,
            })),
            keySlices: yamlTeaching.key_slices.map((slice) => slice.name),
            docPath: pipelineSkillLoader.getPipelineMeta(primaryPipelineId)?.doc_path || '',
          }
        : mdTeaching;

      const basePinInstructions = pipelineSkillLoader.getAutoPinInstructions(primaryPipelineId);
      const smartFilterConfigs = pipelineSkillLoader.getSmartFilterConfigs(primaryPipelineId);

      const smartPinInstructions: PinInstructionResponse[] = TEACHING_FEATURES.useTypeTransforms
        ? basePinInstructions.map((inst: PinInstruction) => {
            const hasSmartFilter = inst.smart_filter?.enabled ?? smartFilterConfigs.has(inst.pattern);

            const rawInst: RawPinInstruction = {
              pattern: inst.pattern,
              match_by: inst.match_by,
              priority: inst.priority,
              reason: inst.reason,
              expand: inst.expand,
              main_thread_only: inst.main_thread_only,
              smart_filter: hasSmartFilter ? inst.smart_filter : undefined,
            };

            const transformed = transformPinInstruction(rawInst, activeRenderingProcesses);
            if (transformed.smartPin && !transformed.skipPin) {
              transformed.reason = `${inst.reason} (${activeRenderingProcesses.length} 活跃进程)`;
            }

            return transformed;
          })
        : basePinInstructions.map((inst: PinInstruction): PinInstructionResponse => {
            const hasSmartFilter = smartFilterConfigs.has(inst.pattern) || inst.smart_filter?.enabled;
            const hasActiveRenderingData = activeRenderingProcesses.length > 0;
            const activeProcessNames = new Set(activeRenderingProcesses.map((p) => p.processName));

            const baseInstruction: PinInstructionResponse = {
              pattern: inst.pattern,
              matchBy: inst.match_by,
              priority: inst.priority,
              reason: inst.reason,
              expand: inst.expand,
              mainThreadOnly: inst.main_thread_only,
            };

            if (hasSmartFilter) {
              if (hasActiveRenderingData) {
                return {
                  ...baseInstruction,
                  activeProcessNames: Array.from(activeProcessNames),
                  smartPin: true,
                  reason: `${inst.reason} (${activeRenderingProcesses.length} 活跃进程)`,
                };
              }
              return {
                ...baseInstruction,
                reason: `${inst.reason} (未检测到活跃渲染进程，使用默认 Pin)`,
              };
            }
            return baseInstruction;
          });

      const response = {
        success: true,
        detection: {
          primary_pipeline: {
            id: primaryPipelineId,
            confidence: primaryConfidence,
          },
          candidates,
          features,
          subvariants: subvariants || {
            buffer_mode: 'UNKNOWN',
            flutter_engine: 'N/A',
            webview_mode: 'N/A',
            game_engine: 'N/A',
          },
          trace_requirements_missing: traceRequirementsMissing,
        },
        teaching: teachingContent
          ? {
              title: teachingContent.title,
              summary: teachingContent.summary,
              mermaidBlocks: teachingContent.mermaidBlocks,
              threadRoles: teachingContent.threadRoles,
              keySlices: teachingContent.keySlices,
              docPath: teachingContent.docPath,
            }
          : {
              title: `渲染管线: ${primaryPipelineId}`,
              summary: '未找到对应的文档内容。',
              mermaidBlocks: [],
              threadRoles: [],
              keySlices: [],
              docPath,
            },
        pinInstructions: smartPinInstructions,
        activeRenderingProcesses: activeRenderingProcesses.map((p: any) => ({
          processName: p.processName,
          frameCount: p.frameCount,
          renderThreadTid: p.renderThreadTid,
        })),
      };

      console.log(
        `[AgentRoutes] Teaching pipeline detected: ${primaryPipelineId} (${(primaryConfidence * 100).toFixed(1)}%)`
      );
      console.log(`[AgentRoutes] Smart pin: ${activeRenderingProcesses.length} active rendering processes`);
      res.json(response);
    } catch (error: any) {
      console.error('[AgentRoutes] Teaching pipeline error:', error);
      console.error('[AgentRoutes] Stack trace:', error.stack);
      res.status(500).json({
        success: false,
        error: error.message || 'Failed to detect pipeline',
        stack: process.env.NODE_ENV !== 'production' ? error.stack : undefined,
      });
    }
  });
}
