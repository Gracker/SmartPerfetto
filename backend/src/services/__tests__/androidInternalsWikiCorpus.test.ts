// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import * as fs from 'fs';
import * as os from 'os';
import * as childProcess from 'child_process';
import * as path from 'path';

import {afterEach, beforeEach, describe, expect, it} from '@jest/globals';

import {
  inspectAndroidInternalsWikiIdentity,
  scanAndroidInternalsWiki,
} from '../androidInternalsWiki/androidInternalsWikiCorpus';
import {auditAndroidInternalsWiki} from '../androidInternalsWiki/androidInternalsWikiAudit';
import * as wikiAuditModule from '../androidInternalsWiki/androidInternalsWikiAudit';
import {installGitFsmonitorCanary} from './gitFsmonitorCanary';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'android-internals-corpus-'));
  fs.mkdirSync(path.join(tmpDir, 'src', 'nested'), {recursive: true});
});

afterEach(() => {
  fs.rmSync(tmpDir, {recursive: true, force: true});
});

function write(relativePath: string, content: string): void {
  const target = path.join(tmpDir, relativePath);
  fs.mkdirSync(path.dirname(target), {recursive: true});
  fs.writeFileSync(target, content, 'utf8');
}

function article(title: string, status: string, tags: string[], body: string): string {
  return `---\ntitle: ${title}\nstatus: ${status}\nconfidence: high\ntags: [${tags.join(', ')}]\n---\n# ${title}\n${body}`;
}

describe('Android Internals Wiki corpus', () => {
  it('provides a dedicated corpus scanner', async () => {
    const modulePath = '../androidInternalsWiki/androidInternalsWikiCorpus';

    await expect(import(modulePath)).resolves.toHaveProperty('scanAndroidInternalsWiki');
  });

  it('caps actual article bytes even when accepted files grow after preview', () => {
    write('src/first.md', 'a');
    write('src/second.md', 'b');
    const acceptedPaths = ['src/first.md', 'src/second.md'];
    write('src/first.md', 'aaaa');
    write('src/second.md', 'bbbb');

    expect(() => scanAndroidInternalsWiki(tmpDir, acceptedPaths, {
      maxFileBytes: 16,
      maxTotalBytes: 5,
    })).toThrow('source_total_bytes_exceeded:5');
  });

  it('provides a dedicated article-by-article capability auditor', async () => {
    const modulePath = '../androidInternalsWiki/androidInternalsWikiAudit';

    await expect(import(modulePath)).resolves.toHaveProperty('auditAndroidInternalsWiki');
  });

  it('provides an operator CLI runner without executing on import', async () => {
    const modulePath = '../../scripts/auditAndroidInternalsWiki';

    await expect(import(modulePath)).resolves.toHaveProperty('runAndroidInternalsWikiAudit');
  });

  it('mirrors the wiki inventory rule and keeps malformed metadata visible', () => {
    write('src/a.md', '---\ntitle: A\nstatus: finalized\n---\n# A\nBody');
    write('src/nested/c.md', '---\ntitle: [broken\nstatus: finalized\n---\n# C\nBody');
    write('src/README.md', '---\ntitle: Readme\nstatus: finalized\n---\nignored');
    write('src/SUMMARY.md', '---\ntitle: Summary\nstatus: finalized\n---\nignored');
    write('src/no-frontmatter.md', '# No metadata');
    write('notes/outside.md', '---\ntitle: Outside\nstatus: finalized\n---\nignored');

    const result = (scanAndroidInternalsWiki as any)(tmpDir);

    expect(result.totalArticles).toBe(3);
    expect(result.articles.map((article: any) => article.relativePath)).toEqual([
      'src/a.md',
      'src/nested/c.md',
      'src/no-frontmatter.md',
    ]);
    expect(result.articles[0]).toEqual(expect.objectContaining({metadataValid: true}));
    expect(result.articles[1]).toEqual(expect.objectContaining({
      metadataValid: false,
      status: 'finalized',
    }));
    expect(result.articles[2]).toEqual(expect.objectContaining({
      metadataValid: false,
      metadataError: 'missing frontmatter',
    }));
  });

  it('marks a deleted tracked article with a Chinese path as dirty', () => {
    write('src/消息队列.md', article('消息队列', 'finalized', ['handler'], 'Body'));
    require('child_process').execFileSync('git', ['init', '-q', tmpDir]);
    require('child_process').execFileSync('git', ['-C', tmpDir, 'config', 'user.email', 'test@example.com']);
    require('child_process').execFileSync('git', ['-C', tmpDir, 'config', 'user.name', 'Test']);
    require('child_process').execFileSync('git', ['-C', tmpDir, 'add', '.']);
    require('child_process').execFileSync('git', ['-C', tmpDir, 'commit', '-qm', 'fixture']);
    fs.rmSync(path.join(tmpDir, 'src/消息队列.md'));

    const identity = inspectAndroidInternalsWikiIdentity(scanAndroidInternalsWiki(tmpDir));

    expect(identity.dirty).toBe(true);
    expect(identity.dirtyAcceptedArticlePaths).toEqual(['src/消息队列.md']);
  });

  it('records both sides of a tracked Chinese article rename', () => {
    write('src/消息队列.md', article('消息队列', 'finalized', ['handler'], 'Body'));
    require('child_process').execFileSync('git', ['init', '-q', tmpDir]);
    require('child_process').execFileSync('git', ['-C', tmpDir, 'config', 'user.email', 'test@example.com']);
    require('child_process').execFileSync('git', ['-C', tmpDir, 'config', 'user.name', 'Test']);
    require('child_process').execFileSync('git', ['-C', tmpDir, 'add', '.']);
    require('child_process').execFileSync('git', ['-C', tmpDir, 'commit', '-qm', 'fixture']);
    require('child_process').execFileSync('git', [
      '-C', tmpDir, 'mv', 'src/消息队列.md', 'src/消息循环.md',
    ]);

    const identity = inspectAndroidInternalsWikiIdentity(scanAndroidInternalsWiki(tmpDir));

    expect(identity.dirty).toBe(true);
    expect(identity.dirtyAcceptedArticlePaths).toEqual([
      'src/消息循环.md',
      'src/消息队列.md',
    ]);
  });

  it('accounts for every article without promoting lexical matches to validated coverage', () => {
    write('src/01-startup.md', article('应用启动', 'finalized', ['startup'], '启动阶段证据'));
    write('src/02-handler.md', article('Handler 消息分发', 'finalized', ['handler'], '回调执行切片'));
    write('src/03-boot.md', article('系统开机', 'finalized', ['boot'], '开机阶段'));
    write('src/04-explanation.md', article('Android 分层架构', 'finalized', ['architecture'], '架构知识'));
    write('src/05-non-perfetto.md', article('技术招聘指南', 'finalized', ['career'], '招聘内容'));
    write('src/06-duplicate.md', article('应用启动', 'finalized', ['startup'], '启动阶段证据'));
    write('src/07-broken.md', '---\ntitle: [broken\nstatus: finalized\n---\nBody');
    write('src/08-startup-candidate.md', article('启动优化建议', 'finalized', ['startup'], '解释优化方法'));
    write('src/09-startup-handler.md', article(
      '启动阶段 Handler 消息',
      'finalized',
      ['startup', 'handler'],
      '跨领域回调证据',
    ));
    write('src/10-application.md', article(
      'Application optimization',
      'finalized',
      ['architecture'],
      'Application lifecycle explanation',
    ));
    write('src/11-io.md', article(
      'IO scheduling',
      'finalized',
      ['io'],
      'IO latency explanation',
    ));
    write('src/12-gpu-mixed-script.md', article(
      'GPU工具链',
      'finalized',
      ['gpu'],
      'GPU rendering explanation',
    ));
    const corpus = scanAndroidInternalsWiki(tmpDir);
    const startupAssertion = 'backend/skills/public-fixtures.yaml#smart-launch-light-api36:startup_slow_reasons/startup_overview';
    const handlerAssertion = 'backend/skills/public-fixtures.yaml#smart-launch-heavy-api36:main_thread_handler_callback_slices/callback_slices';

    const report = (auditAndroidInternalsWiki as any)(corpus, {
      domains: [
        {
          id: 'startup',
          terms: ['启动', 'startup'],
          skillTags: ['startup'],
          validations: [{
            skillId: 'startup_slow_reasons',
            observableClaim: 'trace records an Android startup row',
            assertionRef: startupAssertion,
            articlePaths: ['src/01-startup.md'],
          }],
        },
        {
          id: 'handler',
          terms: ['handler', '消息'],
          skillTags: ['handler'],
          validations: [{
            skillId: 'main_thread_handler_callback_slices',
            observableClaim: 'trace records observed Handler callback execution',
            assertionRef: handlerAssertion,
            articlePaths: ['src/09-startup-handler.md'],
          }],
        },
        {id: 'system_boot', terms: ['开机', 'boot'], skillTags: ['system_boot'], deferWithoutFixture: true},
        {id: 'storage', terms: ['io'], skillTags: ['io']},
        {id: 'gpu', terms: ['gpu'], skillTags: ['gpu']},
      ],
      nonPerfettoTerms: ['招聘', 'career'],
    }, [
      {skillId: 'startup_slow_reasons', tags: ['startup'], triggers: []},
      {skillId: 'main_thread_handler_callback_slices', tags: ['handler'], triggers: []},
      {skillId: 'io_probe', tags: ['io'], triggers: []},
      {skillId: 'gpu_probe', tags: ['gpu'], triggers: []},
    ], new Set([startupAssertion, handlerAssertion]));

    expect(report.totalArticles).toBe(corpus.totalArticles);
    expect(report.rows).toHaveLength(corpus.totalArticles);
    expect(Object.fromEntries(report.rows.map((row: any) => [row.relativePath, row.disposition]))).toEqual({
      'src/01-startup.md': 'validated_trace_skill',
      'src/02-handler.md': 'candidate_skill_match',
      'src/03-boot.md': 'deferred_missing_schema_or_fixture',
      'src/04-explanation.md': 'explanation_only',
      'src/05-non-perfetto.md': 'non_perfetto',
      'src/06-duplicate.md': 'duplicate_or_superseded',
      'src/07-broken.md': 'metadata_error',
      'src/08-startup-candidate.md': 'candidate_skill_match',
      'src/09-startup-handler.md': 'candidate_skill_match',
      'src/10-application.md': 'explanation_only',
      'src/11-io.md': 'candidate_skill_match',
      'src/12-gpu-mixed-script.md': 'candidate_skill_match',
    });
    expect(report.rows[0]).toEqual(expect.objectContaining({
      observableClaim: 'trace records an Android startup row',
      validatedAssertionRefs: [startupAssertion],
    }));
    expect(report.rows.find((row: any) => row.relativePath === 'src/09-startup-handler.md'))
      .toEqual(expect.objectContaining({
        matchedDomainIds: ['startup', 'handler'],
        validatedDomainIds: ['handler'],
        unvalidatedDomainIds: ['startup'],
        candidateSkillIds: ['main_thread_handler_callback_slices', 'startup_slow_reasons'],
        observableClaim: 'trace records observed Handler callback execution',
        validatedAssertionRefs: [handlerAssertion],
      }));
    expect(report.rows.find((row: any) => row.relativePath === 'src/10-application.md'))
      .toEqual(expect.objectContaining({
        disposition: 'explanation_only',
      }));
    expect(report.rows.find((row: any) => row.relativePath === 'src/11-io.md'))
      .toEqual(expect.objectContaining({
        disposition: 'candidate_skill_match',
        matchedDomainIds: ['storage'],
      }));
    expect(report.rows.find((row: any) => row.relativePath === 'src/12-gpu-mixed-script.md'))
      .toEqual(expect.objectContaining({
        disposition: 'candidate_skill_match',
        matchedDomainIds: ['gpu'],
      }));
  });

  it('loads capability policy, live Skill metadata, and real assertion refs from source files', () => {
    write('capabilities.yaml', [
      'version: 1',
      'domains:',
      '  - id: startup',
      '    terms: [startup, 启动]',
      '    skill_tags: [startup]',
      '    validations:',
      '      - skill_id: startup_slow_reasons',
      '        observable_claim: startup row exists',
      '        assertion_ref: backend/skills/public-fixtures.yaml#fixture-a:startup_slow_reasons/startup_overview',
      '        article_paths: [src/01-startup.md]',
      'non_perfetto_terms: [career]',
    ].join('\n'));
    write('skills/startup.skill.yaml', [
      'name: startup_slow_reasons',
      'meta:',
      '  tags: [startup, launch]',
      'triggers:',
      '  keywords:',
      '    zh: [冷启动]',
      '    en: [cold start]',
    ].join('\n'));
    write('public-fixtures.yaml', [
      'schema_version: 1',
      'fixtures:',
      '  - id: fixture-a',
      '    assertions:',
      '      - query_id: startup_slow_reasons/startup_overview',
      '        kind: non_empty',
    ].join('\n'));
    const api = wikiAuditModule as any;

    const policy = api.loadWikiCapabilityMap(path.join(tmpDir, 'capabilities.yaml'));
    const skills = api.loadAuditableSkills(path.join(tmpDir, 'skills'));
    const assertions = api.loadValidatedAssertionRefs(path.join(tmpDir, 'public-fixtures.yaml'));

    expect(policy.domains[0]).toEqual(expect.objectContaining({
      id: 'startup',
      skillTags: ['startup'],
    }));
    expect(policy.domains[0].validations[0].articlePaths).toEqual(['src/01-startup.md']);
    expect(skills).toEqual([{
      skillId: 'startup_slow_reasons',
      tags: ['startup', 'launch'],
      triggers: ['冷启动', 'cold start'],
    }]);
    expect(assertions.has(
      'backend/skills/public-fixtures.yaml#fixture-a:startup_slow_reasons/startup_overview',
    )).toBe(true);
  });
});

describe('Android Internals Wiki identity subprocess', () => {
  it('does not execute repository-controlled core.fsmonitor while reading git identity', () => {
    if (process.platform === 'win32') return;
    write('src/a.md', article('A', 'finalized', ['binder'], 'body'));
    const git = (...args: string[]) => childProcess.execFileSync('git', args, {cwd: tmpDir});
    git('init', '-q');
    git('add', 'src/a.md');
    git('-c', 'user.name=SmartPerfetto Test', '-c', 'user.email=test@smartperfetto.local', 'commit', '-qm', 'fixture');
    const fsmonitor = installGitFsmonitorCanary(tmpDir);

    const identity = inspectAndroidInternalsWikiIdentity(scanAndroidInternalsWiki(tmpDir, ['src/a.md']));

    expect(identity.dirty).toBe(false);
    expect(fsmonitor.executed()).toBe(false);
  });
});
