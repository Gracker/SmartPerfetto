// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

/**
 * Skill Controller
 *
 * Handles HTTP requests for skill-based trace analysis.
 */

import { Request, Response } from 'express';
import { getTraceProcessorService } from '../services/traceProcessorService';
import {
  SkillAnalysisAdapter,
  SkillAnalysisRequest,
  createSkillAnalysisAdapter,
} from '../services/skillEngine/skillAnalysisAdapter';
import { ErrorResponse } from '../types';
import { toSingleString } from '../utils/httpValue';
import { sendRouteFailure } from '../middleware/routeFailure';
import {
  localize,
  parseOutputLanguage,
  type OutputLanguage,
} from '../agentv3/outputLanguage';
import {localizeSkillDefinition} from '../services/skillLocalization';

function requestOutputLanguage(req: Request) {
  return parseOutputLanguage(
    req.body?.outputLanguage ??
    req.query.outputLanguage ??
    req.headers['accept-language'] ??
    process.env.SMARTPERFETTO_OUTPUT_LANGUAGE,
  );
}

function localizedError(
  outputLanguage: OutputLanguage,
  error: {zh: string; en: string},
  details: {zh: string; en: string},
): ErrorResponse {
  return {
    error: localize(outputLanguage, error.zh, error.en),
    details: localize(outputLanguage, details.zh, details.en),
  };
}

function sendLocalizedFailure(
  res: Response,
  outputLanguage: OutputLanguage,
  error: unknown,
  failure: {code: string; message: {zh: string; en: string}; logLabel: string},
): void {
  sendRouteFailure(res, {
    code: failure.code,
    error: localize(outputLanguage, failure.message.zh, failure.message.en),
    logLabel: failure.logLabel,
  }, error);
}

class SkillController {
  private adapter: SkillAnalysisAdapter | null = null;

  /**
   * Get or create the adapter instance
   */
  private getAdapter(): SkillAnalysisAdapter {
    if (!this.adapter) {
      const traceProcessor = getTraceProcessorService();
      this.adapter = createSkillAnalysisAdapter(traceProcessor);
    }
    return this.adapter;
  }

  /**
   * List all available skills
   * GET /api/skills
   */
  listSkills = async (req: Request, res: Response) => {
    const outputLanguage = requestOutputLanguage(req);
    try {
      const adapter = this.getAdapter();
      const skills = await adapter.listSkills(outputLanguage);

      res.json({
        skills,
        count: skills.length,
      });
    } catch (error) {
      sendLocalizedFailure(res, outputLanguage, error, {
        code: 'skill_list_failed',
        message: {zh: '无法列出 Skills', en: 'Failed to list Skills'},
        logLabel: '[SkillController] Error listing skills',
      });
    }
  };

  /**
   * Get skill details
   * GET /api/skills/:skillId
   */
  getSkillDetail = async (req: Request, res: Response) => {
    const outputLanguage = requestOutputLanguage(req);
    try {
      const skillId = toSingleString(req.params.skillId);

      if (!skillId) {
        return res.status(400).json(localizedError(
          outputLanguage,
          {zh: '缺少 Skill ID', en: 'Missing Skill ID'},
          {zh: '必须提供 skillId', en: 'skillId is required'},
        ));
      }

      const adapter = this.getAdapter();
      const skill = await adapter.getSkillDetail(skillId);

      if (!skill) {
        return res.status(404).json(localizedError(
          outputLanguage,
          {zh: '未找到 Skill', en: 'Skill not found'},
          {
            zh: `没有找到 ID 为 ${skillId} 的 Skill`,
            en: `No Skill found with ID: ${skillId}`,
          },
        ));
      }
      const localizedSkill = localizeSkillDefinition(
        skill,
        outputLanguage,
        {
          externalAuthored:
            (await adapter.getSkillOrigin(skillId))?.origin === 'external_pack',
        },
      );

      res.json({
        id: localizedSkill.name,
        name: localizedSkill.name,
        version: localizedSkill.version,
        type: localizedSkill.type,
        meta: localizedSkill.meta,
        triggers: localizedSkill.triggers,
        prerequisites: localizedSkill.prerequisites,
        steps: (localizedSkill.steps || []).map((s: any) => ({
          id: s.id,
          name: s.name,
          type: s.type,
          description: s.description,
        })),
        inputs: localizedSkill.inputs,
        thresholds: localizedSkill.thresholds,
        output: localizedSkill.output,
      });
    } catch (error) {
      sendLocalizedFailure(res, outputLanguage, error, {
        code: 'skill_detail_failed',
        message: {zh: '无法获取 Skill 详情', en: 'Failed to get Skill details'},
        logLabel: '[SkillController] Error getting skill detail',
      });
    }
  };

  /**
   * Execute a specific skill
   * POST /api/skills/execute/:skillId
   * Body: { traceId, packageName? }
   */
  executeSkill = async (req: Request, res: Response) => {
    const outputLanguage = requestOutputLanguage(req);
    try {
      const skillId = toSingleString(req.params.skillId);
      const { traceId, packageName, params } = req.body;

      if (!skillId) {
        return res.status(400).json(localizedError(
          outputLanguage,
          {zh: '缺少 Skill ID', en: 'Missing Skill ID'},
          {
            zh: 'URL 参数中必须提供 skillId',
            en: 'skillId is required in URL parameters',
          },
        ));
      }

      if (!traceId) {
        return res.status(400).json(localizedError(
          outputLanguage,
          {zh: '缺少 Trace ID', en: 'Missing Trace ID'},
          {
            zh: '请求体中必须提供 traceId',
            en: 'traceId is required in the request body',
          },
        ));
      }

      const adapter = this.getAdapter();

      const request: SkillAnalysisRequest = {
        traceId,
        skillId,
        packageName: typeof packageName === 'string' ? packageName : undefined,
        params,  // Pass custom skill parameters
        outputLanguage,
      };

      const result = await adapter.analyze(request);

      res.json(result);
    } catch (error) {
      sendLocalizedFailure(res, outputLanguage, error, {
        code: 'skill_execute_failed',
        message: {zh: '无法执行 Skill', en: 'Failed to execute Skill'},
        logLabel: '[SkillController] Error executing skill',
      });
    }
  };

  /**
   * Analyze a trace with automatic skill detection
   * POST /api/skills/analyze
   * Body: { traceId, question, packageName? }
   */
  analyzeTrace = async (req: Request, res: Response) => {
    const outputLanguage = requestOutputLanguage(req);
    try {
      const { traceId, question, packageName, skillId } = req.body;

      if (!traceId) {
        return res.status(400).json(localizedError(
          outputLanguage,
          {zh: '缺少 Trace ID', en: 'Missing Trace ID'},
          {zh: '必须提供 traceId', en: 'traceId is required'},
        ));
      }

      if (!question && !skillId) {
        return res.status(400).json(localizedError(
          outputLanguage,
          {
            zh: '缺少问题或 Skill ID',
            en: 'Missing question or Skill ID',
          },
          {
            zh: '必须提供 question 或 skillId',
            en: 'Either question or skillId is required',
          },
        ));
      }

      const adapter = this.getAdapter();

      const request: SkillAnalysisRequest = {
        traceId,
        skillId,
        question,
        packageName,
        outputLanguage,
      };

      const result = await adapter.analyze(request);

      res.json(result);
    } catch (error) {
      sendLocalizedFailure(res, outputLanguage, error, {
        code: 'skill_trace_analysis_failed',
        message: {zh: '无法分析 Trace', en: 'Failed to analyze Trace'},
        logLabel: '[SkillController] Error analyzing trace',
      });
    }
  };

  /**
   * Detect intent from a question
   * POST /api/skills/detect-intent
   * Body: { question }
   */
  detectIntent = async (req: Request, res: Response) => {
    const outputLanguage = requestOutputLanguage(req);
    try {
      const { question } = req.body;

      if (!question) {
        return res.status(400).json(localizedError(
          outputLanguage,
          {zh: '缺少问题', en: 'Missing question'},
          {zh: '必须提供 question', en: 'question is required'},
        ));
      }

      const adapter = this.getAdapter();
      await adapter.ensureInitialized();

      const skillId = adapter.detectIntent(question);

      if (!skillId) {
        return res.json({
          matched: false,
          skillId: null,
          message: localize(
            outputLanguage,
            '没有找到与该问题匹配的 Skill。',
            'No matching Skill was found for the question.',
          ),
        });
      }

      const skill = await adapter.getSkillDetail(skillId);
      const localizedSkill = skill
        ? localizeSkillDefinition(skill, outputLanguage, {
            externalAuthored:
              (await adapter.getSkillOrigin(skillId))?.origin ===
              'external_pack',
          })
        : undefined;

      res.json({
        matched: true,
        skillId,
        skillName: localizedSkill?.meta.display_name || skillId,
        skillDescription: localizedSkill?.meta.description,
      });
    } catch (error) {
      sendLocalizedFailure(res, outputLanguage, error, {
        code: 'skill_intent_detection_failed',
        message: {zh: '无法识别分析意图', en: 'Failed to detect intent'},
        logLabel: '[SkillController] Error detecting intent',
      });
    }
  };

  /**
   * Detect vendor from trace metadata
   * POST /api/skills/detect-vendor
   * Body: { traceId }
   * Response: SkillVendorDetection (schemaVersion trace_vendor@1)
   */
  detectVendor = async (req: Request, res: Response) => {
    const outputLanguage = requestOutputLanguage(req);
    try {
      const { traceId } = req.body;

      if (!traceId) {
        return res.status(400).json(localizedError(
          outputLanguage,
          {zh: '缺少 Trace ID', en: 'Missing Trace ID'},
          {zh: '必须提供 traceId', en: 'traceId is required'},
        ));
      }

      const adapter = this.getAdapter();
      // SkillVendorDetection is the response contract (trace_vendor@1).
      res.json(await adapter.detectVendor(traceId));
    } catch (error) {
      sendLocalizedFailure(res, outputLanguage, error, {
        code: 'skill_vendor_detection_failed',
        message: {zh: '无法识别设备厂商', en: 'Failed to detect device vendor'},
        logLabel: '[SkillController] Error detecting vendor',
      });
    }
  };
}

export default SkillController;
