#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const backendRoot = path.resolve(__dirname, '..');
const repoRoot = path.resolve(backendRoot, '..');
const stdlibRoot = process.env.PERFETTO_STDLIB_PATH
  ? path.resolve(process.env.PERFETTO_STDLIB_PATH)
  : path.join(repoRoot, 'perfetto', 'src', 'trace_processor', 'perfetto_sql', 'stdlib');
const outputPath = path.join(backendRoot, 'data', 'perfettoStdlibSymbols.json');

const CREATE_REGEX =
  /^\s*CREATE\s+(?:OR\s+REPLACE\s+)?PERFETTO\s+(?:TABLE|VIEW|FUNCTION|MACRO)\s+([A-Za-z_][A-Za-z0-9_]*)/gim;

function walkSqlFiles(dir, out = []) {
  const entries = fs.readdirSync(dir, { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name));

  for (const entry of entries) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkSqlFiles(abs, out);
    } else if (entry.isFile() && entry.name.endsWith('.sql')) {
      out.push(abs);
    }
  }

  return out;
}

function relPathToModulePath(relPath) {
  return relPath.replace(/\\/g, '/').replace(/\.sql$/, '').replace(/\//g, '.');
}

function parseSymbols(sql) {
  const out = [];
  for (const match of sql.matchAll(CREATE_REGEX)) {
    const name = match[1].toLowerCase();
    if (!name.startsWith('_')) out.push(name);
  }
  return out;
}

function getSubmoduleSha() {
  try {
    return execFileSync('git', ['-C', path.join(repoRoot, 'perfetto'), 'rev-parse', 'HEAD'], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return undefined;
  }
}

if (!fs.existsSync(stdlibRoot)) {
  console.error(`Perfetto stdlib directory not found: ${stdlibRoot}`);
  process.exit(1);
}

const modules = new Set();
const builtins = new Set();
const tableToModule = new Map();

for (const abs of walkSqlFiles(stdlibRoot)) {
  const rel = path.relative(stdlibRoot, abs).replace(/\\/g, '/');
  const isPrelude = rel.split('/')[0] === 'prelude';
  const symbols = parseSymbols(fs.readFileSync(abs, 'utf-8'));

  if (isPrelude) {
    for (const symbol of symbols) builtins.add(symbol);
    continue;
  }

  const modulePath = relPathToModulePath(rel);
  modules.add(modulePath);
  for (const symbol of symbols) {
    if (!tableToModule.has(symbol)) tableToModule.set(symbol, modulePath);
  }
}

const sortedModules = Array.from(modules).sort();
const sortedBuiltins = Array.from(builtins).sort();
const sortedTableToModule = Object.fromEntries(
  Array.from(tableToModule.entries()).sort(([a], [b]) => a.localeCompare(b)),
);

const asset = {
  version: 1,
  generatedAt: new Date().toISOString(),
  generatedFrom: getSubmoduleSha(),
  sourcePath: 'perfetto/src/trace_processor/perfetto_sql/stdlib',
  moduleCount: sortedModules.length,
  symbolCount: Object.keys(sortedTableToModule).length,
  builtinCount: sortedBuiltins.length,
  modules: sortedModules,
  tableToModule: sortedTableToModule,
  builtins: sortedBuiltins,
};

fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, `${JSON.stringify(asset, null, 2)}\n`);

console.log(
  `Generated ${path.relative(repoRoot, outputPath)} ` +
  `(${asset.moduleCount} modules, ${asset.symbolCount} symbols, ${asset.builtinCount} builtins).`
);
