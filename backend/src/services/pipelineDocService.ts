// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

/** Projects product-owned teaching cards from the pipeline catalog. */
import { pipelineSkillLoader, renderingTypeSource } from './pipelineSkillLoader';
import type {
  PipelineCatalogEntry,
  RenderingTypeDefinition,
  RenderingTypeTeaching,
} from './pipelineSkillLoader';

export interface PipelineTeachingContent extends RenderingTypeTeaching {
  /** Catalog location of the product teaching card. */
  docPath: string;
}

export interface PipelineCatalogReader {
  getPipelineCatalogEntry(pipelineId: string): PipelineCatalogEntry | null;
  getRenderingType(renderingTypeId: string): RenderingTypeDefinition | null;
  getAllPipelineIds(): string[];
}

export class PipelineDocService {
  constructor(private readonly catalogReader: PipelineCatalogReader = pipelineSkillLoader) {}

  getTeachingContent(pipelineId: string): PipelineTeachingContent | null {
    const entry = this.catalogReader.getPipelineCatalogEntry(pipelineId);
    if (!entry) return null;
    const renderingType = this.catalogReader.getRenderingType(entry.teaching_type_id);
    if (!renderingType) return null;
    const card = renderingType.teaching;
    return {
      title: card.title,
      summary: card.summary,
      mermaidBlocks: [...card.mermaidBlocks],
      threadRoles: card.threadRoles.map((role) => ({...role})),
      keySlices: [...card.keySlices],
      docPath: renderingTypeSource(entry.teaching_type_id),
    };
  }

  getAvailablePipelines(): string[] {
    return [...this.catalogReader.getAllPipelineIds()];
  }

  /** Retained for callers checking whether teaching is available. */
  hasDocument(pipelineId: string): boolean {
    const entry = this.catalogReader.getPipelineCatalogEntry(pipelineId);
    return !!entry && this.catalogReader.getRenderingType(entry.teaching_type_id) !== null;
  }

  /** Cards are projected on each read, so catalog reloads need no cache invalidation. */
  clearCache(): void {}
}

let pipelineDocServiceInstance: PipelineDocService | null = null;

export function getPipelineDocService(): PipelineDocService {
  if (!pipelineDocServiceInstance) {
    pipelineDocServiceInstance = new PipelineDocService();
  }
  return pipelineDocServiceInstance;
}
