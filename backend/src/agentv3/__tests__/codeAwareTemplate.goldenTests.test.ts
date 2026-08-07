// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {describe, expect, it} from '@jest/globals';

import {loadPromptTemplate, renderTemplate} from '../strategyLoader';

describe('code-aware.template golden rules', () => {
  const rendered = renderTemplate(loadPromptTemplate('code-aware') ?? '', {
    codeAwareMode: 'metadata_only',
    codebaseIds: 'cb_app, cb_kernel',
  });

  it('locks the source lookup order and domain split', () => {
    expect(rendered).toContain('search_codebase');
    expect(rendered).toContain('不要求预先建立索引');
    expect(rendered).toContain('read_codebase_file');
    expect(rendered).toContain('resolve_symbol');
    expect(rendered).toContain('lookup_app_source');
    expect(rendered).toContain('lookup_aosp_source');
    expect(rendered).toContain('lookup_kernel_source');
    expect(rendered).toContain('referenceId` 不授予 patch 能力');
  });

  it('locks degraded and metadata-only output discipline', () => {
    expect(rendered).toContain('metadata_only');
    expect(rendered).toContain('provider_send_disabled_for_session');
    expect(rendered).toContain('symbol_only_low_confidence');
    expect(rendered).toContain('不能生成 patch');
  });

  it('requires successful source lookups to remain locatable in the final report', () => {
    const contract = loadPromptTemplate('prompt-code-reference-contract-zh') ?? '';
    expect(contract).toContain('成功返回源码 CodeRef');
    expect(contract).toContain('search_codebase');
    expect(contract).toContain('read_codebase_file');
    expect(contract).toContain('referenceId');
    expect(contract).toContain('relative/path/File.kt:L10-L20');
    expect(contract).toContain('不能只写文件名');
    expect(contract).toContain('不得编造行号');
  });

  it('locks patchStatus output discipline', () => {
    expect(rendered).toContain('patchStatus="verified"');
    expect(rendered).toContain('patchStatus="sketch"');
    expect(rendered).toContain('patchStatus="unverified"');
    expect(rendered).toContain('不能输出 unified diff');
    expect(rendered).toContain('multi_codebase_not_supported_phase1');
  });

  it('keeps legacy Plan 44/54/55 recall out of code evidence', () => {
    expect(rendered).toContain('recall_project_memory');
    expect(rendered).toContain('recall_similar_case');
    expect(rendered).toContain('legacy `lookup_blog_knowledge`');
    expect(rendered).toContain('不等同于用户代码证据');
  });
});
