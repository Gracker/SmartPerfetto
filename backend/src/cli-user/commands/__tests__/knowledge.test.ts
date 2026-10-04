// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, jest} from '@jest/globals';

import {
  runKnowledgeListCommand,
  runKnowledgePreviewCommand,
  runKnowledgeRegisterCommand,
  runKnowledgeReindexCommand,
  runKnowledgeRemoveCommand,
  runKnowledgeSearchCommand,
} from '../knowledge';
import {resetCliEnvironmentForTesting} from '../../bootstrap';

let tmpDir: string;
let docsRoot: string;
let logSpy: jest.SpiedFunction<typeof console.log>;
let errorSpy: jest.SpiedFunction<typeof console.error>;
const savedEnv: Record<string, string | undefined> = {};
const ENV_KEYS = ['SMARTPERFETTO_BACKEND_DATA_DIR', 'SMARTPERFETTO_BACKEND_LOG_DIR', 'SMARTPERFETTO_KNOWLEDGE_ROOTS'];

beforeAll(() => {
  tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cli-knowledge-')));
  for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
  // Every store this file touches lives under the temp directory; no allowlist is configured.
  process.env.SMARTPERFETTO_BACKEND_DATA_DIR = path.join(tmpDir, 'data');
  process.env.SMARTPERFETTO_BACKEND_LOG_DIR = path.join(tmpDir, 'logs');
  delete process.env.SMARTPERFETTO_KNOWLEDGE_ROOTS;
  docsRoot = path.join(tmpDir, 'team docs');
  fs.mkdirSync(path.join(docsRoot, 'render'), {recursive: true});
  fs.writeFileSync(path.join(docsRoot, 'render/compositor.md'), [
    '# Render framework', '', '## XRenderCompositorWorker', '',
    'XRenderCompositorWorker composes every frame and waits on the frame fence.',
  ].join('\n'));
  fs.writeFileSync(path.join(docsRoot, 'image.png'), 'not a document');
});

afterAll(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  fs.rmSync(tmpDir, {recursive: true, force: true});
});

beforeEach(() => {
  resetCliEnvironmentForTesting();
  logSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
  errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  logSpy.mockRestore();
  errorSpy.mockRestore();
});

const sessionDir = () => path.join(tmpDir, 'sessions');
const lastJson = () => JSON.parse(String(logSpy.mock.calls[logSpy.mock.calls.length - 1]?.[0]));
const printed = () => [...logSpy.mock.calls, ...errorSpy.mock.calls].map(call => call.join(' ')).join('\n');

describe('smp knowledge', () => {
  it('previews, registers with explicit rights, indexes, lists, searches and removes a document folder', async () => {
    expect(await runKnowledgePreviewCommand({rootPath: docsRoot, sessionDir: sessionDir(), format: 'json'})).toBe(0);
    expect(lastJson()).toMatchObject({success: true, preview: {documentCount: 1}});

    // Rights are never implied.
    expect(await runKnowledgeRegisterCommand({rootPath: docsRoot, sessionDir: sessionDir(), format: 'json'})).toBe(2);
    expect(lastJson()).toMatchObject({success: false, code: 'KNOWLEDGE_SOURCE_RIGHTS_REQUIRED'});

    expect(await runKnowledgeRegisterCommand({rootPath: docsRoot, sessionDir: sessionDir(), format: 'json',
      acceptRights: true, name: 'Team docs', description: 'Render framework notes'})).toBe(0);
    const registered = lastJson();
    const sourceId = registered.source.sourceId as string;
    expect(registered.source).toMatchObject({kind: 'document_collection', displayName: 'Team docs',
      description: 'Render framework notes', rightsAcknowledged: true, sendToProvider: false, hasActiveIndex: false});
    // Consent left out keeps the one in effect; the flag grants it explicitly.
    expect(await runKnowledgeRegisterCommand({rootPath: docsRoot, sessionDir: sessionDir(), format: 'json',
      acceptRights: true, sendToProvider: true, name: 'Team docs'})).toBe(0);
    expect(lastJson().source).toMatchObject({sourceId, sendToProvider: true});
    expect(await runKnowledgeRegisterCommand({rootPath: docsRoot, sessionDir: sessionDir(), format: 'json',
      acceptRights: true, name: 'Team docs'})).toBe(0);
    expect(lastJson().source.sendToProvider).toBe(true);

    expect(await runKnowledgeReindexCommand({sourceId, sessionDir: sessionDir(), format: 'json'})).toBe(0);
    expect(lastJson().result).toMatchObject({sourceId, documentCount: 1});

    expect(await runKnowledgeListCommand({sessionDir: sessionDir(), format: 'text'})).toBe(0);
    expect(printed()).toContain(`${sourceId}\tdocument_collection\tTeam docs\tdocuments=1\tindex=active\tconsent=enabled`);

    expect(await runKnowledgeSearchCommand({sourceId, query: 'XRenderCompositorWorker', sessionDir: sessionDir(),
      format: 'text'})).toBe(0);
    expect(printed()).toMatch(/kb:render\/compositor\.md#L\d+-L\d+/);
    expect(printed()).toContain('composes every frame');

    // No output names the registered absolute root.
    expect(printed()).not.toContain(docsRoot);

    expect(await runKnowledgeRemoveCommand({sourceId, sessionDir: sessionDir(), format: 'json'})).toBe(2);
    expect(await runKnowledgeRemoveCommand({sourceId, sessionDir: sessionDir(), format: 'json', yes: true})).toBe(0);
    expect(lastJson()).toEqual({success: true, sourceId, deleted: true});
    expect(await runKnowledgeListCommand({sessionDir: sessionDir(), format: 'json'})).toBe(0);
    expect(lastJson().sources).toEqual([]);
    expect(await runKnowledgeSearchCommand({sourceId, query: 'frame', sessionDir: sessionDir(), format: 'json'})).toBe(3);
    expect(lastJson()).toMatchObject({success: false, code: 'KNOWLEDGE_SOURCE_NOT_FOUND'});
  });

  it('reports an empty folder and a bad search as input errors, with a product code only', async () => {
    const empty = path.join(tmpDir, 'empty');
    fs.mkdirSync(empty, {recursive: true});
    expect(await runKnowledgePreviewCommand({rootPath: empty, sessionDir: sessionDir(), format: 'json'})).toBe(2);
    expect(lastJson()).toMatchObject({success: false, code: 'KNOWLEDGE_COLLECTION_EMPTY'});
    expect(await runKnowledgeSearchCommand({sourceId: 'eks_' + '0'.repeat(24), query: ' ', sessionDir: sessionDir(),
      format: 'json'})).toBe(2);
    expect(await runKnowledgeSearchCommand({sourceId: 'eks_' + '0'.repeat(24), query: 'x', topK: 0,
      sessionDir: sessionDir(), format: 'json'})).toBe(2);
  });
});
