// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {createHash} from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';

import type {
  SelfEvolutionPersistenceCapability,
} from '../../../types/selfEvolution';
import {EvalCaseStore} from '../evalCaseStore';
import {
  loadSyntheticEvalSeedRegistry,
  parseSyntheticEvalSeedRegistry,
  seedSyntheticEvalCases,
  __testing,
} from '../syntheticEvalSeeder';

const persistenceUnavailable: SelfEvolutionPersistenceCapability = {
  persistence: 'unavailable',
  reason: 'data_root_not_writable',
  configured: true,
  writable: false,
  outsidePackage: true,
  externalMount: true,
  dataRoot: '/tmp/synthetic-eval-seeder-tests',
  packageRoot: '/app',
  checkedAt: 1,
};
const scope = {tenantId: 'local', workspaceId: 'local'};

describe('synthetic EvalCase seeder', () => {
  let directory: string;
  let corpusRoot: string;
  let store: EvalCaseStore;

  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'synthetic-eval-seeder-'));
    corpusRoot = path.join(directory, 'corpus');
    store = new EvalCaseStore({
      persistence: persistenceUnavailable,
      corpusRoot,
    });
  });

  afterEach(() => {
    store.close();
    fs.rmSync(directory, {recursive: true, force: true});
  });

  function writeRegistry(input: {
    contentHash: string;
    alias?: string;
  }): string {
    const registryPath = path.join(directory, 'seeds.registry.yaml');
    fs.writeFileSync(registryPath, JSON.stringify({
      schemaVersion: 1,
      evalSetId: 'test-constructed-v1',
      seeds: [{
        caseId: 'synthetic-test-v1',
        catalogAlias: input.alias ?? 'test-trace',
        contentHash: input.contentHash,
        query: 'Analyze the deterministic test trace.',
        analysisMode: 'full',
        expectedScene: 'general',
        goldenPoints: ['Use the deterministic evidence.'],
        split: 'validation',
        createdAt: '2026-07-29T00:00:00.000Z',
      }],
    }));
    return registryPath;
  }

  it('keeps the packed registry aligned with every constructed trace catalog entry', () => {
    const registry = loadSyntheticEvalSeedRegistry();
    const catalogPath = path.resolve(
      __dirname,
      '../../../../../Trace/catalog.json',
    );
    const catalog = JSON.parse(fs.readFileSync(catalogPath, 'utf8')) as {
      cases: Array<{
        id: string;
        kind: string;
        scene: string;
        trace: {sha256: string};
      }>;
    };
    const constructed = catalog.cases.filter(entry => entry.kind === 'constructed');
    expect(registry.seeds).toHaveLength(constructed.length);
    expect(registry.seeds.map(seed => seed.catalogAlias).sort())
      .toEqual(constructed.map(entry => entry.id).sort());
    for (const seed of registry.seeds) {
      const catalogEntry = constructed.find(entry => entry.id === seed.catalogAlias);
      expect(catalogEntry).toMatchObject({
        scene: seed.expectedScene,
        trace: {sha256: seed.contentHash},
      });
    }
    expect(__testing.DEFAULT_REGISTRY_PATH)
      .toMatch(/backend\/strategies\/golden-trace-eval\.registry\.json$/);
    expect(registry.seeds.every(seed => seed.groundTruth !== undefined)).toBe(true);
  });

  it('strictly rejects unknown fields and duplicate source aliases', () => {
    const seed = {
      caseId: 'case-a',
      catalogAlias: 'alias-a',
      contentHash: 'a'.repeat(64),
      query: 'Analyze.',
      analysisMode: 'full',
      expectedScene: 'general',
      goldenPoints: ['Point.'],
      split: 'train',
      createdAt: '2026-07-29T00:00:00.000Z',
    };
    expect(() => parseSyntheticEvalSeedRegistry({
      schemaVersion: 1,
      evalSetId: 'set-a',
      seeds: [{...seed, unknown: true}],
    })).toThrow('synthetic_eval_seed_unknown_field');
    expect(() => parseSyntheticEvalSeedRegistry({
      schemaVersion: 1,
      evalSetId: 'set-a',
      seeds: [seed, {...seed, caseId: 'case-b'}],
    })).toThrow('synthetic_eval_seed_catalog_alias_duplicate');
  });

  it('imports an available generated trace and seeds cases idempotently', () => {
    const content = Buffer.from('tiny generated trace');
    const contentHash = createHash('sha256').update(content).digest('hex');
    const traceRoot = path.join(directory, 'generated');
    const traceDirectory = path.join(traceRoot, 'test-trace');
    fs.mkdirSync(traceDirectory, {recursive: true});
    fs.writeFileSync(path.join(traceDirectory, 'trace.pftrace'), content);
    const registryPath = writeRegistry({contentHash});

    const first = seedSyntheticEvalCases({
      store,
      scope,
      registryPath,
      constructedTraceRoot: traceRoot,
    });
    expect(first).toMatchObject({
      seeded: 1,
      idempotent: 0,
      corpusImported: 1,
    });
    expect(first.cases[0].traces[0]).toMatchObject({
      corpusId: contentHash,
      catalogAlias: 'test-trace',
      contentHash,
    });
    const opened = store.openTrace(scope, contentHash)!;
    expect(fs.readFileSync(opened.fileDescriptor)).toEqual(content);
    opened.close();

    expect(seedSyntheticEvalCases({
      store,
      scope,
      registryPath,
      constructedTraceRoot: traceRoot,
    })).toMatchObject({
      seeded: 0,
      idempotent: 1,
      corpusImported: 1,
    });
  });

  it('fails explicitly when generated bytes are unavailable', () => {
    const contentHash = 'b'.repeat(64);
    const registryPath = writeRegistry({contentHash});
    expect(() => seedSyntheticEvalCases({
      store,
      scope,
      registryPath,
      constructedTraceRoot: path.join(directory, 'missing-generated-root'),
    })).toThrow('synthetic_eval_seed_trace_root_unavailable');
    expect(store.listCases(scope)).toEqual([]);
  });

  it('fails before seeding when generated bytes disagree with the packed hash', () => {
    const traceRoot = path.join(directory, 'generated');
    const traceDirectory = path.join(traceRoot, 'test-trace');
    fs.mkdirSync(traceDirectory, {recursive: true});
    fs.writeFileSync(path.join(traceDirectory, 'trace.pftrace'), 'wrong bytes');
    const registryPath = writeRegistry({contentHash: 'c'.repeat(64)});

    expect(() => seedSyntheticEvalCases({
      store,
      scope,
      registryPath,
      constructedTraceRoot: traceRoot,
    })).toThrow('eval_corpus_content_hash_mismatch');
    expect(store.listCases(scope)).toEqual([]);
  });

  it('rejects traversal aliases and symlink escapes from the trace root', () => {
    expect(() => parseSyntheticEvalSeedRegistry({
      schemaVersion: 1,
      evalSetId: 'set-a',
      seeds: [{
        caseId: 'case-a',
        catalogAlias: '../escape',
        contentHash: 'a'.repeat(64),
        query: 'Analyze.',
        analysisMode: 'full',
        expectedScene: 'general',
        goldenPoints: ['Point.'],
        split: 'train',
        createdAt: '2026-07-29T00:00:00.000Z',
      }],
    })).toThrow('synthetic_eval_seed_catalog_alias_invalid');

    const content = Buffer.from('outside trace');
    const contentHash = createHash('sha256').update(content).digest('hex');
    const traceRoot = path.join(directory, 'generated');
    const outside = path.join(directory, 'outside');
    fs.mkdirSync(traceRoot);
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, 'trace.pftrace'), content);
    fs.symlinkSync(outside, path.join(traceRoot, 'test-trace'));
    const registryPath = writeRegistry({contentHash});

    expect(() => seedSyntheticEvalCases({
      store,
      scope,
      registryPath,
      constructedTraceRoot: traceRoot,
    })).toThrow('synthetic_eval_seed_trace_path_escape');
  });
});
