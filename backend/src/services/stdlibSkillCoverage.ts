// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

/**
 * Stdlib Skill Coverage Analyzer (Spark Plan 01)
 *
 * Produces a `StdlibSkillCoverageContract` snapshot of:
 *  - Which Perfetto stdlib modules are referenced by Skill YAML prerequisites.
 *  - Which modules are detected via raw SQL inspection (`sqlIncludeInjector`).
 *  - Drift between declared and detected — both ways.
 *  - Modules that no Skill currently references (uncovered → Skill suggestion).
 *  - New modules since the last persisted snapshot (Spark #21 watcher hook).
 *
 * The analyzer is read-only and intentionally side-effect-light: it can run
 * inside `validate:skills` summary, the CLI `coverage` command, or be invoked
 * from any maintenance flow without spinning up a trace processor.
 */

import * as fs from 'fs';
import * as path from 'path';
import {
  getPerfettoStdlibModules,
} from './perfettoStdlibScanner';
import {injectStdlibIncludes} from '../agentv3/sqlIncludeInjector';
import {
  ensureSkillRegistryInitialized,
  skillRegistry,
} from './skillEngine/skillLoader';
import type {SkillDefinition} from './skillEngine/types';
import {executableSqlUnits} from './skillEngine/processScopeSql';
import {
  makeSparkProvenance,
  type StdlibModuleEntry,
  type StdlibSkillCoverageContract,
  type StdlibSkillUsage,
} from '../types/sparkContracts';

/**
 * Match an explicit `INCLUDE PERFETTO MODULE <name>;` statement in raw SQL.
 * Mirrors the include syntax recognized by `sqlStdlibDependencyAnalyzer` so we count
 * modules the skill author already wrote into their SQL — without those
 * being treated as drift just because the auto-injector did not need to
 * add them.
 */
const EXPLICIT_INCLUDE_REGEX = /\bINCLUDE\s+PERFETTO\s+MODULE\s+([\w.]+)/gi;

/** @internal The stdlib modules, lowercase, a Skill's SQL units read; the SQL-unit contract test reads it. */
export function detectStdlibModulesUsedBySkill(skill: SkillDefinition): Set<string> {
  const detected = new Set<string>();

  const visit = (sql: string | undefined): void => {
    if (!sql || sql.trim().length === 0) return;
    // Count modules the author already wrote: `INCLUDE PERFETTO MODULE foo;`.
    // Codex review caught that injectStdlibIncludes() only reports modules
    // it newly added, so a correctly-included module would otherwise look
    // like "declared but unused" drift.
    for (const match of sql.matchAll(EXPLICIT_INCLUDE_REGEX)) {
      const mod = match[1]?.toLowerCase();
      if (mod) detected.add(mod);
    }
    try {
      const result = injectStdlibIncludes(sql);
      for (const mod of result.injected) detected.add(mod);
    } catch {
      // Stay quiet — analyzer must never throw on malformed SQL; the
      // `validate:skills` path already surfaces those errors separately.
    }
  };

  // Every SQL the executor runs, named and exact (executableSqlUnits).
  for (const unit of executableSqlUnits(skill)) {
    if (typeof unit.source.sql === 'string') visit(unit.source.sql);
  }

  return detected;
}

function diffSets(a: Iterable<string>, b: Set<string>): string[] {
  const out: string[] = [];
  for (const item of a) if (!b.has(item)) out.push(item);
  return out.sort();
}

/** Snapshot file for Spark #21 watcher diffing. */
function getDefaultSnapshotPath(): string {
  return path.resolve(__dirname, '../../data/stdlibSkillCoverageSnapshot.json');
}

interface StoredSnapshot {
  version: 1;
  capturedAt: number;
  modules: string[];
}

function readPersistedSnapshot(snapshotPath: string): StoredSnapshot | null {
  try {
    if (!fs.existsSync(snapshotPath)) return null;
    const raw = fs.readFileSync(snapshotPath, 'utf-8');
    const parsed = JSON.parse(raw) as Partial<StoredSnapshot>;
    if (parsed.version !== 1 || !Array.isArray(parsed.modules)) return null;
    return {
      version: 1,
      capturedAt: typeof parsed.capturedAt === 'number' ? parsed.capturedAt : 0,
      modules: parsed.modules,
    };
  } catch {
    return null;
  }
}

export interface AnalyzeStdlibSkillCoverageOptions {
  /** Override snapshot path (used in tests). */
  snapshotPath?: string;
  /** Skip persisted snapshot lookup entirely. */
  ignoreSnapshot?: boolean;
}

/**
 * Analyze Skill prerequisites + raw-SQL detected stdlib usage and produce a
 * `StdlibSkillCoverageContract` snapshot.
 *
 * Returns an unsupported contract (with empty arrays) when the stdlib catalog
 * is unavailable so the caller can detect missing data without inventing
 * coverage statistics.
 */
export async function analyzeStdlibSkillCoverage(
  options: AnalyzeStdlibSkillCoverageOptions = {},
): Promise<StdlibSkillCoverageContract> {
  const stdlibModules = getPerfettoStdlibModules();
  if (stdlibModules.length === 0) {
    return {
      ...makeSparkProvenance({
        source: 'stdlib-skill-coverage',
        unsupportedReason: 'Perfetto stdlib catalog is empty',
      }),
      totalModules: 0,
      modulesCovered: 0,
      skillsWithDrift: 0,
      uncoveredModules: [],
      skillUsage: [],
      coverage: [
        {sparkId: 1, planId: '01', status: 'unsupported'},
        {sparkId: 21, planId: '01', status: 'unsupported'},
      ],
    };
  }

  await ensureSkillRegistryInitialized();
  const skills = skillRegistry.getAllSkills();

  const stdlibSet = new Set(stdlibModules);
  const declaredCount = new Map<string, number>();
  const usedCount = new Map<string, number>();
  const skillUsage: StdlibSkillUsage[] = [];

  let skillsWithDrift = 0;

  for (const skill of skills) {
    const declared = (skill.prerequisites?.modules ?? []).slice().sort();
    const detected = Array.from(detectStdlibModulesUsedBySkill(skill)).sort();

    const declaredSet = new Set(declared);
    const detectedSet = new Set(detected);

    const declaredButUnused = diffSets(declared, detectedSet);
    const detectedButUndeclared = diffSets(detected, declaredSet);

    if (declaredButUnused.length > 0 || detectedButUndeclared.length > 0) {
      skillsWithDrift += 1;
    }

    for (const m of declared) {
      if (stdlibSet.has(m)) declaredCount.set(m, (declaredCount.get(m) ?? 0) + 1);
    }
    for (const m of detected) {
      if (stdlibSet.has(m)) usedCount.set(m, (usedCount.get(m) ?? 0) + 1);
    }

    skillUsage.push({
      skillId: skill.name,
      declared,
      detected,
      declaredButUnused,
      detectedButUndeclared,
    });
  }

  // Coverage = modules referenced by any skill (declared OR detected).
  const referenced = new Set<string>();
  for (const m of declaredCount.keys()) referenced.add(m);
  for (const m of usedCount.keys()) referenced.add(m);

  const uncoveredModules: StdlibModuleEntry[] = [];
  for (const m of stdlibModules) {
    if (referenced.has(m)) continue;
    uncoveredModules.push({
      module: m,
      declaredBySkills: declaredCount.get(m) ?? 0,
      usedBySkills: usedCount.get(m) ?? 0,
    });
  }

  // Watcher: detect modules added since the persisted snapshot.
  let newlyAddedModules: StdlibModuleEntry[] | undefined;
  if (!options.ignoreSnapshot) {
    const snapshotPath = options.snapshotPath ?? getDefaultSnapshotPath();
    const previous = readPersistedSnapshot(snapshotPath);
    if (previous) {
      const previousSet = new Set(previous.modules);
      const added = stdlibModules.filter(m => !previousSet.has(m));
      if (added.length > 0) {
        newlyAddedModules = added.map(m => ({
          module: m,
          declaredBySkills: declaredCount.get(m) ?? 0,
          usedBySkills: usedCount.get(m) ?? 0,
          newSinceLastSnapshot: true,
        }));
      }
    }
  }

  return {
    ...makeSparkProvenance({source: 'stdlib-skill-coverage'}),
    totalModules: stdlibModules.length,
    modulesCovered: referenced.size,
    skillsWithDrift,
    uncoveredModules,
    skillUsage,
    ...(newlyAddedModules ? {newlyAddedModules} : {}),
    coverage: [
      {
        sparkId: 1,
        planId: '01',
        status: 'implemented',
        note: 'Skill prerequisites + raw SQL detection cross-checked.',
      },
      {
        sparkId: 21,
        planId: '01',
        status: newlyAddedModules ? 'implemented' : 'scaffolded',
        note: newlyAddedModules
          ? 'Newly added stdlib modules surfaced via persisted snapshot diff.'
          : 'Watcher uses persisted snapshot; no diff yet because no snapshot exists.',
      },
    ],
  };
}

/**
 * Persist the current stdlib catalog as a snapshot so future runs can detect
 * newly added modules. Safe to call from CLI; never throws on filesystem
 * issues — it logs a warning and continues.
 */
export function persistStdlibSnapshot(snapshotPath?: string): void {
  const target = snapshotPath ?? getDefaultSnapshotPath();
  const modules = getPerfettoStdlibModules();
  const snapshot: StoredSnapshot = {
    version: 1,
    capturedAt: Date.now(),
    modules,
  };
  try {
    fs.mkdirSync(path.dirname(target), {recursive: true});
    fs.writeFileSync(target, JSON.stringify(snapshot, null, 2), 'utf-8');
  } catch (err: any) {
    console.warn(`[StdlibSkillCoverage] Failed to write snapshot ${target}: ${err.message}`);
  }
}
