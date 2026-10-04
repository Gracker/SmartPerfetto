// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

// Where a Skill root keeps what: the one description of the layout the loader
// reads, the CLI validates, a Skill pack may ship and the Trace tooling
// inventories (Trace/skill-sql.inventory.json records it for the tooling,
// which cannot import TypeScript).

import fs from 'fs';
import path from 'path';

export const SKILL_LAYOUT = {
  /** Flat directories of Skill files, read in this order from every root. */
  skillDirs: ['atomic', 'composite', 'deep', 'system', 'comparison'],
  /** Built-in only: Skills a source checkout adds, read after skillDirs. */
  customDir: 'custom',
  /** Module expert Skills, read recursively. */
  modulesDir: 'modules',
  /** Pipeline definitions; a file whose name starts with templatePrefix is a template. */
  pipelinesDir: 'pipelines',
  templatePrefix: '_',
  fragmentsDir: 'fragments',
  /** Built-in only: one directory per vendor of `*.override.yaml` files. */
  vendorsDir: 'vendors',
  docsDir: 'docs',
} as const;

/** A Skill file name. */
export const SKILL_FILE_PATTERN = /\.skill\.ya?ml$/;

/** The top-level directories a Skill pack may ship Skills in (no custom Skills, no vendor overrides). */
export const PACK_SKILL_DIRS: readonly string[] = [...SKILL_LAYOUT.skillDirs, SKILL_LAYOUT.modulesDir, SKILL_LAYOUT.pipelinesDir];

/** How a Skill file is read: a Skill, a module expert Skill, or a pipeline definition. */
export type SkillFileKind = 'skill' | 'module' | 'pipeline';

export interface SkillFile {
  path: string;
  kind: SkillFileKind;
}

/**
 * Every Skill file of a root, in the order the loader reads them: the flat
 * skillDirs, then (with `includeCustom`) customDir, then modulesDir at any
 * depth, then the pipelinesDir definitions that are not templates. A missing
 * directory has no files.
 */
export function listSkillFiles(rootPath: string, options: {includeCustom?: boolean} = {}): SkillFile[] {
  const flat = (dir: string, kind: SkillFileKind, skip?: (name: string) => boolean): SkillFile[] => {
    const full = path.join(rootPath, dir);
    if (!fs.existsSync(full)) return [];
    return fs.readdirSync(full)
      .filter(name => SKILL_FILE_PATTERN.test(name) && !skip?.(name))
      .map(name => ({path: path.join(full, name), kind}));
  };
  const recursive = (dir: string): SkillFile[] => fs.readdirSync(dir, {withFileTypes: true}).flatMap(entry => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return recursive(full);
    return SKILL_FILE_PATTERN.test(entry.name) ? [{path: full, kind: 'module' as const}] : [];
  });
  const modules = path.join(rootPath, SKILL_LAYOUT.modulesDir);
  return [
    ...SKILL_LAYOUT.skillDirs.flatMap(dir => flat(dir, 'skill')),
    ...(options.includeCustom ? flat(SKILL_LAYOUT.customDir, 'skill') : []),
    ...(fs.existsSync(modules) ? recursive(modules) : []),
    ...flat(SKILL_LAYOUT.pipelinesDir, 'pipeline', name => name.startsWith(SKILL_LAYOUT.templatePrefix)),
  ];
}
