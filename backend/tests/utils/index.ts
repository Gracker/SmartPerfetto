/**
 * Test Utilities for SmartPerfetto Backend Tests
 *
 * Provides reusable utility functions for testing:
 * - waitForCondition - waits for a condition with timeout
 * - measureExecutionTime - measures execution time of async functions
 * - normalizeForSnapshot - removes non-deterministic fields for snapshot testing
 * - createTestEmitter - creates an emitter that collects emitted events
 */

import { EventEmitter } from 'events';

// =============================================================================
// waitForCondition
// =============================================================================

export interface WaitOptions {
  /** Timeout in milliseconds (default: 5000) */
  timeoutMs?: number;
  /** Polling interval in milliseconds (default: 50) */
  intervalMs?: number;
  /** Error message on timeout */
  timeoutMessage?: string;
}

/**
 * Waits for a condition to become true within a timeout period.
 * Useful for testing async operations that may take variable time.
 *
 * @param condition - Function that returns true when condition is met
 * @param options - Wait configuration options
 * @returns Promise that resolves when condition is met
 * @throws Error if timeout is reached before condition is met
 *
 * @example
 * ```ts
 * // Wait for array to have items
 * await waitForCondition(() => results.length > 0);
 *
 * // Wait with custom timeout
 * await waitForCondition(
 *   () => service.isReady(),
 *   { timeoutMs: 10000, timeoutMessage: 'Service failed to start' }
 * );
 * ```
 */
export async function waitForCondition(
  condition: () => boolean | Promise<boolean>,
  options: WaitOptions = {}
): Promise<void> {
  const {
    timeoutMs = 5000,
    intervalMs = 50,
    timeoutMessage = 'Condition not met within timeout',
  } = options;

  const startTime = Date.now();

  while (Date.now() - startTime < timeoutMs) {
    const result = await Promise.resolve(condition());
    if (result) {
      return;
    }
    await new Promise(resolve => setTimeout(resolve, intervalMs));
  }

  throw new Error(`${timeoutMessage} (waited ${timeoutMs}ms)`);
}

/**
 * Waits for a specified number of milliseconds.
 * Convenience wrapper around setTimeout for tests.
 *
 * @param ms - Milliseconds to wait
 * @returns Promise that resolves after the delay
 *
 * @example
 * ```ts
 * await delay(100);
 * ```
 */
export async function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// =============================================================================
// measureExecutionTime
// =============================================================================

export interface ExecutionResult<T> {
  /** Result of the async function */
  result: T;
  /** Execution time in milliseconds */
  durationMs: number;
  /** Start timestamp */
  startTime: number;
  /** End timestamp */
  endTime: number;
}

/**
 * Measures the execution time of an async function.
 * Useful for performance testing and ensuring operations complete within bounds.
 *
 * @param fn - Async function to measure
 * @returns Promise with result and timing information
 *
 * @example
 * ```ts
 * const { result, durationMs } = await measureExecutionTime(async () => {
 *   return await analyzer.analyze(trace);
 * });
 * expect(durationMs).toBeLessThan(1000);
 * ```
 */
export async function measureExecutionTime<T>(
  fn: () => Promise<T>
): Promise<ExecutionResult<T>> {
  const startTime = Date.now();
  const result = await fn();
  const endTime = Date.now();

  return {
    result,
    durationMs: endTime - startTime,
    startTime,
    endTime,
  };
}

/**
 * Measures synchronous function execution time.
 *
 * @param fn - Synchronous function to measure
 * @returns Result with timing information
 */
export function measureSyncExecutionTime<T>(fn: () => T): ExecutionResult<T> {
  const startTime = Date.now();
  const result = fn();
  const endTime = Date.now();

  return {
    result,
    durationMs: endTime - startTime,
    startTime,
    endTime,
  };
}

// =============================================================================
// normalizeForSnapshot
// =============================================================================

export interface NormalizeOptions {
  /** Fields to remove (default: ['timestamp', 'createdAt', 'updatedAt', 'id']) */
  removeFields?: string[];
  /** Additional fields to remove */
  additionalRemoveFields?: string[];
  /** Fields to replace with placeholder values */
  replaceFields?: Record<string, any>;
  /** Whether to sort object keys (default: true) */
  sortKeys?: boolean;
  /** Whether to normalize arrays by sorting them (default: false) */
  sortArrays?: boolean;
  /** Custom replacer function for JSON.stringify */
  replacer?: (key: string, value: any) => any;
}

/**
 * Default non-deterministic fields to remove for snapshot testing
 */
const DEFAULT_REMOVE_FIELDS = [
  'timestamp',
  'createdAt',
  'updatedAt',
  'id',
  'executionTimeMs',
  'latencyMs',
  'startTime',
  'endTime',
  'durationMs',
  'totalDurationMs',
];

/**
 * Normalizes an object for snapshot testing by removing non-deterministic fields.
 * Useful for creating stable snapshots that don't change on every test run.
 *
 * @param obj - Object to normalize
 * @param options - Normalization options
 * @returns Normalized object suitable for snapshot comparison
 *
 * @example
 * ```ts
 * const normalized = normalizeForSnapshot(result, {
 *   removeFields: ['timestamp', 'id'],
 *   replaceFields: { modelId: '[MODEL_ID]' }
 * });
 * expect(normalized).toMatchSnapshot();
 * ```
 */
export function normalizeForSnapshot<T>(
  obj: T,
  options: NormalizeOptions = {}
): T {
  const {
    removeFields = DEFAULT_REMOVE_FIELDS,
    additionalRemoveFields = [],
    replaceFields = {},
    sortKeys = true,
    sortArrays = false,
    replacer,
  } = options;

  const fieldsToRemove = new Set([...removeFields, ...additionalRemoveFields]);

  function normalize(value: any, key?: string): any {
    // Handle null/undefined
    if (value === null || value === undefined) {
      return value;
    }

    // Check if this field should be replaced
    if (key && key in replaceFields) {
      return replaceFields[key];
    }

    // Handle arrays
    if (Array.isArray(value)) {
      let normalized = value.map((item, index) => normalize(item, String(index)));
      if (sortArrays && normalized.length > 0 && typeof normalized[0] !== 'object') {
        normalized = [...normalized].sort();
      }
      return normalized;
    }

    // Handle objects
    if (typeof value === 'object') {
      const result: Record<string, any> = {};
      let keys = Object.keys(value);

      if (sortKeys) {
        keys = keys.sort();
      }

      for (const k of keys) {
        // Skip fields that should be removed
        if (fieldsToRemove.has(k)) {
          continue;
        }

        // Apply custom replacer if provided
        if (replacer) {
          const replaced = replacer(k, value[k]);
          if (replaced !== undefined) {
            result[k] = normalize(replaced, k);
            continue;
          }
        }

        result[k] = normalize(value[k], k);
      }

      return result;
    }

    // Handle primitives
    return value;
  }

  return normalize(obj) as T;
}

/**
 * Normalizes timestamps in an object by replacing them with a placeholder.
 * Useful when you want to keep timestamp fields but make them deterministic.
 *
 * @param obj - Object to normalize
 * @param placeholder - Placeholder value for timestamps (default: '[TIMESTAMP]')
 * @returns Object with normalized timestamps
 */
export function normalizeTimestamps<T>(
  obj: T,
  placeholder: string = '[TIMESTAMP]'
): T {
  return normalizeForSnapshot(obj, {
    removeFields: [],
    replaceFields: {
      timestamp: placeholder,
      createdAt: placeholder,
      updatedAt: placeholder,
      startTime: placeholder,
      endTime: placeholder,
    },
  });
}

/**
 * Normalizes IDs in an object by replacing them with sequential placeholders.
 * Useful for snapshot testing objects with generated IDs.
 *
 * @param obj - Object to normalize
 * @param idFields - Fields to treat as IDs (default: ['id', 'sessionId', 'traceId', 'taskId'])
 * @returns Object with normalized IDs
 */
export function normalizeIds<T>(
  obj: T,
  idFields: string[] = ['id', 'sessionId', 'traceId', 'taskId', 'hypothesisId', 'findingId']
): T {
  const idMap = new Map<string, string>();
  let idCounter = 0;

  function getPlaceholder(value: any): string {
    const key = String(value);
    if (!idMap.has(key)) {
      idMap.set(key, `[ID_${idCounter++}]`);
    }
    return idMap.get(key)!;
  }

  return normalizeForSnapshot(obj, {
    removeFields: [],
    replacer: (key, value) => {
      if (idFields.includes(key) && value != null) {
        return getPlaceholder(value);
      }
      return undefined;
    },
  });
}

// =============================================================================
// createTestEmitter
// =============================================================================

export interface TestEmitterEvent {
  /** Event name */
  event: string;
  /** Event arguments */
  args: any[];
  /** Timestamp when event was emitted */
  timestamp: number;
}

export interface TestEmitter extends EventEmitter {
  /** Get all emitted events */
  getEmittedEvents(): TestEmitterEvent[];
  /** Get events filtered by name */
  getEventsByName(name: string): TestEmitterEvent[];
  /** Get the last emitted event */
  getLastEvent(): TestEmitterEvent | undefined;
  /** Get the last emitted event by name */
  getLastEventByName(name: string): TestEmitterEvent | undefined;
  /** Clear recorded events */
  clearEvents(): void;
  /** Wait for a specific event to be emitted */
  waitForEvent(name: string, timeoutMs?: number): Promise<TestEmitterEvent>;
  /** Get count of events by name */
  getEventCount(name?: string): number;
}

/**
 * Creates an EventEmitter that records all emitted events for later inspection.
 * Useful for testing event-driven code.
 *
 * @returns Enhanced EventEmitter with event recording capabilities
 *
 * @example
 * ```ts
 * const emitter = createTestEmitter();
 * orchestrator.setEmitter(emitter);
 *
 * await orchestrator.analyze(query);
 *
 * expect(emitter.getEventsByName('progress')).toHaveLength(3);
 * expect(emitter.getLastEventByName('conclusion')?.args[0]).toContain('success');
 * ```
 */
export function createTestEmitter(): TestEmitter {
  const emittedEvents: TestEmitterEvent[] = [];
  const emitter = new EventEmitter() as TestEmitter;

  // Override emit to record all events
  const originalEmit = emitter.emit.bind(emitter);
  emitter.emit = function (event: string, ...args: any[]): boolean {
    emittedEvents.push({
      event,
      args,
      timestamp: Date.now(),
    });
    return originalEmit(event, ...args);
  };

  // Add helper methods
  emitter.getEmittedEvents = () => [...emittedEvents];

  emitter.getEventsByName = (name: string) =>
    emittedEvents.filter(e => e.event === name);

  emitter.getLastEvent = () =>
    emittedEvents.length > 0 ? emittedEvents[emittedEvents.length - 1] : undefined;

  emitter.getLastEventByName = (name: string) => {
    const events = emitter.getEventsByName(name);
    return events.length > 0 ? events[events.length - 1] : undefined;
  };

  emitter.clearEvents = () => {
    emittedEvents.length = 0;
  };

  emitter.waitForEvent = (name: string, timeoutMs = 5000): Promise<TestEmitterEvent> => {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        emitter.removeListener(name, handler);
        reject(new Error(`Timeout waiting for event: ${name}`));
      }, timeoutMs);

      const handler = (...args: any[]) => {
        clearTimeout(timeout);
        resolve({
          event: name,
          args,
          timestamp: Date.now(),
        });
      };

      emitter.once(name, handler);
    });
  };

  emitter.getEventCount = (name?: string) => {
    if (name) {
      return emitter.getEventsByName(name).length;
    }
    return emittedEvents.length;
  };

  return emitter;
}

// =============================================================================
// Test Data Generators
// =============================================================================

/**
 * Generates a random ID suitable for testing
 */
export function generateTestId(prefix: string = 'test'): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}

/**
 * Generates a unique session ID for testing
 */
export function generateSessionId(): string {
  return generateTestId('session');
}

/**
 * Generates a unique trace ID for testing
 */
export function generateTraceId(): string {
  return generateTestId('trace');
}

// =============================================================================
// Assertion Helpers
// =============================================================================

/**
 * Asserts that an async function throws an error matching the expected message
 *
 * @param fn - Async function expected to throw
 * @param expectedMessage - Expected error message (string or regex)
 */
export async function expectAsyncThrows(
  fn: () => Promise<any>,
  expectedMessage?: string | RegExp
): Promise<void> {
  let threw = false;
  let errorMessage = '';

  try {
    await fn();
  } catch (error: any) {
    threw = true;
    errorMessage = error.message || String(error);
  }

  if (!threw) {
    throw new Error('Expected function to throw, but it did not');
  }

  if (expectedMessage) {
    if (typeof expectedMessage === 'string') {
      if (!errorMessage.includes(expectedMessage)) {
        throw new Error(
          `Expected error message to contain "${expectedMessage}", but got "${errorMessage}"`
        );
      }
    } else {
      if (!expectedMessage.test(errorMessage)) {
        throw new Error(
          `Expected error message to match ${expectedMessage}, but got "${errorMessage}"`
        );
      }
    }
  }
}

/**
 * Asserts that a value is defined (not null or undefined)
 */
export function assertDefined<T>(value: T | null | undefined, message?: string): asserts value is T {
  if (value === null || value === undefined) {
    throw new Error(message || 'Expected value to be defined');
  }
}

// =============================================================================
// Mock Data Utilities
// =============================================================================

/**
 * Creates a deep clone of an object
 */
export function deepClone<T>(obj: T): T {
  return JSON.parse(JSON.stringify(obj));
}

/**
 * Merges objects deeply, with later objects taking precedence
 */
export function deepMerge<T extends Record<string, any>>(...objects: Partial<T>[]): T {
  const result: any = {};

  for (const obj of objects) {
    if (!obj) continue;

    for (const key of Object.keys(obj)) {
      const value = obj[key];

      if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
        result[key] = deepMerge(result[key] || {}, value);
      } else {
        result[key] = value;
      }
    }
  }

  return result;
}

// =============================================================================
// Async Testing Utilities
// =============================================================================

/**
 * Runs a function multiple times and returns aggregated results
 * Useful for testing functions with non-deterministic behavior
 *
 * @param fn - Function to run
 * @param times - Number of times to run (default: 10)
 * @returns Array of results
 */
export async function runMultipleTimes<T>(
  fn: () => Promise<T>,
  times: number = 10
): Promise<T[]> {
  const results: T[] = [];
  for (let i = 0; i < times; i++) {
    results.push(await fn());
  }
  return results;
}

/**
 * Runs multiple async functions concurrently and collects results
 *
 * @param fns - Array of async functions to run
 * @returns Array of results
 */
export async function runConcurrently<T>(
  fns: Array<() => Promise<T>>
): Promise<T[]> {
  return Promise.all(fns.map(fn => fn()));
}

/**
 * Retries an async function until it succeeds or max retries is reached
 *
 * @param fn - Async function to retry
 * @param maxRetries - Maximum number of retries (default: 3)
 * @param delayMs - Delay between retries in ms (default: 100)
 * @returns Result of successful execution
 * @throws Last error if all retries fail
 */
export async function retryUntilSuccess<T>(
  fn: () => Promise<T>,
  maxRetries: number = 3,
  delayMs: number = 100
): Promise<T> {
  let lastError: Error | undefined;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error: any) {
      lastError = error;
      if (attempt < maxRetries - 1) {
        await delay(delayMs);
      }
    }
  }

  throw lastError || new Error('All retries failed');
}
