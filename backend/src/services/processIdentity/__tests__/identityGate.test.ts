// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import { IdentityGate, getEffectiveIdentityConfig, sqlUsesProcessNameFilter } from '../identityGate';
import type { SkillDefinition } from '../../skillEngine/types';
import type { ProcessIdentityResolution } from '../types';

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
  it('detects common process identity filter SQL shapes', () => {
    expect(sqlUsesProcessNameFilter("SELECT * FROM process proc WHERE proc.name IN ('com.example')")).toBe(true);
    expect(sqlUsesProcessNameFilter("SELECT * FROM process WHERE name = 'surfaceflinger'")).toBe(true);
    expect(sqlUsesProcessNameFilter("SELECT * FROM android_binder_txns WHERE client_process GLOB 'com.example*'")).toBe(true);
    expect(sqlUsesProcessNameFilter("SELECT * FROM thread_slice s WHERE s.process_name NOT GLOB 'com.android*'")).toBe(true);
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
      params: {process_name: 'com.example', upid: 42},
      resolve: async target => {
        expect(target).toEqual(expect.objectContaining({
          requestedName: 'com.example',
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
    const result = await gate.apply({
      traceId: 'trace',
      skill: skill({
        sql: "SELECT * FROM process p WHERE p.name GLOB '${package}*'",
      }),
      params: { package: 'com.example' },
      resolve: async () => verified({ status: 'unresolved', confidenceScore: 0, resolverError: 'module unavailable' }),
    });

    expect(result.allowed).toBe(true);
    expect(result.inherited.identity_gate_warning).toContain('resolver failed');
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
