// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import Database from 'better-sqlite3';
import {afterEach, beforeEach, describe, expect, it, jest} from '@jest/globals';

import {convertDocumentCollectionFile, type DocumentCollectionDocument} from '../documentCollectionCorpus';
import {DocumentCollectionStore, KnowledgeIndexUnavailableError} from '../documentCollectionStore';
import {
  knowledgeBm25,
  knowledgeFtsMatchExpression,
  knowledgeIndexTokenText,
  knowledgeQueryTokens,
} from '../knowledgeTokens';

const SCOPE = {tenantId: 'tenant-1', workspaceId: 'workspace-1', userId: 'user-1'};
const OTHER_SCOPE = {tenantId: 'tenant-1', workspaceId: 'workspace-1', userId: 'user-2'};
const SOURCE = `eks_${'a'.repeat(24)}`;
const generation = (seed: string) => `dc_${seed.repeat(32).slice(0, 32)}`;
const HELD = {assertHeld: () => undefined};

let tmpDir: string;
let store: DocumentCollectionStore;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'document-collection-store-'));
  store = new DocumentCollectionStore(tmpDir);
});

afterEach(() => {
  fs.rmSync(tmpDir, {recursive: true, force: true});
});

function documents(): DocumentCollectionDocument[] {
  return [
    convertDocumentCollectionFile('render/compositor.md', [
      '# 渲染线程',
      'XRenderCompositorWorker 负责合成每一帧，在 RenderThread 之后运行。',
      '',
      '## Known issues',
      'Frame pacing stalls when the worker waits on a fence.',
    ].join('\n'))!,
    convertDocumentCollectionFile('misc/notes.txt', 'Unrelated notes about binder transactions.\n')!,
    convertDocumentCollectionFile('titles/binder.md', '# Binder\nbody without the other word\n')!,
    // Unrelated pages give bm25 a corpus in which a rare term outweighs a common one.
    ...['input', 'memory', 'storage', 'network', 'battery', 'thermal'].map(topic =>
      convertDocumentCollectionFile(`filler/${topic}.md`, `# ${topic}\nGeneral notes on ${topic} behaviour.\n`)!),
  ];
}

function writeGeneration(id: string, scope = SCOPE): void {
  const writer = store.beginGeneration(scope, SOURCE, id);
  writer.writeBatch(documents());
  writer.commit({contentFingerprint: 'f'.repeat(64), documentCount: 9, sectionCount: 10, chunkCount: 10});
}

/** A fence that holds for `held` checks, then reports the lease lost. */
function fenceLostAfter(held: number) {
  let checks = 0;
  return {
    assertHeld: () => {
      checks += 1;
      if (checks > held) throw new Error('external_knowledge_reindex_lease_lost');
    },
  };
}

/** The one scope directory these tests write: SCOPE's. */
function sourceDirectory(): string {
  const [scopeDirectory] = fs.readdirSync(tmpDir);
  return path.join(tmpDir, scopeDirectory!, SOURCE);
}

describe('knowledge tokens', () => {
  it('splits identifiers and CJK so internal names and two-character terms match', () => {
    expect(knowledgeQueryTokens('XRenderCompositorWorker')).toEqual(
      expect.arrayContaining(['xrendercompositorworker', 'xrender', 'compositor', 'worker']));
    expect(knowledgeQueryTokens('渲染线程')).toEqual(expect.arrayContaining(['渲染', '染线', '线程']));
    expect(knowledgeIndexTokenText('foo_bar.baz')).toBe('foo_bar.baz foo bar baz');
  });

  it('builds one MATCH expression and one bm25 weighting for both knowledge stores', () => {
    expect(knowledgeFtsMatchExpression(['binder', '-', '_.$', 'say "hi"'])).toBe('"binder" OR "say ""hi"""');
    expect(knowledgeFtsMatchExpression(['-', '/'])).toBeUndefined();
    expect(knowledgeBm25('chunks_fts')).toBe('bm25(chunks_fts, 8.0, 5.0, 3.0, 1.0, 2.0)');
    expect(knowledgeBm25('chunks_fts', 1)).toBe('bm25(chunks_fts, 0.0, 8.0, 5.0, 3.0, 1.0, 2.0)');
  });
});

describe('DocumentCollectionStore', () => {
  it('finds internal identifiers, camelCase parts and CJK terms', () => {
    const id = generation('1');
    writeGeneration(id);
    const firstSection = expect.objectContaining({
      relativePath: 'render/compositor.md',
      title: '渲染线程',
      heading: '渲染线程',
      headingPath: ['渲染线程'],
      startLine: 1,
      endLine: 2,
    });
    // The exact identifier and the CJK terms rank the section that holds them first.
    for (const query of ['XRenderCompositorWorker', '线程', '合成']) {
      expect(store.search(SCOPE, SOURCE, id, query, 5)[0]).toEqual(firstSection);
    }
    // A camelCase part alone still finds it.
    expect(store.search(SCOPE, SOURCE, id, 'Compositor', 5)[0]).toEqual(firstSection);
    expect(store.search(SCOPE, SOURCE, id, 'CompositorWorker', 5)).toContainEqual(firstSection);
    const section = store.search(SCOPE, SOURCE, id, 'fence pacing', 5)[0];
    expect(section).toEqual(expect.objectContaining({
      heading: 'Known issues',
      headingPath: ['渲染线程', 'Known issues'],
      startLine: 4,
      endLine: 5,
    }));
    expect(section!.sectionId).toMatch(/^d[0-9a-f]{16}:1$/);
    expect(store.search(SCOPE, SOURCE, id, '- /', 5)).toEqual([]);
  });

  it('weights a title match above a body match', () => {
    const id = generation('2');
    writeGeneration(id);
    const hits = store.search(SCOPE, SOURCE, id, 'binder', 5);
    expect(hits.map(hit => hit.relativePath)).toEqual(['titles/binder.md', 'misc/notes.txt']);
  });

  it('reads the whole section a hit belongs to from the same generation', () => {
    const id = generation('5');
    writeGeneration(id);
    const hit = store.search(SCOPE, SOURCE, id, 'fence pacing', 5)[0]!;
    const section = store.readSection(SCOPE, SOURCE, id, hit.sectionId);
    expect(section).toMatchObject({sectionId: hit.sectionId, relativePath: 'render/compositor.md',
      heading: hit.heading, headingPath: hit.headingPath});
    expect(section!.body).toContain('Frame pacing stalls when the worker waits on a fence.');
    expect(section!.startLine).toBeLessThanOrEqual(hit.startLine);
    expect(section!.endLine).toBeGreaterThanOrEqual(hit.endLine);
    expect(store.readSection(SCOPE, SOURCE, id, 'd0000000000000000:9')).toBeUndefined();
    expect(() => store.readSection(OTHER_SCOPE, SOURCE, id, hit.sectionId)).toThrow(KnowledgeIndexUnavailableError);
  });

  it('treats a heading path it cannot read as an unavailable index, never quoting the stored text', () => {
    const id = generation('6');
    writeGeneration(id);
    const hit = store.search(SCOPE, SOURCE, id, 'fence pacing', 5)[0]!;
    const db = new Database(path.join(sourceDirectory(), `${id}.sqlite`));
    db.prepare('UPDATE sections SET heading_path_json = ?').run('{HEADING_CANARY');
    db.close();
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      expect(() => store.readSection(SCOPE, SOURCE, id, hit.sectionId)).toThrow(KnowledgeIndexUnavailableError);
      expect(() => store.search(SCOPE, SOURCE, id, 'fence pacing', 5)).toThrow(KnowledgeIndexUnavailableError);
      expect(JSON.stringify(warn.mock.calls)).not.toContain('HEADING_CANARY');
    } finally {
      warn.mockRestore();
    }
  });

  it('answers knowledge_index_unavailable for a missing file or one that is not the named generation', () => {
    const id = generation('3');
    expect(() => store.search(SCOPE, SOURCE, id, 'binder', 5)).toThrow(KnowledgeIndexUnavailableError);
    writeGeneration(id);
    const directory = sourceDirectory();
    const renamed = generation('4');
    fs.copyFileSync(path.join(directory, `${id}.sqlite`), path.join(directory, `${renamed}.sqlite`));
    expect(() => store.search(SCOPE, SOURCE, renamed, 'binder', 5)).toThrow(KnowledgeIndexUnavailableError);
    // Another scope resolves to another directory: the same ids find nothing there.
    expect(() => store.search(OTHER_SCOPE, SOURCE, id, 'binder', 5)).toThrow(KnowledgeIndexUnavailableError);
    expect(() => store.search(SCOPE, '../escape', id, 'binder', 5)).toThrow('knowledge_index_id_invalid');
  });

  it('opens readers read-only and leaves the file unchanged', () => {
    const id = generation('5');
    writeGeneration(id);
    const filePath = path.join(sourceDirectory(), `${id}.sqlite`);
    const before = fs.readFileSync(filePath);
    store.search(SCOPE, SOURCE, id, 'binder', 5);
    expect(fs.readFileSync(filePath).equals(before)).toBe(true);
    expect(fs.readdirSync(sourceDirectory()).sort()).toEqual([`${id}.sqlite`]);
  });

  it('writes to a staging file and only moves it into place on commit', () => {
    const id = generation('6');
    const writer = store.beginGeneration(SCOPE, SOURCE, id);
    writer.writeBatch(documents());
    expect(fs.readdirSync(sourceDirectory())).toEqual([`${id}.sqlite.staging`]);
    expect(() => store.search(SCOPE, SOURCE, id, 'binder', 5)).toThrow(KnowledgeIndexUnavailableError);
    writer.abort();
    expect(fs.readdirSync(sourceDirectory())).toEqual([]);
  });

  it('collects unreferenced generations and stale staging, keeping referenced ones and live staging', async () => {
    const [oldest, previous, current] = [generation('7'), generation('8'), generation('9')];
    for (const id of [oldest, previous, current]) writeGeneration(id);
    const directory = sourceDirectory();
    fs.writeFileSync(path.join(directory, `${generation('b')}.sqlite.staging`), 'crashed writer');
    fs.writeFileSync(path.join(directory, `${generation('b')}.sqlite.staging-journal`), 'crashed writer');
    fs.writeFileSync(path.join(directory, 'unrelated.txt'), 'not ours');
    const live = store.beginGeneration(SCOPE, SOURCE, generation('c'));

    expect(await store.collectGarbage(SCOPE, SOURCE, new Set([previous, current]), HELD)).toEqual({removed: 3, failed: 0});
    expect(fs.readdirSync(directory).sort()).toEqual([
      `${previous}.sqlite`,
      `${current}.sqlite`,
      `${generation('c')}.sqlite.staging`,
      'unrelated.txt',
    ].sort());
    live.abort();
  });

  it('leaves a generation it cannot delete for the next collection', async () => {
    const [kept, stuck] = [generation('f'), generation('0')];
    writeGeneration(kept);
    const directory = sourceDirectory();
    // A directory in a generation file's place cannot be removed as a file, like an open handle on Windows.
    fs.mkdirSync(path.join(directory, `${stuck}.sqlite`));
    expect(await store.collectGarbage(SCOPE, SOURCE, new Set([kept]), HELD)).toEqual({removed: 0, failed: 1});
    fs.rmdirSync(path.join(directory, `${stuck}.sqlite`));
    fs.writeFileSync(path.join(directory, `${stuck}.sqlite`), 'released');
    expect(await store.collectGarbage(SCOPE, SOURCE, new Set([kept]), HELD)).toEqual({removed: 1, failed: 0});
    expect(fs.readdirSync(directory)).toEqual([`${kept}.sqlite`]);
  });

  it('stores the FTS index contentless and the manifest from the corpus summary', () => {
    const id = generation('a');
    writeGeneration(id);
    const db = new Database(path.join(sourceDirectory(), `${id}.sqlite`), {readonly: true});
    try {
      const rows = db.prepare('SELECT body, tokens FROM chunks_fts').all() as Array<{body: unknown; tokens: unknown}>;
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.every(row => row.body === null && row.tokens === null)).toBe(true);
      const manifest = Object.fromEntries((db.prepare('SELECT key, value FROM manifest').all() as
        Array<{key: string; value: string}>).map(row => [row.key, JSON.parse(row.value)]));
      expect(manifest).toEqual(expect.objectContaining({documentCount: 9, sectionCount: 10, chunkCount: 10}));
    } finally {
      db.close();
    }
  });

  it('closes a cached reader before deleting its generation', async () => {
    const id = generation('b');
    writeGeneration(id);
    expect(store.search(SCOPE, SOURCE, id, 'binder', 5).length).toBeGreaterThan(0);
    store.removeGeneration(SCOPE, SOURCE, id, HELD);
    expect(() => store.search(SCOPE, SOURCE, id, 'binder', 5)).toThrow(KnowledgeIndexUnavailableError);
    writeGeneration(id);
    expect(store.search(SCOPE, SOURCE, id, 'binder', 5).length).toBeGreaterThan(0);
    await store.removeSource(SCOPE, SOURCE, HELD);
    expect(() => store.search(SCOPE, SOURCE, id, 'binder', 5)).toThrow(KnowledgeIndexUnavailableError);
  });

  it('stops deleting at once when the lease is lost part way through a cleanup', async () => {
    writeGeneration(generation('c'));
    const directory = sourceDirectory();
    for (let index = 0; index < 40; index += 1) {
      fs.writeFileSync(path.join(directory, `${generation(index.toString(16).padStart(2, '0'))}.sqlite`), 'old');
    }
    const before = fs.readdirSync(directory).length;
    await expect(store.collectGarbage(SCOPE, SOURCE, new Set([generation('c')]), fenceLostAfter(1)))
      .rejects.toThrow('external_knowledge_reindex_lease_lost');
    // One batch of 16 went before the second check failed; nothing after it.
    expect(fs.readdirSync(directory).length).toBe(before - 16);

    await expect(store.removeSource(SCOPE, SOURCE, fenceLostAfter(0)))
      .rejects.toThrow('external_knowledge_reindex_lease_lost');
    expect(fs.readdirSync(directory).length).toBe(before - 16);
    await expect(store.removeSource(SCOPE, SOURCE, fenceLostAfter(1)))
      .rejects.toThrow('external_knowledge_reindex_lease_lost');
    expect(fs.existsSync(directory)).toBe(true);
    expect(() => store.removeGeneration(SCOPE, SOURCE, generation('c'), fenceLostAfter(0)))
      .toThrow('external_knowledge_reindex_lease_lost');
    expect(fs.existsSync(path.join(directory, `${generation('c')}.sqlite`))).toBe(true);
  });

  it('does not reuse a cached reader once its file was deleted or replaced elsewhere', () => {
    const [kept, other] = [generation('7'), generation('8')];
    writeGeneration(kept);
    writeGeneration(other);
    expect(store.search(SCOPE, SOURCE, kept, 'binder', 5).length).toBeGreaterThan(0);
    const file = path.join(sourceDirectory(), `${kept}.sqlite`);
    // Replaced by another generation's bytes: the manifest no longer names this generation.
    fs.copyFileSync(path.join(sourceDirectory(), `${other}.sqlite`), file);
    expect(() => store.search(SCOPE, SOURCE, kept, 'binder', 5)).toThrow(KnowledgeIndexUnavailableError);
    fs.unlinkSync(file);
    expect(() => store.search(SCOPE, SOURCE, kept, 'binder', 5)).toThrow(KnowledgeIndexUnavailableError);
  });

  (process.platform === 'win32' ? it.skip : it)(
    'fails a cleanup whose directory cannot be read, instead of reporting it clean', async () => {
      writeGeneration(generation('9'));
      const directory = sourceDirectory();
      fs.chmodSync(directory, 0o000);
      try {
        await expect(store.removeSource(SCOPE, SOURCE, HELD)).rejects.toThrow();
      } finally {
        fs.chmodSync(directory, 0o755);
      }
      expect(fs.readdirSync(directory)).toEqual([`${generation('9')}.sqlite`]);
      // A directory that is already gone is clean.
      await store.removeSource(SCOPE, SOURCE, HELD);
      await store.removeSource(SCOPE, SOURCE, HELD);
    });

  it('removes one generation or the whole source', async () => {
    const [first, second] = [generation('d'), generation('e')];
    writeGeneration(first);
    writeGeneration(second);
    store.removeGeneration(SCOPE, SOURCE, first, HELD);
    store.removeGeneration(SCOPE, SOURCE, first, HELD);
    expect(fs.readdirSync(sourceDirectory())).toEqual([`${second}.sqlite`]);
    await store.removeSource(SCOPE, SOURCE, HELD);
    expect(() => store.search(SCOPE, SOURCE, second, 'binder', 5)).toThrow(KnowledgeIndexUnavailableError);
    await store.removeSource(SCOPE, SOURCE, HELD);
  });
});
