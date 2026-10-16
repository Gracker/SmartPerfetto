// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';

const backendRoot = path.resolve(__dirname, '../../..');
const glmE2E = require(path.join(backendRoot, 'scripts/run-glm-agent-e2e.cjs')) as {
  buildChildEnv(
    apiKey: string,
    runtimeKind: string,
    isolatedRoot: string,
  ): Record<string, string | undefined>;
};

describe('Qoder BYOK tooling', () => {
  it('documents Qoder as an explicit GLM Coding Plan E2E runtime', () => {
    const result = spawnSync(
      process.execPath,
      [path.join(backendRoot, 'scripts/run-glm-agent-e2e.cjs'), '--help'],
      {cwd: backendRoot, encoding: 'utf8'},
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('qoder-agent-sdk');
    expect(result.stdout).toContain('QODER_PERSONAL_ACCESS_TOKEN');
    expect(result.stdout).toContain('BYOK does not replace Qoder authentication');
  });

  it('maps GLM Coding Plan into Qoder BYOK without replacing Qoder authentication', () => {
    const keys = [
      'QODER_PERSONAL_ACCESS_TOKEN',
      'GLM_BASE_URL',
      'GLM_MODEL',
      'GLM_LIGHT_MODEL',
    ] as const;
    const original = Object.fromEntries(keys.map(key => [key, process.env[key]]));
    process.env.QODER_PERSONAL_ACCESS_TOKEN = 'qoder-auth-secret';
    delete process.env.GLM_BASE_URL;
    delete process.env.GLM_MODEL;
    delete process.env.GLM_LIGHT_MODEL;
    try {
      const env = glmE2E.buildChildEnv(
        'glm-test-provider-key',
        'qoder-agent-sdk',
        '/tmp/qoder-e2e-test',
      );

      expect(env).toMatchObject({
        SMARTPERFETTO_AGENT_RUNTIME: 'qoder-agent-sdk',
        QODER_PERSONAL_ACCESS_TOKEN: 'qoder-auth-secret',
        QODER_MODEL: 'glm-5.3',
        QODER_LIGHT_MODEL: 'glm-5.3-flash',
        QODER_BYOK_API_KEY: 'glm-test-provider-key',
        QODER_BYOK_PROVIDER: 'glm',
        QODER_BYOK_BASE_URL: 'https://open.bigmodel.cn/api/coding/paas/v4',
        QODER_BYOK_STYLE: 'openai',
      });
      expect(env.QODER_PERSONAL_ACCESS_TOKEN).not.toBe(env.QODER_BYOK_API_KEY);
    } finally {
      for (const key of keys) {
        const value = original[key];
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  it('provides an opt-in installer that requires explicit terms acceptance', () => {
    const packageJson = JSON.parse(
      fs.readFileSync(path.join(backendRoot, 'package.json'), 'utf8'),
    ) as {scripts?: Record<string, string>};
    expect(packageJson.scripts?.['qoder:install']).toBe('node scripts/install-qoder-sdk.cjs');

    const result = spawnSync(
      process.execPath,
      [path.join(backendRoot, 'scripts/install-qoder-sdk.cjs'), '--help'],
      {cwd: backendRoot, encoding: 'utf8'},
    );
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('--accept-terms');
    expect(result.stdout).toContain('backend/.qoder-sdk');
  });
});
