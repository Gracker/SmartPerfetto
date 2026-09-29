// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)

import fs from 'node:fs';
import path from 'node:path';

export type TraceCatalogCase = {
  id: string;
  kind: 'real' | 'constructed';
  aliases?: string[];
  case_dir: string;
  trace: {file: string; materialization: 'committed' | 'base-plus-overlay'};
  construction?: {output: string};
};

function defaultRepoRoot(): string {
  const cwd = process.cwd();
  if (fs.existsSync(path.join(cwd, 'Trace', 'catalog.json'))) return cwd;
  const parent = path.resolve(cwd, '..');
  if (fs.existsSync(path.join(parent, 'Trace', 'catalog.json'))) return parent;
  throw new Error(`Cannot locate Trace/catalog.json from ${cwd}`);
}

export function listTraceCases(repoRoot = defaultRepoRoot()): TraceCatalogCase[] {
  const catalogPath = path.join(repoRoot, 'Trace', 'catalog.json');
  const catalog = JSON.parse(fs.readFileSync(catalogPath, 'utf8')) as {cases?: TraceCatalogCase[]};
  if (!Array.isArray(catalog.cases)) throw new Error(`Invalid trace catalog: ${catalogPath}`);
  return catalog.cases;
}

export function resolveTraceCase(selector: string, repoRoot = defaultRepoRoot()): string {
  const matches = listTraceCases(repoRoot).filter(
    entry => entry.id === selector || entry.aliases?.includes(selector),
  );
  if (matches.length !== 1) {
    throw new Error(matches.length === 0
      ? `Unknown trace case: ${selector}`
      : `Ambiguous trace case selector: ${selector}`);
  }
  const entry = matches[0];
  if (entry.trace.materialization === 'base-plus-overlay') {
    if (!entry.construction?.output) throw new Error(`Constructed case has no output: ${entry.id}`);
    return path.resolve(repoRoot, entry.construction.output);
  }
  return path.resolve(repoRoot, entry.case_dir, entry.trace.file);
}
