import dotenv from 'dotenv';
// Load environment variables FIRST before importing routes
dotenv.config({ override: true });

import { installEpipeGuard } from './utils/epipeGuard';

import express from 'express';
import cors from 'cors';
import path from 'path';

// Import configuration
import { serverConfig } from './config';

// Import routes (now after dotenv.config())
import sqlRoutes from './routes/sql';
import simpleTraceRoutes from './routes/simpleTraceRoutes';
import perfettoLocalRoutes from './routes/perfettoLocalRoutes';
import aiChatRoutes from './routes/aiChatRoutes';
import autoAnalysisRoutes from './routes/autoAnalysis';
import sessionRoutes from './routes/sessionRoutes';
import perfettoSqlRoutes from './routes/perfettoSqlRoutes';
import exportRoutes from './routes/exportRoutes';
import templateAnalysisRoutes from './routes/templateAnalysisRoutes';
import skillRoutes from './routes/skillRoutes';
import skillAdminRoutes from './routes/skillAdminRoutes';
import strategyAdminRoutes from './routes/strategyAdminRoutes';
import reportRoutes from './routes/reportRoutes';
import agentRoutes from './routes/agentRoutes';
import advancedAIRoutes from './routes/advancedAIRoutes';
import providerRoutes from './routes/providerRoutes';
import {
  assertTraceAnalysisConfiguredForStartup,
  getTraceAnalysisConfigurationStatus,
} from './services/traceAnalysisSkill';
import {
  getClaudeRuntimeDiagnostics,
  hasClaudeCredentials,
  isClaudeCodeEnabled,
} from './agentv3/claudeConfig';
import { getProviderService } from './services/providerManager';
import {
  getLegacyApiUsageSnapshot,
} from './services/legacyApiTelemetry';
import {
  AGENT_API_V1_BASE,
  AGENT_API_V1_LLM_BASE,
  LEGACY_AGENT_API_BASE,
  rejectLegacyAgentApi,
} from './middleware/legacyAgentApi';

// Import cleanup utilities
import { TraceProcessorFactory, killOrphanProcessors } from './services/workingTraceProcessor';
import { getPortPool, resetPortPool } from './services/portPool';

const app = express();
const PORT = serverConfig.port;
const NODE_ENV = serverConfig.nodeEnv;

// Fail fast for trace-analysis-specific credentials when strict startup validation is enabled.
assertTraceAnalysisConfiguredForStartup();

// Middleware
app.use(cors({
  origin: serverConfig.corsOrigins,
  credentials: true,
}));

app.use(express.json({ limit: serverConfig.bodyLimit }));
app.use(express.urlencoded({ extended: true, limit: serverConfig.bodyLimit }));

// Health check endpoint
app.get('/health', (req, res) => {
  const useAgentV3 = isClaudeCodeEnabled();
  const claudeDiagnostics = getClaudeRuntimeDiagnostics();
  const providerSvc = getProviderService();
  const activeProvider = providerSvc.list().find(p => p.isActive);
  const aiEngineConfigured = useAgentV3
    ? (activeProvider != null || hasClaudeCredentials())
    : !!process.env.DEEPSEEK_API_KEY;

  res.json({
    status: 'OK',
    timestamp: new Date().toISOString(),
    environment: NODE_ENV,
    version: '1.0.0',
    traceAnalysis: getTraceAnalysisConfigurationStatus(),
    aiEngine: {
      runtime: useAgentV3 ? 'agentv3' : 'agentv2',
      model: useAgentV3
        ? (activeProvider?.models.primary || process.env.CLAUDE_MODEL || 'claude-sonnet-4-6')
        : (process.env.DEEPSEEK_MODEL || 'deepseek-chat'),
      providerMode: useAgentV3 ? claudeDiagnostics.providerMode : 'deepseek_legacy',
      configured: aiEngineConfigured,
      source: activeProvider ? 'provider-manager' : 'env-fallback',
      ...(activeProvider ? {
        activeProvider: {
          id: activeProvider.id,
          name: activeProvider.name,
          type: activeProvider.type,
        },
      } : {}),
      authRequired: !!process.env.SMARTPERFETTO_API_KEY,
      diagnostics: useAgentV3
        ? claudeDiagnostics
        : {
            runtime: 'agentv2',
            providerMode: 'deepseek_legacy',
            model: process.env.DEEPSEEK_MODEL || 'deepseek-chat',
            configured: !!process.env.DEEPSEEK_API_KEY,
            configHint: 'AI_SERVICE=deepseek uses the deprecated agentv2 fallback. New provider integrations should use agentv3 with an Anthropic-compatible proxy.',
          },
    },
  });
});

// Debug endpoint to check env vars
app.get('/debug', (req, res) => {
  const legacyUsage = getLegacyApiUsageSnapshot(10);
  res.json({
    hasDeepSeekKey: !!process.env.DEEPSEEK_API_KEY,
    deepSeekBaseUrl: process.env.DEEPSEEK_BASE_URL,
    deepSeekModel: process.env.DEEPSEEK_MODEL,
    aiService: process.env.AI_SERVICE,
    cwd: process.cwd(),
    legacyAgentApiUsage: legacyUsage,
  });
});

// API routes
app.use('/api/sql', sqlRoutes);
app.use('/api/traces', simpleTraceRoutes);
app.use(AGENT_API_V1_LLM_BASE, aiChatRoutes);
app.use('/api/perfetto', perfettoLocalRoutes);
app.use('/api/auto-analysis', autoAnalysisRoutes);
app.use('/api/sessions', sessionRoutes);
app.use('/api/perfetto-sql', perfettoSqlRoutes);
app.use('/api/export', exportRoutes);
app.use('/api/template-analysis', templateAnalysisRoutes);
app.use('/api/skills', skillRoutes);
app.use('/api/admin', skillAdminRoutes);
app.use('/api/admin', strategyAdminRoutes);
app.use('/api/reports', reportRoutes);
app.use(AGENT_API_V1_BASE, agentRoutes);
app.use('/api/advanced-ai', advancedAIRoutes);
app.use('/api/v1/providers', providerRoutes);
app.use(LEGACY_AGENT_API_BASE, rejectLegacyAgentApi);

const assistantShellDir = path.resolve(__dirname, '../public/assistant-shell');
app.get('/assistant-shell', (_req, res) => {
  res.sendFile(path.join(assistantShellDir, 'index.html'));
});
app.use('/assistant-shell', express.static(assistantShellDir));

// Serve uploaded files in development
if (NODE_ENV === 'development') {
  app.use('/uploads', express.static(path.join(__dirname, '../uploads')));
}

// 404 handler
app.use((req, res) => {
  res.status(404).json({
    error: 'Route not found',
    message: `Cannot ${req.method} ${req.originalUrl}`,
  });
});

// Global error handler
app.use((err: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
  console.error('Unhandled error:', err);

  res.status(err.status || 500).json({
    error: 'Internal server error',
    message: NODE_ENV === 'development' ? err.message : 'Something went wrong',
    ...(NODE_ENV === 'development' && { stack: err.stack }),
  });
});

// Initialize services
// Kill orphan trace_processor processes from previous runs
killOrphanProcessors();

// Graceful shutdown handler
function gracefulShutdown(signal: string) {
  console.log(`\n📴 Received ${signal}, shutting down gracefully...`);

  // Cleanup all trace processors (this will also release ports)
  console.log('🧹 Cleaning up trace processors...');
  TraceProcessorFactory.cleanup();

  // Reset port pool
  console.log('🔌 Resetting port pool...');
  resetPortPool();

  console.log('✅ Cleanup complete, exiting...');
  process.exit(0);
}

// Register signal handlers
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// EPIPE guard: prevent stdout/stderr/uncaughtException EPIPE from crashing the server.
// Non-EPIPE uncaught exceptions still trigger graceful shutdown.
installEpipeGuard((error) => {
  console.error('❌ Uncaught Exception:', error);
  gracefulShutdown('uncaughtException');
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('❌ Unhandled Rejection at:', promise, 'reason:', reason);
});

// Start server
const server = app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`📊 Environment: ${NODE_ENV}`);
  console.log(`🔗 API URL: http://localhost:${PORT}/api`);
  console.log(`❤️  Health check: http://localhost:${PORT}/health`);
  console.log(`📈 Stats: http://localhost:${PORT}/api/traces/stats`);
});

// Handle server close
server.on('close', () => {
  console.log('🔒 Server closed');
});
