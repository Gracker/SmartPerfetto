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

  beforeEach(() => {
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

    it('should detect MIXED for ANDROID_VIEW_MIXED pipeline', async () => {
      mockExecute.mockResolvedValue(
        buildSkillResult({
          pipelineId: 'ANDROID_VIEW_MIXED',
          confidence: 0.70,
        }),
      );

      const result = await detectArchitectureViaSkill(context.traceProcessorService, context.traceId);

      expect(result.type).toBe('MIXED');
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
      expect(result.webview?.engine).toBe('CHROMIUM');
      expect(result.webview?.surfaceType).toBe('TEXTUREVIEW');
    });

    it('should detect WebView SURFACE_CONTROL', async () => {
      mockExecute.mockResolvedValue(
        buildSkillResult({
          pipelineId: 'WEBVIEW_SURFACE_CONTROL',
          confidence: 0.90,
          webviewMode: 'SURFACE_CONTROL',
        }),
      );

      const result = await detectArchitectureViaSkill(context.traceProcessorService, context.traceId);

      expect(result.type).toBe('WEBVIEW');
      expect(result.webview?.surfaceType).toBe('SURFACECONTROL');
    });

    it('should detect X5 custom WebView', async () => {
      mockExecute.mockResolvedValue(
        buildSkillResult({
          pipelineId: 'WEBVIEW_TEXTUREVIEW_CUSTOM',
          confidence: 0.80,
          webviewMode: 'TEXTUREVIEW_CUSTOM',
        }),
      );

      const result = await detectArchitectureViaSkill(context.traceProcessorService, context.traceId);

      expect(result.type).toBe('WEBVIEW');
      expect(result.webview?.engine).toBe('X5');
    });
  });

  describe('Compose detection', () => {
    it('should detect Compose', async () => {
      mockExecute.mockResolvedValue(
        buildSkillResult({
          pipelineId: 'COMPOSE_STANDARD',
          confidence: 0.75,
        }),
      );

      const result = await detectArchitectureViaSkill(context.traceProcessorService, context.traceId);

      expect(result.type).toBe('COMPOSE');
      expect(result.compose?.hasRecomposition).toBe(true);
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
    it('resolves every architecture type from catalog metadata', async () => {
      await ensurePipelineSkillsInitialized();
      for (const [pipelineId, entry] of Object.entries(pipelineSkillLoader.getCatalog().pipelines)) {
        expect(resolvePipelineArchitectureType(pipelineId)).toBe(entry.architecture_type);
      }
      expect(resolvePipelineArchitectureType('NOT_IN_CATALOG')).toBe('STANDARD');
    });

    it('should detect CAMERA for CAMERA_PIPELINE', async () => {
      mockExecute.mockResolvedValue(
        buildSkillResult({ pipelineId: 'CAMERA_PIPELINE', confidence: 0.70 }),
      );

      const result = await detectArchitectureViaSkill(context.traceProcessorService, context.traceId);

      expect(result.type).toBe('CAMERA');
    });

    it('should detect VIDEO_OVERLAY for VIDEO_OVERLAY_HWC', async () => {
      mockExecute.mockResolvedValue(
        buildSkillResult({ pipelineId: 'VIDEO_OVERLAY_HWC', confidence: 0.65 }),
      );

      const result = await detectArchitectureViaSkill(context.traceProcessorService, context.traceId);

      expect(result.type).toBe('VIDEO_OVERLAY');
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
    it('should parse candidates into evidence array', async () => {
      mockExecute.mockResolvedValue(
        buildSkillResult({
          pipelineId: 'ANDROID_VIEW_STANDARD_BLAST',
          confidence: 0.85,
          candidatesList: 'ANDROID_VIEW_STANDARD_BLAST:0.85; COMPOSE_STANDARD:0.65; FLUTTER_SURFACEVIEW_IMPELLER:0.30',
        }),
      );

      const result = await detectArchitectureViaSkill(context.traceProcessorService, context.traceId);

      expect(result.evidence).toHaveLength(3);
      expect(result.evidence[0]).toEqual({ type: 'slice', value: 'ANDROID_VIEW_STANDARD_BLAST', weight: 0.85 });
      expect(result.evidence[1]).toEqual({ type: 'slice', value: 'COMPOSE_STANDARD', weight: 0.65 });
      expect(result.evidence[2]).toEqual({ type: 'slice', value: 'FLUTTER_SURFACEVIEW_IMPELLER', weight: 0.30 });
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
