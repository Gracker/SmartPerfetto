// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {describe, expect, it} from '@jest/globals';

import {
  buildSourceSelectionIR,
  sourceSelectionAdmits,
  sourceSelectionGitPathspecs,
  sourceSelectionRipgrepArguments,
} from '../codebase/sourceSelectionPolicy';

describe('SourceSelectionPolicy', () => {
  it('uses kind-specific language sets and rejects hard-excluded paths', () => {
    const app = buildSourceSelectionIR({kind: 'app_source'});
    const kernel = buildSourceSelectionIR({kind: 'kernel_source'});

    expect(sourceSelectionAdmits(app, 'lib/main.dart')).toBe(true);
    expect(sourceSelectionAdmits(app, 'src/App.tsx')).toBe(true);
    expect(sourceSelectionAdmits(kernel, 'drivers/gpu/scheduler.c')).toBe(true);
    expect(sourceSelectionAdmits(kernel, 'lib/main.dart')).toBe(false);
    expect(sourceSelectionAdmits(app, '.repo/projects/secret/Main.kt')).toBe(false);
    expect(sourceSelectionAdmits(app, '.git/config.ts')).toBe(false);
    expect(sourceSelectionAdmits(app, 'certs/release.keystore')).toBe(false);
  });

  it('keeps every pre-policy source extension available for existing registrations', () => {
    for (const kind of ['app_source', 'aosp', 'kernel_source', 'oem_sdk'] as const) {
      const policy = buildSourceSelectionIR({kind});
      expect(sourceSelectionAdmits(policy, 'legacy/tool.go')).toBe(true);
      expect(sourceSelectionAdmits(policy, 'legacy/tool.py')).toBe(true);
    }
  });

  it('lets explicit prefixes override noise directories but never hard excludes', () => {
    const defaultPolicy = buildSourceSelectionIR({kind: 'app_source'});
    const explicitNoise = buildSourceSelectionIR({
      kind: 'app_source',
      includePrefixes: ['Pods/TracingKit'],
    });
    const explicitHard = buildSourceSelectionIR({
      kind: 'app_source',
      includePrefixes: ['.repo/projects'],
    });
    const explicitSecrets = buildSourceSelectionIR({
      kind: 'app_source',
      includePrefixes: ['secrets'],
    });
    const nestedNoise = buildSourceSelectionIR({
      kind: 'app_source',
      includePrefixes: ['packages/app/node_modules/lib'],
    });

    expect(sourceSelectionAdmits(defaultPolicy, 'Pods/TracingKit/Hook.mm')).toBe(false);
    expect(sourceSelectionAdmits(explicitNoise, 'Pods/TracingKit/Hook.mm')).toBe(true);
    expect(sourceSelectionAdmits(explicitHard, '.repo/projects/Hook.mm')).toBe(false);
    expect(sourceSelectionAdmits(explicitSecrets, 'secrets/credentials.properties')).toBe(false);
    expect(sourceSelectionAdmits(nestedNoise, 'packages/app/node_modules/lib/index.ts')).toBe(true);
    expect(sourceSelectionRipgrepArguments(nestedNoise)).not.toEqual(expect.arrayContaining([
      '--glob',
      '!**/node_modules/',
    ]));
  });

  it('normalizes prefixes, restricts glob syntax, and projects one canonical IR', () => {
    const policy = buildSourceSelectionIR({
      kind: 'aosp',
      includePrefixes: ['./frameworks/base/'],
      excludeGlobs: ['**/generated/**'],
    });

    expect(policy.includePrefixes).toEqual(['frameworks/base']);
    expect(sourceSelectionAdmits(policy, 'frameworks/base/core/Foo.java')).toBe(true);
    expect(sourceSelectionAdmits(policy, 'frameworks/base/generated/Foo.java')).toBe(false);
    expect(sourceSelectionAdmits(
      buildSourceSelectionIR({kind: 'aosp', excludeGlobs: ['**/generated/**']}),
      'generated/Foo.java',
    )).toBe(false);
    expect(sourceSelectionGitPathspecs(policy)).toEqual([':(literal)frameworks/base']);
    expect((sourceSelectionGitPathspecs as any)(policy, 'win32'))
      .toEqual([':(icase,literal)frameworks/base']);
    expect(sourceSelectionRipgrepArguments(policy)).toEqual(expect.arrayContaining([
      '--glob',
      '!**/.repo/',
      '--glob',
      '!**/generated/**',
    ]));
    expect(() => buildSourceSelectionIR({kind: 'aosp', excludeGlobs: ['!secret/**']}))
      .toThrow('source_exclude_glob_invalid');
    expect(() => buildSourceSelectionIR({kind: 'aosp', excludeGlobs: ['[ab]/**']}))
      .toThrow('source_exclude_glob_invalid');
  });

  it('projects include-ignored discovery without changing the canonical predicate', () => {
    const includeIgnored = buildSourceSelectionIR({
      kind: 'app_source',
      ignoreMode: 'include_ignored',
    });

    expect(sourceSelectionRipgrepArguments(includeIgnored)).toEqual(expect.arrayContaining([
      '--no-ignore',
    ]));
    expect(sourceSelectionAdmits(includeIgnored, 'src/Main.kt')).toBe(true);
  });

  it('matches adversarial wildcard sequences without catastrophic backtracking', () => {
    const policy = buildSourceSelectionIR({
      kind: 'app_source',
      excludeGlobs: [`${'*a'.repeat(24)}b.kt`],
    });

    expect(sourceSelectionAdmits(policy, `${'a'.repeat(80)}.kt`)).toBe(true);
  });
});
