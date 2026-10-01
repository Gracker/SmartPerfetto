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

describe('recallCasesByTags', () => {
  it('ranks admitted cases by the share of the requested tags they carry', () => {
    addPublished(curatedCaseNode('both', {tags: ['scrolling', 'shader_compile']}));
    addPublished(curatedCaseNode('one', {tags: ['scrolling']}));
    addPublished(curatedCaseNode('none', {tags: ['anr']}));

    expect(recallCasesByTags(library, {tags: ['scrolling', 'shader_compile']}).map(hit => [hit.caseId, hit.score]))
      .toEqual([['both', 1], ['one', 0.5]]);
    expect(recallCasesByTags(library, {tags: []})).toEqual([]);
  });

  it('recalls reviewed cases only on request, published ones first', () => {
    addPublished(curatedCaseNode('published'));
    library.saveCase(curatedCaseNode('reviewed'), curator);

    expect(recallCasesByTags(library, {}).map(hit => [hit.caseId, hit.score])).toEqual([['published', 1]]);
    expect(recallCasesByTags(library, {includeReviewed: true}).map(hit => [hit.caseId, hit.score]))
      .toEqual([['published', 1], ['reviewed', 0.5]]);
    expect(recallCasesByTags(library, {tags: ['scrolling'], includeReviewed: true}).map(hit => hit.caseId))
      .toEqual(['published', 'reviewed']);
  });

  it('restricts to one App/Device/CUJ key and honors topK', () => {
    addPublished(curatedCaseNode('pixel', {key: {appId: 'com.example', deviceId: 'pixel', buildId: 'b1', cuj: 'scroll'}}));
    addPublished(curatedCaseNode('other', {key: {appId: 'com.example', deviceId: 'other', buildId: 'b1', cuj: 'scroll'}}));

    expect(recallCasesByTags(library, {deviceId: 'pixel'}).map(hit => hit.caseId)).toEqual(['pixel']);
    expect(recallCasesByTags(library, {appId: 'com.example', topK: 1})).toHaveLength(1);
  });

  it('never recalls a case analyses may not read', () => {
    writeCaseFileWithoutAttestations(libraryPath, curatedCaseNode('legacy', {status: 'published', curatedBy: 'someone'}));
    library.saveCase(curatedCaseNode('undeclared', {redactionState: 'raw'}), curator);
    library.saveCase(curatedCaseNode('draft', {status: 'draft'}), curator);

    expect(recallCasesByTags(library, {tags: ['scrolling'], includeReviewed: true})).toEqual([]);
  });
});
