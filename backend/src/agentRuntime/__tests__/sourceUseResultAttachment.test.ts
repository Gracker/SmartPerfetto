// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import fs from 'fs';
import path from 'path';

const RUNTIME_FILES = [
  'engines/claude/claudeRuntime.ts',
  'engines/openai/openAiRuntime.ts',
  'engines/pi/piAgentCoreRuntime.ts',
  'engines/opencode/openCodeRuntime.ts',
  'engines/qoder/qoderRuntime.ts',
] as const;

describe('runtime source-use result attachment', () => {
  test.each(RUNTIME_FILES)('%s attaches the actual accessor through the shared finalizer', relativePath => {
    const source = fs.readFileSync(path.join(__dirname, '..', relativePath), 'utf8');

    expect(source).toContain('attachSourceUseToAnalysisResult');
    expect(source).toMatch(/attachSourceUseToAnalysisResult\([^)]*sourceUse/s);
  });
});
