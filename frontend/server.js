// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

/**
 * SmartPerfetto Frontend Server
 *
 * Serves pre-built Perfetto UI static files on port 10000.
 * No build step required — just run: node server.js
 *
 * Environment variables:
 *   SMARTPERFETTO_FRONTEND_PORT  Listening port (default: 10000)
 *   SMARTPERFETTO_FRONTEND_BIND_HOST  Listening host (default: 127.0.0.1)
 *   PORT                         Legacy listening port fallback
 */

'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = Number(safePort(process.env.SMARTPERFETTO_FRONTEND_PORT || process.env.PORT, '10000'));
const BIND_HOST = resolveBindHost(process.env.SMARTPERFETTO_FRONTEND_BIND_HOST);
const DIST_DIR = __dirname;
const REQUIRED_RUNTIME_ASSETS = [
  'frontend_bundle.js',
  'engine_bundle.js',
  'frontend.css',
  'trace_processor.wasm',
  'trace_processor_memory64.wasm',
];
const DEFAULT_SHUTDOWN_POLL_INTERVAL_MS = 100;
const DEFAULT_SHUTDOWN_DEADLINE_MS = 5_000;
const liveReloadResponsesByServer = new WeakMap();
const socketsByServer = new WeakMap();
const RUNTIME_ENV_FILE_KEYS = [
  'SMARTPERFETTO_BACKEND_PUBLIC_URL',
  'SMARTPERFETTO_BACKEND_URL',
  'SMARTPERFETTO_OIDC_ISSUER_URL',
  'SMARTPERFETTO_OIDC_CLIENT_ID',
  'SMARTPERFETTO_OIDC_REDIRECT_URI',
];

const MIME_TYPES = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.js.map': 'application/json',
  '.css': 'text/css',
  '.css.map': 'application/json',
  '.wasm': 'application/wasm',
  '.json': 'application/json',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
};

function getMime(filePath) {
  // Check double extensions first (.js.map)
  if (filePath.endsWith('.js.map') || filePath.endsWith('.css.map')) return 'application/json';
  const ext = path.extname(filePath).toLowerCase();
  return MIME_TYPES[ext] || 'application/octet-stream';
}

function safePort(value, fallback) {
  const text = String(value || '').trim();
  if (!/^\d+$/.test(text)) return fallback;
  const parsed = Number(text);
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= 65535
    ? String(parsed)
    : fallback;
}

function parseRuntimeEnvFile(content) {
  const parsed = {};
  for (const sourceLine of content.split(/\r?\n/)) {
    const line = sourceLine.trim();
    if (!line || line.startsWith('#')) continue;
    const separator = line.indexOf('=');
    if (separator <= 0) continue;
    const key = line.slice(0, separator).trim().replace(/^export\s+/, '');
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    let value = line.slice(separator + 1).trim();
    const quote = value[0];
    if ((quote === '"' || quote === "'") && value.endsWith(quote)) {
      value = value.slice(1, -1);
    } else {
      value = value.replace(/\s+#.*$/, '').trim();
    }
    parsed[key] = value;
  }
  return parsed;
}

function resolveBindHost(value) {
  const host = String(value || '').trim() || '127.0.0.1';
  if (!/^[A-Za-z0-9.:[\]_-]+$/.test(host)) {
    throw new Error(`Invalid SMARTPERFETTO_FRONTEND_BIND_HOST: ${value}`);
  }
  return host;
}

function listenFrontend(serverInstance, {host = BIND_HOST, port = PORT} = {}, callback) {
  return serverInstance.listen({host, port}, callback);
}

function isPathInside(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === '' || (
    relative !== '..' &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

function resolveStaticRequest(rawUrl, distDir = DIST_DIR) {
  const rawPathname = String(rawUrl || '').split(/[?#]/, 1)[0];
  if (!rawPathname.startsWith('/')) {
    throw new Error('Request path must be absolute');
  }

  let urlPath;
  try {
    urlPath = decodeURIComponent(rawPathname);
  } catch {
    throw new Error('Request path contains invalid percent encoding');
  }
  if (urlPath.includes('\0') || urlPath.includes('\\')) {
    throw new Error('Request path contains an unsafe character');
  }
  if (urlPath.split('/').some((segment) => segment === '.' || segment === '..')) {
    throw new Error('Request path contains traversal');
  }

  const root = path.resolve(distDir);
  const filePath = path.resolve(root, `.${urlPath}`);
  if (!isPathInside(root, filePath)) {
    throw new Error('Request path escapes the frontend root');
  }
  return {filePath, urlPath};
}

function runtimeEnvFileValues(distDir) {
  const values = {};
  const explicitEnvFile = process.env.SMARTPERFETTO_ENV_FILE;
  const candidates = explicitEnvFile
    ? [explicitEnvFile]
    : [
      path.resolve(distDir, '../backend/.env'),
      path.resolve(distDir, '../.env'),
    ];
  for (const candidate of candidates) {
    let parsed;
    try {
      parsed = parseRuntimeEnvFile(fs.readFileSync(candidate, 'utf8'));
    } catch {
      continue;
    }
    for (const key of RUNTIME_ENV_FILE_KEYS) {
      if (values[key] === undefined && parsed[key] !== undefined) {
        values[key] = parsed[key];
      }
    }
  }
  return values;
}

function runtimeConfig(distDir = DIST_DIR) {
  const fileEnv = runtimeEnvFileValues(distDir);
  const oidcEnvValue = (key) => process.env[key] ?? fileEnv[key] ?? '';
  const externalIssueUrl = (
    process.env.SMARTPERFETTO_EXTERNAL_ISSUE_URL || ''
  ).trim();
  const oidcEnabled = [
    oidcEnvValue('SMARTPERFETTO_OIDC_ISSUER_URL'),
    oidcEnvValue('SMARTPERFETTO_OIDC_CLIENT_ID'),
    oidcEnvValue('SMARTPERFETTO_OIDC_REDIRECT_URI'),
  ].some((value) => value.trim().length > 0);
  let backendUrl = (
    process.env.SMARTPERFETTO_BACKEND_PUBLIC_URL ||
    process.env.SMARTPERFETTO_BACKEND_URL ||
    (oidcEnabled
      ? fileEnv.SMARTPERFETTO_BACKEND_PUBLIC_URL ||
        fileEnv.SMARTPERFETTO_BACKEND_URL
      : '') ||
    ''
  ).trim();
  if (!backendUrl && oidcEnabled) {
    try {
      backendUrl = new URL(
        oidcEnvValue('SMARTPERFETTO_OIDC_REDIRECT_URI'),
      ).origin;
    } catch {
      backendUrl = '';
    }
  }
  return {
    backendPort: safePort(
      process.env.SMARTPERFETTO_BACKEND_PUBLIC_PORT ||
      process.env.SMARTPERFETTO_BACKEND_PORT,
      '3000',
    ),
    frontendPort: safePort(
      process.env.SMARTPERFETTO_FRONTEND_PORT ||
      process.env.PORT,
      '10000',
    ),
    ...(oidcEnabled ? {authProbeRequired: true, oidcEnabled: true} : {}),
    ...(backendUrl ? {backendUrl} : {}),
    ...(externalIssueUrl ? {externalIssueUrl} : {}),
  };
}

function runtimeConfigScript(distDir = DIST_DIR) {
  const config = runtimeConfig(distDir);
  const serialized = JSON.stringify(config)
    .replace(/</g, '\\u003c')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
  return `<script>window.__SMARTPERFETTO_CONFIG__=${serialized};</script>`;
}

function injectRuntimeConfig(filePath, data, distDir = DIST_DIR) {
  if (path.basename(filePath) !== 'index.html') return data;
  const html = data.toString('utf8');
  const script = runtimeConfigScript(distDir);
  const marker = '</head>';
  if (html.includes(marker)) {
    return Buffer.from(html.replace(marker, `${script}\n${marker}`));
  }
  return Buffer.from(`${script}\n${html}`);
}

function frontendHealth(distDir = DIST_DIR) {
  try {
    const indexPath = path.join(distDir, 'index.html');
    const indexHtml = fs.readFileSync(indexPath, 'utf8');
    const versionAttribute = /data-perfetto_version='([^']+)'/.exec(indexHtml)?.[1];
    if (!versionAttribute) throw new Error('index.html does not declare a Perfetto version');

    const version = JSON.parse(versionAttribute).stable;
    if (typeof version !== 'string' || !/^v[0-9A-Za-z._-]+$/.test(version)) {
      throw new Error('index.html has an invalid stable Perfetto version');
    }

    const versionDir = path.join(distDir, version);
    const manifestPath = path.join(versionDir, 'manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    if (!manifest.resources || typeof manifest.resources !== 'object') {
      throw new Error('manifest.json has no resources map');
    }

    for (const asset of REQUIRED_RUNTIME_ASSETS) {
      if (!Object.hasOwn(manifest.resources, asset)) {
        throw new Error(`manifest.json does not declare ${asset}`);
      }
      const stat = fs.statSync(path.join(versionDir, asset));
      if (!stat.isFile() || stat.size === 0) {
        throw new Error(`${asset} is missing or empty`);
      }
    }

    return {status: 'OK', version};
  } catch (error) {
    return {status: 'ERROR', error: error.message};
  }
}

function watchShutdownFile(
  shutdownFile,
  onShutdown,
  pollIntervalMs = DEFAULT_SHUTDOWN_POLL_INTERVAL_MS,
) {
  const target = String(shutdownFile || '').trim();
  if (!target) return () => {};

  let stopped = false;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
  };
  const timer = setInterval(() => {
    try {
      const stat = fs.lstatSync(target);
      if (!stat.isFile() || stat.isSymbolicLink()) return;
      stop();
      onShutdown('launcher-control-file');
    } catch (error) {
      if (error && error.code !== 'ENOENT') {
        console.warn(`[Frontend] Cannot inspect shutdown file ${target}: ${error.message || error}`);
      }
    }
  }, pollIntervalMs);
  timer.unref();
  return stop;
}

function openedFileMatchesPath(openedStat, pathStat) {
  return (
    openedStat.isFile() &&
    pathStat.isFile() &&
    openedStat.dev === pathStat.dev &&
    openedStat.ino === pathStat.ino
  );
}

function readStaticFile(root, filePath, callback) {
  const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0);
  fs.open(filePath, flags, (openError, descriptor) => {
    if (openError) {
      callback(openError);
      return;
    }

    const finish = (error, result) => {
      fs.close(descriptor, (closeError) => callback(error || closeError, result));
    };
    fs.fstat(descriptor, (fstatError, openedStat) => {
      if (fstatError || !openedStat.isFile()) {
        finish(fstatError || new Error('Static path is not a regular file'));
        return;
      }
      fs.realpath(filePath, (realpathError, realPath) => {
        if (realpathError || !isPathInside(root, realPath)) {
          finish(realpathError || new Error('Static path escapes the frontend root'));
          return;
        }
        fs.stat(realPath, (statError, pathStat) => {
          if (statError || !openedFileMatchesPath(openedStat, pathStat)) {
            finish(statError || new Error('Static path changed while it was opened'));
            return;
          }
          fs.readFile(descriptor, (readError, data) => {
            finish(readError, readError ? undefined : {data, realPath});
          });
        });
      });
    });
  });
}

function createFrontendServer(distDir = DIST_DIR) {
  const root = fs.realpathSync(distDir);
  const liveReloadResponses = new Set();
  const sockets = new Set();
  const serverInstance = http.createServer((req, res) => {
    // CORS headers for cross-origin requests from Perfetto UI
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');

    let requestPath;
    try {
      requestPath = resolveStaticRequest(req.url, root);
    } catch {
      res.writeHead(400, {'Content-Type': 'text/plain'});
      res.end('Invalid request path');
      return;
    }
    const {urlPath} = requestPath;

    if (urlPath === '/health') {
      const health = frontendHealth(root);
      const body = JSON.stringify(health);
      res.writeHead(health.status === 'OK' ? 200 : 503, {'Content-Type': 'application/json'});
      res.end(body);
      return;
    }

    // Live reload endpoint (no-op stub so browser doesn't error)
    if (urlPath === '/live_reload') {
      res.writeHead(200, {'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache'});
      res.write('data: connected\n\n');
      liveReloadResponses.add(res);
      res.once('close', () => liveReloadResponses.delete(res));
      return;
    }

    let filePath = requestPath.filePath;
    if (urlPath === '/') {
      filePath = path.join(root, 'index.html');
    }

    const serve = (candidate, allowSpaFallback) => {
      readStaticFile(root, candidate, (readError, result) => {
        if (readError && allowSpaFallback) {
          serve(path.join(root, 'index.html'), false);
          return;
        }
        if (readError) {
          res.writeHead(404, {'Content-Type': 'text/plain'});
          res.end('Not found');
          return;
        }
        const body = injectRuntimeConfig(result.realPath, result.data, root);
        const isIndex = path.basename(result.realPath) === 'index.html';
        const oidcIndex = isIndex && runtimeConfig(root).oidcEnabled;
        res.writeHead(200, {
          'Content-Type': getMime(result.realPath),
          ...(oidcIndex ? {'Cache-Control': 'no-store'} : {}),
        });
        res.end(body);
      });
    };
    serve(filePath, urlPath !== '/' && !path.extname(urlPath));
  });
  serverInstance.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  liveReloadResponsesByServer.set(serverInstance, liveReloadResponses);
  socketsByServer.set(serverInstance, sockets);
  return serverInstance;
}

function closeFrontendServer(
  serverInstance,
  callback,
  shutdownDeadlineMs = DEFAULT_SHUTDOWN_DEADLINE_MS,
) {
  for (const response of liveReloadResponsesByServer.get(serverInstance) || []) {
    response.end();
  }
  let completed = false;
  const deadline = setTimeout(() => {
    for (const socket of socketsByServer.get(serverInstance) || []) {
      socket.destroy();
    }
  }, shutdownDeadlineMs);
  deadline.unref();
  const finish = (error) => {
    if (completed) return;
    completed = true;
    clearTimeout(deadline);
    callback?.(error);
  };
  const result = serverInstance.close(finish);
  serverInstance.closeIdleConnections?.();
  return result;
}

const server = createFrontendServer();

server.on('error', (err) => {
  if (err && err.code === 'EADDRINUSE') {
    console.error(`[Frontend] Port ${PORT} is already in use.`);
    console.error(
      '[Frontend] Close the existing SmartPerfetto/frontend process, or set SMARTPERFETTO_FRONTEND_PORT to a free port before starting.',
    );
    process.exit(1);
  }
  if (err && err.code === 'EACCES') {
    console.error(`[Frontend] Permission denied while listening on port ${PORT}.`);
    console.error(
      '[Frontend] Set SMARTPERFETTO_FRONTEND_PORT to an allowed port and restart SmartPerfetto.',
    );
    process.exit(1);
  }
  throw err;
});

if (require.main === module) {
  let shutdownStarted = false;
  const shutdown = (reason) => {
    if (shutdownStarted) return;
    shutdownStarted = true;
    console.log(`[Frontend] Received ${reason}, shutting down gracefully...`);
    closeFrontendServer(server, (error) => {
      if (error) {
        console.error(`[Frontend] Graceful shutdown failed: ${error.message || error}`);
        process.exitCode = 1;
      }
    });
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  watchShutdownFile(process.env.SMARTPERFETTO_SHUTDOWN_FILE, shutdown);
  listenFrontend(server, undefined, () => {
    console.log(`[Frontend] Serving Perfetto UI on http://${BIND_HOST}:${PORT}`);
  });
}

module.exports = {
  REQUIRED_RUNTIME_ASSETS,
  closeFrontendServer,
  createFrontendServer,
  frontendHealth,
  isPathInside,
  listenFrontend,
  readStaticFile,
  resolveBindHost,
  resolveStaticRequest,
  server,
  watchShutdownFile,
};
