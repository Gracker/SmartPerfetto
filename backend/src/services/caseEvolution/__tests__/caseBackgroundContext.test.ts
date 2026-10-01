// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';

import type { CaseNode } from '../../../types/sparkContracts';
import { CaseLibrary } from '../../caseLibrary';
import { buildCaseBackgroundContext } from '../caseBackgroundContext';
import { loadCaseEvolutionConfig } from '../caseEvolutionConfig';
import {caseCurationGrantForMarkdownIngest} from '../../security/caseCuration';
import {writeCaseFileWithoutAttestations} from '../../../../tests/helpers/caseStoreFixture';

const curator = caseCurationGrantForMarkdownIngest();

let tmpDir: string;
let library: CaseLibrary;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-case-background-'));
  library = new CaseLibrary(path.join(tmpDir, 'case_library.json'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function caseNode(caseId: string, status: CaseNode['status'], quality: 'curated' | 'imported'): CaseNode {
  return {
    schemaVersion: 1,
    source: 'curated_markdown_case',
    createdAt: 1,
    caseId,
    title: `${caseId} title`,
    status,
    redactionState: 'redacted',
    tags: ['scrolling', 'shader_compile'],
    findings: [{ id: 'finding-1', title: 'Shader compile overlaps jank', severity: 'warning' }],
    knowledge: {
      sourceFile: `fixtures/${caseId}.md`,
      body: 'body',
      quality,
      scene: 'scrolling',
      domainPack: 'scrolling.v1',
      taxonomy: {
        primary_root_cause: 'shader_compile',
        secondary_root_causes: [],
        responsibility: 'app',
        severity: 'warning',
      },
      context: { architectureType: 'android' },
      evidenceSignatures: {
        required: [{ field: 'reason_code', op: 'eq', value: 'shader_compile' }],
        supportive: [{ field: 'render_slices', op: 'contains_any', value: ['makePipeline'] }],
      },
      recommendations: {
        app: [{ id: 'app-1', priority: 'P1', action: 'Do not copy this into prompt', applies_when: 'shader_compile', risks: 'risk' }],
        oem: [],
      },
    },
  };
}

describe('buildCaseBackgroundContext', () => {
  it('returns undefined when prompt injection is off by default', () => {
    library.saveCase(caseNode('case-reviewed', 'reviewed', 'imported'), curator);

    expect(buildCaseBackgroundContext('scrolling', 'android', undefined, {
      library,
      config: loadCaseEvolutionConfig({}),
    })).toBeUndefined();
  });

  it('surfaces reviewed background cases without copying recommendation text', () => {
    library.saveCase(caseNode('case-reviewed', 'reviewed', 'imported'), curator);
    library.saveCase(caseNode('case-draft', 'draft', 'imported'), curator);

    const context = buildCaseBackgroundContext('scrolling', 'android', undefined, {
      library,
      config: loadCaseEvolutionConfig({
        CASE_EVOLUTION_RETRIEVE_ENABLED: '1',
        CASE_EVOLUTION_PROMPT_INJECT_ENABLED: '1',
      }),
    });

    expect(context).toContain('可能相关的历史案例');
    expect(context).toContain('case-reviewed');
    expect(context).not.toContain('case-draft');
    expect(context).not.toContain('Do not copy this into prompt');
  });

  it('renders an English-only context when English output is configured', () => {
    library.saveCase(caseNode('case-reviewed', 'reviewed', 'imported'), curator);

    const context = buildCaseBackgroundContext('scrolling', 'android', undefined, {
      library,
      config: loadCaseEvolutionConfig({
        CASE_EVOLUTION_RETRIEVE_ENABLED: '1',
        CASE_EVOLUTION_PROMPT_INJECT_ENABLED: '1',
      }),
      outputLanguage: 'en',
    });

    expect(context).toContain('Potentially Relevant Historical Cases');
    expect(context).toContain('Status: reviewed; root cause: shader_compile');
    expect(context).toContain('Key evidence conditions:');
    expect(context).not.toMatch(/可能相关|状态：|关键证据条件/);
  });

  it('injects only cases analyses may read: undeclared or unattested reviewed cases stay out', () => {
    writeCaseFileWithoutAttestations(path.join(tmpDir, 'case_library.json'), caseNode('case-legacy', 'reviewed', 'curated'));
    library.saveCase({...caseNode('case-raw', 'reviewed', 'curated'), redactionState: 'raw'}, curator);
    library.saveCase(caseNode('case-attested', 'reviewed', 'imported'), curator);

    const context = buildCaseBackgroundContext('scrolling', 'android', undefined, {
      library,
      config: loadCaseEvolutionConfig({
        CASE_EVOLUTION_RETRIEVE_ENABLED: '1',
        CASE_EVOLUTION_PROMPT_INJECT_ENABLED: '1',
      }),
    });

    expect(context).toContain('case-attested');
    expect(context).not.toContain('case-legacy');
    expect(context).not.toContain('case-raw');
  });

  it('never injects drafts: the retired draft switch is ignored', () => {
    library.saveCase(caseNode('case-draft', 'draft', 'curated'), curator);

    expect(buildCaseBackgroundContext('scrolling', 'android', undefined, {
      library,
      config: loadCaseEvolutionConfig({
        CASE_EVOLUTION_RETRIEVE_ENABLED: '1',
        CASE_EVOLUTION_PROMPT_INJECT_ENABLED: '1',
        CASE_EVOLUTION_INCLUDE_DRAFTS: '1',
      }),
    })).toBeUndefined();
  });

  it('silently drops the segment when it exceeds its dedicated prompt budget', () => {
    library.saveCase(caseNode('case-reviewed', 'reviewed', 'imported'), curator);

    expect(buildCaseBackgroundContext('scrolling', 'android', undefined, {
      library,
      config: loadCaseEvolutionConfig({
        CASE_EVOLUTION_RETRIEVE_ENABLED: '1',
        CASE_EVOLUTION_PROMPT_INJECT_ENABLED: '1',
      }),
      maxTokens: 10,
    })).toBeUndefined();
  });
});
