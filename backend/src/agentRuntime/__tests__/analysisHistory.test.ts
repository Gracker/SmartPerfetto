// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {describe, expect, it, jest} from '@jest/globals';
import {createAnalysisHistoryReader, createRuntimeAnalysisHistoryReader, renderAnalysisHistoryContext,
  resolveAnalysisHistoryReader, toAnalysisHistoryTurn, withAnalysisHistoryReader, type AnalysisHistoryTurn} from '../analysisHistory';
import {AnalysisHistoryStore, parseAnalysisHistoryTurn} from '../../services/analysisHistoryStore';
import {clearCodeAwareOutputGuards, sanitizeCodeAwareText, sanitizeOwnerCodeAwareText} from '../../services/security/codeAwareOutputRegistry';

function turn(index = 0): AnalysisHistoryTurn {
  return toAnalysisHistoryTurn({id: `run-${index}`, turnIndex: index, traceId: 'trace', timestamp: index,
    query: `question-${index}`, result: {message: `answer-${index}`,
      completion: {status: 'completed'}, conclusionContract: {uncertainties: [], nextSteps: []}}});
}

describe('typed analysis history', () => {
  it('carries product-resolved source activation through real runtime wrappers without sourceUsePolicy', () => {
    const source = {...turn(), sourceDerived: true, analysisContextFingerprint: 'scope-A', answer: 'AUTHORIZED_SOURCE_HISTORY'};
    const missingFingerprint = {...turn(1), sourceDerived: true, answer: 'LEGACY_PRIVATE_HISTORY'};
    const publicTurn = turn(2);
    let productActive = true;
    let runtimeActive = true;
    const productReader = createAnalysisHistoryReader({getTurns: () => [source, missingFingerprint, publicTurn],
      assertActive: () => {if (!productActive) throw new Error('product_revoked');}});
    const baseOptions = {analysisContextFingerprint: 'scope-A', codeAwareMode: 'provider_send' as const, codebaseIds: ['A']};
    const bound = withAnalysisHistoryReader(baseOptions, productReader, {includeSourceDerived: true});
    expect(bound).not.toHaveProperty('sourceUsePolicy');
    const runtime = createRuntimeAnalysisHistoryReader({options: {...bound}, sessionId: 'physical-run', traceId: 'trace',
      getTurns: () => [], assertActive: () => {if (!runtimeActive) throw new Error('runtime_revoked');}});
    expect(runtime.getTurns()).toEqual([source, publicTurn]);
    expect(String(runtime.read({turnId: source.id}).text)).toContain('AUTHORIZED_SOURCE_HISTORY');
    expect(runtime.read({turnId: missingFingerprint.id})).toMatchObject({success: false});
    expect(renderAnalysisHistoryContext(runtime.getTurns())).toContain('AUTHORIZED_SOURCE_HISTORY');
    const changedScope = createRuntimeAnalysisHistoryReader({options: {...bound, analysisContextFingerprint: 'scope-B'},
      sessionId: 'physical-B', traceId: 'trace', getTurns: () => [], assertActive: () => {}});
    expect(changedScope.getTurns()).toEqual([publicTurn]);
    const dormant = createRuntimeAnalysisHistoryReader({options: withAnalysisHistoryReader(baseOptions, productReader,
      {includeSourceDerived: false}), sessionId: 'physical-dormant', traceId: 'trace', getTurns: () => [],
      assertActive: () => {}, includeSourceDerived: true});
    expect(dormant.getTurns()).toEqual([publicTurn]);
    const restricted = createRuntimeAnalysisHistoryReader({options: bound, sessionId: 'restricted', traceId: 'trace',
      getTurns: () => [], assertActive: () => {}, includeSourceDerived: false});
    expect(restricted.getTurns()).toEqual([publicTurn]);
    runtimeActive = false;
    expect(() => runtime.read({turnId: source.id})).toThrow('runtime_revoked');
    runtimeActive = true;
    productActive = false;
    expect(() => runtime.read({turnId: source.id})).toThrow('product_revoked');
  });

  it('keeps pre-acf2 source-derived history stored but out of the model context', () => {
    const current = `acf2:${'d'.repeat(64)}`;
    const legacySource = {...turn(), sourceDerived: true, analysisContextFingerprint: 'd'.repeat(64), answer: 'LEGACY_SOURCE'};
    const currentSource = {...turn(1), sourceDerived: true, analysisContextFingerprint: current, answer: 'CURRENT_SOURCE'};
    const publicTurn = turn(2);
    const stored = [legacySource, currentSource, publicTurn];
    const reader = createRuntimeAnalysisHistoryReader({options: {analysisContextFingerprint: current,
      codeAwareMode: 'provider_send', codebaseIds: ['A']}, sessionId: 'upgraded', traceId: 'trace',
      getTurns: () => stored, assertActive: () => {}});
    expect(reader.getTurns()).toEqual([currentSource, publicTurn]);
    expect(reader.read({turnId: legacySource.id})).toMatchObject({success: false});
    expect(renderAnalysisHistoryContext(reader.getTurns())).not.toContain('LEGACY_SOURCE');
    // Nothing is re-stamped: the stored turn keeps the fingerprint it ran under.
    expect(stored[0]!.analysisContextFingerprint).toBe('d'.repeat(64));
  });

  it('does not recreate an issued reader or its restriction from serialized options', () => {
    const source = {...turn(), sourceDerived: true, analysisContextFingerprint: 'scope-A'};
    const productOnly = {...turn(1), sourceDerived: true, analysisContextFingerprint: 'scope-A', answer: 'PRODUCT_READER_ONLY'};
    const selection = {analysisContextFingerprint: 'scope-A', codeAwareMode: 'provider_send' as const, codebaseIds: ['A']};
    const bound = withAnalysisHistoryReader(selection,
      createAnalysisHistoryReader({getTurns: () => [productOnly], assertActive: () => {}}), {includeSourceDerived: false});
    const json = JSON.parse(JSON.stringify(bound));
    // Ordinary string keys are neither the issued reader nor its restriction:
    // the runtime reads its own turns, activated by the authorized selection.
    const runtime = createRuntimeAnalysisHistoryReader({options: {...json, includeSourceDerived: false},
      sessionId: 's', traceId: 'trace', getTurns: () => [source], assertActive: () => {}});
    expect(runtime.getTurns()).toEqual([source]);
  });

  it('activates source-derived history from the authorized selection, partitioned by exact fingerprint', () => {
    const scopeA = {...turn(0), sourceDerived: true, analysisContextFingerprint: 'scope-A', answer: 'SCOPE_A'};
    const scopeB = {...turn(1), sourceDerived: true, analysisContextFingerprint: 'scope-B', answer: 'SCOPE_B'};
    const unscoped = {...turn(2), sourceDerived: true, answer: 'NO_FINGERPRINT'};
    const publicTurn = turn(3);
    const read = (options: object) => createRuntimeAnalysisHistoryReader({options, sessionId: 'run', traceId: 'trace',
      getTurns: () => [scopeA, scopeB, unscoped, publicTurn], assertActive: () => {}}).getTurns();
    // Web and CLI analyze runs bind no reader; the selection alone activates.
    expect(read({analysisContextFingerprint: 'scope-A', codeAwareMode: 'provider_send', codebaseIds: ['A']}))
      .toEqual([scopeA, publicTurn]);
    expect(read({analysisContextFingerprint: 'scope-A', knowledgeSourceIds: ['kb']})).toEqual([scopeA, publicTurn]);
    for (const inactive of [{}, {codeAwareMode: 'off', codebaseIds: ['A']}, {codeAwareMode: 'provider_send', codebaseIds: []}]) {
      expect(read({analysisContextFingerprint: 'scope-A', ...inactive})).toEqual([publicTurn]);
    }
  });

  it('registers every private question the model can read for strict echo, whichever store supplied it', () => {
    const sessionId = 'history-echo-physical';
    const privateTurn = (index: number, id: string, fingerprint: string, query: string): AnalysisHistoryTurn =>
      ({...turn(index), id, sourceDerived: true, analysisContextFingerprint: fingerprint, query});
    const durableOnly = privateTurn(0, 'durable-only', 'scope-A', 'DURABLE_ONLY_PRIVATE_QUESTION about Foo::bar');
    const durableOriginal = privateTurn(1, 'same-run', 'scope-A', 'DURABLE_ORIGINAL_PRIVATE_QUESTION about Baz::qux');
    const otherScope = privateTurn(2, 'other-scope', 'scope-B', 'OTHER_SCOPE_PRIVATE_QUESTION');
    // An older CLI transcript stored a placeholder under the same run id.
    const localPlaceholder = {...durableOriginal, query: 'Private source or knowledge analysis request (original content not persisted)'};
    const archive = jest.spyOn(AnalysisHistoryStore.prototype, 'list').mockReturnValue([durableOnly, durableOriginal, otherScope]);
    try {
      const options = {tenantId: 't', workspaceId: 'w', userId: 'u', analysisContextFingerprint: 'scope-A',
        codeAwareMode: 'provider_send' as const, codebaseIds: ['A']};
      // The CLI binds its local transcript merged under the backend reader, which wins per run id.
      const backend = createRuntimeAnalysisHistoryReader({options, sessionId, traceId: 'trace',
        getTurns: () => [], assertActive: () => {}});
      const merged = createAnalysisHistoryReader({assertActive: () => {},
        getTurns: () => [...new Map([localPlaceholder, ...backend.getTurns()].map(entry => [entry.id, entry])).values()]});
      const runtime = createRuntimeAnalysisHistoryReader({options: withAnalysisHistoryReader(options, merged),
        sessionId, traceId: 'trace', getTurns: () => [], assertActive: () => {}});

      expect(runtime.getTurns().map(entry => entry.query).sort()).toEqual([durableOnly.query, durableOriginal.query].sort());
      const echo = `Earlier you asked ${durableOnly.query}; then ${durableOriginal.query}.`;
      const strict = sanitizeCodeAwareText(sessionId, echo);
      expect(strict).toContain('[PRIVATE_QUERY_REFERENCE]');
      expect(strict).not.toContain('DURABLE_ONLY_PRIVATE_QUESTION');
      expect(strict).not.toContain('DURABLE_ORIGINAL_PRIVATE_QUESTION');
      // The creator's own question stays readable to them.
      expect(sanitizeOwnerCodeAwareText(sessionId, echo)).toBe(echo);
      // A question the model cannot read is neither returned nor registered.
      expect(sanitizeCodeAwareText(sessionId, otherScope.query)).toBe(otherScope.query);
    } finally {
      archive.mockRestore();
      clearCodeAwareOutputGuards(sessionId);
    }
  });

  it('retains canonical artifactRefs and row selectors through conversion, persistence parsing and full pages', () => {
    const entry = toAnalysisHistoryTurn({id: 'located', turnIndex: 0, timestamp: 1, traceId: 'trace', query: 'Q',
      result: {message: 'A', completion: {status: 'completed'}, conclusionContract: {claims: [
        {artifactRefs: [{artifactId: 'art-1', rowSelector: {utid: 42, name: 'worker', active: true}, verified: true}]},
        {references: [{evidenceRefId: 'ev-2', sourceRef: 'source-2', rowSelector: {id: 7}, column: 'duration', value: 123, witness: 'fake'}]},
      ]}}});
    const expected = [{artifactId: 'art-1', rowSelector: {utid: 42, name: 'worker', active: true}},
      {evidenceRefId: 'ev-2', sourceRef: 'source-2', rowSelector: {id: 7}, column: 'duration'}];
    expect(entry.evidence).toEqual(expected);
    const parsed = parseAnalysisHistoryTurn(JSON.parse(JSON.stringify(entry)))!;
    expect(parsed.evidence).toEqual(expected);
    const page = createAnalysisHistoryReader({getTurns: () => [parsed], assertActive: () => {}}).read({turnId: entry.id});
    expect(JSON.parse(String(page.text)).evidence).toEqual(expected);
    expect(String(page.text)).not.toContain('witness');
    expect(String(page.text)).not.toContain('verified');
  });

  it.each(['archive', 'bound'] as const)('gates %s source history by its original exact fingerprint and current lease', mode => {
    const secret = {...turn(0), sourceDerived: true, analysisContextFingerprint: 'source-A', answer: 'SOURCE_A_SECRET'};
    const legacyPrivate = {...turn(1), sourceDerived: true, answer: 'MISSING_FINGERPRINT_SECRET'};
    const ordinary = {...turn(2), answer: 'PUBLIC_CONTEXT'};
    const archive = jest.spyOn(AnalysisHistoryStore.prototype, 'list').mockReturnValue([secret, legacyPrivate, ordinary]);
    let active = true;
    const assertActive = () => {if (!active) throw new Error('revoked');};
    const boundReader = createAnalysisHistoryReader({getTurns: () => [secret, legacyPrivate, ordinary], assertActive: () => {}});
    const make = (fingerprint?: string, includeSourceDerived = true) => {
      const options = {tenantId: 't', workspaceId: 'w', userId: 'u', analysisContextFingerprint: fingerprint};
      return createRuntimeAnalysisHistoryReader({options: mode === 'bound' ? withAnalysisHistoryReader(options, boundReader) : options,
        sessionId: 's', traceId: 'trace', getTurns: () => [], assertActive, includeSourceDerived});
    };
    try {
      for (const fingerprint of ['source-B', undefined, '']) {
        const reader = make(fingerprint);
        expect(reader.getTurns().map(item => item.id)).toEqual([ordinary.id]);
        expect(reader.read({turnId: secret.id})).toMatchObject({success: false});
        expect(reader.read({turnId: legacyPrivate.id})).toMatchObject({success: false});
      }
      const same = make('source-A');
      expect(same.getTurns().map(item => item.id)).toEqual([secret.id, ordinary.id]);
      const page = same.read({turnId: secret.id});
      expect(page).toMatchObject({success: true});
      expect(String(page.text)).toContain('SOURCE_A_SECRET');
      expect(String(page.text)).not.toContain('analysisContextFingerprint');
      expect(make('source-A', false).getTurns()).toEqual([ordinary]);
      active = false;
      expect(() => same.read({turnId: secret.id})).toThrow('revoked');
      expect(() => same.getTurns()).toThrow('revoked');
    } finally {archive.mockRestore();}
  });

  it('merges only stable run identities and keeps a fresh index-zero result newest', () => {
    const old = {...turn(7), id: 'old-run', timestamp: 100};
    const newest = {...turn(0), id: 'new-run', timestamp: 200, partial: true, completionStatus: 'incomplete' as const,
      terminationReason: 'turn_limit', uncertainties: ['NEW_MISSING_WORK']};
    const sameIndexOld = {...turn(0), id: 'different-old-run', timestamp: 50};
    const archive = jest.spyOn(AnalysisHistoryStore.prototype, 'list').mockReturnValue([sameIndexOld, old]);
    try {
      const reader = createRuntimeAnalysisHistoryReader({options: {tenantId: 't', workspaceId: 'w', userId: 'u'},
        sessionId: 's', traceId: 'trace', getTurns: () => [{...old, answer: 'unfinalized draft'}, newest], assertActive: () => {}});
      expect(reader.getTurns()).toEqual([sameIndexOld, old, newest]);
      expect(reader.read({}).entries).toEqual(expect.arrayContaining([expect.objectContaining({id: newest.id})]));
      const preview = renderAnalysisHistoryContext(reader.getTurns(), {outputLanguage: 'en', maxBytes: 2500})!;
      expect(preview).toContain('new-run');
      expect(preview).toContain('NEW_MISSING_WORK');
      expect(preview).not.toContain('unfinalized draft');
    } finally {archive.mockRestore();}
  });

  it('preserves partial and missing work without headings or success inference', () => {
    const entry = toAnalysisHistoryTurn({id: 'limited', turnIndex: 2, traceId: 'trace', timestamp: 1, query: 'Why?',
      result: {conclusion: 'A natural answer without headings.', partial: true,
        completion: {status: 'incomplete', reason: 'turn_limit'}, terminationMessage: 'budget reached',
        conclusionContract: {uncertainties: ['GPU evidence missing'], nextSteps: ['Inspect the fence'],
          claims: [{references: [{artifactId: 'art-1', rowIndex: 0, column: 'duration', verified: true}]}]}}});
    expect(entry).toMatchObject({partial: true, completionStatus: 'incomplete', terminationReason: 'turn_limit',
      uncertainties: ['GPU evidence missing'], nextSteps: ['Inspect the fence'], evidence: [{artifactId: 'art-1', rowIndex: 0, column: 'duration'}]});
    const legacy = toAnalysisHistoryTurn({id: 'legacy', turnIndex: 0, timestamp: 0, traceId: 'trace', query: 'Q', result: {message: 'All done'}});
    expect(legacy).toMatchObject({partial: true, completionStatus: 'unknown'});
    expect(parseAnalysisHistoryTurn({...entry, proof: 'forged'})).not.toHaveProperty('proof');
  });

  it('pages the complete turn including long text and late uncertainties with no new acquisition', () => {
    const entry = {...turn(), answer: 'Answer 中文 '.repeat(1000), uncertainties: ['early', 'late'], nextSteps: ['follow up']};
    const assertActive = jest.fn();
    const reader = createAnalysisHistoryReader({getTurns: () => [entry], assertActive});
    expect(reader.read({})).toMatchObject({kind: 'index', totalTurns: 1, entries: [{id: 'run-0'}]});
    let offset: number | null = 0;
    let text = '';
    while (offset !== null) {
      const page = reader.read({turnId: entry.id, textOffset: offset, maxChars: 127});
      text += page.text;
      offset = page.nextTextOffset as number | null;
    }
    expect(JSON.parse(text)).toEqual(entry);
    expect(assertActive).toHaveBeenCalled();
    expect(reader.read({turnId: 'another-session-id'})).toMatchObject({success: false, error: 'analysis_history_turn_unavailable'});
    expect(() => reader.read({limit: 0})).toThrow('invalid_page');
  });

  it('checks active authorization on every read and does not expose mutable backing data', () => {
    let active = true;
    const entry = turn();
    const reader = createAnalysisHistoryReader({getTurns: () => [entry], assertActive: () => {if (!active) throw new Error('revoked');}});
    reader.getTurns()[0].answer = 'changed';
    expect(reader.getTurns()[0].answer).toBe('answer-0');
    active = false;
    expect(() => reader.read({turnId: entry.id})).toThrow('revoked');
  });

  it('carries issued readers through spreads but rejects forged symbols and ignores JSON claims', () => {
    const reader = createAnalysisHistoryReader({getTurns: () => [turn()], assertActive: () => {}});
    const fallback = createAnalysisHistoryReader({getTurns: () => [], assertActive: () => {}});
    const options = withAnalysisHistoryReader({}, reader);
    expect(resolveAnalysisHistoryReader({...options}, fallback)).toBe(reader);
    expect(resolveAnalysisHistoryReader(JSON.parse(JSON.stringify(options)), fallback)).toBe(fallback);
    const symbol = Object.getOwnPropertySymbols(options)[0];
    expect(() => resolveAnalysisHistoryReader({[symbol]: {}}, fallback)).toThrow('binding_invalid');
  });

  it('filters dormant source-derived history from both prompt and on-demand reads', () => {
    const reader = createRuntimeAnalysisHistoryReader({options: {codeAwareMode: 'off'}, sessionId: 's', traceId: 'trace',
      getTurns: () => [{...turn(0), sourceDerived: true}, turn(1), {...turn(2), traceId: 'other-trace'}], assertActive: () => {}});
    expect(reader.getTurns().map(item => item.id)).toEqual(['run-1']);
    expect(reader.read({turnId: 'run-0'})).toMatchObject({success: false});
  });

  it('keeps the latest unfinished work before prose under a CJK byte budget', () => {
    const entries = Array.from({length: 40}, (_, i) => ({...turn(i), answer: '长回答'.repeat(800)}));
    entries[35] = {...entries[35], partial: true, completionStatus: 'incomplete', terminationReason: 'turn_limit',
      uncertainties: ['GPU_MISSING'], nextSteps: ['FOLLOW_UP']};
    const context = renderAnalysisHistoryContext(entries, {outputLanguage: 'en', maxBytes: 3000})!;
    expect(Buffer.byteLength(context)).toBeLessThanOrEqual(3000);
    expect(context).toContain('run-35');
    expect(context).toContain('turn_limit');
    expect(context).toContain('GPU_MISSING');
    expect(context).toContain('read_session_history');
    expect(context).toContain('"truncated":true');
  });
});
