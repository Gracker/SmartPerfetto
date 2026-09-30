// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

// Shared, non-suite fixture: every runtime builds its tools with
// createClaudeMcpServer, so each runtime suite runs these invoke_skill
// scenarios through the real factory with the options that runtime itself
// passed. The vendor hint is best effort in every runtime: it appears only
// when metadata resolution finishes inside VENDOR_HINT_WAIT_MS.

import {expect} from '@jest/globals';
import type {ClaudeMcpServerOptions, createClaudeMcpServer} from '../../agentv3/claudeMcpServer';
import {ArtifactStore} from '../../agentv3/artifactStore';
import {buildStrategyRegistrySnapshotFromDefinitions, getRegisteredScenes} from '../../agentv3/strategyLoader';
import type {VendorOverride} from '../../services/skillEngine/skillLoader';
import type {SkillDefinition} from '../../services/skillEngine/types';
import {
  withEffectiveRuntimeRegistrySnapshot,
  type EffectiveRuntimeRegistrySnapshot,
  type ReadonlySkillRegistrySnapshot,
} from '../../services/selfEvolution/effectiveRuntimeRegistryContext';
import {
  clearTraceVendorCacheForTests,
  TRACE_VENDOR_METADATA_SQL,
} from '../../services/traceVendor/traceVendorResolver';
import {
  vendorQueryServiceDouble,
  XIAOMI_METADATA,
} from '../../services/traceVendor/__tests__/traceVendorFixture';
import {extractFirstJsonValue} from '../../utils/llmJson';

type CreateClaudeMcpServer = typeof createClaudeMcpServer;

const VENDOR_HINT_SKILL_WITH_OVERRIDES = 'startup_analysis';
const VENDOR_HINT_SKILL_WITHOUT_OVERRIDES = 'scrolling_analysis';

const XIAOMI_VENDOR_HINT = {
  vendor: 'xiaomi',
  displayName: '小米 MIUI 启动分析',
  additionalStepIds: ['miui_boost_events'],
};

function override(vendor: string, displayName: string, stepId: string): VendorOverride {
  return {
    vendor, extends: VENDOR_HINT_SKILL_WITH_OVERRIDES, displayName,
    detection: {signatures: [{pattern: '*', confidence: 'low'}]},
    additionalSteps: [{id: stepId, name: stepId, sql: 'SELECT 1'}],
  } as VendorOverride;
}

const OVERRIDES: Record<string, VendorOverride[]> = {
  [VENDOR_HINT_SKILL_WITH_OVERRIDES]: [
    // SoC override listed first: the hint must follow the resolver's OEM-first order.
    override('qualcomm', '高通平台启动分析', 'qcom_perf_lock'),
    override('xiaomi', XIAOMI_VENDOR_HINT.displayName, XIAOMI_VENDOR_HINT.additionalStepIds[0]),
  ],
};

function skill(name: string): SkillDefinition {
  return {
    name, version: '1', type: 'composite',
    meta: {display_name: name, description: name},
    identity: {policy: 'verify_if_present', scope: 'process'},
  } as unknown as SkillDefinition;
}

function registrySnapshot(): EffectiveRuntimeRegistrySnapshot {
  const skills = [skill(VENDOR_HINT_SKILL_WITH_OVERRIDES), skill(VENDOR_HINT_SKILL_WITHOUT_OVERRIDES)];
  const byId = new Map(skills.map(entry => [entry.name, entry]));
  const skillRegistry: ReadonlySkillRegistrySnapshot = {
    registryFingerprint: 'vendor-hint-fixture',
    overlayGeneration: 'vendor-hint-fixture',
    isInitialized: () => true,
    getSkill: name => byId.get(name),
    getAllSkills: () => [...skills],
    getFragmentCache: () => new Map(),
    getSkillOrigin: () => ({origin: 'built_in'} as never),
    getAppliedOverlayIds: () => [],
    getVendorOverride: (skillId, vendor) =>
      OVERRIDES[skillId]?.find(entry => entry.vendor.toLowerCase() === vendor.toLowerCase()),
    getVendorOverridesForSkill: skillId => OVERRIDES[skillId] ?? [],
    hasVendorOverrides: skillId => (OVERRIDES[skillId]?.length ?? 0) > 0,
    getVendorOverrideLoadIssues: () => [],
    findMatchingSkill: () => undefined,
  };
  const strategyRegistry = buildStrategyRegistrySnapshotFromDefinitions({
    definitions: getRegisteredScenes(), overlayGeneration: 'vendor-hint-fixture'});
  return {
    scope: {tenantId: 'vendor-hint-fixture', workspaceId: 'vendor-hint-fixture'},
    baseSkillRegistryFingerprint: 'vendor-hint-fixture',
    baseStrategyRegistryFingerprint: strategyRegistry.registryFingerprint,
    overlayGeneration: 'vendor-hint-fixture',
    skillRegistry,
    strategyRegistry,
    skillNotes: {registryFingerprint: 'vendor-hint-fixture', getSkillNotes: () => [], getSkillIds: () => []},
  };
}

/** Invoke results carry guidance prose around the JSON body. */
function parseInvokeSkillResult(value: unknown): Record<string, unknown> {
  const text = (value as {content?: Array<{type?: string; text?: string}>})?.content
    ?.find(item => item.type === 'text')?.text ?? '';
  return JSON.parse(extractFirstJsonValue(text) ?? 'null');
}

type MetadataMode = 'resolve' | 'hang' | 'abort_during_wait';

interface VendorHintScenarioResult {
  result: Record<string, unknown>;
  /** Ordered trace processor activity: the Skill's own query, then any metadata query. */
  queryLog: Array<'skill' | 'metadata'>;
  unhandledRejections: unknown[];
}

async function runScenario(input: {
  createMcpServer: CreateClaudeMcpServer;
  runtimeOptions: Partial<ClaudeMcpServerOptions>;
  skillId: string;
  metadata: MetadataMode;
}): Promise<VendorHintScenarioResult> {
  clearTraceVendorCacheForTests();
  const queryLog: Array<'skill' | 'metadata'> = [];
  const controller = new AbortController();
  const traceProcessorService = vendorQueryServiceDouble(async (_traceId: string, sql: string) => {
    if (sql !== TRACE_VENDOR_METADATA_SQL) {
      queryLog.push('skill');
      return {columns: ['a'], rows: [[1]], durationMs: 1};
    }
    queryLog.push('metadata');
    if (input.metadata === 'hang') return new Promise(() => undefined);
    if (input.metadata === 'abort_during_wait') {
      setTimeout(() => controller.abort(), 0);
      return new Promise(() => undefined);
    }
    return XIAOMI_METADATA;
  }, {id: 'vendor-hint-trace', filePath: '/tmp/vendor-hint.pftrace', size: 1, traceOs: 'android'});
  const skillExecutor = {
    prepareInvocation: async (_skillId: string, _traceId: string, params: Record<string, unknown> = {}) =>
      ({allowed: true, params, config: {policy: 'none'}}),
    // The Skill's own queries finish before execute() returns.
    execute: async (skillId: string, traceId: string) => {
      await traceProcessorService.query(traceId, 'SELECT skill_step');
      return {
        skillId, success: true,
        displayResults: [{stepId: 'result', title: 'Result', layer: 'list', format: 'table',
          data: {columns: ['a'], rows: [[1]]}}],
        diagnostics: [], executionTimeMs: 1,
      };
    },
    replaceRegisteredSkills: () => undefined,
    registerSkills: () => undefined,
    registerSkill: () => undefined,
    setFragmentRegistry: () => undefined,
    setRunManifestAttributionSink: () => undefined,
  };
  const {
    traceProcessorService: _runtimeService, skillExecutor: _runtimeExecutor, runManifestAttributionSink: _sink,
    strategyRegistry: _strategies, sceneRunContext: _scene, canInvokeTool: _canInvoke, toolObserver: _observer,
    ...runtimeOptions
  } = input.runtimeOptions as Record<string, unknown>;
  const unhandledRejections: unknown[] = [];
  const onUnhandled = (reason: unknown) => unhandledRejections.push(reason);
  process.on('unhandledRejection', onUnhandled);
  try {
    const mcp = withEffectiveRuntimeRegistrySnapshot(registrySnapshot(), () => input.createMcpServer({
      analysisNotes: [], hypotheses: [], uncertaintyFlags: [], watchdogWarning: {current: null},
      ...runtimeOptions,
      // A fresh store per scenario keeps artifact ids comparable; a runtime
      // that runs without artifact mode stays without it.
      artifactStore: 'artifactStore' in runtimeOptions && !runtimeOptions.artifactStore
        ? undefined : new ArtifactStore(),
      traceId: 'vendor-hint-trace',
      userQuery: 'Analyze startup',
      traceProcessorService,
      skillExecutor,
    } as unknown as ClaudeMcpServerOptions));
    const definition = mcp.toolDefinitions.find(candidate => candidate.name === 'invoke_skill');
    if (!definition) throw new Error('invoke_skill is not registered');
    const raw = await definition.shared.handler({skillId: input.skillId}, {signal: controller.signal});
    await new Promise(resolve => setImmediate(resolve));
    return {result: parseInvokeSkillResult(raw), queryLog, unhandledRejections};
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
}

/**
 * Run the four invoke_skill vendor-hint scenarios through the real MCP factory
 * and assert the behaviour every runtime shares. `runtimeOptions` are the
 * options the runtime under test passed to createClaudeMcpServer; the trace
 * processor, executor and registry are replaced by fixture doubles.
 */
export async function expectRuntimeVendorHintParity(input: {
  createMcpServer: CreateClaudeMcpServer;
  runtimeOptions?: Partial<ClaudeMcpServerOptions>;
}): Promise<void> {
  const base = {createMcpServer: input.createMcpServer, runtimeOptions: input.runtimeOptions ?? {}};
  const resolved = await runScenario({...base, skillId: VENDOR_HINT_SKILL_WITH_OVERRIDES, metadata: 'resolve'});
  const timedOut = await runScenario({...base, skillId: VENDOR_HINT_SKILL_WITH_OVERRIDES, metadata: 'hang'});
  const aborted = await runScenario({...base, skillId: VENDOR_HINT_SKILL_WITH_OVERRIDES, metadata: 'abort_during_wait'});
  const withoutOverrides = await runScenario({...base, skillId: VENDOR_HINT_SKILL_WITHOUT_OVERRIDES, metadata: 'resolve'});

  expect(resolved.result.success).toBe(true);
  expect(resolved.result.vendorOverride).toEqual(XIAOMI_VENDOR_HINT);
  // The resolver starts only after the Skill's own queries.
  expect(resolved.queryLog).toEqual(['skill', 'metadata']);

  const {vendorOverride: _hint, ...withoutHint} = resolved.result;
  for (const degraded of [timedOut, aborted]) {
    expect(degraded.result.vendorOverride).toBeUndefined();
    expect(degraded.result.success).toBe(true);
    expect(degraded.result).toEqual(withoutHint);
    expect(degraded.queryLog).toEqual(['skill', 'metadata']);
    expect(degraded.unhandledRejections).toEqual([]);
  }

  expect(withoutOverrides.result.success).toBe(true);
  expect(withoutOverrides.result.vendorOverride).toBeUndefined();
  expect(withoutOverrides.queryLog).toEqual(['skill']);
  expect(resolved.unhandledRejections).toEqual([]);
}
