import { Request, Response } from 'express';
import AutoAnalysisService from '../services/autoAnalysisService';
import AIService from '../services/aiService';
import { ErrorResponse } from '../types';

class AutoAnalysisController {
  private autoAnalysisService: AutoAnalysisService;
  private aiService: AIService;

  constructor() {
    this.autoAnalysisService = new AutoAnalysisService();
    this.aiService = new AIService();
  }

  // 分析 Trace 文件
  analyzeTrace = async (req: Request, res: Response): Promise<void> => {
    try {
      const { traceFile, fileId } = req.body;

      if (!traceFile && !fileId) {
        const error: ErrorResponse = {
          error: 'Missing trace file',
          details: 'Please provide traceFile or fileId',
        };
        res.status(400).json(error);
        return;
      }

      // 如果提供了 fileId，获取文件路径
      let filePath = traceFile;
      if (fileId) {
        // 从 trace 存储中获取文件路径
        const fs = require('fs').promises;
        const path = require('path');
        const uploadsDir = path.join(__dirname, '../../uploads');

        // 查找文件
        const files = await fs.readdir(uploadsDir);
        const file = files.find((f: string) => f.includes(fileId) || f === fileId);

        if (!file) {
          const error: ErrorResponse = {
            error: 'File not found',
            details: `Trace file with ID ${fileId} not found`,
          };
          res.status(404).json(error);
          return;
        }

        filePath = path.join(uploadsDir, file);
      }

      // 执行自动分析
      const analysis = await this.autoAnalysisService.analyzeTrace(filePath);

      res.json({
        success: true,
        data: analysis,
        message: 'Analysis completed successfully',
      });
    } catch (error) {
      console.error('Error analyzing trace:', error);
      const errorResponse: ErrorResponse = {
        error: 'Analysis failed',
        details: error instanceof Error ? error.message : 'Unknown error',
      };
      res.status(500).json(errorResponse);
    }
  };

  // 获取分析模式
  getPatterns = async (req: Request, res: Response): Promise<void> => {
    try {
      const patterns = this.autoAnalysisService.getPatterns();

      res.json({
        success: true,
        data: patterns,
      });
    } catch (error) {
      console.error('Error getting patterns:', error);
      const errorResponse: ErrorResponse = {
        error: 'Failed to get patterns',
        details: error instanceof Error ? error.message : 'Unknown error',
      };
      res.status(500).json(errorResponse);
    }
  };

  // 生成报告
  generateReport = async (req: Request, res: Response): Promise<void> => {
    try {
      const { analysis } = req.body;

      if (!analysis) {
        const error: ErrorResponse = {
          error: 'Missing analysis data',
          details: 'Please provide analysis data',
        };
        res.status(400).json(error);
        return;
      }

      const report = await this.autoAnalysisService.generateReport(analysis);

      res.json({
        success: true,
        data: report,
      });
    } catch (error) {
      console.error('Error generating report:', error);
      const errorResponse: ErrorResponse = {
        error: 'Report generation failed',
        details: error instanceof Error ? error.message : 'Unknown error',
      };
      res.status(500).json(errorResponse);
    }
  };

  // AI 增强分析
  enhanceAnalysis = async (req: Request, res: Response): Promise<void> => {
    try {
      const { analysis, query } = req.body;

      if (!analysis) {
        const error: ErrorResponse = {
          error: 'Missing analysis data',
          details: 'Please provide analysis data',
        };
        res.status(400).json(error);
        return;
      }

      const enhancedResult = await this.autoAnalysisService.enhanceAnalysis(
        analysis,
        query,
        this.aiService
      );

      res.json({
        success: true,
        data: enhancedResult,
        message: enhancedResult.aiSummary ? 'AI enhancement applied' : 'AI enhancement unavailable',
      });
    } catch (error) {
      console.error('Error enhancing analysis:', error);
      const errorResponse: ErrorResponse = {
        error: 'Enhancement failed',
        details: error instanceof Error ? error.message : 'Unknown error',
      };
      res.status(500).json(errorResponse);
    }
  };
}

export default AutoAnalysisController;
