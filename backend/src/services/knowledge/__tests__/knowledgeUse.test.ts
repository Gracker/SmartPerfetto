// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {describe, expect, it} from '@jest/globals';

import {KnowledgeReferenceLedger, type KnowledgeReferenceBinding} from '../knowledgeTools';
import {
  buildKnowledgeUse,
  knowledgeReferenceCount,
  KnowledgeUseRecorder,
  projectKnowledgeUseForAudience,
  sanitizeKnowledgeUse,
  type KnowledgeUseRecord,
} from '../knowledgeUse';

const BASE_A = `eks_${'a'.repeat(24)}`;
const BASE_B = `eks_${'b'.repeat(24)}`;
const GEN_1 = `dc_${'1'.repeat(32)}`;
const GEN_2 = `dc_${'2'.repeat(32)}`;

function binding(overrides: Partial<KnowledgeReferenceBinding> = {}): KnowledgeReferenceBinding {
  return {
    scopeKey: 'tenant\0workspace\0user', sourceId: BASE_A, generation: GEN_1, sectionId: 'd1:0', chunkId: 'd1:0:0',
    relativePath: 'guides/render notes.md', lineRange: {start: 10, end: 20}, excerptComplete: false, ...overrides,
  };
}

function record(build: (ledger: KnowledgeReferenceLedger, recorder: KnowledgeUseRecorder) => void): KnowledgeUseRecord {
  const ledger = new KnowledgeReferenceLedger();
  const recorder = new KnowledgeUseRecorder(ledger);
  build(ledger, recorder);
  return recorder.snapshot();
}

describe('knowledge_use@1 citations', () => {
  it('grades a citation delivered only when its text was delivered, and located when only its place was', () => {
    let hitId = '';
    const searchOnly = record(ledger => {hitId = ledger.issue(binding());});
    const located = buildKnowledgeUse(searchOnly, 'See «Render › Fences» `kb:guides/render notes.md#L12-L14`.')!;
    expect(located.citations).toEqual([{citation: 'kb:guides/render notes.md#L12-L14',
      relativePath: 'guides/render notes.md', lineRange: {start: 12, end: 14}, status: 'located',
      knowledgeBaseId: BASE_A, referenceId: hitId}]);

    // The excerpt was the hit's whole text: its lines were delivered.
    const wholeExcerpt = record(ledger => {hitId = ledger.issue(binding({excerptComplete: true}));});
    expect(buildKnowledgeUse(wholeExcerpt, '`kb:guides/render notes.md#L10-L20`')!.citations[0]!.status)
      .toBe('delivered');

    // A section read whole covers lines its hit did not.
    const read = record(ledger => {
      hitId = ledger.issue(binding());
      ledger.recordDelivered(hitId, binding(), 1, {partCount: 1, truncated: false, sectionRange: {start: 1, end: 40}});
    });
    expect(buildKnowledgeUse(read, '`kb:guides/render notes.md#L30-L35`')!.citations[0]).toMatchObject({
      status: 'delivered', referenceId: hitId});
  });

  it('never calls a partly delivered or budget-cut section delivered', () => {
    const partial = record(ledger => {
      const id = ledger.issue(binding());
      ledger.recordDelivered(id, binding(), 1, {partCount: 2, truncated: false, sectionRange: {start: 1, end: 40}});
    });
    expect(buildKnowledgeUse(partial, '`kb:guides/render notes.md#L30-L35`')!.citations[0]!.status).toBe('located');
    const cut = record(ledger => {
      const id = ledger.issue(binding());
      ledger.recordDelivered(id, binding(), 1, {partCount: 1, truncated: true, sectionRange: {start: 1, end: 40}});
    });
    expect(buildKnowledgeUse(cut, '`kb:guides/render notes.md#L30-L35`')!.citations[0]!.status).toBe('located');
  });

  it('is unmatched outside delivered lines and ambiguous across knowledge bases or generations', () => {
    const single = record(ledger => {ledger.issue(binding());});
    expect(buildKnowledgeUse(single, 'kb:guides/other.md#L1 and `kb:guides/render notes.md#L18-L25`')!.citations
      .map(citation => citation.status)).toEqual(['unmatched', 'unmatched']);
    const twoBases = record(ledger => {
      ledger.issue(binding());
      ledger.issue(binding({sourceId: BASE_B, chunkId: 'b:0'}));
    });
    expect(buildKnowledgeUse(twoBases, '`kb:guides/render notes.md#L12`')!.citations[0]).toEqual({
      citation: 'kb:guides/render notes.md#L12', relativePath: 'guides/render notes.md', lineRange: {start: 12, end: 12},
      status: 'ambiguous', candidateKnowledgeBaseIds: [BASE_A, BASE_B]});
    const twoGenerations = record(ledger => {
      ledger.issue(binding());
      ledger.issue(binding({generation: GEN_2}));
    });
    expect(buildKnowledgeUse(twoGenerations, '`kb:guides/render notes.md#L12`')!.citations[0]!.status).toBe('ambiguous');
  });

  it('matches a trailing path and reads a range whole or not at all', () => {
    const bare = record(ledger => {ledger.issue(binding({relativePath: 'guides/render.md', excerptComplete: true}));});
    expect(buildKnowledgeUse(bare, 'Per kb:render.md#L11-L12, the fence waits.')!.citations[0]).toMatchObject({
      citation: 'kb:render.md#L11-L12', relativePath: 'render.md', status: 'delivered'});
    // A reversed range never shrinks into its first line, and keeps no lines.
    expect(buildKnowledgeUse(bare, 'kb:guides/render.md#L15-L11')!.citations[0]).toEqual({
      citation: 'kb:guides/render.md#L15-L11', relativePath: 'guides/render.md', status: 'unmatched'});
    expect(buildKnowledgeUse(bare, 'kb:guides/render.md#L11–L12')!.citations[0]!.lineRange).toEqual({start: 11, end: 12});
  });

  it('reports a truncated extraction instead of grading what it did not read', () => {
    const body = Array.from({length: 201}, (_, index) => `kb:a.md#L${index + 1}`).join('\n');
    const use = buildKnowledgeUse({sources: [], locations: []}, body)!;
    expect(use.citations).toHaveLength(200);
    expect(use.citationsTruncated).toBe(true);
  });

  it('is undefined when nothing was recorded, and empty when a selected base delivered nothing', () => {
    expect(buildKnowledgeUse(undefined, 'kb:a.md#L1')).toBeUndefined();
    expect(buildKnowledgeUse({sources: [], locations: []}, 'no citations')).toEqual({
      schemaVersion: 'knowledge_use@1', sources: [], citations: []});
  });
});

describe('knowledge use sources', () => {
  it('counts each delivered reference and Wiki chunk once, per base', () => {
    const snapshot = record((ledger, recorder) => {
      ledger.issue(binding());
      ledger.issue(binding());
      ledger.issue(binding({chunkId: 'd1:0:1'}));
      recorder.recordWikiDelivery(BASE_B, 'wiki_gen', ['c1', 'c2']);
      recorder.recordWikiDelivery(BASE_B, 'wiki_gen', ['c2']);
      recorder.recordWikiDelivery(BASE_B, 'wiki_gen', []);
    });
    expect(snapshot.sources).toEqual([
      {knowledgeBaseId: BASE_A, kind: 'document_collection', generation: GEN_1, deliveredReferenceCount: 2},
      {knowledgeBaseId: BASE_B, kind: 'android_internals_wiki', generation: 'wiki_gen', deliveredReferenceCount: 2},
    ]);
    expect(knowledgeReferenceCount(buildKnowledgeUse(snapshot, ''))).toBe(4);
    expect(knowledgeReferenceCount(undefined)).toBeUndefined();
  });
});

describe('knowledge_use@1 closed shape', () => {
  const built = buildKnowledgeUse(record(ledger => {ledger.issue(binding());}),
    '`kb:guides/render notes.md#L12`')!;
  const valid = () => structuredClone(built);

  it('accepts what it builds and rejects any other shape whole', () => {
    expect(sanitizeKnowledgeUse(valid())).toEqual(valid());
    const variants: unknown[] = [
      {...valid(), extra: true},
      {...valid(), schemaVersion: 'knowledge_use@2'},
      {...valid(), sources: [{...valid().sources[0], knowledgeBaseId: '../escape'}]},
      {...valid(), sources: [{...valid().sources[0], kind: 'blog'}]},
      {...valid(), sources: [{...valid().sources[0], deliveredReferenceCount: -1}]},
      {...valid(), sources: [valid().sources[0], valid().sources[0]]},
      {...valid(), citations: [{...valid().citations[0], status: 'verified'}]},
      // A positive status names its pin; an unmatched one names none.
      {...valid(), citations: [{...valid().citations[0], referenceId: undefined}]},
      {...valid(), citations: [{...valid().citations[0], status: 'unmatched'}]},
      {...valid(), citations: [{...valid().citations[0], relativePath: '/abs/path.md'}]},
      {...valid(), citations: [{...valid().citations[0], lineRange: {start: 3, end: 1}}]},
      // Only an unmatched citation may lack its lines.
      {...valid(), citations: [{...valid().citations[0], lineRange: undefined}]},
      {...valid(), citationsTruncated: false},
    ];
    for (const variant of variants) expect(sanitizeKnowledgeUse(JSON.parse(JSON.stringify(variant)))).toBeUndefined();
  });

  it('rejects a citation the record\'s own sources do not stand behind', () => {
    const ambiguous = buildKnowledgeUse(record(ledger => {
      ledger.issue(binding());
      ledger.issue(binding({sourceId: BASE_B, chunkId: 'b:0'}));
    }), '`kb:guides/render notes.md#L12`')!;
    expect(sanitizeKnowledgeUse(structuredClone(ambiguous))).toEqual(ambiguous);
    const source = valid().sources[0]!;
    const variants: unknown[] = [
      // The pinned base delivered nothing this record lists.
      {...valid(), sources: []},
      {...valid(), sources: [{...source, knowledgeBaseId: BASE_B}]},
      // A Wiki has no line locations, so it cannot pin a cited line.
      {...valid(), sources: [{...source, kind: 'android_internals_wiki'}]},
      {...valid(), sources: [{...source, deliveredReferenceCount: 0}]},
      // Every ambiguous candidate is a base that delivered.
      {...ambiguous, sources: ambiguous.sources.slice(0, 1)},
      {...ambiguous, citations: [{...ambiguous.citations[0], candidateKnowledgeBaseIds: [BASE_A, `eks_${'c'.repeat(24)}`]}]},
    ];
    for (const variant of variants) expect(sanitizeKnowledgeUse(JSON.parse(JSON.stringify(variant)))).toBeUndefined();
    // An unmatched citation names no base, so it needs no source.
    const unmatched = buildKnowledgeUse({sources: [], locations: []}, 'kb:guides/x.md#L1')!;
    expect(sanitizeKnowledgeUse(structuredClone(unmatched))).toEqual(unmatched);
  });

  it('keeps the owner their citations and gives every other audience the sources only', () => {
    const owner = projectKnowledgeUseForAudience(valid(), {owner: true, projectText: text => text});
    expect(owner).toEqual(valid());
    const strict = projectKnowledgeUseForAudience(valid(), {owner: false, projectText: text => text});
    expect(strict).toEqual({schemaVersion: 'knowledge_use@1', sources: valid().sources, citations: []});
    expect(JSON.stringify(strict)).not.toContain('render notes');
    // A projection that alters the path drops that citation for the owner too.
    expect(projectKnowledgeUseForAudience(valid(), {owner: true, projectText: text => text.replace('render', '[x]')})
      ?.citations).toEqual([]);
  });
});
