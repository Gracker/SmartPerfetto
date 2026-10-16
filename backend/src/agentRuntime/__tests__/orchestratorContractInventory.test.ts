// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import { describe, expect, it } from '@jest/globals';
import fs from 'fs';
import path from 'path';
import type { IOrchestrator } from '../../agent/core/orchestratorTypes';

const CONSUMED_OPTIONAL_HOOKS = [
  'abortSession',
  'cleanupSession',
  'getFocusStore',
  'recordUserInteraction',
  'restoreArchitectureCache',
  'getCachedArchitecture',
  'getSessionNotes',
  'getSessionPlan',
  'getSessionUncertaintyFlags',
  'takeSnapshot',
  'restoreFromSnapshot',
] as const satisfies readonly (keyof IOrchestrator)[];

const CONSUMER_FILES = [
  'assistant/application/agentAnalyzeSessionService.ts',
  'routes/agentRoutes.ts',
  'routes/agentResumeRoutes.ts',
  'routes/agentReportRoutes.ts',
  'cli-user/services/cliAnalyzeService.ts',
  'services/agentReportData.ts',
  'services/persistAgentSession.ts',
] as const;

function sourceText(relativePath: string): string {
  return fs.readFileSync(path.join(__dirname, '../..', relativePath), 'utf8');
}

function sourceMentionsHook(hook: string): boolean {
  const pattern = new RegExp(`\\.${hook}\\b`);
  return CONSUMER_FILES.some((file) => pattern.test(sourceText(file)));
}

describe('IOrchestrator contract inventory', () => {
  it('tracks source consumers for optional hooks on the route-facing facade', () => {
    for (const hook of CONSUMED_OPTIONAL_HOOKS) {
      expect(sourceMentionsHook(hook)).toBe(true);
    }
    expect(sourceMentionsHook('restoreSessionMapping')).toBe(false);
    expect(sourceMentionsHook('getProgressTracker')).toBe(false);
  });
});
