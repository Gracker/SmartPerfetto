// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {afterEach, beforeEach, describe, expect, it, jest} from '@jest/globals';

import {ingestCaseKnowledge} from '../caseIngester';
import {CaseGraph} from '../caseGraph';
import {CaseLibrary} from '../caseLibrary';
import {RagStore} from '../ragStore';
import {caseCurationGrantForMarkdownIngest} from '../security/caseCuration';
import {writeCaseFileWithoutAttestations} from '../../../tests/helpers/caseStoreFixture';

const curator = caseCurationGrantForMarkdownIngest();

let tmpDir: string;
let casesDir: string;
let caseLibraryPath: string;
let caseGraphPath: string;
let ragStorePath: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'case-ingester-test-'));
  casesDir = path.join(tmpDir, 'cases');
  caseLibraryPath = path.join(tmpDir, 'case_library.json');
  caseGraphPath = path.join(tmpDir, 'case_graph.json');
  ragStorePath = path.join(tmpDir, 'rag_store.json');
  fs.mkdirSync(casesDir, {recursive: true});
});

afterEach(() => {
  if (fs.existsSync(tmpDir)) {
    fs.rmSync(tmpDir, {recursive: true, force: true});
  }
});

function writeCase(fileName: string, content: string): string {
  const filePath = path.join(casesDir, fileName);
  fs.writeFileSync(filePath, content, 'utf-8');
  return filePath;
}

function caseMarkdown(input: {
  caseId: string;
  title?: string;
  status?: 'reviewed' | 'published';
  curator?: string;
  similarRootCause?: string[];
  reasonCode?: string;
  contextLines?: string;
}): string {
  const title = input.title ?? `Case ${input.caseId}`;
  const status = input.status ?? 'reviewed';
  const curatorLine = input.curator === undefined ? 'curator: perf-team\n' : input.curator ? `curator: ${input.curator}\n` : '';
  const reasonCode = input.reasonCode ?? 'shader_compile';
  const similarRootCause = input.similarRootCause ?? [];
  return `---
case_id: ${input.caseId}
title: ${title}
status: ${status}
quality: curated
scene: scrolling
domain_pack: scrolling.v1
${curatorLine}tags: [scrolling, ${reasonCode}]
taxonomy:
  primary_root_cause: ${reasonCode}
  secondary_root_causes: [render_thread_heavy]
  responsibility: mixed
  severity: critical
context:
  app_architecture: android_view_standard
  device_vendor: pixel
  os_version: Android 15
  refresh_rate_hz: 120
  workload: list_scroll
${input.contextLines ?? ''}evidence_signatures:
  required:
    - field: reason_code
      op: eq
      value: ${reasonCode}
  supportive:
    - field: jank_responsibility
      op: eq
      value: APP
findings:
  - id: f1
    title: ${title} finding
    evidence_refs: []
    confidence: high
recommendations:
  app:
    - id: app_precompile_shader
      priority: P0
      action: Precompile or warm up shaders before the first scroll.
      applies_when: Shader compilation slices overlap dropped-frame windows.
      risks: Warmup can move CPU and memory cost earlier in the flow.
  oem:
    - id: oem_sched_freq_check
      priority: P1
      action: Inspect scheduling and frequency response during the same window.
      applies_when: App-side work overlaps low frequency or scheduling delay.
      risks: Boost policy can increase power.
relations:
  similar_root_cause: [${similarRootCause.join(', ')}]
  same_app: []
  same_device: []
  before_after_fix: []
  derived_pattern: []
  contradicts: []
---

## Summary

${title} body.
`;
}

function ingest() {
  return ingestCaseKnowledge({
    casesDir,
    grant: curator,
    caseLibraryPath,
    caseGraphPath,
    ragStorePath,
  });
}

describe('caseIngester', () => {
  it('writes CaseLibrary records, CaseGraph edges, and case_library RAG chunks', () => {
    writeCase(
      'a.md',
      caseMarkdown({
        caseId: 'scroll_shader_compile_pixel8_001',
        title: 'Shader compile during scroll',
        similarRootCause: ['scroll_shader_compile_followup_001'],
      }),
    );
    writeCase(
      'b.md',
      caseMarkdown({
        caseId: 'scroll_shader_compile_followup_001',
        title: 'Follow-up shader compile case',
      }),
    );

    const result = ingest();

    expect(result.caseCount).toBe(2);
    expect(result.edgeCount).toBe(1);
    expect(result.chunkCount).toBe(2);

    const library = new CaseLibrary(caseLibraryPath);
    const first = library.getCase('scroll_shader_compile_pixel8_001');
    expect(first?.knowledge?.domainPack).toBe('scrolling.v1');
    expect(first?.knowledge?.recommendations.app[0].id).toBe(
      'app_precompile_shader',
    );

    const graph = new CaseGraph(caseGraphPath, new CaseLibrary(caseLibraryPath));
    expect(graph.listEdges()).toEqual([
      expect.objectContaining({
        fromCaseId: 'scroll_shader_compile_pixel8_001',
        toCaseId: 'scroll_shader_compile_followup_001',
        relation: 'similar_root_cause',
      }),
    ]);

    const ragStore = new RagStore(ragStorePath);
    expect(ragStore.listChunks({kind: 'case_library'})).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          chunkId: 'case:scroll_shader_compile_pixel8_001:summary',
          kind: 'case_library',
          registryOrigin: 'plan54_cases',
          uri: 'case://scroll_shader_compile_pixel8_001',
        }),
      ]),
    );
  });

  it('full-rederives generated cases, graph edges, and RAG chunks from Markdown', () => {
    const secondFile = writeCase(
      'b.md',
      caseMarkdown({caseId: 'scroll_scheduler_followup_001'}),
    );
    writeCase(
      'a.md',
      caseMarkdown({
        caseId: 'scroll_scheduler_freq_mixed_001',
        title: 'Old title',
        similarRootCause: ['scroll_scheduler_followup_001'],
        reasonCode: 'sched_delay_in_slice',
      }),
    );
    ingest();

    fs.rmSync(secondFile);
    writeCase(
      'a.md',
      caseMarkdown({
        caseId: 'scroll_scheduler_freq_mixed_001',
        title: 'New title',
        similarRootCause: [],
        reasonCode: 'sched_delay_in_slice',
      }),
    );

    const result = ingest();

    expect(result.caseCount).toBe(1);
    const library = new CaseLibrary(caseLibraryPath);
    expect(library.listCases().map(c => c.caseId)).toEqual([
      'scroll_scheduler_freq_mixed_001',
    ]);
    expect(library.getCase('scroll_scheduler_freq_mixed_001')?.title).toBe(
      'New title',
    );
    expect(new CaseGraph(caseGraphPath, new CaseLibrary(caseLibraryPath)).listEdges()).toEqual([]);
    expect(new RagStore(ragStorePath).listChunks({kind: 'case_library'})).toHaveLength(1);
  });

  it('rerun after a simulated mid-ingest crash converges all stores', () => {
    writeCase(
      'a.md',
      caseMarkdown({
        caseId: 'scroll_shader_compile_pixel8_001',
        similarRootCause: ['scroll_shader_compile_followup_001'],
      }),
    );
    writeCase(
      'b.md',
      caseMarkdown({caseId: 'scroll_shader_compile_followup_001'}),
    );

    expect(() =>
      ingestCaseKnowledge({
        casesDir,
        grant: curator,
        caseLibraryPath,
        caseGraphPath,
        ragStorePath,
        failAfterStore: 'caseLibrary',
      }),
    ).toThrow(/simulated/i);

    expect(new CaseLibrary(caseLibraryPath).listCases()).toHaveLength(2);
    expect(new CaseGraph(caseGraphPath, new CaseLibrary(caseLibraryPath)).listEdges()).toEqual([]);
    expect(new RagStore(ragStorePath).listChunks({kind: 'case_library'})).toEqual([]);

    const result = ingest();

    expect(result.caseCount).toBe(2);
    expect(new CaseLibrary(caseLibraryPath).listCases()).toHaveLength(2);
    expect(new CaseGraph(caseGraphPath, new CaseLibrary(caseLibraryPath)).listEdges()).toHaveLength(1);
    expect(new RagStore(ragStorePath).listChunks({kind: 'case_library'})).toHaveLength(2);
  });

  it('does not downgrade a runtime-promoted published case on re-ingest', () => {
    writeCase(
      'a.md',
      caseMarkdown({
        caseId: 'scroll_shader_compile_pixel8_001',
        status: 'reviewed',
      }),
    );
    ingest();

    const library = new CaseLibrary(caseLibraryPath);
    library.publishCase('scroll_shader_compile_pixel8_001', {reviewer: 'runtime-curator'}, curator);

    const result = ingest();

    const stored = new CaseLibrary(caseLibraryPath).getCase(
      'scroll_shader_compile_pixel8_001',
    );
    expect(stored?.status).toBe('published');
    expect(stored?.curatedBy).toBe('runtime-curator');
    expect(result.warnings.join('\n')).toMatch(/preserved.*published/i);
  });

  it('does not keep a curation for Markdown content that changed since', () => {
    const caseId = 'scroll_shader_compile_pixel8_001';
    writeCase('a.md', caseMarkdown({caseId, status: 'reviewed'}));
    ingest();
    new CaseLibrary(caseLibraryPath).publishCase(caseId, {reviewer: 'runtime-curator'}, curator);

    writeCase('a.md', caseMarkdown({caseId, status: 'reviewed', title: 'Edited after the review'}));
    const result = ingest();

    const stored = new CaseLibrary(caseLibraryPath).getCaseForCuration(caseId);
    expect(stored).toMatchObject({status: 'reviewed', curatedBy: 'perf-team', analysisAdmitted: true});
    expect(result.warnings.join('\n')).toMatch(/did not keep the published status.*content changed since/);
  });

  it('sees a change under an own __proto__ key in the Markdown context', () => {
    const caseId = 'scroll_shader_compile_pixel8_001';
    const withNote = (note: string) => caseMarkdown({caseId, status: 'reviewed', contextLines: `  __proto__:\n    note: ${note}\n`});
    writeCase('a.md', withNote('measured'));
    ingest();
    new CaseLibrary(caseLibraryPath).publishCase(caseId, {reviewer: 'runtime-curator'}, curator);

    writeCase('a.md', withNote('edited'));
    const result = ingest();

    expect(new CaseLibrary(caseLibraryPath).getCase(caseId)?.status).toBe('reviewed');
    expect(result.warnings.join('\n')).toMatch(/content changed since/);
  });

  it('keeps an attested API curation when only the Markdown curator line is removed', () => {
    const caseId = 'scroll_shader_compile_pixel8_001';
    writeCase('a.md', caseMarkdown({caseId, status: 'reviewed'}));
    ingest();
    new CaseLibrary(caseLibraryPath).publishCase(caseId, {reviewer: 'runtime-curator'}, curator);

    writeCase('a.md', caseMarkdown({caseId, status: 'reviewed', curator: ''}));
    ingest();

    expect(new CaseLibrary(caseLibraryPath).getCaseForCuration(caseId)).toMatchObject({
      status: 'published',
      curatedBy: 'runtime-curator',
      redactionState: 'redacted',
      analysisAdmitted: true,
    });
  });

  it('does not keep a raised status nobody attested, such as one written before attestations', () => {
    const caseId = 'scroll_shader_compile_pixel8_001';
    writeCase('a.md', caseMarkdown({caseId, status: 'reviewed', curator: ''}));
    ingest();
    // A signed-in user raised it through the old API, which wrote whatever the body said.
    const raised = {...new CaseLibrary(caseLibraryPath).getCase(caseId)!, status: 'published' as const,
      redactionState: 'redacted' as const, curatedBy: 'any-user'};
    writeCaseFileWithoutAttestations(caseLibraryPath, raised);

    const result = ingest();

    const stored = new CaseLibrary(caseLibraryPath).getCaseForCuration(caseId);
    expect(stored).toMatchObject({status: 'reviewed', redactionState: 'raw', analysisAdmitted: false});
    expect(stored?.curatedBy).toBeUndefined();
    expect(result.warnings.join('\n')).toMatch(/did not keep the published status.*no curator attested it/);
  });

  it.each(['reviewed', 'published'] as const)(
    'dates a %s curation from the import that brought its current content', status => {
      const caseId = 'scroll_shader_compile_pixel8_001';
      const now = jest.spyOn(Date, 'now').mockReturnValue(1_000);
      try {
        writeCase('a.md', caseMarkdown({caseId, status}));
        ingest();
        now.mockReturnValue(2_000);
        ingest();
        expect(new CaseLibrary(caseLibraryPath).getCase(caseId)?.curatedAt).toBe(1_000);

        now.mockReturnValue(3_000);
        writeCase('a.md', caseMarkdown({caseId, status, title: 'Edited after the review'}));
        ingest();
        expect(new CaseLibrary(caseLibraryPath).getCase(caseId)?.curatedAt).toBe(3_000);
      } finally {
        now.mockRestore();
      }
    });

  it('lets analyses read an imported case only when it names a curator', () => {
    writeCase('a.md', caseMarkdown({caseId: 'case_with_curator'}));
    writeCase('b.md', caseMarkdown({caseId: 'case_without_curator', curator: ''}));
    ingest();

    expect(new CaseLibrary(caseLibraryPath).listAdmittedCases().map(c => c.caseId))
      .toEqual(['case_with_curator']);
  });

  it('makes a case imported before attestations readable once imported again', () => {
    writeCase('a.md', caseMarkdown({caseId: 'case_a'}));
    ingest();
    writeCaseFileWithoutAttestations(caseLibraryPath);
    expect(new CaseLibrary(caseLibraryPath).listAdmittedCases()).toEqual([]);

    ingest();

    expect(new CaseLibrary(caseLibraryPath).listAdmittedCases().map(c => c.caseId)).toEqual(['case_a']);
  });
});
