// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

import {afterAll, afterEach, beforeAll, describe, expect, it} from '@jest/globals';
import express from 'express';
import request from 'supertest';
import {createLoopbackServerFixture} from '../../../tests/helpers/loopbackServer';

import {sendResolvedFile} from '../sendResolvedFile';

const loopbackServers = createLoopbackServerFixture();

describe('sendResolvedFile', () => {
  let tmpDir: string;
  let dotDir: string;

  afterEach(async () => {await loopbackServers.close();});

  beforeAll(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'send-resolved-file-'));
    dotDir = path.join(tmpDir, '.local', 'share');
    await fs.mkdir(dotDir, {recursive: true});
    await fs.writeFile(path.join(dotDir, 'trace.txt'), 'trace-bytes');
    await fs.writeFile(path.join(dotDir, '.secret'), 'hidden');
  });

  afterAll(async () => {
    await fs.rm(tmpDir, {recursive: true, force: true});
  });

  async function appSending(target: string, onError?: (res: express.Response) => void) {
    const app = express();
    app.get('/file', (_req, res) => {
      sendResolvedFile(res, target, onError && (error => {
        if (error && !res.headersSent) onError(res);
      }));
    });
    return loopbackServers.listen(app);
  }

  it('serves a file below a dot-directory', async () => {
    const res = await request(await appSending(path.join(dotDir, 'trace.txt'))).get('/file');
    expect(res.status).toBe(200);
    expect(res.text).toBe('trace-bytes');
  });

  it('resolves a relative path against the working directory', async () => {
    const relative = path.relative(process.cwd(), path.join(dotDir, 'trace.txt'));
    const res = await request(await appSending(relative)).get('/file');
    expect(res.status).toBe(200);
  });

  it('still refuses a dotfile itself', async () => {
    const res = await request(await appSending(path.join(dotDir, '.secret'))).get('/file');
    expect(res.status).toBe(404);
    expect(res.text).not.toContain('hidden');
  });

  it('reports a missing file to the callback instead of next()', async () => {
    const app = await appSending(path.join(dotDir, 'missing.txt'), res => res.status(410).end());
    expect((await request(app).get('/file')).status).toBe(410);
  });
});
