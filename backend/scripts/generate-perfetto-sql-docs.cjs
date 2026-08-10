#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const {
  generateFullStdlibDocs,
  loadFullStdlibDocs,
  normalizeModuleDoc,
} = require('./perfetto-stdlib-docs.cjs');

const backendRoot = path.resolve(__dirname, '..');
const repoRoot = path.resolve(backendRoot, '..');
const outputPath = path.join(backendRoot, 'data', 'perfettoSqlDocs.json');
const perfettoRoot = process.env.PERFETTO_SOURCE_ROOT
  ? path.resolve(process.env.PERFETTO_SOURCE_ROOT)
  : path.join(repoRoot, 'perfetto');
const stdlibRoot = path.join(perfettoRoot, 'src', 'trace_processor', 'perfetto_sql', 'stdlib');

function readTextIfExists(file) {
  try {
    return fs.existsSync(file) ? fs.readFileSync(file, 'utf-8') : '';
  } catch {
    return '';
  }
}

function currentFrontendVersion() {
  const html = readTextIfExists(path.join(repoRoot, 'frontend', 'index.html'));
  const match = html.match(/(v\d+(?:\.\d+)*-[a-f0-9]+)\//);
  return match?.[1];
}

function findStdlibDocsPath() {
  if (process.env.PERFETTO_STDLIB_DOCS_PATH) {
    return path.resolve(process.env.PERFETTO_STDLIB_DOCS_PATH);
  }

  const candidates = [];
  const version = currentFrontendVersion();
  if (version) {
    candidates.push(path.join(repoRoot, 'frontend', version, 'stdlib_docs.json'));
  }

  const frontendRoot = path.join(repoRoot, 'frontend');
  if (fs.existsSync(frontendRoot)) {
    for (const entry of fs.readdirSync(frontendRoot).sort().reverse()) {
      if (entry.startsWith('v')) {
        candidates.push(path.join(frontendRoot, entry, 'stdlib_docs.json'));
      }
    }
  }

  const outRoot = path.join(repoRoot, 'perfetto', 'out');
  if (fs.existsSync(outRoot)) {
    const stack = [outRoot];
    while (stack.length) {
      const dir = stack.pop();
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const abs = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          stack.push(abs);
        } else if (entry.isFile() && entry.name === 'stdlib_docs.json') {
          candidates.push(abs);
        }
      }
    }
  }

  return candidates.find(file => fs.existsSync(file));
}

function findPfsqlBin() {
  if (!process.env.PERFETTO_SOURCE_ROOT && process.env.PFSQL_BIN) {
    const explicit = path.resolve(process.env.PFSQL_BIN);
    return fs.existsSync(explicit) ? explicit : undefined;
  }
  const outRoot = path.join(perfettoRoot, 'out');
  if (!fs.existsSync(outRoot)) return undefined;
  const stack = [outRoot];
  while (stack.length) {
    const dir = stack.pop();
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(abs);
      } else if (entry.isFile() && entry.name === 'pfsql') {
        try {
          fs.accessSync(abs, fs.constants.X_OK);
          return abs;
        } catch {
          // Built object directories can contain ninja metadata but no binary.
        }
      }
    }
  }
  return undefined;
}

function getSubmoduleSha() {
  if (process.env.PERFETTO_GENERATED_FROM) {
    return process.env.PERFETTO_GENERATED_FROM;
  }
  try {
    return execFileSync('git', ['-C', perfettoRoot, 'rev-parse', 'HEAD'], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return undefined;
  }
}

function normalizeText(value) {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
}

function sortedUnique(values) {
  return Array.from(new Set((values || []).filter(Boolean))).sort();
}

function moduleToSourcePath(moduleName) {
  return `perfetto/src/trace_processor/perfetto_sql/stdlib/${moduleName.replace(/\./g, '/')}.sql`;
}

function columnFromDoc(col) {
  return {
    name: col.name,
    type: col.type,
    description: normalizeText(col.desc),
    ...(col.table ? { table: col.table } : {}),
    ...(col.column ? { column: col.column } : {}),
  };
}

function paramFromDoc(arg) {
  return {
    name: arg.name,
    type: arg.type,
    description: normalizeText(arg.desc),
    ...(arg.table ? { table: arg.table } : {}),
    ...(arg.column ? { column: arg.column } : {}),
  };
}

function entryTypeFromDataObject(type) {
  const normalized = String(type || '').toLowerCase();
  return normalized === 'table' ? 'table' : 'view';
}

function loadPfsqlLineage() {
  const pfsql = findPfsqlBin();
  if (!pfsql || !fs.existsSync(stdlibRoot)) {
    return { status: 'unavailable' };
  }
  try {
    const raw = execFileSync(pfsql, ['lineage', stdlibRoot], {
      cwd: repoRoot,
      encoding: 'utf-8',
      maxBuffer: 64 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const parsed = JSON.parse(raw);
    const modules = new Map();
    const symbols = new Map();
    for (const mod of parsed.modules || []) {
      modules.set(mod.module, {
        missingIncludes: sortedUnique(mod.missing_includes),
        errors: sortedUnique(mod.errors),
      });
      for (const sym of mod.symbols || []) {
        const usesModules = sortedUnique(Object.keys(sym.uses || {}));
        const implicitUsesModules = sortedUnique(Object.keys(sym.implicit_uses || {}));
        symbols.set(`${mod.module}\n${sym.name}`, {
          usesModules,
          implicitUsesModules,
          intrinsicsOrExternal: sortedUnique(sym.intrinsics_or_external),
        });
      }
    }
    return {
      status: 'ok',
      binary: path.relative(repoRoot, pfsql),
      modules,
      symbols,
    };
  } catch (error) {
    return { status: 'failed', error: error.message };
  }
}

const docsPath = process.env.PERFETTO_SOURCE_ROOT ? undefined : findStdlibDocsPath();
if (!process.env.PERFETTO_SOURCE_ROOT && !docsPath) {
  console.error('Could not find stdlib_docs.json. Set PERFETTO_STDLIB_DOCS_PATH to regenerate.');
  process.exit(1);
}

const generatedFrom = getSubmoduleSha();
const docsSource = process.env.PERFETTO_SOURCE_ROOT
  ? {
      docs: generateFullStdlibDocs({perfettoRoot, stdlibRoot}),
      sourceDocsMode: 'runtime-revision-source-generator',
    }
  : loadFullStdlibDocs({docsPath, repoRoot, stdlibRoot});
const {docs, sourceDocsMode} = docsSource;
const pfsqlLineage = loadPfsqlLineage();

const modules = [];
const entries = [];
const moduleIncludeMap = new Map();

for (const group of docs) {
  const packageName = group.name;
  for (const mod of group.modules || []) {
    const moduleName = mod.module_name;
    const includes = sortedUnique(mod.includes);
    moduleIncludeMap.set(moduleName, includes);

    const symbolNames = [];
    const moduleLineage = pfsqlLineage.modules?.get(moduleName) || {};
    const moduleBase = {
      package: packageName,
      module: moduleName,
      moduleDoc: normalizeModuleDoc(mod.module_doc),
      tags: sortedUnique(mod.tags),
      includes,
      dataCheckSql: mod.data_check_sql || undefined,
      sourcePath: moduleToSourcePath(moduleName),
      missingIncludes: moduleLineage.missingIncludes || [],
      errors: moduleLineage.errors || [],
    };

    for (const obj of mod.data_objects || []) {
      symbolNames.push(obj.name);
      const lineage = pfsqlLineage.symbols?.get(`${moduleName}\n${obj.name}`);
      entries.push({
        id: `stdlib.${moduleName}.${obj.name}`,
        name: obj.name,
        type: entryTypeFromDataObject(obj.type),
        category: moduleName.split('.')[0] || packageName,
        subcategory: moduleName.split('.').slice(1).join('.'),
        module: moduleName,
        package: packageName,
        description: normalizeText(obj.summary_desc || obj.desc || mod.module_doc),
        fullDescription: normalizeText(obj.desc),
        visibility: obj.visibility || 'public',
        tags: moduleBase.tags,
        include: `INCLUDE PERFETTO MODULE ${moduleName};`,
        moduleIncludes: includes,
        dataCheckSql: obj.data_check_sql || mod.data_check_sql || undefined,
        sourcePath: moduleBase.sourcePath,
        columns: (obj.cols || []).map(columnFromDoc),
        ...(lineage ? { lineage } : {}),
      });
    }

    for (const fn of mod.functions || []) {
      symbolNames.push(fn.name);
      const lineage = pfsqlLineage.symbols?.get(`${moduleName}\n${fn.name}`);
      entries.push({
        id: `stdlib.${moduleName}.${fn.name}`,
        name: fn.name,
        type: 'function',
        category: moduleName.split('.')[0] || packageName,
        subcategory: moduleName.split('.').slice(1).join('.'),
        module: moduleName,
        package: packageName,
        description: normalizeText(fn.summary_desc || fn.desc || mod.module_doc),
        fullDescription: normalizeText(fn.desc),
        visibility: fn.visibility || 'public',
        tags: moduleBase.tags,
        include: `INCLUDE PERFETTO MODULE ${moduleName};`,
        moduleIncludes: includes,
        returnType: fn.return_type || undefined,
        returnDescription: normalizeText(fn.return_desc),
        sourcePath: moduleBase.sourcePath,
        params: (fn.args || []).map(paramFromDoc),
        ...(lineage ? { lineage } : {}),
      });
    }

    for (const fn of mod.table_functions || []) {
      symbolNames.push(fn.name);
      const lineage = pfsqlLineage.symbols?.get(`${moduleName}\n${fn.name}`);
      entries.push({
        id: `stdlib.${moduleName}.${fn.name}`,
        name: fn.name,
        type: 'table_function',
        category: moduleName.split('.')[0] || packageName,
        subcategory: moduleName.split('.').slice(1).join('.'),
        module: moduleName,
        package: packageName,
        description: normalizeText(fn.summary_desc || fn.desc || mod.module_doc),
        fullDescription: normalizeText(fn.desc),
        visibility: fn.visibility || 'public',
        tags: moduleBase.tags,
        include: `INCLUDE PERFETTO MODULE ${moduleName};`,
        moduleIncludes: includes,
        returnType: fn.return_type || undefined,
        returnDescription: normalizeText(fn.return_desc),
        sourcePath: moduleBase.sourcePath,
        params: (fn.args || []).map(paramFromDoc),
        columns: (fn.cols || []).map(columnFromDoc),
        ...(lineage ? { lineage } : {}),
      });
    }

    for (const macro of mod.macros || []) {
      symbolNames.push(macro.name);
      const lineage = pfsqlLineage.symbols?.get(`${moduleName}\n${macro.name}`);
      entries.push({
        id: `stdlib.${moduleName}.${macro.name}`,
        name: macro.name,
        type: 'macro',
        category: moduleName.split('.')[0] || packageName,
        subcategory: moduleName.split('.').slice(1).join('.'),
        module: moduleName,
        package: packageName,
        description: normalizeText(macro.summary_desc || macro.desc || mod.module_doc),
        fullDescription: normalizeText(macro.desc),
        visibility: macro.visibility || 'public',
        tags: moduleBase.tags,
        include: `INCLUDE PERFETTO MODULE ${moduleName};`,
        moduleIncludes: includes,
        returnType: macro.return_type || undefined,
        returnDescription: normalizeText(macro.return_desc),
        sourcePath: moduleBase.sourcePath,
        params: (macro.args || []).map(paramFromDoc),
        ...(lineage ? { lineage } : {}),
      });
    }

    modules.push({
      ...moduleBase,
      symbols: sortedUnique(symbolNames),
    });
  }
}

function collectTransitiveIncludes(moduleName, seen = new Set()) {
  const direct = moduleIncludeMap.get(moduleName) || [];
  for (const dep of direct) {
    if (seen.has(dep)) continue;
    seen.add(dep);
    collectTransitiveIncludes(dep, seen);
  }
  return sortedUnique(Array.from(seen));
}

const modulesWithClosure = modules
  .map(mod => ({
    ...mod,
    transitiveIncludes: collectTransitiveIncludes(mod.module),
  }))
  .sort((a, b) => a.module.localeCompare(b.module));

const moduleByName = new Map(modulesWithClosure.map(mod => [mod.module, mod]));
const entriesWithClosure = entries
  .map(entry => ({
    ...entry,
    transitiveIncludes: moduleByName.get(entry.module)?.transitiveIncludes || [],
  }))
  .sort((a, b) => a.name.localeCompare(b.name) || a.module.localeCompare(b.module));

const symbolToModule = {};
for (const entry of entriesWithClosure) {
  if (!symbolToModule[entry.name]) symbolToModule[entry.name] = entry.module;
}

const stats = {
  moduleCount: modulesWithClosure.length,
  entryCount: entriesWithClosure.length,
  byType: entriesWithClosure.reduce((acc, entry) => {
    acc[entry.type] = (acc[entry.type] || 0) + 1;
    return acc;
  }, {}),
};

const asset = {
  version: 1,
  generatedAt: new Date().toISOString(),
  generatedFrom,
  sourceDocs: docsPath
    ? path.relative(repoRoot, docsPath)
    : `git:${generatedFrom}:src/trace_processor/perfetto_sql/stdlib`,
  sourceDocsMode,
  pfsqlLineage: {
    status: pfsqlLineage.status,
    ...(pfsqlLineage.binary ? { binary: pfsqlLineage.binary } : {}),
    ...(pfsqlLineage.error ? { error: pfsqlLineage.error } : {}),
  },
  stats,
  modules: modulesWithClosure,
  entries: entriesWithClosure,
  symbolToModule: Object.fromEntries(Object.entries(symbolToModule).sort(([a], [b]) => a.localeCompare(b))),
};

fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, `${JSON.stringify(asset, null, 2)}\n`);

console.log(
  `Generated ${path.relative(repoRoot, outputPath)} ` +
  `(${stats.moduleCount} modules, ${stats.entryCount} entries, pfsql=${asset.pfsqlLineage.status}).`
);
