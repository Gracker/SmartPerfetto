import { describe, it, expect, jest } from '@jest/globals';
import { FrameStatsAnalyzer } from '../frameStatsAnalysis';

function createAnalyzerWithRows(
  rows: any[][],
  columns: string[] = ['ts', 'dur_ms', 'frame_number']
) {
  const query = jest.fn(async (_traceId: string, _sql: string) => ({ columns, rows }));
  const traceProcessor = {
    query,
  };
  const analyzer = new FrameStatsAnalyzer(traceProcessor as any);
  return { analyzer, query: traceProcessor.query };
}

describe('FrameStatsAnalyzer', () => {
  it('escapes package filter to prevent SQL injection and wildcard expansion', async () => {
    const rows = [
      ['1000000000', '20', '1'],
      ['1016666667', '20', '2'],
    ];
    const { analyzer, query } = createAnalyzerWithRows(rows);

    await analyzer.analyze('trace-1', "com.demo' OR 1=1_% --");

    const executedSql = query.mock.calls[0]?.[1] as string;
    expect(executedSql).toContain("process.name LIKE '%com.demo'' OR 1=1\\_\\% --%' ESCAPE '\\'");
    expect(executedSql).not.toContain("process.name LIKE '%com.demo' OR 1=1");
  });

  it('uses a conservative 60Hz fallback budget by default for jank classification', async () => {
    const rows = [
      ['1000000000', '20', '1'],
      ['1016666667', '20', '2'],
    ];
    const { analyzer } = createAnalyzerWithRows(rows);

    const result = await analyzer.analyze('trace-1');

    expect(result.summary.jankCount).toBe(0);
    expect(result.summary.jankPercentage).toBe(0);
  });

  it('keeps full jank count while limiting returned jank frame samples to 100', async () => {
    const rows: any[][] = [];
    let ts = 1_000_000_000;
    for (let i = 0; i < 150; i++) {
      rows.push([String(ts), '40', String(i + 1)]);
      ts += 16_666_667;
    }
    const { analyzer } = createAnalyzerWithRows(rows);

    const result = await analyzer.analyze('trace-1');

    expect(result.summary.jankCount).toBe(150);
    expect(result.jankFrames).toHaveLength(100);
    expect(result.summary.jankPercentage).toBe(100);
  });

  it('guards FPS calculation when frame timestamps collapse to the same value', async () => {
    const rows = [
      ['1000000000', '10', '1'],
      ['1000000000', '12', '2'],
    ];
    const { analyzer } = createAnalyzerWithRows(rows);

    const result = await analyzer.analyze('trace-1');

    expect(Number.isFinite(result.summary.avgFps)).toBe(true);
    expect(result.summary.avgFps).toBeGreaterThan(0);
  });

  it('applies the same jank counting behavior in slice fallback mode', async () => {
    const rows: any[][] = [];
    let ts = 1_000_000_000;
    for (let i = 0; i < 120; i++) {
      rows.push([String(ts), '40', 'DrawFrame']);
      ts += 16_666_667;
    }
    const { analyzer } = createAnalyzerWithRows(rows, ['ts', 'dur_ms', 'name']);

    const result = await analyzer.analyzeFromSlices('trace-1', 'com.demo.app');

    expect(result.summary.jankCount).toBe(120);
    expect(result.jankFrames).toHaveLength(100);
  });
});
