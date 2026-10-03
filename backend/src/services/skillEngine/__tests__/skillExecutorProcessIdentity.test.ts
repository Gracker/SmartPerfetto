// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import { SkillExecutor } from '../skillExecutor';
import type {QueryResult} from '../../traceProcessorService';
import type { SkillDefinition } from '../types';
import fs from 'fs';
import path from 'path';
import yaml from 'js-yaml';
import Database from 'better-sqlite3';
import { normalizeSkillDefinition, SkillRegistry } from '../skillLoader';
import { getExactProcessScopeSupport } from '../processScopeSql';
import {resultScopeProvenance} from '../scopeEvidence';
import {createEffectiveProcessScope} from '../../processIdentity/effectiveProcessScope';
import type {EffectiveProcessScope} from '../../processIdentity/effectiveProcessScope';

const resolverSkill: SkillDefinition = {
  name: 'process_identity_resolver',
  version: '1.0',
  type: 'atomic',
  meta: { display_name: 'Resolver', description: 'Resolver' },
  identity: { policy: 'exempt', scope: 'process' },
  inputs: [
    { name: 'package', type: 'string', required: false },
    { name: 'process_name', type: 'string', required: false },
    { name: 'thread_name', type: 'string', required: false },
    { name: 'upid', type: 'integer', required: false },
    { name: 'pid', type: 'integer', required: false },
    { name: 'max_rows', type: 'integer', required: false },
  ],
  sql: 'SELECT 1 AS resolver_probe',
};

const targetSkill: SkillDefinition = {
  name: 'target_process_skill',
  version: '1.0',
  type: 'atomic',
  meta: { display_name: 'Target', description: 'Target' },
  identity: {
    policy: 'required',
    scope: 'process',
    aliases: ['process_name', 'package'],
    rewriteTo: 'recommended_process_name_param',
  },
  inputs: [
    { name: 'process_name', type: 'string', required: true },
  ],
  sql: "SELECT '${process_name}' AS process_name",
};

const packageTargetSkill: SkillDefinition = {
  name: 'target_package_skill',
  version: '1.0',
  type: 'atomic',
  meta: { display_name: 'Target Package', description: 'Target Package' },
  identity: {
    policy: 'required',
    scope: 'process',
    aliases: ['process_name', 'package'],
    rewriteTo: 'recommended_process_name_param',
  },
  inputs: [
    { name: 'package', type: 'string', required: true },
  ],
  sql: "SELECT '${package}' AS package_name, '${process_name}' AS leaked_process_name",
};

const threadTargetSkill: SkillDefinition = {
  name: 'target_thread_skill',
  version: '1.0',
  type: 'atomic',
  meta: { display_name: 'Target Thread', description: 'Target Thread' },
  identity: {
    policy: 'required',
    scope: 'process',
    rewriteTo: 'upid',
  },
  inputs: [
    { name: 'thread_name', type: 'string', required: true },
  ],
  sql: "SELECT '${thread_name}' AS thread_name",
};

function createExecutor(query: jest.Mock): SkillExecutor {
  const executor = new SkillExecutor({ query });
  executor.registerSkills([resolverSkill, targetSkill, packageTargetSkill, threadTargetSkill]);
  return executor;
}

describe('SkillExecutor process identity gate', () => {
  it.each([
    {params: {package: 'com.example', upid: 42}, expectedMode: 'exact_upid', expectedSqlValue: 42},
    {params: {package: 'com.example'}, expectedMode: 'named', expectedSqlValue: null},
  ])('propagates a selected startup scope through its nested placement Skill: $expectedMode', async ({params, expectedMode, expectedSqlValue}) => {
    const placement: SkillDefinition = {name: 'startup_placement_fixture', version: '1', type: 'atomic',
      meta: {display_name: 'Placement', description: 'Placement'},
      inputs: [{name: 'package', type: 'string', required: true}],
      process_scope: {role: 'target', binding: 'native_upid'},
      sql: 'SELECT ${__process_scope.upid} AS selected_upid',
    };
    const detail: SkillDefinition = {name: 'startup_detail_fixture', version: '1', type: 'composite',
      meta: {display_name: 'Startup detail', description: 'Startup detail'},
      identity: {policy: 'required', scope: 'process', aliases: ['package'], rewriteTo: 'recommended_process_name_param'},
      inputs: [{name: 'package', type: 'string', required: true}],
      steps: [{id: 'placement', type: 'skill', skill: placement.name,
        params: {package: '${package}'}, display: {level: 'detail', layer: 'deep', title: 'Placement', format: 'table'}}],
    };
    const query = jest.fn()
      .mockResolvedValueOnce({
        columns: ['rank', 'confidence_score', 'identity_status', 'canonical_package_name',
          'recommended_process_name_param', 'upid', 'process_name', 'target_match_sources',
          'supporting_sources', 'identity_warning'],
        rows: [[1, 100, 'confirmed', 'com.example', 'com.example', 42, 'com.example',
          'process.name', 'startup_processes.upid', 'ok']], durationMs: 1,
      })
      .mockResolvedValueOnce({columns: ['selected_upid'], rows: [[expectedSqlValue]], durationMs: 1});
    const executor = new SkillExecutor({query});
    executor.registerSkills([resolverSkill, placement, detail]);
    const result = await executor.execute(detail.name, 'trace', params);
    expect(result.success).toBe(true);
    const nested = result.rawResults?.placement;
    expect(nested?.appliedProcessScope).toMatchObject({mode: expectedMode,
      ...(expectedMode === 'exact_upid' ? {upid: 42} : {})});
    expect(nested?.scopeProvenance?.entries).toEqual(expect.arrayContaining([
      expect.objectContaining({role: 'target', scope: expect.objectContaining({mode: expectedMode})}),
    ]));
    if (expectedMode === 'exact_upid') {
      expect(nested?.appliedProcessScope?.identityRefId).toBe(result.identityResolution?.identityRefId);
    } else {
      expect(nested?.appliedProcessScope).not.toHaveProperty('upid');
    }
    expect(query.mock.calls[1][1]).toContain(`SELECT ${expectedSqlValue === null ? 'NULL' : '42'} AS selected_upid`);
  });

  it('runs resolver and rewrites process_name before executing required process skills', async () => {
    const query = jest.fn()
      .mockResolvedValueOnce({
        columns: ['rank', 'confidence_score', 'identity_status', 'canonical_package_name', 'recommended_process_name_param', 'upid', 'target_match_sources', 'supporting_sources', 'identity_warning'],
        rows: [[1, 90, 'confirmed', 'com.example', 'com.real.process', 42, 'android_process_metadata.package_name', 'frame_timeline.upid', 'ok']],
        durationMs: 1,
      })
      .mockResolvedValueOnce({
        columns: ['process_name'],
        rows: [['com.real.process']],
        durationMs: 1,
      });

    const result = await createExecutor(query).execute('target_process_skill', 'trace', {
      process_name: 'com.example',
    });

    expect(result.success).toBe(true);
    expect(query).toHaveBeenCalledTimes(2);
    expect(query.mock.calls[1][1]).toContain("SELECT 'com.real.process' AS process_name");
  });

  it('does not leak undeclared process aliases into skill parameter validation', async () => {
    const query = jest.fn()
      .mockResolvedValueOnce({
        columns: ['rank', 'confidence_score', 'identity_status', 'canonical_package_name', 'recommended_process_name_param', 'upid', 'target_match_sources', 'supporting_sources', 'identity_warning'],
        rows: [[1, 90, 'confirmed', 'com.example', 'com.real.process', 42, 'android_process_metadata.package_name', 'frame_timeline.upid', 'ok']],
        durationMs: 1,
      })
      .mockResolvedValueOnce({
        columns: ['package_name', 'leaked_process_name'],
        rows: [['com.real.process', '']],
        durationMs: 1,
      });

    const result = await createExecutor(query).execute('target_package_skill', 'trace', {
      process_name: 'com.example',
    });

    expect(result.success).toBe(true);
    expect(query).toHaveBeenCalledTimes(2);
    expect(query.mock.calls[1][1]).toContain("SELECT 'com.real.process' AS package_name, '' AS leaked_process_name");
  });

  it('refuses an exact UPID selector for an undeclared legacy target Skill', async () => {
    const query = jest.fn()
      .mockResolvedValueOnce({
        columns: ['rank', 'confidence_score', 'identity_status', 'canonical_package_name', 'recommended_process_name_param', 'upid', 'target_match_sources', 'supporting_sources', 'identity_warning'],
        rows: [[1, 100, 'confirmed', 'com.example', 'com.example', 42, 'upid,process.name', 'frame_timeline.upid', 'ok']],
        durationMs: 1,
      })
      .mockResolvedValueOnce({
        columns: ['process_name'],
        rows: [['com.example']],
        durationMs: 1,
      });

    const result = await createExecutor(query).execute('target_process_skill', 'trace', {
      process_name: 'com.example',
      upid: 42,
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('SQL has no process_scope declaration');
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('blocks required process skills when resolver returns only weak identity evidence', async () => {
    const query = jest.fn().mockResolvedValueOnce({
      columns: ['rank', 'confidence_score', 'identity_status', 'canonical_package_name', 'recommended_process_name_param', 'upid', 'target_match_sources', 'supporting_sources', 'identity_warning'],
      rows: [[1, 20, 'weak_match', 'com.example', 'com.uncertain', 42, 'thread.name', '', 'shared UID']],
      durationMs: 1,
    });

    const result = await createExecutor(query).execute('target_process_skill', 'trace', {
      process_name: 'com.example',
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('could not be verified');
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('blocks required process skills when resolver returns only a probable identity match', async () => {
    const query = jest.fn().mockResolvedValueOnce({
      columns: ['rank', 'confidence_score', 'identity_status', 'canonical_package_name', 'recommended_process_name_param', 'upid', 'target_match_sources', 'supporting_sources', 'identity_warning'],
      rows: [[1, 55, 'probable', 'com.example', 'com.example:provider', 42, 'android_process_metadata.package_name', '', 'ok']],
      durationMs: 1,
    });

    const result = await createExecutor(query).execute('target_process_skill', 'trace', {
      process_name: 'com.example',
    });

    expect(result.success).toBe(false);
    expect(result.identityResolution?.status).toBe('ambiguous');
    expect(result.identityResolution?.warnings).toContain('probable identity match requires additional confirmation before parameter rewrite');
    expect(query).toHaveBeenCalledTimes(1);
  });

  it.each([
    {label: 'reused PID', columns: ['process_count', 'unique_upid'], rows: [[2, 42]], status: 'ambiguous'},
    {label: 'missing uniqueness facts', columns: ['rank'], rows: [[1]], status: 'error'},
  ])('blocks PID-only execution for $label before the ranked resolver or target SQL', async ({columns, rows, status}) => {
    const query = jest.fn(async (_traceId: string, _sql: string): Promise<QueryResult> =>
      ({columns, rows, durationMs: 1}));

    const result = await createExecutor(query).execute('target_process_skill', 'trace', {
      pid: 4242,
    });

    expect(result.success).toBe(false);
    expect(result.identityResolution?.status).toBe(status);
    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0][1]).toContain('COUNT(DISTINCT upid)');
  });

  it('blocks thread-only matches even when the resolver reports high confidence', async () => {
    const query = jest.fn().mockResolvedValueOnce({
      columns: ['rank', 'confidence_score', 'identity_status', 'canonical_package_name', 'recommended_process_name_param', 'upid', 'target_match_sources', 'supporting_sources', 'identity_warning', 'thread_name', 'thread_target_matched'],
      rows: [[1, 90, 'confirmed', 'com.example', 'com.example', 42, 'thread.name', 'frame_timeline.upid', 'ok', 'main', 1]],
      durationMs: 1,
    });

    const result = await createExecutor(query).execute('target_thread_skill', 'trace', {
      thread_name: 'main',
    });

    expect(result.success).toBe(false);
    expect(result.identityResolution?.status).toBe('ambiguous');
    expect(result.identityResolution?.warnings).toContain('thread-only identity target is not enough to verify a unique process');
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('accepts an exact requested main process over close package child processes', async () => {
    const query = jest.fn()
      .mockResolvedValueOnce({
        columns: ['rank', 'confidence_score', 'identity_status', 'canonical_package_name', 'recommended_process_name_param', 'upid', 'process_name', 'target_match_sources', 'supporting_sources', 'identity_warning'],
        rows: [
          [1, 100, 'confirmed', 'com.example', 'com.example', 42, 'com.example', 'process.name', 'frame_timeline.upid', 'ok'],
          [2, 100, 'confirmed', 'com.example', 'com.example:remote', 43, 'com.example:remote', 'android_process_metadata.package_name', '', 'ok'],
        ],
        durationMs: 1,
      })
      .mockResolvedValueOnce({
        columns: ['process_name'],
        rows: [['com.example']],
        durationMs: 1,
      });

    const result = await createExecutor(query).execute('target_process_skill', 'trace', {
      process_name: 'com.example',
    });

    expect(result.success).toBe(true);
    expect(result.identityResolution?.status).toBe('verified');
    expect(result.identityResolution?.warnings).not.toContain(
      'multiple close process identity candidates require manual confirmation',
    );
    expect(query).toHaveBeenCalledTimes(2);
  });

  it('blocks required process skills when non-exact identity candidates are too close', async () => {
    const query = jest.fn().mockResolvedValueOnce({
      columns: ['rank', 'confidence_score', 'identity_status', 'canonical_package_name', 'recommended_process_name_param', 'upid', 'process_name', 'target_match_sources', 'supporting_sources', 'identity_warning'],
      rows: [
        [1, 95, 'confirmed', 'com.example', 'com.example:main', 42, 'com.example:main', 'android_process_metadata.package_name', 'frame_timeline.upid', 'ok'],
        [2, 90, 'confirmed', 'com.example', 'com.example:remote', 43, 'com.example:remote', 'android_process_metadata.package_name', 'frame_timeline.upid', 'ok'],
      ],
      durationMs: 1,
    });

    const result = await createExecutor(query).execute('target_process_skill', 'trace', {
      process_name: 'com.example',
    });

    expect(result.success).toBe(false);
    expect(result.identityResolution?.status).toBe('ambiguous');
    expect(result.identityResolution?.warnings).toContain('multiple close process identity candidates require manual confirmation');
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('blocks required process skills before querying when target is missing', async () => {
    const query = jest.fn();
    const result = await createExecutor(query).execute('target_process_skill', 'trace', {});

    expect(result.success).toBe(false);
    expect(result.error).toContain('no package/process/upid target');
    expect(result.identityResolution).toEqual(expect.objectContaining({
      status: 'missing',
    }));
    expect(query).not.toHaveBeenCalled();
  });

  it('carries identity sidecars through generic DataEnvelope conversion', () => {
    const envelopes = SkillExecutor.toDataEnvelopes({
      skillId: 'target_process_skill',
      skillName: 'Target',
      success: true,
      displayResults: [{
        stepId: 'root',
        title: 'Result',
        layer: 'overview',
        level: 'detail',
        format: 'table',
        data: { columns: ['process_name'], rows: [['com.example']] },
      }],
      diagnostics: [],
      identityResolution: {
        version: 'identity_contract@1',
        identityRefId: 'identity:test',
        target: { traceId: 'trace', source: 'skill_param' },
        status: 'verified',
        processes: [],
        threads: [],
        warnings: [],
      },
      executionTimeMs: 1,
    });

    expect(envelopes[0].meta).toEqual(expect.objectContaining({
      identityRefId: 'identity:test',
      identityStatus: 'verified',
      identityResolution: expect.objectContaining({ identityRefId: 'identity:test' }),
    }));
  });

  it('does not cache transient resolver failures', async () => {
    const query = jest.fn()
      .mockRejectedValueOnce(new Error('trace processor warming up'))
      .mockResolvedValueOnce({
        columns: ['rank', 'confidence_score', 'identity_status', 'canonical_package_name', 'recommended_process_name_param', 'upid', 'target_match_sources', 'supporting_sources', 'identity_warning'],
        rows: [[1, 90, 'confirmed', 'com.example', 'com.real.process', 42, 'android_process_metadata.package_name', 'frame_timeline.upid', 'ok']],
        durationMs: 1,
      })
      .mockResolvedValueOnce({
        columns: ['process_name'],
        rows: [['com.real.process']],
        durationMs: 1,
      });

    const executor = createExecutor(query);
    const first = await executor.execute('target_process_skill', 'trace', {
      process_name: 'com.example',
    });
    const second = await executor.execute('target_process_skill', 'trace', {
      process_name: 'com.example',
    });

    expect(first.success).toBe(false);
    expect(second.success).toBe(true);
    expect(query).toHaveBeenCalledTimes(3);
  });
});

describe('SkillExecutor trusted exact UPID execution', () => {
  it('does not replace present null provenance with valid child evidence during result merging', () => {
    const child = {scopeProvenance: {version: 'process_scope_evidence@1', entries: [{role: 'target',
      scope: {mode: 'exact_upid', traceId: 'trace', traceSide: 'current', upid: 42}}]}};
    const invalid = {version: 'process_scope_evidence@1', entries: [], invalid: true};
    expect(resultScopeProvenance({scopeProvenance: null, rawResults: {child}})).toEqual(invalid);
    expect(resultScopeProvenance({rawResults: {bad: {scopeProvenance: null}, child}})).toEqual(invalid);
    expect(resultScopeProvenance({rawResults: {child}})).toEqual(child.scopeProvenance);
  });
  const fragments = new Map([['fragments/effective_target_processes.sql',
    'effective_target_processes AS (SELECT * FROM process WHERE ${__process_scope.upid} IS NULL OR upid = ${__process_scope.upid})']]);
  const native: SkillDefinition = {
    name: 'native_exact', version: '1', type: 'atomic', meta: { display_name: 'Native', description: 'Native' },
    identity: { policy: 'none' },
    process_scope: { role: 'target', binding: 'native_upid' },
    sql: 'SELECT upid FROM process WHERE upid = ${__process_scope.upid}',
  };
  const fragmentSkill: SkillDefinition = {
    ...native, name: 'fragment_exact',
    sql: 'SELECT upid FROM effective_target_processes',
    process_scope: { role: 'target', binding: 'effective_target_processes' },
    sql_fragments: ['fragments/effective_target_processes.sql'],
  };
  const identityRows = {
    columns: ['rank', 'confidence_score', 'identity_status', 'upid', 'pid', 'process_name', 'recommended_process_name_param', 'target_match_sources', 'identity_warning'],
    rows: [
      [1, 100, 'confirmed', 42, 4242, 'com.example', 'com.example', 'upid', 'ok'],
      [2, 100, 'confirmed', 43, 4242, 'com.example', 'com.example', 'process.name', 'ok'],
    ],
  };
  const makeExecutor = () => {
    const query = jest.fn(async (_traceId: string, sql: string) => {
      if (sql.includes('resolver_probe')) return identityRows;
      if (sql.includes('iterator_items')) return { columns: ['__process_scope'], rows: [[{ upid: 43 }]] };
      return { columns: ['upid'], rows: [[42]] };
    });
    const executor = createExecutor(query);
    executor.registerSkills([native, fragmentSkill]);
    executor.setFragmentRegistry(fragments);
    return { executor, query };
  };

  it.each(['missing', 'forged', 'wrong_trace'] as const)(
    'rejects %s runtime scope before declared step SQL can fall back to NULL', async kind => {
      const {executor, query} = makeExecutor();
      const processScope = kind === 'missing' ? undefined : kind === 'forged'
        ? JSON.parse(JSON.stringify(createEffectiveProcessScope('trace', 'current')))
        : createEffectiveProcessScope('other-trace', 'current');
      const result = await (executor as any).executeStep({...native, id: 'direct-step'}, {
        traceId: 'trace', params: {upid: 42, __process_scope: {upid: 99}},
        inherited: {}, results: {}, variables: {}, processScope,
      }, native.name);
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/issued process scope|untrusted or belongs to a different trace/);
      expect(query).not.toHaveBeenCalled();
    },
  );

  it('keeps issued unscoped SQL NULL without turning it into an exact identity', async () => {
    const {executor, query} = makeExecutor();
    const gate = await executor.prepareInvocation(native.name, 'trace', {});
    expect(gate.allowed).toBe(true);
    expect(gate.processScope?.mode).toBe('unscoped');
    const result = await executor.execute(native.name, 'trace', {}, {}, gate.processScope);
    expect(result.success).toBe(true);
    expect(result.identityResolution).toBeUndefined();
    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0][1]).toContain('upid = NULL');
  });

  it('refuses an explicit UPID reserved binding without scope or a declaration', async () => {
    const {executor, query} = makeExecutor();
    const result = await (executor as any).executeStep({...native, id: 'legacy-step', process_scope: undefined}, {
      traceId: 'trace', params: {upid: 42}, inherited: {}, results: {}, variables: {},
    }, native.name);
    expect(result.success).toBe(false);
    expect(result.error).toContain('Reserved process scope binding requires an issued process scope');
    expect(query).not.toHaveBeenCalled();
  });

  it.each([native, {...native, process_scope: undefined}, {...fragmentSkill, process_scope: undefined}])(
    'requires issued scope for reserved SQL and fragments even with empty params: $name', async source => {
      const {executor, query} = makeExecutor();
      const result = await (executor as any).executeStep({...source, id: 'unissued-step'}, {
        traceId: 'trace', params: {}, inherited: {}, results: {}, variables: {},
      }, source.name);
      expect(result.success).toBe(false);
      expect(result.error).toContain('Reserved process scope binding requires an issued process scope');
      expect(query).not.toHaveBeenCalled();
    },
  );

  it.each([native, fragmentSkill])('requires a declaration for reserved SQL and fragments: $name', async source => {
    const {executor, query} = makeExecutor();
    const result = await (executor as any).executeStep({...source, id: 'undeclared-step', process_scope: undefined}, {
      traceId: 'trace', params: {}, inherited: {}, results: {}, variables: {},
      processScope: createEffectiveProcessScope('trace', 'current'),
    }, source.name);
    expect(result.success).toBe(false);
    expect(result.error).toContain('SQL has no process_scope declaration');
    expect(query).not.toHaveBeenCalled();
  });

  it('keeps SQL without reserved bindings compatible with a context that has no process scope', async () => {
    const {executor, query} = makeExecutor();
    const result = await (executor as any).executeStep({id: 'ordinary-step', type: 'atomic', sql: 'SELECT 7 AS public_value'}, {
      traceId: 'trace', params: {}, inherited: {}, results: {}, variables: {},
    }, native.name);
    expect(result.success).toBe(true);
    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0][1]).toBe('SELECT 7 AS public_value');
  });

  it.each([native.name, fragmentSkill.name])('binds root SQL %s to the selected singleton, never candidates', async name => {
    const { executor, query } = makeExecutor();
    const result = await executor.execute(name, 'trace', { upid: 42, __process_scope: { upid: 43 } },
      { __process_scope: { upid: 99 } });
    expect(result.success).toBe(true);
    expect(result.identityResolution?.processes.map(process => process.upid)).toEqual([42]);
    expect(result.rawResults?.root.appliedProcessScope).toMatchObject({ mode: 'exact_upid', upid: 42 });
    expect(result.rawResults?.root.evidenceRole).toBe('target');
    expect(query.mock.calls[1][1]).toContain('upid = 42');
    expect(query.mock.calls[1][1]).not.toContain('43');
  });

  it.each([{ upid: 0 }, { upid: 0, package: 'com.example' }, { pid: 0 }, { pid: 0, package: 'com.example' }])(
    'rejects zero selectors before executing any SQL: %j', async params => {
      const { executor, query } = makeExecutor();
      const result = await executor.execute(native.name, 'trace', params);
      expect(result.success).toBe(false);
      expect(result.error).toContain('expected a positive safe integer');
      expect(query).not.toHaveBeenCalled();
    },
  );

  it('rejects missing scope declarations and required fragments before target SQL', async () => {
    for (const declaration of [undefined, { role: 'target', binding: 'effective_target_processes' }]) {
      const { executor, query } = makeExecutor();
      executor.registerSkill({ ...fragmentSkill, process_scope: declaration as any,
        sql_fragments: ['fragments/missing.sql'] });
      const result = await executor.execute(fragmentSkill.name, 'trace', { upid: 42 });
      expect(result.success).toBe(false);
      expect(result.error).toContain('Exact UPID scope is unsupported');
      expect(result.error).toContain('native_exact');
      expect(query).toHaveBeenCalledTimes(1);
    }
  });

  it('cannot restore runtime authority from serialized evidence', async () => {
    const { executor, query } = makeExecutor();
    const first = await executor.execute(native.name, 'trace', { upid: 42 });
    const serialized = JSON.parse(JSON.stringify(first.rawResults?.root.appliedProcessScope));
    const second = await executor.execute(native.name, 'trace', {}, {}, serialized);
    expect(second.success).toBe(false);
    expect(second.error).toContain('untrusted');
    expect(query).toHaveBeenCalledTimes(2);
  });

  it('selects exact SQL before fragment dispatch and makes unsupported branches explicitly unavailable', async () => {
    const { executor, query } = makeExecutor();
    const exactVariant = { ...fragmentSkill, sql: 'SELECT * FROM unsafe_named_buffer_track',
      exact_sql: { sql: fragmentSkill.sql!, sql_fragments: fragmentSkill.sql_fragments,
        process_scope: fragmentSkill.process_scope! } };
    executor.registerSkill(exactVariant);
    const result = await executor.execute(exactVariant.name, 'trace', { upid: 42 });
    expect(result.success).toBe(true);
    expect(query.mock.calls.map(call => call[1]).join('\n')).not.toContain('unsafe_named_buffer_track');
    executor.registerSkill({ ...native, name: 'partial', type: 'composite', sql: undefined, steps: [{
      id: 'buffer', type: 'atomic', sql: 'SELECT * FROM unsafe_named_buffer_track',
      process_scope: { role: 'target', exact_unavailable: 'No UPID relationship exists for this track' },
    }] });
    const partial = await executor.execute('partial', 'trace', { upid: 42 });
    expect(partial.success).toBe(true);
    expect(partial.partial).toBe(true);
    expect(partial.displayResults[0].executionStatus).toBe('unavailable');
    expect(partial.displayResults[0].appliedProcessScope).toBeUndefined();
    expect(partial.scopeProvenance?.entries[0].availability).toBe('unavailable');
    expect(query.mock.calls.map(call => call[1]).join('\n')).not.toContain('unsafe_named_buffer_track');
  });

  it('binds an exact-scope-unavailable step\'s save_as to null that keeps its unavailable scope', async () => {
    const { executor } = makeExecutor();
    const skill: SkillDefinition = { ...native, name: 'partial_bound', type: 'composite', sql: undefined, steps: [
      { id: 'buffer', type: 'atomic', sql: 'SELECT * FROM unsafe_named_buffer_track', save_as: 'buffer_rows',
        process_scope: { role: 'target', exact_unavailable: 'No UPID relationship exists for this track' } },
      { id: 'probe', type: 'diagnostic', inputs: ['buffer_rows'], rules: [
        { condition: 'buffer_rows?.data == null', diagnosis: 'UNOBSERVED', confidence: 'high' },
        { condition: 'buffer_rows?.data != null', diagnosis: 'BOUND ${JSON.stringify(buffer_rows.data)}', confidence: 'high' },
      ] } as any,
    ] };
    executor.registerSkill(skill);
    const inherited = { buffer_rows: { data: [{ source: 'caller' }] } };
    const entries = (provenance: any) => provenance?.entries?.map((entry: any) =>
      ({ sourceStepId: entry.sourceStepId, availability: entry.availability }));
    const unavailable = [{ sourceStepId: 'buffer', availability: 'unavailable' }];

    const result = await executor.execute(skill.name, 'trace', { upid: 42 }, inherited);
    expect(result.diagnostics.map(d => d.diagnosis)).toEqual(['UNOBSERVED']);
    expect(entries(result.diagnostics[0].scopeProvenance)).toEqual(unavailable);

    const layered = await executor.executeCompositeSkill(skill, { upid: 42 }, { traceId: 'trace', inherited });
    const probe = layered.stepResults?.find(step => step.stepId === 'probe');
    expect(probe?.data?.diagnostics?.map((d: any) => d.diagnosis)).toEqual(['UNOBSERVED']);
    expect(entries(probe?.scopeProvenance)).toEqual(unavailable);
  });

  it('preflights the whole composite before an earlier target step can run', async () => {
    const { executor, query } = makeExecutor();
    executor.registerSkill({ ...native, name: 'unmigrated_child', process_scope: undefined });
    executor.registerSkill({ ...native, name: 'parent', type: 'composite', sql: undefined,
      steps: [{ id: 'first', skill: native.name }, { id: 'last', skill: 'unmigrated_child' }] });
    const result = await executor.execute('parent', 'trace', { upid: 42 });
    expect(result.success).toBe(false);
    expect(query).toHaveBeenCalledTimes(1);
    expect(result.error).toContain('unmigrated_child');
  });

  it('propagates scope through step SQL, refs, iterator, parallel and conditional branches', async () => {
    const { executor, query } = makeExecutor();
    const parent: SkillDefinition = { ...native, name: 'parent', type: 'composite',
      steps: [
        { id: 'items', type: 'atomic', sql: 'SELECT 1 AS iterator_items',
          process_scope: { role: 'global_context' }, save_as: '__process_scope' },
        { id: 'iterate', type: 'iterator', source: '__process_scope', item_skill: native.name },
        { id: 'parallel', type: 'parallel', steps: [
          { id: 'ref', skill: fragmentSkill.name },
          { id: 'step_sql', type: 'atomic', sql: fragmentSkill.sql!, sql_fragments: fragmentSkill.sql_fragments,
            process_scope: fragmentSkill.process_scope },
        ] },
        { id: 'conditional', type: 'conditional', conditions: [{ when: 'true', then: { id: 'branch', skill: native.name } }] },
      ],
    };
    delete parent.sql;
    executor.registerSkill(parent);
    const result = await executor.execute('parent', 'trace', { upid: 42 });
    expect(result).toEqual(expect.objectContaining({success: true}));
    expect(result.error).toBeUndefined();
    const analysisSql = query.mock.calls.map(call => call[1]).filter(sql => !sql.includes('resolver_probe') && !sql.includes('iterator_items'));
    expect(analysisSql).toHaveLength(4);
    for (const sql of analysisSql) {
      expect(sql).toContain('upid = 42');
      expect(sql).not.toContain('43');
    }
    expect(result.rawResults?.items.evidenceRole).toBe('global_context');
    expect(result.rawResults?.items.appliedProcessScope).toBeUndefined();
    const layered = await executor.executeCompositeSkill(parent, { upid: 42 }, { traceId: 'trace' });
    expect(layered.stepResults?.find(step => step.stepId === 'items')?.evidenceRole).toBe('global_context');
  });

  it('preserves peer context while the authored target relation is exact', async () => {
    const { executor, query } = makeExecutor();
    executor.registerSkill({ ...fragmentSkill, sql: `${fragmentSkill.sql} CROSS JOIN process peer WHERE peer.name = 'surfaceflinger'` });
    const result = await executor.execute(fragmentSkill.name, 'trace', { upid: 42 });
    expect(result.success).toBe(true);
    expect(query.mock.calls[1][1]).toContain("CROSS JOIN process peer WHERE peer.name = 'surfaceflinger'");
    expect(query.mock.calls[1][1]).toContain('upid = 42');
  });

  it('rejects a child selector that switches to a restarted process instance', async () => {
    const { executor, query } = makeExecutor();
    executor.registerSkill({ ...native, name: 'parent', type: 'composite', sql: undefined,
      steps: [{ id: 'switch', skill: native.name, params: { upid: 43 } }] });
    const result = await executor.execute('parent', 'trace', { upid: 42 });
    expect(result.success).toBe(false);
    expect(result.error).toContain('cannot change');
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('declares executable scope bindings on the migrated real YAML and fragment paths', () => {
    const skillsDir = path.resolve(__dirname, '../../../../skills');
    const realFragments = new Map(['effective_target_processes.sql', 'target_threads.sql', 'io_blocked_function_families.sql']
      .map(name => [`fragments/${name}`, fs.readFileSync(path.join(skillsDir, 'fragments', name), 'utf8')]));
    for (const name of ['process_slice_cpu_hotspots', 'main_thread_slices_in_range', 'main_thread_states_in_range',
      'app_frame_production', 'frame_pipeline_variance', 'process_identity_resolver']) {
      const file = path.join(skillsDir, 'atomic', `${name}.skill.yaml`);
      const definition = normalizeSkillDefinition(yaml.load(fs.readFileSync(file, 'utf8')), file)!;
      expect(getExactProcessScopeSupport(definition, new Map(), realFragments)).toEqual({ supported: true });
    }
  });

  it('executes the real scrolling dependency closure with exact target and global context roles', async () => {
    const registry = new SkillRegistry();
    const skillsDir = path.resolve(__dirname, '../../../../skills');
    const definitions = ['composite/scrolling_analysis.skill.yaml', 'atomic/cpu_topology_view.skill.yaml',
      'atomic/frame_pipeline_variance.skill.yaml','atomic/cpu_system_context_in_range.skill.yaml',
      'atomic/thread_system_summary_in_range.skill.yaml','atomic/thread_preemption_handoffs_in_range.skill.yaml'].map(file => registry.loadSingleSkill(skillsDir, file)!);
    const query = jest.fn(async (_trace: string, sql: string) => {
      if (sql.includes('resolver_probe')) return identityRows;
      if (sql.includes('as has_frame_timeline')) return { columns: ['has_frame_timeline'], rows: [[1]] };
      if (sql.includes('frame_count AS')) return { columns: ['has_data', 'total_frames', 'vsync_period_ns'], rows: [[1, 3, 16666667]] };
      if (sql.includes('target_presence AS')) return {
        columns: ['coverage_status', 'should_fallback', 'frame_timeline_frames', 'buffer_tx_frames'],
        rows: [['frame_timeline_only_exact_upid', 0, 3, null]],
      };
      if (sql.includes('resolved_jank AS')) return { columns: ['total_frames', 'janky_frames', 'refresh_rate'], rows: [[3, 1, 60]] };
      if (sql.includes('as input_data_status')) return {columns: ['total_input_events'], rows: [[2]]};
      if (sql.includes('frame_backlog AS')) return {columns: ['avg_e2e_ms', 'frame_budget_ms'], rows: [[8, 16.67]]};
      return { columns: [], rows: [] };
    });
    const executor = new SkillExecutor({ query });
    executor.registerSkills([resolverSkill, ...definitions]);
    executor.setFragmentRegistry(registry.getFragmentCache());
    const support = getExactProcessScopeSupport(definitions[0], new Map(definitions.map(item => [item.name, item])), registry.getFragmentCache());
    expect(support).toMatchObject({ supported: true, partial: true });
    const result = await executor.execute('scrolling_analysis', 'trace', { upid: 42, enable_frame_details: true });
    expect(result.success).toBe(true);
    expect(result.partial).toBe(true);
    const sentSql = query.mock.calls.map(call => call[1]);
    expect(sentSql.filter(sql => sql.includes('resolver_probe'))).toHaveLength(1);
    expect(sentSql.join('\n')).not.toContain("ct.name GLOB 'BufferTX - *'");
    expect(result.rawResults?.vsync_config.scopeProvenance?.entries.map(entry => entry.role)).toEqual(['target', 'global_context']);
    expect(result.rawResults?.session_cpu_freq.evidenceRole).toBe('global_context');
    expect(result.rawResults?.session_cpu_freq.appliedProcessScope).toBeUndefined();
    expect(result.rawResults?.batch_frame_root_cause.scopeProvenance?.entries.map(entry => entry.role))
      .toEqual(['target', 'global_context', 'peer_context']);
    expect(result.rawResults?.input_latency_summary.scopeProvenance?.entries).toEqual(expect.arrayContaining([
      expect.objectContaining({role: 'target', fields: ['avg_e2e_ms'], scope: expect.objectContaining({upid: 42})}),
      expect.objectContaining({role: 'global_context', fields: ['frame_budget_ms'], scope: expect.objectContaining({mode: 'unscoped'})}),
    ]));
  });
});

describe('PID uniqueness with the real process identity resolver YAML', () => {
  it.each([
    {reused: false, active: false}, {reused: false, active: true},
    {reused: true, active: false}, {reused: true, active: true},
  ])('uses complete process facts independently of candidate activity: %j', async ({reused, active}) => {
    const db = new Database(':memory:');
    db.function('trace_start', () => 0);
    db.function('trace_end', () => 1000);
    try {
      db.exec(`
        CREATE TABLE process(upid INTEGER PRIMARY KEY, pid INTEGER, name TEXT, cmdline TEXT,
          uid INTEGER, android_appid INTEGER, start_ts INTEGER, end_ts INTEGER);
        CREATE TABLE android_process_metadata(upid INTEGER, process_name TEXT, package_name TEXT,
          uid INTEGER, shared_uid INTEGER, is_kernel_task INTEGER);
        CREATE TABLE thread(upid INTEGER, utid INTEGER, tid INTEGER, name TEXT, is_main_thread INTEGER);
        CREATE TABLE actual_frame_timeline_slice(upid INTEGER, ts INTEGER, dur INTEGER, jank_type TEXT, layer_name TEXT);
        CREATE TABLE android_oom_adj_intervals(upid INTEGER, ts INTEGER, dur INTEGER, score INTEGER);
        CREATE TABLE android_battery_stats_event_slices(str_value TEXT, ts INTEGER, safe_dur INTEGER, track_name TEXT);
        INSERT INTO process VALUES (42,4242,'com.example','com.example',1000,1000,0,1000);
      `);
      if (reused) db.exec("INSERT INTO process VALUES (43,4242,'com.example','com.example',1000,1000,0,1000)");
      if (active) db.exec(`
        INSERT INTO actual_frame_timeline_slice VALUES (42,100,100,'App Deadline Missed','layer');
        INSERT INTO thread VALUES (42,10,4242,'main',1), (42,11,4243,'RenderThread',0);
        INSERT INTO android_oom_adj_intervals VALUES (42,0,1000,0);
        INSERT INTO android_battery_stats_event_slices VALUES ('com.example',0,1000,'battery_stats.top');
      `);
      const query = jest.fn(async (_traceId: string, sql: string) => {
        const rendered = sql.replace(/INCLUDE PERFETTO MODULE [^;]+;/g, '').trim();
        if (!rendered) return {columns: [], rows: []};
        const statement = db.prepare<[], unknown[]>(rendered);
        return {columns: statement.columns().map(column => column.name), rows: statement.raw().all()};
      });
      const executor = new SkillExecutor({query});
      const file = path.resolve(__dirname, '../../../../skills/atomic/process_identity_resolver.skill.yaml');
      const definition = normalizeSkillDefinition(yaml.load(fs.readFileSync(file, 'utf8')), file)!;
      executor.registerSkills([definition, {name: 'pid_exact_target', version: '1', type: 'atomic',
        meta: {display_name: 'PID target fixture', description: 'Exact process rows'},
        identity: {policy: 'required'}, inputs: [{name: 'package', type: 'string', required: false}],
        process_scope: {role: 'target', binding: 'native_upid'},
        sql: 'SELECT upid AS selected_upid FROM process WHERE upid = ${__process_scope.upid}',
      }]);
      // The maintained candidate query is deliberately limited to one row. Its
      // activity score must never stand in for complete PID uniqueness facts.
      const candidates = await executor.execute(definition.name, 'trace', {pid: 4242, max_rows: 1});
      expect(candidates.success).toBe(true);
      expect(candidates.rawResults?.root.data).toHaveLength(1);
      expect(candidates.rawResults?.root.data[0].confidence_score).toBe(active ? 55 : 35);
      query.mockClear();

      const result = await executor.execute('pid_exact_target', 'trace', {pid: 4242});
      expect(result.success).toBe(!reused);
      const targetQueries = query.mock.calls.filter(([, sql]) => sql.includes('AS selected_upid'));
      if (reused) {
        expect(result.identityResolution?.status).not.toBe('verified');
        expect(targetQueries).toHaveLength(0);
        expect(query.mock.calls).toHaveLength(1);
      } else {
        expect(result.rawResults?.root.data).toEqual([{selected_upid: 42}]);
        expect(result.rawResults?.root.appliedProcessScope).toMatchObject({mode: 'exact_upid', upid: 42});
        expect(targetQueries).toHaveLength(1);
      }
    } finally {
      db.close();
    }
  });
});

describe('ANR and frame-detail real YAML scope closure', () => {
  const skillsDir = path.resolve(__dirname, '../../../../skills');
  const files = [
    'composite/anr_detail.skill.yaml', 'composite/jank_frame_detail.skill.yaml',
    'atomic/cpu_system_context_in_range.skill.yaml','atomic/thread_system_summary_in_range.skill.yaml',
    'atomic/thread_preemption_handoffs_in_range.skill.yaml',
    'atomic/cpu_topology_view.skill.yaml', 'atomic/main_thread_states_in_range.skill.yaml',
    'atomic/main_thread_slices_in_range.skill.yaml', 'atomic/binder_in_range.skill.yaml',
    'atomic/binder_blocking_in_range.skill.yaml', 'atomic/main_thread_sched_latency_in_range.skill.yaml',
    'atomic/sched_latency_in_range.skill.yaml', 'atomic/task_migration_in_range.skill.yaml',
    'atomic/gpu_render_in_range.skill.yaml', 'atomic/cpu_throttling_in_range.skill.yaml',
    'atomic/cpu_cluster_load_in_range.skill.yaml', 'atomic/page_fault_in_range.skill.yaml',
    'atomic/sf_composition_in_range.skill.yaml', 'atomic/gpu_freq_in_range.skill.yaml',
    'atomic/vsync_alignment_in_range.skill.yaml', 'atomic/render_pipeline_latency.skill.yaml',
    'atomic/process_identity_resolver.skill.yaml',
  ];
  const anrParams = {
    anr_ts: 200_000_000, timeout_ns: 100_000_000,
    process_name: 'com.example', anr_type: 'INPUT_DISPATCHING_TIMEOUT',
  };
  const interval = {start_ts: 100_000_000, end_ts: 200_000_000};

  function fixture() {
    const registry = new SkillRegistry();
    const definitions = files.map(file => registry.loadSingleSkill(skillsDir, file)!);
    const db = new Database(':memory:');
    db.function('trace_start', () => 0);
    db.function('trace_end', () => 1_000_000_000);
    // trace_processor intrinsic; NULL like a trace without clock snapshots, so
    // cpu_cluster_load_in_range takes its wall-clock fallback.
    db.function('to_monotonic', (_ts: unknown) => null);
    db.exec(`
      CREATE TABLE process(upid INTEGER PRIMARY KEY, pid INTEGER, name TEXT, cmdline TEXT,
        uid INTEGER, android_appid INTEGER, start_ts INTEGER, end_ts INTEGER);
      CREATE TABLE thread(upid INTEGER, utid INTEGER PRIMARY KEY, tid INTEGER, name TEXT, is_main_thread INTEGER);
      CREATE TABLE thread_state(utid INTEGER, ts INTEGER, dur INTEGER, state TEXT, cpu INTEGER,
        blocked_function TEXT, io_wait INTEGER, waker_utid INTEGER);
      CREATE TABLE thread_track(id INTEGER PRIMARY KEY, utid INTEGER);
      CREATE TABLE slice(id INTEGER PRIMARY KEY, parent_id INTEGER, track_id INTEGER, ts INTEGER, dur INTEGER, name TEXT);
      CREATE TABLE sched_slice(cpu INTEGER);
      CREATE TABLE cpu(id INTEGER PRIMARY KEY, capacity INTEGER);
      CREATE TABLE cpu_counter_track(id INTEGER PRIMARY KEY, cpu INTEGER, name TEXT);
      CREATE TABLE counter_track(id INTEGER PRIMARY KEY, name TEXT);
      CREATE TABLE counter(track_id INTEGER, ts INTEGER, value REAL);
      CREATE TABLE android_binder_txns(client_upid INTEGER, client_utid INTEGER, client_tid INTEGER,
        client_process TEXT, client_ts INTEGER, client_dur INTEGER, server_upid INTEGER,
        server_utid INTEGER, server_process TEXT, server_thread TEXT, server_dur INTEGER,
        aidl_name TEXT, is_sync INTEGER);
      CREATE TABLE android_monitor_contention(upid INTEGER, blocked_utid INTEGER, blocking_utid INTEGER,
        short_blocking_method TEXT, blocking_thread_name TEXT, short_blocked_method TEXT,
        blocked_thread_name TEXT, process_name TEXT, is_blocked_thread_main INTEGER,
        waiter_count INTEGER, ts INTEGER, dur INTEGER);
      CREATE TABLE android_logs(ts INTEGER, prio INTEGER, tag TEXT, msg TEXT);
      CREATE TABLE gpu_counter_track(id INTEGER PRIMARY KEY, name TEXT, gpu_id INTEGER, ugpu INTEGER);
      CREATE TABLE android_process_metadata(upid INTEGER, process_name TEXT, package_name TEXT,
        uid INTEGER, shared_uid INTEGER, is_kernel_task INTEGER);
      CREATE TABLE actual_frame_timeline_slice(upid INTEGER, ts INTEGER, dur INTEGER, jank_type TEXT, layer_name TEXT);
      CREATE TABLE android_oom_adj_intervals(upid INTEGER, ts INTEGER, dur INTEGER, score INTEGER);
      CREATE TABLE android_battery_stats_event_slices(str_value TEXT, ts INTEGER, safe_dur INTEGER, track_name TEXT);
      INSERT INTO process VALUES
        (42,4242,'com.example','com.example',1000,1000,0,1000000000),
        (43,4343,'com.example','com.example',1000,1000,0,1000000000),
        (44,4444,'com.example:remote','com.example:remote',1000,1000,0,1000000000),
        (45,4545,'com.example.similar','com.example.similar',1000,1000,0,1000000000),
        (90,9000,'surfaceflinger','surfaceflinger',1000,1000,0,1000000000),
        (91,9100,'system_server','system_server',1000,1000,0,1000000000);
      INSERT INTO thread VALUES
        (42,10,4242,'main',1), (42,11,4243,'RenderThread',0), (42,12,4244,'Binder:1',0),
        (42,13,4245,'UIWorker',0), (43,20,4343,'main',1), (43,21,4344,'RenderThread',0),
        (44,30,4444,'main',1), (45,40,4545,'main',1),
        (90,90,9000,'surfaceflinger',1), (91,91,9101,'Binder:server',0);
      -- Waker identity belongs to the successor Runnable event. Zero-duration
      -- transitions preserve these wakeup events without adding occupancy.
      INSERT INTO thread_state VALUES
        (10,100000000,10000000,'R',0,NULL,0,NULL),
        (10,110000000,20000000,'Running',0,NULL,0,NULL),
        (10,130000000,20000000,'S',0,'binder_thread_read',0,NULL),
        (10,150000000,0,'R',0,NULL,0,91),
        (10,150000000,10000000,'D',0,'do_page_fault',1,NULL),
        (10,160000000,0,'R',0,NULL,0,91),
        (10,160000000,10000000,'S',0,'futex_wait',0,NULL),
        (10,170000000,0,'R',0,NULL,0,12),
        (10,180000000,5000000,'Running',1,NULL,0,NULL),
        (11,125000000,5000000,'Running',1,NULL,0,NULL),
        (11,130000000,3000000,'R',1,NULL,0,NULL),
        (12,120000000,5000000,'Running',0,NULL,0,NULL),
        (12,170000000,2000000,'D',0,'do_page_fault',1,91),
        (13,125000000,2000000,'R',0,NULL,0,NULL),
        (20,100000000,80000000,'R',0,NULL,0,NULL),
        (20,180000000,10000000,'Running',0,NULL,0,NULL),
        (30,100000000,90000000,'R',0,NULL,0,NULL),
        (40,100000000,90000000,'R',0,NULL,0,NULL),
        (90,100000000,80000000,'Running',1,NULL,0,NULL);
      INSERT INTO thread_track VALUES (100,10),(101,11),(120,20),(121,21),(130,30),(140,40),(190,90);
      INSERT INTO slice VALUES
        (1,NULL,100,140000000,4000000,'fsync'),
        (2,1,100,141000000,1000000,'write'),
        (3,NULL,101,125000000,5000000,'DrawFrame'),
        (4,NULL,190,125000000,9000000,'DrawFrame'),
        (5,NULL,121,125000000,50000000,'DrawFrame'),
        (6,NULL,120,140000000,50000000,'fsync'),
        (7,NULL,190,150000000,6000000,'composite');
      INSERT INTO android_binder_txns VALUES
        (42,10,4242,'com.example',130000000,20000000,91,91,'system_server','Binder:server',15000000,'IFixture',1),
        (42,12,4244,'com.example',150000000,2000000,91,91,'system_server','Binder:server',1000000,'IWorker',1),
        (43,20,4343,'com.example',130000000,70000000,91,91,'system_server','Binder:server',60000000,'IFixture',1);
      INSERT INTO android_monitor_contention VALUES
        (42,10,12,'ownerMethod','Binder:1','blockedMethod','main','com.example',1,2,140000000,5000000),
        (43,20,21,'decoyOwner','RenderThread','blockedMethod','main','com.example',1,3,140000000,50000000);
      INSERT INTO android_logs VALUES (190000000,5,'InputDispatcher','com.example input dispatch timeout');
      INSERT INTO cpu VALUES (0,512),(1,1024);
      INSERT INTO sched_slice VALUES (0),(1);
      INSERT INTO cpu_counter_track VALUES (1,0,'cpufreq'),(2,1,'cpufreq');
      INSERT INTO counter_track VALUES (30,'VSYNC-sf');
      INSERT INTO counter VALUES (1,100000000,1000000),(1,190000000,500000),
        (2,100000000,2000000),(2,190000000,1500000),
        (30,100000000,1),(30,116000000,1),(30,132000000,1),(30,148000000,1),
        (30,164000000,1),(30,180000000,1),(30,196000000,1);
      -- kgsl_gpu_frequency samples, which trace_processor stores in Hz.
      INSERT INTO gpu_counter_track VALUES (40,'gpufreq',0,0);
      INSERT INTO counter VALUES (40,100000000,800000000),(40,150000000,400000000);
    `);
    db.exec(`
      CREATE TABLE trace_bounds(start_ts INTEGER,end_ts INTEGER);
      INSERT INTO trace_bounds VALUES(0,1000000000);
      ALTER TABLE counter ADD COLUMN id INTEGER;
      UPDATE counter SET id = rowid;
      ALTER TABLE thread ADD COLUMN is_idle INTEGER DEFAULT 0;
      ALTER TABLE cpu ADD COLUMN cpu INTEGER;
      ALTER TABLE cpu ADD COLUMN machine_id INTEGER;
      ALTER TABLE cpu ADD COLUMN cluster_id INTEGER;
      UPDATE cpu SET cpu=id,cluster_id=id;
      ALTER TABLE thread_state ADD COLUMN id INTEGER;
      ALTER TABLE thread_state ADD COLUMN ucpu INTEGER;
      ALTER TABLE thread_state ADD COLUMN irq_context INTEGER;
      UPDATE thread_state SET id=rowid,ucpu=cpu;
      ALTER TABLE sched_slice ADD COLUMN id INTEGER;
      ALTER TABLE sched_slice ADD COLUMN ucpu INTEGER;
      ALTER TABLE sched_slice ADD COLUMN utid INTEGER;
      ALTER TABLE sched_slice ADD COLUMN ts INTEGER;
      ALTER TABLE sched_slice ADD COLUMN dur INTEGER;
      ALTER TABLE sched_slice ADD COLUMN end_state TEXT;
      ALTER TABLE sched_slice ADD COLUMN priority INTEGER;
      DELETE FROM sched_slice;
      INSERT INTO sched_slice SELECT cpu,id,ucpu,utid,ts,dur,'S',120 FROM thread_state WHERE state='Running';
      CREATE TABLE cpu_frequency_counters AS
        SELECT c.rowid AS id,t.id AS track_id,t.cpu AS ucpu,t.cpu,c.ts,LEAD(c.ts,1,1000000000) OVER(PARTITION BY t.cpu ORDER BY c.ts)-c.ts AS dur,c.value AS freq
        FROM counter c JOIN cpu_counter_track t ON t.id=c.track_id WHERE t.name='cpufreq';
    `);
    const query = jest.fn(async (_trace: string, sql: string): Promise<QueryResult> => {
      // Materialized module tables above are fixture data, not replacement SQL.
      // The real YAML, fragments, resolver, scope gate and SQLite execute below.
      const sqliteSql = sql.replace(/INCLUDE PERFETTO MODULE [^;]+;/g, '')
        .replace(/CREATE PERFETTO (TABLE|VIEW)/g, 'CREATE $1').trim();
      if (!sqliteSql) return {columns: [], rows: [], durationMs: 0};
      const statement = db.prepare<[], unknown[]>(sqliteSql);
      if (!statement.reader) {
        statement.run();
        return {columns: [], rows: [], durationMs: 0};
      }
      return {columns: statement.columns().map(column => column.name), rows: statement.raw().all(), durationMs: 0};
    });
    const executor = new SkillExecutor({query});
    executor.registerSkills(definitions);
    executor.setFragmentRegistry(registry.getFragmentCache());
    return {db, executor, query, definitions, registry};
  }

  async function executeHelper(executor: SkillExecutor, name: string, scope: EffectiveProcessScope) {
    const packageInputs = new Set(['binder_in_range', 'binder_blocking_in_range',
      'main_thread_sched_latency_in_range', 'sched_latency_in_range', 'task_migration_in_range',
      'page_fault_in_range', 'gpu_render_in_range']);
    return executor.execute(name, 'trace', {...interval,
      ...(packageInputs.has(name) ? {package: 'com.example'} : {})}, {}, scope);
  }

  it('admits both complete real closures without declaring any SQL unavailable', () => {
    const {db, definitions, registry} = fixture();
    try {
      const graph = new Map(definitions.map(definition => [definition.name, definition]));
      for (const name of ['anr_detail', 'jank_frame_detail']) {
        expect(getExactProcessScopeSupport(graph.get(name)!, graph, registry.getFragmentCache()))
          .toMatchObject({supported: true});
      }
      for (const definition of definitions) {
        const sqlNodes = [definition, ...(definition.steps || [])].filter(node => 'sql' in node);
        for (const node of sqlNodes) {
          expect((node as any).process_scope?.exact_unavailable).toBeUndefined();
        }
      }
    } finally {db.close();}
  });

  it('executes ANR exact rows while retaining Binder threads, lock owners and external wakers', async () => {
    const {db, executor} = fixture();
    try {
      const result = await executor.execute('anr_detail', 'trace', {...anrParams, upid: 42});
      expect(result.success).toBe(true);
      const raw = result.rawResults!;
      for (const id of ['anr_info', 'main_thread_quadrant', 'render_thread_analysis',
        'lock_contention', 'app_freeze_check', 'wakeup_chain', 'blocking_reasons',
        'main_thread_slices', 'binder_calls', 'main_thread_sync_binder', 'sched_latency',
        'direct_blocker_classification', 'direct_blocker_slice_classification']) {
        expect(raw[id]).toMatchObject({success: true});
      }
      expect(raw.anr_info.data[0]).toMatchObject({upid: 42, pid: 4242, process_name: 'com.example', timeout_ms: 100});
      expect(raw.anr_info.evidenceRole).toBe('identity_metadata');
      expect(raw.anr_info.appliedProcessScope).toBeUndefined();
      expect(raw.main_thread_quadrant.data[0]).toMatchObject({total_ms: 75, q3_runnable_ms: 10, q4_sleeping_ms: 40});
      expect(raw.app_freeze_check.data.map((row: any) => row.thread_type)).toEqual(['MainThread', 'RenderThread', 'Binder']);
      expect(raw.lock_contention.data).toEqual([expect.objectContaining({wait_ms: 5, blocking_thread_name: 'Binder:1', waiter_count: 2})]);
      expect(raw.wakeup_chain.data).toHaveLength(3);
      expect(raw.wakeup_chain.data).toEqual(expect.arrayContaining([
        expect.objectContaining({waker_process: 'system_server', blocked_function: 'binder_thread_read', wakeup_count: 1, total_sleep_ms: 20}),
        expect.objectContaining({waker_process: 'system_server', blocked_function: 'do_page_fault', wakeup_count: 1, total_sleep_ms: 10}),
        expect.objectContaining({waker_thread: 'Binder:1', blocked_function: 'futex_wait', wakeup_count: 1, total_sleep_ms: 10}),
      ]));
      expect(raw.wakeup_chain.data.filter((row: any) => row.waker_process === 'system_server')
        .reduce((total: number, row: any) => total + row.total_sleep_ms, 0)).toBe(30);
      for (const [id, peerFields] of [
        ['lock_contention', ['blocking_method', 'blocking_thread_name', 'waiter_count']],
        ['wakeup_chain', ['waker_thread', 'waker_process']],
      ] as const) {
        const entries = raw[id].scopeProvenance!.entries;
        expect(entries.find((entry: any) => entry.role === 'peer_context')).toMatchObject({
          fields: [...peerFields], scope: {mode: 'unscoped'}, relativeTo: {upid: 42},
        });
        const targetFields = entries.find(entry => entry.role === 'target')!.fields;
        for (const field of peerFields) expect(targetFields).not.toContain(field);
      }
      expect(raw.anr_logcat_context.evidenceRole).toBe('global_context');
      expect(raw.anr_logcat_context.appliedProcessScope).toBeUndefined();
    } finally {db.close();}
  });

  it.each([{selector: {}, expectedPid: null}, {selector: {pid: 4242}, expectedPid: 4242}])(
    'runs the real root-to-child chain without forwarding default zero IDs: %j', async ({selector, expectedPid}) => {
      const {db, executor} = fixture();
      try {
        db.exec(`UPDATE process SET name = 'other.instance', cmdline = 'other.instance' WHERE upid IN (43,44);
          UPDATE android_binder_txns SET client_process = 'other.instance' WHERE client_upid IN (43,44);
          UPDATE android_monitor_contention SET process_name = 'other.instance' WHERE upid IN (43,44)`);
        const execute = jest.spyOn(executor, 'execute');
        const result = await executor.execute('anr_detail', 'trace', {...anrParams, ...selector});
        expect(result.success).toBe(true);
        expect(result.rawResults?.anr_info.data[0]).toMatchObject({pid: expectedPid, upid: expectedPid === null ? null : 42});
        for (const name of ['main_thread_states_in_range', 'main_thread_slices_in_range']) {
          const call = execute.mock.calls.find(([id]) => id === name)!;
          expect(call).toBeDefined();
          expect(call[2]).not.toHaveProperty('upid');
          expect(call[2]).not.toHaveProperty('pid');
          expect(call[4]?.mode).toBe(expectedPid === null ? 'named' : 'exact_upid');
        }
        expect(result.rawResults?.blocking_reasons.success).toBe(true);
        expect(result.rawResults?.main_thread_slices.success).toBe(true);
      } finally {db.close();}
    },
  );

  it('keeps Binder client quantities exact and server quantities as peer evidence', async () => {
    const {db, executor} = fixture();
    try {
      const gate = await executor.prepareInvocation('anr_detail', 'trace', {...anrParams, upid: 42});
      expect(gate.allowed).toBe(true);
      const calls = await executeHelper(executor, 'binder_in_range', gate.processScope!);
      expect(calls.success).toBe(true);
      expect(calls.rawResults?.root.data).toEqual([expect.objectContaining({call_count: 2, total_client_ms: 22, server_process: 'system_server'})]);
      const blocking = await executeHelper(executor, 'binder_blocking_in_range', gate.processScope!);
      expect(blocking.success).toBe(true);
      expect(blocking.rawResults?.root.data).toEqual([
        expect.objectContaining({interface: 'IFixture', total_block_ms: 20, server_exec_ms: 15, is_main_blocked: 1}),
        expect.objectContaining({interface: 'IWorker', total_block_ms: 2, server_exec_ms: 1, is_main_blocked: 0}),
      ]);
      expect(blocking.rawResults?.root.scopeProvenance?.entries).toEqual(expect.arrayContaining([
        expect.objectContaining({role: 'peer_context', fields: ['server_process', 'interface', 'server_exec_ms'], relativeTo: expect.objectContaining({upid: 42})}),
      ]));
    } finally {db.close();}
  });

  it('preserves scoped helper tasks including zero-migration rows and contextual GPU aggregation', async () => {
    const {db, executor} = fixture();
    try {
      const gate = await executor.prepareInvocation('anr_detail', 'trace', {...anrParams, upid: 42});
      expect(gate.allowed).toBe(true);
      const latency = await executeHelper(executor, 'main_thread_sched_latency_in_range', gate.processScope!);
      expect(latency.success).toBe(true);
      expect(latency.rawResults?.root.data[0]).toMatchObject({runnable_count: 1, total_runnable_ms: 10});
      const threads = await executeHelper(executor, 'sched_latency_in_range', gate.processScope!);
      expect(threads.success).toBe(true);
      expect(threads.rawResults?.root.data).toEqual(expect.arrayContaining([
        expect.objectContaining({thread_name: 'main', total_runnable_ms: 10}),
        expect.objectContaining({thread_name: 'RenderThread', total_runnable_ms: 3}),
        expect.objectContaining({thread_name: 'UIWorker', total_runnable_ms: 2}),
      ]));
      const faults = await executeHelper(executor, 'page_fault_in_range', gate.processScope!);
      expect(faults.success).toBe(true);
      expect(faults.rawResults?.root.data).toEqual([
        expect.objectContaining({thread_name: 'main', count: 1, total_ms: 10}),
        expect.objectContaining({thread_name: 'Binder:1', count: 1, total_ms: 2}),
      ]);
      const migration = await executeHelper(executor, 'task_migration_in_range', gate.processScope!);
      expect(migration.success).toBe(true);
      expect(migration.rawResults?.migration_analysis.data).toEqual([
        expect.objectContaining({thread_name: 'main', migration_count: 1, little_to_big: 1, big_core_pct: 20, unique_cpus: 2}),
        expect.objectContaining({thread_name: 'RenderThread', migration_count: 0, big_core_pct: 100, unique_cpus: 1}),
        expect.objectContaining({thread_name: 'Binder:1', migration_count: 0, big_core_pct: 0, unique_cpus: 1}),
      ]);
      const gpu = await executeHelper(executor, 'gpu_render_in_range', gate.processScope!);
      expect(gpu.success).toBe(true);
      expect(gpu.rawResults?.root.data).toEqual([expect.objectContaining({operation: 'Draw Frame', count: 2, total_ms: 14, max_ms: 9})]);
      expect(gpu.rawResults?.root.evidenceRole).toBe('global_context');
      expect(gpu.rawResults?.root.appliedProcessScope).toBeUndefined();
      expect(gpu.rawResults?.root.scopeProvenance?.entries[0].relativeTo?.upid).toBe(42);
    } finally {db.close();}
  });

  it('keeps global and SF measurements unchanged between exact targets and parameter timing as metadata', async () => {
    const {db, executor} = fixture();
    try {
      const first = await executor.prepareInvocation('anr_detail', 'trace', {...anrParams, upid: 42});
      const second = await executor.prepareInvocation('anr_detail', 'trace', {...anrParams, upid: 43});
      expect(first.allowed && second.allowed).toBe(true);
      for (const [name, step, role] of [
        ['cpu_throttling_in_range', 'throttle_detection', 'global_context'],
        ['cpu_cluster_load_in_range', 'cluster_load', 'global_context'],
        ['gpu_freq_in_range', 'root', 'global_context'],
        ['vsync_alignment_in_range', 'root', 'global_context'],
        ['sf_composition_in_range', 'root', 'peer_context'],
        ['render_pipeline_latency', 'root', 'identity_metadata'],
      ]) {
        const a = await executeHelper(executor, name, first.processScope!);
        const b = await executeHelper(executor, name, second.processScope!);
        expect(a.success && b.success).toBe(true);
        expect(a.rawResults?.[step].data.length).toBeGreaterThan(0);
        expect(b.rawResults?.[step].data).toEqual(a.rawResults?.[step].data);
        expect(a.rawResults?.[step].evidenceRole).toBe(role);
        expect(a.rawResults?.[step].appliedProcessScope).toBeUndefined();
      }
    } finally {db.close();}
  });

  it.each([{upid: 0}, {pid: 0}, {upid: 999999}])('refuses invalid selectors before ANR target SQL: %j', async selector => {
    const {db, executor, query} = fixture();
    try {
      const result = await executor.execute('anr_detail', 'trace', {...anrParams, ...selector});
      expect(result.success).toBe(false);
      expect(result.rawResults).toBeUndefined();
      if (('upid' in selector && selector.upid === 0) || ('pid' in selector && selector.pid === 0)) {
        expect(query).not.toHaveBeenCalled();
      }
    } finally {db.close();}
  });

  it('rejects a reused PID and does not infer a unique ANR instance from matching names', async () => {
    const {db, executor, query} = fixture();
    try {
      db.exec('UPDATE process SET pid = 4242 WHERE upid = 43');
      const result = await executor.execute('anr_detail', 'trace', {...anrParams, pid: 4242});
      expect(result.success).toBe(false);
      expect(result.identityResolution?.status).not.toBe('verified');
      expect(result.rawResults).toBeUndefined();
      expect(query).toHaveBeenCalledTimes(1);
    } finally {db.close();}
  });

  it('rejects forged or wrong-trace scope before a real ANR target step executes', async () => {
    const {db, executor, query, definitions} = fixture();
    try {
      const gate = await executor.prepareInvocation('anr_detail', 'trace', {...anrParams, upid: 42});
      expect(gate.allowed).toBe(true);
      const anr = definitions.find(definition => definition.name === 'anr_detail')!;
      const step = anr.steps!.find(candidate => candidate.id === 'main_thread_quadrant')!;
      for (const processScope of [JSON.parse(JSON.stringify(gate.processScope)), createEffectiveProcessScope('other-trace', 'current')]) {
        query.mockClear();
        const result = await (executor as any).executeStep(step, {
          traceId: 'trace', params: {...anrParams, upid: 42, pid: 4242},
          inherited: {}, results: {}, variables: {}, processScope,
        }, anr.name);
        expect(result.success).toBe(false);
        expect(query).not.toHaveBeenCalled();
      }
    } finally {db.close();}
  });
});

describe('app_frame_production executable SQL window semantics', () => {
  const createFixture = () => {
    const db = new Database(':memory:');
    db.exec(`
      CREATE TABLE process(upid INTEGER PRIMARY KEY, pid INTEGER, name TEXT);
      CREATE TABLE expected_frame_timeline_slice(
        upid INTEGER, display_frame_token INTEGER, ts INTEGER, dur INTEGER
      );
      CREATE TABLE actual_frame_timeline_slice(
        upid INTEGER, display_frame_token INTEGER, ts INTEGER, dur INTEGER, jank_type TEXT
      );
      INSERT INTO process VALUES
        (42, 4242, 'com.example'),
        (43, 4242, 'com.example'),
        (44, 4444, 'com.example:remote'),
        (45, 4545, 'com.example.similar');
      INSERT INTO expected_frame_timeline_slice VALUES
        (42, 1, 100000000, 10000000),
        (43, 2, 1000000, 900000000),
        (44, 3, 2000000, 900000000),
        (45, 4, 3000000, 900000000);
      INSERT INTO actual_frame_timeline_slice VALUES
        (42, 1, 105000000, 15000000, 'App Deadline Missed'),
        (43, 2, 2000000, 900000000, 'None'),
        (44, 3, 3000000, 900000000, 'None'),
        (45, 4, 4000000, 900000000, 'None');
    `);
    const executor = new SkillExecutor({ query: async (_traceId: string, sql: string) => {
      // The fixture provides the module's materialized tables. Execute the
      // authored SQL and the executor's real parameter/fragment preparation.
      const sqliteSql = sql.replace(/INCLUDE PERFETTO MODULE [^;]+;/g, '').trim();
      if (!sqliteSql) return { columns: [], rows: [] };
      const statement = db.prepare(sqliteSql);
      return { columns: statement.columns().map(column => column.name), rows: statement.raw().all() };
    } });
    const skillsDir = path.resolve(__dirname, '../../../../skills');
    const file = path.join(skillsDir, 'atomic/app_frame_production.skill.yaml');
    const definition = normalizeSkillDefinition(yaml.load(fs.readFileSync(file, 'utf8')), file)!;
    executor.registerSkills([definition, {
      ...resolverSkill,
      sql: `SELECT 1 AS rank, 100 AS confidence_score, 'confirmed' AS identity_status,
        upid, pid, name AS process_name, name AS recommended_process_name_param,
        'upid' AS target_match_sources, 'ok' AS identity_warning
        FROM process WHERE upid = \${upid}`,
    }]);
    executor.setFragmentRegistry(new Map([['fragments/effective_target_processes.sql',
      fs.readFileSync(path.join(skillsDir, 'fragments/effective_target_processes.sql'), 'utf8')]]));
    return { db, executor };
  };

  it('counts a late first actual frame using automatic expected-clock bounds and exact UPID', async () => {
    const { db, executor } = createFixture();
    try {
      const result = await executor.execute('app_frame_production', 'trace', { upid: 42 });
      expect(result.success).toBe(true);
      expect(result.rawResults?.app_production_stats.data).toEqual([expect.objectContaining({
        total_produced_frames: 1, duration_ms: 10, janky_frames: 1, on_time_frames: 0,
        app_jank_rate: 100, avg_frame_dur_ms: 15, max_frame_dur_ms: 15,
      })]);
    } finally { db.close(); }
  });

  it.each([
    { start_ts: 100_000_000, end_ts: 104_000_000, count: 1 },
    { start_ts: 104_000_000, end_ts: 120_000_000, count: 0 },
  ])('uses expected starts for explicit windows: %j', async ({ start_ts, end_ts, count }) => {
    const { db, executor } = createFixture();
    try {
      const result = await executor.execute('app_frame_production', 'trace', { upid: 42, start_ts, end_ts });
      expect(result.success).toBe(true);
      expect(result.rawResults?.app_production_stats.data[0].total_produced_frames).toBe(count);
    } finally { db.close(); }
  });

  it('returns zero frames when the exact process has no matching frame evidence', async () => {
    const { db, executor } = createFixture();
    try {
      db.exec('DELETE FROM actual_frame_timeline_slice WHERE upid = 42');
      const result = await executor.execute('app_frame_production', 'trace', { upid: 42 });
      expect(result.success).toBe(true);
      expect(result.rawResults?.app_production_stats.data[0]).toMatchObject({
        total_produced_frames: 0, janky_frames: 0, on_time_frames: 0,
      });
    } finally { db.close(); }
  });
});
