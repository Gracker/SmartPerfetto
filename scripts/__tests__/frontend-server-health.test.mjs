// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)

import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const require = createRequire(import.meta.url);
const repoRoot = path.resolve(import.meta.dirname, '../..');
const {
  REQUIRED_RUNTIME_ASSETS,
  closeFrontendServer,
  createFrontendServer,
  frontendHealth,
  listenFrontend,
  readStaticFile,
  resolveBindHost,
  resolveStaticRequest,
  watchShutdownFile,
} = require(path.join(repoRoot, 'frontend/server.js'));

async function reservePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen({host: '127.0.0.1', port: 0}, resolve);
  });
  const {port} = server.address();
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

function waitForProcessExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({code: child.exitCode, signal: child.signalCode});
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('frontend process did not exit')), timeoutMs);
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      resolve({code, signal});
    });
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

async function waitForFrontendHealth(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`);
      if (response.ok && (await response.json()).status === 'OK') return;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`frontend did not become healthy: ${lastError?.message || 'timeout'}`);
}

function openLiveReload(port) {
  return new Promise((resolve, reject) => {
    const request = http.get({
      host: '127.0.0.1',
      path: '/live_reload',
      port,
    }, (response) => {
      response.once('data', () => resolve({request, response}));
    });
    request.once('error', reject);
  });
}

function createFrontendFixture(
  t,
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'smartperfetto-frontend-health-')),
) {
  fs.mkdirSync(root, {recursive: true});
  const version = 'v1.2-test';
  const versionDir = path.join(root, version);
  fs.mkdirSync(versionDir);
  fs.writeFileSync(
    path.join(root, 'index.html'),
    `<body data-perfetto_version='{"stable":"${version}"}'></body>`,
  );
  fs.writeFileSync(path.join(root, 'service_worker.js'), 'fixture:service-worker');
  const resources = {};
  for (const asset of REQUIRED_RUNTIME_ASSETS) {
    resources[asset] = 'sha256-test';
    fs.writeFileSync(path.join(versionDir, asset), `fixture:${asset}`);
  }
  fs.writeFileSync(path.join(versionDir, 'manifest.json'), JSON.stringify({resources}));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  return {root, version, versionDir};
}

function request(server, requestPath) {
  const {port} = server.address();
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      method: 'GET',
      path: requestPath,
      port,
    }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => resolve({
        body: Buffer.concat(chunks).toString('utf8'),
        headers: response.headers,
        status: response.statusCode,
      }));
    });
    req.on('error', reject);
    req.end();
  });
}

test('prebuilt frontend health requires the versioned manifest and core runtime assets', (t) => {
  const {root, version} = createFrontendFixture(t);
  assert.deepEqual(frontendHealth(root), {status: 'OK', version});
});

test('prebuilt frontend health fails when a declared core runtime asset is missing', (t) => {
  const {root, versionDir} = createFrontendFixture(t);
  fs.rmSync(path.join(versionDir, 'trace_processor.wasm'));
  const health = frontendHealth(root);
  assert.equal(health.status, 'ERROR');
  assert.match(health.error, /trace_processor\.wasm/);
});

test('prebuilt frontend health fails when index version metadata is invalid', (t) => {
  const {root} = createFrontendFixture(t);
  fs.writeFileSync(
    path.join(root, 'index.html'),
    `<body data-perfetto_version='{"stable":"../outside"}'></body>`,
  );
  const health = frontendHealth(root);
  assert.equal(health.status, 'ERROR');
  assert.match(health.error, /invalid stable Perfetto version/);
});

test('frontend shutdown control fires once for a regular file', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'smartperfetto-frontend-shutdown-'));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const shutdownFile = path.join(root, 'frontend.shutdown');
  const reasons = [];
  const stop = watchShutdownFile(shutdownFile, (reason) => reasons.push(reason), 5);
  t.after(stop);

  fs.writeFileSync(shutdownFile, 'shutdown\n');
  await new Promise((resolve) => setTimeout(resolve, 40));

  assert.deepEqual(reasons, ['launcher-control-file']);
});

test('frontend listener defaults to IPv4 loopback and supports an explicit Docker bind', async (t) => {
  assert.equal(resolveBindHost(undefined), '127.0.0.1');
  assert.equal(resolveBindHost('0.0.0.0'), '0.0.0.0');
  assert.throws(() => resolveBindHost('http://127.0.0.1'), /Invalid/);

  const testServer = http.createServer((_request, response) => response.end('ok'));
  t.after(() => testServer.close());
  await new Promise((resolve, reject) => {
    testServer.once('error', reject);
    listenFrontend(testServer, {host: resolveBindHost(undefined), port: 0}, resolve);
  });
  assert.equal(testServer.address().address, '127.0.0.1');
});

test('frontend shutdown file closes an active live-reload stream and exits cleanly', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'smartperfetto-frontend-process-'));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const shutdownFile = path.join(root, 'frontend.shutdown');
  const port = await reservePort();
  const child = spawn(process.execPath, [path.join(repoRoot, 'frontend/server.js')], {
    env: {
      ...process.env,
      SMARTPERFETTO_FRONTEND_BIND_HOST: '127.0.0.1',
      SMARTPERFETTO_FRONTEND_PORT: String(port),
      SMARTPERFETTO_SHUTDOWN_FILE: shutdownFile,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  });

  await waitForFrontendHealth(port, 10_000);
  const stream = await openLiveReload(port);
  t.after(() => stream.request.destroy());
  fs.writeFileSync(shutdownFile, 'shutdown\n', {flag: 'wx', mode: 0o600});

  assert.deepEqual(await waitForProcessExit(child, 2_000), {code: 0, signal: null});
});

test('frontend close helper drains tracked live-reload responses before closing', async (t) => {
  const {root} = createFrontendFixture(t);
  const testServer = createFrontendServer(root);
  await new Promise((resolve, reject) => {
    testServer.once('error', reject);
    listenFrontend(testServer, {host: '127.0.0.1', port: 0}, resolve);
  });
  const stream = await openLiveReload(testServer.address().port);
  t.after(() => stream.request.destroy());

  await new Promise((resolve, reject) => {
    closeFrontendServer(testServer, (error) => error ? reject(error) : resolve());
  });
  assert.equal(testServer.listening, false);
});

test('frontend close helper bounds shutdown when a client sends partial headers', async (t) => {
  const {root} = createFrontendFixture(t);
  const testServer = createFrontendServer(root);
  await new Promise((resolve, reject) => {
    testServer.once('error', reject);
    listenFrontend(testServer, {host: '127.0.0.1', port: 0}, resolve);
  });
  const socket = net.createConnection({
    host: '127.0.0.1',
    port: testServer.address().port,
  });
  t.after(() => socket.destroy());
  await new Promise((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('error', reject);
  });
  socket.write('GET / HTTP/1.1\r\nHost: 127.0.0.1\r\n');
  const socketClosed = new Promise((resolve) => socket.once('close', resolve));

  await new Promise((resolve, reject) => {
    closeFrontendServer(
      testServer,
      (error) => error ? reject(error) : resolve(),
      50,
    );
  });
  await socketClosed;
  assert.equal(testServer.listening, false);
});

test('frontend runtime config escapes script-closing environment values', async (t) => {
  const {root} = createFrontendFixture(t);
  const original = process.env.SMARTPERFETTO_BACKEND_PUBLIC_URL;
  process.env.SMARTPERFETTO_BACKEND_PUBLIC_URL =
    '</script><script>globalThis.SMARTPERFETTO_XSS=1</script>';
  t.after(() => {
    if (original === undefined) delete process.env.SMARTPERFETTO_BACKEND_PUBLIC_URL;
    else process.env.SMARTPERFETTO_BACKEND_PUBLIC_URL = original;
  });
  const testServer = createFrontendServer(root);
  t.after(() => closeFrontendServer(testServer));
  await new Promise((resolve, reject) => {
    testServer.once('error', reject);
    listenFrontend(testServer, {host: '127.0.0.1', port: 0}, resolve);
  });

  const response = await request(testServer, '/');
  assert.equal(response.status, 200);
  assert.doesNotMatch(response.body, /<\/script><script>globalThis\.SMARTPERFETTO_XSS/);
  assert.match(response.body, /\\u003c\/script>\\u003cscript>/);
});

test('frontend runtime config exposes the trusted external issue endpoint', async (t) => {
  const {root} = createFrontendFixture(t);
  const original = process.env.SMARTPERFETTO_EXTERNAL_ISSUE_URL;
  process.env.SMARTPERFETTO_EXTERNAL_ISSUE_URL =
    'https://github.example.com/org/repo/issues/new';
  t.after(() => {
    if (original === undefined) {
      delete process.env.SMARTPERFETTO_EXTERNAL_ISSUE_URL;
    } else {
      process.env.SMARTPERFETTO_EXTERNAL_ISSUE_URL = original;
    }
  });
  const testServer = createFrontendServer(root);
  t.after(() => closeFrontendServer(testServer));
  await new Promise((resolve, reject) => {
    testServer.once('error', reject);
    listenFrontend(testServer, {host: '127.0.0.1', port: 0}, resolve);
  });

  const response = await request(testServer, '/');
  assert.equal(response.status, 200);
  assert.match(
    response.body,
    /"externalIssueUrl":"https:\/\/github\.example\.com\/org\/repo\/issues\/new"/,
  );
});

test('frontend runtime config preserves the original startup path when OIDC is not configured', async (t) => {
  const {root} = createFrontendFixture(t);
  const keys = [
    'SMARTPERFETTO_OIDC_ISSUER_URL',
    'SMARTPERFETTO_OIDC_CLIENT_ID',
    'SMARTPERFETTO_OIDC_REDIRECT_URI',
  ];
  const original = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  for (const key of keys) delete process.env[key];
  t.after(() => {
    for (const key of keys) {
      if (original[key] === undefined) delete process.env[key];
      else process.env[key] = original[key];
    }
  });
  const testServer = createFrontendServer(root);
  t.after(() => closeFrontendServer(testServer));
  await new Promise((resolve, reject) => {
    testServer.once('error', reject);
    listenFrontend(testServer, {host: '127.0.0.1', port: 0}, resolve);
  });

  const response = await request(testServer, '/');
  assert.equal(response.status, 200);
  assert.equal(response.headers['cache-control'], undefined);
  assert.doesNotMatch(response.body, /"authProbeRequired"/);
  assert.doesNotMatch(response.body, /"oidcEnabled"/);
});

test('frontend runtime config enables the OIDC gate without exposing OIDC values', async (t) => {
  const {root} = createFrontendFixture(t);
  const keys = [
    'SMARTPERFETTO_OIDC_ISSUER_URL',
    'SMARTPERFETTO_OIDC_CLIENT_ID',
    'SMARTPERFETTO_OIDC_CLIENT_SECRET',
    'SMARTPERFETTO_OIDC_REDIRECT_URI',
  ];
  const original = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  process.env.SMARTPERFETTO_OIDC_ISSUER_URL = 'https://idp.example.test';
  process.env.SMARTPERFETTO_OIDC_CLIENT_ID = 'client-a';
  process.env.SMARTPERFETTO_OIDC_CLIENT_SECRET = 'must-not-appear-in-html';
  process.env.SMARTPERFETTO_OIDC_REDIRECT_URI =
    'https://backend.example.test/api/auth/oidc/callback';
  t.after(() => {
    for (const key of keys) {
      if (original[key] === undefined) delete process.env[key];
      else process.env[key] = original[key];
    }
  });
  const testServer = createFrontendServer(root);
  t.after(() => closeFrontendServer(testServer));
  await new Promise((resolve, reject) => {
    testServer.once('error', reject);
    listenFrontend(testServer, {host: '127.0.0.1', port: 0}, resolve);
  });

  const response = await request(testServer, '/');
  assert.equal(response.status, 200);
  assert.equal(response.headers['cache-control'], 'no-store');
  assert.match(response.body, /"authProbeRequired":true/);
  assert.match(response.body, /"oidcEnabled":true/);
  assert.match(
    response.body,
    /"backendUrl":"https:\/\/backend\.example\.test"/,
  );
  assert.doesNotMatch(response.body, /idp\.example\.test/);
  assert.doesNotMatch(response.body, /client-a/);
  assert.doesNotMatch(response.body, /must-not-appear-in-html/);
});

test('frontend runtime config reads only public browser values from the packaged env file', async (t) => {
  const {root} = createFrontendFixture(t);
  const envPath = path.join(root, 'user.env');
  fs.writeFileSync(envPath, [
    'SMARTPERFETTO_BACKEND_PUBLIC_URL=https://backend.example.test',
    'SMARTPERFETTO_OIDC_ISSUER_URL=https://idp.example.test',
    'SMARTPERFETTO_OIDC_CLIENT_ID=client-from-env-file',
    'SMARTPERFETTO_OIDC_REDIRECT_URI=https://backend.example.test/api/auth/oidc/callback',
    'SMARTPERFETTO_OIDC_CLIENT_SECRET=packaged-secret-must-not-appear',
  ].join('\n'));
  const originalEnvFile = process.env.SMARTPERFETTO_ENV_FILE;
  process.env.SMARTPERFETTO_ENV_FILE = envPath;
  t.after(() => {
    if (originalEnvFile === undefined) delete process.env.SMARTPERFETTO_ENV_FILE;
    else process.env.SMARTPERFETTO_ENV_FILE = originalEnvFile;
  });
  const testServer = createFrontendServer(root);
  t.after(() => closeFrontendServer(testServer));
  await new Promise((resolve, reject) => {
    testServer.once('error', reject);
    listenFrontend(testServer, {host: '127.0.0.1', port: 0}, resolve);
  });

  const response = await request(testServer, '/');
  assert.equal(response.status, 200);
  assert.match(response.body, /"authProbeRequired":true/);
  assert.match(response.body, /"backendUrl":"https:\/\/backend\.example\.test"/);
  assert.match(response.body, /"oidcEnabled":true/);
  assert.doesNotMatch(response.body, /idp\.example\.test/);
  assert.doesNotMatch(response.body, /client-from-env-file/);
  assert.doesNotMatch(response.body, /packaged-secret-must-not-appear/);
});

test('an explicit runtime env file does not fall back to a sibling root env file', async (t) => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'smartperfetto-explicit-env-'));
  const root = path.join(parent, 'frontend');
  createFrontendFixture(t, root);
  fs.writeFileSync(path.join(parent, '.env'), [
    'SMARTPERFETTO_OIDC_ISSUER_URL=https://unexpected-idp.example.test',
    'SMARTPERFETTO_OIDC_CLIENT_ID=unexpected-client',
    'SMARTPERFETTO_OIDC_REDIRECT_URI=https://unexpected.example.test/callback',
  ].join('\n'));
  const explicitEnvPath = path.join(parent, 'source.env');
  fs.writeFileSync(explicitEnvPath, 'SMARTPERFETTO_BACKEND_PUBLIC_URL=https://backend.example.test\n');
  t.after(() => fs.rmSync(parent, {recursive: true, force: true}));

  const keys = [
    'SMARTPERFETTO_ENV_FILE',
    'SMARTPERFETTO_BACKEND_PUBLIC_URL',
    'SMARTPERFETTO_BACKEND_URL',
    'SMARTPERFETTO_OIDC_ISSUER_URL',
    'SMARTPERFETTO_OIDC_CLIENT_ID',
    'SMARTPERFETTO_OIDC_REDIRECT_URI',
  ];
  const original = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  for (const key of keys) delete process.env[key];
  process.env.SMARTPERFETTO_ENV_FILE = explicitEnvPath;
  t.after(() => {
    for (const key of keys) {
      if (original[key] === undefined) delete process.env[key];
      else process.env[key] = original[key];
    }
  });

  const testServer = createFrontendServer(root);
  t.after(() => closeFrontendServer(testServer));
  await new Promise((resolve, reject) => {
    testServer.once('error', reject);
    listenFrontend(testServer, {host: '127.0.0.1', port: 0}, resolve);
  });

  const response = await request(testServer, '/');
  assert.equal(response.status, 200);
  assert.doesNotMatch(response.body, /"authProbeRequired"/);
  assert.doesNotMatch(response.body, /"oidcEnabled"/);
  assert.doesNotMatch(response.body, /backend\.example\.test/);
  assert.doesNotMatch(response.body, /unexpected-idp|unexpected-client/);
});

test('frontend static reads reject a directory-symlink swap after open', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'smartperfetto-static-race-root-'));
  const inside = path.join(root, 'inside');
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'smartperfetto-static-race-outside-'));
  fs.mkdirSync(inside);
  fs.writeFileSync(path.join(inside, 'secret.txt'), 'inside');
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'OUTSIDE-SECRET');
  const link = path.join(root, 'current');
  fs.symlinkSync(outside, link);
  t.after(() => {
    fs.rmSync(root, {recursive: true, force: true});
    fs.rmSync(outside, {recursive: true, force: true});
  });

  const candidate = path.join(link, 'secret.txt');
  const originalRealpath = fs.realpath;
  fs.realpath = (requestedPath, callback) => {
    if (requestedPath === candidate) {
      fs.unlinkSync(link);
      fs.symlinkSync(inside, link);
    }
    return originalRealpath.call(fs, requestedPath, callback);
  };
  t.after(() => {
    fs.realpath = originalRealpath;
  });

  const error = await new Promise((resolve) => {
    readStaticFile(root, candidate, (readError) => resolve(readError));
  });
  assert.match(error?.message || '', /escapes the frontend root|changed while it was opened/);
});

test('frontend server confines decoded request paths to the static root', async (t) => {
  const {root, version} = createFrontendFixture(t);
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'smartperfetto-frontend-outside-'));
  t.after(() => fs.rmSync(outside, {recursive: true, force: true}));
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'must-not-leak');
  fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(root, 'escape.txt'));

  assert.throws(() => resolveStaticRequest('/../secret', root), /traversal/);
  assert.throws(() => resolveStaticRequest('/%2e%2e/secret', root), /traversal/);
  assert.throws(() => resolveStaticRequest('/%5c..%5csecret', root), /unsafe/);
  assert.throws(() => resolveStaticRequest('/%ZZ', root), /percent encoding/);

  const testServer = createFrontendServer(root);
  t.after(() => testServer.close());
  await new Promise((resolve, reject) => {
    testServer.once('error', reject);
    listenFrontend(testServer, {host: '127.0.0.1', port: 0}, resolve);
  });

  const asset = await request(testServer, `/${version}/frontend_bundle.js`);
  assert.equal(asset.status, 200);
  assert.equal(asset.body, 'fixture:frontend_bundle.js');
  assert.equal((await request(testServer, '/analysis/session')).status, 200);
  assert.equal((await request(testServer, '/missing.js')).status, 404);
  assert.equal((await request(testServer, '/escape.txt')).status, 404);
  for (const unsafePath of [
    '/../../../../../../etc/hosts',
    '/%2e%2e/%2e%2e/etc/hosts',
    '/%5c..%5cetc%5chosts',
    '/%ZZ',
  ]) {
    assert.equal((await request(testServer, unsafePath)).status, 400);
  }
});
