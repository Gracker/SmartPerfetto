import { describe, it, expect, jest } from '@jest/globals';
import { sqlExecutorTool } from '../sqlExecutor';

describe('sqlExecutorTool', () => {
  it('enforces validation/limit and clips oversized result sets', async () => {
    const query = jest.fn(async (_traceId: string, sql: string) => {
      if (sql.includes('sqlite_master')) {
        return { columns: ['name'], rows: [['slice']] };
      }
      return {
        columns: ['id'],
        rows: Array.from({ length: 1200 }, (_, i) => [i]),
      };
    });

    const result = await sqlExecutorTool.execute(
      { sql: 'SELECT id FROM slice' },
      {
        traceId: 'trace-1',
        traceProcessorService: { query },
      } as any
    );

    expect(result.success).toBe(true);
    expect(result.data?.rowCount).toBe(1000);
    expect(result.metadata?.rowsClipped).toBe(true);
    expect((query.mock.calls[1]?.[1] as string) || '').toContain('LIMIT 1000');
  });

  it('rejects non-SELECT SQL statements', async () => {
    const query = jest.fn(async (_traceId: string, sql: string) => {
      if (sql.includes('sqlite_master')) {
        return { columns: ['name'], rows: [['slice']] };
      }
      return { columns: [], rows: [] };
    });

    const result = await sqlExecutorTool.execute(
      { sql: 'DELETE FROM slice' },
      {
        traceId: 'trace-2',
        traceProcessorService: { query },
      } as any
    );

    expect(result.success).toBe(false);
    expect(result.error || '').toContain('SQL validation failed');
    expect(query).toHaveBeenCalledTimes(1);
  });
});
