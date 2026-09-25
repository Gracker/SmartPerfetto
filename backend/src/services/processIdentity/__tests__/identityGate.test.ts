// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import fs from 'fs';
import path from 'path';
import yaml from 'js-yaml';
import { IdentityGate, collectSkillSqlUnits, getEffectiveIdentityConfig, sqlUsesProcessNameFilter } from '../identityGate';
import { normalizeSkillDefinition } from '../../skillEngine/skillLoader';
import type { SkillDefinition } from '../../skillEngine/types';
import type { ProcessIdentityResolution } from '../types';
import {assertEffectiveProcessScope, verifiedIdentityForScope} from '../effectiveProcessScope';

function skill(overrides: Partial<SkillDefinition> & Record<string, any>): SkillDefinition {
  return {
    name: 'test_skill',
    version: '1.0',
    type: 'atomic',
    meta: { display_name: 'Test', description: 'Test' },
    ...overrides,
  } as SkillDefinition;
}

function verified(overrides: Partial<ProcessIdentityResolution> = {}): ProcessIdentityResolution {
  return {
    status: 'verified',
    requestedName: 'com.example',
    canonicalPackageName: 'com.example',
    recommendedProcessNameParam: 'com.real.process',
    upids: [42],
    confidenceScore: 90,
    rawStatus: 'confirmed',
    evidenceSources: ['android_process_metadata.package_name'],
    warnings: [],
    candidates: [],
    ...overrides,
  };
}

describe('IdentityGate', () => {
  it.each(['none', 'exempt', 'verify_if_present'] as const)(
    'issues an unscoped authority for an allowed %s invocation without resolving a target', async policy => {
      const params = {};
      const inherited = {context: 'kept'};
      const resolve = jest.fn(async () => verified());
      const result = await new IdentityGate().apply({traceId: 'trace', traceSide: 'reference',
        skill: skill({identity: {policy}}), params, inherited, resolve});
      expect(result.allowed).toBe(true);
      expect(result.params).toBe(params);
      expect(result.inherited).toBe(inherited);
      expect(result.processScope).toMatchObject({mode: 'unscoped', traceId: 'trace', traceSide: 'reference'});
      expect(result.processScope?.upid).toBeUndefined();
      expect(() => assertEffectiveProcessScope(result.processScope!, 'trace', 'reference')).not.toThrow();
      expect(verifiedIdentityForScope(result.processScope!)).toBeUndefined();
      expect(resolve).not.toHaveBeenCalled();
    },
  );

  it('issues unscoped metadata authority for the resolver without resolving itself', async () => {
    const resolve = jest.fn(async () => verified());
    const result = await new IdentityGate().apply({traceId: 'trace',
      skill: skill({name: 'process_identity_resolver'}), params: {upid: 42}, resolve});
    expect(result.allowed).toBe(true);
    expect(result.processScope?.mode).toBe('unscoped');
    expect(() => assertEffectiveProcessScope(result.processScope!, 'trace', 'current')).not.toThrow();
    expect(resolve).not.toHaveBeenCalled();
  });

  it('detects common process identity filter SQL shapes', () => {
    expect(sqlUsesProcessNameFilter("SELECT * FROM process proc WHERE proc.name IN ('com.example')")).toBe(true);
    expect(sqlUsesProcessNameFilter("SELECT * FROM process WHERE name = 'surfaceflinger'")).toBe(true);
    expect(sqlUsesProcessNameFilter("SELECT * FROM android_binder_txns WHERE client_process GLOB 'com.example*'")).toBe(true);
    expect(sqlUsesProcessNameFilter("SELECT * FROM thread_slice s WHERE s.process_name NOT GLOB 'com.android*'")).toBe(true);
  });

  it('reads the fragments a step declares, including exact_sql, and skips label-only fragments', () => {
    const fragments: Record<string, string> = {
      'fragments/filter.sql': "target AS (SELECT upid FROM process WHERE name = '${process_name}')",
      'fragments/labels.sql': "-- process-identity: label-only\nlabels AS (SELECT CASE WHEN p.name = '${package}' THEN 'target' END FROM process p)",
    };
    const resolve = (fragmentPath: string) => fragments[fragmentPath];
    const collectSkillSql = (definition: SkillDefinition, resolver: (fragmentPath: string) => string | undefined) =>
      collectSkillSqlUnits(definition, resolver).join('\n');
    const skill = (step: Record<string, unknown>) => ({name: 'fragment_skill', steps: [{id: 's', ...step}]}) as unknown as SkillDefinition;

    expect(sqlUsesProcessNameFilter(collectSkillSql(skill({sql: 'SELECT 1', sql_fragments: ['fragments/filter.sql']}), resolve))).toBe(true);
    expect(sqlUsesProcessNameFilter(collectSkillSql(skill({sql: 'SELECT 1', exact_sql: {sql: 'SELECT 1',
      sql_fragments: ['fragments/filter.sql']}}), resolve))).toBe(true);
    expect(sqlUsesProcessNameFilter(collectSkillSql(skill({sql: 'SELECT 1', sql_fragments: ['fragments/labels.sql']}), resolve))).toBe(false);
    expect(sqlUsesProcessNameFilter(collectSkillSql(skill({sql: 'SELECT 1', sql_fragments: ['fragments/missing.sql']}), resolve))).toBe(false);
  });

  it('pins the Skills whose identity policy moved when detection became per statement with fragments', () => {
    // Before, detection read only step SQL, concatenated across steps. Fragment
    // filters were missed (these Skills ran with policy none), and a process
    // read in one step plus a bare name comparison in another counted as a
    // filter. Both lists are pinned so any further change is reviewed.
    const walk = (dir: string): string[] => fs.readdirSync(dir, {withFileTypes: true}).flatMap(entry =>
      entry.isDirectory() ? (entry.name === '_template' ? [] : walk(path.join(dir, entry.name)))
        : entry.name.endsWith('.skill.yaml') ? [path.join(dir, entry.name)] : []);
    const gained: string[] = [];
    const lost: string[] = [];
    for (const file of walk(path.join(process.cwd(), 'skills'))) {
      let skill: SkillDefinition | null = null;
      try {
        skill = normalizeSkillDefinition(yaml.load(fs.readFileSync(file, 'utf8')), file);
      } catch {
        continue; // comment-only or template files are not Skills
      }
      if (!skill?.name || skill.identity?.policy) continue;
      const before = sqlUsesProcessNameFilter(collectSkillSqlUnits(skill, () => undefined).join('\n'));
      const after = getEffectiveIdentityConfig(skill).policy === 'verify_if_present';
      if (after && !before) gained.push(skill.name);
      if (before && !after) lost.push(skill.name);
    }
    expect(gained.sort()).toEqual([
      'android_bitmap_memory_per_process',
      'android_heap_dominator_path_extract',
      'android_heap_graph_class_growth',
      'android_heap_graph_leak_candidates',
      'android_heap_graph_summary',
      'android_memory_v57_ai_diagnostics',
      'android_process_state_residency',
      'flutter_scrolling_analysis',
    ]);
    // Its own SQL never filters by process; package only reaches child Skills,
    // which verify it themselves.
    expect(lost).toEqual(['scroll_session_analysis']);
  });

  it('does not treat thread/slice/counter name filters as process identity filters', () => {
    expect(sqlUsesProcessNameFilter("SELECT * FROM slice WHERE name GLOB '*binder*'")).toBe(false);
    expect(sqlUsesProcessNameFilter("SELECT * FROM thread t WHERE t.name = 'RenderThread'")).toBe(false);
    expect(sqlUsesProcessNameFilter("SELECT * FROM slice s JOIN thread t USING(utid) JOIN process p USING(upid) WHERE s.name GLOB '*binder*'")).toBe(false);
    expect(sqlUsesProcessNameFilter("SELECT * FROM counter_track cct WHERE cct.name = 'cpufreq'")).toBe(false);
  });

  it('infers verify_if_present for skills that filter by process.name', () => {
    const config = getEffectiveIdentityConfig(skill({
      sql: "SELECT * FROM process p WHERE p.name GLOB '${package}*'",
    }));

    expect(config.policy).toBe('verify_if_present');
  });

  it('always exempts process_identity_resolver even if YAML metadata is wrong', () => {
    const config = getEffectiveIdentityConfig(skill({
      name: 'process_identity_resolver',
      identity: { policy: 'required', scope: 'process' },
    }));

    expect(config.policy).toBe('exempt');
  });

  it('does not let inherited variables bypass identity gate for normal skills', async () => {
    const gate = new IdentityGate();
    const result = await gate.apply({
      traceId: 'trace',
      skill: skill({
        identity: { policy: 'required', scope: 'process' },
      }),
      params: {},
      inherited: { __skipIdentityGate: true },
      resolve: async () => verified(),
    });

    expect(result.allowed).toBe(false);
    expect(result.error).toContain('no package/process/upid target');
  });

  it('rewrites process aliases after verified identity resolution', async () => {
    const gate = new IdentityGate();
    const result = await gate.apply({
      traceId: 'trace',
      skill: skill({
        identity: {
          policy: 'required',
          scope: 'process',
          aliases: ['package', 'process_name'],
          rewriteTo: 'recommended_process_name_param',
        },
      }),
      params: { package: 'com.example', process_name: 'com.example' },
      resolve: async () => verified(),
    });

    expect(result.allowed).toBe(true);
    expect(result.params.package).toBe('com.real.process');
    expect(result.params.process_name).toBe('com.real.process');
    expect(result.inherited.identity_resolution?.canonicalPackageName).toBe('com.example');
  });

  it('uses UPID for identity verification without leaking it into undeclared Skill inputs', async () => {
    const gate = new IdentityGate();
    const targetSkill = skill({
      identity: {
        policy: 'required',
        scope: 'process',
        aliases: ['process_name'],
        rewriteTo: 'recommended_process_name_param',
      },
      inputs: [{name: 'process_name', type: 'string', required: true}],
    });
    const result = await gate.apply({
      traceId: 'trace',
      skill: targetSkill,
      params: {process_name: 'com.real.process', upid: 42},
      resolve: async target => {
        expect(target).toEqual(expect.objectContaining({
          requestedName: 'com.real.process',
          upid: 42,
        }));
        return verified();
      },
    });

    expect(result.allowed).toBe(true);
    expect(result.params).toEqual({process_name: 'com.real.process'});
  });

  it('blocks required process skills when no target identity is provided', async () => {
    const gate = new IdentityGate();
    const result = await gate.apply({
      traceId: 'trace',
      skill: skill({
        identity: { policy: 'required', scope: 'process' },
      }),
      params: {},
      resolve: async () => verified(),
    });

    expect(result.allowed).toBe(false);
    expect(result.error).toMatch(/no package\/process\/upid target/);
  });

  it('blocks process-filtered skills when a provided target is ambiguous', async () => {
    const gate = new IdentityGate();
    const result = await gate.apply({
      traceId: 'trace',
      skill: skill({
        sql: "SELECT * FROM process p WHERE p.name GLOB '${package}*'",
      }),
      params: { package: 'com.example' },
      resolve: async () => verified({ status: 'ambiguous', confidenceScore: 30, rawStatus: 'weak_match' }),
    });

    expect(result.allowed).toBe(false);
    expect(result.error).toContain('could not be verified');
  });

  it('fails open for inferred overview skills only when resolver execution itself fails', async () => {
    const gate = new IdentityGate();
    const params = {package: 'com.example'};
    const resolution = verified({status: 'unresolved', upids: [], candidates: [], confidenceScore: 0,
      resolverError: 'module unavailable', warnings: ['original unresolved warning']});
    const result = await gate.apply({
      traceId: 'trace',
      skill: skill({
        sql: "SELECT * FROM process p WHERE p.name GLOB '${package}*'",
      }),
      params,
      resolve: async () => resolution,
    });

    expect(result.allowed).toBe(true);
    expect(result.params).toBe(params);
    expect(result.resolution).toBe(resolution);
    expect(result.inherited.identity_resolution).toBe(resolution);
    expect(result.inherited.identity_gate_warning).toContain('resolver failed');
    expect(result.processScope).toMatchObject({mode: 'named', requestedName: params.package});
    expect(result.processScope?.upid).toBeUndefined();
    expect(() => assertEffectiveProcessScope(result.processScope!, 'trace', 'current')).not.toThrow();
    expect(verifiedIdentityForScope(result.processScope!)?.resolution).toEqual(resolution);

    for (const selector of [{upid: 42}, {pid: 4242}]) {
      const refused = await gate.apply({traceId: 'trace', skill: skill({identity: {policy: 'verify_if_present'}}),
        params: {...params, ...selector}, resolve: async () => resolution});
      expect(refused.allowed).toBe(false);
      expect(refused.processScope).toBeUndefined();
    }
  });

  it('retries a transient named resolver failure for a required child and reuses only the recovered identity', async () => {
    const gate = new IdentityGate();
    const params = {package: 'com.example'};
    const failed = verified({status: 'unresolved', upids: [], candidates: [], confidenceScore: 0,
      resolverError: 'temporarily unavailable', warnings: ['original warning']});
    const overview = await gate.apply({traceId: 'trace', skill: skill({identity: {policy: 'verify_if_present'}}),
      params, resolve: async () => failed});
    expect(overview.allowed).toBe(true);
    expect(overview.inherited.identity_gate_warning).toContain('temporarily unavailable');
    const recover = jest.fn(async () => verified());
    const child = await gate.apply({traceId: 'trace', skill: skill({identity: {policy: 'required'}}),
      params, inherited: overview.inherited, processScope: overview.processScope, resolve: recover});
    expect(recover).toHaveBeenCalledTimes(1);
    expect(child.allowed).toBe(true);
    expect(child.resolution?.status).toBe('verified');
    expect(child.processScope).not.toBe(overview.processScope);
    expect(verifiedIdentityForScope(overview.processScope!)?.resolution).toEqual(failed);
    expect(overview.inherited.identity_gate_warning).toContain('temporarily unavailable');
    const reuse = jest.fn(async () => verified());
    const next = await gate.apply({traceId: 'trace', skill: skill({identity: {policy: 'required'}}),
      params, processScope: child.processScope, resolve: reuse});
    expect(next.allowed).toBe(true);
    expect(next.processScope).toBe(child.processScope);
    expect(reuse).not.toHaveBeenCalled();
  });
});

describe('sqlUsesProcessNameFilter operator boundaries', () => {
  // The gate decides both the raw-SQL identity warning and Skill identity
  // admission. It previously required whitespace before the operator, so the
  // idiomatic `p.name='com.foo'` scoped a query to a process while looking
  // unscoped — quick mode writes raw SQL freely, so this was reachable.
  it.each([
    ["SELECT * FROM slice JOIN process p USING(upid) WHERE p.name='com.a'", 'alias, no space'],
    ["SELECT * FROM slice JOIN process p USING(upid) WHERE p.name!='com.a'", 'alias, !='],
    ["SELECT * FROM slice JOIN process p USING(upid) WHERE p.name<>'com.a'", 'alias, <>'],
    ["SELECT * FROM process WHERE name='com.a'", 'bare name, no space'],
    ["SELECT * FROM v WHERE process_name='com.a'", 'process_name, no space'],
    ["SELECT * FROM v WHERE package_name='com.a'", 'package_name, no space'],
    ["WITH t AS (SELECT upid FROM process WHERE name='com.a') SELECT * FROM slice JOIN t USING(upid)", 'CTE'],
  ])('detects a process filter written without whitespace (%s)', sql => {
    expect(sqlUsesProcessNameFilter(sql)).toBe(true);
  });

  it.each([
    ["SELECT * FROM process p WHERE p.name GLOB 'com.a*'", 'GLOB'],
    ["SELECT * FROM process p WHERE p.name NOT LIKE '%a%'", 'NOT LIKE'],
    ["SELECT * FROM process p WHERE p.name IN ('a','b')", 'IN'],
  ])('still detects word operators, which do need whitespace (%s)', sql => {
    expect(sqlUsesProcessNameFilter(sql)).toBe(true);
  });

  it.each([
    ['SELECT * FROM thread_slice WHERE upid = 1008', 'upid only'],
    ['SELECT * FROM slice WHERE dur > 1000', 'no identity column'],
    ["SELECT * FROM slice s WHERE s.name='doFrame'", 'slice name is not a process name'],
    ['SELECT nameGLOBAL FROM t WHERE nameGLOBAL > 1', 'identifier that merely starts with an operator'],
  ])('does not treat unrelated comparisons as process scoping (%s)', sql => {
    expect(sqlUsesProcessNameFilter(sql)).toBe(false);
  });
});

describe('IdentityGate exact process scope', () => {
  const targetSkill = skill({
    identity: { policy: 'verify_if_present' },
    inputs: [{ name: 'package', type: 'string', required: false, default: 'com.default' }],
  });
  const exact = () => verified({
    recommendedProcessNameParam: 'com.example',
    candidates: [{ rank: 1, confidenceScore: 100, upid: 42, pid: 4242,
      processName: 'com.example', canonicalPackageName: 'com.example' }],
  });

  it('binds a verified singleton PID to exact UPID instead of broadening to its process name', async () => {
    const resolve = jest.fn(async () => exact());
    const result = await new IdentityGate().apply({traceId: 'trace', skill: targetSkill,
      params: {pid: 4242}, inherited: {package: 'com.default'}, resolve});
    expect(resolve).toHaveBeenCalledWith({pid: 4242});
    expect(result.allowed).toBe(true);
    expect(result.processScope).toMatchObject({mode: 'exact_upid', upid: 42});
    expect(result.params).not.toHaveProperty('pid');
  });

  it.each([
    {upids: [42, 43], candidates: [
      {rank: 1, confidenceScore: 100, pid: 4242, upid: 42},
      {rank: 2, confidenceScore: 100, pid: 4242, upid: 43},
    ]},
    {upids: [42], candidates: [{rank: 1, confidenceScore: 100, pid: 9999, upid: 42}]},
  ])('rejects reused or mismatched PID resolution: %j', async resolution => {
    const result = await new IdentityGate().apply({traceId: 'trace', skill: targetSkill,
      params: {pid: 4242}, resolve: async () => verified(resolution)});
    expect(result.allowed).toBe(false);
    expect(result.processScope).toBeUndefined();
  });

  it('does not consume an undeclared thread filter merely to disambiguate its process', async () => {
    const resolve = jest.fn(async () => exact());
    const result = await new IdentityGate().apply({traceId: 'trace', skill: targetSkill,
      params: {upid: 42, thread_name: 'RenderThread'}, resolve});
    expect(result.allowed).toBe(false);
    expect(resolve).not.toHaveBeenCalled();
  });

  it.each([
    { upid: 0 }, { upid: '0' }, { upid: 0, package: 'com.example' },
    { pid: 0 }, { pid: '0' }, { pid: 0, package: 'com.example' },
    { upid: 42, pid: 0 },
  ])('rejects explicit zero selectors before resolution: %j', async params => {
    const resolve = jest.fn(async () => exact());
    const result = await new IdentityGate().apply({
      traceId: 'trace', skill: targetSkill, params,
      inherited: { package: 'com.default' }, resolve,
    });
    expect(result.allowed).toBe(false);
    expect(result.error).toContain('expected a positive safe integer');
    expect(result.processScope).toBeUndefined();
    expect(resolve).not.toHaveBeenCalled();
  });

  it('keeps omitted selectors separate from SQL input defaults', async () => {
    const resolve = jest.fn(async () => exact());
    const result = await new IdentityGate().apply({
      traceId: 'trace', skill: { ...targetSkill, inputs: [
        { name: 'upid', type: 'integer', required: false, default: 0 },
        { name: 'pid', type: 'integer', required: false, default: 0 },
      ] }, params: {}, resolve,
    });
    expect(result.allowed).toBe(true);
    expect(result.processScope).toMatchObject({mode: 'unscoped', traceId: 'trace', traceSide: 'current'});
    expect(result.processScope?.upid).toBeUndefined();
    expect(() => assertEffectiveProcessScope(result.processScope!, 'trace', 'current')).not.toThrow();
    expect(resolve).not.toHaveBeenCalled();
  });

  it('reuses prepared exact identity across enriched intervals while still checking conflicts', async () => {
    const gate = new IdentityGate();
    const resolve = jest.fn(async () => exact());
    const prepared = await gate.apply({ traceId: 'trace', skill: targetSkill, params: { upid: 42 }, resolve });
    const enriched = await gate.apply({ traceId: 'trace', skill: targetSkill,
      params: { package: 'com.example', start_ts: 100, end_ts: 200 }, processScope: prepared.processScope, resolve });
    expect(enriched.allowed).toBe(true);
    expect(enriched.processScope).toBe(prepared.processScope);
    const conflicting = await gate.apply({ traceId: 'trace', skill: targetSkill,
      params: { pid: 9000 }, processScope: prepared.processScope, resolve });
    expect(conflicting.allowed).toBe(false);
    expect(resolve).toHaveBeenCalledTimes(1);
  });

  it('verifies named-to-UPID narrowing and refuses a different package', async () => {
    const gate = new IdentityGate();
    const prepared = await gate.apply({ traceId: 'trace', skill: targetSkill,
      params: { package: 'com.example' }, resolve: async () => exact() });
    for (const [name, allowed] of [['com.example:child', true], ['com.other', false]] as const) {
      const resolve = jest.fn(async () => verified({ upids: [43], recommendedProcessNameParam: name,
        canonicalPackageName: name === 'com.other' ? name : 'com.example',
        candidates: [{ rank: 1, confidenceScore: 100, upid: 43, processName: name }] }));
      const result = await gate.apply({ traceId: 'trace', skill: targetSkill, params: { upid: 43 },
        processScope: prepared.processScope, resolve });
      expect(result.allowed).toBe(allowed);
      expect(resolve).toHaveBeenCalledTimes(1);
      if (allowed) expect(result.processScope).toMatchObject({ mode: 'exact_upid', upid: 43 });
    }
  });

  it('keeps an explicit UPID independent of an inherited/default package', async () => {
    const resolve = jest.fn(async () => exact());
    const result = await new IdentityGate().apply({
      traceId: 'trace', skill: targetSkill, params: { upid: 42 },
      inherited: { package: 'com.default' }, resolve,
    });
    expect(resolve).toHaveBeenCalledWith({ upid: 42 });
    expect(result.params).toEqual({ package: 'com.example' });
    expect(result.processScope).toMatchObject({ mode: 'exact_upid', traceId: 'trace', upid: 42 });
    expect(Object.isFrozen(result.processScope)).toBe(true);
  });

  it.each([
    { upid: 42, package: 'com.other' },
    { upid: 42, pid: 9000 },
    { upid: 42, package: 'com.example', process_name: 'com.other' },
  ])('rejects conflicting explicit selectors: %j', async params => {
    const result = await new IdentityGate().apply({
      traceId: 'trace', skill: targetSkill, params, resolve: async () => exact(),
    });
    expect(result.allowed).toBe(false);
    expect(result.error).toContain('conflicts');
    expect(result.resolution?.status).toBe('ambiguous');
  });

  it('never converts resolver candidates or a different UPID into selected scope', async () => {
    for (const upids of [[43], [42, 43], []]) {
      const result = await new IdentityGate().apply({
        traceId: 'trace', skill: targetSkill, params: { upid: 42 },
        resolve: async () => ({ ...exact(), upids }),
      });
      expect(result.allowed).toBe(false);
      expect(result.processScope).toBeUndefined();
    }
  });

  it('does not fail open on an exact selector when the resolver fails', async () => {
    const result = await new IdentityGate().apply({
      traceId: 'trace', skill: targetSkill, params: { upid: 42 },
      resolve: async () => verified({ status: 'unresolved', upids: [], resolverError: 'unavailable' }),
    });
    expect(result.allowed).toBe(false);
  });

  it('preserves inherited exact scope under none/exempt and refuses trace changes or forged scopes', async () => {
    const gate = new IdentityGate();
    const first = await gate.apply({ traceId: 'trace', skill: targetSkill, params: { upid: 42 }, resolve: async () => exact() });
    for (const policy of ['none', 'exempt'] as const) {
      const result = await gate.apply({ traceId: 'trace', skill: skill({ identity: { policy } }), params: {},
        processScope: first.processScope, resolve: async () => exact() });
      expect(result.processScope).toBe(first.processScope);
      expect(result.allowed).toBe(true);
    }
    for (const input of [
      { traceId: 'other', processScope: first.processScope },
      { traceId: 'trace', traceSide: 'reference' as const, processScope: first.processScope },
      { traceId: 'trace', processScope: { ...first.processScope! } },
    ]) {
      const result = await gate.apply({ ...input, skill: targetSkill, params: {}, resolve: async () => exact() });
      expect(result.allowed).toBe(false);
      expect(result.error).toContain('untrusted or belongs to a different trace/side');
    }
  });
});
