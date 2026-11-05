// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {describe, expect, it, jest} from '@jest/globals';
import {createHash} from 'node:crypto';
import {AnalysisHistoryContextBudgetError, createAnalysisHistoryReader, createRuntimeAnalysisHistoryReader, renderAnalysisHistoryContext,
  resolveAnalysisHistoryReader, toAnalysisHistoryTurn, withAnalysisHistoryReader, type AnalysisHistoryTurn} from '../analysisHistory';
import {AnalysisHistoryStore, parseAnalysisHistoryTurn} from '../../services/analysisHistoryStore';
import {clearCodeAwareOutputGuards, sanitizeCodeAwareText, sanitizeOwnerCodeAwareText} from '../../services/security/codeAwareOutputRegistry';
import {renderRequiredLocalizedStrategyTemplate} from '../../agentv3/localizedStrategyTemplate';
import {ConversationPendingContext} from '../../assistant/application/conversationPendingContext';

function turn(index = 0): AnalysisHistoryTurn {
  return toAnalysisHistoryTurn({id: `run-${index}`, turnIndex: index, traceId: 'trace', timestamp: index,
    query: `question-${index}`, result: {message: `answer-${index}`,
      completion: {status: 'completed'}, conclusionContract: {uncertainties: [], nextSteps: []}}});
}

interface HistoryContextCase {
  id: string;
  outputLanguage: 'zh-CN' | 'en';
  budgets: number[];
  turns: AnalysisHistoryTurn[];
  reader?: {sessionId: string; traceId: string; options: {analysisContextFingerprint: string;
    codeAwareMode: 'provider_send'; codebaseIds: string[]}};
  expectations: {latestId: string; latestIncompleteId?: string; mustRetainIncompleteAtOrAbove?: number;
    relatedToLatest?: string[]; neverRelatedToLatest?: string[]; authorizedIds?: string[]; forbiddenText?: string[]};
}

/** Six inputs frozen before changing the renderer; data, budgets and case order are fingerprinted. */
function historyContextCases(): HistoryContextCase[] {
  const entry = (index: number, prefix: string): AnalysisHistoryTurn => ({id: `${prefix}-${index}`, turnIndex: index,
    timestamp: 1793850000000 + index * 1000, traceId: 'trace-main', query: `Question ${index}: inspect this interval.`,
    answer: `Answer ${index}: this is a bounded historical result.`, partial: false, completionStatus: 'completed',
    uncertainties: [], nextSteps: [], evidence: []});
  const locator = (index: number) => ({artifactId: `art-${index + 1}`, evidenceRefId: `fixture-evidence-${index}`,
    sourceToolCallId: `fixture-call-${index}`, traceId: 'trace-main', rowIndex: index, column: 'duration_ns',
    rowSelector: {id: index, active: true}});
  const cases: HistoryContextCase[] = [];
  const tight = Array.from({length: 6}, (_, i) => entry(i, 'tight'));
  for (const item of tight) item.answer = 'Historical answer with enough detail to require spilling. '.repeat(100);
  Object.assign(tight[1], {partial: true, completionStatus: 'incomplete', terminationReason: 'turn_limit',
    terminationMessage: 'Required GPU evidence was not collected.',
    uncertainties: ['GPU_EVIDENCE_UNAVAILABLE', 'SCHEDULING_SCOPE_UNCONFIRMED'],
    nextSteps: ['Read the original scope before another investigation.']});
  tight[5].query = 'LATEST_COMPLETE_QUESTION';
  tight[5].answer = `LATEST_COMPLETE_ANSWER ${tight[5].answer}`;
  tight[5].evidence = Array.from({length: 7}, (_, i) => locator(i));
  cases.push({id: 'latest-complete-older-incomplete', outputLanguage: 'en', budgets: [1800, 3000, 6000, 12000],
    turns: tight, expectations: {latestId: 'tight-5', latestIncompleteId: 'tight-1', mustRetainIncompleteAtOrAbove: 3000}});
  for (const language of ['zh-CN', 'en'] as const) {
    const entries = Array.from({length: 20}, (_, i) => entry(i, language === 'zh-CN' ? 'zh' : 'en'));
    for (const [index, item] of entries.entries()) {
      item.query = (language === 'zh-CN' ? `问题${index}：核对本次启动区间，不改变分析范围。`
        : `Question ${index}: examine the original startup interval without widening its scope. `).repeat(8);
      item.answer = (language === 'zh-CN' ? '历史说明：数据不足并不等于零。😀 引号“示例”与换行\n仍属于普通文本。'
        : 'Historical explanation: missing evidence is not zero. 😀 Quoted "example" and a newline\nremain ordinary text. ').repeat(180);
      item.uncertainties = Array.from({length: 6}, (_, j) => (language === 'zh-CN' ? `不足${j}：需要核对原始数据来源。`
        : `Uncertainty ${j}: original source data must be checked. `).repeat(15));
      item.nextSteps = Array.from({length: 5}, (_, j) => (language === 'zh-CN' ? `下一步${j}：只读取已授权的历史定位。`
        : `Next step ${j}: read only the authorized historical locator. `).repeat(10));
      item.evidence = Array.from({length: 7}, (_, j) => locator(index * 10 + j));
    }
    Object.assign(entries[15], {partial: true, completionStatus: 'unknown', terminationReason: 'execution_error'});
    cases.push({id: language === 'zh-CN' ? 'long-chinese' : 'long-english', outputLanguage: language,
      budgets: [3000, 6000, 12000], turns: entries,
      expectations: {latestId: entries[19].id, latestIncompleteId: entries[15].id, mustRetainIncompleteAtOrAbove: 3000}});
  }
  const shared = locator(3);
  const related = Array.from({length: 5}, (_, i) => entry(i, 'same-locator'));
  for (const index of [0, 4]) related[index].evidence = [{...shared}];
  related[2].evidence = [{...shared, rowSelector: {active: true, id: 3}}];
  related[1].evidence = [{...shared, column: 'cpu_time_ns'}];
  related[3].evidence = [{...shared, rowIndex: 4}];
  cases.push({id: 'complete-stable-locator-match', outputLanguage: 'en', budgets: [3000, 6000, 12000], turns: related,
    expectations: {latestId: 'same-locator-4', relatedToLatest: ['same-locator-2', 'same-locator-0'],
      neverRelatedToLatest: ['same-locator-3', 'same-locator-1']}});
  const collision = Array.from({length: 6}, (_, i) => entry(i, 'collision'));
  for (const item of collision) {item.query = 'The same question'; item.evidence = [{artifactId: 'art-1'}];}
  collision[1].traceId = 'trace-other'; collision[2].traceId = '';
  collision[3].evidence = [{...locator(3), traceId: 'trace-conflict'}];
  collision[4].evidence = [{sourceRef: 'src/example.kt'}];
  cases.push({id: 'same-query-different-identity', outputLanguage: 'en', budgets: [3000, 6000, 12000], turns: collision,
    expectations: {latestId: 'collision-5', relatedToLatest: []}});
  const authorized = Array.from({length: 4}, (_, i) => entry(i, 'auth'));
  Object.assign(authorized[0], {sourceDerived: true, analysisContextFingerprint: 'fixture-old-scope',
    query: 'OLD_SCOPE_PRIVATE_CANARY', answer: 'OLD_SCOPE_ANSWER_CANARY'});
  Object.assign(authorized[1], {sourceDerived: true, query: 'NO_SCOPE_PRIVATE_CANARY', answer: 'NO_SCOPE_ANSWER_CANARY'});
  Object.assign(authorized[2], {sourceDerived: true, analysisContextFingerprint: 'fixture-current-scope',
    query: 'CURRENT_SCOPE_AUTHORIZED_CANARY', answer: 'CURRENT_SCOPE_AUTHORIZED_ANSWER'});
  for (const item of authorized) item.evidence = [locator(8)];
  cases.push({id: 'source-history-authorization-filter', outputLanguage: 'en', budgets: [3000, 6000, 12000], turns: authorized,
    reader: {sessionId: 'fixture-physical-run', traceId: 'trace-main', options: {analysisContextFingerprint: 'fixture-current-scope',
      codeAwareMode: 'provider_send', codebaseIds: ['fixture-codebase']}}, expectations: {authorizedIds: ['auth-2', 'auth-3'],
      forbiddenText: ['OLD_SCOPE_PRIVATE_CANARY', 'OLD_SCOPE_ANSWER_CANARY', 'NO_SCOPE_PRIVATE_CANARY', 'NO_SCOPE_ANSWER_CANARY'],
      latestId: 'auth-3', relatedToLatest: []}});
  return cases;
}

function historyPreviewPayload(context: string): any {
  return JSON.parse(context.slice(context.indexOf('\n{') + 1));
}

describe('supplemental input in shared analysis history', () => {
  it.each(['zh-CN', 'en'] as const)('retains the actual %s question before long notes in preview and full history', outputLanguage => {
    const pending = new ConversationPendingContext();
    const question = outputLanguage === 'zh-CN' ? '本轮要核对哪段耗时？' : 'Which interval is slow?';
    const note = 'Previously queued background; this is not the current question. '.repeat(90);
    pending.append({expectedQueueEpoch: pending.epoch, expectedRunId: 'previous-run',
      idempotencyKey: 'queued-note', text: note}, 'previous-run');
    const prepared = pending.prepare(question, outputLanguage);
    const entry = toAnalysisHistoryTurn({id: 'latest-run', turnIndex: 1, traceId: 'trace', timestamp: 1,
      query: prepared.query, result: {message: 'The interval needs a scoped check.', completion: {status: 'completed'}}});
    for (const maxBytes of [1800, 6000, 12000]) {
      const context = renderAnalysisHistoryContext([entry], {outputLanguage, maxBytes})!;
      expect(Buffer.byteLength(context, 'utf8')).toBeLessThanOrEqual(maxBytes);
      expect(historyPreviewPayload(context).recent[0].query).toContain(question);
    }
    const reader = createAnalysisHistoryReader({getTurns: () => [entry], assertActive: () => {}});
    expect((reader.read({}).entries as Array<{query: string}>)[0].query).toContain(question);
    let offset: number | null = 0;
    let serialized = '';
    while (offset !== null) {
      const page = reader.read({turnId: entry.id, textOffset: offset, maxChars: 127});
      serialized += page.text;
      offset = page.nextTextOffset as number | null;
    }
    expect(JSON.parse(serialized).query).toBe(prepared.query);
    expect(prepared.query).toContain(note);
    expect(prepared.ids).toEqual(['queued-note']);
  });
});

describe('fixed history context comparison inputs', () => {
  const cases = historyContextCases();
  it('retains the six-case input fingerprint frozen before implementation', () => {
    const payload = {schemaVersion: 1, kind: 'synthetic-context-contract-baseline', caseOrder: cases.map(item => item.id), cases};
    expect(createHash('sha256').update(`${JSON.stringify(payload, null, 2)}\n`).digest('hex'))
      .toBe('c09f84e45f94581a0ac1d1274039c7127212da60855e410760ab4b965b0f42f2');
  });
  it.each(cases.flatMap(input => input.budgets.map(maxBytes => ({input, maxBytes}))))(
    '$input.id within $maxBytes bytes', ({input, maxBytes}) => {
      const entries = input.reader ? createRuntimeAnalysisHistoryReader({...input.reader,
        getTurns: () => input.turns, assertActive: () => {}}).getTurns() : input.turns;
      const context = renderAnalysisHistoryContext(entries, {outputLanguage: input.outputLanguage, maxBytes});
      const payload = context ? historyPreviewPayload(context) : undefined;
      console.info('[HistoryContextCase]', JSON.stringify({id: input.id, maxBytes, bytes: context ? Buffer.byteLength(context) : null,
        available: context !== undefined, latest: payload?.recent.find((item: any) => item.id === input.expectations.latestId) ?? null,
        incomplete: payload?.recent.find((item: any) => item.id === input.expectations.latestIncompleteId) ?? null,
        recentIds: payload?.recent.map((item: any) => item.id) ?? [], earlierIds: payload?.earlier.map((item: any) => item.id) ?? [],
        omittedTurns: payload?.omittedTurns, unlistedTurns: payload?.unlistedTurns}));
      expect(context).toBeDefined();
      expect(Buffer.byteLength(context!)).toBeLessThanOrEqual(maxBytes);
      expect(payload.recent[0].id).toBe(input.expectations.latestId);
      expect(payload.recent[0].answer.length).toBeGreaterThan(0);
      if (input.expectations.latestIncompleteId && maxBytes >= input.expectations.mustRetainIncompleteAtOrAbove!) {
        const incomplete = payload.recent.find((item: any) => item.id === input.expectations.latestIncompleteId);
        expect(incomplete).toBeDefined();
        expect(incomplete.completionStatus).not.toBe('completed');
        expect(incomplete.uncertainties.length).toBeGreaterThan(0);
        expect(incomplete.nextSteps.length).toBeGreaterThan(0);
      }
      expect(payload.omittedTurns).toBe(entries.length - payload.recent.length);
      expect(payload.unlistedTurns).toBe(entries.length - new Set([...payload.recent, ...payload.earlier].map((item: any) => item.id)).size);
      for (const item of payload.recent) {
        const original = entries.find(turn => turn.id === item.id)!;
        expect(item.evidenceCount).toBe(original.evidence.length);
        expect(item.omittedEvidence).toBe(original.evidence.length - item.evidence.length);
        expect(item.omittedUncertainties).toBe(original.uncertainties.length - item.uncertainties.length);
        expect(item.omittedNextSteps).toBe(original.nextSteps.length - item.nextSteps.length);
        if (item.omittedEvidence || item.omittedUncertainties || item.omittedNextSteps) expect(item.truncated).toBe(true);
      }
      const reader = createAnalysisHistoryReader({getTurns: () => entries, assertActive: () => {}});
      if (input.expectations.relatedToLatest) expect(reader.read({turnId: input.expectations.latestId}).relatedTurnIds)
        .toEqual(input.expectations.relatedToLatest);
      for (const item of [...payload.recent, ...payload.earlier]) expect(reader.read({turnId: item.id})).toMatchObject({success: true});
      for (const forbidden of input.expectations.forbiddenText ?? []) expect(context).not.toContain(forbidden);
      if (input.reader) clearCodeAwareOutputGuards(input.reader.sessionId);
    });
});

describe('typed analysis history', () => {
  it('carries product-resolved source activation through real runtime wrappers', () => {
    const source = {...turn(), sourceDerived: true, analysisContextFingerprint: 'scope-A', answer: 'AUTHORIZED_SOURCE_HISTORY'};
    const missingFingerprint = {...turn(1), sourceDerived: true, answer: 'LEGACY_PRIVATE_HISTORY'};
    const publicTurn = turn(2);
    let productActive = true;
    let runtimeActive = true;
    const productReader = createAnalysisHistoryReader({getTurns: () => [source, missingFingerprint, publicTurn],
      assertActive: () => {if (!productActive) throw new Error('product_revoked');}});
    const baseOptions = {analysisContextFingerprint: 'scope-A', codeAwareMode: 'provider_send' as const, codebaseIds: ['A']};
    const bound = withAnalysisHistoryReader(baseOptions, productReader, {includeSourceDerived: true});
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

  it('distinguishes empty history from an impossible budget without exposing historical content', () => {
    expect(renderAnalysisHistoryContext([], {maxBytes: 0})).toBeUndefined();
    const secret = {...turn(), query: 'PRIVATE_QUESTION_CANARY', answer: 'PRIVATE_ANSWER_CANARY'};
    for (const maxBytes of [0, 1, -1, NaN, 0.5]) {
      try {
        renderAnalysisHistoryContext([secret], {maxBytes});
        throw new Error('expected a budget failure');
      } catch (error) {
        expect(error).toBeInstanceOf(AnalysisHistoryContextBudgetError);
        expect(String(error)).toBe('AnalysisHistoryContextBudgetError: analysis_history_context_budget_exceeded');
        expect(error).not.toHaveProperty('cause');
      }
    }
  });

  it('falls back to intact continuation locators when detailed previews cannot fit', () => {
    const entries = [0, 1].map(index => ({...turn(index), query: 'long question '.repeat(300), answer: 'long answer '.repeat(1000),
      uncertainties: ['Missing original evidence.'], nextSteps: ['Read original history.']}));
    entries[0] = {...entries[0], partial: true, completionStatus: 'incomplete'};
    const overhead = Buffer.byteLength(renderRequiredLocalizedStrategyTemplate('prompt-runtime-history', 'en', {history: ''}));
    const maxBytes = overhead + 450;
    const context = renderAnalysisHistoryContext(entries, {outputLanguage: 'en', maxBytes})!;
    const payload = historyPreviewPayload(context);
    expect(Buffer.byteLength(context)).toBeLessThanOrEqual(maxBytes);
    expect(payload).toMatchObject({previewUnavailable: 'byte_budget', omittedTurns: 2, unlistedTurns: 0, recent: [],
      earlier: [{id: 'run-1', completionStatus: 'completed'}, {id: 'run-0', completionStatus: 'incomplete'}]});
  });

  it('keeps a valid continuation inside the existing 900-byte caller limit', () => {
    const entry = {...turn(), answer: 'Large historical reply. '.repeat(1000)};
    const context = renderAnalysisHistoryContext([entry], {outputLanguage: 'zh-CN', maxBytes: 900})!;
    expect(Buffer.byteLength(context)).toBeLessThanOrEqual(900);
    expect(context).toContain('read_session_history');
    expect(historyPreviewPayload(context)).toMatchObject({previewUnavailable: 'byte_budget',
      earlier: [{id: entry.id, completionStatus: 'completed'}]});
  });

  it.each([6000, 12000])('spills oversized metadata and locators within the %i-byte production budget', maxBytes => {
    const entry = {...turn(), traceId: 'huge-trace'.repeat(2000), answer: '😀'.repeat(4000),
      evidence: [{artifactId: 'art-1', sourceRef: 'LONG_LOCATOR_CANARY'.repeat(10000)}]};
    const context = renderAnalysisHistoryContext([entry], {outputLanguage: 'en', maxBytes})!;
    expect(Buffer.byteLength(context)).toBeLessThanOrEqual(maxBytes);
    const item = historyPreviewPayload(context).recent[0];
    expect(item).toMatchObject({id: entry.id, evidenceCount: 1, omittedEvidence: 1, evidence: [], truncated: true});
    expect(context).not.toContain('LONG_LOCATOR_CANARY');
    expect(item.answer).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/u);
    expect(() => renderAnalysisHistoryContext([{...entry, id: 'PRIVATE_ID_CANARY'.repeat(2000)}], {maxBytes}))
      .toThrow(AnalysisHistoryContextBudgetError);
  });

  it('never links ambiguous local IDs, changed locator fields or authorization partitions', () => {
    const ref = {artifactId: 'art-1', evidenceRefId: 'evidence', sourceToolCallId: 'tool', traceId: 'trace',
      rowIndex: 0, rowSelector: {upid: 10, name: 'main'}, column: 'dur'};
    const first = {...turn(0), evidence: [ref]};
    const exact = {...turn(1), evidence: [{...ref, rowSelector: {name: 'main', upid: 10}}]};
    const different = [
      {...turn(2), evidence: [{artifactId: 'art-1'}]},
      {...turn(3), evidence: [{sourceRef: 'source'}]},
      {...turn(4), traceId: 'other', evidence: [ref]},
      {...turn(5), evidence: [{...ref, rowIndex: 1}]},
      {...turn(6), evidence: [{...ref, column: 'cpu'}]},
      {...turn(7), evidence: [{...ref, traceId: ''}]},
      {...turn(8), sourceDerived: true, analysisContextFingerprint: 'scope-A', evidence: [ref]},
      {...turn(9), evidence: [{...ref, sourceToolCallId: ' '}]},
      {...turn(10), evidence: [{...ref, sourceRef: ''}]},
      {...turn(11), evidence: [{...ref, rowSelector: {}}]},
    ];
    const reader = createAnalysisHistoryReader({getTurns: () => [first, exact, ...different], assertActive: () => {}});
    expect(reader.read({turnId: first.id}).relatedTurnIds).toEqual([exact.id]);
    const privateReader = createAnalysisHistoryReader({getTurns: () => [
      {...first, sourceDerived: true, analysisContextFingerprint: 'scope-A'},
      {...exact, sourceDerived: true, analysisContextFingerprint: 'scope-B'},
    ], assertActive: () => {}});
    expect(privateReader.read({turnId: first.id}).relatedTurnIds).toEqual([]);
    expect(JSON.stringify(reader.read({turnId: first.id}))).not.toContain('scope-A');
  });

  it('bounds navigation to two recent exact matches and keeps full turn paging unchanged', () => {
    const entries = Array.from({length: 5}, (_, index) => ({...turn(index),
      evidence: [{evidenceRefId: 'same-evidence', sourceToolCallId: 'same-call', traceId: 'trace', rowIndex: 0}]}));
    const reader = createAnalysisHistoryReader({getTurns: () => entries, assertActive: () => {}});
    const response = reader.read({turnId: entries[0].id});
    expect(response.relatedTurnIds).toEqual(['run-4', 'run-3']);
    expect(JSON.parse(String(response.text))).toEqual(entries[0]);
    expect(reader.getTurns()).toEqual(entries);
  });
});
