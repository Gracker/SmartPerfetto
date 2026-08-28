// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import fs from 'node:fs';
import path from 'node:path';

import {
  CodebaseRegistry,
  type CodebaseRef,
} from '../services/codebase/codebaseRegistry';
import {OnDemandSourceAccessService} from '../services/codebase/onDemandSourceAccess';

const DETERMINISTIC_FIXTURE_MAX_FILES = 8;
const DETERMINISTIC_FIXTURE_MAX_FILE_BYTES = 64 * 1024;

function isWithinRoot(rootPath: string, candidatePath: string): boolean {
  const relative = path.relative(rootPath, candidatePath);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function resolveFixtureScopes(ref: CodebaseRef): string[] {
  const configuredScopes = ref.pathFilters?.length ? ref.pathFilters : ['.'];
  return configuredScopes.map(scope => {
    const configuredPath = path.resolve(ref.rootRealpath, scope);
    if (!isWithinRoot(ref.rootRealpath, configuredPath) || fs.lstatSync(configuredPath).isSymbolicLink()) {
      throw new Error('Deterministic source fixture scope escapes its registered root');
    }
    const realScope = fs.realpathSync(configuredPath);
    if (!isWithinRoot(ref.rootRealpath, realScope)) {
      throw new Error('Deterministic source fixture scope escapes its registered root');
    }
    return realScope;
  });
}

function assertDeterministicFixtureCoverage(ref: CodebaseRef): void {
  const files = new Set<string>();
  for (const scope of resolveFixtureScopes(ref)) {
    const entries = fs.readdirSync(scope, {withFileTypes: true});
    if (entries.some(entry => !entry.isFile())) {
      throw new Error('Deterministic source fixture scope must contain only regular files');
    }
    for (const entry of entries) files.add(path.join(scope, entry.name));
  }
  if (files.size === 0 || files.size > DETERMINISTIC_FIXTURE_MAX_FILES) {
    throw new Error('Deterministic source fixture exceeds the bounded file-count contract');
  }
  for (const filePath of files) {
    const stat = fs.statSync(filePath);
    if (!stat.isFile() || stat.size > DETERMINISTIC_FIXTURE_MAX_FILE_BYTES) {
      throw new Error('Deterministic source fixture exceeds the exact traversal contract');
    }
  }
}

/**
 * Makes bounded test fixtures independent of an installed ripgrep binary while
 * preserving the real Node traversal and search implementation.
 */
export class DeterministicFixtureSourceAccessService extends OnDemandSourceAccessService {
  constructor(private readonly fixtureRegistry: CodebaseRegistry) {
    super({
      registry: fixtureRegistry,
      ripgrepPath: '__smartperfetto_deterministic_missing_rg__',
    });
  }

  override async search(input: Parameters<OnDemandSourceAccessService['search']>[0]) {
    const result = await super.search(input);
    if (
      result.backend !== 'node' ||
      result.backendFidelity !== 'degraded' ||
      result.searchIncompleteReason !== 'backend_degraded' ||
      result.truncated ||
      result.coverageComplete
    ) {
      return result;
    }
    const ref = this.fixtureRegistry.get(input.codebaseId, input.scope);
    if (!ref) throw new Error('Deterministic source fixture registration is missing');
    assertDeterministicFixtureCoverage(ref);
    return {
      ...result,
      coverageComplete: true,
      searchIncompleteReason: undefined,
      backendFidelity: 'exact' as const,
    };
  }
}
