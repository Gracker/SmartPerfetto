// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import fs from 'fs';
import path from 'path';

import type {
  EvalAllowedGapV1,
  EvalCausalEdgeExpectationV1,
  EvalCaseV1,
  EvalForbiddenClaimV1,
  EvalGroundTruthV1,
  EvalScalar,
} from '../../types/selfEvolution';
import {immutableCanonicalSnapshot} from './canonicalJson';
import {parseEvalCase} from './evalContracts';
import {parseEvalGroundTruth} from './goldenTraceScorer';

const DEFAULT_REGISTRY_PATH = path.resolve(
  __dirname,
  '../../../strategies/golden-trace-eval.registry.json',
);
const DEFAULT_CATALOG_PATH = path.resolve(
  __dirname,
  '../../../../Trace/catalog.json',
);
const REPOSITORY_ROOT = path.resolve(__dirname, '../../../..');
const CATALOG_ALIAS_PATTERN = /^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/;

const NUMERIC_SIGNAL_FIELDS = new Map<string, string>([
  ['duration_ns', 'ns'],
  ['value', 'raw'],
  ['rss_anon_kb', 'KiB'],
  ['rss_file_kb', 'KiB'],
  ['swap_kb', 'KiB'],
  ['oom_score_adj', 'raw'],
  ['heap_bytes_allocated', 'bytes'],
  ['sample_count', 'count'],
  ['sample_interval_ns', 'ns'],
  ['kill_reason', 'raw'],
  ['jank_type', 'raw'],
]);

const IDENTITY_SIGNAL_FIELDS = [
  'target_process',
  'name',
  'error_id',
  'subject',
  'layer_name',
  'module_name',
  'function_name',
  'end_state',
] as const;

interface RegistryCaseV1 {
  caseId: string;
  catalogAlias: string;
  query: string;
  analysisMode: 'fast' | 'full';
  expectedScene: string;
  goldenPoints: string[];
  split: EvalCaseV1['split'];
  createdAt: string;
  forbiddenClaims: EvalForbiddenClaimV1[];
  allowedGaps: EvalAllowedGapV1[];
  causalEdges: EvalCausalEdgeExpectationV1[];
}

export interface CompiledGoldenTraceEvalCaseV1 extends EvalCaseV1 {
  catalogAlias: string;
  groundTruth: EvalGroundTruthV1;
}

export interface GoldenTraceRegistryV1 {
  schemaVersion: 1;
  evalSetId: string;
  cases: CompiledGoldenTraceEvalCaseV1[];
}

export type GoldenTraceExecutionCaseV1 = Omit<
  CompiledGoldenTraceEvalCaseV1,
  'catalogAlias' | 'groundTruth' | 'goldenPoints' | 'split'
>;

interface CatalogCase {
  id: string;
  kind: string;
  case_dir: string;
  trace: {sha256: string};
  coverage: {expectations: Array<{id: string}>};
}

function record(value: unknown, error: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(error);
  }
  return value as Record<string, unknown>;
}

function exactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
  error: string,
): void {
  const allowed = new Set(keys);
  if (Object.keys(value).some(key => !allowed.has(key))) throw new Error(error);
}

function nonemptyString(value: unknown, error: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(error);
  return value;
}

function stringArray(value: unknown, error: string): string[] {
  if (!Array.isArray(value) || value.length === 0) throw new Error(error);
  return value.map(item => nonemptyString(item, error));
}

function optionalArray(value: unknown, error: string): unknown[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error(error);
  return value;
}

function parseRegistryCase(value: unknown): RegistryCaseV1 {
  const candidate = record(value, 'golden_trace_registry_case_invalid');
  exactKeys(candidate, [
    'caseId',
    'catalogAlias',
    'query',
    'analysisMode',
    'expectedScene',
    'goldenPoints',
    'split',
    'createdAt',
    'forbiddenClaims',
    'allowedGaps',
    'causalEdges',
  ], 'golden_trace_registry_case_unknown_field');
  const catalogAlias = nonemptyString(
    candidate.catalogAlias,
    'golden_trace_registry_catalog_alias_invalid',
  );
  if (!CATALOG_ALIAS_PATTERN.test(catalogAlias)) {
    throw new Error('golden_trace_registry_catalog_alias_invalid');
  }
  if (candidate.analysisMode !== 'fast' && candidate.analysisMode !== 'full') {
    throw new Error('golden_trace_registry_analysis_mode_invalid');
  }
  if (!['train', 'validation', 'holdout'].includes(String(candidate.split))) {
    throw new Error('golden_trace_registry_split_invalid');
  }
  const createdAt = nonemptyString(
    candidate.createdAt,
    'golden_trace_registry_created_at_invalid',
  );
  if (!Number.isFinite(Date.parse(createdAt))) {
    throw new Error('golden_trace_registry_created_at_invalid');
  }
  const oracle = parseEvalGroundTruth({
    schemaVersion: 1,
    requiredFacts: [],
    numericExpectations: [],
    requiredEvidence: [],
    forbiddenClaims: optionalArray(
      candidate.forbiddenClaims,
      'golden_trace_registry_forbidden_claims_invalid',
    ),
    allowedGaps: optionalArray(
      candidate.allowedGaps,
      'golden_trace_registry_allowed_gaps_invalid',
    ),
    identityExpectations: [],
    causalEdges: optionalArray(
      candidate.causalEdges,
      'golden_trace_registry_causal_edges_invalid',
    ),
  });
  return {
    caseId: nonemptyString(
      candidate.caseId,
      'golden_trace_registry_case_id_invalid',
    ),
    catalogAlias,
    query: nonemptyString(
      candidate.query,
      'golden_trace_registry_query_invalid',
    ),
    analysisMode: candidate.analysisMode,
    expectedScene: nonemptyString(
      candidate.expectedScene,
      'golden_trace_registry_expected_scene_invalid',
    ),
    goldenPoints: stringArray(
      candidate.goldenPoints,
      'golden_trace_registry_golden_points_invalid',
    ),
    split: candidate.split as EvalCaseV1['split'],
    createdAt,
    forbiddenClaims: oracle.forbiddenClaims,
    allowedGaps: oracle.allowedGaps,
    causalEdges: oracle.causalEdges,
  };
}

function parseRegistry(value: unknown): {
  schemaVersion: 1;
  evalSetId: string;
  cases: RegistryCaseV1[];
} {
  const registry = record(value, 'golden_trace_registry_invalid');
  exactKeys(
    registry,
    ['schemaVersion', 'evalSetId', 'cases'],
    'golden_trace_registry_unknown_field',
  );
  if (registry.schemaVersion !== 1 || !Array.isArray(registry.cases)) {
    throw new Error('golden_trace_registry_schema_invalid');
  }
  const cases = registry.cases.map(parseRegistryCase);
  if (cases.length === 0) throw new Error('golden_trace_registry_empty');
  if (new Set(cases.map(item => item.caseId)).size !== cases.length) {
    throw new Error('golden_trace_registry_case_id_duplicate');
  }
  if (new Set(cases.map(item => item.catalogAlias)).size !== cases.length) {
    throw new Error('golden_trace_registry_catalog_alias_duplicate');
  }
  return {
    schemaVersion: 1,
    evalSetId: nonemptyString(
      registry.evalSetId,
      'golden_trace_registry_eval_set_id_invalid',
    ),
    cases,
  };
}

function parseCatalog(value: unknown): Map<string, CatalogCase> {
  const catalog = record(value, 'golden_trace_catalog_invalid');
  if (!Array.isArray(catalog.cases)) throw new Error('golden_trace_catalog_invalid');
  const cases = catalog.cases.map(raw => {
    const item = record(raw, 'golden_trace_catalog_case_invalid');
    const trace = record(item.trace, 'golden_trace_catalog_trace_invalid');
    const coverage = record(
      item.coverage,
      'golden_trace_catalog_coverage_invalid',
    );
    if (!Array.isArray(coverage.expectations)) {
      throw new Error('golden_trace_catalog_expectations_invalid');
    }
    return {
      id: nonemptyString(item.id, 'golden_trace_catalog_case_id_invalid'),
      kind: nonemptyString(item.kind, 'golden_trace_catalog_kind_invalid'),
      case_dir: nonemptyString(
        item.case_dir,
        'golden_trace_catalog_case_dir_invalid',
      ),
      trace: {
        sha256: nonemptyString(
          trace.sha256,
          'golden_trace_catalog_hash_invalid',
        ),
      },
      coverage: {
        expectations: coverage.expectations.map(rawExpectation => {
          const expectation = record(
            rawExpectation,
            'golden_trace_catalog_expectation_invalid',
          );
          return {
            id: nonemptyString(
              expectation.id,
              'golden_trace_catalog_expectation_id_invalid',
            ),
          };
        }),
      },
    } satisfies CatalogCase;
  });
  return new Map(cases.map(item => [item.id, item]));
}

function scenarioScalar(value: unknown): EvalScalar | undefined {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  return undefined;
}

function scenarioNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/.test(value)) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function compileGroundTruth(
  registryCase: RegistryCaseV1,
  catalogCase: CatalogCase,
  scenario: unknown,
): EvalGroundTruthV1 {
  const scenarioRecord = record(scenario, 'golden_trace_scenario_invalid');
  if (!Array.isArray(scenarioRecord.signals)) {
    throw new Error('golden_trace_scenario_signals_invalid');
  }
  // Keep `goldenPoints` as the blinded semantic-judge rubric on EvalCase.
  // Duplicating them into deterministic ground truth would make every
  // provider-free score permanently not-evaluable.
  const requiredFacts: EvalGroundTruthV1['requiredFacts'] = [];
  const numericExpectations: EvalGroundTruthV1['numericExpectations'] = [];
  const identityExpectations: EvalGroundTruthV1['identityExpectations'] = [];
  const actors = record(
    scenarioRecord.actors,
    'golden_trace_scenario_actors_invalid',
  );
  const actorNames = (value: unknown, error: string) => {
    if (!Array.isArray(value)) throw new Error(error);
    return new Map(value.map(rawActor => {
      const actor = record(rawActor, error);
      return [
        nonemptyString(actor.id, error),
        nonemptyString(actor.name, error),
      ];
    }));
  };
  const processNames = actorNames(
    actors.processes,
    'golden_trace_scenario_process_actor_invalid',
  );
  const threadNames = actorNames(
    actors.threads,
    'golden_trace_scenario_thread_actor_invalid',
  );

  scenarioRecord.signals.forEach((rawSignal, index) => {
    const signal = record(rawSignal, 'golden_trace_scenario_signal_invalid');
    const type = nonemptyString(
      signal.type,
      'golden_trace_scenario_signal_type_invalid',
    );
    requiredFacts.push({
      id: `signal-${index}-type`,
      statement: `Signal ${index} has type ${type}.`,
      evaluation: 'deterministic',
      observationKey: `signal.${index}.type`,
      expected: type,
    });
    for (const [field, unit] of NUMERIC_SIGNAL_FIELDS) {
      const expected = scenarioNumber(signal[field]);
      if (expected === undefined) continue;
      numericExpectations.push({
        id: `signal-${index}-${field}`,
        observationKey: `signal.${index}.${field}`,
        expected,
        unit,
        absoluteTolerance: 0,
      });
    }
    for (const field of IDENTITY_SIGNAL_FIELDS) {
      const expected = scenarioScalar(signal[field]);
      if (expected === undefined) continue;
      identityExpectations.push({
        id: `signal-${index}-${field}`,
        observationKey: `signal.${index}.${field}`,
        expected,
      });
    }
    for (const [field, names, observationField] of [
      ['process', processNames, 'process_name'],
      ['thread', threadNames, 'thread_name'],
    ] as const) {
      const actorId = typeof signal[field] === 'string' ? signal[field] : undefined;
      const expected = actorId ? names.get(actorId) : undefined;
      if (!expected) continue;
      identityExpectations.push({
        id: `signal-${index}-${field}`,
        observationKey: `signal.${index}.${observationField}`,
        expected,
      });
    }
  });

  return parseEvalGroundTruth({
    schemaVersion: 1,
    requiredFacts,
    numericExpectations,
    requiredEvidence: catalogCase.coverage.expectations.map(expectation => ({
      id: expectation.id,
      kind: 'coverage_expectation',
      locator: `${registryCase.catalogAlias}:${expectation.id}`,
    })),
    forbiddenClaims: registryCase.forbiddenClaims,
    allowedGaps: registryCase.allowedGaps,
    identityExpectations,
    causalEdges: registryCase.causalEdges,
  });
}

function resolveScenarioPath(catalogCase: CatalogCase): string {
  const caseDirectory = path.resolve(REPOSITORY_ROOT, catalogCase.case_dir);
  const scenarioPath = path.resolve(caseDirectory, 'scenario.json');
  if (
    !caseDirectory.startsWith(`${REPOSITORY_ROOT}${path.sep}`)
    || !scenarioPath.startsWith(`${caseDirectory}${path.sep}`)
  ) {
    throw new Error('golden_trace_scenario_path_escape');
  }
  return scenarioPath;
}

export function loadGoldenTraceRegistry(
  registryPath = DEFAULT_REGISTRY_PATH,
  catalogPath = DEFAULT_CATALOG_PATH,
): GoldenTraceRegistryV1 {
  const registry = parseRegistry(JSON.parse(fs.readFileSync(registryPath, 'utf8')));
  const catalog = parseCatalog(JSON.parse(fs.readFileSync(catalogPath, 'utf8')));
  const cases = registry.cases.map(registryCase => {
    const catalogCase = catalog.get(registryCase.catalogAlias);
    if (!catalogCase || catalogCase.kind !== 'constructed') {
      throw new Error(
        `golden_trace_catalog_case_unavailable:${registryCase.catalogAlias}`,
      );
    }
    const scenarioPath = resolveScenarioPath(catalogCase);
    const groundTruth = compileGroundTruth(
      registryCase,
      catalogCase,
      JSON.parse(fs.readFileSync(scenarioPath, 'utf8')),
    );
    const evalCase = parseEvalCase({
      schemaVersion: 1,
      caseId: registryCase.caseId,
      evalSetId: registry.evalSetId,
      origin: 'synthetic_seed',
      scope: {tenantId: 'system', workspaceId: 'golden-trace'},
      traces: [{
        role: 'current',
        catalogAlias: registryCase.catalogAlias,
        contentHash: catalogCase.trace.sha256,
      }],
      query: registryCase.query,
      analysisMode: registryCase.analysisMode,
      expectedScene: registryCase.expectedScene,
      goldenPoints: registryCase.goldenPoints,
      groundTruth,
      split: registryCase.split,
      createdAt: registryCase.createdAt,
    });
    return {
      ...evalCase,
      catalogAlias: registryCase.catalogAlias,
      groundTruth,
    } satisfies CompiledGoldenTraceEvalCaseV1;
  });
  return immutableCanonicalSnapshot({
    schemaVersion: 1,
    evalSetId: registry.evalSetId,
    cases,
  });
}

export function executionEvalCaseView(
  evalCase: CompiledGoldenTraceEvalCaseV1,
): GoldenTraceExecutionCaseV1 {
  const {
    groundTruth: _groundTruth,
    goldenPoints: _goldenPoints,
    catalogAlias: _catalogAlias,
    split: _split,
    ...executionCase
  } = evalCase;
  return immutableCanonicalSnapshot(executionCase);
}

export const __testing = {
  DEFAULT_CATALOG_PATH,
  DEFAULT_REGISTRY_PATH,
  compileGroundTruth,
};
