import { Request, Response } from 'express';
import { AdvancedAIService } from '../services/advancedAIService';
import { v4 as uuidv4 } from 'uuid';

let aiService: AdvancedAIService;

function getAIService(): AdvancedAIService {
  if (!aiService) {
    aiService = new AdvancedAIService();
  }
  return aiService;
}

// Cleanup old sessions every hour
setInterval(() => {
  if (aiService) {
    getAIService().cleanup();
  }
}, 60 * 60 * 1000);

// Start or get an analysis session
export async function startSession(req: Request, res: Response): Promise<void> {
  try {
    const { traceId, message } = req.body;
    const sessionId = req.headers['x-session-id'] as string || uuidv4();

    const session = await getAIService().startAnalysis(sessionId, traceId, message);

    res.json({
      sessionId: session.id,
      traceId: session.traceId,
      context: session.context,
      messageCount: session.messages.length,
    });
  } catch (error: any) {
    console.error('Failed to start session:', error);
    res.status(500).json({ error: 'Failed to start session' });
  }
}

// Analyze with context
export async function analyzeWithAI(req: Request, res: Response): Promise<void> {
  try {
    const { query, sessionId } = req.body;

    if (!sessionId) {
      res.status(400).json({ error: 'Session ID is required' });
      return;
    }

    if (!query) {
      res.status(400).json({ error: 'Query is required' });
      return;
    }

    const result = await getAIService().analyzeWithContext(sessionId, query);

    res.json(result);
  } catch (error: any) {
    console.error('Analysis failed:', error);
    res.status(500).json({ error: error.message || 'Analysis failed' });
  }
}

// Get proactive insights
export async function getProactiveInsights(req: Request, res: Response): Promise<void> {
  try {
    const { traceId } = req.params;

    if (!traceId) {
      res.status(400).json({ error: 'Trace ID is required' });
      return;
    }

    const insights = await getAIService().getProactiveInsights(traceId);

    res.json({ insights });
  } catch (error: any) {
    console.error('Failed to get insights:', error);
    res.status(500).json({ error: 'Failed to get insights' });
  }
}

// Predict potential issues
export async function predictIssues(req: Request, res: Response): Promise<void> {
  try {
    const { traceId } = req.params;

    if (!traceId) {
      res.status(400).json({ error: 'Trace ID is required' });
      return;
    }

    const predictions = await getAIService().predictIssues(traceId);

    res.json({ predictions });
  } catch (error: any) {
    console.error('Failed to predict issues:', error);
    res.status(500).json({ error: 'Failed to predict issues' });
  }
}

// Get session history
export async function getSession(req: Request, res: Response): Promise<void> {
  try {
    const { sessionId } = req.params;

    if (!sessionId) {
      res.status(400).json({ error: 'Session ID is required' });
      return;
    }

    const session = getAIService().getSession(sessionId);

    if (!session) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }

    res.json({
      sessionId: session.id,
      traceId: session.traceId,
      messages: session.messages,
      context: session.context,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
    });
  } catch (error: any) {
    console.error('Failed to get session:', error);
    res.status(500).json({ error: 'Failed to get session' });
  }
}

// Update user preferences
export async function updatePreferences(req: Request, res: Response): Promise<void> {
  try {
    const { sessionId } = req.params;
    const preferences = req.body;

    if (!sessionId) {
      res.status(400).json({ error: 'Session ID is required' });
      return;
    }

    getAIService().updatePreferences(sessionId, preferences);

    const session = getAIService().getSession(sessionId);

    res.json({
      message: 'Preferences updated',
      preferences: session?.context.userPreferences,
    });
  } catch (error: any) {
    console.error('Failed to update preferences:', error);
    res.status(500).json({ error: 'Failed to update preferences' });
  }
}

// Delete session
export async function deleteSession(req: Request, res: Response): Promise<void> {
  try {
    const { sessionId } = req.params;

    if (!sessionId) {
      res.status(400).json({ error: 'Session ID is required' });
      return;
    }

    getAIService().deleteSession(sessionId);

    res.json({ message: 'Session deleted successfully' });
  } catch (error: any) {
    console.error('Failed to delete session:', error);
    res.status(500).json({ error: 'Failed to delete session' });
  }
}

// Execute suggested SQL query
export async function executeQuery(req: Request, res: Response): Promise<void> {
  try {
    const { traceId, query } = req.body;

    if (!traceId || !query) {
      res.status(400).json({ error: 'Trace ID and query are required' });
      return;
    }

    // Import trace service
    const { traceService } = await import('../controllers/traceProcessorController');

    const result = await traceService.query(traceId, query);

    res.json(result);
  } catch (error: any) {
    console.error('Query execution failed:', error);
    res.status(500).json({
      error: 'Query execution failed',
      details: error.message
    });
  }
}

// Get smart analysis summary
export async function getSmartSummary(req: Request, res: Response): Promise<void> {
  try {
    const { traceId } = req.params;

    if (!traceId) {
      res.status(400).json({ error: 'Trace ID is required' });
      return;
    }

    // Get trace metadata
    const { traceService } = await import('../controllers/traceProcessorController');
    const trace = traceService.getTrace(traceId);

    if (!trace) {
      res.status(404).json({ error: 'Trace not found' });
      return;
    }

    // Get proactive insights and predictions
    const [insights, predictions] = await Promise.all([
      getAIService().getProactiveInsights(traceId),
      getAIService().predictIssues(traceId),
    ]);

    // Generate summary
    const summary = {
      traceInfo: {
        filename: trace.filename,
        size: trace.size,
        status: trace.status,
        duration: trace.metadata?.duration,
        numEvents: trace.metadata?.numEvents,
      },
      insights,
      predictions,
      recommendations: generateRecommendations(insights, predictions),
    };

    res.json(summary);
  } catch (error: any) {
    console.error('Failed to generate summary:', error);
    res.status(500).json({ error: 'Failed to generate summary' });
  }
}

function generateRecommendations(insights: any[], predictions: any[]): string[] {
  const recommendations: Set<string> = new Set();

  // Extract recommendations from insights
  insights.forEach(insight => {
    if (insight.actionItems) {
      insight.actionItems.forEach((item: string) => recommendations.add(item));
    }
  });

  // Extract recommendations from predictions
  predictions.forEach(prediction => {
    if (prediction.actionItems) {
      prediction.actionItems.forEach((item: string) => recommendations.add(item));
    }
  });

  // Add common recommendations based on analysis
  if (insights.some(i => i.type === 'anomaly')) {
    recommendations.add('Investigate the detected anomalies for root causes');
    recommendations.add('Consider adding performance monitoring for these patterns');
  }

  if (predictions.some(p => p.severity === 'high' || p.severity === 'critical')) {
    recommendations.add('Prioritize fixing high-severity issues first');
    recommendations.add('Set up alerts for similar patterns in production');
  }

  return Array.from(recommendations);
}