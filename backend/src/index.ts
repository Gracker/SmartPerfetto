import dotenv from 'dotenv';
// Load environment variables FIRST before importing routes
dotenv.config();

import express from 'express';
import cors from 'cors';
import path from 'path';

// Import routes (now after dotenv.config())
import authRoutes from './routes/auth';
import sqlRoutes from './routes/sql';
import traceRoutes from './routes/trace';
import traceProcessorRoutes from './routes/traceProcessorRoutes';
import articleRoutes from './routes/articles';
import advancedAIRoutes from './routes/advancedAIRoutes';
import simpleTraceRoutes from './routes/simpleTraceRoutes';
import perfettoLocalRoutes from './routes/perfettoLocalRoutes';
import aiChatRoutes from './routes/aiChatRoutes';
import autoAnalysisRoutes from './routes/autoAnalysis';
import traceAnalysisRouter from './routes/traceAnalysisRoutes';
import perfettoSqlRoutes from './routes/perfettoSqlRoutes';

// Import article aggregator initialization
import { initArticleAggregator } from './controllers/articleController';

const app = express();
const PORT = process.env.PORT || 3001;
const NODE_ENV = process.env.NODE_ENV || 'development';

// Middleware
app.use(cors({
  origin: [
    'http://localhost:8080',
    'http://localhost:5173',
    'http://localhost:5174',
    'http://localhost:10000', // Perfetto UI
    'http://127.0.0.1:8080',
    'http://127.0.0.1:5173',
    'http://127.0.0.1:5174',
    'http://127.0.0.1:10000', // Perfetto UI
  ],
  credentials: true,
}));

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

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
    deepSeekKeyPrefix: process.env.DEEPSEEK_API_KEY?.substring(0, 10) + '...',
    deepSeekBaseUrl: process.env.DEEPSEEK_BASE_URL,
    deepSeekModel: process.env.DEEPSEEK_MODEL,
    aiService: process.env.AI_SERVICE,
    cwd: process.cwd(),
  });
});

// API routes
app.use('/api/auth', authRoutes);
app.use('/api/sql', sqlRoutes);
app.use('/api/trace', traceRoutes);
app.use('/api/traces', simpleTraceRoutes); // Use our simple trace routes
app.use('/api/articles', articleRoutes);
app.use('/chat', aiChatRoutes); // Separate endpoint for AI chat without auth
app.use('/api/ai', advancedAIRoutes);
app.use('/api/perfetto', perfettoLocalRoutes);
app.use('/api/auto-analysis', autoAnalysisRoutes);
app.use('/api/trace-analysis', traceAnalysisRouter);
app.use('/api/perfetto-sql', perfettoSqlRoutes);

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
initArticleAggregator();

// Start server
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`📊 Environment: ${NODE_ENV}`);
  console.log(`🔗 API URL: http://localhost:${PORT}/api`);
  console.log(`❤️  Health check: http://localhost:${PORT}/health`);
});