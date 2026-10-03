// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {afterEach, beforeEach, describe, expect, it} from '@jest/globals';

import type {CaseNode} from '../../../types/sparkContracts';
import {curatedCaseNode, writeCaseFileWithoutAttestations} from '../../../../tests/helpers/caseStoreFixture';
import {CaseLibrary} from '../../caseLibrary';
import {caseCurationGrantForMarkdownIngest} from '../../security/caseCuration';
import {recallCasesByTags} from '../caseTagRecall';

const curator = caseCurationGrantForMarkdownIngest();

let tmpDir: string;
let libraryPath: string;
let library: CaseLibrary;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-case-tag-recall-'));
  libraryPath = path.join(tmpDir, 'case_library.json');
  library = new CaseLibrary(libraryPath);
});

afterEach(() => {
  fs.rmSync(tmpDir, {recursive: true, force: true});
});

function addPublished(record: CaseNode): void {
  library.saveCase({...record, status: 'reviewed'}, curator);
  library.publishCase(record.caseId, {reviewer: 'perf-team'}, curator);
}

/** Case knowledge declaring `context`; a case learned before the contract declares no architecture. */
function withKnowledge(caseId: string, context: Record<string, unknown>): CaseNode {
  return curatedCaseNode(caseId, {
    knowledge: {
      sourceFile: `fixtures/${caseId}.md`,
      body: 'body',
      quality: 'curated',
      scene: 'scrolling',
      domainPack: 'scrolling.v1',
      taxonomy: {primary_root_cause: 'shader_compile', secondary_root_causes: [], responsibility: 'app', severity: 'warning'},
      context,
      evidenceSignatures: {required: [], supportive: []},
      recommendations: {app: [], oem: []},
    },
  });
}

describe('recallCasesByTags', () => {
  it('ranks admitted cases by the share of the requested tags they carry', () => {
    addPublished(curatedCaseNode('both', {tags: ['scrolling', 'shader_compile']}));
    addPublished(curatedCaseNode('one', {tags: ['scrolling']}));
    addPublished(curatedCaseNode('none', {tags: ['anr']}));

    expect(recallCasesByTags(library, {tags: ['scrolling', 'shader_compile'], architectureType: undefined}).map(hit => [hit.caseId, hit.score]))
      .toEqual([['both', 1], ['one', 0.5]]);
    expect(recallCasesByTags(library, {tags: [], architectureType: undefined})).toEqual([]);
  });

  it('recalls reviewed cases only on request, published ones first', () => {
    addPublished(curatedCaseNode('published'));
    library.saveCase(curatedCaseNode('reviewed'), curator);

    expect(recallCasesByTags(library, {architectureType: undefined}).map(hit => [hit.caseId, hit.score])).toEqual([['published', 1]]);
    expect(recallCasesByTags(library, {includeReviewed: true, architectureType: undefined}).map(hit => [hit.caseId, hit.score]))
      .toEqual([['published', 1], ['reviewed', 0.5]]);
    expect(recallCasesByTags(library, {tags: ['scrolling'], includeReviewed: true, architectureType: undefined}).map(hit => hit.caseId))
      .toEqual(['published', 'reviewed']);
  });

  it('restricts to one App/Device/CUJ key and honors topK', () => {
    addPublished(curatedCaseNode('pixel', {key: {appId: 'com.example', deviceId: 'pixel', buildId: 'b1', cuj: 'scroll'}}));
    addPublished(curatedCaseNode('other', {key: {appId: 'com.example', deviceId: 'other', buildId: 'b1', cuj: 'scroll'}}));

    expect(recallCasesByTags(library, {deviceId: 'pixel', architectureType: undefined}).map(hit => hit.caseId)).toEqual(['pixel']);
    expect(recallCasesByTags(library, {appId: 'com.example', topK: 1, architectureType: undefined})).toHaveLength(1);
  });

  it('recalls only cases that apply to the trace architecture', () => {
    addPublished(withKnowledge('standard', {app_architecture: 'standard'}));
    addPublished(withKnowledge('flutter', {app_architecture: 'flutter'}));
    addPublished(withKnowledge('views-or-flutter', {app_architecture: ['standard', 'flutter']}));
    addPublished(withKnowledge('any', {app_architecture: 'any'}));
    addPublished(withKnowledge('predates-contract', {}));
    addPublished(curatedCaseNode('manual'));
    const recalled = (architectureType: string | undefined) =>
      recallCasesByTags(library, {tags: ['scrolling'], topK: 10, architectureType}).map(hit => hit.caseId).sort();

    expect(recalled('FLUTTER')).toEqual(['any', 'flutter', 'manual', 'views-or-flutter']);
    expect(recalled('STANDARD')).toEqual(['any', 'manual', 'standard', 'views-or-flutter']);
    const everyCase = ['any', 'flutter', 'manual', 'predates-contract', 'standard', 'views-or-flutter'];
    expect(recalled(undefined)).toEqual(everyCase);
    expect(recalled('UNKNOWN')).toEqual(everyCase);
  });

  it('never recalls a case analyses may not read', () => {
    writeCaseFileWithoutAttestations(libraryPath, curatedCaseNode('legacy', {status: 'published', curatedBy: 'someone'}));
    library.saveCase(curatedCaseNode('undeclared', {redactionState: 'raw'}), curator);
    library.saveCase(curatedCaseNode('draft', {status: 'draft'}), curator);

    expect(recallCasesByTags(library, {tags: ['scrolling'], includeReviewed: true, architectureType: undefined})).toEqual([]);
  });
});
