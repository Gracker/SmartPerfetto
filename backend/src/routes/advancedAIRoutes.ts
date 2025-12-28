import { Router } from 'express';
import {
  startSession,
  analyzeWithAI,
  getProactiveInsights,
  predictIssues,
  getSession,
  updatePreferences,
  deleteSession,
  executeQuery,
  getSmartSummary,
} from '../controllers/advancedAIController';
import { authenticate } from '../middleware/auth';

const router = Router();

// Apply authentication to all routes
router.use(authenticate);

// Session management
router.post('/session/start', startSession);
router.get('/session/:sessionId', getSession);
router.put('/session/:sessionId/preferences', updatePreferences);
router.delete('/session/:sessionId', deleteSession);

// AI analysis
router.post('/analyze', analyzeWithAI);

// Proactive features
router.get('/insights/:traceId', getProactiveInsights);
router.get('/predict/:traceId', predictIssues);
router.get('/summary/:traceId', getSmartSummary);

// Query execution
router.post('/query', executeQuery);

export default router;