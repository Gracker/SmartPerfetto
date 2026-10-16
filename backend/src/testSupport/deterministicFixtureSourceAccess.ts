// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {CodebaseRegistry} from '../services/codebase/codebaseRegistry';
import {OnDemandSourceAccessService} from '../services/codebase/onDemandSourceAccess';

/**
 * Makes bounded test fixtures independent of an installed ripgrep binary by
 * always running the real Node traversal and search implementation. Its
 * coverage and fidelity are reported exactly as production reports them.
 */
export class DeterministicFixtureSourceAccessService extends OnDemandSourceAccessService {
  constructor(fixtureRegistry: CodebaseRegistry) {
    super({
      registry: fixtureRegistry,
      ripgrepPath: '__smartperfetto_deterministic_missing_rg__',
    });
  }
}
