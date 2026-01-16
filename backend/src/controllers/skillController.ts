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
    try {
      const adapter = this.getAdapter();
      const skills = await adapter.listSkills();

      res.json({
        skills,
        count: skills.length,
      });
    } catch (error) {
      console.error('[SkillController] Error listing skills:', error);
      const errorResponse: ErrorResponse = {
        error: 'Failed to list skills',
        details: error instanceof Error ? error.message : 'Unknown error',
      };
      res.status(500).json(errorResponse);
    }
  };

  /**
   * Get skill details
   * GET /api/skills/:skillId
   */
  getSkillDetail = async (req: Request, res: Response) => {
    try {
      const { skillId } = req.params;

      if (!skillId) {
        return res.status(400).json({
          error: 'Missing skill ID',
          details: 'skillId is required',
        });
      }

      const adapter = this.getAdapter();
      const skill = await adapter.getSkillDetail(skillId);

      if (!skill) {
        return res.status(404).json({
          error: 'Skill not found',
          details: `No skill found with ID: ${skillId}`,
        });
      }

      res.json({
        id: skill.name,
        name: skill.name,
        version: skill.version,
        type: skill.type,
        meta: skill.meta,
        triggers: skill.triggers,
        prerequisites: skill.prerequisites,
        steps: (skill.steps || []).map((s: any) => ({
          id: s.id,
          name: s.name,
          type: s.type,
          description: s.description,
        })),
        inputs: skill.inputs,
        thresholds: skill.thresholds,
        output: skill.output,
      });
    } catch (error) {
      console.error('[SkillController] Error getting skill detail:', error);
      const errorResponse: ErrorResponse = {
        error: 'Failed to get skill detail',
        details: error instanceof Error ? error.message : 'Unknown error',
      };
      res.status(500).json(errorResponse);
    }
  };

  /**
   * Execute a specific skill
   * POST /api/skills/execute/:skillId
   * Body: { traceId, packageName? }
   */
  executeSkill = async (req: Request, res: Response) => {
    try {
      const { skillId } = req.params;
      const { traceId, packageName, params } = req.body;

      if (!skillId) {
        return res.status(400).json({
          error: 'Missing skill ID',
          details: 'skillId is required in URL params',
        });
      }

      if (!traceId) {
        return res.status(400).json({
          error: 'Missing trace ID',
          details: 'traceId is required in request body',
        });
      }

      const adapter = this.getAdapter();

      const request: SkillAnalysisRequest = {
        traceId,
        skillId,
        packageName,
        params,  // Pass custom skill parameters
      };

      const result = await adapter.analyze(request);

      res.json(result);
    } catch (error) {
      console.error('[SkillController] Error executing skill:', error);
      const errorResponse: ErrorResponse = {
        error: 'Failed to execute skill',
        details: error instanceof Error ? error.message : 'Unknown error',
      };
      res.status(500).json(errorResponse);
    }
  };

  /**
   * Analyze a trace with automatic skill detection
   * POST /api/skills/analyze
   * Body: { traceId, question, packageName? }
   */
  analyzeTrace = async (req: Request, res: Response) => {
    try {
      const { traceId, question, packageName, skillId } = req.body;

      if (!traceId) {
        return res.status(400).json({
          error: 'Missing trace ID',
          details: 'traceId is required',
        });
      }

      if (!question && !skillId) {
        return res.status(400).json({
          error: 'Missing question or skillId',
          details: 'Either question or skillId is required',
        });
      }

      const adapter = this.getAdapter();

      const request: SkillAnalysisRequest = {
        traceId,
        skillId,
        question,
        packageName,
      };

      const result = await adapter.analyze(request);

      res.json(result);
    } catch (error) {
      console.error('[SkillController] Error analyzing trace:', error);
      const errorResponse: ErrorResponse = {
        error: 'Failed to analyze trace',
        details: error instanceof Error ? error.message : 'Unknown error',
      };
      res.status(500).json(errorResponse);
    }
  };

  /**
   * Detect intent from a question
   * POST /api/skills/detect-intent
   * Body: { question }
   */
  detectIntent = async (req: Request, res: Response) => {
    try {
      const { question } = req.body;

      if (!question) {
        return res.status(400).json({
          error: 'Missing question',
          details: 'question is required',
        });
      }

      const adapter = this.getAdapter();
      await adapter.ensureInitialized();

      const skillId = adapter.detectIntent(question);

      if (!skillId) {
        return res.json({
          matched: false,
          skillId: null,
          message: 'No matching skill found for the given question',
        });
      }

      const skill = await adapter.getSkillDetail(skillId);

      res.json({
        matched: true,
        skillId,
        skillName: skill?.meta.display_name || skillId,
        skillDescription: skill?.meta.description,
      });
    } catch (error) {
      console.error('[SkillController] Error detecting intent:', error);
      const errorResponse: ErrorResponse = {
        error: 'Failed to detect intent',
        details: error instanceof Error ? error.message : 'Unknown error',
      };
      res.status(500).json(errorResponse);
    }
  };

  /**
   * Detect vendor from trace
   * POST /api/skills/detect-vendor
   * Body: { traceId }
   */
  detectVendor = async (req: Request, res: Response) => {
    try {
      const { traceId } = req.body;

      if (!traceId) {
        return res.status(400).json({
          error: 'Missing trace ID',
          details: 'traceId is required',
        });
      }

      const adapter = this.getAdapter();
      const vendorResult = await adapter.detectVendor(traceId);

      res.json({
        vendor: vendorResult.vendor,
        confidence: vendorResult.confidence,
      });
    } catch (error) {
      console.error('[SkillController] Error detecting vendor:', error);
      const errorResponse: ErrorResponse = {
        error: 'Failed to detect vendor',
        details: error instanceof Error ? error.message : 'Unknown error',
      };
      res.status(500).json(errorResponse);
    }
  };
}

export default SkillController;
