// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {describe, expect, it, jest} from '@jest/globals';
import {SkillAnalysisAdapter} from '../skillAnalysisAdapter';
import {LayeredResult} from '../skillExecutor';
import {SkillRegistry} from '../skillLoader';

describe('SkillAnalysisAdapter layered conversion', () => {
  it('preserves per-step global scope through layered display and section conversion', () => {
    const adapter = new SkillAnalysisAdapter({ query: jest.fn() } as any);
    const scopeProvenance = { version: 'process_scope_evidence@1', entries: [{ role: 'global_context',
      scope: { mode: 'unscoped', traceId: 'trace', traceSide: 'current' } }] };
    const display = (adapter as any).convertLayeredResultToDisplayResults({
      layers: { overview: { frequency: { stepId: 'frequency', stepType: 'atomic', success: true,
        data: [{ mhz: 1200 }], executionTimeMs: 1, scopeProvenance,
        display: { show: true, level: 'summary', format: 'table' } } } },
      defaultExpanded: [], metadata: { skillName: 'scope_test', version: '1', executedAt: '' },
    });
    expect(display[0].scopeProvenance).toEqual(scopeProvenance);
    expect(display[0].evidenceRole).toBe('global_context');
    expect(display[0].appliedProcessScope).toBeUndefined();
    expect((adapter as any).convertDisplayResultsToSections(display).frequency.scopeProvenance).toEqual(scopeProvenance);
  });

  it('maps condition-skipped, failed and unavailable steps on every layer', () => {
    const adapter = new SkillAnalysisAdapter({ query: jest.fn() } as any);
    const display = { show: true, level: 'summary', format: 'table' };
    const step = (stepId: string, extra: Record<string, unknown>) => ({ stepId, stepType: 'atomic', executionTimeMs: 0, display, ...extra });
    const skipped = step('input', { success: true, data: [], code: 'condition_not_met', skippedCondition: '${has_input} > 0' });
    const results = (adapter as any).convertLayeredResultToDisplayResults({
      layers: {
        list: {
          input: skipped,
          probe: step('probe', { success: true, data: [], code: 'optional_query_error', error: 'no such table', sql: 'SELECT 1' }),
          scoped: step('scoped', { success: false, code: 'exact_scope_unavailable', error: 'exact scope unavailable' }),
          rows: step('rows', { success: true, data: [], sql: 'SELECT 2' }),
        },
        session: { s1: { input: skipped } },
        deep: { s1: { f1: skipped } },
      },
      defaultExpanded: [], metadata: { skillName: 'status_test', version: '1', executedAt: '' },
    }) as Array<Record<string, any>>;
    const byId = new Map(results.map(result => [result.stepId, result]));

    for (const id of ['input', 's1_input', 's1_f1']) {
      expect(byId.get(id)).toMatchObject({ executionStatus: 'skipped', executionMessage: expect.stringContaining('${has_input} > 0') });
      expect(byId.get(id)?.sql).toBeUndefined();
      expect(byId.get(id)?.executionError).toBeUndefined();
    }
    expect(byId.get('probe')).toMatchObject({ executionStatus: 'optional_error', executionError: 'no such table' });
    expect(byId.get('scoped')).toMatchObject({ executionStatus: 'unavailable', executionMessage: 'exact scope unavailable' });
    expect(byId.get('rows')?.executionStatus).toBeUndefined();
  });

  it.each([false, true])('preserves explicit selectors with layered=%s when packageName is a default', async layered => {
    const registry = new SkillRegistry();
    const definition = { name: 'selector_test', version: '1', type: 'atomic',
      meta: { display_name: 'Selector', description: 'Selector' }, sql: 'SELECT 1' };
    (registry as any).skills.set(definition.name, definition);
    (registry as any).skillOrigins.set(definition.name, {
      origin: 'external_pack',
      packId: 'test-pack',
    });
    (registry as any).initialized = true;
    const adapter = new SkillAnalysisAdapter({ query: jest.fn() } as any, undefined, { registry });
    jest.spyOn(adapter, 'detectVendor').mockResolvedValue({ vendor: 'aosp', confidence: 1 });
    jest.spyOn(adapter as any, 'hasLayeredOutput').mockReturnValue(layered);
    const executor = (adapter as any).executor;
    const execute = jest.spyOn(executor, layered ? 'executeCompositeSkill' : 'execute').mockResolvedValue(layered ? {
      layers: { overview: {}, list: {}, session: {}, deep: {}, diagnosis: {} },
      defaultExpanded: [], stepResults: [], metadata: { skillName: 'selector_test', version: '1', executedAt: '' },
    } : { success: true, displayResults: [], diagnostics: [], executionTimeMs: 0 });
    for (const params of [{ upid: 42 }, { pid: 4242 }, { process_name: 'com.explicit' }, { package: 'com.explicit' }]) {
      await adapter.analyze({ traceId: 'trace', skillId: definition.name, packageName: 'com.default', params });
      const lastCall = execute.mock.calls[execute.mock.calls.length - 1];
      expect(lastCall[layered ? 1 : 2]).toEqual(params);
    }
  });

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

  it('prefers configured column definitions for {columns, rows} payloads', () => {
    const adapter = createAdapter();

    const displayResults = [
      {
        stepId: 'root_cause',
        title: '根因分析',
        level: 'key',
        format: 'table',
        data: {
          columns: ['primary_cause', 'deep_reason', 'internal_metric', 'confidence'],
          rows: [['主线程耗时过长', 'RecyclerView 绑定耗时', 12.34, '高']],
        },
        columnDefinitions: [
          { name: 'primary_cause' },
          { name: 'deep_reason' },
          { name: 'confidence' },
        ],
      } as any,
    ];

    const sections = (adapter as any).convertDisplayResultsToSections(displayResults);
    const section = sections.root_cause;

    expect(section.columns).toEqual(['primary_cause', 'deep_reason', 'confidence']);
    expect(section.data).toEqual([
      {
        primary_cause: '主线程耗时过长',
        deep_reason: 'RecyclerView 绑定耗时',
        confidence: '高',
      },
    ]);
    expect(section.data[0].internal_metric).toBeUndefined();
  });

  it('collects failed raw stepResults that are not present in display layers', () => {
    const adapter = createAdapter();
    const layeredResult: LayeredResult = {
      layers: {
        overview: {},
        list: {},
        session: {},
        deep: {},
      },
      stepResults: [
        {
          stepId: 'hidden_probe',
          stepType: 'atomic',
          success: false,
          error: 'no such table: missing_table',
          executionTimeMs: 3,
        },
      ],
      defaultExpanded: ['overview'],
      metadata: {
        skillName: 'hidden_probe_skill',
        version: '1.0',
        executedAt: new Date().toISOString(),
      },
    };

    const failures = (adapter as any).collectLayeredFailures(layeredResult);

    expect(failures).toHaveLength(1);
    expect(failures[0]).toEqual(expect.objectContaining({
      stepId: 'hidden_probe',
      success: false,
    }));
  });

  it('maps detected vendor ids consistently with available vendor profiles', async () => {
    const queryMock = jest.fn() as any;
    queryMock.mockResolvedValueOnce({rows: []});
    queryMock.mockResolvedValueOnce({
      rows: [['pixel']],
    });
    const traceProcessorMock = {
      query: queryMock,
    };
    const adapter = new SkillAnalysisAdapter(traceProcessorMock as any);

    const detected = await adapter.detectVendor('trace-1');
    expect(queryMock).toHaveBeenCalled();
    expect(detected.vendor).toBe('pixel');
    expect(detected.confidence).toBeGreaterThan(0.5);
  });

  it('falls back to aosp when vendor detection query fails', async () => {
    const queryMock = jest.fn() as any;
    queryMock.mockRejectedValue(new Error('query failed'));
    const traceProcessorMock = {
      query: queryMock,
    };
    const adapter = new SkillAnalysisAdapter(traceProcessorMock as any);

    const detected = await adapter.detectVendor('trace-1');
    expect(detected).toEqual({ vendor: 'aosp', confidence: 0.5 });
  });

  it('preserves external-pack metadata and reports authored localization', async () => {
    const registry = new SkillRegistry();
    const externalSkill = {
      name: 'external_latency_probe',
      version: '1.0.0',
      type: 'atomic',
      meta: {
        display_name: '外部延迟探针',
        description: '由外部 Skill Pack 原样提供',
      },
      triggers: {keywords: ['external']},
      steps: [],
    };
    (registry as any).skills.set(externalSkill.name, externalSkill);
    (registry as any).skillOrigins.set(externalSkill.name, {
      origin: 'external_pack',
      packId: 'test-pack',
    });
    (registry as any).initialized = true;

    const adapter = new SkillAnalysisAdapter(
      {query: jest.fn()} as any,
      undefined,
      {registry},
    );
    const skills = await adapter.listSkills('en');

    expect(skills).toEqual([
      expect.objectContaining({
        id: externalSkill.name,
        displayName: externalSkill.meta.display_name,
        description: externalSkill.meta.description,
        localizationStatus: 'external_authored',
      }),
    ]);
    await expect(adapter.getSkillOrigin(externalSkill.name)).resolves.toMatchObject({
      origin: 'external_pack',
      packId: 'test-pack',
    });
  });
});
