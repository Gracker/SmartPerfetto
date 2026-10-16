// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

/**
 * The RAG admin routes echo only the reason tokens listed in
 * CALLER_FACING_RAG_REASONS. That list is fail-closed: a token missing from it
 * gets fixed text. This check makes adding a token a decision rather than an
 * accident: every token with a source, root, knowledge, codebase, consent or
 * lifecycle prefix that a producer of these routes' errors writes must be
 * listed as caller-facing or declared here as internal, and every listed token
 * must still be written somewhere.
 */

import * as fs from 'fs';
import * as path from 'path';

import {describe, expect, it} from '@jest/globals';

import {CALLER_FACING_RAG_REASONS} from '../ragAdminRoutes';

const SRC_ROOT = path.resolve(__dirname, '..', '..');

/** Modules whose thrown or reported reasons reach the RAG admin routes. */
const PRODUCERS = [
  'routes/ragAdminRoutes.ts',
  'services/rag',
  'services/knowledge',
  'services/externalKnowledgeSourceRegistry.ts',
  'services/scopedIngestLease.ts',
  'services/filesystemRegistryLock.ts',
  'services/ragStore.ts',
  'services/codebase/aospManifest.ts',
  'services/codebase/boundedMetadataFile.ts',
  'services/codebase/codebaseCapability.ts',
  'services/codebase/codebaseRegistry.ts',
  'services/codebase/codebaseRequestError.ts',
  'services/codebase/pathSecurityGate.ts',
  'services/codebase/sourceDisclosure.ts',
  'services/codebase/sourceEnumerator.ts',
  'services/codebase/sourceSelectionPolicy.ts',
];

/** Prefixed literals in those modules that are not answered to a caller. */
const INTERNAL_OR_NOT_A_REASON = new Set([
  // Store kinds, row scopes and the legacy generation id.
  'codebase_1',
  'codebase_ingest_lease',
  'codebase_registry',
  'codebase_registry_ref',
  'external_knowledge_ingest_lease',
  'external_knowledge_registry',
  'external_knowledge_source',
  // The routes' own fixed failure codes.
  'knowledge_source_consent_failed',
  // Invariants and process failures the caller cannot act on.
  'codebase_delete_not_started',
  'source_enumerator_failed',
  // On-demand search arguments; no RAG admin route reads a glob.
  'source_file_glob_invalid',
  // The generic fallback of a source read; its fixed text says the same.
  'source_read_failed',
  // A document collection's index: answered as a typed error with fixed text,
  // or invariants and a cancellation no route requests.
  'knowledge_index_unavailable',
  'knowledge_index_id_invalid',
  'knowledge_index_writer_closed',
  'knowledge_ingest_cancelled',
]);

const PREFIXED_TOKEN =
  /['"`]((?:root|source|knowledge|codebase|external_knowledge|submodule|pending_generation|provider_send|right_to_use)_[a-z0-9_]*[a-z0-9])(?=['"`:])/g;

function sourceFiles(relative: string): string[] {
  const absolute = path.join(SRC_ROOT, relative);
  if (fs.statSync(absolute).isFile()) return [absolute];
  return fs.readdirSync(absolute, {withFileTypes: true}).flatMap(entry => {
    if (entry.name === '__tests__') return [];
    const child = path.join(relative, entry.name);
    return entry.isDirectory() ? sourceFiles(child) : entry.name.endsWith('.ts') ? [path.join(SRC_ROOT, child)] : [];
  });
}

/** The catalog literal itself is not a producer; without this every entry would count as written. */
const CATALOG_LITERAL = /CALLER_FACING_RAG_REASONS: ReadonlySet<string> = new Set\(\[[\s\S]*?\]\);/;

function producedTokens(): Set<string> {
  const tokens = new Set<string>();
  for (const file of PRODUCERS.flatMap(sourceFiles)) {
    const text = fs.readFileSync(file, 'utf8');
    const producerText = text.replace(CATALOG_LITERAL, '');
    if (file.endsWith('ragAdminRoutes.ts') && producerText === text) throw new Error('catalog literal not found');
    for (const match of producerText.matchAll(PREFIXED_TOKEN)) tokens.add(match[1]);
  }
  return tokens;
}

describe('RAG admin caller-facing reason catalog', () => {
  const produced = producedTokens();

  it('classifies every prefixed token its producers write', () => {
    const unclassified = [...produced]
      .filter(token => !CALLER_FACING_RAG_REASONS.has(token) && !INTERNAL_OR_NOT_A_REASON.has(token))
      .sort();
    expect(unclassified).toEqual([]);
  });

  it('lists only tokens a producer still writes', () => {
    const stale = [...CALLER_FACING_RAG_REASONS, ...INTERNAL_OR_NOT_A_REASON]
      .filter(token => !produced.has(token))
      .sort();
    expect(stale).toEqual([]);
  });

  it('never lists one token as both public and internal', () => {
    expect([...INTERNAL_OR_NOT_A_REASON].filter(token => CALLER_FACING_RAG_REASONS.has(token))).toEqual([]);
  });
});
