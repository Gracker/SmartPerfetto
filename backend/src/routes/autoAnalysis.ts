import { Router } from 'express';
import AutoAnalysisController from '../controllers/autoAnalysisController';
import { body } from 'express-validator';

const router = Router();
const controller = new AutoAnalysisController();

// POST /api/auto-analysis/analyze - 分析 trace
router.post(
  '/analyze',
  [
    body('traceFile').optional(),
    body('fileId').optional(),
  ],
  controller.analyzeTrace
);

// GET /api/auto-analysis/patterns - 获取分析模式
router.get('/patterns', controller.getPatterns);

// POST /api/auto-analysis/report - 生成报告
router.post(
  '/report',
  [
    body('analysis').notEmpty(),
  ],
  controller.generateReport
);

// POST /api/auto-analysis/enhance - AI 增强分析
router.post(
  '/enhance',
  [
    body('analysis').notEmpty(),
    body('query').optional(),
  ],
  controller.enhanceAnalysis
);

export default router;