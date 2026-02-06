/**
 * Test Utilities Unit Tests
 *
 * Verifies that all utility functions work correctly.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import {
  waitForCondition,
  delay,
  measureExecutionTime,
  measureSyncExecutionTime,
  normalizeForSnapshot,
  normalizeTimestamps,
  normalizeIds,
  createTestEmitter,
  generateTestId,
  generateSessionId,
  generateTraceId,
  expectAsyncThrows,
  assertDefined,
  deepClone,
  deepMerge,
  runMultipleTimes,
  runConcurrently,
  retryUntilSuccess,
} from '../index';

describe('Test Utilities', () => {
  describe('waitForCondition', () => {
    it('resolves immediately when condition is true', async () => {
      const start = Date.now();
      await waitForCondition(() => true);
      const elapsed = Date.now() - start;

      expect(elapsed).toBeLessThan(100);
    });

    it('waits for condition to become true', async () => {
      let counter = 0;
      const condition = () => {
        counter++;
        return counter >= 3;
      };

      await waitForCondition(condition, { intervalMs: 10 });

      expect(counter).toBeGreaterThanOrEqual(3);
    });

    it('times out when condition never becomes true', async () => {
      await expect(
        waitForCondition(() => false, {
          timeoutMs: 100,
          timeoutMessage: 'Custom timeout message',
        })
      ).rejects.toThrow('Custom timeout message');
    });

    it('supports async conditions', async () => {
      let value = false;
      setTimeout(() => {
        value = true;
      }, 50);

      await waitForCondition(async () => value, { timeoutMs: 200 });

      expect(value).toBe(true);
    });
  });

  describe('delay', () => {
    it('waits for specified milliseconds', async () => {
      const start = Date.now();
      await delay(50);
      const elapsed = Date.now() - start;

      expect(elapsed).toBeGreaterThanOrEqual(45);
      expect(elapsed).toBeLessThan(150);
    });
  });

  describe('measureExecutionTime', () => {
    it('measures async function execution time', async () => {
      const { result, durationMs } = await measureExecutionTime(async () => {
        await delay(50);
        return 'done';
      });

      expect(result).toBe('done');
      expect(durationMs).toBeGreaterThanOrEqual(45);
    });

    it('captures start and end times', async () => {
      const before = Date.now();
      const { startTime, endTime } = await measureExecutionTime(async () => 42);
      const after = Date.now();

      expect(startTime).toBeGreaterThanOrEqual(before);
      expect(endTime).toBeLessThanOrEqual(after);
    });
  });

  describe('measureSyncExecutionTime', () => {
    it('measures sync function execution time', () => {
      const { result, durationMs } = measureSyncExecutionTime(() => {
        let sum = 0;
        for (let i = 0; i < 1000; i++) sum += i;
        return sum;
      });

      expect(result).toBe(499500);
      expect(durationMs).toBeGreaterThanOrEqual(0);
    });
  });

  describe('normalizeForSnapshot', () => {
    it('removes default non-deterministic fields', () => {
      const input = {
        name: 'test',
        id: '123',
        timestamp: Date.now(),
        createdAt: new Date(),
        data: 'value',
      };

      const normalized = normalizeForSnapshot(input);

      expect(normalized).toEqual({
        data: 'value',
        name: 'test',
      });
    });

    it('replaces specified fields with placeholders', () => {
      const input = {
        name: 'test',
        modelId: 'gpt-4',
        value: 42,
      };

      const normalized = normalizeForSnapshot(input, {
        removeFields: [],
        replaceFields: { modelId: '[MODEL_ID]' },
      });

      expect(normalized.modelId).toBe('[MODEL_ID]');
    });

    it('handles nested objects', () => {
      const input = {
        outer: {
          inner: {
            id: '123',
            value: 'keep',
          },
          timestamp: 123456,
        },
      };

      const normalized = normalizeForSnapshot(input);

      expect(normalized.outer.inner.value).toBe('keep');
      expect(normalized.outer.inner.id).toBeUndefined();
      expect(normalized.outer.timestamp).toBeUndefined();
    });

    it('handles arrays', () => {
      const input = {
        items: [
          { id: '1', name: 'a' },
          { id: '2', name: 'b' },
        ],
      };

      const normalized = normalizeForSnapshot(input);

      expect(normalized.items).toHaveLength(2);
      expect(normalized.items[0].name).toBe('a');
      expect(normalized.items[0].id).toBeUndefined();
    });

    it('sorts object keys by default', () => {
      const input = { z: 1, a: 2, m: 3 };
      const normalized = normalizeForSnapshot(input, { removeFields: [] });

      expect(Object.keys(normalized)).toEqual(['a', 'm', 'z']);
    });
  });

  describe('normalizeTimestamps', () => {
    it('replaces timestamp fields with placeholder', () => {
      const input = {
        name: 'test',
        timestamp: 1234567890,
        createdAt: new Date(),
      };

      const normalized = normalizeTimestamps(input);

      expect(normalized.timestamp).toBe('[TIMESTAMP]');
      expect(normalized.createdAt).toBe('[TIMESTAMP]');
      expect(normalized.name).toBe('test');
    });
  });

  describe('normalizeIds', () => {
    it('replaces ID fields with sequential placeholders', () => {
      const input = {
        id: 'abc123',
        sessionId: 'session-456',
        value: 'keep',
      };

      const normalized = normalizeIds(input);

      expect(normalized.id).toBe('[ID_0]');
      expect(normalized.sessionId).toBe('[ID_1]');
      expect(normalized.value).toBe('keep');
    });

    it('reuses placeholders for same ID values', () => {
      const input = {
        items: [
          { id: 'shared', ref: 'shared' },
          { id: 'other', ref: 'shared' },
        ],
      };

      const normalized = normalizeIds(input, ['id', 'ref']);

      expect(normalized.items[0].id).toBe(normalized.items[0].ref);
      expect(normalized.items[1].ref).toBe(normalized.items[0].ref);
    });
  });

  describe('createTestEmitter', () => {
    it('records emitted events', () => {
      const emitter = createTestEmitter();

      emitter.emit('test', 'arg1', 'arg2');
      emitter.emit('other', { key: 'value' });

      expect(emitter.getEmittedEvents()).toHaveLength(2);
    });

    it('filters events by name', () => {
      const emitter = createTestEmitter();

      emitter.emit('a', 1);
      emitter.emit('b', 2);
      emitter.emit('a', 3);

      const aEvents = emitter.getEventsByName('a');

      expect(aEvents).toHaveLength(2);
      expect(aEvents[0].args[0]).toBe(1);
      expect(aEvents[1].args[0]).toBe(3);
    });

    it('gets last event', () => {
      const emitter = createTestEmitter();

      emitter.emit('first', 1);
      emitter.emit('second', 2);

      expect(emitter.getLastEvent()?.event).toBe('second');
      expect(emitter.getLastEventByName('first')?.args[0]).toBe(1);
    });

    it('clears events', () => {
      const emitter = createTestEmitter();

      emitter.emit('test', 1);
      emitter.clearEvents();

      expect(emitter.getEmittedEvents()).toHaveLength(0);
    });

    it('waits for specific event', async () => {
      const emitter = createTestEmitter();

      setTimeout(() => {
        emitter.emit('expected', 'value');
      }, 20);

      const event = await emitter.waitForEvent('expected', 100);

      expect(event.args[0]).toBe('value');
    });

    it('times out waiting for event', async () => {
      const emitter = createTestEmitter();

      await expect(emitter.waitForEvent('never', 50)).rejects.toThrow(
        'Timeout waiting for event: never'
      );
    });

    it('counts events', () => {
      const emitter = createTestEmitter();

      emitter.emit('a', 1);
      emitter.emit('a', 2);
      emitter.emit('b', 3);

      expect(emitter.getEventCount()).toBe(3);
      expect(emitter.getEventCount('a')).toBe(2);
      expect(emitter.getEventCount('b')).toBe(1);
    });
  });

  describe('ID generators', () => {
    it('generates unique test IDs', () => {
      const id1 = generateTestId('test');
      const id2 = generateTestId('test');

      expect(id1).toMatch(/^test_\d+_[a-z0-9]+$/);
      expect(id1).not.toBe(id2);
    });

    it('generates session and trace IDs', () => {
      const sessionId = generateSessionId();
      const traceId = generateTraceId();

      expect(sessionId).toMatch(/^session_/);
      expect(traceId).toMatch(/^trace_/);
    });
  });

  describe('expectAsyncThrows', () => {
    it('passes when function throws', async () => {
      await expectAsyncThrows(async () => {
        throw new Error('Expected error');
      });
    });

    it('fails when function does not throw', async () => {
      await expect(
        expectAsyncThrows(async () => 'no throw')
      ).rejects.toThrow('Expected function to throw');
    });

    it('checks error message with string', async () => {
      await expectAsyncThrows(
        async () => {
          throw new Error('Contains expected text here');
        },
        'expected text'
      );
    });

    it('checks error message with regex', async () => {
      await expectAsyncThrows(
        async () => {
          throw new Error('Error code: 404');
        },
        /code: \d+/
      );
    });
  });

  describe('assertDefined', () => {
    it('passes for defined values', () => {
      expect(() => assertDefined('value')).not.toThrow();
      expect(() => assertDefined(0)).not.toThrow();
      expect(() => assertDefined(false)).not.toThrow();
      expect(() => assertDefined('')).not.toThrow();
    });

    it('throws for null', () => {
      expect(() => assertDefined(null)).toThrow('Expected value to be defined');
    });

    it('throws for undefined', () => {
      expect(() => assertDefined(undefined)).toThrow('Expected value to be defined');
    });

    it('uses custom message', () => {
      expect(() => assertDefined(null, 'Custom message')).toThrow('Custom message');
    });
  });

  describe('deepClone', () => {
    it('creates a deep copy', () => {
      const original = { a: { b: { c: 1 } } };
      const clone = deepClone(original);

      clone.a.b.c = 2;

      expect(original.a.b.c).toBe(1);
      expect(clone.a.b.c).toBe(2);
    });
  });

  describe('deepMerge', () => {
    it('merges objects deeply', () => {
      const base = { a: 1, b: { c: 2, d: 3 }, e: 0 };
      const override = { b: { c: 20, d: 3 }, e: 5 };

      const merged = deepMerge(base, override);

      expect(merged).toEqual({
        a: 1,
        b: { c: 20, d: 3 },
        e: 5,
      });
    });

    it('handles multiple objects', () => {
      const result = deepMerge<Record<string, number>>({ a: 1 }, { b: 2 }, { c: 3 });

      expect(result).toEqual({ a: 1, b: 2, c: 3 });
    });
  });

  describe('runMultipleTimes', () => {
    it('runs function specified number of times', async () => {
      let counter = 0;
      const results = await runMultipleTimes(async () => {
        counter++;
        return counter;
      }, 5);

      expect(results).toEqual([1, 2, 3, 4, 5]);
      expect(counter).toBe(5);
    });
  });

  describe('runConcurrently', () => {
    it('runs functions in parallel', async () => {
      const order: number[] = [];

      const results = await runConcurrently([
        async () => {
          await delay(30);
          order.push(1);
          return 'a';
        },
        async () => {
          await delay(10);
          order.push(2);
          return 'b';
        },
      ]);

      expect(results).toEqual(['a', 'b']);
      expect(order).toEqual([2, 1]); // Second finishes first
    });
  });

  describe('retryUntilSuccess', () => {
    it('returns on first success', async () => {
      let attempts = 0;
      const result = await retryUntilSuccess(async () => {
        attempts++;
        return 'success';
      });

      expect(result).toBe('success');
      expect(attempts).toBe(1);
    });

    it('retries on failure', async () => {
      let attempts = 0;
      const result = await retryUntilSuccess(
        async () => {
          attempts++;
          if (attempts < 3) throw new Error('Not yet');
          return 'success';
        },
        5,
        10
      );

      expect(result).toBe('success');
      expect(attempts).toBe(3);
    });

    it('throws after max retries', async () => {
      await expect(
        retryUntilSuccess(
          async () => {
            throw new Error('Always fails');
          },
          2,
          10
        )
      ).rejects.toThrow('Always fails');
    });
  });
});
