// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

/**
 * Architecture Detector Tests
 *
 * Tests the YAML-skill-backed architecture detection.
 * Mocks SkillExecutor to simulate rendering_pipeline_detection output.
 */

import { describe, it, expect, jest, beforeEach } from '@jest/globals';

import {
  ArchitectureDetector,
  createArchitectureDetector,
  detectArchitectureViaSkill,
  resolvePipelineArchitectureType,
} from '../agent/detectors/architectureDetector';
import type { DetectorContext } from '../agent/detectors/types';
import { ensurePipelineSkillsInitialized, pipelineSkillLoader } from '../services/pipelineSkillLoader';
import {createTraceProcessorQueryCancelledError} from '../services/traceProcessorCancellation';

// Mock the skill engine dependencies
jest.mock('../services/skillEngine/skillLoader', () => ({
  ensureSkillRegistryInitialized: jest.fn(async () => {}),
  skillRegistry: {
    getAllSkills: jest.fn(() => []),
    getFragmentCache: jest.fn(() => new Map()),
  },
}));

// Store a reference to the mock execute so tests can control its return value
const mockExecute = jest.fn<(...args: any[]) => any>();

jest.mock('../services/skillEngine/skillExecutor', () => ({
  createSkillExecutor: jest.fn(() => ({
    registerSkills: jest.fn(),
    setFragmentRegistry: jest.fn(),
    execute: mockExecute,
  })),
}));

/**
 * Helper: build a mock SkillExecutionResult mimicking rendering_pipeline_detection output.
 */
function buildSkillResult(opts: {
  pipelineId: string;
  confidence: number;
  candidatesList?: string;
  featuresList?: string;
  flutterEngine?: string;
  webviewMode?: string;
  gameEngine?: string;
  bufferMode?: string;
}): any {
  return {
    success: true,
    displayResults: [],
    diagnostics: [],
    rawResults: {
      determine_pipeline: {
        stepId: 'determine_pipeline',
        stepType: 'atomic',
        success: true,
        data: [{
          primary_pipeline_id: opts.pipelineId,
          primary_confidence: opts.confidence,
          primary_basis: pipelineSkillLoader.getPipelineCatalogEntry(opts.pipelineId)?.output_path ?? 'hwui',
          target_process: 'com.example.app',
          host_submissions: 12,
          sf_host_frames: 0,
          candidates_list: opts.candidatesList || `${opts.pipelineId}:${opts.confidence}`,
          features_list: opts.featuresList || null,
          doc_path: `rendering_pipelines/${opts.pipelineId.toLowerCase()}.md`,
        }],
      },
      subvariants: {
        stepId: 'subvariants',
        stepType: 'atomic',
        success: true,
        data: [{
          buffer_mode: opts.bufferMode || 'BLAST',
          flutter_engine: opts.flutterEngine || 'N/A',
          webview_mode: opts.webviewMode || 'N/A',
          game_engine: opts.gameEngine || 'N/A',
        }],
      },
    },
    executionTimeMs: 100,
  };
}

describe('ArchitectureDetector (YAML skill-backed)', () => {
  let context: DetectorContext;

  beforeEach(async () => {
    await ensurePipelineSkillsInitialized();
    context = {
      traceId: 'test-trace-id',
      traceProcessorService: {},
    };
    mockExecute.mockReset();
  });

  describe('Standard Android detection', () => {
    it('should detect STANDARD for ANDROID_VIEW_STANDARD_BLAST pipeline', async () => {
      mockExecute.mockResolvedValue(
        buildSkillResult({
          pipelineId: 'ANDROID_VIEW_STANDARD_BLAST',
          confidence: 0.85,
        }),
      );

      const result = await detectArchitectureViaSkill(context.traceProcessorService, context.traceId);

      expect(result.type).toBe('STANDARD');
      expect(result.confidence).toBe(0.85);
      expect(result.evidence.length).toBeGreaterThan(0);
    });

    it('should detect SOFTWARE for ANDROID_VIEW_SOFTWARE pipeline', async () => {
      mockExecute.mockResolvedValue(
        buildSkillResult({
          pipelineId: 'ANDROID_VIEW_SOFTWARE',
          confidence: 0.80,
        }),
      );

      const result = await detectArchitectureViaSkill(context.traceProcessorService, context.traceId);

      expect(result.type).toBe('SOFTWARE');
    });

    it('abstains on a scoring-only mixed candidate', async () => {
      mockExecute.mockResolvedValue(
        buildSkillResult({
          pipelineId: 'ANDROID_VIEW_MIXED',
          confidence: 0.70,
        }),
      );

      const result = await detectArchitectureViaSkill(context.traceProcessorService, context.traceId);

      expect(result.type).toBe('UNKNOWN');
    });
  });

  describe('Flutter detection', () => {
    it('should detect Flutter with Impeller engine', async () => {
      mockExecute.mockResolvedValue(
        buildSkillResult({
          pipelineId: 'FLUTTER_SURFACEVIEW_IMPELLER',
          confidence: 0.95,
          flutterEngine: 'IMPELLER',
        }),
      );

      const result = await detectArchitectureViaSkill(context.traceProcessorService, context.traceId);

      expect(result.type).toBe('FLUTTER');
      expect(result.confidence).toBe(0.95);
      expect(result.flutter?.engine).toBe('IMPELLER');
    });

    it('should detect Flutter with Skia engine', async () => {
      mockExecute.mockResolvedValue(
        buildSkillResult({
          pipelineId: 'FLUTTER_SURFACEVIEW_SKIA',
          confidence: 0.90,
          flutterEngine: 'SKIA',
        }),
      );

      const result = await detectArchitectureViaSkill(context.traceProcessorService, context.traceId);

      expect(result.type).toBe('FLUTTER');
      expect(result.flutter?.engine).toBe('SKIA');
    });

    it('should detect Flutter TextureView variant', async () => {
      mockExecute.mockResolvedValue(
        buildSkillResult({
          pipelineId: 'FLUTTER_TEXTUREVIEW',
          confidence: 0.65,
          flutterEngine: 'UNKNOWN',
        }),
      );

      const result = await detectArchitectureViaSkill(context.traceProcessorService, context.traceId);

      expect(result.type).toBe('FLUTTER');
      expect(result.flutter?.engine).toBe('UNKNOWN');
    });
  });

  describe('WebView detection', () => {
    it('should detect WebView GL_FUNCTOR', async () => {
      mockExecute.mockResolvedValue(
        buildSkillResult({
          pipelineId: 'WEBVIEW_GL_FUNCTOR',
          confidence: 0.85,
          webviewMode: 'GL_FUNCTOR',
        }),
      );

      const result = await detectArchitectureViaSkill(context.traceProcessorService, context.traceId);

      expect(result.type).toBe('WEBVIEW');
      expect(result.webview?.engine).toBe('UNKNOWN');
      expect(result.webview?.surfaceType).toBe('UNKNOWN');
    });

    it('abstains on an unbound WebView SurfaceControl score', async () => {
      mockExecute.mockResolvedValue(
        buildSkillResult({
          pipelineId: 'WEBVIEW_SURFACE_CONTROL',
          confidence: 0.90,
          webviewMode: 'SURFACE_CONTROL',
        }),
      );

      const result = await detectArchitectureViaSkill(context.traceProcessorService, context.traceId);

      expect(result.type).toBe('UNKNOWN');
      expect(result.webview).toBeUndefined();
    });

    it('rejects the unbound custom WebView classification even with a subvariant', async () => {
      mockExecute.mockResolvedValue(
        buildSkillResult({
          pipelineId: 'WEBVIEW_TEXTUREVIEW_CUSTOM',
          confidence: 0.80,
          webviewMode: 'TEXTUREVIEW_CUSTOM',
        }),
      );

      const result = await detectArchitectureViaSkill(context.traceProcessorService, context.traceId);

      expect(result.type).toBe('UNKNOWN');
      expect(result.webview).toBeUndefined();
    });
  });

  describe('Compose detection', () => {
    it('keeps a Compose signature from identifying a separate output path', async () => {
      mockExecute.mockResolvedValue(
        buildSkillResult({
          pipelineId: 'COMPOSE_STANDARD',
          confidence: 0.75,
        }),
      );

      const result = await detectArchitectureViaSkill(context.traceProcessorService, context.traceId);

      expect(result.type).toBe('UNKNOWN');
      expect(result.compose).toBeUndefined();
    });
  });

  describe('Game engine detection', () => {
    it('should detect GAME_ENGINE', async () => {
      mockExecute.mockResolvedValue(
        buildSkillResult({
          pipelineId: 'GAME_ENGINE',
          confidence: 0.85,
          gameEngine: 'UNITY',
        }),
      );

      const result = await detectArchitectureViaSkill(context.traceProcessorService, context.traceId);

      expect(result.type).toBe('GAME_ENGINE');
    });
  });

  describe('Other pipeline types', () => {
    it('promotes only catalog entries bound to the observed output path', async () => {
      await ensurePipelineSkillsInitialized();
      for (const [pipelineId, entry] of Object.entries(pipelineSkillLoader.getCatalog().pipelines)) {
        expect(resolvePipelineArchitectureType(pipelineId, entry.output_path)).toBe(entry.output_path ? entry.architecture_type : 'UNKNOWN');
      }
      expect(resolvePipelineArchitectureType('NOT_IN_CATALOG', 'hwui')).toBe('UNKNOWN');
    });

    it('should detect CAMERA for CAMERA_PIPELINE', async () => {
      mockExecute.mockResolvedValue(
        buildSkillResult({ pipelineId: 'CAMERA_PIPELINE', confidence: 0.70 }),
      );

      const result = await detectArchitectureViaSkill(context.traceProcessorService, context.traceId);

      expect(result.type).toBe('CAMERA');
    });

    it('does not promote the unbound HWC overlay feature', async () => {
      mockExecute.mockResolvedValue(
        buildSkillResult({ pipelineId: 'VIDEO_OVERLAY_HWC', confidence: 0.65 }),
      );

      const result = await detectArchitectureViaSkill(context.traceProcessorService, context.traceId);

      expect(result.type).toBe('UNKNOWN');
    });

    it('should detect SURFACEVIEW for SURFACEVIEW_BLAST', async () => {
      mockExecute.mockResolvedValue(
        buildSkillResult({ pipelineId: 'SURFACEVIEW_BLAST', confidence: 0.75 }),
      );

      const result = await detectArchitectureViaSkill(context.traceProcessorService, context.traceId);

      expect(result.type).toBe('SURFACEVIEW');
    });

    it('should detect GLSURFACEVIEW for OPENGL_ES', async () => {
      mockExecute.mockResolvedValue(
        buildSkillResult({ pipelineId: 'OPENGL_ES', confidence: 0.70 }),
      );

      const result = await detectArchitectureViaSkill(context.traceProcessorService, context.traceId);

      expect(result.type).toBe('GLSURFACEVIEW');
    });

    it('should detect GLSURFACEVIEW for VULKAN_NATIVE', async () => {
      mockExecute.mockResolvedValue(
        buildSkillResult({ pipelineId: 'VULKAN_NATIVE', confidence: 0.80 }),
      );

      const result = await detectArchitectureViaSkill(context.traceProcessorService, context.traceId);

      expect(result.type).toBe('GLSURFACEVIEW');
    });
  });

  describe('Error handling', () => {
    it('rejects missing pipeline rows even when the catalog has a usable default', async () => {
      mockExecute.mockResolvedValue({
        success: true,
        displayResults: [],
        diagnostics: [],
        rawResults: {},
        executionTimeMs: 0,
      });
      const defaultSpy = jest.spyOn(pipelineSkillLoader, 'getDefaultSelection')
        .mockReturnValue({
          pipelineId: 'FLUTTER_SURFACEVIEW_IMPELLER',
          renderingTypeId: 'S10_FLUTTER',
          docPath: 'rendering_pipelines/S10_flutter_type.md',
        });

      try {
        await expect(detectArchitectureViaSkill(
          context.traceProcessorService,
          context.traceId,
        )).rejects.toThrow('did not produce a pipeline ID');
        expect(defaultSpy).not.toHaveBeenCalled();
      } finally {
        defaultSpy.mockRestore();
      }
    });

    it.each([
      ['com.example.app:renderer', 'CAMERA'],
      ['com.example.application', 'UNKNOWN'],
      [null, 'UNKNOWN'],
    ])('checks the observed process %s against the requested package', async (processName, type) => {
      const row = buildSkillResult({pipelineId: 'CAMERA_PIPELINE', confidence: 1});
      row.rawResults.determine_pipeline.data[0].target_process = processName;
      mockExecute.mockResolvedValue(row);
      const result = await detectArchitectureViaSkill(context.traceProcessorService, context.traceId, 'com.example.app');
      expect(result.type).toBe(type);
      if (type === 'UNKNOWN') expect(result.evidence).toEqual([]);
    });

    it('rejects a valid pipeline ID paired with a different real output path', async () => {
      const mismatch = buildSkillResult({pipelineId: 'CAMERA_PIPELINE', confidence: 1});
      mismatch.rawResults.determine_pipeline.data[0].primary_basis = 'hwui';
      mockExecute.mockResolvedValue(mismatch);
      await expect(detectArchitectureViaSkill(context.traceProcessorService, context.traceId))
        .resolves.toMatchObject({type: 'UNKNOWN', confidence: 0, additionalInfo: {pipelineId: 'UNKNOWN', candidates: []}});
    });

    it('abstains on a legacy score-only result even for a catalog variant', async () => {
      const stale = buildSkillResult({pipelineId: 'FLUTTER_TEXTUREVIEW', confidence: 0.9});
      delete stale.rawResults.determine_pipeline.data[0].primary_basis;
      mockExecute.mockResolvedValue(stale);
      await expect(detectArchitectureViaSkill(context.traceProcessorService, context.traceId, 'app.b'))
        .resolves.toMatchObject({type: 'UNKNOWN', confidence: 0,
          detectorScope: {version: 1, traceId: context.traceId, packageName: 'app.b'},
          additionalInfo: {pipelineId: 'UNKNOWN', primaryBasis: 'unknown'}});
    });

    it.each(['Skill not found', 'No processor for trace test-trace'])('rejects skill execution failure: %s', error => {
      mockExecute.mockResolvedValue({
        success: false,
        error,
        displayResults: [],
        diagnostics: [],
        executionTimeMs: 0,
      });

      return expect(detectArchitectureViaSkill(context.traceProcessorService, context.traceId)).rejects.toThrow(error);
    });

    it.each([new Error('Connection refused'), createTraceProcessorQueryCancelledError('cancelled by owner')])
      ('preserves the original thrown exception: %s', async error => {
        mockExecute.mockRejectedValue(error);
        await expect(detectArchitectureViaSkill(context.traceProcessorService, context.traceId)).rejects.toBe(error);
      });

    it.each([undefined, '', '   '])('rejects an absent pipeline ID %s without changing actual STANDARD detection', async pipelineId => {
      const result = buildSkillResult({pipelineId: 'ANDROID_VIEW_STANDARD_BLAST', confidence: 0.85});
      result.rawResults.determine_pipeline.data[0].primary_pipeline_id = pipelineId;
      mockExecute.mockResolvedValue(result);
      await expect(detectArchitectureViaSkill(context.traceProcessorService, context.traceId)).rejects.toThrow('did not produce a pipeline ID');
      mockExecute.mockResolvedValue(buildSkillResult({pipelineId: 'ANDROID_VIEW_STANDARD_BLAST', confidence: 0.85}));
      await expect(detectArchitectureViaSkill(context.traceProcessorService, context.traceId)).resolves.toMatchObject({
        type: 'STANDARD', confidence: 0.85,
      });
    });
  });

  describe('Candidates list parsing', () => {
    it('separates observed output counts from ranked candidates', async () => {
      mockExecute.mockResolvedValue(
        buildSkillResult({
          pipelineId: 'ANDROID_VIEW_STANDARD_BLAST',
          confidence: 0.85,
          candidatesList: 'ANDROID_VIEW_STANDARD_BLAST:0.85; COMPOSE_STANDARD:0.65; FLUTTER_SURFACEVIEW_IMPELLER:0.30',
        }),
      );

      const result = await detectArchitectureViaSkill(context.traceProcessorService, context.traceId);

      expect(result.evidence).toEqual([
        {type: 'count', metric: 'host_submissions', value: 12, source: 'rendering_pipeline_detection/determine_pipeline'},
        {type: 'count', metric: 'sf_host_frames', value: 0, source: 'rendering_pipeline_detection/determine_pipeline'},
      ]);
      expect(result.additionalInfo?.candidates).toEqual([
        {id: 'ANDROID_VIEW_STANDARD_BLAST', confidence: 0.85},
        {id: 'COMPOSE_STANDARD', confidence: 0.65},
        {id: 'FLUTTER_SURFACEVIEW_IMPELLER', confidence: 0.30},
      ]);
    });
  });

  describe('Backward-compatible API', () => {
    it('createArchitectureDetector().detect() should work', async () => {
      mockExecute.mockResolvedValue(
        buildSkillResult({
          pipelineId: 'FLUTTER_SURFACEVIEW_IMPELLER',
          confidence: 0.95,
          flutterEngine: 'IMPELLER',
        }),
      );

      const detector = createArchitectureDetector();
      const result = await detector.detect(context);

      expect(result.type).toBe('FLUTTER');
      expect(result.flutter?.engine).toBe('IMPELLER');
    });

    it('ArchitectureDetector class should be instantiable', () => {
      const detector = new ArchitectureDetector();
      expect(detector).toBeDefined();
      expect(typeof detector.detect).toBe('function');
    });
  });

  describe('Additional info', () => {
    it('should populate additionalInfo with pipelineId and docPath', async () => {
      mockExecute.mockResolvedValue(
        buildSkillResult({
          pipelineId: 'FLUTTER_SURFACEVIEW_IMPELLER',
          confidence: 0.95,
          flutterEngine: 'IMPELLER',
        }),
      );

      const result = await detectArchitectureViaSkill(context.traceProcessorService, context.traceId);

      expect(result.additionalInfo?.pipelineId).toBe('FLUTTER_SURFACEVIEW_IMPELLER');
      expect(result.additionalInfo?.docPath).toBeDefined();
    });
  });
});
