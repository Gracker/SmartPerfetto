// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import { SkillExecutor } from '../skillExecutor';
import type { SkillDefinition } from '../types';

const resolverSkill: SkillDefinition = {
  name: 'process_identity_resolver',
  version: '1.0',
  type: 'atomic',
  meta: { display_name: 'Resolver', description: 'Resolver' },
  identity: { policy: 'exempt', scope: 'process' },
  inputs: [
    { name: 'package', type: 'string', required: false },
    { name: 'process_name', type: 'string', required: false },
    { name: 'thread_name', type: 'string', required: false },
    { name: 'upid', type: 'integer', required: false },
    { name: 'pid', type: 'integer', required: false },
    { name: 'max_rows', type: 'integer', required: false },
  ],
  sql: 'SELECT 1 AS resolver_probe',
};

const targetSkill: SkillDefinition = {
  name: 'target_process_skill',
  version: '1.0',
  type: 'atomic',
  meta: { display_name: 'Target', description: 'Target' },
  identity: {
    policy: 'required',
    scope: 'process',
    aliases: ['process_name', 'package'],
    rewriteTo: 'recommended_process_name_param',
  },
  inputs: [
    { name: 'process_name', type: 'string', required: true },
  ],
  sql: "SELECT '${process_name}' AS process_name",
};

const packageTargetSkill: SkillDefinition = {
  name: 'target_package_skill',
  version: '1.0',
  type: 'atomic',
  meta: { display_name: 'Target Package', description: 'Target Package' },
  identity: {
    policy: 'required',
    scope: 'process',
    aliases: ['process_name', 'package'],
    rewriteTo: 'recommended_process_name_param',
  },
  inputs: [
    { name: 'package', type: 'string', required: true },
  ],
  sql: "SELECT '${package}' AS package_name, '${process_name}' AS leaked_process_name",
};

const threadTargetSkill: SkillDefinition = {
  name: 'target_thread_skill',
  version: '1.0',
  type: 'atomic',
  meta: { display_name: 'Target Thread', description: 'Target Thread' },
  identity: {
    policy: 'required',
    scope: 'process',
    rewriteTo: 'upid',
  },
  inputs: [
    { name: 'thread_name', type: 'string', required: true },
  ],
  sql: "SELECT '${thread_name}' AS thread_name",
};

function createExecutor(query: jest.Mock): SkillExecutor {
  const executor = new SkillExecutor({ query });
  executor.registerSkills([resolverSkill, targetSkill, packageTargetSkill, threadTargetSkill]);
  return executor;
}

describe('SkillExecutor process identity gate', () => {
  it('runs resolver and rewrites process_name before executing required process skills', async () => {
    const query = jest.fn()
      .mockResolvedValueOnce({
        columns: ['rank', 'confidence_score', 'identity_status', 'canonical_package_name', 'recommended_process_name_param', 'upid', 'target_match_sources', 'supporting_sources', 'identity_warning'],
        rows: [[1, 90, 'confirmed', 'com.example', 'com.real.process', 42, 'android_process_metadata.package_name', 'frame_timeline.upid', 'ok']],
        durationMs: 1,
      })
      .mockResolvedValueOnce({
        columns: ['process_name'],
        rows: [['com.real.process']],
        durationMs: 1,
      });

    const result = await createExecutor(query).execute('target_process_skill', 'trace', {
      process_name: 'com.example',
    });

    expect(result.success).toBe(true);
    expect(query).toHaveBeenCalledTimes(2);
    expect(query.mock.calls[1][1]).toContain("SELECT 'com.real.process' AS process_name");
  });

  it('does not leak undeclared process aliases into skill parameter validation', async () => {
    const query = jest.fn()
      .mockResolvedValueOnce({
        columns: ['rank', 'confidence_score', 'identity_status', 'canonical_package_name', 'recommended_process_name_param', 'upid', 'target_match_sources', 'supporting_sources', 'identity_warning'],
        rows: [[1, 90, 'confirmed', 'com.example', 'com.real.process', 42, 'android_process_metadata.package_name', 'frame_timeline.upid', 'ok']],
        durationMs: 1,
      })
      .mockResolvedValueOnce({
        columns: ['package_name', 'leaked_process_name'],
        rows: [['com.real.process', '']],
        durationMs: 1,
      });

    const result = await createExecutor(query).execute('target_package_skill', 'trace', {
      process_name: 'com.example',
    });

    expect(result.success).toBe(true);
    expect(query).toHaveBeenCalledTimes(2);
    expect(query.mock.calls[1][1]).toContain("SELECT 'com.real.process' AS package_name, '' AS leaked_process_name");
  });

  it('consumes an UPID identity selector before target Skill input validation', async () => {
    const query = jest.fn()
      .mockResolvedValueOnce({
        columns: ['rank', 'confidence_score', 'identity_status', 'canonical_package_name', 'recommended_process_name_param', 'upid', 'target_match_sources', 'supporting_sources', 'identity_warning'],
        rows: [[1, 100, 'confirmed', 'com.example', 'com.example', 42, 'upid,process.name', 'frame_timeline.upid', 'ok']],
        durationMs: 1,
      })
      .mockResolvedValueOnce({
        columns: ['process_name'],
        rows: [['com.example']],
        durationMs: 1,
      });

    const result = await createExecutor(query).execute('target_process_skill', 'trace', {
      process_name: 'com.example',
      upid: 42,
    });

    expect(result.success).toBe(true);
    expect(query).toHaveBeenCalledTimes(2);
    expect(query.mock.calls[1][1]).toContain("SELECT 'com.example' AS process_name");
    expect(query.mock.calls[1][1]).not.toContain('upid');
  });

  it('blocks required process skills when resolver returns only weak identity evidence', async () => {
    const query = jest.fn().mockResolvedValueOnce({
      columns: ['rank', 'confidence_score', 'identity_status', 'canonical_package_name', 'recommended_process_name_param', 'upid', 'target_match_sources', 'supporting_sources', 'identity_warning'],
      rows: [[1, 20, 'weak_match', 'com.example', 'com.uncertain', 42, 'thread.name', '', 'shared UID']],
      durationMs: 1,
    });

    const result = await createExecutor(query).execute('target_process_skill', 'trace', {
      process_name: 'com.example',
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('could not be verified');
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('blocks required process skills when resolver returns only a probable identity match', async () => {
    const query = jest.fn().mockResolvedValueOnce({
      columns: ['rank', 'confidence_score', 'identity_status', 'canonical_package_name', 'recommended_process_name_param', 'upid', 'target_match_sources', 'supporting_sources', 'identity_warning'],
      rows: [[1, 55, 'probable', 'com.example', 'com.example:provider', 42, 'android_process_metadata.package_name', '', 'ok']],
      durationMs: 1,
    });

    const result = await createExecutor(query).execute('target_process_skill', 'trace', {
      process_name: 'com.example',
    });

    expect(result.success).toBe(false);
    expect(result.identityResolution?.status).toBe('ambiguous');
    expect(result.identityResolution?.warnings).toContain('probable identity match requires additional confirmation before parameter rewrite');
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('blocks pid-only probable matches because pid can be reused', async () => {
    const query = jest.fn().mockResolvedValueOnce({
      columns: ['rank', 'confidence_score', 'identity_status', 'canonical_package_name', 'recommended_process_name_param', 'upid', 'pid', 'target_match_sources', 'supporting_sources', 'identity_warning'],
      rows: [[1, 55, 'probable', 'com.example', 'com.example', 42, 4242, 'pid', '', 'ok']],
      durationMs: 1,
    });

    const result = await createExecutor(query).execute('target_process_skill', 'trace', {
      pid: 4242,
    });

    expect(result.success).toBe(false);
    expect(result.identityResolution?.status).toBe('ambiguous');
    expect(result.identityResolution?.warnings).toContain('probable identity match requires additional confirmation before parameter rewrite');
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('blocks thread-only matches even when the resolver reports high confidence', async () => {
    const query = jest.fn().mockResolvedValueOnce({
      columns: ['rank', 'confidence_score', 'identity_status', 'canonical_package_name', 'recommended_process_name_param', 'upid', 'target_match_sources', 'supporting_sources', 'identity_warning', 'thread_name', 'thread_target_matched'],
      rows: [[1, 90, 'confirmed', 'com.example', 'com.example', 42, 'thread.name', 'frame_timeline.upid', 'ok', 'main', 1]],
      durationMs: 1,
    });

    const result = await createExecutor(query).execute('target_thread_skill', 'trace', {
      thread_name: 'main',
    });

    expect(result.success).toBe(false);
    expect(result.identityResolution?.status).toBe('ambiguous');
    expect(result.identityResolution?.warnings).toContain('thread-only identity target is not enough to verify a unique process');
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('accepts an exact requested main process over close package child processes', async () => {
    const query = jest.fn()
      .mockResolvedValueOnce({
        columns: ['rank', 'confidence_score', 'identity_status', 'canonical_package_name', 'recommended_process_name_param', 'upid', 'process_name', 'target_match_sources', 'supporting_sources', 'identity_warning'],
        rows: [
          [1, 100, 'confirmed', 'com.example', 'com.example', 42, 'com.example', 'process.name', 'frame_timeline.upid', 'ok'],
          [2, 100, 'confirmed', 'com.example', 'com.example:remote', 43, 'com.example:remote', 'android_process_metadata.package_name', '', 'ok'],
        ],
        durationMs: 1,
      })
      .mockResolvedValueOnce({
        columns: ['process_name'],
        rows: [['com.example']],
        durationMs: 1,
      });

    const result = await createExecutor(query).execute('target_process_skill', 'trace', {
      process_name: 'com.example',
    });

    expect(result.success).toBe(true);
    expect(result.identityResolution?.status).toBe('verified');
    expect(result.identityResolution?.warnings).not.toContain(
      'multiple close process identity candidates require manual confirmation',
    );
    expect(query).toHaveBeenCalledTimes(2);
  });

  it('blocks required process skills when non-exact identity candidates are too close', async () => {
    const query = jest.fn().mockResolvedValueOnce({
      columns: ['rank', 'confidence_score', 'identity_status', 'canonical_package_name', 'recommended_process_name_param', 'upid', 'process_name', 'target_match_sources', 'supporting_sources', 'identity_warning'],
      rows: [
        [1, 95, 'confirmed', 'com.example', 'com.example:main', 42, 'com.example:main', 'android_process_metadata.package_name', 'frame_timeline.upid', 'ok'],
        [2, 90, 'confirmed', 'com.example', 'com.example:remote', 43, 'com.example:remote', 'android_process_metadata.package_name', 'frame_timeline.upid', 'ok'],
      ],
      durationMs: 1,
    });

    const result = await createExecutor(query).execute('target_process_skill', 'trace', {
      process_name: 'com.example',
    });

    expect(result.success).toBe(false);
    expect(result.identityResolution?.status).toBe('ambiguous');
    expect(result.identityResolution?.warnings).toContain('multiple close process identity candidates require manual confirmation');
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('blocks required process skills before querying when target is missing', async () => {
    const query = jest.fn();
    const result = await createExecutor(query).execute('target_process_skill', 'trace', {});

    expect(result.success).toBe(false);
    expect(result.error).toContain('no package/process/upid target');
    expect(result.identityResolution).toEqual(expect.objectContaining({
      status: 'missing',
    }));
    expect(query).not.toHaveBeenCalled();
  });

  it('carries identity sidecars through generic DataEnvelope conversion', () => {
    const envelopes = SkillExecutor.toDataEnvelopes({
      skillId: 'target_process_skill',
      skillName: 'Target',
      success: true,
      displayResults: [{
        stepId: 'root',
        title: 'Result',
        layer: 'overview',
        level: 'detail',
        format: 'table',
        data: { columns: ['process_name'], rows: [['com.example']] },
      }],
      diagnostics: [],
      identityResolution: {
        version: 'identity_contract@1',
        identityRefId: 'identity:test',
        target: { traceId: 'trace', source: 'skill_param' },
        status: 'verified',
        processes: [],
        threads: [],
        warnings: [],
      },
      executionTimeMs: 1,
    });

    expect(envelopes[0].meta).toEqual(expect.objectContaining({
      identityRefId: 'identity:test',
      identityStatus: 'verified',
      identityResolution: expect.objectContaining({ identityRefId: 'identity:test' }),
    }));
  });

  it('does not cache transient resolver failures', async () => {
    const query = jest.fn()
      .mockRejectedValueOnce(new Error('trace processor warming up'))
      .mockResolvedValueOnce({
        columns: ['rank', 'confidence_score', 'identity_status', 'canonical_package_name', 'recommended_process_name_param', 'upid', 'target_match_sources', 'supporting_sources', 'identity_warning'],
        rows: [[1, 90, 'confirmed', 'com.example', 'com.real.process', 42, 'android_process_metadata.package_name', 'frame_timeline.upid', 'ok']],
        durationMs: 1,
      })
      .mockResolvedValueOnce({
        columns: ['process_name'],
        rows: [['com.real.process']],
        durationMs: 1,
      });

    const executor = createExecutor(query);
    const first = await executor.execute('target_process_skill', 'trace', {
      process_name: 'com.example',
    });
    const second = await executor.execute('target_process_skill', 'trace', {
      process_name: 'com.example',
    });

    expect(first.success).toBe(false);
    expect(second.success).toBe(true);
    expect(query).toHaveBeenCalledTimes(3);
  });
});
