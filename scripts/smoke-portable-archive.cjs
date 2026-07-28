#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

'use strict';

const {spawn, spawnSync} = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');
const {
  TARGETS,
  extractArchiveToTemp,
  listEntries,
  normalizeVersion,
  readNodeRuntimePin,
} = require('./verify-portable-package.cjs');

const HOSTS = {
  'windows-x64': {platform: 'win32', arch: 'x64'},
  'macos-arm64': {platform: 'darwin', arch: 'arm64'},
  'linux-x64': {platform: 'linux', arch: 'x64'},
};
const SMOKE_ENV_ALLOWLIST = new Set([
  'COMSPEC',
  'HOME',
  'LANG',
  'LANGUAGE',
  'LC_ALL',
  'NODE_EXTRA_CA_CERTS',
  'NO_COLOR',
  'PATH',
  'PATHEXT',
  'SSL_CERT_DIR',
  'SSL_CERT_FILE',
  'SYSTEMROOT',
  'TEMP',
  'TERM',
  'TMP',
  'TMPDIR',
  'TZ',
  'USERPROFILE',
  'WINDIR',
]);
const HEALTH_RESPONSE_LIMIT_BYTES = 64 * 1024;
const HEALTH_PROBE_OUTPUT_LIMIT_BYTES = 128 * 1024;
const HEALTH_PROBE_ERROR_LIMIT_BYTES = 32 * 1024;
const HEALTH_PROBE_TERMINATION_GRACE_MS = 250;
const HEALTH_PROBE_TERMINATION_SETTLEMENT_MS = 2_000;
const HEALTH_PROBE_IDS = Object.freeze({
  node: 'node-http',
  windows: 'windows-powershell-5.1-httpwebrequest',
});
const WINDOWS_HEALTH_PROBE_SCRIPT = [
  '$ErrorActionPreference = "Stop"',
  '$request = $null',
  '$response = $null',
  '$stream = $null',
  '$memory = $null',
  'try {',
  '  $timeoutMs = [Convert]::ToInt32($env:SMARTPERFETTO_HEALTH_PROBE_TIMEOUT_MS)',
  '  $limitBytes = [Convert]::ToInt32($env:SMARTPERFETTO_HEALTH_PROBE_LIMIT_BYTES)',
  '  $request = [System.Net.HttpWebRequest]::Create($env:SMARTPERFETTO_HEALTH_PROBE_URL)',
  '  $request.Method = "GET"',
  '  $request.Accept = "application/json"',
  '  $request.Proxy = [System.Net.GlobalProxySelection]::GetEmptyWebProxy()',
  '  $request.AllowAutoRedirect = $false',
  '  $request.KeepAlive = $true',
  '  $request.Timeout = $timeoutMs',
  '  $request.ReadWriteTimeout = $timeoutMs',
  '  try {',
  '    $response = [System.Net.HttpWebResponse]$request.GetResponse()',
  '  } catch [System.Net.WebException] {',
  '    if ($null -eq $_.Exception.Response) { throw }',
  '    $response = [System.Net.HttpWebResponse]$_.Exception.Response',
  '  }',
  '  $stream = $response.GetResponseStream()',
  '  $memory = New-Object System.IO.MemoryStream',
  '  $buffer = New-Object byte[] 8192',
  '  while (($read = $stream.Read($buffer, 0, $buffer.Length)) -gt 0) {',
  '    if (($memory.Length + $read) -gt $limitBytes) {',
  '      throw "ERR_HEALTH_RESPONSE_TOO_LARGE: health response exceeded $limitBytes bytes"',
  '    }',
  '    $memory.Write($buffer, 0, $read)',
  '  }',
  '  $statusCode = [int]$response.StatusCode',
  '  $encodedBody = [Convert]::ToBase64String($memory.ToArray())',
  '  [Console]::Out.Write(([string]$statusCode + "`n" + $encodedBody))',
  '} finally {',
  '  if ($null -ne $stream) { $stream.Dispose() }',
  '  if ($null -ne $memory) { $memory.Dispose() }',
  '  if ($null -ne $response) { $response.Dispose() }',
  '  if ($null -ne $request) { $request.Abort() }',
  '}',
].join('; ');

function usage() {
  console.error([
    'Usage:',
    '  node scripts/smoke-portable-archive.cjs \\',
    '    --asset <final-archive> --target <target> --version <version> \\',
    '    --commit <release-commit> [--output-dir <evidence-directory>] \\',
    '    [--public-release] [--allow-dirty]',
    '',
    'This command must run on the operating system and architecture named by --target.',
    '--output-dir must name a fresh path that does not already exist.',
  ].join('\n'));
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') {
      options.help = true;
      continue;
    }
    if (arg === '--public-release') {
      options.publicRelease = true;
      continue;
    }
    if (arg === '--allow-dirty') {
      options.allowDirty = true;
      continue;
    }
    if (['--asset', '--target', '--version', '--commit', '--output-dir'].includes(arg)) {
      if (index + 1 >= argv.length || !argv[index + 1].trim()) {
        throw new Error(`${arg} requires a value`);
      }
      options[arg.slice(2)] = argv[++index];
      continue;
    }
    throw new Error(`Unknown option: ${arg}`);
  }
  return options;
}

function assertMatchingHost(target, platform = process.platform, arch = process.arch) {
  const expected = HOSTS[target];
  if (!expected) throw new Error(`Unsupported target: ${target}`);
  if (platform !== expected.platform || arch !== expected.arch) {
    throw new Error(
      `Target ${target} requires ${expected.platform}/${expected.arch}, got ${platform}/${arch}`,
    );
  }
}

function packagePaths(extractedRoot, packageName, target) {
  const packageRoot = path.join(extractedRoot, packageName);
  const resources = target === 'macos-arm64'
    ? path.join(packageRoot, 'SmartPerfetto.app', 'Contents', 'Resources')
    : packageRoot;
  const launcher = target === 'windows-x64'
    ? path.join(packageRoot, 'SmartPerfetto.exe')
    : target === 'macos-arm64'
      ? path.join(packageRoot, 'SmartPerfetto.app', 'Contents', 'MacOS', 'SmartPerfetto')
      : path.join(packageRoot, 'SmartPerfetto');
  const node = target === 'windows-x64'
    ? path.join(resources, 'runtime', 'node', 'node.exe')
    : path.join(resources, 'runtime', 'node', 'bin', 'node');
  const traceProcessor = path.join(
    resources,
    'bin',
    target === 'windows-x64' ? 'trace_processor_shell.exe' : 'trace_processor_shell',
  );
  const claude = path.join(
    resources,
    'backend',
    'node_modules',
    target === 'windows-x64'
      ? '@anthropic-ai/claude-agent-sdk-win32-x64/claude.exe'
      : target === 'macos-arm64'
        ? '@anthropic-ai/claude-agent-sdk-darwin-arm64/claude'
        : '@anthropic-ai/claude-agent-sdk-linux-x64/claude',
  );
  const opencode = path.join(
    resources,
    'backend',
    'node_modules',
    'opencode-ai',
    'bin',
    'opencode.exe',
  );
  return {
    packageRoot,
    resources,
    launcher,
    node,
    traceProcessor,
    claude,
    opencode,
    manifest: path.join(packageRoot, 'PACKAGE-MANIFEST.json'),
    notarizationReceipt: path.join(packageRoot, 'NOTARIZATION-RECEIPT.json'),
  };
}

function sanitizedSmokeEnv(source) {
  return Object.fromEntries(
    Object.entries(source).filter(([key]) => (
      SMOKE_ENV_ALLOWLIST.has(key.toUpperCase()) || key.toUpperCase().startsWith('LC_')
    )),
  );
}

function isolatedSmokeEnv(source, homeDir) {
  return {
    ...sanitizedSmokeEnv(source),
    HOME: homeDir,
    USERPROFILE: homeDir,
    XDG_CONFIG_HOME: path.join(homeDir, '.config'),
    XDG_DATA_HOME: path.join(homeDir, '.local', 'share'),
    XDG_CACHE_HOME: path.join(homeDir, '.cache'),
    APPDATA: path.join(homeDir, 'AppData', 'Roaming'),
    LOCALAPPDATA: path.join(homeDir, 'AppData', 'Local'),
  };
}

function runChecked(command, args, label, options = {}) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    ...options,
  });
  if (result.error || result.status !== 0) {
    const detail = [result.error?.message, result.stdout, result.stderr]
      .filter(Boolean)
      .join('\n')
      .trim();
    throw new Error(`${label} failed${detail ? `:\n${detail}` : ''}`);
  }
  return {
    stdout: String(result.stdout || '').trim(),
    stderr: String(result.stderr || '').trim(),
  };
}

function runArchiveBinary(command, args, label, env, runner = runChecked) {
  return runner(command, args, label, {
    env,
    killSignal: 'SIGKILL',
    timeout: 30_000,
  });
}

function versionAtLeast(actual, minimum) {
  const actualParts = String(actual).trim().split('.').map(Number);
  const minimumParts = String(minimum).trim().split('.').map(Number);
  if (
    actualParts.some(value => !Number.isInteger(value) || value < 0) ||
    minimumParts.some(value => !Number.isInteger(value) || value < 0)
  ) {
    return false;
  }
  for (let index = 0; index < Math.max(actualParts.length, minimumParts.length); index++) {
    const left = actualParts[index] || 0;
    const right = minimumParts[index] || 0;
    if (left !== right) return left > right;
  }
  return true;
}

async function reservePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', reject);
    server.listen({host: '127.0.0.1', port: 0}, () => {
      const address = server.address();
      const port = address.port;
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

function describeError(error) {
  const details = [];
  let current = error;
  for (let depth = 0; current && depth < 3; depth++) {
    const message = current.message || String(current);
    const code = current.code ? ` (${current.code})` : '';
    details.push(`${message}${code}`);
    current = current.cause;
  }
  const description = details.join(' caused by: ');
  return description.length > 2_048
    ? `${description.slice(0, 2_048)}…`
    : description;
}

function abortableDelay(timeoutMs, signal) {
  if (signal?.aborted) {
    return Promise.reject(signal.reason || new Error('health probe cancelled'));
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(finish, timeoutMs);
    const onAbort = () => finish(signal.reason || new Error('health probe cancelled'));
    function finish(error) {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      if (error) reject(error);
      else resolve();
    }
    signal?.addEventListener('abort', onAbort, {once: true});
  });
}

function parseLoopbackHealthUrl(url) {
  const parsed = new URL(url);
  if (
    parsed.protocol !== 'http:' ||
    parsed.hostname !== '127.0.0.1' ||
    !parsed.port ||
    parsed.username ||
    parsed.password ||
    parsed.hash
  ) {
    throw new Error(`health probe requires a plain IPv4 loopback URL: ${url}`);
  }
  const requestTarget = `${parsed.pathname}${parsed.search}`;
  if (/[\r\n]/.test(requestTarget)) {
    throw new Error(`health probe URL contains an invalid request target: ${url}`);
  }
  return {parsed, requestTarget};
}

function directHttpHealthProbe(url, timeoutMs, signal) {
  const {parsed, requestTarget} = parseLoopbackHealthUrl(url);
  if (signal?.aborted) {
    return Promise.reject(signal.reason || new Error('health probe cancelled'));
  }

  const agent = new http.Agent({
    keepAlive: true,
    maxSockets: 1,
  });
  return new Promise((resolve, reject) => {
    let phase = 'connecting';
    let settled = false;
    let receivedBytes = 0;
    let deadline;
    let response;
    let socket;
    const chunks = [];
    let request;
    const onAbort = () => {
      finish(reject, signal.reason || new Error('health probe cancelled'));
    };
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      signal?.removeEventListener('abort', onAbort);
      response?.destroy();
      request?.destroy();
      socket?.destroy();
      agent.destroy();
      callback(value);
    };
    request = http.request({
      agent,
      host: '127.0.0.1',
      family: 4,
      headers: {
        Accept: 'application/json',
      },
      insecureHTTPParser: false,
      maxHeaderSize: 16 * 1024,
      method: 'GET',
      path: requestTarget,
      port: Number(parsed.port),
      protocol: 'http:',
    }, (incoming) => {
      response = incoming;
      phase = 'receiving response';
      incoming.on('data', (chunk) => {
        receivedBytes += chunk.length;
        if (receivedBytes > HEALTH_RESPONSE_LIMIT_BYTES) {
          const error = new Error(
            `health response exceeded ${HEALTH_RESPONSE_LIMIT_BYTES} bytes`,
          );
          error.code = 'ERR_HEALTH_RESPONSE_TOO_LARGE';
          finish(reject, error);
          return;
        }
        chunks.push(chunk);
      });
      incoming.once('aborted', () => {
        const error = new Error('health response was aborted');
        error.code = 'ECONNRESET';
        finish(reject, error);
      });
      incoming.once('error', (error) => finish(reject, error));
      incoming.once('end', () => finish(resolve, {
        body: Buffer.concat(chunks).toString('utf8'),
        statusCode: incoming.statusCode,
      }));
    });
    request.once('socket', (requestSocket) => {
      socket = requestSocket;
      socket.setNoDelay(true);
    });
    request.once('error', (error) => finish(reject, error));
    deadline = setTimeout(() => {
      const error = new Error(
        `health request exceeded ${timeoutMs}ms during ${phase}; ` +
        `received ${receivedBytes} bytes`,
      );
      error.code = 'ETIMEDOUT';
      finish(reject, error);
    }, timeoutMs);
    signal?.addEventListener('abort', onAbort, {once: true});
    phase = 'awaiting response';
    request.end();
  });
}

function parseWindowsHealthProbeOutput(output) {
  const match = /^([1-5]\d{2})\r?\n([A-Za-z0-9+/]*={0,2})$/.exec(output);
  if (!match || match[2].length % 4 !== 0) {
    throw new Error('Windows health probe returned an invalid response envelope');
  }
  const body = Buffer.from(match[2], 'base64');
  if (
    body.length > HEALTH_RESPONSE_LIMIT_BYTES ||
    body.toString('base64') !== match[2]
  ) {
    throw new Error('Windows health probe returned an invalid response body');
  }
  return {
    body: body.toString('utf8'),
    statusCode: Number(match[1]),
  };
}

function windowsPowerShellHealthProbe(
  url,
  timeoutMs,
  signal,
  {
    sourceEnv = process.env,
    spawnProcess = spawn,
    spawnSyncProcess = spawnSync,
    terminationGraceMs = HEALTH_PROBE_TERMINATION_GRACE_MS,
    terminationSettlementMs = HEALTH_PROBE_TERMINATION_SETTLEMENT_MS,
  } = {},
) {
  parseLoopbackHealthUrl(url);
  if (signal?.aborted) {
    return Promise.reject(signal.reason || new Error('health probe cancelled'));
  }
  const powershell = windowsSystemBinary(
    path.join('WindowsPowerShell', 'v1.0', 'powershell.exe'),
    sourceEnv,
  );
  const taskkill = windowsSystemBinary('taskkill.exe', sourceEnv);
  const requestTimeoutMs = Math.max(1, Math.floor(timeoutMs * 0.8));
  const env = {
    ...sanitizedSmokeEnv(sourceEnv),
    SMARTPERFETTO_HEALTH_PROBE_LIMIT_BYTES: String(HEALTH_RESPONSE_LIMIT_BYTES),
    SMARTPERFETTO_HEALTH_PROBE_TIMEOUT_MS: String(requestTimeoutMs),
    SMARTPERFETTO_HEALTH_PROBE_URL: url,
  };

  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawnProcess(
        powershell,
        ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', WINDOWS_HEALTH_PROBE_SCRIPT],
        {
          env,
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true,
        },
      );
    } catch (error) {
      reject(error);
      return;
    }

    let settled = false;
    let terminationError;
    let gracefulTerminationDeadline;
    let forcedTerminationDeadline;
    let deadline;
    let taskkillAttempted = false;
    const terminationFailures = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    const stdout = [];
    const stderr = [];
    const onAbort = () => terminate(
      signal.reason || new Error('health probe cancelled'),
    );
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      clearTimeout(gracefulTerminationDeadline);
      clearTimeout(forcedTerminationDeadline);
      signal?.removeEventListener('abort', onAbort);
      callback(value);
    };
    const forceTerminate = () => {
      if (settled || taskkillAttempted) return;
      taskkillAttempted = true;
      let result;
      try {
        result = spawnSyncProcess(
          taskkill,
          ['/T', '/F', '/PID', String(child.pid)],
          {
            env: sanitizedSmokeEnv(sourceEnv),
            stdio: 'ignore',
            timeout: terminationSettlementMs,
            windowsHide: true,
          },
        );
      } catch (error) {
        terminationFailures.push(error);
      }
      if (result?.error) terminationFailures.push(result.error);
      if (result && result.status !== 0) {
        terminationFailures.push(new Error(
          `taskkill exited with status ${result.status}`,
        ));
      }
      forcedTerminationDeadline = setTimeout(() => {
        const confirmationError = new Error(
          `Windows health probe child ${child.pid} did not close within ` +
          `${terminationSettlementMs}ms after taskkill`,
        );
        confirmationError.code = 'ECHILDSTUCK';
        const error = new AggregateError(
          [terminationError, ...terminationFailures, confirmationError],
          'Windows health probe failed and child termination could not be confirmed',
        );
        error.code = 'ECHILDSTUCK';
        finish(reject, error);
      }, terminationSettlementMs);
    };
    const terminate = (error) => {
      if (settled || terminationError) return;
      terminationError = error;
      let accepted = false;
      try {
        accepted = child.kill();
      } catch (killError) {
        terminationFailures.push(killError);
      }
      if (!accepted) {
        forceTerminate();
        return;
      }
      gracefulTerminationDeadline = setTimeout(
        forceTerminate,
        terminationGraceMs,
      );
    };
    const capture = (chunks, chunk, currentBytes, limitBytes, label) => {
      const nextBytes = currentBytes + chunk.length;
      if (nextBytes > limitBytes) {
        terminate(new Error(`${label} exceeded ${limitBytes} bytes`));
        return currentBytes;
      }
      chunks.push(chunk);
      return nextBytes;
    };

    child.stdout.on('data', (chunk) => {
      stdoutBytes = capture(
        stdout,
        chunk,
        stdoutBytes,
        HEALTH_PROBE_OUTPUT_LIMIT_BYTES,
        'Windows health probe stdout',
      );
    });
    child.stderr.on('data', (chunk) => {
      stderrBytes = capture(
        stderr,
        chunk,
        stderrBytes,
        HEALTH_PROBE_ERROR_LIMIT_BYTES,
        'Windows health probe stderr',
      );
    });
    child.once('error', (error) => {
      if (!terminationError) {
        finish(reject, error);
        return;
      }
      terminationFailures.push(error);
      forceTerminate();
    });
    child.once('close', (code, exitSignal) => {
      if (terminationError) {
        finish(reject, terminationError);
        return;
      }
      const errorOutput = Buffer.concat(stderr).toString('utf8').trim();
      if (code !== 0 || exitSignal) {
        const detail = errorOutput ? `: ${errorOutput}` : '';
        finish(
          reject,
          new Error(
            `Windows health probe exited code=${code}, signal=${exitSignal}${detail}`,
          ),
        );
        return;
      }
      try {
        finish(
          resolve,
          parseWindowsHealthProbeOutput(Buffer.concat(stdout).toString('utf8')),
        );
      } catch (error) {
        finish(reject, error);
      }
    });
    deadline = setTimeout(() => {
      const error = new Error(`Windows health probe exceeded ${timeoutMs}ms`);
      error.code = 'ETIMEDOUT';
      terminate(error);
    }, timeoutMs);
    signal?.addEventListener('abort', onAbort, {once: true});
  });
}

function healthProbeIdForTarget(target) {
  if (!HOSTS[target]) throw new Error(`Unsupported target: ${target}`);
  return target === 'windows-x64'
    ? HEALTH_PROBE_IDS.windows
    : HEALTH_PROBE_IDS.node;
}

function healthProbeForTarget(target, dependencies) {
  const id = healthProbeIdForTarget(target);
  if (id === HEALTH_PROBE_IDS.windows) {
    return Object.freeze({
      attemptTimeoutMs: 5_000,
      id,
      run: (url, timeoutMs, signal) => windowsPowerShellHealthProbe(
        url,
        timeoutMs,
        signal,
        dependencies,
      ),
    });
  }
  return Object.freeze({
    attemptTimeoutMs: 2_000,
    id,
    run: directHttpHealthProbe,
  });
}

const DEFAULT_HEALTH_PROBE = healthProbeForTarget('linux-x64');

async function waitForHealth(
  url,
  expectation,
  timeoutMs,
  signal,
  healthProbe = DEFAULT_HEALTH_PROBE,
) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    if (signal?.aborted) {
      throw signal.reason || new Error(`health probe cancelled: ${url}`);
    }
    try {
      const remainingMs = Math.max(1, deadline - Date.now());
      const response = await healthProbe.run(
        url,
        Math.min(healthProbe.attemptTimeoutMs, remainingMs),
        signal,
      );
      const payload = JSON.parse(response.body);
      if (
        response.statusCode >= 200 &&
        response.statusCode < 300 &&
        payload.status === expectation.status &&
        (!expectation.version || payload.version === expectation.version)
      ) {
        return payload;
      }
      lastError = new Error(
        `HTTP ${response.statusCode}, status=${payload.status}, version=${payload.version}`,
      );
    } catch (error) {
      if (signal?.aborted) {
        throw signal.reason || error;
      }
      lastError = error;
    }
    const delayMs = Math.min(250, Math.max(0, deadline - Date.now()));
    if (delayMs > 0) await abortableDelay(delayMs, signal);
  }
  throw new Error(
    `${url} did not become healthy: ${lastError ? describeError(lastError) : 'timeout'}`,
  );
}

async function waitForReadiness({
  backendTimeoutMs = 120_000,
  backendUrl,
  frontendTimeoutMs = 60_000,
  frontendUrl,
  healthProbe = DEFAULT_HEALTH_PROBE,
  launcherExitPromise,
  version,
}) {
  const controller = new AbortController();
  const probes = [
    waitForHealth(
      backendUrl,
      {status: 'OK', version},
      backendTimeoutMs,
      controller.signal,
      healthProbe,
    ),
    waitForHealth(
      frontendUrl,
      {status: 'OK'},
      frontendTimeoutMs,
      controller.signal,
      healthProbe,
    ),
  ];
  try {
    return await Promise.race([
      Promise.all(probes),
      launcherExitPromise.then((exit) => {
        throw new Error(
          `launcher exited before readiness: code=${exit.code}, signal=${exit.signal}`,
        );
      }),
    ]);
  } finally {
    controller.abort(new Error('portable readiness probe group completed'));
    await Promise.allSettled(probes);
  }
}

function waitForExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({code: child.exitCode, signal: child.signalCode});
  }
  return new Promise((resolve, reject) => {
    let timer;
    const complete = (callback, value) => {
      clearTimeout(timer);
      child.off('error', onError);
      child.off('exit', onExit);
      callback(value);
    };
    const onError = (error) => complete(reject, error);
    const onExit = (code, signal) => complete(resolve, {code, signal});
    child.once('error', onError);
    child.once('exit', onExit);
    timer = setTimeout(() => {
      complete(reject, new Error(`launcher did not exit within ${timeoutMs}ms`));
    }, timeoutMs);
    timer.unref();
  });
}

async function canBindPort(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.unref();
    server.once('error', () => resolve(false));
    server.listen({host: '127.0.0.1', port}, () => {
      server.close(() => resolve(true));
    });
  });
}

function processIsGone(pid) {
  try {
    process.kill(pid, 0);
  } catch (error) {
    return error?.code === 'ESRCH';
  }
  if (process.platform !== 'win32') {
    const ps = fs.existsSync('/bin/ps') ? '/bin/ps' : '/usr/bin/ps';
    const result = spawnSync(ps, ['-p', String(pid), '-o', 'stat='], {
      encoding: 'utf8',
      env: {LANG: 'C', LC_ALL: 'C', PATH: '/usr/bin:/bin'},
      timeout: 10_000,
    });
    return result.status !== 0 || /^\s*Z/.test(String(result.stdout || ''));
  }
  return false;
}

function envValue(source, key) {
  const match = Object.entries(source).find(([name]) => name.toUpperCase() === key);
  return match?.[1];
}

function windowsSystemBinary(name, source = process.env) {
  const systemRoot = envValue(source, 'SYSTEMROOT') || envValue(source, 'WINDIR');
  if (!systemRoot || !path.win32.isAbsolute(systemRoot)) {
    throw new Error('SystemRoot is required to locate trusted Windows system tools');
  }
  return path.win32.join(systemRoot, 'System32', name);
}

function collectDescendantPids(rows, rootPid) {
  const childrenByParent = new Map();
  for (const row of rows) {
    const match = /^\s*(\d+)\s+(\d+)\s*$/.exec(row);
    if (!match) continue;
    const pid = Number(match[1]);
    const parentPid = Number(match[2]);
    if (pid <= 0 || parentPid <= 0 || pid === parentPid) continue;
    const children = childrenByParent.get(parentPid) || [];
    children.push(pid);
    childrenByParent.set(parentPid, children);
  }

  const descendants = [];
  const visited = new Set([rootPid]);
  const visit = (parentPid) => {
    for (const pid of childrenByParent.get(parentPid) || []) {
      if (visited.has(pid)) continue;
      visited.add(pid);
      visit(pid);
      descendants.push(pid);
    }
  };
  visit(rootPid);
  return descendants;
}

function unixDescendantPids(rootPid, runner = spawnSync) {
  const ps = fs.existsSync('/bin/ps') ? '/bin/ps' : '/usr/bin/ps';
  const result = runner(ps, ['-A', '-o', 'pid=,ppid='], {
    encoding: 'utf8',
    env: {LANG: 'C', LC_ALL: 'C', PATH: '/usr/bin:/bin'},
    killSignal: 'SIGKILL',
    maxBuffer: 16 * 1024 * 1024,
    timeout: 10_000,
  });
  if (result.error || result.status !== 0) {
    throw new Error(
      `process enumeration failed: ${
        result.error?.message || String(result.stderr || '').trim() || `exit ${result.status}`
      }`,
    );
  }
  return collectDescendantPids(String(result.stdout || '').split(/\r?\n/), rootPid);
}

function windowsDescendantPids(rootPid, sourceEnv = process.env, runner = spawnSync) {
  const powershell = windowsSystemBinary(
    path.join('WindowsPowerShell', 'v1.0', 'powershell.exe'),
    sourceEnv,
  );
  const script = [
    '$rows = Get-CimInstance Win32_Process | ForEach-Object {',
    '  "$($_.ProcessId) $($_.ParentProcessId)"',
    '}',
    '[Console]::Out.Write(($rows -join "`n"))',
  ].join('; ');
  const result = runner(
    powershell,
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script],
    {
      encoding: 'utf8',
      env: sanitizedSmokeEnv(sourceEnv),
      killSignal: 'SIGKILL',
      maxBuffer: 16 * 1024 * 1024,
      timeout: 10_000,
      windowsHide: true,
    },
  );
  if (result.error || result.status !== 0) {
    throw new Error(
      `Windows process enumeration failed: ${
        result.error?.message || String(result.stderr || '').trim() || `exit ${result.status}`
      }`,
    );
  }
  return collectDescendantPids(String(result.stdout || '').split(/\r?\n/), rootPid);
}

function descendantPids(rootPid, sourceEnv = process.env, runner = spawnSync) {
  return process.platform === 'win32'
    ? windowsDescendantPids(rootPid, sourceEnv, runner)
    : unixDescendantPids(rootPid, runner);
}

function startProcessTreeMonitor(
  rootPid,
  sourceEnv = process.env,
  runner = spawnSync,
  sampleIntervalMs = process.platform === 'win32' ? 1_000 : 50,
) {
  const observed = new Set();
  const failures = [];
  let successfulSamples = 0;
  let stopped = false;
  const sample = () => {
    try {
      for (const pid of descendantPids(rootPid, sourceEnv, runner)) observed.add(pid);
      successfulSamples++;
    } catch (error) {
      failures.push(error?.message || String(error));
    }
  };
  sample();
  const timer = setInterval(sample, sampleIntervalMs);
  timer.unref();
  return {
    observed,
    stop() {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
      sample();
    },
    evidence(survivingPids = []) {
      return {
        enumerationSucceeded: successfulSamples > 0 && failures.length === 0,
        failures: [...failures],
        observedPids: [...observed],
        samples: successfulSamples,
        survivingPids: [...survivingPids],
      };
    },
  };
}

function forceKillProcessTree(pid, sourceEnv = process.env, runner = spawnSync) {
  if (!Number.isInteger(pid) || pid <= 0 || processIsGone(pid)) return;
  if (process.platform === 'win32') {
    let taskkill;
    try {
      taskkill = windowsSystemBinary('taskkill.exe', sourceEnv);
    } catch {
      return;
    }
    runner(taskkill, ['/T', '/F', '/PID', String(pid)], {
      env: sanitizedSmokeEnv(sourceEnv),
      stdio: 'ignore',
      windowsHide: true,
    });
    return;
  }

  let descendants = [];
  try {
    descendants = descendantPids(pid, sourceEnv, runner);
  } catch {}
  for (const descendant of descendants) {
    try {
      process.kill(-descendant, 'SIGKILL');
    } catch {}
    try {
      process.kill(descendant, 'SIGKILL');
    } catch {}
  }
  try {
    process.kill(pid, 'SIGKILL');
  } catch {}
}

function validateLifecycleReceipt(receipt, expected) {
  const fail = (message) => {
    throw new Error(`invalid lifecycle receipt: ${message}`);
  };
  if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)) fail('expected an object');
  if (receipt.schemaVersion !== 2) fail('schemaVersion must be 2');
  if (receipt.version !== expected.version) fail('version does not match the archive');
  if (receipt.gitCommit !== expected.commit) fail('gitCommit does not match the archive');
  if (receipt.packageTarget !== expected.target) fail('packageTarget does not match the archive');
  const expectedContainment = expected.target === 'windows-x64'
    ? 'windows-job-object'
    : 'service-process-groups';
  if (receipt.containment !== expectedContainment) {
    fail(`containment must be ${expectedContainment}`);
  }
  if (receipt.exitReason !== 'shutdown-file') fail('exitReason must be shutdown-file');
  if (receipt.success !== true) fail('success must be true');
  if (
    receipt.ports?.backend !== expected.backendPort ||
    receipt.ports?.frontend !== expected.frontendPort ||
    receipt.ports?.released !== true
  ) {
    fail('ports must match the launched services and be released');
  }
  if (!Array.isArray(receipt.services) || receipt.services.length !== 2) {
    fail('services must contain exactly backend and frontend');
  }

  const expectedNames = new Set(['backend', 'frontend']);
  const pids = new Set();
  for (const service of receipt.services) {
    if (!service || typeof service !== 'object' || !expectedNames.delete(service.name)) {
      fail('service names must be unique backend and frontend entries');
    }
    if (!Number.isInteger(service.pid) || service.pid <= 0 || pids.has(service.pid)) {
      fail('service PIDs must be positive and unique');
    }
    pids.add(service.pid);
    if (
      service.gracefulRequested !== true ||
      service.escalated !== false ||
      service.shutdownError ||
      service.result?.success !== true ||
      service.result?.exitCode !== 0 ||
      service.result?.error
    ) {
      fail(`${service.name} does not prove a graceful, non-escalated exit`);
    }
  }
  if (expectedNames.size !== 0) fail('services are incomplete');
  if (
    typeof receipt.finishedAt !== 'string' ||
    !Number.isFinite(Date.parse(receipt.finishedAt))
  ) {
    fail('finishedAt must be a valid timestamp');
  }
  return receipt;
}

function writeJson(file, value) {
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, {
    flag: 'wx',
    mode: 0o600,
  });
  try {
    fs.renameSync(temporary, file);
  } catch (error) {
    fs.rmSync(temporary, {force: true});
    throw error;
  }
}

function createEvidenceDirectory(requestedDirectory, target) {
  if (!requestedDirectory) {
    return fs.mkdtempSync(path.join(os.tmpdir(), `smartperfetto-${target}-smoke-`));
  }
  const evidenceDirectory = path.resolve(requestedDirectory);
  fs.mkdirSync(path.dirname(evidenceDirectory), {recursive: true, mode: 0o700});
  try {
    fs.mkdirSync(evidenceDirectory, {mode: 0o700});
  } catch (error) {
    if (error?.code === 'EEXIST') {
      throw new Error(
        `Smoke evidence directory already exists; choose a fresh path: ${evidenceDirectory}`,
      );
    }
    throw error;
  }
  return evidenceDirectory;
}

async function identifyAsset(asset) {
  const hash = crypto.createHash('sha256');
  await new Promise((resolve, reject) => {
    const stream = fs.createReadStream(asset);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.once('error', reject);
    stream.once('end', resolve);
  });
  const stat = fs.statSync(asset);
  return {
    name: path.basename(asset),
    sha256: hash.digest('hex'),
    size: stat.size,
  };
}

async function smoke(options) {
  const target = options.target;
  const targetContract = TARGETS[target];
  if (!targetContract) throw new Error(`Unsupported target: ${target}`);
  assertMatchingHost(target);
  if (options.publicRelease && options.allowDirty) {
    throw new Error('--allow-dirty cannot be combined with --public-release');
  }

  const version = normalizeVersion(options.version);
  const commit = String(options.commit || '').trim();
  if (!commit) throw new Error('--commit is required');
  const asset = path.resolve(options.asset);
  const assetIdentity = await identifyAsset(asset);
  const packageName = `smartperfetto-v${version}-${targetContract.os}-${targetContract.arch}`;
  const evidenceDir = createEvidenceDirectory(options['output-dir'], target);
  const dataDir = path.join(evidenceDir, 'data');
  const logsDir = path.join(evidenceDir, 'logs');
  const homeDir = path.join(evidenceDir, 'home');
  const shutdownFile = path.join(evidenceDir, 'shutdown.request');
  const lifecycleReceipt = path.join(evidenceDir, 'lifecycle-receipt.json');
  const stdoutPath = path.join(evidenceDir, 'launcher.stdout.log');
  const stderrPath = path.join(evidenceDir, 'launcher.stderr.log');
  const summaryPath = path.join(evidenceDir, 'smoke-summary.json');
  const failureSummaryPath = path.join(evidenceDir, 'smoke-failure.json');
  const runtimeEnv = isolatedSmokeEnv(process.env, homeDir);
  const healthProbe = healthProbeForTarget(target);
  fs.mkdirSync(homeDir, {recursive: true});
  let extractedRoot;
  let sourceGitDirty = null;
  let child;
  let launcherExitPromise;
  let processTreeMonitor;
  let successful = false;
  let failureMessage = '';

  try {
    const staticVerificationArgs = [
      path.join(__dirname, 'verify-portable-package.cjs'),
      '--asset', asset,
      '--target', target,
      '--version', version,
      '--commit', commit,
    ];
    if (!options.allowDirty) staticVerificationArgs.push('--require-clean');
    if (options.publicRelease) staticVerificationArgs.push('--public-release');
    runChecked(
      process.execPath,
      staticVerificationArgs,
      'static final-archive verification',
      {
        killSignal: 'SIGKILL',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 180_000,
      },
    );

    const entries = listEntries(asset, targetContract.ext);
    extractedRoot = extractArchiveToTemp(asset, targetContract.ext, entries);
    const paths = packagePaths(extractedRoot, packageName, target);
    const manifest = JSON.parse(fs.readFileSync(paths.manifest, 'utf8'));
    sourceGitDirty = manifest.gitDirty;
    if (
      manifest.version !== version ||
      manifest.gitCommit !== commit ||
      typeof manifest.gitDirty !== 'boolean' ||
      (!options.allowDirty && manifest.gitDirty !== false) ||
      manifest.target?.id !== target
    ) {
      throw new Error('extracted manifest does not match the requested source and target');
    }

    const emptyTrace = path.join(evidenceDir, 'empty-trace.pftrace');
    fs.writeFileSync(emptyTrace, '');
    const runtimeEvidence = {
      node: runArchiveBinary(
        paths.node,
        ['--version'],
        'bundled Node.js',
        runtimeEnv,
      ),
      claude: fs.existsSync(paths.claude)
        ? runArchiveBinary(
            paths.claude,
            ['--version'],
            'bundled Claude',
            runtimeEnv,
          )
        : null,
      opencode: fs.existsSync(paths.opencode)
        ? runArchiveBinary(
            paths.opencode,
            ['--version'],
            'bundled OpenCode',
            runtimeEnv,
          )
        : null,
      traceProcessor: runArchiveBinary(
        paths.traceProcessor,
        [emptyTrace, '-Q', 'select 1 as smartperfetto_smoke;'],
        'bundled trace_processor_shell',
        runtimeEnv,
      ),
    };
    if (target === 'linux-x64') {
      runtimeEvidence.libc = runArchiveBinary(
        paths.node,
        ['-p', 'process.report.getReport().header.glibcVersionRuntime || ""'],
        'Linux glibc runtime',
        runtimeEnv,
      );
      if (!versionAtLeast(runtimeEvidence.libc.stdout, '2.34')) {
        throw new Error(
          `Linux portable archive requires glibc 2.34 or newer, got ${
            runtimeEvidence.libc.stdout || '<non-glibc>'
          }`,
        );
      }
    }
    if (target === 'macos-arm64' && options.publicRelease) {
      const app = path.join(paths.packageRoot, 'SmartPerfetto.app');
      runtimeEvidence.macosRelease = {
        codesign: runArchiveBinary(
          '/usr/bin/codesign',
          ['--verify', '--deep', '--strict', '--verbose=2', app],
          'macOS Developer ID signature',
          runtimeEnv,
        ),
        gatekeeper: runArchiveBinary(
          '/usr/sbin/spctl',
          ['--assess', '--type', 'execute', '--verbose=4', app],
          'macOS Gatekeeper assessment',
          runtimeEnv,
        ),
        staple: runArchiveBinary(
          '/usr/bin/xcrun',
          ['stapler', 'validate', app],
          'macOS notarization staple',
          runtimeEnv,
        ),
        notarytool: JSON.parse(fs.readFileSync(paths.notarizationReceipt, 'utf8')),
      };
      const gatekeeperOutput = [
        runtimeEvidence.macosRelease.gatekeeper.stdout,
        runtimeEvidence.macosRelease.gatekeeper.stderr,
      ].join('\n');
      if (!/source=Notarized Developer ID/i.test(gatekeeperOutput)) {
        throw new Error(
          'macOS Gatekeeper did not identify the app as Notarized Developer ID',
        );
      }
    }
    const expectedNodeVersion = `v${readNodeRuntimePin(options.target).version}`;
    if (runtimeEvidence.node.stdout.trim() !== expectedNodeVersion) {
      throw new Error(
        `bundled Node.js must be ${expectedNodeVersion}, got ${runtimeEvidence.node.stdout}`,
      );
    }
    if (
      !runtimeEvidence.traceProcessor.stdout.includes('smartperfetto_smoke') ||
      !/(^|\r?\n)1(\r?\n|$)/.test(runtimeEvidence.traceProcessor.stdout)
    ) {
      throw new Error('bundled trace_processor_shell did not return smartperfetto_smoke=1');
    }

    const backendPort = await reservePort();
    let frontendPort = await reservePort();
    while (frontendPort === backendPort) frontendPort = await reservePort();
    fs.mkdirSync(dataDir, {recursive: true});
    fs.mkdirSync(logsDir, {recursive: true});
    const stdout = fs.openSync(stdoutPath, 'w', 0o600);
    const stderr = fs.openSync(stderrPath, 'w', 0o600);
    child = spawn(paths.launcher, [
      '--non-interactive',
      '--shutdown-file', shutdownFile,
      '--lifecycle-receipt', lifecycleReceipt,
    ], {
      cwd: paths.packageRoot,
      env: {
        ...runtimeEnv,
        SMARTPERFETTO_BACKEND_PORT: String(backendPort),
        SMARTPERFETTO_FRONTEND_PORT: String(frontendPort),
        SMARTPERFETTO_PORTABLE_DATA_DIR: dataDir,
        SMARTPERFETTO_PORTABLE_LOG_DIR: logsDir,
        SMARTPERFETTO_NO_OPEN: '1',
      },
      stdio: ['ignore', stdout, stderr],
      windowsHide: true,
    });
    fs.closeSync(stdout);
    fs.closeSync(stderr);
    processTreeMonitor = startProcessTreeMonitor(child.pid);

    launcherExitPromise = waitForExit(child, 180_000);
    const [backendHealth, frontendHealth] = await waitForReadiness({
      backendUrl: `http://127.0.0.1:${backendPort}/health`,
      frontendUrl: `http://127.0.0.1:${frontendPort}/health`,
      healthProbe,
      launcherExitPromise,
      version,
    });
    fs.writeFileSync(shutdownFile, 'shutdown\n', {flag: 'wx', mode: 0o600});
    const launcherExit = await launcherExitPromise;
    if (launcherExit.code !== 0 || launcherExit.signal) {
      throw new Error(
        `launcher exit was not successful: code=${launcherExit.code}, signal=${launcherExit.signal}`,
      );
    }
    processTreeMonitor.stop();

    const receipt = validateLifecycleReceipt(
      JSON.parse(fs.readFileSync(lifecycleReceipt, 'utf8')),
      {version, commit, target, backendPort, frontendPort},
    );
    if (!await canBindPort(backendPort) || !await canBindPort(frontendPort)) {
      throw new Error('backend or frontend port remained bound after launcher exit');
    }
    const liveChildren = receipt.services
      .map(service => service.pid)
      .filter(pid => Number.isInteger(pid) && pid > 0 && !processIsGone(pid));
    if (liveChildren.length > 0) {
      throw new Error(`child processes survived launcher exit: ${liveChildren.join(', ')}`);
    }
    const liveObservedChildren = [...processTreeMonitor.observed]
      .filter(pid => Number.isInteger(pid) && pid > 0 && !processIsGone(pid));
    if (liveObservedChildren.length > 0) {
      throw new Error(
        `observed descendant processes survived launcher exit: ${liveObservedChildren.join(', ')}`,
      );
    }
    const processTreeEvidence = processTreeMonitor.evidence(liveObservedChildren);
    if (options.publicRelease && !processTreeEvidence.enumerationSucceeded) {
      throw new Error(
        `public-release smoke could not prove descendant cleanup: ${
          processTreeEvidence.failures.join('; ') || 'no successful process enumeration'
        }`,
      );
    }

    writeJson(summaryPath, {
      schemaVersion: 2,
      success: true,
      asset: assetIdentity,
      target,
      version,
      commit,
      gitDirty: manifest.gitDirty,
      publicRelease: options.publicRelease === true,
      host: {platform: process.platform, arch: process.arch},
      healthProbe: healthProbe.id,
      ports: {backend: backendPort, frontend: frontendPort},
      health: {backend: backendHealth, frontend: frontendHealth},
      runtimes: runtimeEvidence,
      lifecycleReceipt: receipt,
      processTree: processTreeEvidence,
      finishedAt: new Date().toISOString(),
    });
    successful = true;
    console.log(`Portable archive runtime smoke passed: ${path.basename(asset)}`);
    console.log(`Evidence: ${evidenceDir}`);
  } catch (error) {
    failureMessage = error?.stack || String(error);
    throw error;
  } finally {
    processTreeMonitor?.stop();
    if (!successful) {
      if (child && child.exitCode === null && child.signalCode === null) {
        try {
          if (!fs.existsSync(shutdownFile)) {
            fs.writeFileSync(shutdownFile, 'shutdown\n', {flag: 'wx', mode: 0o600});
          }
        } catch {}
        await Promise.race([
          launcherExitPromise?.catch(() => undefined) ?? Promise.resolve(),
          new Promise((resolve) => setTimeout(resolve, 25_000)),
        ]);
        if (child.exitCode === null && child.signalCode === null) {
          forceKillProcessTree(child.pid);
        }
      }
      // Never signal a historical bare PID: it may have been reused after the
      // sample was recorded. The launcher owns descendant containment, while
      // failure cleanup targets only the still-live launcher tree above.
      writeJson(failureSummaryPath, {
        schemaVersion: 2,
        success: false,
        asset: assetIdentity,
        target,
        version,
        commit,
        gitDirty: sourceGitDirty,
        publicRelease: options.publicRelease === true,
        host: {platform: process.platform, arch: process.arch},
        healthProbe: healthProbe.id,
        error: failureMessage,
        lifecycleReceipt: fs.existsSync(lifecycleReceipt) ? lifecycleReceipt : null,
        finishedAt: new Date().toISOString(),
      });
      console.error(`Smoke evidence preserved: ${evidenceDir}`);
    }
    if (extractedRoot) {
      fs.rmSync(extractedRoot, {recursive: true, force: true});
    }
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    usage();
    return;
  }
  if (!options.asset || !options.target || !options.version || !options.commit) {
    usage();
    process.exitCode = 2;
    return;
  }
  await smoke(options);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error?.stack || error);
    process.exitCode = 1;
  });
}

module.exports = {
  assertMatchingHost,
  collectDescendantPids,
  createEvidenceDirectory,
  directHttpHealthProbe,
  forceKillProcessTree,
  healthProbeForTarget,
  healthProbeIdForTarget,
  packagePaths,
  parseArgs,
  isolatedSmokeEnv,
  runArchiveBinary,
  sanitizedSmokeEnv,
  startProcessTreeMonitor,
  validateLifecycleReceipt,
  versionAtLeast,
  waitForHealth,
  waitForReadiness,
  windowsPowerShellHealthProbe,
  windowsSystemBinary,
};
