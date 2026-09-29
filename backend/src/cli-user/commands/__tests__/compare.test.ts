// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import { runCompareCommand } from '../compare';

jest.mock('../../bootstrap', () => ({
  ...jest.requireActual('../../bootstrap'),
  bootstrap: jest.fn(() => ({ paths: { root: '/tmp/smp', sessions: '/tmp/smp/sessions' } })),
}));

jest.mock('../../services/runtimeGuard', () => ({
  assertAnalysisRuntimeReady: jest.fn(),
}));

const startSessionMock = jest.fn(async (_ctx: unknown, _input: unknown) => ({
  sessionId: 'agent-test',
  sessionDir: '/tmp/smp/sessions/agent-test',
  turn: 1,
  success: true,
  degraded: false,
}));

jest.mock('../../services/turnRunner', () => ({
  startSession: (ctx: unknown, input: unknown) => startSessionMock(ctx, input),
}));

const shutdownMock = jest.fn();
let emitConstructorDiagnostic = false;

jest.mock('../../services/cliAnalyzeService', () => ({
  CliAnalyzeService: jest.fn(() => {
    if (emitConstructorDiagnostic) {
      console.log('[ProviderManager] constructor diagnostic');
    }
    return { shutdown: shutdownMock };
  }),
}));

describe('runCompareCommand', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    emitConstructorDiagnostic = false;
  });

  test('passes the user query through without adding a CLI-private comparison prompt', async () => {
    const exitCode = await runCompareCommand({
      currentTrace: './current.trace',
      referenceTrace: './reference.trace',
      query: '  对比启动慢的原因  ',
      verbose: false,
      noColor: true,
      format: 'json',
    });

    expect(exitCode).toBe(0);
    expect(startSessionMock).toHaveBeenCalledTimes(1);
    const input = (startSessionMock.mock.calls[0] as [unknown, { query: string }])[1];
    expect(input.query).toBe('对比启动慢的原因');
    expect(input.query).not.toContain('SmartPerfetto CLI 深度对比契约');
    expect(input.query).not.toContain('get_comparison_context');
  });

  test('keeps service-construction diagnostics off machine-readable stdout', async () => {
    emitConstructorDiagnostic = true;
    const stdoutSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    const stderrSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const exitCode = await runCompareCommand({
        currentTrace: './current.trace',
        referenceTrace: './reference.trace',
        query: 'compare',
        verbose: false,
        noColor: true,
        format: 'json',
      });

      expect(exitCode).toBe(0);
      expect(stdoutSpy).not.toHaveBeenCalledWith('[ProviderManager] constructor diagnostic');
      expect(stderrSpy).toHaveBeenCalledWith('[ProviderManager] constructor diagnostic');
    } finally {
      stdoutSpy.mockRestore();
      stderrSpy.mockRestore();
    }
  });
});
