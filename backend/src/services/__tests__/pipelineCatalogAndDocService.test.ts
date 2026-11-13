// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import { beforeAll, describe, expect, it } from '@jest/globals';
import { PipelineDocService } from '../pipelineDocService';
import { pipelineSkillLoader, renderingTypeSource } from '../pipelineSkillLoader';
import type { RenderingTypeDefinition } from '../pipelineSkillLoader';

describe('pipeline catalog and product teaching cards', () => {
  beforeAll(async () => {
    await pipelineSkillLoader.reload();
  });

  it('loads the complete role-aware catalog without promoting features', () => {
    const catalog = pipelineSkillLoader.getCatalog();
    const entries = Object.entries(catalog.pipelines);
    expect(entries).toHaveLength(31);
    expect(pipelineSkillLoader.getAllPipelineIds()).toHaveLength(31);
    expect(catalog.version).toBe('3.0');
    expect(catalog).not.toHaveProperty('source');
    expect(catalog).not.toHaveProperty('documents');
    expect(catalog.rendering_types).not.toHaveProperty('S15_UNIFIED_RENDERING');
    expect(pipelineSkillLoader.getPipelineCatalogEntry('CHROME_BROWSER_VIZ'))
      .toEqual(expect.objectContaining({
        teaching_type_id: 'S16_CHROMIUM_BROWSER',
        rendering_type_id: 'S16_CHROMIUM_BROWSER',
      }));

    for (const [pipelineId, entry] of entries) {
      expect(pipelineSkillLoader.getPipeline(pipelineId)).not.toBeNull();
      expect(pipelineSkillLoader.getRenderingType(entry.teaching_type_id)).not.toBeNull();
      if (entry.classification_role === 'variant') {
        expect(entry.primary_eligible).toBe(true);
        expect(entry.rendering_type_id).toBe(entry.teaching_type_id);
      } else {
        expect(entry.primary_eligible).toBe(false);
        expect(entry.rendering_type_id).toBeUndefined();
      }
    }

    expect(pipelineSkillLoader.getPipelineCatalogEntry('FLUTTER_SURFACEVIEW_IMPELLER'))
      .toEqual(expect.objectContaining({
        classification_role: 'variant',
        rendering_type_id: 'S10_FLUTTER',
        architecture_type: 'FLUTTER',
      }));
    expect(pipelineSkillLoader.getPipelineCatalogEntry('VARIABLE_REFRESH_RATE'))
      .toEqual(expect.objectContaining({
        classification_role: 'feature',
        teaching_type_id: 'S01_OVERVIEW',
        primary_eligible: false,
      }));
  });

  it('derives the fallback IDs and teaching source from the catalog default', () => {
    expect(pipelineSkillLoader.getDefaultSelection()).toEqual({
      pipelineId: 'ANDROID_VIEW_STANDARD_BLAST',
      renderingTypeId: 'S02_AOSP_STANDARD',
      docPath: renderingTypeSource('S02_AOSP_STANDARD'),
    });
  });

  it('projects each pipeline card directly from the product catalog', () => {
    const service = new PipelineDocService(pipelineSkillLoader);
    const catalog = pipelineSkillLoader.getCatalog();
    expect(service.getAvailablePipelines()).toEqual(pipelineSkillLoader.getAllPipelineIds());
    for (const [pipelineId, entry] of Object.entries(catalog.pipelines)) {
      expect(service.hasDocument(pipelineId)).toBe(true);
      expect(service.getTeachingContent(pipelineId)).toEqual({
        ...catalog.rendering_types[entry.teaching_type_id].teaching,
        docPath: renderingTypeSource(entry.teaching_type_id),
      });
    }
    const chrome = service.getTeachingContent('CHROME_BROWSER_VIZ');
    expect(chrome?.docPath).toBe(renderingTypeSource('S16_CHROMIUM_BROWSER'));
    const webview = service.getTeachingContent('WEBVIEW_GL_FUNCTOR');
    expect(webview?.keySlices).toContain('WebViewFunctor::drawVk');
    expect(service.getTeachingContent('UNKNOWN')).toBeNull();
    expect(service.hasDocument('UNKNOWN')).toBe(false);
  });

  it('returns independent card fields without mutating the catalog or later reads', () => {
    const service = new PipelineDocService();
    const catalogCard = pipelineSkillLoader.getRenderingType('S02_AOSP_STANDARD')!.teaching;
    const original = structuredClone(catalogCard);
    const projected = service.getTeachingContent('ANDROID_VIEW_STANDARD_BLAST')!;
    projected.title = 'Changed by a caller';
    projected.summary = 'Changed by a caller';
    projected.mermaidBlocks.push('caller diagram');
    projected.keySlices.push('caller event');
    projected.threadRoles.push({thread: 'caller', responsibility: 'caller'});
    projected.threadRoles[0].responsibility = 'Changed by a caller';
    service.getAvailablePipelines().push('CALLER_PIPELINE');

    expect(catalogCard).toEqual(original);
    expect(service.getTeachingContent('ANDROID_VIEW_STANDARD_BLAST')).toEqual({
      ...original,
      docPath: renderingTypeSource('S02_AOSP_STANDARD'),
    });
    expect(service.getAvailablePipelines()).not.toContain('CALLER_PIPELINE');
    expect(() => service.clearCache()).not.toThrow();
  });

  it('uses an injected catalog reader without document files and observes replacement cards', () => {
    const entry = pipelineSkillLoader.getPipelineCatalogEntry('ANDROID_VIEW_STANDARD_BLAST')!;
    let renderingType: RenderingTypeDefinition | null = {
      kind: 'concrete',
      teaching: {
        title: 'Product card', summary: 'Product guidance',
        mermaidBlocks: [], threadRoles: [], keySlices: ['queueBuffer'],
      },
    };
    const service = new PipelineDocService({
      getPipelineCatalogEntry: (id) => id === 'TEST' ? entry : null,
      getRenderingType: () => renderingType,
      getAllPipelineIds: () => ['TEST'],
    });
    expect(service.getTeachingContent('TEST')?.keySlices).toEqual(['queueBuffer']);
    renderingType.teaching.title = 'Replacement card';
    service.clearCache();
    expect(service.getTeachingContent('TEST')?.title).toBe('Replacement card');
    renderingType = null;
    expect(service.getTeachingContent('TEST')).toBeNull();
    expect(service.hasDocument('TEST')).toBe(false);
  });
});
