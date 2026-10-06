// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)

import {afterEach, describe, expect, it} from '@jest/globals';
import {createServer} from 'http';
import {type AddressInfo} from 'net';
import request from 'supertest';
import {createLoopbackServerFixture} from '../../tests/helpers/loopbackServer';

const fixture = createLoopbackServerFixture();
afterEach(async () => { await fixture.close(); });

describe('HTTP test loopback fixture', () => {
  it('waits for IPv4 readiness and serves the intended app', async () => {
    const server = await fixture.listen((_req, res) => res.end('intended app'));
    expect(server.address()).toMatchObject({address: '127.0.0.1', family: 'IPv4'});
    const response = await request(server).get('/probe');
    expect(response.status).toBe(200);
    expect(response.text).toBe('intended app');
  });

  it('rejects an occupied IPv4 port rather than serving another listener', async () => {
    const sentinel = createServer((_req, res) => res.end('other app'));
    await new Promise<void>(resolve => sentinel.listen(0, '127.0.0.1', resolve));
    try {
      const {port} = sentinel.address() as AddressInfo;
      await expect(fixture.listen((_req, res) => res.end('intended app'), port))
        .rejects.toMatchObject({code: 'EADDRINUSE'});
      expect((await request(sentinel).get('/probe')).text).toBe('other app');
    } finally {
      await new Promise<void>((resolve, reject) => {
        sentinel.close(error => error ? reject(error) : resolve());
      });
    }
  });

  it('closes every owned listener and releases its port', async () => {
    const first = await fixture.listen((_req, res) => res.end());
    const second = await fixture.listen((_req, res) => res.end());
    const {port} = first.address() as AddressInfo;
    await fixture.close();
    expect(first.listening).toBe(false);
    expect(second.listening).toBe(false);
    const reused = await fixture.listen((_req, res) => res.end('reused'), port);
    expect((await request(reused).get('/probe')).text).toBe('reused');
    await fixture.close();
    await fixture.close();
  });
});
