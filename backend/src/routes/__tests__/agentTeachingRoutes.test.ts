// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {afterEach,  describe, expect, it, jest, beforeEach } from '@jest/globals';
import express from 'express';
import request from 'supertest';
import { registerTeachingRoutes } from '../agentTeachingRoutes';
import { readTraceMetadataForContext } from '../../services/traceMetadataStore';
import { getTraceProcessorService } from '../../services/traceProcessorService';
import { RenderingPipelineTeachingService } from '../../services/renderingPipelineTeachingService';

import {createLoopbackServerFixture} from '../../../tests/helpers/loopbackServer';

const loopbackServers = createLoopbackServerFixture();

afterEach(async () => {
  await loopbackServers.close();
});

const mockAnalyze = jest.fn<(...args: any[]) => any>();
const mockGetTrace = jest.fn<(...args: any[]) => any>();

jest.mock('../../services/traceMetadataStore', () => ({
  readTraceMetadataForContext: jest.fn(),
}));

jest.mock('../../services/traceProcessorService', () => ({
  getTraceProcessorService: jest.fn(() => ({
    getTrace: mockGetTrace,
  })),
}));

jest.mock('../../services/renderingPipelineTeachingService', () => ({
  RenderingPipelineTeachingService: jest.fn().mockImplementation(() => ({
    analyze: mockAnalyze,
  })),
}));

async function makeApp() {
  const app = express();
  app.use(express.json());
  app.use((req: any, _res, next) => {
    req.requestContext = {
      tenantId: 'default-dev-tenant',
      workspaceId: 'default-workspace',
      userId: 'dev-user-123',
      authType: 'dev',
      roles: ['org_admin'],
      scopes: ['*'],
      requestId: 'req-test',
    };
    next();
  });
  const router = express.Router();
  registerTeachingRoutes(router);
  app.use('/api/agent/v1', router);
  return loopbackServers.listen(app);
}

function buildTeachingResponse(): any {
  return {
    success: true,
    schemaVersion: 'teaching.pipeline.v2',
    detection: {
      detected: true,
      primaryPipelineId: 'ANDROID_VIEW_STANDARD_BLAST',
      primaryRenderingTypeId: 'S02_AOSP_STANDARD',
      primaryConfidence: 0.9,
      primary_pipeline: {
        id: 'ANDROID_VIEW_STANDARD_BLAST',
        confidence: 0.9,
      },
      renderingType: {
        id: 'S02_AOSP_STANDARD',
        docPath: 'rendering_pipelines/S02_aosp_standard_type.md',
      },
      candidates: [{ id: 'ANDROID_VIEW_STANDARD_BLAST', confidence: 0.9 }],
      renderingTypeCandidates: [{ id: 'S02_AOSP_STANDARD', confidence: 0.9 }],
      relatedRenderingTypes: [{
        id: 'S06_MULTI_WINDOW',
        confidence: 0.7,
        docPath: 'rendering_pipelines/S06_multi_window_type.md',
      }],
      features: [],
      subvariants: {
        buffer_mode: 'BLAST',
        flutter_engine: 'N/A',
        webview_mode: 'N/A',
        game_engine: 'N/A',
      },
      traceRequirementsMissing: [],
      trace_requirements_missing: [],
    },
    observedFlow: {
      schemaVersion: 'observed-flow.v1',
      context: {
        traceId: 'trace-1',
        packageName: 'com.demo',
        sourcePriority: [
          'selection',
          'visible_window',
          'package_or_process_hint',
          'active_rendering_process_fallback',
        ],
      },
      lanes: [{
        id: 'app_com_demo_main',
        role: 'app',
        title: 'com.demo main',
        processName: 'com.demo',
        threadName: 'main',
        pipelineIds: ['ANDROID_VIEW_STANDARD_BLAST'],
        confidence: 0.9,
        evidenceSource: 'observed_slice_query',
      }],
      events: [{
        id: 'event-1-100',
        stage: 'app_frame',
        name: 'Choreographer#doFrame',
        ts: 100,
        dur: 200,
        durMs: 0,
        processName: 'com.demo',
        threadName: 'main',
        laneId: 'app_com_demo_main',
        evidenceSource: 'observed_slice_query',
        confidence: 0.9,
      }],
      dependencies: [],
      completeness: {
        level: 'medium',
        missingSignals: [],
        warnings: [],
      },
    },
    teaching: {
      title: 'S02 AOSP 标准类型',
      summary: 'Trace-backed teaching content.',
      mermaidBlocks: [],
      threadRoles: [],
      keySlices: ['Choreographer#doFrame'],
      docPath: 'rendering_pipelines/S02_aosp_standard_type.md',
    },
    teachingContent: {
      title: 'S02 AOSP 标准类型',
      summary: 'Trace-backed teaching content.',
      mermaidBlocks: [],
      threadRoles: [],
      keySlices: ['Choreographer#doFrame'],
      docPath: 'rendering_pipelines/S02_aosp_standard_type.md',
    },
    pinPlan: {
      status: 'planned',
      instructions: [],
      expectedLaneIds: ['app_com_demo_main'],
      expectedTrackHints: [],
      summary: 'planned',
      warnings: [],
    },
    overlayPlan: {
      status: 'ready',
      skillId: 'pipeline_key_slices_overlay',
      eventIds: ['event-1-100'],
      keySliceNames: ['Choreographer#doFrame'],
      summary: 'ready',
      warnings: [],
    },
    warnings: [],
    pinInstructions: [],
    activeRenderingProcesses: [],
  };
}

describe('agent teaching pipeline route', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (readTraceMetadataForContext as any).mockResolvedValue({ traceId: 'trace-1' });
    mockGetTrace.mockReturnValue({ id: 'trace-1', status: 'ready' });
    mockAnalyze.mockResolvedValue(buildTeachingResponse());
  });

  it('requires traceId', async () => {
    const res = await request(await makeApp())
      .post('/api/agent/v1/teaching/pipeline')
      .send({outputLanguage: 'en'});

    expect(res.status).toBe(400);
    expect(res.body).toEqual({
      success: false,
      error: 'traceId is required',
    });
    expect(mockAnalyze).not.toHaveBeenCalled();
  });

  it('returns 404 when trace metadata is not owned by the request context', async () => {
    (readTraceMetadataForContext as any).mockResolvedValue(null);

    const res = await request(await makeApp())
      .post('/api/agent/v1/teaching/pipeline')
      .send({ traceId: 'trace-1' });

    expect(res.status).toBe(404);
    expect(mockAnalyze).not.toHaveBeenCalled();
  });

  it('returns 404 when the trace is not uploaded to the backend processor', async () => {
    mockGetTrace.mockReturnValue(null);

    const res = await request(await makeApp())
      .post('/api/agent/v1/teaching/pipeline')
      .send({ traceId: 'trace-1' });

    expect(res.status).toBe(404);
    expect(res.body).toEqual(expect.objectContaining({
      success: false,
      code: 'TRACE_NOT_UPLOADED',
    }));
    expect(mockAnalyze).not.toHaveBeenCalled();
  });

  it('preserves legacy fields while returning the v2 observed-flow contract', async () => {
    const res = await request(await makeApp())
      .post('/api/agent/v1/teaching/pipeline')
      .send({
        traceId: 'trace-1',
        packageName: 'com.demo',
        visibleWindow: { startTs: 100, endTs: 1000 },
      });

    expect(res.status).toBe(200);
    const traceProcessor = (getTraceProcessorService as jest.Mock).mock.results[0].value;
    expect(RenderingPipelineTeachingService).toHaveBeenCalledWith(traceProcessor);
    expect(mockAnalyze).toHaveBeenCalledWith(expect.objectContaining({
      traceId: 'trace-1',
      packageName: 'com.demo',
      visibleWindow: { startTs: 100, endTs: 1000 },
    }));
    expect(res.body).toEqual(expect.objectContaining({
      success: true,
      schemaVersion: 'teaching.pipeline.v2',
      observedFlow: expect.objectContaining({
        schemaVersion: 'observed-flow.v1',
        lanes: expect.any(Array),
        events: expect.any(Array),
      }),
      pinPlan: expect.objectContaining({ status: 'planned' }),
      overlayPlan: expect.objectContaining({ status: 'ready' }),
      warnings: expect.any(Array),
      teaching: expect.any(Object),
      pinInstructions: expect.any(Array),
      activeRenderingProcesses: expect.any(Array),
    }));
    expect(res.body.detection).toEqual(expect.objectContaining({
      primaryPipelineId: 'ANDROID_VIEW_STANDARD_BLAST',
      primaryRenderingTypeId: 'S02_AOSP_STANDARD',
      primary_pipeline: {
        id: 'ANDROID_VIEW_STANDARD_BLAST',
        confidence: 0.9,
      },
      renderingType: {
        id: 'S02_AOSP_STANDARD',
        docPath: 'rendering_pipelines/S02_aosp_standard_type.md',
      },
      relatedRenderingTypes: [{
        id: 'S06_MULTI_WINDOW',
        confidence: 0.7,
        docPath: 'rendering_pipelines/S06_multi_window_type.md',
      }],
      trace_requirements_missing: [],
    }));
  });
});
