// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {describe, expect, it} from '@jest/globals';

import {
  isKnowledgeRefusalAction,
  KNOWLEDGE_REFUSAL_ACTIONS,
  KnowledgeReferenceLedger,
  splitKnowledgeSection,
} from '../knowledgeTools';

const binding = {
  scopeKey: 'tenant\0workspace\0user',
  sourceId: 'eks_' + 'a'.repeat(24),
  generation: 'dc_' + 'b'.repeat(32),
  sectionId: 'd1:0',
  chunkId: 'd1:0:0',
  lineRange: {start: 1, end: 4},
};

describe('KnowledgeReferenceLedger', () => {
  it('issues one random kref per delivered hit and resolves only what it issued', () => {
    const ledger = new KnowledgeReferenceLedger();
    const id = ledger.issue(binding);
    expect(id).toMatch(/^kref-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(ledger.issue({...binding})).toBe(id);
    expect(ledger.issue({...binding, chunkId: 'd1:0:1'})).not.toBe(id);
    expect(ledger.resolve(id)).toEqual(binding);
    expect(ledger.resolve('kref-00000000-0000-0000-0000-000000000000')).toBeUndefined();
    expect(new KnowledgeReferenceLedger().resolve(id)).toBeUndefined();
  });

  it('remembers delivered parts per section, through any reference to it', () => {
    const ledger = new KnowledgeReferenceLedger();
    ledger.recordDelivered(binding, 1, {partCount: 2, truncated: false});
    expect(ledger.deliveredPart({...binding, chunkId: 'd1:0:1'}, 1)).toEqual({partCount: 2, truncated: false});
    expect(ledger.deliveredPart(binding, 2)).toBeUndefined();
    expect(ledger.deliveredPart({...binding, generation: 'dc_' + 'c'.repeat(32)}, 1)).toBeUndefined();
  });
});

describe('splitKnowledgeSection', () => {
  it('splits deterministically at a line break in the second half, within the limit', () => {
    const body = Array.from({length: 20}, (_, index) => `line ${index} text`).join('\n');
    const parts = splitKnowledgeSection(body, 50);
    expect(parts.join('')).toBe(body);
    expect(parts.every(part => part.length <= 50)).toBe(true);
    expect(parts.slice(0, -1).every(part => part.endsWith('\n'))).toBe(true);
    expect(splitKnowledgeSection(body, 50)).toEqual(parts);
  });

  it('cuts a long line by characters without splitting a surrogate pair', () => {
    const body = `${'a'.repeat(9)}😀${'b'.repeat(20)}`;
    const parts = splitKnowledgeSection(body, 10);
    expect(parts.join('')).toBe(body);
    expect(parts[0]).toBe('a'.repeat(9));
    expect(parts[1]!.startsWith('😀')).toBe(true);
    expect(splitKnowledgeSection('', 10)).toEqual(['']);
  });
});

describe('knowledge refusal actions', () => {
  it('projects only the closed set it issues', () => {
    for (const action of Object.values(KNOWLEDGE_REFUSAL_ACTIONS)) expect(isKnowledgeRefusalAction(action)).toBe(true);
    expect(isKnowledgeRefusalAction('read render/compositor.md instead')).toBe(false);
    expect(isKnowledgeRefusalAction(undefined)).toBe(false);
  });
});
