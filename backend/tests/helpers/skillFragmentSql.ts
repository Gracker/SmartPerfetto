// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)

import {builtInSkillFragment, injectFragmentCtes} from '../../src/services/skillEngine/skillFragments';
import {substituteSqlPlaceholders} from '../../src/services/skillEngine/sqlTemplate';

/** Prepend a step's declared built-in fragments exactly as the Skill executor does. */
export function withStepFragments(sql: string, fragments: readonly string[] | undefined): string {
  return injectFragmentCtes(sql, (fragments || []).map(path => builtInSkillFragment(path.replace(/^fragments\//, ''))));
}

/**
 * Step SQL with its fragments, every bound placeholder (comments keep theirs)
 * filled: `vars` by path, else
 * the placeholder's own default. A placeholder with neither throws, so a test
 * cannot silently run SQL that still contains `${...}`.
 */
export function renderStepSql(
  sql: string,
  fragments: readonly string[] | undefined,
  vars: Readonly<Record<string, string | number>>,
): string {
  return substituteSqlPlaceholders(withStepFragments(sql, fragments), placeholder => {
    const value = vars[placeholder.path] ?? placeholder.defaultValue;
    if (value === undefined) throw new Error(`unbound placeholder ${placeholder.match}`);
    return String(value);
  });
}
