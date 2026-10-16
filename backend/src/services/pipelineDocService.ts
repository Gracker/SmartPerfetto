// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

/**
 * Pipeline Documentation Service
 *
 * Parses rendering_pipelines/*.md files to extract teaching content:
 * - Title and summary
 * - Mermaid diagrams
 * - Thread role tables
 * - Key slices
 */

import * as fs from 'fs';
import * as path from 'path';
import { pipelineSkillLoader } from './pipelineSkillLoader';
import type { PipelineCatalogEntry, RenderingTypeDefinition } from './pipelineSkillLoader';

/**
 * Thread role information extracted from documentation
 */
export interface ThreadRole {
  thread: string;
  responsibility: string;
  traceTag?: string;
}

/**
 * Extracted teaching content from a pipeline document
 */
export interface PipelineTeachingContent {
  /** Document title (first # heading) */
  title: string;
  /** Summary paragraph (first content paragraph after title) */
  summary: string;
  /** All Mermaid diagram code blocks */
  mermaidBlocks: string[];
  /** Thread roles extracted from tables */
  threadRoles: ThreadRole[];
  /** Key slice names mentioned in the document */
  keySlices: string[];
  /** Path to the source document */
  docPath: string;
}

export interface PipelineCatalogReader {
  getPipelineCatalogEntry(pipelineId: string): PipelineCatalogEntry | null;
  getRenderingType(renderingTypeId: string): RenderingTypeDefinition | null;
  getAllPipelineIds(): string[];
}

export class PipelineDocService {
  private docsDir: string;
  private cache: Map<string, PipelineTeachingContent> = new Map();

  constructor(
    docsDir?: string,
    private readonly catalogReader: PipelineCatalogReader = pipelineSkillLoader
  ) {
    this.docsDir = docsDir || this.resolveDefaultDocsDir();
  }

  private resolveDefaultDocsDir(): string {
    const candidates = [
      path.resolve(__dirname, '..', 'rendering_pipelines'),
      path.resolve(__dirname, '..', '..', '..', 'docs', 'rendering_pipelines'),
    ];
    return candidates.find((candidate) => fs.existsSync(candidate)) || candidates[0];
  }

  private getDocumentFile(pipelineId: string): string | null {
    const entry = this.catalogReader.getPipelineCatalogEntry(pipelineId);
    if (!entry) return null;
    return this.catalogReader.getRenderingType(entry.teaching_type_id)?.document || null;
  }

  /**
   * Get teaching content for a pipeline type
   */
  getTeachingContent(pipelineId: string): PipelineTeachingContent | null {
    // Check cache first
    if (this.cache.has(pipelineId)) {
      return this.cache.get(pipelineId)!;
    }

    const docFile = this.getDocumentFile(pipelineId);
    if (!docFile) {
      console.warn(`[PipelineDocService] No document mapping for pipeline: ${pipelineId}`);
      return null;
    }

    const docPath = path.join(this.docsDir, docFile);
    if (!fs.existsSync(docPath)) {
      console.warn(`[PipelineDocService] Document not found: ${docPath}`);
      return null;
    }

    try {
      const content = fs.readFileSync(docPath, 'utf-8');
      const parsed = this.parseDocument(content, docFile);
      this.cache.set(pipelineId, parsed);
      return parsed;
    } catch (error: any) {
      console.error(`[PipelineDocService] Error reading ${docPath}:`, error.message);
      return null;
    }
  }

  /**
   * Parse a markdown document and extract teaching content
   */
  private parseDocument(content: string, docPath: string): PipelineTeachingContent {
    return {
      title: this.extractTitle(content),
      summary: this.extractSummary(content),
      mermaidBlocks: this.extractMermaidBlocks(content),
      threadRoles: this.extractThreadRoles(content),
      keySlices: this.extractKeySlices(content),
      docPath: `rendering_pipelines/${docPath}`,
    };
  }

  /**
   * Extract the document title (first # heading)
   */
  private extractTitle(content: string): string {
    const match = content.match(/^#\s+(.+)$/m);
    return match ? match[1].trim() : 'Rendering Pipeline';
  }

  /**
   * Extract the summary (first descriptive paragraph after title)
   *
   * Strategy: Skip NOTE/IMPORTANT/WARNING blocks (usually version info),
   * and extract the first real paragraph that describes the pipeline.
   */
  private extractSummary(content: string): string {
    const lines = content.split('\n');
    let foundTitle = false;
    let summary = '';
    let inNoteBlock = false;
    let inCodeBlock = false;

    for (const line of lines) {
      // Track code blocks
      if (line.startsWith('```')) {
        inCodeBlock = !inCodeBlock;
        continue;
      }
      if (inCodeBlock) continue;

      // Skip title line
      if (!foundTitle && line.startsWith('#')) {
        foundTitle = true;
        continue;
      }

      // Skip empty lines before finding summary
      if (!summary && !line.trim()) {
        continue;
      }

      // Skip NOTE/IMPORTANT/WARNING blocks (they usually contain version info, not content description)
      if (line.match(/^>\s*\[!(NOTE|IMPORTANT|WARNING)\]/)) {
        inNoteBlock = true;
        continue;
      }
      if (inNoteBlock && line.startsWith('>')) {
        continue;
      }
      if (inNoteBlock && !line.startsWith('>')) {
        inNoteBlock = false;
        // Don't use NOTE content as summary, continue looking for real paragraph
      }

      // Skip headings
      if (line.startsWith('#')) {
        if (summary) break;
        continue;
      }

      // Skip tables, lists
      if (line.startsWith('|') || line.startsWith('-') || line.startsWith('*')) {
        if (summary) break;
        continue;
      }

      // Capture regular paragraph (the first descriptive text)
      if (line.trim()) {
        if (!summary) {
          summary = line.trim();
        } else {
          // Continue building the paragraph
          summary += ' ' + line.trim();
          // Stop at sentence end or after reasonable length
          if (summary.endsWith('.') || summary.endsWith('。') || summary.length > 300) {
            break;
          }
        }
      } else if (summary) {
        // Empty line after content = end of paragraph
        break;
      }
    }

    // Limit summary length
    if (summary.length > 500) {
      summary = summary.substring(0, 497) + '...';
    }

    return summary || 'Android rendering pipeline documentation.';
  }

  /**
   * Extract all Mermaid code blocks
   */
  private extractMermaidBlocks(content: string): string[] {
    const blocks: string[] = [];
    const regex = /```mermaid\n([\s\S]*?)```/g;
    let match;

    while ((match = regex.exec(content)) !== null) {
      blocks.push(match[1].trim());
    }

    return blocks;
  }

  /**
   * Extract thread roles from markdown tables
   *
   * Looks for tables with columns like:
   * | 线程名称 | 关键职责 | 常见 Trace 标签 |
   * | Thread | Responsibility | Trace Tag |
   */
  private extractThreadRoles(content: string): ThreadRole[] {
    const roles: ThreadRole[] = [];
    const lines = content.split('\n');

    let inTable = false;
    let threadColIdx = -1;
    let responsibilityColIdx = -1;
    let traceTagColIdx = -1;

    for (const line of lines) {
      // Check if line is a table row
      if (line.trim().startsWith('|') && line.trim().endsWith('|')) {
        const cols = line
          .split('|')
          .map((c) => c.trim())
          .filter((c) => c);

        // Check if this is a header row
        if (!inTable) {
          // Look for thread-related headers
          for (let i = 0; i < cols.length; i++) {
            const col = cols[i].toLowerCase();
            if (
              col.includes('线程') ||
              col.includes('thread') ||
              col === 'participant'
            ) {
              threadColIdx = i;
            } else if (
              col.includes('职责') ||
              col.includes('responsibility') ||
              col.includes('作用') ||
              col.includes('description')
            ) {
              responsibilityColIdx = i;
            } else if (
              col.includes('trace') ||
              col.includes('标签') ||
              col.includes('tag') ||
              col.includes('slice')
            ) {
              traceTagColIdx = i;
            }
          }

          // Check if this looks like a thread roles table
          if (threadColIdx >= 0 && responsibilityColIdx >= 0) {
            inTable = true;
            continue;
          }
        }

        // Skip separator row
        if (inTable && cols.every((c) => c.match(/^[-:]+$/))) {
          continue;
        }

        // Parse data row
        if (inTable && cols.length >= 2) {
          const thread = cols[threadColIdx]?.replace(/\*\*/g, '').trim();
          const responsibility = cols[responsibilityColIdx]?.replace(/\*\*/g, '').trim();
          const traceTag =
            traceTagColIdx >= 0
              ? cols[traceTagColIdx]?.replace(/`/g, '').trim()
              : undefined;

          if (thread && responsibility) {
            roles.push({
              thread,
              responsibility,
              traceTag: traceTag || undefined,
            });
          }
        }
      } else if (inTable) {
        // End of table
        inTable = false;
        threadColIdx = -1;
        responsibilityColIdx = -1;
        traceTagColIdx = -1;
      }
    }

    return roles;
  }

  /**
   * Extract key slice names from the document
   *
   * Looks for:
   * - Slice names in backticks: `DrawFrame`
   * - Trace tags: *Trace*: `sliceName`
   */
  private extractKeySlices(content: string): string[] {
    const slices = new Set<string>();

    // Known key slices to look for
    const knownSlices = [
      'DrawFrame',
      'syncFrameState',
      'Choreographer#doFrame',
      'queueBuffer',
      'dequeueBuffer',
      'applyTransaction',
      'setTransactionState',
      'latchBuffer',
      'handleMessageRefresh',
      'handleMessageInvalidate',
      'BLASTBufferQueue',
      'eglSwapBuffers',
      'vkQueuePresent',
      'vkQueuePresentKHR',
      'lockCanvas',
      'unlockCanvasAndPost',
      'updateTexImage',
      'DrawGL',
      'DrawFunctor',
      'Engine::BeginFrame',
      'Rasterizer',
      'EntityPass',
      'SkGpu',
    ];

    // Extract from backticks
    const backtickRegex = /`([A-Za-z_#:]+(?:\*)?)`/g;
    let match;
    while ((match = backtickRegex.exec(content)) !== null) {
      const slice = match[1];
      // Filter for likely slice names
      if (
        slice.length > 3 &&
        slice.length < 50 &&
        !slice.includes(' ') &&
        (slice.includes('Frame') ||
          slice.includes('Buffer') ||
          slice.includes('Transaction') ||
          slice.includes('Sync') ||
          slice.includes('Draw') ||
          slice.includes('latch') ||
          slice.includes('queue') ||
          slice.includes('egl') ||
          slice.includes('vk') ||
          slice.includes('Choreographer') ||
          knownSlices.includes(slice))
      ) {
        slices.add(slice);
      }
    }

    // Also add any known slices found in text
    for (const known of knownSlices) {
      if (content.includes(known)) {
        slices.add(known);
      }
    }

    return Array.from(slices).slice(0, 20); // Limit to top 20
  }

  /**
   * Get all available pipeline types
   */
  getAvailablePipelines(): string[] {
    return this.catalogReader.getAllPipelineIds();
  }

  /**
   * Check if a document exists for a pipeline type
   */
  hasDocument(pipelineId: string): boolean {
    const docFile = this.getDocumentFile(pipelineId);
    if (!docFile) return false;

    const docPath = path.join(this.docsDir, docFile);
    return fs.existsSync(docPath);
  }

  /**
   * Clear the cache
   */
  clearCache(): void {
    this.cache.clear();
  }
}

// Singleton instance
let pipelineDocServiceInstance: PipelineDocService | null = null;

export function getPipelineDocService(): PipelineDocService {
  if (!pipelineDocServiceInstance) {
    pipelineDocServiceInstance = new PipelineDocService();
  }
  return pipelineDocServiceInstance;
}
