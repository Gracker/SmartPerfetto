// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

/**
 * Agent Core Architecture Tests
 *
 * Unit tests for the new Agent architecture components:
 * - SessionLogger
 * - ModelRouter
 */

import { describe, it, expect, beforeEach, afterAll } from '@jest/globals';
import * as fs from 'fs';
import * as path from 'path';

// Import components to test
import {
  createSessionLogger,
  getSessionLoggerManager,
  SessionLogger,
} from '../services/sessionLogger';

import { ModelRouter } from '../agent/core/modelRouter';

describe('SessionLogger', () => {
  const testLogDir = path.join(process.cwd(), 'logs', 'test-sessions');
  let logger: SessionLogger;

  beforeEach(() => {
    // Create fresh logger for each test
    const sessionId = `test-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    logger = createSessionLogger(sessionId);
  });

  afterAll(() => {
    // Clean up test log files
    if (fs.existsSync(testLogDir)) {
      const files = fs.readdirSync(testLogDir);
      files.forEach((file) => {
        if (file.startsWith('session_test-')) {
          fs.unlinkSync(path.join(testLogDir, file));
        }
      });
    }
  });

  describe('logging methods', () => {
    it('should log debug messages', () => {
      logger.debug('TestComponent', 'Debug message', { key: 'value' });
      const logs = logger.readLogs();

      const debugLog = logs.find(l => l.level === 'debug' && l.message === 'Debug message');
      expect(debugLog).toBeDefined();
      expect(debugLog?.component).toBe('TestComponent');
      expect(debugLog?.data).toEqual({ key: 'value' });
    });

    it('should log info messages', () => {
      logger.info('TestComponent', 'Info message');
      const logs = logger.readLogs();

      const infoLog = logs.find(l => l.level === 'info' && l.message === 'Info message');
      expect(infoLog).toBeDefined();
    });

    it('should log warnings', () => {
      logger.warn('TestComponent', 'Warning message');
      const logs = logger.readLogs();

      const warnLog = logs.find(l => l.level === 'warn');
      expect(warnLog).toBeDefined();
    });

    it('should log errors with stack trace', () => {
      const error = new Error('Test error');
      logger.error('TestComponent', 'Error occurred', error);
      const logs = logger.readLogs();

      const errorLog = logs.find(l => l.level === 'error');
      expect(errorLog).toBeDefined();
      expect(errorLog?.error?.message).toBe('Test error');
      expect(errorLog?.error?.stack).toBeDefined();
    });
  });

  describe('metadata', () => {
    it('should store and retrieve metadata', () => {
      logger.setMetadata({ traceId: 'trace-123', query: 'analyze scrolling' });

      const summary = logger.getSummary();
      expect(summary.traceId).toBe('trace-123');
      expect(summary.query).toBe('analyze scrolling');
    });
  });

  describe('timed operations', () => {
    it('should track synchronous operation timing', () => {
      const result = logger.timed('TestComponent', 'sync operation', () => {
        return 'result';
      });

      expect(result).toBe('result');
      const logs = logger.readLogs();
      const timedLog = logs.find(l => l.message.includes('sync operation completed'));
      expect(timedLog).toBeDefined();
      expect(timedLog?.data?.duration).toBeDefined();
    });

    it('should track async operation timing', async () => {
      const result = await logger.timed('TestComponent', 'async operation', async () => {
        await new Promise(resolve => setTimeout(resolve, 10));
        return 'async result';
      });

      expect(result).toBe('async result');
      const logs = logger.readLogs();
      const timedLog = logs.find(l => l.message.includes('async operation completed'));
      expect(timedLog).toBeDefined();
    });
  });

  describe('summary', () => {
    it('should generate correct summary', () => {
      logger.info('Component1', 'Message 1');
      logger.warn('Component2', 'Warning');
      logger.error('Component1', 'Error');
      logger.info('Component3', 'Message 2');

      const summary = logger.getSummary();

      expect(summary.logCount).toBeGreaterThanOrEqual(4);
      expect(summary.errorCount).toBe(1);
      expect(summary.warnCount).toBe(1);
      expect(summary.components).toContain('Component1');
      expect(summary.components).toContain('Component2');
    });
  });
});

describe('SessionLoggerManager', () => {
  it('should list sessions', () => {
    const manager = getSessionLoggerManager();
    const sessions = manager.listSessions();

    expect(Array.isArray(sessions)).toBe(true);
  });

  it('should get or create logger for session', () => {
    const manager = getSessionLoggerManager();
    const sessionId = `manager-test-${Date.now()}`;

    const logger1 = manager.getLogger(sessionId);
    const logger2 = manager.getLogger(sessionId);

    // Should return same instance
    expect(logger1).toBe(logger2);
  });
});

describe('ModelRouter', () => {
  let modelRouter: ModelRouter;
  const originalDeepSeekApiKey = process.env.DEEPSEEK_API_KEY;

  beforeEach(() => {
    process.env.DEEPSEEK_API_KEY = 'test-deepseek-key';
    modelRouter = new ModelRouter();
  });

  afterEach(() => {
    if (originalDeepSeekApiKey === undefined) {
      delete process.env.DEEPSEEK_API_KEY;
    } else {
      process.env.DEEPSEEK_API_KEY = originalDeepSeekApiKey;
    }
  });

  describe('task routing', () => {
    it('should route reasoning tasks appropriately', () => {
      const model = modelRouter.routeByTask('intent_understanding');
      expect(model.strengths).toContain('reasoning');
    });

    it('should route coding tasks appropriately', () => {
      const model = modelRouter.routeByTask('sql_generation');
      expect(model.strengths).toContain('coding');
    });

    it('should route fast/cost tasks appropriately', () => {
      const model = modelRouter.routeByTask('simple_extraction');
      // simple_extraction requires ['speed', 'cost'] - may match on 'cost' if 'speed' model disabled
      expect(model.strengths.some(s => s === 'speed' || s === 'cost')).toBe(true);
    });
  });

  describe('model management', () => {
    it('should return enabled models', () => {
      const models = modelRouter.getEnabledModels();
      expect(Array.isArray(models)).toBe(true);
      expect(models.length).toBeGreaterThan(0);
    });

    it('should find model by strengths', () => {
      // findByStrengths takes an array of strengths
      const reasoningModel = modelRouter.findByStrengths(['reasoning']);
      expect(reasoningModel).toBeDefined();
      expect(reasoningModel!.strengths).toContain('reasoning');
    });

    it('should list all models', () => {
      const models = modelRouter.listModels();
      expect(Array.isArray(models)).toBe(true);
      expect(models.length).toBeGreaterThan(0);
    });
  });

  describe('fallback chain', () => {
    it('should provide fallback model IDs', () => {
      const primary = modelRouter.routeByTask('evaluation');
      // getFallbackChain takes a model ID string, returns string[]
      const fallbacks = modelRouter.getFallbackChain(primary.id);

      expect(Array.isArray(fallbacks)).toBe(true);
      // Fallbacks should not include primary (comparing strings)
      expect(fallbacks.includes(primary.id)).toBe(false);
    });
  });
});
