// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import fs from 'fs';
import path from 'path';

import type {
  EvalCaseV1,
  EvalGroundTruthV1,
  RunManifestScope,
} from '../../types/selfEvolution';
import type {EvalCaseStore} from './evalCaseStore';
import {immutableCanonicalSnapshot} from './canonicalJson';
import {parseEvalCase} from './evalContracts';
import {loadGoldenTraceRegistry} from './goldenTraceRegistry';
import {parseEvalGroundTruth} from './goldenTraceScorer';

const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const CATALOG_ALIAS_PATTERN = /^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/;
const DEFAULT_REGISTRY_PATH = path.resolve(
  __dirname,
  '../../../strategies/golden-trace-eval.registry.json',
);
const DEFAULT_CONSTRUCTED_TRACE_ROOT = path.resolve(
  __dirname,
  '../../../../Trace/.generated/constructed',
);

export interface SyntheticEvalSeedV1 {
  caseId: string;
  catalogAlias: string;
  contentHash: string;
  query: string;
  analysisMode: 'fast' | 'full';
  expectedScene: string;
  goldenPoints: string[];
  groundTruth?: EvalGroundTruthV1;
  expectedRubricVersion?: string;
  split: 'train' | 'validation' | 'holdout';
  createdAt: string;
}

export interface SyntheticEvalSeedRegistryV1 {
  schemaVersion: 1;
  evalSetId: string;
  seeds: SyntheticEvalSeedV1[];
}

export interface SeedSyntheticEvalCasesOptions {
  store: EvalCaseStore;
  scope: RunManifestScope;
  registryPath?: string;
  constructedTraceRoot?: string;
}

export interface SeedSyntheticEvalCasesResult {
  evalSetId: string;
  seeded: number;
  idempotent: number;
  corpusImported: number;
  cases: EvalCaseV1[];
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
  if (Object.keys(value).some(key => !allowed.has(key))) {
    throw new Error(error);
  }
}

function nonempty(value: unknown, error: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(error);
  return value;
}

function catalogAlias(value: unknown): string {
  const alias = nonempty(value, 'synthetic_eval_seed_catalog_alias_invalid');
  if (!CATALOG_ALIAS_PATTERN.test(alias)) {
    throw new Error('synthetic_eval_seed_catalog_alias_invalid');
  }
  return alias;
}

function parseSeed(value: unknown): SyntheticEvalSeedV1 {
  const seed = record(value, 'synthetic_eval_seed_invalid');
  exactKeys(seed, [
    'caseId',
    'catalogAlias',
    'contentHash',
    'query',
    'analysisMode',
    'expectedScene',
    'goldenPoints',
    'groundTruth',
    'expectedRubricVersion',
    'split',
    'createdAt',
  ], 'synthetic_eval_seed_unknown_field');
  if (seed.analysisMode !== 'fast' && seed.analysisMode !== 'full') {
    throw new Error('synthetic_eval_seed_analysis_mode_invalid');
  }
  if (!['train', 'validation', 'holdout'].includes(String(seed.split))) {
    throw new Error('synthetic_eval_seed_split_invalid');
  }
  const contentHash = nonempty(
    seed.contentHash,
    'synthetic_eval_seed_content_hash_invalid',
  );
  if (!SHA256_PATTERN.test(contentHash)) {
    throw new Error('synthetic_eval_seed_content_hash_invalid');
  }
  if (!Array.isArray(seed.goldenPoints) || seed.goldenPoints.length === 0) {
    throw new Error('synthetic_eval_seed_golden_points_invalid');
  }
  const createdAt = nonempty(
    seed.createdAt,
    'synthetic_eval_seed_created_at_invalid',
  );
  if (!Number.isFinite(Date.parse(createdAt))) {
    throw new Error('synthetic_eval_seed_created_at_invalid');
  }
  return {
    caseId: nonempty(seed.caseId, 'synthetic_eval_seed_case_id_invalid'),
    catalogAlias: catalogAlias(seed.catalogAlias),
    contentHash,
    query: nonempty(seed.query, 'synthetic_eval_seed_query_invalid'),
    analysisMode: seed.analysisMode,
    expectedScene: nonempty(
      seed.expectedScene,
      'synthetic_eval_seed_expected_scene_invalid',
    ),
    goldenPoints: seed.goldenPoints.map(point =>
      nonempty(point, 'synthetic_eval_seed_golden_point_invalid')),
    ...(seed.groundTruth === undefined
      ? {}
      : {groundTruth: parseEvalGroundTruth(seed.groundTruth)}),
    ...(seed.expectedRubricVersion === undefined
      ? {}
      : {
          expectedRubricVersion: nonempty(
            seed.expectedRubricVersion,
            'synthetic_eval_seed_rubric_version_invalid',
          ),
        }),
    split: seed.split as SyntheticEvalSeedV1['split'],
    createdAt,
  };
}

export function parseSyntheticEvalSeedRegistry(
  value: unknown,
): SyntheticEvalSeedRegistryV1 {
  const registry = record(value, 'synthetic_eval_seed_registry_invalid');
  exactKeys(
    registry,
    ['schemaVersion', 'evalSetId', 'seeds'],
    'synthetic_eval_seed_registry_unknown_field',
  );
  if (registry.schemaVersion !== 1 || !Array.isArray(registry.seeds)) {
    throw new Error('synthetic_eval_seed_registry_schema_invalid');
  }
  if (registry.seeds.length === 0) {
    throw new Error('synthetic_eval_seed_registry_empty');
  }
  const seeds = registry.seeds.map(parseSeed);
  if (new Set(seeds.map(seed => seed.caseId)).size !== seeds.length) {
    throw new Error('synthetic_eval_seed_case_id_duplicate');
  }
  if (new Set(seeds.map(seed => seed.catalogAlias)).size !== seeds.length) {
    throw new Error('synthetic_eval_seed_catalog_alias_duplicate');
  }
  return immutableCanonicalSnapshot({
    schemaVersion: 1,
    evalSetId: nonempty(
      registry.evalSetId,
      'synthetic_eval_seed_eval_set_id_invalid',
    ),
    seeds,
  });
}

export function loadSyntheticEvalSeedRegistry(
  registryPath = DEFAULT_REGISTRY_PATH,
): SyntheticEvalSeedRegistryV1 {
  const content = fs.readFileSync(registryPath, 'utf8');
  const raw = JSON.parse(content) as unknown;
  if (
    raw
    && typeof raw === 'object'
    && !Array.isArray(raw)
    && Array.isArray((raw as {cases?: unknown}).cases)
  ) {
    const registry = loadGoldenTraceRegistry(registryPath);
    return immutableCanonicalSnapshot({
      schemaVersion: 1,
      evalSetId: registry.evalSetId,
      seeds: registry.cases.map(evalCase => ({
        caseId: evalCase.caseId,
        catalogAlias: evalCase.catalogAlias,
        contentHash: evalCase.traces[0].contentHash,
        query: evalCase.query,
        analysisMode: evalCase.analysisMode,
        expectedScene: evalCase.expectedScene!,
        goldenPoints: evalCase.goldenPoints!,
        groundTruth: evalCase.groundTruth,
        ...(evalCase.expectedRubricVersion
          ? {expectedRubricVersion: evalCase.expectedRubricVersion}
          : {}),
        split: evalCase.split,
        createdAt: evalCase.createdAt,
      })),
    });
  }
  return parseSyntheticEvalSeedRegistry(raw);
}

function resolveSeedTracePath(
  realTraceRoot: string,
  seed: SyntheticEvalSeedV1,
): string {
  const traceDirectory = path.resolve(realTraceRoot, seed.catalogAlias);
  const generatedTracePath = path.join(traceDirectory, 'trace.pftrace');
  if (
    !traceDirectory.startsWith(`${realTraceRoot}${path.sep}`)
    || !generatedTracePath.startsWith(`${realTraceRoot}${path.sep}`)
  ) {
    throw new Error('synthetic_eval_seed_trace_path_escape');
  }
  if (!fs.existsSync(generatedTracePath)) {
    throw new Error(
      `synthetic_eval_seed_trace_unavailable:${seed.catalogAlias}`,
    );
  }
  const directoryStat = fs.lstatSync(traceDirectory);
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
    throw new Error('synthetic_eval_seed_trace_path_escape');
  }
  const realGeneratedTracePath = fs.realpathSync(generatedTracePath);
  if (!realGeneratedTracePath.startsWith(`${realTraceRoot}${path.sep}`)) {
    throw new Error('synthetic_eval_seed_trace_path_escape');
  }
  return realGeneratedTracePath;
}

export function seedSyntheticEvalCases(
  options: SeedSyntheticEvalCasesOptions,
): SeedSyntheticEvalCasesResult {
  const registry = loadSyntheticEvalSeedRegistry(options.registryPath);
  const traceRoot = options.constructedTraceRoot
    ?? DEFAULT_CONSTRUCTED_TRACE_ROOT;
  const result: SeedSyntheticEvalCasesResult = {
    evalSetId: registry.evalSetId,
    seeded: 0,
    idempotent: 0,
    corpusImported: 0,
    cases: [],
  };
  if (!fs.existsSync(traceRoot)) {
    throw new Error('synthetic_eval_seed_trace_root_unavailable');
  }
  const realTraceRoot = fs.realpathSync(traceRoot);
  const resolvedSeeds = registry.seeds.map(seed => ({
    seed,
    sourcePath: resolveSeedTracePath(realTraceRoot, seed),
  }));
  const importedSeeds = resolvedSeeds.map(({seed, sourcePath}) => {
    const corpusId = options.store.importTrace({
      scope: options.scope,
      sourcePath,
      expectedContentHash: seed.contentHash,
      createdAt: seed.createdAt,
    }).corpusId;
    result.corpusImported += 1;
    return {
      seed,
      evalCase: parseEvalCase({
        schemaVersion: 1,
        caseId: seed.caseId,
        evalSetId: registry.evalSetId,
        origin: 'synthetic_seed',
        scope: options.scope,
        traces: [{
          role: 'current',
          corpusId,
          catalogAlias: seed.catalogAlias,
          contentHash: seed.contentHash,
        }],
        query: seed.query,
        analysisMode: seed.analysisMode,
        expectedScene: seed.expectedScene,
        goldenPoints: seed.goldenPoints,
        ...(seed.groundTruth ? {groundTruth: seed.groundTruth} : {}),
        ...(seed.expectedRubricVersion
          ? {expectedRubricVersion: seed.expectedRubricVersion}
          : {}),
        split: seed.split,
        createdAt: seed.createdAt,
      }),
    };
  });
  for (const {evalCase} of importedSeeds) {
    const put = options.store.putCase(options.scope, evalCase);
    if (put.idempotent) result.idempotent += 1;
    else result.seeded += 1;
    result.cases.push(put.evalCase);
  }
  return immutableCanonicalSnapshot(result);
}

export const __testing = {
  DEFAULT_CONSTRUCTED_TRACE_ROOT,
  DEFAULT_REGISTRY_PATH,
};
