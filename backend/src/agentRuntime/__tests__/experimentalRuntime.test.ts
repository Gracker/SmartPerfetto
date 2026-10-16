// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import fs from 'fs';
import path from 'path';
import {
  EXPERIMENTAL_AGENT_RUNTIME_ENABLED_ENV,
  EXPERIMENTAL_AGENT_RUNTIME_ENV,
  EXPERIMENTAL_OPENCODE_RUNTIME_KIND,
  EXPERIMENTAL_PI_AGENT_CORE_RUNTIME_KIND,
  isExperimentalAgentRuntimeKind,
  listExperimentalRuntimeKinds,
  resolveExperimentalAgentRuntimeSelection,
} from '../experimentalRuntime';

describe('experimental runtime selection', () => {
  it('keeps hidden runtimes behind shared explicit experiment env vars', () => {
    expect(resolveExperimentalAgentRuntimeSelection({})).toBeUndefined();
    expect(() => resolveExperimentalAgentRuntimeSelection({
      [EXPERIMENTAL_AGENT_RUNTIME_ENV]: EXPERIMENTAL_PI_AGENT_CORE_RUNTIME_KIND,
    })).toThrow(
      `${EXPERIMENTAL_AGENT_RUNTIME_ENV} requires ${EXPERIMENTAL_AGENT_RUNTIME_ENABLED_ENV}=1`,
    );
    expect(() => resolveExperimentalAgentRuntimeSelection({
      [EXPERIMENTAL_AGENT_RUNTIME_ENABLED_ENV]: '1',
      [EXPERIMENTAL_AGENT_RUNTIME_ENV]: 'other-runtime',
    })).toThrow(`Unsupported ${EXPERIMENTAL_AGENT_RUNTIME_ENV}="other-runtime"`);
    expect(resolveExperimentalAgentRuntimeSelection({
      [EXPERIMENTAL_AGENT_RUNTIME_ENABLED_ENV]: '1',
      [EXPERIMENTAL_AGENT_RUNTIME_ENV]: EXPERIMENTAL_PI_AGENT_CORE_RUNTIME_KIND,
    })).toEqual({
      kind: EXPERIMENTAL_PI_AGENT_CORE_RUNTIME_KIND,
      source: 'env',
    });
    expect(resolveExperimentalAgentRuntimeSelection({
      [EXPERIMENTAL_AGENT_RUNTIME_ENABLED_ENV]: 'true',
      [EXPERIMENTAL_AGENT_RUNTIME_ENV]: EXPERIMENTAL_OPENCODE_RUNTIME_KIND,
    })).toEqual({
      kind: EXPERIMENTAL_OPENCODE_RUNTIME_KIND,
      source: 'env',
    });
  });

  it('reads the opt-in switch with the shared on/off spelling set', () => {
    for (const enabled of ['1', 'true', 'yes', 'on', 'enabled', ' ON ']) {
      expect(resolveExperimentalAgentRuntimeSelection({
        [EXPERIMENTAL_AGENT_RUNTIME_ENABLED_ENV]: enabled,
        [EXPERIMENTAL_AGENT_RUNTIME_ENV]: EXPERIMENTAL_PI_AGENT_CORE_RUNTIME_KIND,
      })).toEqual({kind: EXPERIMENTAL_PI_AGENT_CORE_RUNTIME_KIND, source: 'env'});
    }
    for (const disabled of ['0', 'false', 'no', 'off', 'disabled', 'maybe', '']) {
      expect(() => resolveExperimentalAgentRuntimeSelection({
        [EXPERIMENTAL_AGENT_RUNTIME_ENABLED_ENV]: disabled,
        [EXPERIMENTAL_AGENT_RUNTIME_ENV]: EXPERIMENTAL_PI_AGENT_CORE_RUNTIME_KIND,
      })).toThrow(`${EXPERIMENTAL_AGENT_RUNTIME_ENV} requires ${EXPERIMENTAL_AGENT_RUNTIME_ENABLED_ENV}=1`);
    }
  });

  it('derives experimental runtime predicates from the shared kind list', () => {
    expect(listExperimentalRuntimeKinds()).toEqual([
      EXPERIMENTAL_PI_AGENT_CORE_RUNTIME_KIND,
      EXPERIMENTAL_OPENCODE_RUNTIME_KIND,
    ]);
    expect(isExperimentalAgentRuntimeKind(EXPERIMENTAL_PI_AGENT_CORE_RUNTIME_KIND)).toBe(true);
    expect(isExperimentalAgentRuntimeKind(EXPERIMENTAL_OPENCODE_RUNTIME_KIND)).toBe(true);
    expect(isExperimentalAgentRuntimeKind('pi-agent-core')).toBe(false);
  });
});

describe('experimental runtime import boundaries', () => {
  const srcRoot = path.resolve(__dirname, '..');

  function readSource(relativePath: string): string {
    return fs.readFileSync(path.join(srcRoot, relativePath), 'utf8');
  }

  function staticImports(source: string): string[] {
    return Array.from(source.matchAll(/^\s*import(?:\s+type)?[\s\S]*?\sfrom\s+['"]([^'"]+)['"];?/gm))
      .map(match => match[1]);
  }

  it('keeps selection and experimental kind parsing out of concrete runtime modules', () => {
    expect(staticImports(readSource('runtimeSelection.ts'))).not.toEqual(
      expect.arrayContaining([
        './engines/pi/piAgentCoreRuntime',
        './engines/opencode/openCodeRuntime',
      ]),
    );
    expect(staticImports(readSource('experimentalRuntime.ts'))).not.toEqual(
      expect.arrayContaining([
        './engines/pi/piAgentCoreRuntime',
        './engines/opencode/openCodeRuntime',
        './runtimeSelection',
      ]),
    );
    expect(staticImports(readSource(path.join('engines', 'pi', 'piAgentCoreRuntime.ts'))))
      .not.toContain('../opencode/openCodeRuntime');
  });

  it('keeps experimental runtime factories lazily loaded from the registry', () => {
    const registrySource = readSource('runtimeRegistry.ts');
    expect(staticImports(registrySource)).not.toEqual(
      expect.arrayContaining([
        './engines/pi/piAgentCoreRuntime',
        './engines/opencode/openCodeRuntime',
      ]),
    );
    expect(registrySource).toContain("require('./engines/pi/piAgentCoreRuntime')");
    expect(registrySource).toContain("require('./engines/opencode/openCodeRuntime')");
  });

  it('loads concrete runtime implementations from engine directories', () => {
    const descriptorsSource = readSource('runtimeDescriptors.ts');
    const diagnosticsSource = readSource('runtimeDiagnostics.ts');

    expect(descriptorsSource).toContain("require('./engines/claude')");
    expect(descriptorsSource).toContain("require('./engines/claude/claudeConfig')");
    expect(descriptorsSource).toContain("require('./engines/openai')");
    expect(descriptorsSource).toContain("require('./engines/openai/openAiConfig')");
    expect(descriptorsSource).toContain("require('./engines/pi/piAgentCoreRuntime')");
    expect(descriptorsSource).toContain("require('./engines/opencode/openCodeRuntime')");
    expect(diagnosticsSource).toContain("require('./engines/pi/piAgentCoreRuntime')");
    expect(diagnosticsSource).toContain("require('./engines/opencode/openCodeRuntime')");
    expect(descriptorsSource).not.toContain("require('../agentv3')");
    expect(descriptorsSource).not.toContain("require('../agentOpenAI')");
    expect(descriptorsSource).not.toContain("require('./piAgentCoreRuntime')");
    expect(descriptorsSource).not.toContain("require('./openCodeRuntime')");
  });
});
