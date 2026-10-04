// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

/**
 * Run-local state and closed contract of the document-collection knowledge
 * tools (`search_knowledge`, `read_knowledge_section`). Knowledge is
 * background the owner selected, never trace evidence: its references live in
 * their own `kref-` namespace, which no claim or source binding can resolve.
 */

import {randomUUID} from 'crypto';

import {isExternalKnowledgeSourceId} from '../externalKnowledgeSourceRegistry';

export const KNOWLEDGE_TOOL_NAMES: ReadonlySet<string> = new Set(['search_knowledge', 'read_knowledge_section']);

/**
 * What a knowledge tool refusal asks the model to do instead. Closed product
 * tokens, never derived from document content, so the external projection may
 * carry them across its boundary.
 */
export const KNOWLEDGE_REFUSAL_ACTIONS = {
  /** A knowledge base id outside this run's selected document collections. */
  unauthorizedKnowledgeBase: 'use_authorized_knowledge_base_id',
  /** A reference id this run never issued. */
  unknownReference: 'use_reference_id_from_search_knowledge',
  /** A part beyond the section's part count. */
  partOutOfRange: 'retry_with_part_within_part_count',
  /** The run's knowledge calls or tokens are used up. */
  budgetExhausted: 'continue_with_existing_knowledge',
  /** An evaluation run excluded this knowledge. */
  evaluationFiltered: 'continue_without_filtered_knowledge',
} as const;

const KNOWLEDGE_REFUSAL_ACTION_VALUES: ReadonlySet<string> = new Set(Object.values(KNOWLEDGE_REFUSAL_ACTIONS));

/** True only for an action the knowledge tools issue; anything else is not projected. */
export function isKnowledgeRefusalAction(value: unknown): value is string {
  return typeof value === 'string' && KNOWLEDGE_REFUSAL_ACTION_VALUES.has(value);
}

const KNOWLEDGE_REFERENCE_PREFIX = 'kref-';

/** Where an issued reference points: one search hit of one pinned generation, in one access scope. */
export interface KnowledgeReferenceBinding {
  scopeKey: string;
  sourceId: string;
  generation: string;
  sectionId: string;
  chunkId: string;
  /** The document's path relative to its collection, as delivered with the hit. */
  relativePath: string;
  /** The search hit's own source lines; a read reports the whole section's. */
  lineRange: {start: number; end: number};
  /** The delivered excerpt was the hit's whole text, so its lines were delivered in full. */
  excerptComplete: boolean;
}

interface DeliveredPart {
  partCount: number;
  truncated: boolean;
}

/** One section a read delivered parts of, through the reference first used to read it. */
interface DeliveredSection {
  referenceId: string;
  binding: KnowledgeReferenceBinding;
  sectionRange: {start: number; end: number};
  partCount: number;
  /** Delivered part numbers, each with whether the budget cut it. */
  parts: Map<number, boolean>;
}

/**
 * Lines of one document this run delivered to the model: a search hit's lines
 * (whole only when its excerpt was its whole text) or a section a read
 * delivered (whole only when every part arrived uncut). Knowledge citations in
 * the answer are graded against these, never against lines that were only located.
 */
export interface KnowledgeDeliveredLocation {
  referenceId: string;
  knowledgeBaseId: string;
  generation: string;
  relativePath: string;
  lineRange: {start: number; end: number};
  bodyDelivered: boolean;
}

/**
 * The references one run issued and the section parts it delivered. It lives
 * with the run's MCP server, so a reference never resolves in another run,
 * session or workspace. Ids are random: knowing one reveals nothing and a
 * guessed one resolves to nothing.
 */
export class KnowledgeReferenceLedger {
  private readonly bindings = new Map<string, KnowledgeReferenceBinding>();
  private readonly idsByHit = new Map<string, string>();
  private readonly sections = new Map<string, DeliveredSection>();

  /** The reference for a hit actually returned to the model; the same hit keeps its id. */
  issue(binding: KnowledgeReferenceBinding): string {
    const hitKey = [binding.scopeKey, binding.sourceId, binding.generation, binding.chunkId].join('\0');
    const existing = this.idsByHit.get(hitKey);
    if (existing) return existing;
    const id = `${KNOWLEDGE_REFERENCE_PREFIX}${randomUUID()}`;
    this.bindings.set(id, Object.freeze({...binding, lineRange: Object.freeze({...binding.lineRange})}));
    this.idsByHit.set(hitKey, id);
    return id;
  }

  resolve(id: string): KnowledgeReferenceBinding | undefined {
    return this.bindings.get(id);
  }

  /** A part of this section this run already delivered, through any reference to it. */
  deliveredPart(binding: KnowledgeReferenceBinding, part: number): DeliveredPart | undefined {
    const section = this.sections.get(sectionKey(binding));
    const truncated = section?.parts.get(part);
    return truncated === undefined ? undefined : {partCount: section!.partCount, truncated};
  }

  recordDelivered(
    referenceId: string,
    binding: KnowledgeReferenceBinding,
    part: number,
    delivered: DeliveredPart & {sectionRange: {start: number; end: number}},
  ): void {
    const key = sectionKey(binding);
    const section = this.sections.get(key) ?? {referenceId, binding, partCount: delivered.partCount,
      sectionRange: Object.freeze({...delivered.sectionRange}), parts: new Map<number, boolean>()};
    section.parts.set(part, delivered.truncated);
    this.sections.set(key, section);
  }

  /** How many references this run delivered from each knowledge base. */
  deliveredReferenceCounts(): Map<string, {generation: string; count: number}> {
    const counts = new Map<string, {generation: string; count: number}>();
    for (const binding of this.bindings.values()) {
      const entry = counts.get(binding.sourceId) ?? {generation: binding.generation, count: 0};
      entry.count += 1;
      counts.set(binding.sourceId, entry);
    }
    return counts;
  }

  /** Every location this run delivered, search hits first, then the sections it read. */
  deliveredLocations(): KnowledgeDeliveredLocation[] {
    const hits = [...this.bindings].map(([referenceId, binding]) => ({
      referenceId, knowledgeBaseId: binding.sourceId, generation: binding.generation,
      relativePath: binding.relativePath, lineRange: {...binding.lineRange}, bodyDelivered: binding.excerptComplete,
    }));
    const sections = [...this.sections.values()].map(section => {
      let whole = section.parts.size === section.partCount;
      for (const truncated of section.parts.values()) whole &&= !truncated;
      return {
        referenceId: section.referenceId, knowledgeBaseId: section.binding.sourceId,
        generation: section.binding.generation, relativePath: section.binding.relativePath,
        lineRange: {...section.sectionRange}, bodyDelivered: whole,
      };
    });
    return [...hits, ...sections];
  }
}

function sectionKey(binding: KnowledgeReferenceBinding): string {
  return [binding.scopeKey, binding.sourceId, binding.generation, binding.sectionId].join('\0');
}

/** `end`, moved back one when it would split a surrogate pair. */
export function safeSliceEnd(text: string, end: number): number {
  return end > 0 && end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1] ?? '') ? end - 1 : end;
}

/**
 * A section's text in deterministic parts of at most `partChars` characters.
 * A part ends at the last line break in its second half when there is one,
 * and never between the two halves of a surrogate pair. The same body always
 * yields the same parts, so a part number names the same text on every read.
 */
export function splitKnowledgeSection(body: string, partChars: number): string[] {
  const limit = Math.max(2, Math.trunc(partChars));
  const parts: string[] = [];
  let start = 0;
  while (start < body.length) {
    let end = Math.min(body.length, start + limit);
    if (end < body.length) {
      const lineBreak = body.lastIndexOf('\n', end - 1);
      end = lineBreak >= start + Math.floor(limit / 2) ? lineBreak + 1 : safeSliceEnd(body, end);
    }
    parts.push(body.slice(start, end));
    start = end;
  }
  return parts.length > 0 ? parts : [''];
}

/** A knowledge tool result's variant, when every field its production contract delivers is present and typed. */
export type KnowledgeResultShape =
  | {variant: 'search'; knowledgeBaseIds: string[]}
  | {variant: 'read'; knowledgeBaseId: string; part: number; partCount: number}
  | {variant: 'already_delivered'; knowledgeBaseId: string; part: number; partCount: number};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function positiveInteger(value: unknown): number | undefined {
  return Number.isSafeInteger(value) && Number(value) > 0 ? Number(value) : undefined;
}

/** An issued reference and the knowledge base it names; the full form also carries its location. */
function referenceBase(value: unknown, full: boolean): string | undefined {
  if (!isRecord(value) || typeof value.id !== 'string' || !value.id.startsWith(KNOWLEDGE_REFERENCE_PREFIX) ||
    !isExternalKnowledgeSourceId(value.knowledgeBaseId)) return undefined;
  if (!full) return value.knowledgeBaseId;
  const range = value.lineRange;
  const located = typeof value.title === 'string' && typeof value.relativePath === 'string' &&
    Array.isArray(value.headingPath) && value.headingPath.every(heading => typeof heading === 'string') &&
    isRecord(range) && positiveInteger(range.start) !== undefined && positiveInteger(range.end) !== undefined &&
    Number(range.end) >= Number(range.start);
  return located ? value.knowledgeBaseId : undefined;
}

/**
 * The one shape check for knowledge tool results, shared by the outward
 * projection and the owner's narration: a success needs an explicit
 * `success: true`, every field its variant delivers, and its optional flags
 * (`truncated`, `budgetExhausted`, `alreadyDelivered`, `budget`) well typed;
 * anything else is not a success, and nothing may narrate or project it as one.
 */
export function knowledgeResultShape(toolName: string, value: unknown): KnowledgeResultShape | undefined {
  if (!isRecord(value) || value.success !== true) return undefined;
  // Optional flags, when present, carry their one meaning.
  for (const flag of ['truncated', 'budgetExhausted', 'alreadyDelivered'] as const) {
    if (value[flag] !== undefined && value[flag] !== true) return undefined;
  }
  if (value.budget !== undefined && !isRecord(value.budget)) return undefined;
  if (toolName === 'search_knowledge') {
    if (!Array.isArray(value.hits)) return undefined;
    const bases = value.hits.map(hit => isRecord(hit) && typeof hit.excerpt === 'string'
      ? referenceBase(hit, true) : undefined);
    if (bases.some(base => base === undefined)) return undefined;
    return {variant: 'search', knowledgeBaseIds: [...new Set(bases as string[])]};
  }
  if (toolName !== 'read_knowledge_section') return undefined;
  const part = positiveInteger(value.part);
  const partCount = positiveInteger(value.partCount);
  if (!part || !partCount || part > partCount) return undefined;
  if (value.alreadyDelivered === true) {
    const knowledgeBaseId = referenceBase(value.reference, false);
    return knowledgeBaseId ? {variant: 'already_delivered', knowledgeBaseId, part, partCount} : undefined;
  }
  const knowledgeBaseId = typeof value.text === 'string' ? referenceBase(value.reference, true) : undefined;
  return knowledgeBaseId ? {variant: 'read', knowledgeBaseId, part, partCount} : undefined;
}
