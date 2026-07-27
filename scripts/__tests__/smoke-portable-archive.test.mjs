// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

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
  assertMatchingHost,
  collectDescendantPids,
  createEvidenceDirectory,
  directHttpHealthProbe,
  forceKillProcessTree,
  isolatedSmokeEnv,
  packagePaths,
  parseHealthHttpResponse,
  parseArgs,
  runArchiveBinary,
  sanitizedSmokeEnv,
  startProcessTreeMonitor,
  validateLifecycleReceipt,
  versionAtLeast,
  waitForHealth,
  waitForReadiness,
  windowsSystemBinary,
} = require(path.join(repoRoot, 'scripts/smoke-portable-archive.cjs'));
const {
  REQUIRED_RUNTIME_ASSETS,
  createFrontendServer,
} = require(path.join(repoRoot, 'frontend/server.js'));

async function listenOnLoopback(server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen({host: '127.0.0.1', port: 0}, resolve);
  });
  return server.address().port;
}

async function closeHttpServer(server) {
  server.closeAllConnections?.();
  if (!server.listening) return;
  await new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

async function waitForChild(child) {
  const stdout = [];
  const stderr = [];
  child.stdout.on('data', (chunk) => stdout.push(chunk));
  child.stderr.on('data', (chunk) => stderr.push(chunk));
  const {code, signal} = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (exitCode, exitSignal) => {
      resolve({code: exitCode, signal: exitSignal});
    });
  });
  return {
    code,
    signal,
    stderr: Buffer.concat(stderr).toString('utf8'),
    stdout: Buffer.concat(stdout).toString('utf8'),
  };
}

function waitForSocketClose(socket, timeoutMs = 2_000) {
  if (socket.destroyed) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('health probe socket did not close')),
      timeoutMs,
    );
    socket.once('close', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

async function startRawResponseServer(onRequest) {
  const sockets = new Set();
  const requests = [];
  const requestWaiters = [];
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    const chunks = [];
    let handled = false;
    socket.on('data', (chunk) => {
      if (handled) return;
      chunks.push(chunk);
      const bytes = Buffer.concat(chunks);
      if (bytes.indexOf('\r\n\r\n') < 0) return;
      handled = true;
      const request = bytes.toString('latin1');
      requests.push(request);
      requestWaiters.shift()?.(request);
      Promise.resolve(onRequest(socket, request)).catch((error) => {
        socket.destroy(error);
      });
    });
  });
  const port = await listenOnLoopback(server);
  return {
    close: async () => {
      for (const socket of sockets) socket.destroy();
      if (!server.listening) return;
      await new Promise((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
      });
    },
    nextRequest: () => {
      if (requests.length > 0) return Promise.resolve(requests.at(-1));
      return new Promise((resolve) => requestWaiters.push(resolve));
    },
    port,
    requests,
    server,
    sockets,
  };
}

function healthHttpResponse(payload, headers = {}) {
  const body = Buffer.from(JSON.stringify(payload));
  const lines = [
    'HTTP/1.0 200 OK',
    `Content-Length: ${body.length}`,
    'Content-Type: application/json',
    'Connection: close',
    ...Object.entries(headers).map(([name, value]) => `${name}: ${value}`),
    '',
    '',
  ];
  return Buffer.concat([Buffer.from(lines.join('\r\n')), body]);
}

function rawLoopbackRequest(port, requestTarget = '/health') {
  return new Promise((resolve, reject) => {
    const chunks = [];
    const socket = net.createConnection({
      family: 4,
      host: '127.0.0.1',
      port,
    });
    socket.once('connect', () => {
      socket.write([
        `GET ${requestTarget} HTTP/1.0`,
        `Host: 127.0.0.1:${port}`,
        'Connection: close',
        '',
        '',
      ].join('\r\n'));
    });
    socket.on('data', (chunk) => chunks.push(chunk));
    socket.once('end', () => resolve(Buffer.concat(chunks)));
    socket.once('error', reject);
  });
}

test('portable smoke requires a matching native host', () => {
  assert.doesNotThrow(() => assertMatchingHost('linux-x64', 'linux', 'x64'));
  assert.throws(
    () => assertMatchingHost('windows-x64', 'darwin', 'arm64'),
    /requires win32\/x64/,
  );
});

test('portable smoke resolves target-specific launcher and runtime paths', () => {
  const windows = packagePaths('/tmp/root', 'package', 'windows-x64');
  assert.equal(windows.launcher, path.join('/tmp/root', 'package', 'SmartPerfetto.exe'));
  assert.equal(windows.node, path.join('/tmp/root', 'package', 'runtime', 'node', 'node.exe'));

  const macos = packagePaths('/tmp/root', 'package', 'macos-arm64');
  assert.equal(
    macos.launcher,
    path.join('/tmp/root', 'package', 'SmartPerfetto.app', 'Contents', 'MacOS', 'SmartPerfetto'),
  );
  assert.match(
    macos.node.split(path.sep).join('/'),
    /SmartPerfetto\.app\/Contents\/Resources\/runtime\/node\/bin\/node$/,
  );
});

test('portable smoke parser rejects incomplete option values', () => {
  assert.throws(() => parseArgs(['--asset']), /requires a value/);
  assert.deepEqual(
    parseArgs([
      '--asset', '/tmp/archive',
      '--target', 'linux-x64',
      '--version', '1.2.3',
      '--commit', 'abc',
    ]),
    {
      asset: '/tmp/archive',
      target: 'linux-x64',
      version: '1.2.3',
      commit: 'abc',
    },
  );
  assert.deepEqual(parseArgs(['--allow-dirty']), {allowDirty: true});
});

test('portable smoke creates a fresh evidence directory and refuses reuse', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'smartperfetto-smoke-evidence-test-'));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const evidence = path.join(root, 'linux-x64');
  assert.equal(createEvidenceDirectory(evidence, 'linux-x64'), evidence);
  assert.throws(
    () => createEvidenceDirectory(evidence, 'linux-x64'),
    /already exists; choose a fresh path/,
  );
});

test('portable smoke does not expose release or provider credentials to the archive', () => {
  assert.deepEqual(
    sanitizedSmokeEnv({
      PATH: '/bin',
      GH_TOKEN: 'github-secret',
      GITHUB_TOKEN: 'actions-secret',
      OPENAI_API_KEY: 'provider-secret',
      ANTHROPIC_AUTH_TOKEN: 'provider-token',
      AWS_SECRET_ACCESS_KEY: 'aws-secret',
      SMARTPERFETTO_MACOS_NOTARY_PROFILE: 'notary-secret',
      SMARTPERFETTO_ENV_FILE: '/real/maintainer/provider.env',
      NODE_OPTIONS: '--require=/untrusted/hook.js',
    }),
    {PATH: '/bin'},
  );
});

test('portable health probe bypasses startup proxy settings and closes its socket', async (t) => {
  let proxyRequests = 0;
  const proxy = http.createServer((_request, response) => {
    proxyRequests++;
    response.writeHead(502);
    response.end('proxy must not receive loopback health traffic');
  });
  const proxyPort = await listenOnLoopback(proxy);
  t.after(() => closeHttpServer(proxy));

  let connectionHeader;
  let healthSocket;
  const health = http.createServer((request, response) => {
    connectionHeader = request.headers.connection;
    response.writeHead(200, {'Content-Type': 'application/json'});
    response.end(JSON.stringify({status: 'OK', version: 'fixture-version'}));
  });
  health.once('connection', (socket) => {
    healthSocket = socket;
  });
  const healthPort = await listenOnLoopback(health);
  t.after(() => closeHttpServer(health));

  const smokeModule = path.join(repoRoot, 'scripts/smoke-portable-archive.cjs');
  const child = spawn(process.execPath, ['-e', [
    `const {waitForHealth}=require(${JSON.stringify(smokeModule)});`,
    'waitForHealth(process.argv[1], {status: "OK", version: "fixture-version"}, 2000)',
    '  .then((result) => process.stdout.write(JSON.stringify(result)))',
    '  .catch((error) => { console.error(error.stack || error); process.exitCode = 1; });',
  ].join('\n'), `http://127.0.0.1:${healthPort}/health`], {
    env: {
      ...process.env,
      ALL_PROXY: `http://127.0.0.1:${proxyPort}`,
      HTTP_PROXY: `http://127.0.0.1:${proxyPort}`,
      HTTPS_PROXY: `http://127.0.0.1:${proxyPort}`,
      NODE_USE_ENV_PROXY: '1',
      NO_PROXY: '',
      no_proxy: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const result = await waitForChild(child);

  assert.deepEqual(
    {code: result.code, signal: result.signal, stderr: result.stderr},
    {code: 0, signal: null, stderr: ''},
  );
  assert.deepEqual(
    JSON.parse(result.stdout),
    {status: 'OK', version: 'fixture-version'},
  );
  assert.equal(proxyRequests, 0);
  assert.equal(connectionHeader, 'close');
  assert.ok(healthSocket, 'health server did not observe a connection');
  await waitForSocketClose(healthSocket);
});

test('portable health probe parses fragmented bytes and sends a fixed HTTP/1.0 request', async (t) => {
  let healthSocket;
  const response = healthHttpResponse({status: 'OK', version: 'fixture-version'});
  const fixture = await startRawResponseServer(async (socket) => {
    healthSocket = socket;
    let offset = 0;
    for (const end of [1, 9, 27, 53, response.length]) {
      socket.write(response.subarray(offset, end));
      offset = end;
      await new Promise((resolve) => setImmediate(resolve));
    }
    socket.end();
  });
  t.after(() => fixture.close());

  const result = await directHttpHealthProbe(
    `http://127.0.0.1:${fixture.port}/health?probe=portable`,
    2_000,
  );
  assert.deepEqual(
    {...result, body: JSON.parse(result.body)},
    {
      body: {status: 'OK', version: 'fixture-version'},
      statusCode: 200,
    },
  );
  const request = await fixture.nextRequest();
  assert.match(request, /^GET \/health\?probe=portable HTTP\/1\.0\r\n/);
  assert.match(request, new RegExp(`\r\nHost: 127\\.0\\.0\\.1:${fixture.port}\r\n`));
  assert.match(request, /\r\nAccept: application\/json\r\n/);
  assert.match(request, /\r\nConnection: close\r\n\r\n$/);
  assert.ok(healthSocket, 'raw server did not observe a health connection');
  await waitForSocketClose(healthSocket);
});

test('portable health probe half-closes its request before awaiting the response', async (t) => {
  let observedRequest = '';
  let observedSocket;
  const response = healthHttpResponse({status: 'OK', version: 'fixture-version'});
  const server = net.createServer({allowHalfOpen: true}, (socket) => {
    observedSocket = socket;
    const chunks = [];
    socket.on('data', (chunk) => chunks.push(chunk));
    socket.once('end', () => {
      observedRequest = Buffer.concat(chunks).toString('latin1');
      socket.end(response);
    });
  });
  const port = await listenOnLoopback(server);
  t.after(() => closeHttpServer(server));

  assert.deepEqual(
    await directHttpHealthProbe(
      `http://127.0.0.1:${port}/health`,
      2_000,
    ),
    {
      body: JSON.stringify({status: 'OK', version: 'fixture-version'}),
      statusCode: 200,
    },
  );
  assert.match(observedRequest, /^GET \/health HTTP\/1\.0\r\n/);
  assert.ok(observedSocket, 'half-close server did not observe a connection');
  await waitForSocketClose(observedSocket);
});

test('portable health probe accepts the production frontend response framing', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'smartperfetto-frontend-health-'));
  const version = 'vfixture';
  const versionRoot = path.join(root, version);
  fs.mkdirSync(versionRoot, {recursive: true});
  fs.writeFileSync(
    path.join(root, 'index.html'),
    `<html data-perfetto_version='${JSON.stringify({stable: version})}'></html>`,
  );
  fs.writeFileSync(
    path.join(versionRoot, 'manifest.json'),
    `${JSON.stringify({
      resources: Object.fromEntries(
        REQUIRED_RUNTIME_ASSETS.map((asset) => [asset, {file: asset}]),
      ),
    })}\n`,
  );
  for (const asset of REQUIRED_RUNTIME_ASSETS) {
    fs.writeFileSync(path.join(versionRoot, asset), 'fixture\n');
  }
  const frontend = createFrontendServer(root);
  const port = await listenOnLoopback(frontend);
  t.after(async () => {
    await closeHttpServer(frontend);
    fs.rmSync(root, {recursive: true, force: true});
  });

  const rawResponse = await rawLoopbackRequest(port);
  const rawHeaders = rawResponse
    .subarray(0, rawResponse.indexOf(Buffer.from('\r\n\r\n')))
    .toString('latin1');
  assert.match(rawHeaders, /\r\nConnection: close(?:\r\n|$)/i);
  assert.doesNotMatch(rawHeaders, /\r\nContent-Length:/i);
  assert.doesNotMatch(rawHeaders, /\r\nTransfer-Encoding:/i);
  const parsedResponse = parseHealthHttpResponse(rawResponse);
  assert.deepEqual(
    {
      ...parsedResponse,
      body: JSON.parse(parsedResponse.body),
    },
    {body: {status: 'OK', version}, statusCode: 200},
  );
  assert.deepEqual(
    await waitForHealth(
      `http://127.0.0.1:${port}/health`,
      {status: 'OK', version},
      2_000,
    ),
    {status: 'OK', version},
  );
});

test('portable health response parser accepts only strict bounded framing', () => {
  const validBody = Buffer.from('{"status":"OK"}');
  assert.deepEqual(
    parseHealthHttpResponse(Buffer.concat([
      Buffer.from([
        'HTTP/1.1 200 OK',
        `Content-Length: ${validBody.length}`,
        'Connection: close',
        '',
        '',
      ].join('\r\n')),
      validBody,
    ])),
    {body: validBody.toString('utf8'), statusCode: 200},
  );
  assert.deepEqual(
    parseHealthHttpResponse(Buffer.from([
      'HTTP/1.0 200 OK',
      'Connection: close',
      '',
      '{"status":"OK"}',
    ].join('\r\n'))),
    {body: '{"status":"OK"}', statusCode: 200},
  );

  const invalidResponses = [
    'HTTP/2 200 OK\r\nContent-Length: 0\r\n\r\n',
    'HTTP/1.1 100 Continue\r\nConnection: close\r\n\r\nHTTP/1.1 200 OK\r\n\r\n',
    'HTTP/1.1 200 OK\r\nBad Header: value\r\nContent-Length: 0\r\n\r\n',
    'HTTP/1.1 200 OK\r\n Folded: value\r\nContent-Length: 0\r\n\r\n',
    'HTTP/1.1 200 OK\nContent-Length: 0\n\n',
    'HTTP/1.1 200 OK\r\nContent-Length: 0\r\nContent-Length: 0\r\n\r\n',
    'HTTP/1.1 200 OK\r\nContent-Length: 0\r\nContent-Length: 1\r\n\r\n',
    'HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n0\r\n\r\n',
    'HTTP/1.1 200 OK\r\nContent-Length: 0\r\nTransfer-Encoding: chunked\r\n\r\n',
    'HTTP/1.1 200 OK\r\n\r\n',
    'HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nx',
    'HTTP/1.1 200 OK\r\nContent-Length: 1\r\n\r\nxx',
    'HTTP/1.1 200 OK\r\nContent-Length: 19\r\n\r\nHTTP/1.1 200 OK\r\n\r\n',
  ];
  for (const response of invalidResponses) {
    assert.throws(
      () => parseHealthHttpResponse(Buffer.from(response)),
      /invalid health HTTP response/,
      response,
    );
  }

  let bodyLength = 64 * 1024;
  let boundaryHeader;
  do {
    boundaryHeader = Buffer.from(
      `HTTP/1.0 200 OK\r\nContent-Length: ${bodyLength}\r\n\r\n`,
    );
    bodyLength = (64 * 1024) - boundaryHeader.length;
  } while (
    boundaryHeader.length + bodyLength !== 64 * 1024 ||
    !boundaryHeader.includes(Buffer.from(`Content-Length: ${bodyLength}`))
  );
  const boundaryResponse = Buffer.concat([
    boundaryHeader,
    Buffer.alloc(bodyLength, 'x'),
  ]);
  assert.equal(boundaryResponse.length, 64 * 1024);
  assert.equal(parseHealthHttpResponse(boundaryResponse).body.length, bodyLength);
  assert.throws(
    () => parseHealthHttpResponse(Buffer.concat([boundaryResponse, Buffer.from('x')])),
    /health response exceeded 65536 bytes/,
  );
});

test('portable raw health probe times out partial responses and closes each socket', async (t) => {
  const fixtures = [];
  t.after(async () => {
    await Promise.all(fixtures.map((fixture) => fixture.close()));
  });
  for (const partialResponse of [
    'HTTP/1.0 200 OK\r\nContent-Len',
    'HTTP/1.0 200 OK\r\nContent-Length: 20\r\n\r\n{"status":',
  ]) {
    let observedSocket;
    const fixture = await startRawResponseServer((socket) => {
      observedSocket = socket;
      socket.write(partialResponse);
    });
    fixtures.push(fixture);
    await assert.rejects(
      directHttpHealthProbe(
        `http://127.0.0.1:${fixture.port}/health`,
        150,
      ),
      (error) => {
        assert.equal(error?.code, 'ETIMEDOUT');
        assert.match(
          error.message,
          /during receiving response; received [1-9]\d* bytes$/,
        );
        return true;
      },
    );
    assert.ok(observedSocket, 'partial-response server did not observe a connection');
    await waitForSocketClose(observedSocket);
  }
});

test('portable raw health probe honors pre-connect and connected cancellation', async (t) => {
  let connections = 0;
  let connectedSocket;
  let resolveConnected;
  const connected = new Promise((resolve) => {
    resolveConnected = resolve;
  });
  const fixture = await startRawResponseServer((socket) => {
    connections++;
    connectedSocket = socket;
    resolveConnected();
  });
  t.after(() => fixture.close());

  const preAborted = new AbortController();
  preAborted.abort(new Error('pre-aborted fixture'));
  await assert.rejects(
    directHttpHealthProbe(
      `http://127.0.0.1:${fixture.port}/health`,
      2_000,
      preAborted.signal,
    ),
    /pre-aborted fixture/,
  );
  assert.equal(connections, 0);

  const controller = new AbortController();
  const probe = directHttpHealthProbe(
    `http://127.0.0.1:${fixture.port}/health`,
    2_000,
    controller.signal,
  );
  await connected;
  controller.abort(new Error('connected fixture cancelled'));
  await assert.rejects(probe, /connected fixture cancelled/);
  await waitForSocketClose(connectedSocket);
});

test('portable raw health probe rejects malformed EOF and closes its socket', async (t) => {
  let observedSocket;
  const fixture = await startRawResponseServer((socket) => {
    observedSocket = socket;
    socket.end('HTTP/1.0 200 OK\n\n{"status":"OK"}');
  });
  t.after(() => fixture.close());
  await assert.rejects(
    directHttpHealthProbe(
      `http://127.0.0.1:${fixture.port}/health`,
      2_000,
    ),
    /missing CRLF header terminator/,
  );
  assert.ok(observedSocket, 'malformed-response server did not observe a connection');
  await waitForSocketClose(observedSocket);
});

test('portable readiness independently proves backend and frontend payloads', async (t) => {
  const backend = http.createServer((_request, response) => {
    response.writeHead(200, {'Content-Type': 'application/json'});
    response.end(JSON.stringify({status: 'OK', version: 'fixture-version'}));
  });
  const frontend = http.createServer((_request, response) => {
    response.writeHead(200, {'Content-Type': 'application/json'});
    response.end(JSON.stringify({status: 'OK', surface: 'frontend'}));
  });
  const backendPort = await listenOnLoopback(backend);
  const frontendPort = await listenOnLoopback(frontend);
  t.after(async () => {
    await Promise.all([closeHttpServer(backend), closeHttpServer(frontend)]);
  });
  assert.deepEqual(
    await waitForReadiness({
      backendUrl: `http://127.0.0.1:${backendPort}/health`,
      frontendUrl: `http://127.0.0.1:${frontendPort}/health`,
      launcherExitPromise: new Promise(() => {}),
      version: 'fixture-version',
    }),
    [
      {status: 'OK', version: 'fixture-version'},
      {status: 'OK', surface: 'frontend'},
    ],
  );
});

test('portable health probe timeout reports ETIMEDOUT and closes its socket', async (t) => {
  let healthSocket;
  const fixture = await startRawResponseServer((socket) => {
    healthSocket = socket;
  });
  t.after(() => fixture.close());

  await assert.rejects(
    waitForHealth(
      `http://127.0.0.1:${fixture.port}/health`,
      {status: 'OK'},
      300,
    ),
    /health request exceeded \d+ms during awaiting response; received 0 bytes \(ETIMEDOUT\)/,
  );
  assert.ok(healthSocket, 'health server did not observe a connection');
  await waitForSocketClose(healthSocket);
});

test('portable readiness cancels and settles the peer probe after one health failure', async (t) => {
  const failing = http.createServer((_request, response) => {
    response.writeHead(503, {'Content-Type': 'application/json'});
    response.end(JSON.stringify({status: 'ERROR'}));
  });
  const failingPort = await listenOnLoopback(failing);
  t.after(() => closeHttpServer(failing));

  let hangingSocket;
  let hangingRequestResolve;
  const hangingRequest = new Promise((resolve) => {
    hangingRequestResolve = resolve;
  });
  const hanging = http.createServer((_request, _response) => {
    hangingRequestResolve();
  });
  hanging.once('connection', (socket) => {
    hangingSocket = socket;
  });
  const hangingPort = await listenOnLoopback(hanging);
  t.after(() => closeHttpServer(hanging));

  const readiness = waitForReadiness({
    backendTimeoutMs: 300,
    backendUrl: `http://127.0.0.1:${failingPort}/health`,
    frontendTimeoutMs: 5_000,
    frontendUrl: `http://127.0.0.1:${hangingPort}/health`,
    launcherExitPromise: new Promise(() => {}),
    version: 'fixture-version',
  });
  await hangingRequest;
  await assert.rejects(readiness, /did not become healthy/);
  assert.ok(hangingSocket, 'hanging frontend did not observe a connection');
  await waitForSocketClose(hangingSocket);
});

test('portable readiness cancels both probes when the launcher exits', async (t) => {
  const sockets = [];
  let backendRequestResolve;
  const backendRequest = new Promise((resolve) => {
    backendRequestResolve = resolve;
  });
  const hanging = http.createServer((_request, _response) => {
    backendRequestResolve();
  });
  hanging.on('connection', (socket) => sockets.push(socket));
  const backendPort = await listenOnLoopback(hanging);
  t.after(() => closeHttpServer(hanging));

  let frontendRequestResolve;
  const frontendRequest = new Promise((resolve) => {
    frontendRequestResolve = resolve;
  });
  const second = http.createServer((_request, _response) => {
    frontendRequestResolve();
  });
  second.on('connection', (socket) => sockets.push(socket));
  const frontendPort = await listenOnLoopback(second);
  t.after(() => closeHttpServer(second));

  await assert.rejects(
    waitForReadiness({
      backendUrl: `http://127.0.0.1:${backendPort}/health`,
      frontendUrl: `http://127.0.0.1:${frontendPort}/health`,
      launcherExitPromise: Promise.all([
        backendRequest,
        frontendRequest,
      ]).then(() => ({code: 23, signal: null})),
      version: 'fixture-version',
    }),
    /launcher exited before readiness: code=23/,
  );
  assert.equal(sockets.length, 2);
  await Promise.all(sockets.map((socket) => waitForSocketClose(socket)));
});

test('portable health errors preserve bounded response-limit diagnostics', async (t) => {
  const oversized = http.createServer((_request, response) => {
    response.writeHead(200, {'Content-Type': 'application/json'});
    response.end('x'.repeat(70 * 1024));
  });
  const port = await listenOnLoopback(oversized);
  t.after(() => closeHttpServer(oversized));

  await assert.rejects(
    waitForHealth(
      `http://127.0.0.1:${port}/health`,
      {status: 'OK'},
      500,
    ),
    /ERR_HEALTH_RESPONSE_TOO_LARGE/,
  );
});

test('every archive runtime probe receives the isolated smoke environment', () => {
  const env = isolatedSmokeEnv(
    {
      PATH: '/bin',
      HOME: '/real/home',
      USERPROFILE: 'C:\\real-home',
      NODE_OPTIONS: '--require=/untrusted/hook.js',
      OPENAI_API_KEY: 'provider-secret',
    },
    '/evidence/fresh-home',
  );
  assert.equal(env.PATH, '/bin');
  assert.equal(env.HOME, '/evidence/fresh-home');
  assert.equal(env.USERPROFILE, '/evidence/fresh-home');
  assert.equal(env.XDG_CONFIG_HOME, path.join('/evidence/fresh-home', '.config'));
  assert.equal(env.LOCALAPPDATA, path.join('/evidence/fresh-home', 'AppData', 'Local'));
  assert.equal(env.NODE_OPTIONS, undefined);
  assert.equal(env.OPENAI_API_KEY, undefined);

  let received;
  const result = runArchiveBinary(
    '/archive/runtime/node',
    ['--version'],
    'bundled Node.js',
    env,
    (command, args, label, options) => {
      received = {command, args, label, options};
      return {stdout: 'v24.0.0', stderr: ''};
    },
  );
  assert.equal(result.stdout, 'v24.0.0');
  assert.deepEqual(received, {
    command: '/archive/runtime/node',
    args: ['--version'],
    label: 'bundled Node.js',
    options: {
      env,
      killSignal: 'SIGKILL',
      timeout: 30_000,
    },
  });
});

test('portable smoke validates the complete lifecycle receipt contract', () => {
  const expected = {
    backendPort: 3100,
    commit: 'abc123',
    frontendPort: 10100,
    target: 'linux-x64',
    version: '1.2.3',
  };
  const receipt = {
    schemaVersion: 2,
    version: expected.version,
    gitCommit: expected.commit,
    packageTarget: expected.target,
    containment: 'service-process-groups',
    exitReason: 'shutdown-file',
    success: true,
    ports: {
      backend: expected.backendPort,
      frontend: expected.frontendPort,
      released: true,
    },
    services: [
      {
        name: 'backend',
        pid: 101,
        gracefulRequested: true,
        escalated: false,
        result: {exitCode: 0, success: true},
      },
      {
        name: 'frontend',
        pid: 102,
        gracefulRequested: true,
        escalated: false,
        result: {exitCode: 0, success: true},
      },
    ],
    finishedAt: new Date().toISOString(),
  };
  assert.equal(validateLifecycleReceipt(receipt, expected), receipt);

  for (const candidate of [
    {...receipt, services: []},
    {...receipt, gitCommit: 'wrong'},
    {...receipt, packageTarget: 'windows-x64'},
    {...receipt, containment: 'windows-job-object'},
    {...receipt, ports: {...receipt.ports, frontend: 10101}},
    {...receipt, services: [receipt.services[0], {...receipt.services[0]}]},
    {
      ...receipt,
      services: [
        {...receipt.services[0], escalated: true},
        receipt.services[1],
      ],
    },
  ]) {
    assert.throws(() => validateLifecycleReceipt(candidate, expected), /invalid lifecycle receipt/);
  }
});

test('portable smoke finds nested descendants in post-order', () => {
  assert.deepEqual(
    collectDescendantPids([
      '10 1',
      '20 10',
      '30 20',
      '40 10',
      '50 999',
    ], 10),
    [30, 20, 40],
  );
});

test('portable smoke records process-enumeration failures instead of failing open', () => {
  const monitor = startProcessTreeMonitor(
    123,
    process.env,
    () => ({status: 1, stderr: 'permission denied'}),
    60_000,
  );
  monitor.stop();
  const evidence = monitor.evidence();
  assert.equal(evidence.enumerationSucceeded, false);
  assert.equal(evidence.samples, 0);
  assert.ok(evidence.failures.some(message => message.includes('permission denied')));
});

test('portable smoke resolves taskkill from trusted Windows System32', () => {
  assert.equal(
    windowsSystemBinary('taskkill.exe', {SystemRoot: 'C:\\Windows'}),
    path.win32.join('C:\\Windows', 'System32', 'taskkill.exe'),
  );
  assert.throws(
    () => windowsSystemBinary('taskkill.exe', {PATH: 'C:\\archive'}),
    /SystemRoot/,
  );
});

test('portable smoke enforces the Linux glibc baseline numerically', () => {
  assert.equal(versionAtLeast('2.34', '2.34'), true);
  assert.equal(versionAtLeast('2.36', '2.34'), true);
  assert.equal(versionAtLeast('2.33', '2.34'), false);
  assert.equal(versionAtLeast('', '2.34'), false);
});

test('portable smoke failure cleanup kills a launcher and detached service child', {
  skip: process.platform === 'win32',
}, async (t) => {
  const parent = spawn(process.execPath, ['-e', [
    "const {spawn}=require('child_process');",
    "const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'});",
    "process.stdout.write(String(child.pid)+'\\n');",
    'setInterval(()=>{},1000);',
  ].join('')], {stdio: ['ignore', 'pipe', 'ignore']});
  t.after(() => {
    try {
      process.kill(parent.pid, 'SIGKILL');
    } catch {}
  });
  const childPid = await new Promise((resolve, reject) => {
    parent.stdout.once('data', (chunk) => resolve(Number(String(chunk).trim())));
    parent.once('error', reject);
  });
  t.after(() => {
    try {
      process.kill(-childPid, 'SIGKILL');
    } catch {}
  });

  forceKillProcessTree(parent.pid);
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    let parentAlive = true;
    let childAlive = true;
    try {
      process.kill(parent.pid, 0);
    } catch {
      parentAlive = false;
    }
    try {
      process.kill(childPid, 0);
    } catch {
      childAlive = false;
    }
    if (!parentAlive && !childAlive) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail('launcher or detached child survived failure cleanup');
});

test('portable smoke remembers observed service children after the launcher exits', {
  skip: process.platform === 'win32',
}, async (t) => {
  const parent = spawn(process.execPath, ['-e', [
    "const {spawn}=require('child_process');",
    "const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'});",
    "process.stdout.write(String(child.pid)+'\\n');",
    'setTimeout(()=>process.exit(0),300);',
  ].join('')], {stdio: ['ignore', 'pipe', 'ignore']});
  const monitor = startProcessTreeMonitor(parent.pid);
  t.after(() => monitor.stop());
  const childPid = await new Promise((resolve, reject) => {
    parent.stdout.once('data', (chunk) => resolve(Number(String(chunk).trim())));
    parent.once('error', reject);
  });
  t.after(() => {
    try {
      process.kill(-childPid, 'SIGKILL');
    } catch {}
  });
  await new Promise((resolve, reject) => {
    parent.once('exit', resolve);
    parent.once('error', reject);
  });
  monitor.stop();
  assert.equal(monitor.observed.has(childPid), true);
  for (const pid of monitor.observed) forceKillProcessTree(pid);

  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    try {
      process.kill(childPid, 0);
    } catch {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail('observed detached child survived cleanup after launcher exit');
});
