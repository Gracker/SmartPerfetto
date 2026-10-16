// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)

import {createServer, type RequestListener, type Server} from 'http';

/** Own the same IPv4 listeners that Supertest's fixed 127.0.0.1 URL reaches. */
export function createLoopbackServerFixture() {
  const servers = new Set<Server>();
  return {
    async listen(app: RequestListener, port = 0): Promise<Server> {
      const server = createServer(app);
      await new Promise<void>((resolve, reject) => {
        const cleanup = () => {
          server.removeListener('error', onError);
          server.removeListener('listening', onReady);
        };
        const onError = (error: Error) => { cleanup(); reject(error); };
        const onReady = () => { cleanup(); resolve(); };
        server.once('error', onError);
        server.once('listening', onReady);
        try {
          server.listen(port, '127.0.0.1');
        } catch (error) {
          cleanup();
          reject(error);
        }
      });
      servers.add(server);
      return server;
    },
    async close(): Promise<void> {
      const owned = [...servers];
      servers.clear();
      await Promise.all(owned.map(server => new Promise<void>((resolve, reject) => {
        if (!server.listening) return resolve();
        server.close(error => error ? reject(error) : resolve());
      })));
    },
  };
}
