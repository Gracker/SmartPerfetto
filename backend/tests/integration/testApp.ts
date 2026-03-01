/**
 * Test App Setup for Integration Tests
 *
 * Creates an Express app instance for testing without starting a server.
 * Provides utilities for:
 * - Loading test traces
 * - Cleaning up resources
 * - Managing test state
 */

import express from 'express';
import cors from 'cors';
import path from 'path';
import fs from 'fs';

// Import routes
import agentRoutes from '../../src/routes/agentRoutes';
import traceProcessorRoutes from '../../src/routes/traceProcessorRoutes';
import skillRoutes from '../../src/routes/skillRoutes';
import {
  LEGACY_AGENT_API_BASE,
  rejectLegacyAgentApi,
} from '../../src/middleware/legacyAgentApi';

// Import services
import { TraceProcessorService, getTraceProcessorService } from '../../src/services/traceProcessorService';

// =============================================================================
// Test App Factory
// =============================================================================

export function createTestApp() {
  const app = express();

  // Middleware
  app.use(cors());
  app.use(express.json({ limit: '50mb' }));
  app.use(express.urlencoded({ extended: true, limit: '50mb' }));

  // Health check
  app.get('/health', (req, res) => {
    res.json({ status: 'OK', timestamp: new Date().toISOString() });
  });

  // API routes (only the ones we need for testing)
  app.use('/api/agent/v1', agentRoutes);
  app.use(LEGACY_AGENT_API_BASE, rejectLegacyAgentApi);
  app.use('/api/trace-processor', traceProcessorRoutes);
  app.use('/api/skills', skillRoutes);

  const assistantShellDir = path.resolve(process.cwd(), 'public/assistant-shell');
  app.get('/assistant-shell', (_req, res) => {
    res.sendFile(path.join(assistantShellDir, 'index.html'));
  });
  app.use('/assistant-shell', express.static(assistantShellDir));

  // 404 handler
  app.use((req, res) => {
    res.status(404).json({
      error: 'Route not found',
      message: `Cannot ${req.method} ${req.originalUrl}`,
    });
  });

  // Error handler
  app.use((err: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
    console.error('Test app error:', err.message);
    res.status(err.status || 500).json({
      error: 'Internal server error',
      message: err.message,
    });
  });

  return app;
}

// =============================================================================
// Test Utilities
// =============================================================================

/**
 * Load a test trace file and return its traceId
 */
export async function loadTestTrace(traceName: string): Promise<string> {
  const tracePath = path.resolve(process.cwd(), '..', 'test-traces', traceName);

  if (!fs.existsSync(tracePath)) {
    throw new Error(`Test trace not found: ${tracePath}`);
  }

  const traceProcessorService = getTraceProcessorService();
  const traceId = await traceProcessorService.loadTraceFromFilePath(tracePath);

  console.log(`[TestApp] Loaded trace ${traceName} with ID: ${traceId}`);
  return traceId;
}

/**
 * Clean up a trace by ID
 */
export async function cleanupTrace(traceId: string): Promise<void> {
  try {
    const traceProcessorService = getTraceProcessorService();
    await traceProcessorService.deleteTrace(traceId);
    console.log(`[TestApp] Cleaned up trace: ${traceId}`);
  } catch (e) {
    // Ignore cleanup errors
  }
}

/**
 * Get test trace path
 */
export function getTestTracePath(traceName: string): string {
  return path.resolve(process.cwd(), '..', 'test-traces', traceName);
}

/**
 * Wait for a specified amount of time
 */
export function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Collect SSE events from a response stream
 */
export async function collectSSEEvents(
  response: any,
  maxEvents: number = 50,
  timeoutMs: number = 30000
): Promise<Array<{ event: string; data: any }>> {
  const events: Array<{ event: string; data: any }> = [];
  let buffer = '';

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      resolve(events);
    }, timeoutMs);

    response.on('data', (chunk: Buffer) => {
      buffer += chunk.toString();

      // Parse SSE events
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      let currentEvent = '';
      let currentData = '';

      for (const line of lines) {
        if (line.startsWith('event:')) {
          currentEvent = line.slice(6).trim();
        } else if (line.startsWith('data:')) {
          currentData = line.slice(5).trim();
        } else if (line === '' && currentEvent && currentData) {
          try {
            events.push({
              event: currentEvent,
              data: JSON.parse(currentData),
            });
          } catch {
            events.push({
              event: currentEvent,
              data: currentData,
            });
          }

          // Check for end event or max events
          if (currentEvent === 'end' || events.length >= maxEvents) {
            clearTimeout(timeout);
            resolve(events);
            return;
          }

          currentEvent = '';
          currentData = '';
        }
      }
    });

    response.on('error', (err: Error) => {
      clearTimeout(timeout);
      reject(err);
    });

    response.on('end', () => {
      clearTimeout(timeout);
      resolve(events);
    });
  });
}
