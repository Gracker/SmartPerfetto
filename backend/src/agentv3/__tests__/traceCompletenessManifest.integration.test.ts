// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {mkdtemp, rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {TraceProcessorService} from '../../services/traceProcessorService';
import {resolveTraceCase} from '../../utils/traceCorpus';
import {probeTraceCompleteness} from '../traceCompletenessProber';

describe('TraceCompleteness CapabilityManifest production integration', () => {
  it('resolves the cataloged startup trace and the running processor identity', async () => {
    const uploadDir = await mkdtemp(path.join(os.tmpdir(), 'trace-manifest-integration-'));
    const service = new TraceProcessorService(uploadDir);
    const tracePath = resolveTraceCase('android-startup-light');
    let traceId: string | undefined;

    try {
      traceId = await service.loadTraceFromFilePath(tracePath);
      const runningProcessor = service.getRunningCapabilityTraceProcessorInput(traceId);

      const result = await probeTraceCompleteness(service, traceId, undefined);

      expect(result.capabilityManifestResolution).toMatchObject({status: 'ready'});
      if (result.capabilityManifestResolution?.status !== 'ready') {
        throw new Error('Expected a ready CapabilityManifest resolution');
      }
      const manifest = result.capabilityManifestResolution.manifest;
      expect(manifest.content.trace.fingerprintKind).toBe('trace_bytes_sha256');
      expect(manifest.content.trace.fingerprintSha256).toMatch(/^[0-9a-f]{64}$/);
      expect(manifest.content.trace.clockRangeNs).toEqual({
        startNs: expect.stringMatching(/^(0|[1-9]\d*)$/),
        endNs: expect.stringMatching(/^(0|[1-9]\d*)$/),
      });
      expect(BigInt(manifest.content.trace.clockRangeNs!.startNs))
        .toBeLessThanOrEqual(BigInt(manifest.content.trace.clockRangeNs!.endNs));
      expect(runningProcessor?.source).toBe('local_binary');
      expect(['bundled', 'custom']).toContain(manifest.content.traceProcessor.source);
      expect(manifest.content.traceProcessor).not.toHaveProperty('reportedVersion');

      const serialized = JSON.stringify(manifest);
      expect(serialized).not.toContain(tracePath);
      expect(serialized).not.toContain(uploadDir);
      expect(serialized).not.toMatch(/"[^"]*path[^"]*":/i);
    } finally {
      try {
        if (traceId !== undefined) {
          await service.deleteTrace(traceId);
        }
      } finally {
        await rm(uploadDir, {recursive: true, force: true});
      }
    }
  }, 120_000);
});
