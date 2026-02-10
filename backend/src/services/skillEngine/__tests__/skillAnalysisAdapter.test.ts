import {describe, expect, it, jest} from '@jest/globals';
import {SkillAnalysisAdapter} from '../skillAnalysisAdapter';
import {LayeredResult} from '../skillExecutor';

describe('SkillAnalysisAdapter layered conversion', () => {
  const createAdapter = () => {
    const traceProcessorMock = {
      query: jest.fn(),
    };
    return new SkillAnalysisAdapter(traceProcessorMock as any);
  };

  it('unwraps nested skill step data and keeps display column definitions', () => {
    const adapter = createAdapter();

    const layeredResult: LayeredResult = {
      layers: {
        overview: {
          get_startups: {
            stepId: 'get_startups',
            stepType: 'skill',
            success: true,
            data: {
              skillId: 'startup_events_in_range',
              success: true,
              rawResults: {
                root: {
                  data: [
                    {
                      startup_id: 2,
                      start_ts: '564166652267210',
                      dur_ns: '1338654478',
                      dur_ms: 1338.65,
                    },
                  ],
                },
              },
            },
            executionTimeMs: 12,
            display: {
              title: '检测到的启动事件',
              level: 'key',
              format: 'table',
              columns: [
                {
                  name: 'start_ts',
                  type: 'timestamp',
                  unit: 'ns',
                  clickAction: 'navigate_range',
                  durationColumn: 'dur_ns',
                },
                {
                  name: 'dur_ns',
                  type: 'duration',
                  format: 'duration_ms',
                  unit: 'ns',
                },
                {
                  name: 'dur_ms',
                  type: 'duration',
                  format: 'duration_ms',
                  unit: 'ms',
                  hidden: true,
                },
              ],
            } as any,
          } as any,
        },
        list: {},
        session: {},
        deep: {},
      },
      defaultExpanded: ['overview'],
      metadata: {
        skillName: 'startup_analysis',
        version: '1.0',
        executedAt: new Date().toISOString(),
      },
    };

    const displayResults = (adapter as any).convertLayeredResultToDisplayResults(layeredResult);
    expect(displayResults).toHaveLength(1);

    const first = displayResults[0];
    expect(Array.isArray(first.data)).toBe(true);
    expect(first.data[0].startup_id).toBe(2);
    expect(first.data[0].dur_ms).toBe(1338.65);
    expect(first.columnDefinitions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'dur_ms',
          type: 'duration',
          unit: 'ms',
        }),
      ])
    );

    const sections = (adapter as any).convertDisplayResultsToSections(displayResults);
    const section = sections.get_startups;
    expect(section).toBeDefined();
    expect(section.rowCount).toBe(1);
    expect(section.data[0].dur_ms).toBe(1338.65);
    expect(section.columnDefinitions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'start_ts',
          clickAction: 'navigate_range',
          durationColumn: 'dur_ns',
          unit: 'ns',
        }),
      ])
    );
  });

  it('falls back to nested displayResults payload when rawResults is absent', () => {
    const adapter = createAdapter();

    const layeredResult: LayeredResult = {
      layers: {
        overview: {
          get_startups: {
            stepId: 'get_startups',
            stepType: 'skill',
            success: true,
            data: {
              skillId: 'startup_events_in_range',
              success: true,
              displayResults: [
                {
                  stepId: 'root',
                  data: {
                    columns: ['startup_id', 'dur_ms'],
                    rows: [[2, 1338.65]],
                  },
                },
              ],
            },
            executionTimeMs: 8,
            display: {
              title: '检测到的启动事件',
              level: 'key',
              format: 'table',
            } as any,
          } as any,
        },
        list: {},
        session: {},
        deep: {},
      },
      defaultExpanded: ['overview'],
      metadata: {
        skillName: 'startup_analysis',
        version: '1.0',
        executedAt: new Date().toISOString(),
      },
    };

    const displayResults = (adapter as any).convertLayeredResultToDisplayResults(layeredResult);
    expect(displayResults).toHaveLength(1);
    expect(displayResults[0].data).toEqual({
      columns: ['startup_id', 'dur_ms'],
      rows: [[2, 1338.65]],
    });
  });
});

