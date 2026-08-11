// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import assert from 'node:assert/strict';
import {spawn, spawnSync} from 'node:child_process';
import {EventEmitter} from 'node:events';
import {createRequire} from 'node:module';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import {PassThrough} from 'node:stream';
import test from 'node:test';

const require = createRequire(import.meta.url);
const repoRoot = path.resolve(import.meta.dirname, '../..');
const {
  assertMatchingHost,
  collectDescendantPids,
  createEvidenceDirectory,
  directHttpHealthProbe,
  forceKillProcessTree,
  healthProbeForTarget,
  healthProbeIdForTarget,
  isolatedSmokeEnv,
  packagePaths,
  parseWindowsProcessSnapshot,
  parseArgs,
  probePortableNativeModules,
  probeWindowsDpapiSecretStore,
  requestLocalJson,
  runArchiveBinary,
  sanitizedSmokeEnv,
  smokeProviderConfiguration,
  startProcessTreeMonitor,
  validateLifecycleReceipt,
  versionAtLeast,
  waitForHealth,
  waitForReadiness,
  windowsDpapiProbeEnv,
  windowsDescendantPids,
  windowsGoHealthProbe,
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

function mockWindowsProbeEnvironment(overrides = {}) {
  return {
    PATH: process.env.PATH,
    SMARTPERFETTO_WINDOWS_GATE_HELPER_PATH:
      'C:\\gate\\smartperfetto-health-probe.exe',
    SystemRoot: 'C:\\Windows',
    ...overrides,
  };
}

function mockRegularProbeFile() {
  return {
    isFile: () => true,
    isSymbolicLink: () => false,
  };
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

async function captureProbeSockets(run) {
  const originalRequest = http.request;
  const sockets = [];
  http.request = (...args) => {
    const request = originalRequest(...args);
    request.once('socket', (socket) => sockets.push(socket));
    return request;
  };
  try {
    await run();
  } finally {
    http.request = originalRequest;
  }
  return sockets;
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
  assert.equal(
    windows.sodiumPrebuild,
    path.join(
      '/tmp/root',
      'package',
      'backend',
      'node_modules',
      'sodium-native',
      'prebuilds',
      'win32-x64',
      'sodium-native.node',
    ),
  );

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

test('portable native-module probe performs sqlite and sodium operations', () => {
  const evidence = probePortableNativeModules({
    node: process.execPath,
    betterSqlite3: path.join(
      repoRoot,
      'backend/node_modules/better-sqlite3',
    ),
    sodium: path.join(
      repoRoot,
      'backend/node_modules/sodium-native',
    ),
  }, process.env);

  assert.deepEqual(evidence, {
    betterSqlite3: 'query-ok',
    sodiumNative: 'secretbox-ok',
  });
});

test('Provider archive smoke creates, activates, masks, persists, and removes a local profile', async () => {
  const providerId = 'provider-smoke-id';
  const providerFile = path.join(os.tmpdir(), `providers-${process.pid}-${Date.now()}.json`);
  fs.writeFileSync(providerFile, '[]\n');
  const calls = [];
  const requester = async (url, options = {}) => {
    calls.push({url, options});
    if (options.method === 'POST' && url.endsWith('/api/v1/providers')) {
      fs.writeFileSync(providerFile, JSON.stringify([{
        id: providerId,
        connection: {openaiApiKey: 'smartperfetto-not-a-real-credential'},
      }]));
      return {statusCode: 201, body: {success: true, provider: {id: providerId}}};
    }
    if (options.method === 'POST' && url.endsWith(`/${providerId}/activate`)) {
      return {statusCode: 200, body: {success: true}};
    }
    if (url.endsWith('/effective')) {
      return {
        statusCode: 200,
        body: {
          source: 'provider-manager',
          provider: {
            id: providerId,
            connection: {openaiApiKey: '****tial'},
          },
        },
      };
    }
    if (url.endsWith(`/${providerId}`) && !options.method) {
      return {
        statusCode: 200,
        body: {
          success: true,
          provider: {
            id: providerId,
            connection: {openaiApiKey: '****tial'},
          },
        },
      };
    }
    if (options.method === 'POST' && url.endsWith('/deactivate')) {
      return {statusCode: 200, body: {success: true}};
    }
    if (options.method === 'DELETE' && url.endsWith(`/${providerId}`)) {
      fs.writeFileSync(providerFile, '[]\n');
      return {statusCode: 200, body: {success: true}};
    }
    throw new Error(`unexpected request: ${url}`);
  };
  try {
    const evidence = await smokeProviderConfiguration(
      'http://127.0.0.1:3000',
      providerFile,
      requester,
    );
    assert.deepEqual(evidence, {
      created: true,
      activated: true,
      responseMasked: true,
      persistedUnderPortableDataRoot: true,
      cleanedUp: true,
    });
    assert.deepEqual(calls.map(call => call.options.method || 'GET'), [
      'POST',
      'POST',
      'GET',
      'GET',
      'POST',
      'DELETE',
    ]);
    assert.equal(calls.some(call => call.url.endsWith('/test')), false);
  } finally {
    fs.rmSync(providerFile, {force: true});
  }
});

test('loopback JSON requester rejects non-loopback URLs and parses bounded JSON', async () => {
  assert.throws(
    () => requestLocalJson('https://example.test/api'),
    /only permits loopback HTTP requests/,
  );
  const server = http.createServer((_request, response) => {
    response.writeHead(200, {'Content-Type': 'application/json'});
    response.end(JSON.stringify({success: true}));
  });
  const port = await listenOnLoopback(server);
  try {
    const result = await requestLocalJson(`http://127.0.0.1:${port}/api`);
    assert.deepEqual(result, {statusCode: 200, body: {success: true}});
  } finally {
    await closeHttpServer(server);
  }
});

test('loopback JSON requester bypasses ambient proxy settings', async (t) => {
  let proxyRequests = 0;
  const proxy = http.createServer((_request, response) => {
    proxyRequests++;
    response.writeHead(502);
    response.end('proxy must not receive loopback Provider smoke traffic');
  });
  const proxyPort = await listenOnLoopback(proxy);
  t.after(() => closeHttpServer(proxy));

  let directRequests = 0;
  const backend = http.createServer((_request, response) => {
    directRequests++;
    response.writeHead(200, {'Content-Type': 'application/json'});
    response.end(JSON.stringify({success: true}));
  });
  const backendPort = await listenOnLoopback(backend);
  t.after(() => closeHttpServer(backend));

  const smokeModule = path.join(repoRoot, 'scripts/smoke-portable-archive.cjs');
  const child = spawn(process.execPath, ['-e', [
    `const {requestLocalJson}=require(${JSON.stringify(smokeModule)});`,
    'requestLocalJson(process.argv[1])',
    '  .then((result) => process.stdout.write(JSON.stringify(result)))',
    '  .catch((error) => { console.error(error.stack || error); process.exitCode = 1; });',
  ].join('\n'), `http://127.0.0.1:${backendPort}/api/v1/providers/effective`], {
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
    {statusCode: 200, body: {success: true}},
  );
  assert.equal(proxyRequests, 0);
  assert.equal(directRequests, 1);
});

test('Windows DPAPI package probe uses the packaged Node and SecretStore module', () => {
  const invocations = [];
  const evidence = probeWindowsDpapiSecretStore({
    node: 'C:\\package\\runtime\\node\\node.exe',
    localSecretStore: 'C:\\package\\backend\\dist\\services\\providerManager\\localSecretStore.js',
  }, 'C:\\evidence\\data', {SYSTEMROOT: 'C:\\Windows'}, (...args) => {
    invocations.push(args);
    return {
      status: 0,
      stdout: JSON.stringify({
        source: 'windows-dpapi',
        reopened: true,
        plaintextMasterKey: false,
      }),
      stderr: '',
    };
  });

  assert.deepEqual(evidence, {
    source: 'windows-dpapi',
    reopened: true,
    plaintextMasterKey: false,
  });
  assert.equal(invocations.length, 1);
  assert.equal(invocations[0][0], 'C:\\package\\runtime\\node\\node.exe');
  assert.deepEqual(invocations[0][3], {
    env: {SYSTEMROOT: 'C:\\Windows', NODE_ENV: 'production'},
    killSignal: 'SIGKILL',
    timeout: 135_000,
  });
});

test('Windows DPAPI probe preserves the host profile without leaking credentials', () => {
  const env = windowsDpapiProbeEnv({
    SystemRoot: 'C:\\Windows',
    HOME: 'C:\\Users\\runneradmin',
    USERPROFILE: 'C:\\Users\\runneradmin',
    APPDATA: 'C:\\Users\\runneradmin\\AppData\\Roaming',
    LOCALAPPDATA: 'C:\\Users\\runneradmin\\AppData\\Local',
    HOMEDRIVE: 'C:',
    HOMEPATH: '\\Users\\runneradmin',
    PSMODULEPATH: 'C:\\Program Files\\WindowsPowerShell\\Modules;C:\\Windows\\system32\\WindowsPowerShell\\v1.0\\Modules',
    PROGRAMFILES: 'C:\\Program Files',
    'PROGRAMFILES(X86)': 'C:\\Program Files (x86)',
    PROGRAMW6432: 'C:\\Program Files',
    SYSTEMDRIVE: 'C:',
    GH_TOKEN: 'must-not-leak',
    SMARTPERFETTO_SECRET_STORE_MASTER_KEY: 'must-not-leak',
  }, {
    SYSTEMROOT: 'C:\\Windows',
    HOME: 'D:\\evidence\\home',
    USERPROFILE: 'D:\\evidence\\home',
    APPDATA: 'D:\\evidence\\home\\AppData\\Roaming',
    LOCALAPPDATA: 'D:\\evidence\\home\\AppData\\Local',
  });

  assert.deepEqual(env, {
    SYSTEMROOT: 'C:\\Windows',
    HOME: 'C:\\Users\\runneradmin',
    USERPROFILE: 'C:\\Users\\runneradmin',
    APPDATA: 'C:\\Users\\runneradmin\\AppData\\Roaming',
    LOCALAPPDATA: 'C:\\Users\\runneradmin\\AppData\\Local',
    HOMEDRIVE: 'C:',
    HOMEPATH: '\\Users\\runneradmin',
    PSMODULEPATH: 'C:\\Program Files\\WindowsPowerShell\\Modules;C:\\Windows\\system32\\WindowsPowerShell\\v1.0\\Modules',
    PROGRAMFILES: 'C:\\Program Files',
    'PROGRAMFILES(X86)': 'C:\\Program Files (x86)',
    PROGRAMW6432: 'C:\\Program Files',
    SYSTEMDRIVE: 'C:',
  });
  assert.equal(env.GH_TOKEN, undefined);
  assert.equal(env.SMARTPERFETTO_SECRET_STORE_MASTER_KEY, undefined);
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

test('portable health probe bypasses startup proxy settings', async (t) => {
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
  assert.equal(connectionHeader, 'keep-alive');
  assert.ok(healthSocket, 'health server did not observe a connection');
  await waitForSocketClose(healthSocket);
});

test('portable smoke selects and records the required health client by target', () => {
  assert.equal(healthProbeIdForTarget('windows-x64'), 'windows-go-net-http');
  assert.equal(healthProbeIdForTarget('macos-arm64'), 'node-http');
  assert.equal(healthProbeIdForTarget('linux-x64'), 'node-http');
  assert.equal(healthProbeForTarget('windows-x64').attemptTimeoutMs, 5_000);
  assert.equal(healthProbeForTarget('linux-x64').attemptTimeoutMs, 2_000);
  assert.throws(() => healthProbeIdForTarget('unknown-target'), /Unsupported target/);
});

test('Windows health probe executes a trusted fixed Go binary with bounded input', async () => {
  const payload = {status: 'OK', version: 'fixture-version'};
  let invocation;
  const result = await windowsGoHealthProbe(
    'http://127.0.0.1:3100/health',
    2_000,
    undefined,
    {
      sourceEnv: mockWindowsProbeEnvironment({
        GH_TOKEN: 'must-not-leak',
        HTTP_PROXY: 'http://127.0.0.1:1',
      }),
      statProbePath: mockRegularProbeFile,
      spawnProcess(command, args, options) {
        invocation = {args, command, options};
        return spawn(process.execPath, ['-e', [
          'const body = Buffer.from(JSON.stringify({status: "OK", version: "fixture-version"}));',
          'process.stdout.write(`200\\n${body.toString("base64")}`);',
        ].join('\n')], options);
      },
    },
  );

  assert.deepEqual(
    {...result, body: JSON.parse(result.body)},
    {body: payload, statusCode: 200},
  );
  assert.equal(
    invocation.command,
    'C:\\gate\\smartperfetto-health-probe.exe',
  );
  assert.deepEqual(invocation.args, [
    'http://127.0.0.1:3100/health',
    '1600',
  ]);
  assert.doesNotMatch(JSON.stringify(invocation.options.env), /must-not-leak|HTTP_PROXY/);
  assert.equal(invocation.options.env.GH_TOKEN, undefined);
  assert.deepEqual(invocation.options.stdio, ['ignore', 'pipe', 'pipe']);
  assert.equal(invocation.options.windowsHide, true);
});

test('Windows health probe rejects an untrusted executable path before spawning', () => {
  assert.throws(
    () => windowsGoHealthProbe(
      'http://127.0.0.1:3100/health',
      2_000,
      undefined,
      {sourceEnv: {SystemRoot: 'C:\\Windows'}},
    ),
    /must name an absolute \.exe path/,
  );
  assert.throws(
    () => windowsGoHealthProbe(
      'http://127.0.0.1:3100/health',
      2_000,
      undefined,
      {
        sourceEnv: mockWindowsProbeEnvironment(),
        statProbePath: () => ({
          isFile: () => true,
          isSymbolicLink: () => true,
        }),
      },
    ),
    /regular non-symlink file/,
  );
});

test('Windows health probe has a hard process deadline and leaves no child', async () => {
  let child;
  await assert.rejects(
    windowsGoHealthProbe(
      'http://127.0.0.1:3100/health',
      100,
      undefined,
      {
        sourceEnv: mockWindowsProbeEnvironment(),
        statProbePath: mockRegularProbeFile,
        spawnProcess(_command, _args, options) {
          child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], options);
          return child;
        },
      },
    ),
    (error) => {
      assert.equal(error?.code, 'ETIMEDOUT');
      assert.match(error.message, /exceeded 100ms/);
      return true;
    },
  );
  assert.ok(child);
  assert.notEqual(child.exitCode === null && child.signalCode === null, true);
  assert.throws(() => process.kill(child.pid, 0), /ESRCH/);
});

test('Windows health probe cancellation terminates and settles its child', async () => {
  const controller = new AbortController();
  let child;
  const probe = windowsGoHealthProbe(
    'http://127.0.0.1:3100/health',
    5_000,
    controller.signal,
    {
      sourceEnv: mockWindowsProbeEnvironment(),
      statProbePath: mockRegularProbeFile,
      spawnProcess(_command, _args, options) {
        child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], options);
        return child;
      },
    },
  );
  controller.abort(new Error('Windows health fixture cancelled'));

  await assert.rejects(probe, /Windows health fixture cancelled/);
  assert.ok(child);
  assert.notEqual(child.exitCode === null && child.signalCode === null, true);
  assert.throws(() => process.kill(child.pid, 0), /ESRCH/);
});

test('Windows health probe force-kills and settles when direct termination is refused', async () => {
  const child = new EventEmitter();
  child.pid = 4242;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => false;
  let taskkillInvocation;

  await assert.rejects(
    windowsGoHealthProbe(
      'http://127.0.0.1:3100/health',
      5,
      undefined,
      {
        sourceEnv: mockWindowsProbeEnvironment(),
        statProbePath: mockRegularProbeFile,
        spawnProcess() {
          return child;
        },
        spawnSyncProcess(command, args, options) {
          taskkillInvocation = {args, command, options};
          return {status: 0};
        },
        terminationGraceMs: 5,
        terminationSettlementMs: 10,
      },
    ),
    (error) => {
      assert.equal(error?.code, 'ECHILDSTUCK');
      assert.match(error.message, /termination could not be confirmed/);
      return true;
    },
  );

  assert.equal(taskkillInvocation.command, 'C:\\Windows\\System32\\taskkill.exe');
  assert.deepEqual(taskkillInvocation.args, ['/T', '/F', '/PID', '4242']);
  assert.deepEqual(taskkillInvocation.options.stdio, 'ignore');
  assert.equal(taskkillInvocation.options.timeout, 10);
  assert.equal(taskkillInvocation.options.windowsHide, true);
});

for (const [streamName, limitBytes] of [
  ['stdout', 128 * 1024],
  ['stderr', 32 * 1024],
]) {
  test(`Windows health probe bounds ${streamName} and terminates its child`, async () => {
    let child;
    await assert.rejects(
      windowsGoHealthProbe(
        'http://127.0.0.1:3100/health',
        2_000,
        undefined,
        {
          sourceEnv: mockWindowsProbeEnvironment(),
          statProbePath: mockRegularProbeFile,
          spawnProcess(_command, _args, options) {
            child = spawn(process.execPath, ['-e', [
              `process.${streamName}.write(Buffer.alloc(${limitBytes + 1}));`,
              'setInterval(() => {}, 1000);',
            ].join('\n')], options);
            return child;
          },
        },
      ),
      new RegExp(`${streamName} exceeded ${limitBytes} bytes`),
    );
    assert.ok(child);
    assert.notEqual(child.exitCode === null && child.signalCode === null, true);
    assert.throws(() => process.kill(child.pid, 0), /ESRCH/);
  });
}

test('Windows fixed Go helper runs its real health and process contracts on Windows', {
  skip: process.platform !== 'win32',
}, async (t) => {
  const fixtureLauncher = spawn(
    process.execPath,
    ['-e', [
      'const {spawn}=require("node:child_process");',
      'const child=spawn(process.execPath,["-e","setInterval(() => {}, 1000)"],{stdio:"ignore",windowsHide:true});',
      'process.stdout.write(`${child.pid}\\n`);',
      'setInterval(() => {}, 1000);',
    ].join('\n')],
    {stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true},
  );
  const fixtureClosed = new Promise((resolve) => {
    fixtureLauncher.once('close', resolve);
  });
  t.after(async () => {
    if (fixtureLauncher.pid) {
      let alive = true;
      try {
        process.kill(fixtureLauncher.pid, 0);
      } catch (error) {
        if (error?.code !== 'ESRCH') throw error;
        alive = false;
      }
      if (alive) {
        const result = spawnSync(
          windowsSystemBinary('taskkill.exe', process.env),
          ['/T', '/F', '/PID', String(fixtureLauncher.pid)],
          {
            encoding: 'utf8',
            timeout: 5_000,
            windowsHide: true,
          },
        );
        let survivedCleanup = false;
        if (!result.error && result.status !== 0 && !result.signal) {
          try {
            process.kill(fixtureLauncher.pid, 0);
            survivedCleanup = true;
          } catch (error) {
            if (error?.code !== 'ESRCH') throw error;
          }
        }
        if (
          result.error ||
          result.signal ||
          (result.status !== 0 && survivedCleanup)
        ) {
          throw new Error(
            `fixture cleanup failed: ${
              result.error?.message ||
              String(result.stderr || '').trim() ||
              `exit ${result.status}, signal ${result.signal || 'none'}`
            }`,
          );
        }
      }
    }
    await Promise.race([
      fixtureClosed,
      new Promise((_, reject) => {
        const deadline = setTimeout(
          () => reject(new Error('fixture launcher did not close after cleanup')),
          5_000,
        );
        deadline.unref();
      }),
    ]);
  });
  const fixtureChildPid = await new Promise((resolve, reject) => {
    let output = '';
    const deadline = setTimeout(
      () => reject(new Error('fixture launcher did not report its child PID')),
      5_000,
    );
    fixtureLauncher.once('error', (error) => {
      clearTimeout(deadline);
      reject(error);
    });
    fixtureLauncher.once('exit', (code, signal) => {
      clearTimeout(deadline);
      reject(new Error(
        `fixture launcher exited before reporting its child: code=${code}, signal=${signal}`,
      ));
    });
    fixtureLauncher.stdout.on('data', (chunk) => {
      output += chunk.toString('utf8');
      const match = /^(\d+)\r?\n/.exec(output);
      if (!match) return;
      clearTimeout(deadline);
      resolve(Number(match[1]));
    });
  });

  let helperPid;
  let snapshotRows;
  const fixtureDescendants = windowsDescendantPids(
    fixtureLauncher.pid,
    process.env,
    (command, args, options) => {
      const result = spawnSync(command, args, options);
      helperPid = result.pid;
      snapshotRows = parseWindowsProcessSnapshot(result.stdout);
      return result;
    },
  );
  assert.ok(Number.isSafeInteger(helperPid) && helperPid > 0);
  const parentByPid = new Map(
    snapshotRows.map((row) => {
      const [pid, parentPid] = row.split(' ').map(Number);
      return [pid, parentPid];
    }),
  );
  assert.equal(parentByPid.get(fixtureChildPid), fixtureLauncher.pid);
  assert.equal(parentByPid.get(helperPid), process.pid);
  assert.equal(fixtureDescendants.includes(fixtureChildPid), true);
  assert.equal(fixtureDescendants.includes(helperPid), false);
  assert.equal(fixtureDescendants.includes(process.pid), false);
  assert.equal(fixtureDescendants.includes(fixtureLauncher.pid), false);
  assert.equal(new Set(fixtureDescendants).size, fixtureDescendants.length);

  let redirected = false;
  const health = http.createServer((request, response) => {
    if (request.url === '/redirect') {
      response.writeHead(302, {Location: '/followed'});
      response.end();
      return;
    }
    if (request.url === '/followed') redirected = true;
    response.writeHead(200, {'Content-Type': 'application/json'});
    response.end(JSON.stringify({status: 'OK', version: 'fixture-version'}));
  });
  const healthPort = await listenOnLoopback(health);
  t.after(() => closeHttpServer(health));

  let result;
  try {
    result = await windowsGoHealthProbe(
      `http://127.0.0.1:${healthPort}/health`,
      5_000,
      undefined,
      {
        sourceEnv: {
          ...process.env,
          ALL_PROXY: 'http://127.0.0.1:1',
          HTTP_PROXY: 'http://127.0.0.1:1',
          HTTPS_PROXY: 'http://127.0.0.1:1',
          NO_PROXY: '',
        },
      },
    );
  } catch (error) {
    throw new Error(`Windows Go 200 response phase failed: ${error.message}`, {
      cause: error,
    });
  }

  assert.equal(result.statusCode, 200);
  assert.deepEqual(
    JSON.parse(result.body),
    {status: 'OK', version: 'fixture-version'},
  );
  let redirectResult;
  try {
    redirectResult = await windowsGoHealthProbe(
      `http://127.0.0.1:${healthPort}/redirect`,
      5_000,
      undefined,
    );
  } catch (error) {
    throw new Error(`Windows Go redirect phase failed: ${error.message}`, {
      cause: error,
    });
  }
  assert.equal(redirectResult.statusCode, 302);
  assert.equal(redirected, false);
});

test('Windows health probe rejects malformed helper output', async () => {
  await assert.rejects(
    windowsGoHealthProbe(
      'http://127.0.0.1:3100/health',
      2_000,
      undefined,
      {
        sourceEnv: mockWindowsProbeEnvironment(),
        statProbePath: mockRegularProbeFile,
        spawnProcess(_command, _args, options) {
          return spawn(
            process.execPath,
            ['-e', 'process.stdout.write("200\\nnot canonical base64!")'],
            options,
          );
        },
      },
    ),
    /invalid response envelope/,
  );
});

test('portable health probe parses fragmented bytes and sends a fixed direct request', async (t) => {
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
  assert.match(request, /^GET \/health\?probe=portable HTTP\/1\.1\r\n/);
  assert.match(request, new RegExp(`\r\nHost: 127\\.0\\.0\\.1:${fixture.port}\r\n`));
  assert.match(request, /\r\nAccept: application\/json\r\n/);
  assert.match(request, /\r\nConnection: keep-alive\r\n/);
  assert.match(request, /\r\n\r\n$/);
  assert.ok(healthSocket, 'raw server did not observe a health connection');
  await waitForSocketClose(healthSocket);
});

test('portable health probe accepts the production frontend keep-alive response', async (t) => {
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
  let connectionHeader;
  let frontendSocket;
  frontend.once('request', (request) => {
    connectionHeader = request.headers.connection;
  });
  frontend.once('connection', (socket) => {
    frontendSocket = socket;
  });
  const port = await listenOnLoopback(frontend);
  t.after(async () => {
    await closeHttpServer(frontend);
    fs.rmSync(root, {recursive: true, force: true});
  });

  const probeSockets = await captureProbeSockets(async () => {
    assert.deepEqual(
      await waitForHealth(
        `http://127.0.0.1:${port}/health`,
        {status: 'OK', version},
        2_000,
      ),
      {status: 'OK', version},
    );
  });
  assert.equal(probeSockets.length, 1);
  assert.ok(probeSockets.every((socket) => socket.destroyed));
  assert.ok(frontendSocket, 'production frontend did not observe a connection');
  await waitForSocketClose(frontendSocket);
  assert.equal(connectionHeader, 'keep-alive');
});

test('portable health probe accepts only explicit IPv4 loopback URLs', () => {
  assert.throws(
    () => directHttpHealthProbe('http://localhost:3000/health', 100),
    /plain IPv4 loopback URL/,
  );
  assert.throws(
    () => directHttpHealthProbe('https://127.0.0.1:3000/health', 100),
    /plain IPv4 loopback URL/,
  );
  assert.throws(
    () => directHttpHealthProbe('http://user@127.0.0.1:3000/health', 100),
    /plain IPv4 loopback URL/,
  );
});

test('portable health probe times out partial responses and destroys each client socket', async (t) => {
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
    const probeSockets = await captureProbeSockets(() =>
      assert.rejects(
        directHttpHealthProbe(
          `http://127.0.0.1:${fixture.port}/health`,
          150,
        ),
        (error) => {
          assert.equal(error?.code, 'ETIMEDOUT');
          assert.match(error.message, /during (?:awaiting|receiving) response/);
          return true;
        },
      ),
    );
    assert.equal(probeSockets.length, 1);
    assert.ok(probeSockets.every((socket) => socket.destroyed));
    assert.ok(observedSocket, 'partial-response server did not observe a connection');
    observedSocket.destroy();
    await waitForSocketClose(observedSocket);
  }
});

test('portable health probe honors pre-connect and connected cancellation', async (t) => {
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
  const probeSockets = await captureProbeSockets(async () => {
    const probe = directHttpHealthProbe(
      `http://127.0.0.1:${fixture.port}/health`,
      2_000,
      controller.signal,
    );
    await connected;
    controller.abort(new Error('connected fixture cancelled'));
    await assert.rejects(probe, /connected fixture cancelled/);
  });
  assert.equal(probeSockets.length, 1);
  assert.ok(probeSockets.every((socket) => socket.destroyed));
  connectedSocket.destroy();
  await waitForSocketClose(connectedSocket);
});

test('portable health probe rejects malformed responses and closes its socket', async (t) => {
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
    /Parse Error|HPE_/,
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

test('portable health probe timeout reports ETIMEDOUT and destroys its client sockets', async (t) => {
  let healthSocket;
  const fixture = await startRawResponseServer((socket) => {
    healthSocket = socket;
  });
  t.after(() => fixture.close());

  const probeSockets = await captureProbeSockets(() =>
    assert.rejects(
      waitForHealth(
        `http://127.0.0.1:${fixture.port}/health`,
        {status: 'OK'},
        300,
      ),
      /health request exceeded \d+ms during awaiting response; received 0 bytes \(ETIMEDOUT\)/,
    ),
  );
  assert.ok(probeSockets.length > 0);
  assert.ok(probeSockets.every((socket) => socket.destroyed));
  assert.ok(healthSocket, 'health server did not observe a connection');
  healthSocket.destroy();
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
  let requestCount = 0;
  const oversized = http.createServer((_request, response) => {
    requestCount += 1;
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
  assert.equal(requestCount, 1);
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

test('Windows process snapshot parser accepts only complete canonical rows', () => {
  assert.deepEqual(
    parseWindowsProcessSnapshot('0 0\n10 1\n20 10\n'),
    ['0 0', '10 1', '20 10'],
  );

  for (const snapshot of [
    '',
    '10 1',
    '10 1\r\n',
    '10  1\n',
    '010 1\n',
    '10 nope\n',
    '4294967296 1\n',
    '10 1\n10 2\n',
    '10 1\n\n',
  ]) {
    assert.throws(
      () => parseWindowsProcessSnapshot(snapshot),
      /Windows process snapshot/,
      snapshot,
    );
  }
});

test('Windows process enumeration uses the fixed Go helper and strict tree rows', () => {
  let invocation;
  const descendants = windowsDescendantPids(
    10,
    mockWindowsProbeEnvironment({GH_TOKEN: 'must-not-leak'}),
    (command, args, options) => {
      invocation = {args, command, options};
      return {
        error: undefined,
        signal: null,
        status: 0,
        stderr: '',
        stdout: '0 0\n10 1\n20 10\n30 20\n40 10\n',
      };
    },
    mockRegularProbeFile,
  );

  assert.deepEqual(descendants, [30, 20, 40]);
  assert.equal(invocation.command, 'C:\\gate\\smartperfetto-health-probe.exe');
  assert.deepEqual(invocation.args, ['process-snapshot']);
  assert.equal(invocation.options.timeout, 5_000);
  assert.equal(invocation.options.windowsHide, true);
  assert.equal(invocation.options.env.GH_TOKEN, undefined);
});

test('Windows process enumeration fails closed on helper failures', () => {
  const oversized = `${'x'.repeat(8 * 1024 * 1024)}x`;
  const failures = [
    {
      error: Object.assign(new Error('timed out'), {code: 'ETIMEDOUT'}),
      signal: null,
      status: null,
      stderr: '',
      stdout: '',
    },
    {error: undefined, signal: null, status: 1, stderr: 'snapshot failed', stdout: ''},
    {error: undefined, signal: 'SIGKILL', status: null, stderr: '', stdout: ''},
    {error: undefined, signal: null, status: 0, stderr: '', stdout: ''},
    {error: undefined, signal: null, status: 0, stderr: '', stdout: 'not rows\n'},
    {error: undefined, signal: null, status: 0, stderr: '', stdout: '10 1\n10 2\n'},
    {error: undefined, signal: null, status: 0, stderr: '', stdout: oversized},
  ];

  for (const result of failures) {
    assert.throws(
      () => windowsDescendantPids(
        10,
        mockWindowsProbeEnvironment(),
        () => result,
        mockRegularProbeFile,
      ),
      /Windows process/,
    );
  }
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
