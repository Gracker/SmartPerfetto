// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';

import type { CaseNode } from '../../../types/sparkContracts';
import { CaseLibrary } from '../../caseLibrary';
import { ingestCaseKnowledge } from '../../caseIngester';
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
      context: { app_architecture: 'standard' },
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

    expect(buildCaseBackgroundContext('scrolling', 'STANDARD', undefined, {
      library,
      config: loadCaseEvolutionConfig({}),
    })).toBeUndefined();
  });

  it('surfaces reviewed background cases without copying recommendation text', () => {
    library.saveCase(caseNode('case-reviewed', 'reviewed', 'imported'), curator);
    library.saveCase(caseNode('case-draft', 'draft', 'imported'), curator);

    const context = buildCaseBackgroundContext('scrolling', 'STANDARD', undefined, {
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

    const context = buildCaseBackgroundContext('scrolling', 'STANDARD', undefined, {
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

    const context = buildCaseBackgroundContext('scrolling', 'STANDARD', undefined, {
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

    expect(buildCaseBackgroundContext('scrolling', 'STANDARD', undefined, {
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

    expect(buildCaseBackgroundContext('scrolling', 'STANDARD', undefined, {
      library,
      config: loadCaseEvolutionConfig({
        CASE_EVOLUTION_RETRIEVE_ENABLED: '1',
        CASE_EVOLUTION_PROMPT_INJECT_ENABLED: '1',
      }),
      maxTokens: 10,
    })).toBeUndefined();
  });
});

describe('buildCaseBackgroundContext with curated Markdown cases', () => {
  const repoCasesDir = path.resolve(__dirname, '../../../../knowledge/cases');
  const injectionConfig = loadCaseEvolutionConfig({
    CASE_EVOLUTION_RETRIEVE_ENABLED: '1',
    CASE_EVOLUTION_PROMPT_INJECT_ENABLED: '1',
  });

  /** Ingest Markdown exactly as `npm run ingest:cases` does, into this test's stores. */
  function ingest(casesDir: string): void {
    ingestCaseKnowledge({
      casesDir,
      grant: curator,
      caseLibrary: library,
      caseGraphPath: path.join(tmpDir, 'case_graph.json'),
      ragStorePath: path.join(tmpDir, 'rag_store.json'),
    });
  }

  /** Copies of the repository's shader case under another id and architecture declaration. */
  function writeVariant(casesDir: string, caseId: string, appArchitecture: string): void {
    const source = fs.readFileSync(
      path.join(repoCasesDir, 'scrolling', 'scroll_shader_compile_pixel8_001.md'),
      'utf-8',
    );
    const variant = source
      .replace('case_id: scroll_shader_compile_pixel8_001', `case_id: ${caseId}`)
      .replace('  app_architecture: standard\n', `  app_architecture: ${appArchitecture}\n`);
    expect(variant).toContain(`app_architecture: ${appArchitecture}`);
    fs.mkdirSync(path.join(casesDir, 'scrolling'), { recursive: true });
    fs.writeFileSync(path.join(casesDir, 'scrolling', `${caseId}.md`), variant);
  }

  function background(architectureType: string | undefined): string | undefined {
    return buildCaseBackgroundContext('scrolling', architectureType, undefined, {
      library,
      config: injectionConfig,
      maxTokens: 10_000,
      topK: 10,
    });
  }

  it('keeps the repository View-system cases out of a Flutter analysis', () => {
    ingest(repoCasesDir);

    expect(background('FLUTTER')).toBeUndefined();
  });

  it('injects the repository View-system cases into a View-system analysis', () => {
    ingest(repoCasesDir);

    const context = background('STANDARD');

    expect(context).toContain('scroll_shader_compile_pixel8_001');
    expect(context).toContain('scroll_scheduler_freq_mixed_001');
  });

  it.each([undefined, 'unknown', 'UNKNOWN'])(
    'does not rule cases out when the trace architecture is %p',
    architectureType => {
      ingest(repoCasesDir);

      expect(background(architectureType)).toContain('scroll_shader_compile_pixel8_001');
    },
  );

  it('matches a declared architecture list and an explicit any', () => {
    const casesDir = path.join(tmpDir, 'cases');
    writeVariant(casesDir, 'scroll_view_or_compose_001', '[standard, compose]');
    writeVariant(casesDir, 'scroll_any_architecture_001', 'any');
    writeVariant(casesDir, 'scroll_flutter_only_001', 'flutter');
    ingest(casesDir);

    const compose = background('COMPOSE');
    expect(compose).toContain('scroll_view_or_compose_001');
    expect(compose).toContain('scroll_any_architecture_001');
    expect(compose).not.toContain('scroll_flutter_only_001');

    const flutter = background('FLUTTER');
    expect(flutter).toContain('scroll_flutter_only_001');
    expect(flutter).toContain('scroll_any_architecture_001');
    expect(flutter).not.toContain('scroll_view_or_compose_001');
  });

  it('does not inject a stored case whose architecture predates the contract', () => {
    ingest(repoCasesDir);
    const stored = library.getCase('scroll_scheduler_freq_mixed_001')!;
    library.saveCase({
      ...stored,
      knowledge: {
        ...stored.knowledge!,
        context: { ...stored.knowledge!.context, app_architecture: 'android_view_standard' },
      },
    }, curator);

    const context = background('STANDARD');

    expect(context).toContain('scroll_shader_compile_pixel8_001');
    expect(context).not.toContain('scroll_scheduler_freq_mixed_001');
  });
});
