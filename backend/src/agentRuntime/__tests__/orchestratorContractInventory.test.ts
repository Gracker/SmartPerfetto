// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import { describe, expect, it } from '@jest/globals';
import fs from 'fs';
import path from 'path';
import type { IOrchestrator } from '../../agent/core/orchestratorTypes';

const ORCHESTRATOR_REQUIRED_HOOKS = [
  'on',
  'off',
  'emit',
  'removeAllListeners',
  'analyze',
  'reset',
] as const satisfies readonly (keyof IOrchestrator)[];

const ORCHESTRATOR_OPTIONAL_HOOKS = [
  'abortSession',
  'cleanupSession',
  'getFocusStore',
  'recordUserInteraction',
  'getSdkSessionId',
  'restoreArchitectureCache',
  'getCachedArchitecture',
  'getSessionNotes',
  'getSessionPlan',
  'getSessionUncertaintyFlags',
  'takeSnapshot',
  'restoreFromSnapshot',
] as const satisfies readonly (keyof IOrchestrator)[];

const CONSUMED_OPTIONAL_HOOKS = [
  'abortSession',
  'cleanupSession',
  'getFocusStore',
  'recordUserInteraction',
  'getSdkSessionId',
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
  it('documents the stable outer facade consumed by routes, session service, and CLI', () => {
    expect(ORCHESTRATOR_REQUIRED_HOOKS).toEqual([
      'on',
      'off',
      'emit',
      'removeAllListeners',
      'analyze',
      'reset',
    ]);
    expect(ORCHESTRATOR_OPTIONAL_HOOKS).toEqual([
      'abortSession',
      'cleanupSession',
      'getFocusStore',
      'recordUserInteraction',
      'getSdkSessionId',
      'restoreArchitectureCache',
      'getCachedArchitecture',
      'getSessionNotes',
      'getSessionPlan',
      'getSessionUncertaintyFlags',
      'takeSnapshot',
      'restoreFromSnapshot',
    ]);
  });

  it('keeps every currently consumed optional hook declared on IOrchestrator', () => {
    expect(CONSUMED_OPTIONAL_HOOKS).toEqual([
      'abortSession',
      'cleanupSession',
      'getFocusStore',
      'recordUserInteraction',
      'getSdkSessionId',
      'restoreArchitectureCache',
      'getCachedArchitecture',
      'getSessionNotes',
      'getSessionPlan',
      'getSessionUncertaintyFlags',
      'takeSnapshot',
      'restoreFromSnapshot',
    ]);
  });

  it('tracks source consumers for optional hooks on the route-facing facade', () => {
    for (const hook of CONSUMED_OPTIONAL_HOOKS) {
      expect(sourceMentionsHook(hook)).toBe(true);
    }
    expect(sourceMentionsHook('restoreSessionMapping')).toBe(false);
    expect(sourceMentionsHook('getProgressTracker')).toBe(false);
  });

  it('keeps the deleted analysis harness out of agentRuntime sources', () => {
    const agentRuntimeRoot = path.join(__dirname, '..');
    const implementationPath = path.join(agentRuntimeRoot, 'analysisHarness.ts');
    const testPath = path.join(agentRuntimeRoot, '__tests__/analysisHarness.test.ts');

    expect(fs.existsSync(implementationPath)).toBe(false);
    expect(fs.existsSync(testPath)).toBe(false);
  });
});
