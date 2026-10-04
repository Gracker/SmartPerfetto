// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

/**
 * Runtime options as admission hands them to a runtime. Every product entry
 * point (`prepareSession`, the conversation and CLI turns) computes the
 * analysis-context fingerprint when it admits a run with private context; a
 * runtime refuses one without it (`requireAdmittedAnalysisContextFingerprint`).
 * Tests that call a runtime directly admit their options the same way.
 */

import type {AnalysisOptions} from '../../src/agent/core/orchestratorTypes';
import * as contextAuthorization from '../../src/services/resolvedAnalysisContext';
import {resolveKnowledgeScope} from '../../src/services/scopedKnowledgeStore';
import {analysisHasPrivateContext} from '../../src/services/security/analysisPrivateContext';

export function admitted<T extends AnalysisOptions | undefined>(options: T): T {
  if (!options || options.analysisContextFingerprint !== undefined || !analysisHasPrivateContext(options)) {
    return options;
  }
  return {...options, analysisContextFingerprint: contextAuthorization
    .buildAnalysisContextAuthorizationFingerprint(options, resolveKnowledgeScope(options))};
}
