// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {describe, it, expect, beforeEach, afterEach} from '@jest/globals';

import {CaseGraph} from '../caseGraph';
import {type CaseEdge} from '../../types/sparkContracts';

let tmpDir: string;
let storagePath: string;
/** These tests exercise the graph alone; no case of theirs is retired. */
const NO_RETIRED_CASES = {retiredCaseIds: () => new Set<string>()};

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'case-graph-test-'));
  storagePath = path.join(tmpDir, 'edges.json');
});

afterEach(() => {
  if (fs.existsSync(tmpDir)) {
    fs.rmSync(tmpDir, {recursive: true, force: true});
  }
});

function makeEdge(overrides: Partial<CaseEdge> = {}): CaseEdge {
  return {
    edgeId: 'e1',
    fromCaseId: 'a',
    toCaseId: 'b',
    relation: 'similar_root_cause',
    ...overrides,
  };
}

describe('CaseGraph — basic CRUD', () => {
  it('adds and reads back edges via getEdgesFrom / getEdgesTo', () => {
    const g = new CaseGraph(storagePath, NO_RETIRED_CASES);
    g.addEdge(makeEdge());
    expect(g.getEdgesFrom('a')).toHaveLength(1);
    expect(g.getEdgesTo('b')).toHaveLength(1);
  });

  it('rejects self-loops', () => {
    const g = new CaseGraph(storagePath, NO_RETIRED_CASES);
    expect(() =>
      g.addEdge(makeEdge({edgeId: 'self', fromCaseId: 'x', toCaseId: 'x'})),
    ).toThrow(/self-loop/i);
  });

  it('deduplicates on (from, to, relation) — replaces in place', () => {
    const g = new CaseGraph(storagePath, NO_RETIRED_CASES);
    g.addEdge(makeEdge({edgeId: 'e1', weight: 0.5, note: 'first'}));
    g.addEdge(makeEdge({edgeId: 'e1-updated', weight: 0.9, note: 'second'}));
    const edges = g.getEdgesFrom('a');
    expect(edges).toHaveLength(1);
    expect(edges[0].weight).toBe(0.9);
    expect(edges[0].note).toBe('second');
    expect(edges[0].edgeId).toBe('e1-updated');
  });

  it('treats different relations between same pair as separate edges', () => {
    const g = new CaseGraph(storagePath, NO_RETIRED_CASES);
    g.addEdge(makeEdge({edgeId: 'e1', relation: 'similar_root_cause'}));
    g.addEdge(makeEdge({edgeId: 'e2', relation: 'before_after_fix'}));
    expect(g.getEdgesFrom('a')).toHaveLength(2);
  });

  it('removeEdge by edgeId returns true when present, false otherwise', () => {
    const g = new CaseGraph(storagePath, NO_RETIRED_CASES);
    g.addEdge(makeEdge({edgeId: 'e1'}));
    expect(g.removeEdge('e1')).toBe(true);
    expect(g.removeEdge('e1')).toBe(false);
  });

  it('size reflects current edge count', () => {
    const g = new CaseGraph(storagePath, NO_RETIRED_CASES);
    expect(g.size()).toBe(0);
    g.addEdge(makeEdge({edgeId: 'e1'}));
    g.addEdge(makeEdge({edgeId: 'e2', relation: 'before_after_fix'}));
    expect(g.size()).toBe(2);
  });

  it('preserves writes from graph instances created before either mutation', () => {
    const first = new CaseGraph(storagePath, NO_RETIRED_CASES);
    const second = new CaseGraph(storagePath, NO_RETIRED_CASES);

    first.addEdge(makeEdge({edgeId: 'e1'}));
    second.addEdge(makeEdge({
      edgeId: 'e2',
      fromCaseId: 'b',
      toCaseId: 'c',
    }));

    expect(new CaseGraph(storagePath, NO_RETIRED_CASES).listEdges().map(edge => edge.edgeId)).toEqual(['e1', 'e2']);
  });
});

describe('CaseGraph — findRelated', () => {
  function seed(g: CaseGraph): void {
    // a → b (similar_root_cause, weight 0.9)
    // a → c (before_after_fix, weight 0.5)
    // d → a (same_app, weight 0.7)
    g.addEdge(makeEdge({edgeId: 'e1', fromCaseId: 'a', toCaseId: 'b', weight: 0.9}));
    g.addEdge(
      makeEdge({
        edgeId: 'e2',
        fromCaseId: 'a',
        toCaseId: 'c',
        relation: 'before_after_fix',
        weight: 0.5,
      }),
    );
    g.addEdge(
      makeEdge({
        edgeId: 'e3',
        fromCaseId: 'd',
        toCaseId: 'a',
        relation: 'same_app',
        weight: 0.7,
      }),
    );
  }

  it("default direction='both' returns out + in edges", () => {
    const g = new CaseGraph(storagePath, NO_RETIRED_CASES);
    seed(g);
    const related = g.findRelated('a');
    expect(related.map(r => r.caseId).sort()).toEqual(['b', 'c', 'd']);
  });

  it("direction='out' returns only outgoing", () => {
    const g = new CaseGraph(storagePath, NO_RETIRED_CASES);
    seed(g);
    const related = g.findRelated('a', {direction: 'out'});
    expect(related.map(r => r.caseId).sort()).toEqual(['b', 'c']);
  });

  it("direction='in' returns only incoming", () => {
    const g = new CaseGraph(storagePath, NO_RETIRED_CASES);
    seed(g);
    const related = g.findRelated('a', {direction: 'in'});
    expect(related.map(r => r.caseId)).toEqual(['d']);
  });

  it('relations filter narrows the result', () => {
    const g = new CaseGraph(storagePath, NO_RETIRED_CASES);
    seed(g);
    const related = g.findRelated('a', {
      relations: ['before_after_fix'],
    });
    expect(related.map(r => r.caseId)).toEqual(['c']);
  });

  it('orders by edge weight descending; unweighted edges sort to the back', () => {
    const g = new CaseGraph(storagePath, NO_RETIRED_CASES);
    seed(g);
    g.addEdge(
      makeEdge({
        edgeId: 'e4',
        fromCaseId: 'a',
        toCaseId: 'e',
        relation: 'derived_pattern',
      }),
    );
    const related = g.findRelated('a', {direction: 'out'});
    expect(related[0].caseId).toBe('b');
    expect(related[1].caseId).toBe('c');
    // Unweighted last.
    expect(related[2].caseId).toBe('e');
  });

  it('respects topK', () => {
    const g = new CaseGraph(storagePath, NO_RETIRED_CASES);
    seed(g);
    expect(g.findRelated('a', {topK: 1})).toHaveLength(1);
  });
});

describe('CaseGraph — listEdges deterministic order', () => {
  it('lists edges sorted by canonical key', () => {
    const g = new CaseGraph(storagePath, NO_RETIRED_CASES);
    g.addEdge(makeEdge({edgeId: 'z', fromCaseId: 'b', toCaseId: 'c'}));
    g.addEdge(makeEdge({edgeId: 'a', fromCaseId: 'a', toCaseId: 'b'}));
    const edges = g.listEdges();
    expect(edges.map(e => e.edgeId)).toEqual(['a', 'z']);
  });
});

describe('CaseGraph — persistence', () => {
  it('persists across instances', () => {
    const g1 = new CaseGraph(storagePath, NO_RETIRED_CASES);
    g1.addEdge(makeEdge({edgeId: 'e1'}));
    const g2 = new CaseGraph(storagePath, NO_RETIRED_CASES);
    expect(g2.size()).toBe(1);
  });

  it('preserves corrupted JSON and refuses to overwrite it', () => {
    fs.writeFileSync(storagePath, 'not-json{', 'utf-8');
    const g = new CaseGraph(storagePath, NO_RETIRED_CASES);
    expect(g.size()).toBe(0);
    expect(fs.existsSync(storagePath)).toBe(true);
    expect(() => g.addEdge(makeEdge({edgeId: 'e1'}))).toThrow(/unreadable/);
    expect(fs.readFileSync(storagePath, 'utf-8')).toBe('not-json{');
  });
});
