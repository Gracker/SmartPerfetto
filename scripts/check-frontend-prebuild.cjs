#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const frontendDir = path.join(root, 'frontend');

function fail(message) {
  console.error(`ERROR: ${message}`);
  process.exitCode = 1;
}

function readText(filePath) {
  return fs.readFileSync(filePath, 'utf8');
}

function exists(filePath) {
  try {
    fs.accessSync(filePath, fs.constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function sha256Resource(filePath) {
  return `sha256-${crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('base64')}`;
}

function fileSize(filePath) {
  return fs.statSync(filePath).size;
}

function stableVersionFromIndex(indexHtml) {
  const match = indexHtml.match(/data-perfetto_version='([^']+)'/);
  if (!match) return null;
  try {
    return JSON.parse(match[1]).stable;
  } catch {
    return null;
  }
}

const indexPath = path.join(frontendDir, 'index.html');
if (!exists(indexPath)) {
  fail('frontend/index.html is missing');
} else if (!exists(path.join(frontendDir, 'server.js'))) {
  fail('frontend/server.js is missing');
} else {
  const version = stableVersionFromIndex(readText(indexPath));
  if (!version) {
    fail('frontend/index.html does not declare data-perfetto_version.stable');
  } else {
    const versionDirs = fs
      .readdirSync(frontendDir, {withFileTypes: true})
      .filter(entry => entry.isDirectory() && /^v\d/.test(entry.name))
      .map(entry => entry.name)
      .sort();
    if (versionDirs.length !== 1 || versionDirs[0] !== version) {
      fail(`frontend/index.html stable=${version}, but version directories are [${versionDirs.join(', ')}]`);
    }

    const versionDir = path.join(frontendDir, version);
    const manifestPath = path.join(versionDir, 'manifest.json');
    if (!exists(manifestPath)) {
      fail(`${path.relative(root, manifestPath)} is missing`);
    } else {
      const manifest = JSON.parse(readText(manifestPath));
      for (const [resource, expectedHash] of Object.entries(manifest.resources ?? {})) {
        const resourcePath = path.join(versionDir, resource);
        if (!exists(resourcePath)) {
          fail(`manifest resource is missing: ${path.relative(root, resourcePath)}`);
          continue;
        }
        const actualHash = sha256Resource(resourcePath);
        if (actualHash !== expectedHash) {
          fail(`manifest hash mismatch for ${path.relative(root, resourcePath)}`);
        }
      }

      for (const required of [
        'frontend_bundle.js',
        'frontend.css',
        'engine_bundle.js',
        'traceconv_bundle.js',
        'trace_processor.wasm',
        'trace_processor_memory64.wasm',
        'traceconv.wasm',
        'stdlib_docs.json',
        'syntaqlite-runtime.js',
        'syntaqlite-runtime.wasm',
        'syntaqlite-sqlite.wasm',
      ]) {
        const requiredPath = path.join(versionDir, required);
        if (!exists(requiredPath)) {
          fail(`required prebuild asset is missing: ${path.relative(root, requiredPath)}`);
        }
      }

      for (const requiredManifestResource of ['trace_processor.wasm', 'trace_processor_memory64.wasm']) {
        const expectedHash = manifest.resources?.[requiredManifestResource];
        const resourcePath = path.join(versionDir, requiredManifestResource);
        if (!expectedHash) {
          fail(`manifest resource is missing required hash: ${requiredManifestResource}`);
        } else if (exists(resourcePath) && sha256Resource(resourcePath) !== expectedHash) {
          fail(`manifest hash mismatch for ${path.relative(root, resourcePath)}`);
        }
      }

      for (const bundle of ['engine_bundle.js', 'traceconv_bundle.js']) {
        const bundlePath = path.join(versionDir, bundle);
        if (exists(bundlePath) && fileSize(bundlePath) < 100_000) {
          fail(`${path.relative(root, bundlePath)} looks like a stub (${fileSize(bundlePath)} bytes)`);
        }
        if (bundle === 'engine_bundle.js' && exists(bundlePath)) {
          const bundleText = readText(bundlePath);
          if (!bundleText.includes('"trace_processor.wasm"')) {
            fail(`${path.relative(root, bundlePath)} is missing classic trace_processor.wasm loader glue`);
          }
        }
      }

      const cssPath = path.join(versionDir, 'frontend.css');
      if (exists(cssPath)) {
        const cssText = readText(cssPath);
        const cssAssetUrls = [...cssText.matchAll(/url\(\s*(["']?)([^"')]+)\1\s*\)/g)]
          .map(match => match[2])
          .filter(assetUrl => !/^(?:data:|https?:)/.test(assetUrl));
        for (const assetUrl of [...new Set(cssAssetUrls)].sort()) {
          const pathname = assetUrl.split(/[?#]/, 1)[0];
          const assetPath = pathname.startsWith('/')
            ? path.join(frontendDir, pathname.slice(1))
            : path.resolve(versionDir, pathname);
          const relativeAssetPath = path.relative(frontendDir, assetPath);
          if (relativeAssetPath.startsWith('..') || path.isAbsolute(relativeAssetPath)) {
            fail(`frontend CSS asset escapes frontend/: ${assetUrl}`);
          } else if (!exists(assetPath)) {
            fail(`frontend CSS references missing asset: ${path.relative(root, assetPath)}`);
          } else if (fileSize(assetPath) === 0) {
            fail(`frontend CSS asset is empty: ${path.relative(root, assetPath)}`);
          }
        }
      }

      const bundlePath = path.join(versionDir, 'frontend_bundle.js');
      if (exists(bundlePath)) {
        const bundleText = readText(bundlePath);
        for (const forbidden of [
          "regexp_extract(r.name, 'Lock contention on (?:a )?(.*) lock')",
          'lock_name FROM android_monitor_contention',
          'SELECT lock_name FROM android_monitor_contention',
        ]) {
          if (bundleText.includes(forbidden)) {
            fail(`frontend bundle contains stale AndroidLockContention SQL: ${forbidden}`);
          }
        }
        const requiredTopLevelSyntaqliteAssets = [
          'assets/syntaqlite-perfetto.wasm',
          'assets/syntaqlite-runtime.js',
          'assets/syntaqlite-runtime.wasm',
          'assets/syntaqlite-sqlite.wasm',
        ];
        const referencedAssets = [...bundleText.matchAll(/["'](assets\/syntaqlite-[^"']+)["']/g)]
          .map(match => match[1]);
        for (const asset of [...new Set([...referencedAssets, ...requiredTopLevelSyntaqliteAssets])].sort()) {
          const assetPath = path.join(frontendDir, asset);
          if (!exists(assetPath)) {
            fail(`frontend bundle references missing asset: ${path.relative(root, assetPath)}`);
          }
          if (exists(assetPath) && fileSize(assetPath) === 0) {
            fail(`frontend asset is empty: ${path.relative(root, assetPath)}`);
          }
        }
      }
    }
  }
}

if (process.exitCode) {
  process.exit(process.exitCode);
}

console.log('frontend prebuild check passed');
