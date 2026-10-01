// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import * as fs from 'fs';
import * as path from 'path';
import {describe, expect, it, jest} from '@jest/globals';

const sdkQuery = jest.fn((params: unknown) => params);
jest.mock('@anthropic-ai/claude-agent-sdk', () => ({query: (params: unknown) => sdkQuery(params)}));

import {claudeSdkQuery} from '../engines/claude/claudeSdkQuery';

const SRC_ROOT = path.resolve(__dirname, '../..');
const WRAPPER = path.join(SRC_ROOT, 'agentRuntime/engines/claude/claudeSdkQuery.ts');
const SDK = String.raw`['"]@anthropic-ai/claude-agent-sdk['"]`;
// A value import of `query`, a namespace import, or a runtime load of the SDK
// module: any of them reaches `query` without the wrapper.
const DIRECT_QUERY_ACCESS = [
  new RegExp(String.raw`import\s+(?!type\b)\{[^}]*(?<![\w$])(?<!type\s)query\b[^}]*\}\s*from\s*${SDK}`),
  new RegExp(String.raw`import\s+\*\s+as\s+\w+\s+from\s*${SDK}`),
  new RegExp(String.raw`(?:import|require)\(\s*${SDK}\s*\)`),
];

function productionSources(dir: string): string[] {
  return fs.readdirSync(dir, {withFileTypes: true}).flatMap(entry => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === '__tests__' ? [] : productionSources(full);
    return /\.tsx?$/.test(entry.name) && !entry.name.endsWith('.d.ts') ? [full] : [];
  });
}

describe('claudeSdkQuery', () => {
  it('forces session persistence off whatever the caller passes', () => {
    claudeSdkQuery({prompt: 'p', options: {model: 'm', maxTurns: 3, persistSession: true}});
    claudeSdkQuery({prompt: 'q'});

    expect(sdkQuery).toHaveBeenNthCalledWith(1, {prompt: 'p', options: {model: 'm', maxTurns: 3, persistSession: false}});
    expect(sdkQuery).toHaveBeenNthCalledWith(2, {prompt: 'q', options: {persistSession: false}});
  });

  it('is the only production path to the SDK query', () => {
    const offenders = productionSources(SRC_ROOT)
      .filter(file => file !== WRAPPER)
      .filter(file => {
        const source = fs.readFileSync(file, 'utf8');
        return DIRECT_QUERY_ACCESS.some(pattern => pattern.test(source));
      })
      .map(file => path.relative(SRC_ROOT, file));

    expect(offenders).toEqual([]);
  });

  it('recognises every direct access form it is meant to reject', () => {
    const accesses = [
      "import {query} from '@anthropic-ai/claude-agent-sdk';",
      "import { SYSTEM_PROMPT_DYNAMIC_BOUNDARY,\n  query as sdkQuery } from \"@anthropic-ai/claude-agent-sdk\";",
      "import {type Options, query} from '@anthropic-ai/claude-agent-sdk';",
      "import * as sdk from '@anthropic-ai/claude-agent-sdk';",
      "const sdk = await import('@anthropic-ai/claude-agent-sdk');",
    ];
    const allowed = [
      "import type {Options, query} from '@anthropic-ai/claude-agent-sdk';",
      "import {type query, tool} from '@anthropic-ai/claude-agent-sdk';",
      "import {createSdkMcpServer} from '@anthropic-ai/claude-agent-sdk';",
      "import {queryHelper} from '@anthropic-ai/claude-agent-sdk';",
    ];
    for (const source of accesses) expect(DIRECT_QUERY_ACCESS.some(p => p.test(source))).toBe(true);
    for (const source of allowed) expect(DIRECT_QUERY_ACCESS.some(p => p.test(source))).toBe(false);
  });
});
