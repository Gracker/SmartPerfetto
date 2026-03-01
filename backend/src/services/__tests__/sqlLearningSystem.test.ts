import { describe, expect, test, beforeEach, afterEach } from '@jest/globals';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { SQLLearningSystem } from '../sqlLearningSystem';

describe('SQLLearningSystem execution verification', () => {
  let tempDir: string;
  let system: SQLLearningSystem;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'smartperfetto-sql-learning-'));
    system = new SQLLearningSystem(tempDir);
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  test('does not mark fix as success when execution verification fails', async () => {
    const result = await system.fixSQL(
      'SELECT * FROM app_launch LIMIT 10',
      'no such table: app_launch',
      '分析启动问题',
      () => ({ isValid: true, errors: [] }),
      async () => ({ ok: false, error: 'no such table: app_launch' })
    );

    expect(result.success).toBe(false);
    expect(result.executionError).toContain('no such table');

    const stats = await system.getStats();
    expect(stats.totalErrors).toBe(1);
    expect(stats.totalFixes).toBe(0);
  });

  test('marks fix as success only after execution verification succeeds', async () => {
    const result = await system.fixSQL(
      'SELECT * FROM app_launch LIMIT 10',
      'no such table: app_launch',
      '分析启动问题',
      () => ({ isValid: true, errors: [] }),
      async () => ({ ok: true })
    );

    expect(result.success).toBe(true);
    expect(result.fixedSQL.length).toBeGreaterThan(0);

    const stats = await system.getStats();
    expect(stats.totalErrors).toBe(1);
    expect(stats.totalFixes).toBe(1);
  });
});
