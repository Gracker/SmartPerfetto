// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

const {execFileSync} = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isFullDocs(value) {
  return Array.isArray(value) && value.length > 0 && value.every(group =>
    isObject(group) &&
    typeof group.name === 'string' && group.name.length > 0 &&
    Array.isArray(group.modules) &&
    group.modules.every(mod => isObject(mod) && typeof mod.module_name === 'string' && mod.module_name.length > 0)
  );
}

function isMetadataDocs(value) {
  return isObject(value) && Object.keys(value).length > 0 && Object.entries(value).every(([moduleName, metadata]) =>
    moduleName.length > 0 &&
    isObject(metadata) &&
    Array.isArray(metadata.tags) &&
    Array.isArray(metadata.includes) &&
    Object.hasOwn(metadata, 'data_check_sql')
  );
}

function collectSqlFiles(root) {
  const files = [];
  const stack = [path.resolve(root)];
  while (stack.length > 0) {
    const dir = stack.pop();
    for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
      const absolutePath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(absolutePath);
      } else if (entry.isFile() && entry.name.endsWith('.sql')) {
        files.push(absolutePath);
      }
    }
  }
  return files.sort();
}

function fullModuleNames(docs) {
  return docs
    .flatMap(group => group.modules.map(mod => mod.module_name))
    .sort();
}

function runUpstreamGenerator({perfettoRoot, inputListPath, outputPath}) {
  const generator = path.join(perfettoRoot, 'tools', 'gen_stdlib_docs_json.py');
  execFileSync(
    process.env.PYTHON_BIN || 'python3',
    [generator, '--json-out', outputPath, '--input-list-file', inputListPath],
    {cwd: perfettoRoot, stdio: ['ignore', 'inherit', 'inherit']},
  );
}

function generateFullStdlibDocs({
  perfettoRoot,
  stdlibRoot,
  runGenerator = runUpstreamGenerator,
}) {
  const sqlFiles = collectSqlFiles(stdlibRoot);
  if (sqlFiles.length === 0) {
    throw new Error(`Perfetto stdlib contains no SQL files: ${stdlibRoot}`);
  }

  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'smartperfetto-stdlib-docs-'));
  const inputListPath = path.join(tempRoot, 'stdlib-inputs.txt');
  const outputPath = path.join(tempRoot, 'stdlib_docs.full.json');
  try {
    fs.writeFileSync(inputListPath, `${sqlFiles.join('\n')}\n`);
    runGenerator({perfettoRoot, inputListPath, outputPath});
    const generated = JSON.parse(fs.readFileSync(outputPath, 'utf8'));
    if (!isFullDocs(generated)) {
      throw new Error('Perfetto full-doc generator did not produce a full documentation array');
    }
    return generated;
  } finally {
    fs.rmSync(tempRoot, {recursive: true, force: true});
  }
}

function loadFullStdlibDocs({
  docsPath,
  repoRoot,
  stdlibRoot,
  runGenerator = runUpstreamGenerator,
}) {
  const source = JSON.parse(fs.readFileSync(docsPath, 'utf8'));
  if (isFullDocs(source)) {
    return {docs: source, sourceDocsMode: 'full-json'};
  }
  if (!isMetadataDocs(source)) {
    throw new Error(`unsupported stdlib documentation shape: ${docsPath}`);
  }

  const generated = generateFullStdlibDocs({
    perfettoRoot: path.join(repoRoot, 'perfetto'),
    stdlibRoot,
    runGenerator,
  });
  const expectedModules = Object.keys(source).sort();
  const actualModules = fullModuleNames(generated);
  if (JSON.stringify(actualModules) !== JSON.stringify(expectedModules)) {
    throw new Error('Perfetto full documentation modules do not match metadata-only source');
  }
  return {docs: generated, sourceDocsMode: 'metadata-plus-source-generator'};
}

function normalizeModuleDoc(value) {
  const text = isObject(value) ? value.desc : value;
  return typeof text === 'string' ? text.replace(/\s+/g, ' ').trim() : '';
}

module.exports = {
  generateFullStdlibDocs,
  loadFullStdlibDocs,
  normalizeModuleDoc,
};
