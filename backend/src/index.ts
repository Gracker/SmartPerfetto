import dotenv from 'dotenv';
// Load environment variables FIRST before importing routes
dotenv.config();

import express from 'express';
import cors from 'cors';
import path from 'path';

// Import configuration
import { serverConfig } from './config';

// Import routes (now after dotenv.config())
import sqlRoutes from './routes/sql';
import traceRoutes from './routes/trace';
import traceProcessorRoutes from './routes/traceProcessorRoutes';
import advancedAIRoutes from './routes/advancedAIRoutes';
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
import reportRoutes from './routes/reportRoutes';
import agentRoutes from './routes/agentRoutes';

// Import cleanup utilities
import { TraceProcessorFactory, killOrphanProcessors } from './services/workingTraceProcessor';
import { getPortPool, resetPortPool } from './services/portPool';

const app = express();
const PORT = serverConfig.port;
const NODE_ENV = serverConfig.nodeEnv;

// Middleware
app.use(cors({
  origin: serverConfig.corsOrigins,
  credentials: true,
}));

app.use(express.json({ limit: serverConfig.bodyLimit }));
app.use(express.urlencoded({ extended: true, limit: serverConfig.bodyLimit }));

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({
    status: 'OK',
    timestamp: new Date().toISOString(),
    environment: NODE_ENV,
    version: '1.0.0',
  });
});

// Debug endpoint to check env vars
app.get('/debug', (req, res) => {
  res.json({
    hasDeepSeekKey: !!process.env.DEEPSEEK_API_KEY,
    deepSeekBaseUrl: process.env.DEEPSEEK_BASE_URL,
    deepSeekModel: process.env.DEEPSEEK_MODEL,
    aiService: process.env.AI_SERVICE,
    cwd: process.cwd(),
  });
});

// API routes
app.use('/api/sql', sqlRoutes);
app.use('/api/trace', traceRoutes);
app.use('/api/traces', simpleTraceRoutes);
app.use('/chat', aiChatRoutes);
app.use('/api/ai', advancedAIRoutes);
app.use('/api/perfetto', perfettoLocalRoutes);
app.use('/api/auto-analysis', autoAnalysisRoutes);
app.use('/api/sessions', sessionRoutes);
app.use('/api/perfetto-sql', perfettoSqlRoutes);
app.use('/api/export', exportRoutes);
app.use('/api/template-analysis', templateAnalysisRoutes);
app.use('/api/skills', skillRoutes);
app.use('/api/admin', skillAdminRoutes);
app.use('/api/reports', reportRoutes);
app.use('/api/agent', agentRoutes);

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

// Handle uncaught exceptions
process.on('uncaughtException', (error) => {
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
