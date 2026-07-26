// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {afterEach, beforeEach, describe, expect, it, jest} from '@jest/globals';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import {ApplicationUpdateService} from '../applicationUpdateService';
import type {
  ApplicationBuildIdentity,
  ApplicationDistribution,
} from '../types';

let tempRoot: string;
const now = new Date('2026-07-26T08:00:00.000Z');

function identity(
  distribution: ApplicationDistribution = 'source',
): ApplicationBuildIdentity {
  return {
    distribution,
    channel: 'stable',
    version: '1.2.2',
    commit: '1'.repeat(40),
    target: {
      os: distribution === 'portable' ? 'darwin' : 'linux',
      arch: 'arm64',
      ...(distribution === 'portable' ? {id: 'macos-arm64'} : {}),
    },
    signingMode:
      distribution === 'portable' ? 'macos-adhoc' : 'source-checkout',
  };
}

function jsonResponse(
  body: unknown,
  init: ResponseInit = {},
): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: {'content-type': 'application/json', ...init.headers},
    ...init,
  });
}

function release(version: string, assets: unknown[] = []): unknown {
  return {
    tag_name: `v${version}`,
    draft: false,
    prerelease: false,
    published_at: '2026-07-25T00:00:00Z',
    assets,
  };
}

beforeEach(async () => {
  tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'application-update-test-'));
});

afterEach(async () => {
  jest.restoreAllMocks();
  await fs.rm(tempRoot, {recursive: true, force: true});
});

describe('ApplicationUpdateService', () => {
  it('compares stable releases and reuses a validated ETag cache', async () => {
    const fetch = jest
      .fn<(input: string | URL | Request, init?: RequestInit) => Promise<Response>>()
      .mockResolvedValueOnce(
        jsonResponse(release('1.3.0'), {headers: {etag: '"release-1.3.0"'}}),
      )
      .mockResolvedValueOnce(new Response(null, {status: 304}));
    const service = new ApplicationUpdateService({
      fetch,
      cacheRoot: tempRoot,
      now: () => now,
      freshMs: -1,
      minimumManualRefreshMs: -1,
    });

    const first = await service.checkNow(identity(), {force: true});
    const second = await service.checkNow(identity(), {force: true});

    expect(first).toMatchObject({
      state: 'update_available',
      source: 'github-releases',
      latest: {version: '1.3.0'},
      action: {kind: 'source', command: 'git fetch --tags origin'},
    });
    expect(second).toMatchObject({state: 'update_available'});
    expect(second.stale).toBeUndefined();
    expect(fetch).toHaveBeenCalledTimes(2);
    expect((fetch.mock.calls[1][1]?.headers as Record<string, string>)['If-None-Match'])
      .toBe('"release-1.3.0"');
  });

  it('requires the exact portable target asset and exposes its digest', async () => {
    const digest = 'a'.repeat(64);
    const service = new ApplicationUpdateService({
      cacheRoot: tempRoot,
      now: () => now,
      minimumManualRefreshMs: -1,
      fetch: async () => jsonResponse(release('1.3.0', [{
        name: 'smartperfetto-v1.3.0-macos-arm64.zip',
        digest: `sha256:${digest}`,
      }])),
    });

    const status = await service.checkNow(identity('portable'), {force: true});
    expect(status).toMatchObject({
      state: 'update_available',
      latest: {
        asset: {
          name: 'smartperfetto-v1.3.0-macos-arm64.zip',
          sha256: digest,
        },
      },
      action: {kind: 'portable', sha256: digest},
    });
  });

  it('waits for the matching Docker Hub SemVer tag', async () => {
    const fetch = jest.fn(async (input: string | URL | Request) => {
      const url = String(input);
      return url.includes('hub.docker.com')
        ? jsonResponse({name: '1.3.0', digest: 'sha256:image'})
        : jsonResponse(release('1.3.0'));
    });
    const service = new ApplicationUpdateService({
      cacheRoot: tempRoot,
      now: () => now,
      minimumManualRefreshMs: -1,
      fetch,
    });

    const status = await service.checkNow(identity('docker'), {force: true});
    expect(status).toMatchObject({
      state: 'update_available',
      action: {
        kind: 'docker',
        imageTag: '1.3.0',
      },
    });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('uses the npm registry for npm installations', async () => {
    const service = new ApplicationUpdateService({
      cacheRoot: tempRoot,
      now: () => now,
      minimumManualRefreshMs: -1,
      fetch: async () => jsonResponse({version: '1.2.2'}),
    });

    await expect(
      service.checkNow(identity('npm'), {force: true}),
    ).resolves.toMatchObject({
      state: 'up_to_date',
      source: 'npm-registry',
    });
  });

  it.each([
    {current: '1.2.2', latest: '1.2.2', state: 'up_to_date'},
    {current: '1.3.0', latest: '1.2.2', state: 'ahead'},
    {current: '1.2.2', latest: '1.3.0', state: 'update_available'},
  ])('compares stable SemVer as $state', async ({current, latest, state}) => {
    const build = identity();
    build.version = current;
    const service = new ApplicationUpdateService({
      cacheRoot: tempRoot,
      now: () => now,
      minimumManualRefreshMs: -1,
      fetch: async () => jsonResponse(release(latest)),
    });
    await expect(
      service.checkNow(build, {force: true}),
    ).resolves.toMatchObject({state});
  });

  it('rejects prerelease metadata without replacing last-known-good data', async () => {
    const fetch = jest
      .fn<(input: string | URL | Request) => Promise<Response>>()
      .mockResolvedValueOnce(jsonResponse(release('1.3.0')))
      .mockResolvedValueOnce(jsonResponse(release('1.4.0-beta.1')));
    const service = new ApplicationUpdateService({
      cacheRoot: tempRoot,
      now: () => now,
      freshMs: -1,
      minimumManualRefreshMs: -1,
      fetch,
    });
    await service.checkNow(identity(), {force: true});

    await expect(
      service.checkNow(identity(), {force: true}),
    ).resolves.toMatchObject({
      state: 'update_available',
      stale: true,
      latest: {version: '1.3.0'},
      lastError: {code: 'invalid_response'},
    });
  });

  it('supports source nightly commits and rejects unsupported nightly builds', async () => {
    const build = identity();
    build.channel = 'nightly';
    const latestCommit = '2'.repeat(40);
    const service = new ApplicationUpdateService({
      cacheRoot: tempRoot,
      now: () => now,
      minimumManualRefreshMs: -1,
      fetch: async () => jsonResponse({sha: latestCommit}),
    });
    await expect(
      service.checkNow(build, {force: true}),
    ).resolves.toMatchObject({
      state: 'update_available',
      source: 'github-main',
      latest: {commit: latestCommit},
      action: {kind: 'source'},
    });

    const portable = identity('portable');
    portable.channel = 'nightly';
    expect(service.getStatus(portable).state).toBe('unsupported_channel');
  });

  it('does not trust an oversized response body', async () => {
    const service = new ApplicationUpdateService({
      cacheRoot: tempRoot,
      now: () => now,
      minimumManualRefreshMs: -1,
      fetch: async () => new Response('{}', {
        status: 200,
        headers: {'content-length': String(1024 * 1024 + 1)},
      }),
    });
    await expect(
      service.checkNow(identity(), {force: true}),
    ).resolves.toMatchObject({
      state: 'error',
      lastError: {code: 'response_too_large'},
    });
  });

  it('keeps last-known-good data when a refresh fails', async () => {
    const fetch = jest
      .fn<(input: string | URL | Request) => Promise<Response>>()
      .mockResolvedValueOnce(jsonResponse(release('1.3.0')))
      .mockRejectedValueOnce(new Error('offline'));
    const service = new ApplicationUpdateService({
      cacheRoot: tempRoot,
      now: () => now,
      freshMs: -1,
      minimumManualRefreshMs: -1,
      fetch,
    });
    await service.checkNow(identity(), {force: true});

    const status = await service.checkNow(identity(), {force: true});
    expect(status).toMatchObject({
      state: 'update_available',
      stale: true,
      latest: {version: '1.3.0'},
      lastError: {code: 'network_error'},
    });
  });

  it('coalesces concurrent checks and supports an explicit opt-out', async () => {
    let resolveFetch: ((response: Response) => void) | undefined;
    let notifyStarted: (() => void) | undefined;
    const started = new Promise<void>(resolve => {
      notifyStarted = resolve;
    });
    const fetch = jest.fn(() => new Promise<Response>(resolve => {
      resolveFetch = resolve;
      notifyStarted?.();
    }));
    const service = new ApplicationUpdateService({
      cacheRoot: tempRoot,
      now: () => now,
      fetch,
    });
    const first = service.checkNow(identity(), {force: true});
    const second = service.checkNow(identity(), {force: true});
    await started;
    resolveFetch?.(jsonResponse(release('1.2.2')));

    await expect(Promise.all([first, second])).resolves.toHaveLength(2);
    expect(fetch).toHaveBeenCalledTimes(1);

    const disabled = new ApplicationUpdateService({
      cacheRoot: tempRoot,
      env: {SMARTPERFETTO_UPDATE_CHECK: 'off'} as NodeJS.ProcessEnv,
      fetch,
    });
    expect(disabled.getStatus(identity()).state).toBe('disabled');
  });
});
