// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import * as fs from 'fs';
import * as path from 'path';

export type PerfettoSqlDocEntryType = 'table' | 'view' | 'function' | 'table_function' | 'macro';

export interface PerfettoSqlDocColumn {
  name: string;
  type?: string;
  description?: string;
  table?: string;
  column?: string;
}

export interface PerfettoSqlDocParam {
  name: string;
  type?: string;
  description?: string;
  table?: string;
  column?: string;
}

export interface PerfettoSqlSymbolLineage {
  usesModules?: string[];
  implicitUsesModules?: string[];
  intrinsicsOrExternal?: string[];
}

export interface PerfettoSqlDocEntry {
  id: string;
  name: string;
  type: PerfettoSqlDocEntryType;
  category: string;
  subcategory?: string;
  module: string;
  package: string;
  description: string;
  fullDescription?: string;
  visibility?: string;
  tags?: string[];
  include?: string;
  moduleIncludes?: string[];
  transitiveIncludes?: string[];
  dataCheckSql?: string;
  sourcePath?: string;
  columns?: PerfettoSqlDocColumn[];
  params?: PerfettoSqlDocParam[];
  returnType?: string;
  returnDescription?: string;
  lineage?: PerfettoSqlSymbolLineage;
}

export interface PerfettoSqlModuleDoc {
  package: string;
  module: string;
  moduleDoc?: string;
  tags?: string[];
  includes?: string[];
  transitiveIncludes?: string[];
  dataCheckSql?: string;
  sourcePath?: string;
  missingIncludes?: string[];
  errors?: string[];
  symbols: string[];
}

export interface PerfettoSqlDocsAsset {
  version: number;
  generatedAt?: string;
  generatedFrom?: string;
  sourceDocs?: string;
  sourceDocsMode?:
    | 'full-json'
    | 'metadata-plus-source-generator'
    | 'runtime-revision-source-generator';
  pfsqlLineage?: {
    status: 'ok' | 'unavailable' | 'failed';
    binary?: string;
    error?: string;
  };
  stats?: {
    moduleCount: number;
    entryCount: number;
    byType: Record<string, number>;
  };
  modules: PerfettoSqlModuleDoc[];
  entries: PerfettoSqlDocEntry[];
  symbolToModule: Record<string, string>;
}

export interface PerfettoSqlDocSearchResult {
  entry: PerfettoSqlDocEntry;
  score: number;
  matchedFields: string[];
}

let cachedAsset: PerfettoSqlDocsAsset | null | undefined;
let cachedModuleMap: Map<string, PerfettoSqlModuleDoc> | null = null;

export function getPerfettoSqlDocsAssetPath(): string {
  return path.resolve(__dirname, '../../data/perfettoSqlDocs.json');
}

export function loadPerfettoSqlDocsAsset(): PerfettoSqlDocsAsset | null {
  if (cachedAsset !== undefined) return cachedAsset;

  const assetPath = getPerfettoSqlDocsAssetPath();
  if (!fs.existsSync(assetPath)) {
    cachedAsset = null;
    return cachedAsset;
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(assetPath, 'utf-8')) as Partial<PerfettoSqlDocsAsset>;
    if (
      parsed.version !== 1
      || !Array.isArray(parsed.modules)
      || !Array.isArray(parsed.entries)
      || !parsed.symbolToModule
      || typeof parsed.symbolToModule !== 'object'
    ) {
      console.warn(`[PerfettoSqlDocs] Ignoring invalid docs asset: ${assetPath}`);
      cachedAsset = null;
      return cachedAsset;
    }
    cachedAsset = parsed as PerfettoSqlDocsAsset;
    return cachedAsset;
  } catch (error: any) {
    console.warn(`[PerfettoSqlDocs] Failed to read docs asset ${assetPath}: ${error.message}`);
    cachedAsset = null;
    return cachedAsset;
  }
}

export function clearPerfettoSqlDocsCache(): void {
  cachedAsset = undefined;
  cachedModuleMap = null;
}

function getModuleMap(): Map<string, PerfettoSqlModuleDoc> {
  if (cachedModuleMap) return cachedModuleMap;
  cachedModuleMap = new Map();
  const asset = loadPerfettoSqlDocsAsset();
  for (const mod of asset?.modules ?? []) {
    cachedModuleMap.set(mod.module.toLowerCase(), mod);
  }
  return cachedModuleMap;
}

function tokensFor(query: string): string[] {
  return query
    .toLowerCase()
    .split(/[\s_.:/-]+/)
    .map(t => t.trim())
    .filter(t => t.length >= 2);
}

function includesToken(value: unknown, token: string): boolean {
  return typeof value === 'string' && value.toLowerCase().includes(token);
}

function scoreDocEntry(entry: PerfettoSqlDocEntry, query: string): { score: number; fields: string[] } {
  const lower = query.toLowerCase().trim();
  const tokens = tokensFor(query);
  const fields: string[] = [];
  let score = 0;

  const name = entry.name.toLowerCase();
  const moduleName = entry.module.toLowerCase();
  const desc = (entry.description || '').toLowerCase();

  if (name === lower) {
    score += 120;
    fields.push('name:exact');
  } else if (name.includes(lower)) {
    score += 70;
    fields.push('name:partial');
  }

  if (moduleName === lower) {
    score += 90;
    fields.push('module:exact');
  } else if (moduleName.includes(lower)) {
    score += 40;
    fields.push('module:partial');
  }

  if (desc.includes(lower)) {
    score += 20;
    fields.push('description:partial');
  }

  for (const token of tokens) {
    if (name.includes(token)) {
      score += 16;
      fields.push(`name:token:${token}`);
    }
    if (moduleName.includes(token)) {
      score += 12;
      fields.push(`module:token:${token}`);
    }
    if (desc.includes(token)) {
      score += 6;
      fields.push(`description:token:${token}`);
    }
    if (entry.tags?.some(tag => includesToken(tag, token))) {
      score += 5;
      fields.push(`tag:${token}`);
    }
    if (entry.columns?.some(col =>
      includesToken(col.name, token) || includesToken(col.description, token) || includesToken(col.type, token)
    )) {
      score += 10;
      fields.push(`column:${token}`);
    }
    if (entry.params?.some(param =>
      includesToken(param.name, token) || includesToken(param.description, token) || includesToken(param.type, token)
    )) {
      score += 8;
      fields.push(`param:${token}`);
    }
  }

  return { score, fields: [...new Set(fields)] };
}

export function searchPerfettoSqlDocs(
  query: string,
  options: { limit?: number; includePrivate?: boolean; type?: string; module?: string } = {},
): PerfettoSqlDocSearchResult[] {
  const asset = loadPerfettoSqlDocsAsset();
  if (!asset || !query.trim()) return [];

  const results: PerfettoSqlDocSearchResult[] = [];
  const moduleFilter = options.module?.toLowerCase();
  for (const entry of asset.entries) {
    if (!options.includePrivate && (entry.visibility === 'private' || entry.name.startsWith('_'))) {
      continue;
    }
    if (options.type && entry.type !== options.type) continue;
    if (moduleFilter && entry.module.toLowerCase() !== moduleFilter) continue;

    const scored = scoreDocEntry(entry, query);
    if (scored.score > 0) {
      results.push({ entry, score: scored.score, matchedFields: scored.fields });
    }
  }

  results.sort((a, b) =>
    b.score - a.score
    || a.entry.name.localeCompare(b.entry.name)
    || a.entry.module.localeCompare(b.entry.module)
  );
  return results.slice(0, options.limit ?? 30);
}

export function getPerfettoSqlModuleDoc(moduleName: string): PerfettoSqlModuleDoc | undefined {
  return getModuleMap().get(moduleName.toLowerCase());
}

export function listPerfettoSqlModuleDocs(namespace?: string): PerfettoSqlModuleDoc[] {
  const asset = loadPerfettoSqlDocsAsset();
  if (!asset) return [];
  const normalized = namespace?.trim().toLowerCase();
  return asset.modules
    .filter(mod => {
      if (!normalized) return true;
      const name = mod.module.toLowerCase();
      return name === normalized || name.startsWith(`${normalized}.`);
    })
    .sort((a, b) => a.module.localeCompare(b.module));
}

export function getPerfettoSqlModuleClosure(moduleName: string): string[] {
  const mod = getPerfettoSqlModuleDoc(moduleName);
  return mod?.transitiveIncludes ?? [];
}

export function moduleCoveredByPerfettoSqlLineage(targetModule: string, declaredModule: string): boolean {
  const target = targetModule.trim().toLowerCase();
  const declared = declaredModule.trim().toLowerCase();
  if (!target || !declared) return false;
  if (target === declared || target.startsWith(`${declared}.`)) return true;

  for (const included of getPerfettoSqlModuleClosure(declared)) {
    const normalized = included.toLowerCase();
    if (target === normalized || target.startsWith(`${normalized}.`)) {
      return true;
    }
  }
  return false;
}
