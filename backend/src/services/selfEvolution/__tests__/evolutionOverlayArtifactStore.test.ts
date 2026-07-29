// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {afterEach, beforeEach, describe, expect, it} from '@jest/globals';

import type {
  EvolutionOverlayArtifactV1,
  EvolutionOverlayPayloadV1,
  SelfEvolutionPersistenceCapability,
} from '../../../types/selfEvolution';
import {canonicalContentHash} from '../canonicalJson';
import {EvolutionOverlayArtifactStore} from '../evolutionOverlayArtifactStore';
import {createEvolutionOverlayArtifactV1} from '../evolutionOverlayContract';

describe('EvolutionOverlayArtifactStore', () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-evolution-artifacts-'));
  });

  afterEach(() => {
    fs.rmSync(root, {recursive: true, force: true});
  });

  function persistence(
    state: 'available' | 'unavailable' = 'available',
  ): SelfEvolutionPersistenceCapability {
    return {
      persistence: state,
      ...(state === 'unavailable'
        ? {reason: 'external_data_dir_not_configured'}
        : {}),
      configured: state === 'available',
      writable: true,
      outsidePackage: true,
      externalMount: false,
      dataRoot: root,
      packageRoot: path.join(root, 'package'),
      checkedAt: 1,
    };
  }

  function artifact(): EvolutionOverlayArtifactV1 {
    const payload: EvolutionOverlayPayloadV1 = {
      schemaVersion: 1,
      payloadKind: 'skill_delta',
      skillOverlay: {
        schemaVersion: 1,
        overlayId: 'overlay_test',
        baseSkillId: 'startup_analysis',
        baseFingerprint: '1'.repeat(64),
        proposalId: 'proposal_test',
        createdAt: '2026-07-29T01:02:03.000Z',
        scope: {tenantId: 'tenant', workspaceId: 'workspace'},
        operations: [{
          op: 'set_metadata',
          operationId: 'set_tags',
          meta: {tags: ['tested']},
        }],
      },
    };
    return createEvolutionOverlayArtifactV1({
      artifactId: 'artifact:test',
      payload,
      provenance: {
        schemaVersion: 1,
        overlayId: 'overlay_test',
        overlayKind: 'skill_delta',
        overlayContentHash: canonicalContentHash(payload),
        deltaSchemaVersion: 1,
        proposalId: 'proposal_test',
        proposalRevision: 3,
        gateVerdict: 'passed',
        derivedFrom: {
          baseKind: 'skill',
          baseId: 'startup_analysis',
          baseVersion: '1',
          baseContentFingerprint: '1'.repeat(64),
          baseOrigin: 'built_in',
        },
        dependencyFingerprints: {
          loaderSchemaVersion: 'effective-runtime-registry-v1',
        },
        producedUnder: {
          buildIdentity: {
            distribution: 'portable',
            channel: 'stable',
            version: '1.3.0',
            commit: 'a'.repeat(40),
            target: 'darwin-arm64',
          },
          traceProcessorVersion: 'v49.0',
          testedMatrix: [{runtime: 'openai-agents-sdk'}],
        },
        compatibility: {
          smartPerfettoMinVersion: '1.3.0',
          smartPerfettoMaxVersionTested: '1.3.0',
        },
        createdAt: 1,
        actor: {userId: 'maintainer'},
        scope: {tenantId: 'tenant', workspaceId: 'workspace'},
      },
    });
  }

  it('stores immutable content-addressed bytes and reloads strictly', () => {
    const store = new EvolutionOverlayArtifactStore({
      rootDirectory: path.join(root, 'objects'),
      persistence: persistence(),
    });
    const value = artifact();

    const first = store.put(value);
    const second = store.put(value);

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(first.filePath).toBe(second.filePath);
    expect(store.load(value.contentHash)).toEqual(value);
    expect(fs.statSync(first.filePath).mode & 0o777).toBe(0o600);
  });

  it('fails closed when persistence is unavailable', () => {
    const store = new EvolutionOverlayArtifactStore({
      rootDirectory: path.join(root, 'objects'),
      persistence: persistence('unavailable'),
    });
    expect(() => store.put(artifact()))
      .toThrow('self_evolution_persistence_unavailable');
  });

  it('rejects a symlinked object directory', () => {
    const outside = path.join(root, 'outside');
    fs.mkdirSync(outside);
    const objectRoot = path.join(root, 'objects');
    fs.symlinkSync(outside, objectRoot, 'dir');
    const store = new EvolutionOverlayArtifactStore({
      rootDirectory: objectRoot,
      persistence: persistence(),
    });

    expect(() => store.put(artifact()))
      .toThrow('evolution_overlay_artifact_symlink_not_allowed');
    expect(fs.readdirSync(outside)).toEqual([]);
  });
});
