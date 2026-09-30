// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

/**
 * Conclusion contract derivation and conclusion-output normalization.
 *
 * Parses a runtime's final conclusion (typed JSON, legacy JSON-like sections or
 * Markdown) into a ConclusionContract and repairs JSON-shaped conclusion text
 * into readable Markdown.
 */

import type {
  ConclusionClusterFrameListMode,
  ConclusionClusterOutputMode,
  ConclusionClaimKind,
  ConclusionClaimSupportLevel,
  ConclusionContract,
  ConclusionContractClaimItem,
  ConclusionContractClaimReference,
  ConclusionContractClusterItem,
  ConclusionContractClusterPolicy,
  ConclusionContractConclusionItem,
  ConclusionContractEvidenceItem,
  ConclusionContractMetadata,
  ConclusionOutputMode,
} from './conclusionContract';
import {parseConclusionContractSidecar, parseTypedConclusionContractJson,
  hasConclusionContractDeclarations,
  parseDeclaredConclusionClaims, parseDeclaredRelationProposals,
} from './conclusionContract';
import {
  buildTriadStatement,
  hasTriadRoleText,
  parseTriadParts,
} from '../../utils/analysisNarrative';
import {sanitizeConclusionSourceContract} from '../../services/codebase/sourceClaimVerifier';

type EvidenceObject = {
  evidenceId?: unknown;
  evidence_id?: unknown;
  title?: unknown;
  kind?: unknown;
  description?: unknown;
  summary?: unknown;
};
const DEFAULT_TOP_CLUSTER_FRAME_RENDER_LIMIT = 5;
const DEFAULT_FULL_CLUSTER_FRAME_RENDER_LIMIT = 120;

function asEvidenceObject(value: unknown): EvidenceObject | null {
  if (!value || typeof value !== 'object') {
    return null;
  }

  return value as EvidenceObject;
}

function resolveClusterFrameLimit(
  mode: ConclusionClusterFrameListMode,
  maxFramesPerCluster?: number
): number {
  if (mode === 'none') return 0;
  if (Number.isFinite(maxFramesPerCluster) && (maxFramesPerCluster || 0) > 0) {
    return Math.round(maxFramesPerCluster as number);
  }
  return mode === 'top'
    ? DEFAULT_TOP_CLUSTER_FRAME_RENDER_LIMIT
    : DEFAULT_FULL_CLUSTER_FRAME_RENDER_LIMIT;
}

function applyClusterFrameListMode(
  frameIds: string[],
  mode: ConclusionClusterFrameListMode,
  maxFramesPerCluster?: number
): { frameIds: string[]; omittedCount: number } {
  if (mode === 'none') return { frameIds: [], omittedCount: 0 };
  const limit = resolveClusterFrameLimit(mode, maxFramesPerCluster);
  const selected = frameIds.slice(0, limit);
  return {
    frameIds: selected,
    omittedCount: Math.max(0, frameIds.length - selected.length),
  };
}

function parseNumberFromUnknown(raw: unknown): number | undefined {
  const value = readNumberValue(raw);
  return Number.isFinite(value) ? value : undefined;
}

function clampPercent(raw: number | undefined): number | undefined {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return undefined;
  // Use strict < 1 so that exactly 1 is treated as "1%" not "100%".
  // LLM may output confidence on 0-1 scale (e.g. 0.85) or 0-100 scale (e.g. 85).
  if (raw > 0 && raw < 1) return Math.max(0, Math.min(100, raw * 100));
  return Math.max(0, Math.min(100, raw));
}

function normalizeConclusionId(id: string, fallbackRank: number): string {
  const text = String(id || '').trim();
  if (!text) return `C${fallbackRank}`;
  const m = text.match(/C?\s*(\d+)/i);
  if (m) return `C${Math.max(1, Number(m[1]))}`;
  return `C${fallbackRank}`;
}

function stripJsonCodeFence(text: string): string {
  return String(text || '')
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();
}

function extractFirstJsonObject(text: string): string | null {
  const source = String(text || '');
  const start = source.indexOf('{');
  if (start < 0) return null;

  let depth = 0;
  let inString = false;
  let escaping = false;
  for (let i = start; i < source.length; i += 1) {
    const ch = source[i];
    if (inString) {
      if (escaping) {
        escaping = false;
      } else if (ch === '\\') {
        escaping = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === '{') {
      depth += 1;
      continue;
    }
    if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        return source.slice(start, i + 1);
      }
    }
  }

  return null;
}

function toRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function toStringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value
      .map(v => stripBulletPrefix(String(v || '').trim()))
      .filter(Boolean);
  }
  if (typeof value === 'string') {
    const line = stripBulletPrefix(value.trim());
    return line ? [line] : [];
  }
  return [];
}

function parseConclusionItemFromRecord(
  record: Record<string, unknown>,
  fallbackRank: number
): ConclusionContractConclusionItem | null {
  const trigger = readSemanticText(record, 'trigger');
  const supply = readSemanticText(record, 'supply');
  const amplification = readSemanticText(record, 'amplification');
  const statement = readSemanticText(record, 'statement');
  const rank = Math.round(parseNumberFromUnknown(readValueFromAliases(record, ['rank', 'order', 'index', '序号', '编号'])) || fallbackRank);
  const confidencePercent = clampPercent(readSemanticNumber(record, 'confidence'));

  let resolvedStatement = statement;
  if (!resolvedStatement && (trigger || supply || amplification)) {
    resolvedStatement = buildTriadStatement({
      ...(trigger ? { trigger } : {}),
      ...(supply ? { supply } : {}),
      ...(amplification ? { amplification } : {}),
    });
  }

  if (!resolvedStatement) return null;

  return {
    rank: Number.isFinite(rank) && rank > 0 ? rank : fallbackRank,
    statement: resolvedStatement,
    confidencePercent,
    trigger: trigger || undefined,
    supply: supply || undefined,
    amplification: amplification || undefined,
  };
}

function parseClusterItemFromRecord(record: Record<string, unknown>): ConclusionContractClusterItem | null {
  const cluster = readSemanticText(record, 'cluster_label');
  const description = readSemanticText(record, 'cluster_description');
  const rank = readSemanticNumber(record, 'cluster_rank');
  const rankPrefix = typeof rank === 'number' && rank > 0 ? `K${Math.round(rank)}` : '';
  const frames = parseNumberFromUnknown(readSemanticNumber(record, 'cluster_frames'));
  const percentage = parseNumberFromUnknown(readSemanticNumber(record, 'cluster_percentage'));
  const frameRefs = parseClusterFrameRefs(record);

  let resolvedCluster = cluster;
  if (!resolvedCluster && rankPrefix) resolvedCluster = rankPrefix;
  if (!resolvedCluster && !description) return null;
  if (!resolvedCluster && description) resolvedCluster = description;
  if (resolvedCluster && rankPrefix && !new RegExp(`^${rankPrefix}\\b`, 'i').test(resolvedCluster)) {
    resolvedCluster = `${rankPrefix}: ${resolvedCluster}`;
  }

  return {
    cluster: resolvedCluster || '',
    description: description || undefined,
    frames: typeof frames === 'number' && frames > 0 ? frames : undefined,
    percentage: typeof percentage === 'number' ? percentage : undefined,
    frameRefs: frameRefs.length > 0 ? frameRefs : undefined,
  };
}

function parseFrameRefsFromUnknown(raw: unknown): string[] {
  if (Array.isArray(raw)) {
    return Array.from(new Set(raw.map((v: unknown) => String(v).trim()).filter(Boolean)));
  }
  if (typeof raw !== 'string') {
    return [];
  }
  const text = raw.trim();
  if (!text) return [];
  const normalized = text.replace(/[（(]\s*其余\s*\d+\s*帧省略\s*[）)]/g, '').trim();
  const tokens = normalized.split(/[\/|,，;；\s]+/g)
    .map(t => t.trim())
    .filter(Boolean)
    .filter(t => /^\d{3,}$/.test(t));
  return Array.from(new Set(tokens));
}

function parseClusterFrameRefs(record: Record<string, unknown>): string[] {
  const direct = readValueFromAliases(record, [
    'frameRefs',
    'frame_refs',
    'frameIds',
    'frame_ids',
    'cluster_frame_refs',
    'clusterFrameRefs',
    'cluster_frames_list',
    'clusterFramesList',
    '聚合帧',
    '帧列表',
    '帧ID列表',
  ]);
  const directRefs = parseFrameRefsFromUnknown(direct);
  if (directRefs.length > 0) return directRefs;

  const clusterDescription = readSemanticText(record, 'cluster_description');
  return parseFrameRefsFromUnknown(clusterDescription);
}

function parseEvidenceItemsFromRecord(record: Record<string, unknown>, fallbackRank: number): ConclusionContractEvidenceItem[] {
  const conclusionId = normalizeConclusionId(readSemanticText(record, 'conclusion_id'), fallbackRank);
  const evidenceTexts = extractEvidenceTextsFromJsonLikeObject(record);
  if (evidenceTexts.length === 0) return [];
  return evidenceTexts.map(text => ({ conclusionId, text }));
}

function parseClaimScalar(value: unknown): string | number | boolean | undefined {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'string') return undefined;
  const text = String(value).trim();
  if (!text) return undefined;
  if (/^(true|false)$/i.test(text)) return /^true$/i.test(text);
  if (/^[+-]?(?:(?:\d+(?:\.\d*)?)|(?:\.\d+))(?:e[+-]?\d+)?$/i.test(text)) {
    const parsed = Number(text);
    if (Number.isFinite(parsed)) return parsed;
  }
  return text;
}

function parseClaimRowSelector(value: unknown): Record<string, string | number | boolean> | undefined {
  let record = toRecord(value);
  if (!record && typeof value === 'string') {
    const text = value.trim();
    if (text.startsWith('{')) {
      try {
        record = toRecord(JSON.parse(text));
      } catch {
        record = null;
      }
    } else {
      const parsed: Record<string, string | number | boolean> = {};
      for (const part of text.split(/\s+(?:AND|and)\s+|[,，]/)) {
        const match = part.trim().match(/^([^=：:]+)\s*(?:=|:|：)\s*(.+)$/);
        if (!match) continue;
        const key = match[1].trim();
        const parsedValue = parseClaimScalar(match[2].trim().replace(/^['"]|['"]$/g, ''));
        if (!key || parsedValue === undefined) continue;
        parsed[key] = parsedValue;
      }
      return Object.keys(parsed).length > 0 ? parsed : undefined;
    }
  }
  if (!record) return undefined;

  const selector: Record<string, string | number | boolean> = {};
  for (const [key, rawValue] of Object.entries(record)) {
    const normalizedKey = String(key || '').trim();
    const parsedValue = parseClaimScalar(rawValue);
    if (!normalizedKey || parsedValue === undefined) continue;
    selector[normalizedKey] = parsedValue;
  }
  return Object.keys(selector).length > 0 ? selector : undefined;
}

function splitClaimList(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  return String(value)
    .split(/[,，]/)
    .map(item => item.trim())
    .filter(Boolean);
}

function parseClaimRowIndices(value: unknown): number[] {
  if (value === undefined || value === null || value === '') return [];
  if (typeof value === 'number' && Number.isInteger(value) && value >= 0) return [value];
  const text = String(value).trim();
  const range = text.match(/^(\d+)\s*(?:-|\.\.|~|至|到)\s*(\d+)$/);
  if (range) {
    const start = Number(range[1]);
    const end = Number(range[2]);
    if (Number.isInteger(start) && Number.isInteger(end) && start >= 0 && end >= start && end - start <= 50) {
      return Array.from({ length: end - start + 1 }, (_, index) => start + index);
    }
  }
  const parsed = parseNumberFromUnknown(value);
  return parsed !== undefined && Number.isInteger(parsed) && parsed >= 0 ? [parsed] : [];
}

function parseClaimTupleValues(
  rawValue: unknown,
  rowCount: number,
  columnCount: number,
): unknown[][] {
  if (rawValue === undefined) return [];
  if (rowCount > 1) {
    const rowGroups = splitClaimList(rawValue);
    if (rowGroups.length === rowCount) {
      return rowGroups.map(group => {
        const slashParts = String(group)
          .split('/')
          .map(item => item.trim())
          .filter(Boolean);
        if (columnCount > 1 && slashParts.length === columnCount) {
          return slashParts.map(parseClaimScalar);
        }
        return [parseClaimScalar(group)];
      });
    }
  }

  if (columnCount > 1) {
    const values = splitClaimList(rawValue);
    if (values.length >= columnCount) {
      const normalizedValues = values.length === columnCount
        ? values
        : [
            ...values.slice(0, columnCount - 1),
            values.slice(columnCount - 1).join(', '),
          ];
      return [normalizedValues.map(parseClaimScalar)];
    }
  }

  return [[parseClaimScalar(rawValue)]];
}

function parseClaimReferencesFromRecord(record: Record<string, unknown>): ConclusionContractClaimReference[] {
  const evidenceRefId = String(readValueFromAliases(record, [
    'evidenceRefId', 'evidence_ref_id', 'evidenceId', 'evidence_id',
  ]) || '').trim();
  const sourceRef = String(readValueFromAliases(record, [
    'sourceRef', 'source_ref', 'ref',
  ]) || '').trim();
  const sourceToolCallId = String(readValueFromAliases(record, [
    'sourceToolCallId', 'source_tool_call_id', 'toolCallId', 'tool_call_id',
  ]) || '').trim();
  const rowIndexRaw = readValueFromAliases(record, ['rowIndex', 'row_index']);
  const rowIndices = parseClaimRowIndices(rowIndexRaw);
  const rowSelector = parseClaimRowSelector(readValueFromAliases(record, ['rowSelector', 'row_selector']));
  const columnRaw = readValueFromAliases(record, ['column', 'col']);
  const columns = splitClaimList(columnRaw);
  const rawValue = readValueFromAliases(record, ['value']);
  const artifactId = String(readValueFromAliases(record, ['artifactId', 'artifact_id']) || '').trim();
  const sourceArtifactId = String(readValueFromAliases(record, ['sourceArtifactId', 'source_artifact_id']) || '').trim();

  if (!evidenceRefId && !sourceRef && !sourceToolCallId && !artifactId && !sourceArtifactId) return [];

  const base = {
    ...(evidenceRefId ? { evidenceRefId } : {}),
    ...(sourceRef ? { sourceRef } : {}),
    ...(sourceToolCallId ? { sourceToolCallId } : {}),
    ...(artifactId ? { artifactId } : {}),
    ...(sourceArtifactId ? { sourceArtifactId } : {}),
  };

  const rowTargets = rowIndices.length > 0 ? rowIndices : [undefined];
  const columnTargets = columns.length > 0 ? columns : [undefined];
  const tupleValues = parseClaimTupleValues(rawValue, rowTargets.length, columnTargets.length);
  const refs: ConclusionContractClaimReference[] = [];

  rowTargets.forEach((rowIndex, rowOffset) => {
    columnTargets.forEach((column, columnOffset) => {
      const value = tupleValues[rowOffset]?.[columnOffset]
        ?? (rowTargets.length === 1 ? tupleValues[0]?.[columnOffset] : undefined);
      refs.push({
        ...base,
        ...(rowIndex !== undefined ? { rowIndex } : {}),
        ...(rowSelector ? { rowSelector } : {}),
        ...(column ? { column } : {}),
        ...(value !== undefined ? { value: value as string | number | boolean } : {}),
      });
    });
  });

  return refs;
}

function parseClaimKind(value: unknown): ConclusionClaimKind | undefined {
  const normalized = String(value || '').trim();
  const allowed: ConclusionClaimKind[] = [
    'numeric',
    'categorical',
    'time_range',
    'identity',
    'causal',
    'comparison',
    'inference',
    'recommendation',
  ];
  return allowed.includes(normalized as ConclusionClaimKind)
    ? normalized as ConclusionClaimKind
    : undefined;
}

function parseClaimSupportLevel(value: unknown): ConclusionClaimSupportLevel | undefined {
  const normalized = String(value || '').trim();
  const allowed: ConclusionClaimSupportLevel[] = ['verified', 'partial', 'inference', 'unsupported'];
  return allowed.includes(normalized as ConclusionClaimSupportLevel)
    ? normalized as ConclusionClaimSupportLevel
    : undefined;
}

function parseStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out = value
    .map(item => String(item || '').trim())
    .filter(Boolean);
  return out.length > 0 ? Array.from(new Set(out)) : undefined;
}

function parseClaimArtifactRefs(value: unknown): Array<{ artifactId: string; rowIndex?: number; rowSelector?: Record<string, unknown> }> | undefined {
  if (!Array.isArray(value)) return undefined;
  const refs = value
    .map(item => toRecord(item))
    .filter((item): item is Record<string, unknown> => Boolean(item))
    .map(item => {
      const artifactId = String(readValueFromAliases(item, [
        'artifactId',
        'artifact_id',
        'sourceArtifactId',
        'source_artifact_id',
      ]) || '').trim();
      if (!artifactId) return undefined;
      const rowIndex = parseNumberFromUnknown(readValueFromAliases(item, ['rowIndex', 'row_index']));
      const rowSelector = toRecord(readValueFromAliases(item, ['rowSelector', 'row_selector'])) || undefined;
      return {
        artifactId,
        ...(rowIndex !== undefined ? { rowIndex } : {}),
        ...(rowSelector ? { rowSelector } : {}),
      };
    })
    .filter((item): item is { artifactId: string; rowIndex?: number; rowSelector?: Record<string, unknown> } => Boolean(item));
  return refs.length > 0 ? refs : undefined;
}

function parseClaimItemsFromUnknown(value: unknown): ConclusionContractClaimItem[] {
  if (!Array.isArray(value)) return [];

  const claims: ConclusionContractClaimItem[] = [];
  value.forEach((item, idx) => {
    const record = toRecord(item);
    if (!record) return;

    const referencesSource = readValueFromAliases(record, [
      'references', 'refs', 'evidenceRefs', 'evidence_refs',
    ]);
    const references = Array.isArray(referencesSource)
      ? referencesSource
          .map(ref => toRecord(ref))
          .filter((ref): ref is Record<string, unknown> => Boolean(ref))
          .flatMap(ref => parseClaimReferencesFromRecord(ref))
      : [];
    const artifactRefs = parseClaimArtifactRefs(readValueFromAliases(record, ['artifactRefs', 'artifact_refs']));
    const claimId = String(readValueFromAliases(record, ['id', 'claimId', 'claim_id']) || '').trim();
    const conclusionId = normalizeConclusionId(
      String(readValueFromAliases(record, ['conclusionId', 'conclusion_id', 'conclusion']) || '').trim(),
      idx + 1
    );
    const text = String(readValueFromAliases(record, ['text', 'statement', 'claim']) || '').trim();
    if (!text) return;
    const kind = parseClaimKind(readValueFromAliases(record, ['kind', 'claimKind', 'claim_kind']));
    const supportLevel = parseClaimSupportLevel(readValueFromAliases(record, ['supportLevel', 'support_level']));
    const relationRefs = parseStringArray(readValueFromAliases(record, ['relationRefs', 'relation_refs']));

    claims.push({
      ...(claimId ? { id: claimId } : {}),
      conclusionId,
      text,
      ...(kind ? { kind } : {}),
      references,
      ...(artifactRefs ? { artifactRefs } : {}),
      ...(relationRefs ? { relationRefs } : {}),
      ...(supportLevel ? { supportLevel } : {}),
    });
  });
  return claims;
}

function parseClaimReferencesFromMarkdownLine(line: string): ConclusionContractClaimReference[] {
  const identifierKeys = new Set([
    'evidence_ref_id',
    'evidenceRefId',
    'evidence_id',
    'evidenceId',
    'source_ref',
    'sourceRef',
    'ref',
    'source_tool_call_id',
    'sourceToolCallId',
    'tool_call_id',
    'toolCallId',
    'artifact_id',
    'artifactId',
    'source_artifact_id',
    'sourceArtifactId',
  ]);
  const localKeys = new Set(['row_index', 'rowIndex', 'row_selector', 'rowSelector', 'column', 'col', 'value']);
  const base: Record<string, unknown> = {};
  const groups: Record<string, unknown>[] = [];
  let current: Record<string, unknown> = {};

  const flush = () => {
    if (Object.keys(current).length === 0) return;
    groups.push({ ...base, ...current });
    current = {};
  };

  for (const part of String(line || '').split(';')) {
    const match = part.trim().match(/^([a-zA-Z_]+)\s*=\s*(.*)$/);
    if (!match) continue;
    const key = match[1];
    const value = match[2].trim();
    if (identifierKeys.has(key)) {
      base[key] = value;
      continue;
    }
    if (
      localKeys.has(key) &&
      (Object.prototype.hasOwnProperty.call(current, key)
        || ((key === 'row_index' || key === 'rowIndex' || key === 'row_selector' || key === 'rowSelector')
          && (current.column !== undefined || current.col !== undefined || current.value !== undefined))
        || ((key === 'column' || key === 'col') && current.value !== undefined))
    ) {
      flush();
    }
    current[key] = value;
  }
  flush();
  if (groups.length === 0 && Object.keys(base).length > 0) groups.push({ ...base });
  return groups.flatMap(group => parseClaimReferencesFromRecord(group));
}

function parseClaimItemsFromMarkdownSection(sectionBody: string): ConclusionContractClaimItem[] {
  const claims: ConclusionContractClaimItem[] = [];
  let current: ConclusionContractClaimItem | null = null;

  const flush = () => {
    // Missing evidence is a verification result, not a reason to erase a claim.
    if (current) claims.push(current);
    current = null;
  };

  for (const rawLine of String(sectionBody || '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const claimMatch = line.match(/^[-*]\s+([^:：]+)\s*[:：]\s*(.+)$/);
    if (claimMatch && !/=/.test(claimMatch[1])) {
      flush();
      const idPart = claimMatch[1].trim();
      const [claimIdRaw, conclusionIdRaw] = idPart.split('/').map(part => part.trim());
      current = {
        ...(claimIdRaw ? { id: claimIdRaw } : {}),
        ...(conclusionIdRaw ? { conclusionId: normalizeConclusionId(conclusionIdRaw, claims.length + 1) } : {}),
        text: stripBulletPrefix(claimMatch[2].trim()),
        references: [],
      };
      continue;
    }

    const refLine = line.replace(/^[-*]\s+/, '').trim();
    const refs = parseClaimReferencesFromMarkdownLine(refLine);
    if (refs.length > 0) {
      if (!current) {
        current = {
          id: `Q${claims.length + 1}`,
          text: `claim ${claims.length + 1}`,
          references: [],
        };
      }
      current.references.push(...refs);
    }
  }
  flush();
  return claims;
}

function extractListEntriesFromSectionBody(body: string): string[] {
  const entries: string[] = [];
  for (const rawLine of String(body || '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const bullet = line.match(/^(?:[-*]|\d+\.)\s+(.+)$/);
    if (bullet) {
      const text = stripBulletPrefix(bullet[1].trim());
      if (text) entries.push(text);
      continue;
    }
    entries.push(stripBulletPrefix(line));
  }
  return entries.filter(Boolean);
}

function parseConclusionConfidenceFromStatement(statement: string): { statement: string; confidencePercent?: number } {
  const raw = String(statement || '')
    .trim()
    .replace(/[·]\s*$/, '')
    .trim();
  if (!raw) return { statement: raw };

  const m = raw.match(/[（(]\s*置信度\s*[:：]?\s*(\d+(?:\.\d+)?)\s*%?\s*[）)]/i);
  if (!m) return { statement: raw };

  const confidence = clampPercent(Number(m[1]));
  const cleaned = raw.replace(m[0], '').trim();
  return { statement: cleaned || raw, confidencePercent: confidence };
}

function parseConclusionItemsFromMarkdownSection(sectionBody: string): ConclusionContractConclusionItem[] {
  const numberedItems: Array<{ index: number; text: string }> = [];
  const bulletFallback: string[] = [];
  const lines = String(sectionBody || '').split(/\r?\n/);

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;

    const mNum = line.match(/^([1-9]\d*)\s*[.)、]\s*(.+)$/);
    if (mNum && Number.isSafeInteger(Number(mNum[1]))) {
      numberedItems.push({ index: Number(mNum[1]), text: mNum[2].trim() });
      continue;
    }

    const mC = line.match(/^C([1-9]\d*)\s*[:：]\s*(.+)$/i);
    if (mC && Number.isSafeInteger(Number(mC[1]))) {
      numberedItems.push({ index: Number(mC[1]), text: mC[2].trim() });
      continue;
    }

    const mBullet = line.match(/^-\s+(.+)$/);
    if (mBullet) {
      bulletFallback.push(mBullet[1].trim());
    }
  }

  const baseItems = numberedItems.length > 0
    ? numberedItems
    : bulletFallback.map((text, idx) => ({ index: idx + 1, text }));

  const triadParts = parseTriadParts(sectionBody || '');

  const items = baseItems.map((item, idx) => {
    const rank = item.index || idx + 1;
    const parsed = parseConclusionConfidenceFromStatement(item.text);
    return {
      rank,
      statement: parsed.statement,
      confidencePercent: parsed.confidencePercent,
    };
  });

  if (triadParts.trigger || triadParts.supply || triadParts.amplification) {
    const triadStatement = buildTriadStatement(triadParts);
    const alreadyCovered = items.some(item =>
      hasTriadRoleText(item.statement, 'trigger') &&
      hasTriadRoleText(item.statement, 'supply') &&
      hasTriadRoleText(item.statement, 'amplification')
    );
    if (!alreadyCovered) {
      items.push({
        rank: items.length + 1,
        statement: triadStatement,
        confidencePercent: undefined,
      });
    }
  }

  return items;
}

function parseClusterItemsFromMarkdownSection(sectionBody: string): ConclusionContractClusterItem[] {
  const entries = extractListEntriesFromSectionBody(sectionBody);
  const clusters: ConclusionContractClusterItem[] = [];
  for (const entry of entries) {
    const metricMatch = entry.match(/[（(]\s*(\d+(?:\.\d+)?)\s*帧\s*,\s*(\d+(?:\.\d+)?)\s*%\s*[）)]/);
    let clusterText = entry;
    let frames: number | undefined;
    let percentage: number | undefined;
    if (metricMatch) {
      clusterText = entry.replace(metricMatch[0], '').trim();
      frames = Number(metricMatch[1]);
      percentage = Number(metricMatch[2]);
    }
    if (!clusterText) continue;
    const m = clusterText.match(/^(K\d+)\s*[:：]\s*(.+)$/i);
    const description = m ? m[2] : undefined;
    const frameRefs = parseFrameRefsFromUnknown(description);
    clusters.push({
      cluster: m ? m[1] : clusterText,
      description,
      frames: Number.isFinite(frames) ? frames : undefined,
      percentage: Number.isFinite(percentage) ? percentage : undefined,
      frameRefs: frameRefs.length > 0 ? frameRefs : undefined,
    });
  }
  return clusters;
}

function parseEvidenceItemsFromMarkdownSection(sectionBody: string): ConclusionContractEvidenceItem[] {
  const entries = extractListEntriesFromSectionBody(sectionBody);
  const evidenceItems: ConclusionContractEvidenceItem[] = [];
  entries.forEach((entry, idx) => {
    const m = entry.match(/^(C\d+)\s*[:：]\s*(.+)$/i);
    if (m) {
      evidenceItems.push({
        conclusionId: normalizeConclusionId(m[1], idx + 1),
        text: m[2].trim(),
      });
    } else {
      evidenceItems.push({
        conclusionId: normalizeConclusionId('', idx + 1),
        text: entry,
      });
    }
  });
  return evidenceItems;
}

function parseMetadataFromMarkdownSection(sectionBody: string): ConclusionContractMetadata | undefined {
  const entries = extractListEntriesFromSectionBody(sectionBody);
  let confidencePercent: number | undefined;
  let rounds: number | undefined;

  for (const entry of entries) {
    const confidenceMatch = entry.match(/置信度\s*[:：]\s*(\d+(?:\.\d+)?)\s*%?/i);
    if (confidenceMatch && confidencePercent === undefined) {
      confidencePercent = clampPercent(Number(confidenceMatch[1]));
      continue;
    }
    const roundsMatch = entry.match(/分析轮次\s*[:：]\s*(\d+(?:\.\d+)?)/i);
    if (roundsMatch && rounds === undefined) {
      rounds = Number(roundsMatch[1]);
    }
  }

  if (confidencePercent === undefined && rounds === undefined) return undefined;
  return {
    confidencePercent,
    rounds: typeof rounds === 'number' && Number.isFinite(rounds) ? Math.max(1, Math.round(rounds)) : undefined,
  };
}

function normalizeSceneId(raw: unknown): string | undefined {
  return String(raw || '').trim().toLowerCase() || undefined;
}

function normalizeClusterOutputMode(raw: unknown): ConclusionClusterOutputMode {
  const text = String(raw || '').trim().toLowerCase();
  if (text === 'required' || text === 'optional' || text === 'none') return text;
  return 'optional';
}

function normalizeClusterFrameListMode(raw: unknown): ConclusionClusterFrameListMode {
  const text = String(raw || '').trim().toLowerCase();
  if (text === 'full' || text === 'top' || text === 'none') return text;
  return 'none';
}

function normalizeClusterPolicy(raw: unknown): ConclusionContractClusterPolicy | undefined {
  if (!raw) return undefined;
  const source = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
  const outputMode = normalizeClusterOutputMode(readValueFromAliases(source, ['outputMode', 'output_mode']));
  const frameListMode = normalizeClusterFrameListMode(readValueFromAliases(source, ['frameListMode', 'frame_list_mode']));
  const maxFramesPerCluster = parseNumberFromUnknown(
    readValueFromAliases(source, ['maxFramesPerCluster', 'max_frames_per_cluster'])
  );
  const resolvedMax = Number.isFinite(maxFramesPerCluster) && (maxFramesPerCluster || 0) > 0
    ? Math.round(maxFramesPerCluster as number)
    : undefined;

  return {
    outputMode,
    frameListMode,
    maxFramesPerCluster: resolvedMax,
  };
}

function sanitizeConclusionContract(contract: ConclusionContract): ConclusionContract {
  const sanitizeText = (text: string): string => stripBulletPrefix(String(text || '').trim())
    .replace(/[·]\s*$/, '')
    .trim();
  const dedupe = (items: string[]): string[] => {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const raw of items) {
      const item = sanitizeText(raw);
      if (!item || seen.has(item)) continue;
      seen.add(item);
      out.push(item);
    }
    return out;
  };

  const conclusions = contract.conclusions
    .map((item, idx) => {
      const rank = Number.isFinite(item.rank) && item.rank > 0 ? Math.round(item.rank) : idx + 1;
      const parsed = parseConclusionConfidenceFromStatement(item.statement);
      const statement = sanitizeText(parsed.statement);
      const confidencePercent = clampPercent(item.confidencePercent ?? parsed.confidencePercent);
      return {
        rank,
        statement,
        confidencePercent,
        trigger: sanitizeText(item.trigger || ''),
        supply: sanitizeText(item.supply || ''),
        amplification: sanitizeText(item.amplification || ''),
      };
    })
    .filter(item => item.statement || item.trigger || item.supply || item.amplification)
    .sort((a, b) => a.rank - b.rank)
    .map((item, idx) => {
      let statement = item.statement;
      if (!statement) {
        statement = buildTriadStatement({
          ...(item.trigger ? { trigger: item.trigger } : {}),
          ...(item.supply ? { supply: item.supply } : {}),
          ...(item.amplification ? { amplification: item.amplification } : {}),
        });
      }
      return {
        rank: idx + 1,
        statement: statement || '结论信息缺失（证据不足）',
        confidencePercent: item.confidencePercent,
        trigger: item.trigger || undefined,
        supply: item.supply || undefined,
        amplification: item.amplification || undefined,
      };
    });

  const clusterPolicy = normalizeClusterPolicy(contract.metadata?.clusterPolicy);
  const sceneId = normalizeSceneId(contract.metadata?.sceneId);

  const clusters = contract.clusters
    .map(item => ({
      cluster: sanitizeText(item.cluster),
      description: sanitizeText(item.description || '') || undefined,
      frames: typeof item.frames === 'number' && Number.isFinite(item.frames) && item.frames > 0
        ? Math.round(item.frames)
        : undefined,
      percentage: clampPercent(item.percentage),
      frameRefs: parseFrameRefsFromUnknown(item.frameRefs),
    }))
    .filter(item => item.cluster)
    .map(item => {
      const selection = applyClusterFrameListMode(
        item.frameRefs,
        clusterPolicy?.frameListMode || 'top',
        clusterPolicy?.maxFramesPerCluster
      );
      return {
        cluster: item.cluster,
        description: item.description,
        frames: item.frames,
        percentage: item.percentage,
        frameRefs: selection.frameIds.length > 0 ? selection.frameIds : undefined,
        omittedFrameRefs: selection.omittedCount > 0 ? selection.omittedCount : undefined,
      };
    });

  const evidenceChain = contract.evidenceChain
    .map((item, idx) => ({
      conclusionId: normalizeConclusionId(item.conclusionId, idx + 1),
      text: sanitizeText(item.text),
    }))
    .filter(item => item.text);

  const claims = contract.bindingEligibility !== undefined ? (contract.claims ?? []) : (contract.claims || [])
    .map((item, idx) => {
      const references = (item.references || [])
        .map(ref => ({
          ...(ref.evidenceRefId ? { evidenceRefId: sanitizeText(ref.evidenceRefId) } : {}),
          ...(typeof ref.rowIndex === 'number' && Number.isFinite(ref.rowIndex) ? { rowIndex: ref.rowIndex } : {}),
          ...(ref.rowSelector ? { rowSelector: parseClaimRowSelector(ref.rowSelector) } : {}),
          ...(ref.column ? { column: sanitizeText(ref.column) } : {}),
          ...(ref.value !== undefined ? { value: parseClaimScalar(ref.value) } : {}),
          ...(ref.sourceRef ? { sourceRef: sanitizeText(ref.sourceRef) } : {}),
          ...(ref.sourceToolCallId ? { sourceToolCallId: sanitizeText(ref.sourceToolCallId) } : {}),
          ...(ref.artifactId ? { artifactId: sanitizeText(ref.artifactId) } : {}),
          ...(ref.sourceArtifactId ? { sourceArtifactId: sanitizeText(ref.sourceArtifactId) } : {}),
        }))
        .filter(ref => (
          (ref.evidenceRefId || ref.sourceRef || ref.sourceToolCallId || ref.artifactId || ref.sourceArtifactId) &&
          (ref.value === undefined || typeof ref.value === 'string' || typeof ref.value === 'number' || typeof ref.value === 'boolean')
        )) as ConclusionContractClaimReference[];
      const kind = parseClaimKind(item.kind);
      const artifactRefs = parseClaimArtifactRefs(item.artifactRefs);
      const relationRefs = parseStringArray(item.relationRefs);
      const supportLevel = parseClaimSupportLevel(item.supportLevel);
      return {
        ...(item.id ? { id: sanitizeText(item.id) } : {}),
        ...(item.conclusionId ? { conclusionId: normalizeConclusionId(item.conclusionId, idx + 1) } : {}),
        text: sanitizeText(item.text),
        ...(kind ? { kind } : {}),
        references,
        ...(artifactRefs ? { artifactRefs } : {}),
        ...(relationRefs ? { relationRefs } : {}),
        ...(supportLevel ? { supportLevel } : {}),
      };
    })
    // Keep the whole explicit claim set. Dropping unreferenced claims or a tail
    // of claims would let an incomplete verification look like a complete pass.
    .filter(item => item.text);

  const uncertainties = dedupe(contract.uncertainties);
  const nextSteps = dedupe(contract.nextSteps);

  const metadata = contract.metadata
    ? {
        confidencePercent: clampPercent(contract.metadata.confidencePercent),
        rounds: typeof contract.metadata.rounds === 'number' && Number.isFinite(contract.metadata.rounds)
          ? Math.max(1, Math.round(contract.metadata.rounds))
          : undefined,
        clusterPolicy,
        sceneId,
      }
    : ((clusterPolicy || sceneId) ? { ...(clusterPolicy ? { clusterPolicy } : {}), ...(sceneId ? { sceneId } : {}) } : undefined);

  const sanitized: ConclusionContract = {
    schemaVersion: 'conclusion_contract_v1',
    mode: contract.mode,
    conclusions: conclusions.length > 0 ? conclusions : [{
      rank: 1,
      statement: '结论信息缺失（证据不足）',
      confidencePercent: 40,
    }],
    clusters,
    evidenceChain,
    ...(claims.length > 0 ? { claims } : {}),
    ...(contract.bindingEligibility !== undefined ? {
      bindingEligibility: contract.bindingEligibility, parseIssues: contract.parseIssues ?? [],
      ...(Object.prototype.hasOwnProperty.call(contract, 'rawClaims') ? {rawClaims: contract.rawClaims} : {}),
      ...(Object.prototype.hasOwnProperty.call(contract, 'rawDeclaration') ? {rawDeclaration: contract.rawDeclaration} : {}),
      ...(Object.prototype.hasOwnProperty.call(contract, 'rawRelationProposals')
        ? {rawRelationProposals: contract.rawRelationProposals} : {}),
      ...(contract.relationProposals ? {relationProposals: contract.relationProposals} : {}),
    } : {}),
    ...(contract.sourceUseDecision ? {sourceUseDecision: contract.sourceUseDecision} : {}),
    ...(contract.sourceReferences ? {sourceReferences: contract.sourceReferences} : {}),
    ...(contract.sourceClaimBindings ? {sourceClaimBindings: contract.sourceClaimBindings} : {}),
    uncertainties,
    nextSteps,
    metadata: metadata && (
      metadata.confidencePercent !== undefined ||
      metadata.rounds !== undefined ||
      metadata.clusterPolicy !== undefined ||
      metadata.sceneId !== undefined
    )
      ? metadata
      : undefined,
  };
  return sanitizeConclusionSourceContract(sanitized);
}

function parseMarkdownToConclusionContract(
  markdown: string,
  mode: ConclusionOutputMode,
): ConclusionContract | null {
  const text = String(markdown || '').trim();
  if (!text) return null;

  const conclusionSection =
    findMarkdownSection(text, /^##\s*结论[（(]按可能性排序[）)]\s*$/m) ||
    findMarkdownSection(text, /^##\s*分析结论\s*$/m);
  const clusterSection =
    findMarkdownSection(text, /^##\s*掉帧聚类[（(]先看大头[）)]\s*$/m)
    || findMarkdownSection(text, /^##\s*聚类[（(]先看大头[）)]\s*$/m)
    || findMarkdownSection(text, /^##\s*聚类\s*$/m);
  const evidenceSection = findMarkdownSection(text, /^##\s*证据链[（(]对应上述结论[）)]\s*$/m);
  const claimsSection = findMarkdownSection(text, /^##\s*逐句数据引用(?:[（(](?:结构化来源|系统核对结果)[）)])?\s*$/m);
  const uncertaintySection = findMarkdownSection(text, /^##\s*不确定性与反例\s*$/m);
  const nextStepSection = findMarkdownSection(text, /^##\s*下一步[（(]最高信息增益[）)]\s*$/m);
  const metadataSection = findMarkdownSection(text, /^##\s*分析元数据\s*$/m);

  const hasSignal = Boolean(
    conclusionSection || clusterSection || evidenceSection || claimsSection || uncertaintySection || nextStepSection || metadataSection
  );
  if (!hasSignal) return null;

  const clusterHeader = clusterSection
    ? text.slice(clusterSection.headerStart, clusterSection.headerEnd)
    : '';
  const inferredSceneId = /掉帧聚类/.test(clusterHeader) ? 'jank' : undefined;
  const parsedMetadata = metadataSection ? parseMetadataFromMarkdownSection(metadataSection.body) : undefined;
  const metadata = inferredSceneId
    ? { ...(parsedMetadata || {}), sceneId: inferredSceneId }
    : parsedMetadata;

  const contract: ConclusionContract = {
    schemaVersion: 'conclusion_contract_v1',
    mode,
    conclusions: conclusionSection ? parseConclusionItemsFromMarkdownSection(conclusionSection.body) : [],
    clusters: clusterSection ? parseClusterItemsFromMarkdownSection(clusterSection.body) : [],
    evidenceChain: evidenceSection ? parseEvidenceItemsFromMarkdownSection(evidenceSection.body) : [],
    claims: claimsSection ? parseClaimItemsFromMarkdownSection(claimsSection.body) : [],
    uncertainties: uncertaintySection
      ? extractListEntriesFromSectionBody(uncertaintySection.body).map(normalizeUncertaintyWording)
      : [],
    nextSteps: nextStepSection
      ? extractListEntriesFromSectionBody(nextStepSection.body).map(normalizeNextStepWording)
      : [],
    metadata,
  };

  return sanitizeConclusionContract(contract);
}

function parseJsonToConclusionContract(
  rawText: string,
  mode: ConclusionOutputMode,
): {status: 'absent' | 'valid' | 'invalid'; contract?: ConclusionContract} {
  const typed = parseTypedConclusionContractJson(rawText);
  if (typed.status !== 'absent') return typed;
  const cleaned = stripJsonCodeFence(rawText);
  if (!cleaned) return {status: 'absent'};
  if (!cleaned.startsWith('{')) return {status: 'absent'};

  let parsed: unknown = null;
  const candidate = cleaned.endsWith('}') ? cleaned : extractFirstJsonObject(cleaned);
  if (!candidate) return {status: 'absent'};
  try {
    parsed = JSON.parse(candidate);
  } catch {
    return {status: 'absent'};
  }

  const root = toRecord(parsed);
  if (!root) return {status: 'absent'};
  if (root.schemaVersion === 'conclusion_contract_v1' && hasConclusionContractDeclarations(root)) {
    // The legacy extractor recognized a typed object only after trimming extra
    // framing or trailing content. It must not repair that protocol implicitly.
    return {status: 'invalid'};
  }


  const conclusionSource = readValueFromAliases(root, ['conclusion', 'conclusions', '结论']);
  const clusterSource = readValueFromAliases(root, ['clusters', 'jank_clusters', '掉帧聚类', 'cluster']);
  const evidenceSource = readValueFromAliases(root, ['evidence_chain', 'evidenceChain', '证据链']);
  const claimsSource = readValueFromAliases(root, ['claims', 'claim_refs', 'claimRefs', 'claimReferences', '逐句数据引用']);
  const uncertaintySource = readValueFromAliases(root, ['uncertainties', 'uncertainty', '不确定性与反例', '不确定性']);
  const nextStepSource = readValueFromAliases(root, ['next_steps', 'nextStep', 'next_step', '下一步']);
  const metadataSource = readValueFromAliases(root, ['metadata', 'analysis_metadata', '分析元数据']);
  const sourceUseDecision = readValueFromAliases(root, ['sourceUseDecision', 'source_use_decision']);
  const sourceReferences = readValueFromAliases(root, ['sourceReferences', 'source_references']);
  const sourceClaimBindings = readValueFromAliases(root, ['sourceClaimBindings', 'source_claim_bindings']);

  const conclusions: ConclusionContractConclusionItem[] = [];
  if (Array.isArray(conclusionSource)) {
    conclusionSource.forEach((item, idx) => {
      if (typeof item === 'string') {
        const parsedItem = parseConclusionConfidenceFromStatement(item);
        conclusions.push({
          rank: idx + 1,
          statement: parsedItem.statement,
          confidencePercent: parsedItem.confidencePercent,
        });
        return;
      }
      const record = toRecord(item);
      if (!record) return;
      const parsedItem = parseConclusionItemFromRecord(record, idx + 1);
      if (parsedItem) conclusions.push(parsedItem);
    });
  } else if (typeof conclusionSource === 'string') {
    const parsedItem = parseConclusionConfidenceFromStatement(conclusionSource);
    if (parsedItem.statement) {
      conclusions.push({
        rank: 1,
        statement: parsedItem.statement,
        confidencePercent: parsedItem.confidencePercent,
      });
    }
  } else {
    const fallbackItem = parseConclusionItemFromRecord(root, 1);
    if (fallbackItem) conclusions.push(fallbackItem);
  }

  const clusters: ConclusionContractClusterItem[] = [];
  if (Array.isArray(clusterSource)) {
    for (const item of clusterSource) {
      const record = toRecord(item);
      if (!record) continue;
      const parsedItem = parseClusterItemFromRecord(record);
      if (parsedItem) clusters.push(parsedItem);
    }
  } else {
    const record = toRecord(clusterSource);
    if (record) {
      const parsedItem = parseClusterItemFromRecord(record);
      if (parsedItem) clusters.push(parsedItem);
    }
  }

  const evidenceChain: ConclusionContractEvidenceItem[] = [];
  if (Array.isArray(evidenceSource)) {
    evidenceSource.forEach((item, idx) => {
      if (typeof item === 'string') {
        const m = item.match(/^(C\d+)\s*[:：]\s*(.+)$/i);
        evidenceChain.push({
          conclusionId: normalizeConclusionId(m?.[1] || '', idx + 1),
          text: stripBulletPrefix(m?.[2] || item),
        });
        return;
      }
      const record = toRecord(item);
      if (!record) return;
      evidenceChain.push(...parseEvidenceItemsFromRecord(record, idx + 1));
    });
  } else {
    const record = toRecord(evidenceSource);
    if (record) {
      evidenceChain.push(...parseEvidenceItemsFromRecord(record, 1));
    }
  }

  const declarations = hasConclusionContractDeclarations(root) && Array.isArray(claimsSource)
    ? parseDeclaredConclusionClaims(claimsSource) : undefined;
  const claims = declarations?.claims ?? parseClaimItemsFromUnknown(claimsSource);
  const relations = Object.prototype.hasOwnProperty.call(root, 'relationProposals')
    ? parseDeclaredRelationProposals(root.relationProposals) : undefined;
  const declarationIssues = [...(declarations?.issues ?? []), ...(relations?.issues ?? [])];

  const uncertainties = toStringArray(uncertaintySource).map(normalizeUncertaintyWording);
  const nextSteps = toStringArray(nextStepSource).map(normalizeNextStepWording);

  const metadataRecord = toRecord(metadataSource);
  const metadataClusterPolicy = normalizeClusterPolicy(
    metadataRecord ? readValueFromAliases(metadataRecord, ['clusterPolicy', 'cluster_policy']) : undefined
  );
  const rootClusterPolicy = normalizeClusterPolicy(readValueFromAliases(root, ['clusterPolicy', 'cluster_policy']));
  const metadataSceneId = normalizeSceneId(
    metadataRecord ? readValueFromAliases(metadataRecord, ['sceneId', 'scene_id', 'scene']) : undefined
  );
  const rootSceneId = normalizeSceneId(readValueFromAliases(root, ['sceneId', 'scene_id', 'scene']));
  const metadata: ConclusionContractMetadata | undefined = metadataRecord
    ? {
        confidencePercent: clampPercent(readSemanticNumber(metadataRecord, 'confidence')),
        rounds: (() => {
          const rounds = readSemanticNumber(metadataRecord, 'rounds');
          return typeof rounds === 'number' && Number.isFinite(rounds) ? Math.round(rounds) : undefined;
        })(),
        clusterPolicy: metadataClusterPolicy || rootClusterPolicy,
        sceneId: metadataSceneId || rootSceneId,
      }
    : {
        confidencePercent: clampPercent(readSemanticNumber(root, 'confidence')),
        rounds: (() => {
          const rounds = readSemanticNumber(root, 'rounds');
          return typeof rounds === 'number' && Number.isFinite(rounds) ? Math.round(rounds) : undefined;
        })(),
        clusterPolicy: rootClusterPolicy,
        sceneId: rootSceneId,
      };

  const contract: ConclusionContract = {
    schemaVersion: 'conclusion_contract_v1',
    mode,
    conclusions,
    clusters,
    evidenceChain,
    claims,
    ...(declarations || relations ? {
      parseIssues: declarationIssues,
      bindingEligibility: declarationIssues.length ? 'ineligible' as const : 'eligible' as const,
      ...(declarations && Object.prototype.hasOwnProperty.call(declarations, 'rawClaims') ? {rawClaims: declarations.rawClaims} : {}),
      ...(relations ? {relationProposals: relations.relationProposals,
        ...(Object.prototype.hasOwnProperty.call(relations, 'rawRelationProposals')
          ? {rawRelationProposals: relations.rawRelationProposals} : {})} : {}),
    } : {}),
    ...(sourceUseDecision ? {sourceUseDecision: sourceUseDecision as ConclusionContract['sourceUseDecision']} : {}),
    ...(Array.isArray(sourceReferences)
      ? {sourceReferences: sourceReferences as ConclusionContract['sourceReferences']}
      : {}),
    ...(Array.isArray(sourceClaimBindings)
      ? {sourceClaimBindings: sourceClaimBindings as ConclusionContract['sourceClaimBindings']}
      : {}),
    uncertainties,
    nextSteps,
    metadata,
  };

  return {status: 'valid', contract: sanitizeConclusionContract(contract)};
}

export function deriveConclusionContract(
  rawText: string,
  options: {
    mode?: ConclusionOutputMode;
    sceneId?: string;
  } = {}
): ConclusionContract | null {
  const machine = parseConclusionContractSidecar(rawText);
  if (machine.status !== 'absent') {
    return machine.contract ? sanitizeConclusionSourceContract(machine.contract) : null;
  }
  const mode = options.mode || 'initial_report';
  const sceneIdHint = normalizeSceneId(options.sceneId);
  const text = String(rawText || '').trim();
  if (!text) return null;

  const applySceneIdHint = (contract: ConclusionContract): ConclusionContract => {
    if (!sceneIdHint || contract.metadata?.sceneId) return contract;
    return {
      ...contract,
      metadata: {
        ...(contract.metadata || {}),
        sceneId: sceneIdHint,
      },
    };
  };

  const contractFromJson = parseJsonToConclusionContract(text, mode);
  if (contractFromJson.status !== 'absent') {
    return contractFromJson.contract ? applySceneIdHint(sanitizeConclusionSourceContract(contractFromJson.contract)) : null;
  }

  const markdownCandidates: string[] = [text];
  const normalizedJsonLike = convertJsonLikeSectionsToMarkdown(text);
  if (normalizedJsonLike) {
    markdownCandidates.push(normalizedJsonLike);
  }

  const normalizedJson = convertJsonToMarkdown(text);
  if (normalizedJson && normalizedJson !== text) {
    markdownCandidates.push(normalizedJson);
  }

  for (const candidate of markdownCandidates) {
    const contract = parseMarkdownToConclusionContract(candidate, mode);
    if (contract) return applySceneIdHint(contract);
  }

  return null;
}

function findMarkdownSection(
  text: string,
  headerRe: RegExp
): null | { headerStart: number; headerEnd: number; bodyStart: number; bodyEnd: number; body: string } {
  const m = headerRe.exec(text);
  if (!m) return null;

  const headerStart = m.index;
  const headerEnd = headerStart + m[0].length;

  let bodyStart = headerEnd;
  if (text[bodyStart] === '\r' && text[bodyStart + 1] === '\n') bodyStart += 2;
  else if (text[bodyStart] === '\n') bodyStart += 1;

  const nextHeaderRe = /^##\s+/gm;
  nextHeaderRe.lastIndex = bodyStart;
  const next = nextHeaderRe.exec(text);
  const bodyEnd = next ? next.index : text.length;
  const body = text.slice(bodyStart, bodyEnd);

  return { headerStart, headerEnd, bodyStart, bodyEnd, body };
}

function convertJsonLikeSectionsToMarkdown(rawText: string): string | null {
  const sections = parseJsonLikeSections(rawText);
  if (!sections) return null;

  const lines: string[] = [];
  const conclusions: Array<{ statement: string; confidence?: number }> = [];
  const clusterLines: string[] = [];
  const evidenceLines: string[] = [];
  const uncertainties: string[] = [];
  const nextSteps: string[] = [];
  const metadataLines: string[] = [];

  for (const line of sections.conclusion) {
    const obj = parseJsonLine(line);
    if (obj) {
      const statement = readSemanticText(obj, 'statement');
      const confidence = normalizeConfidencePercent(readSemanticNumber(obj, 'confidence'));
      if (statement) {
        conclusions.push({
          statement,
          confidence,
        });
        continue;
      }

      const trigger = readSemanticText(obj, 'trigger');
      const supply = readSemanticText(obj, 'supply');
      const amp = readSemanticText(obj, 'amplification');
      if (trigger || supply || amp) {
        const triadStatement = buildTriadStatement({
          ...(trigger ? { trigger } : {}),
          ...(supply ? { supply } : {}),
          ...(amp ? { amplification: amp } : {}),
        });
        conclusions.push({
          statement: triadStatement,
          confidence,
        });
        continue;
      }
    }
    const plain = stripBulletPrefix(line.trim());
    if (plain) conclusions.push({ statement: plain });
  }

  for (const line of sections.clusters) {
    const obj = parseJsonLine(line);
    if (obj) {
      const formatted = formatClusterLineFromJsonLikeObject(obj);
      if (formatted) {
        clusterLines.push(formatted);
        continue;
      }
    }

    const plain = stripBulletPrefix(line.trim());
    if (plain) clusterLines.push(`- ${plain}`);
  }

  for (const line of sections.evidence_chain) {
    const obj = parseJsonLine(line);
    if (obj) {
      const cid =
        readSemanticText(obj, 'conclusion_id') ||
        'C1';
      const evidenceTexts = extractEvidenceTextsFromJsonLikeObject(obj);
      for (const evText of evidenceTexts) {
        if (/^C\d+[:：]/i.test(evText)) {
          evidenceLines.push(`- ${evText}`);
        } else {
          evidenceLines.push(`- ${cid}: ${evText}`);
        }
      }
      if (evidenceTexts.length === 0) {
        evidenceLines.push(`- ${cid}: 原始证据项缺少可展示文本（需补充数据说明）`);
      }
      continue;
    }

    const plain = stripBulletPrefix(line.trim());
    if (plain) evidenceLines.push(`- ${plain}`);
  }

  for (const line of sections.uncertainties) {
    const obj = parseJsonLine(line);
    if (obj) {
      const point = readSemanticText(obj, 'uncertainty_point');
      const explanation = readSemanticText(obj, 'uncertainty_reason');
      if (point && explanation) {
        uncertainties.push(normalizeUncertaintyWording(`${point}：${explanation}`));
        continue;
      }
      if (point) {
        uncertainties.push(normalizeUncertaintyWording(point));
        continue;
      }
      if (explanation) {
        uncertainties.push(normalizeUncertaintyWording(explanation));
        continue;
      }
    }

    const plain = stripBulletPrefix(line.trim());
    if (plain) uncertainties.push(normalizeUncertaintyWording(plain));
  }

  for (const line of sections.next_steps) {
    const obj = parseJsonLine(line);
    if (obj) {
      const action = readSemanticText(obj, 'next_action');
      const reason = readSemanticText(obj, 'next_reason');
      if (action && reason) {
        nextSteps.push(normalizeNextStepWording(`${action}（原因：${reason}）`));
        continue;
      }
      if (action) {
        nextSteps.push(normalizeNextStepWording(action));
        continue;
      }
      if (reason) {
        nextSteps.push(normalizeNextStepWording(reason));
        continue;
      }
    }

    const plain = stripBulletPrefix(line.trim());
    if (plain) nextSteps.push(normalizeNextStepWording(plain));
  }

  for (const line of sections.metadata) {
    const obj = parseJsonLine(line);
    if (obj) {
      const confidence = normalizeConfidencePercent(readSemanticNumber(obj, 'confidence'));
      if (typeof confidence === 'number') {
        metadataLines.push(`- 置信度: ${Math.round(confidence)}%`);
      }
      const rounds = readSemanticNumber(obj, 'rounds');
      if (typeof rounds === 'number' && rounds > 0) {
        metadataLines.push(`- 分析轮次: ${Math.round(rounds)}`);
      }
      continue;
    }

    const plain = stripBulletPrefix(line.trim());
    if (plain) metadataLines.push(`- ${plain}`);
  }

  const normalizedNextSteps = [...new Set(nextSteps.filter(Boolean))];

  lines.push('## 结论（按可能性排序）');
  if (conclusions.length === 0) {
    lines.push('1. 结论信息缺失（置信度: 40%）');
  } else {
    conclusions.forEach((item, idx) => {
      const conf = Number.isFinite(item.confidence) ? `（置信度: ${Math.round(item.confidence!)}%）` : '';
      lines.push(`${idx + 1}. ${item.statement}${conf}`);
    });
  }
  lines.push('');

  lines.push('## 聚类（先看大头）');
  if (clusterLines.length === 0) {
    lines.push('- 暂无');
  } else {
    lines.push(...clusterLines);
  }
  lines.push('');

  lines.push('## 证据链（对应上述结论）');
  if (evidenceLines.length === 0) {
    lines.push('- 证据链信息缺失');
  } else {
    lines.push(...evidenceLines);
  }
  lines.push('');

  lines.push('## 不确定性与反例');
  if (uncertainties.length === 0) {
    lines.push('- 暂无');
  } else {
    uncertainties.forEach((item) => lines.push(`- ${item}`));
  }
  lines.push('');

  lines.push('## 下一步（最高信息增益）');
  if (normalizedNextSteps.length === 0) {
    lines.push('- 暂无');
  } else {
    normalizedNextSteps.forEach((item) => lines.push(`- ${item}`));
  }

  if (metadataLines.length > 0) {
    lines.push('');
    lines.push('## 分析元数据');
    lines.push(...metadataLines);
  }

  return lines.join('\n');
}

type JsonLikeSection = 'conclusion' | 'clusters' | 'evidence_chain' | 'uncertainties' | 'next_steps' | 'metadata';

function parseJsonLikeSections(rawText: string): Record<JsonLikeSection, string[]> | null {
  const sectionAlias: Record<string, JsonLikeSection> = {
    conclusion: 'conclusion',
    结论: 'conclusion',
    jank_clusters: 'clusters',
    jank_cluster: 'clusters',
    clusters: 'clusters',
    cluster: 'clusters',
    掉帧聚类: 'clusters',
    聚类: 'clusters',
    evidence_chain: 'evidence_chain',
    证据链: 'evidence_chain',
    uncertainties: 'uncertainties',
    uncertainty: 'uncertainties',
    uncertainty_and_counterexamples: 'uncertainties',
    uncertainty_and_counterexample: 'uncertainties',
    不确定性与反例: 'uncertainties',
    不确定性: 'uncertainties',
    反例: 'uncertainties',
    next_steps: 'next_steps',
    next_step: 'next_steps',
    下一步: 'next_steps',
    analysis_metadata: 'metadata',
    analysis_meta: 'metadata',
    metadata: 'metadata',
    meta: 'metadata',
    分析元数据: 'metadata',
    元数据: 'metadata',
  };

  const out = {
    conclusion: [] as string[],
    clusters: [] as string[],
    evidence_chain: [] as string[],
    uncertainties: [] as string[],
    next_steps: [] as string[],
    metadata: [] as string[],
  };

  let current: keyof typeof out | null = null;
  let hitHeader = false;
  for (const rawLine of String(rawText || '').split(/\r?\n/)) {
    const line = rawLine.trim();
    const headerMatch = line.match(/^([A-Za-z_\u4e00-\u9fa5]+)\s*[:：]\s*(.*)$/);
    if (headerMatch) {
      const mapped = sectionAlias[String(headerMatch[1] || '').toLowerCase()];
      if (mapped) {
        current = mapped;
        hitHeader = true;
        const inlineContent = String(headerMatch[2] || '').trim();
        if (inlineContent) out[current].push(inlineContent);
        continue;
      }
      if (current && line) {
        out[current].push(line);
      }
      continue;
    }
    if (/^#{1,6}\s+/.test(line)) {
      current = null;
      continue;
    }
    if (!current) continue;
    if (line) out[current].push(line);
  }

  if (!hitHeader) return null;

  const hasSignal =
    out.conclusion.length > 0 ||
    out.clusters.length > 0 ||
    out.evidence_chain.length > 0 ||
    out.uncertainties.length > 0 ||
    out.next_steps.length > 0 ||
    out.metadata.length > 0;
  return hasSignal ? out : null;
}

function parseJsonLine(line: string): Record<string, unknown> | null {
  const s = String(line || '')
    .trim()
    .replace(/[·。]\s*$/, '')
    .replace(/,\s*$/, '');
  if (!(s.startsWith('{') && s.endsWith('}'))) return null;
  try {
    const parsed = JSON.parse(s);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return null;
  } catch {
    return null;
  }
}

type SemanticTextField =
  | 'statement'
  | 'trigger'
  | 'supply'
  | 'amplification'
  | 'conclusion_id'
  | 'uncertainty_point'
  | 'uncertainty_reason'
  | 'next_action'
  | 'next_reason'
  | 'source'
  | 'cluster_label'
  | 'cluster_description';

type SemanticNumberField =
  | 'confidence'
  | 'rounds'
  | 'cluster_rank'
  | 'cluster_frames'
  | 'cluster_percentage';

type SemanticRule = {
  aliases: string[];
  patterns: RegExp[];
};

const SEMANTIC_TEXT_RULES: Record<SemanticTextField, SemanticRule> = {
  statement: {
    aliases: ['statement', 'summary', 'conclusion', '结论', '描述', '说明'],
    patterns: [/statement|summary|conclusion|结论|描述|说明/i],
  },
  trigger: {
    aliases: ['trigger', 'trigger_factor', 'triggerFactor', '触发因子', '直接原因'],
    patterns: [/trigger|触发|直接原因/i],
  },
  supply: {
    aliases: ['supply', 'supply_constraint', 'supplyConstraint', '供给约束', '资源瓶颈', '资源问题'],
    patterns: [/supply|constraint|bottleneck|供给约束|资源瓶颈|资源问题|瓶颈/i],
  },
  amplification: {
    aliases: ['amplification', 'amplification_path', 'amplificationPath', '放大路径', '放大环节', '放大因素'],
    patterns: [/amplification|amplify|path|放大路径|放大环节|放大因素|放大/i],
  },
  conclusion_id: {
    aliases: ['conclusion_id', 'conclusionId', 'conclusion', '结论编号', '结论ID'],
    patterns: [/conclusionid|conclusion|结论编号|结论id|cid/i],
  },
  uncertainty_point: {
    aliases: ['point', 'title', 'statement', 'topic', '问题', '标题', '结论'],
    patterns: [/point|title|statement|topic|问题|标题|结论/i],
  },
  uncertainty_reason: {
    aliases: ['explanation', 'reason', 'detail', '说明', '原因', '描述'],
    patterns: [/explanation|reason|detail|说明|原因|描述/i],
  },
  next_action: {
    aliases: ['action', 'step', 'title', 'next_step', '下一步', '动作', '步骤', '建议'],
    patterns: [/action|step|title|nextstep|下一步|动作|步骤|建议/i],
  },
  next_reason: {
    aliases: ['reason', 'explanation', 'detail', '原因', '说明'],
    patterns: [/reason|explanation|detail|原因|说明/i],
  },
  source: {
    aliases: ['source', 'skill', '来源'],
    patterns: [/source|skill|来源/i],
  },
  cluster_label: {
    aliases: ['cluster', 'name', 'pattern', '聚类', '簇', 'clusterId', 'cluster_id'],
    patterns: [/cluster|name|pattern|聚类|簇/i],
  },
  cluster_description: {
    aliases: ['description', 'desc', '描述', '特征'],
    patterns: [/description|desc|描述|特征/i],
  },
};

const SEMANTIC_NUMBER_RULES: Record<SemanticNumberField, SemanticRule> = {
  confidence: {
    aliases: ['confidence', 'overall_confidence', '置信度'],
    patterns: [/confidence|overallconfidence|置信度/i],
  },
  rounds: {
    aliases: ['rounds', 'analysis_rounds', 'iterations', '分析轮次', '轮次'],
    patterns: [/rounds|analysisrounds|iterations|分析轮次|轮次/i],
  },
  cluster_rank: {
    aliases: ['rank', '排序', '序号'],
    patterns: [/rank|排序|序号/i],
  },
  cluster_frames: {
    aliases: ['frames', 'frameCount', 'frame_count', '帧数'],
    patterns: [/frames|framecount|帧数/i],
  },
  cluster_percentage: {
    aliases: ['percentage', 'pct', 'ratio', '占比', '比例'],
    patterns: [/percentage|pct|ratio|占比|比例/i],
  },
};

function normalizeJsonLikeKey(key: string): string {
  return String(key || '')
    .trim()
    .replace(/[\s_\-]/g, '')
    .toLowerCase();
}

function buildNormalizedAliasSet(aliases: string[]): Set<string> {
  return new Set(aliases.map((alias) => normalizeJsonLikeKey(alias)));
}

function readTextByRule(obj: Record<string, unknown>, rule: SemanticRule): string {
  const aliasSet = buildNormalizedAliasSet(rule.aliases);
  let fuzzyMatch = '';

  for (const [rawKey, rawValue] of Object.entries(obj)) {
    if (typeof rawValue !== 'string') continue;
    const text = stripBulletPrefix(rawValue.trim());
    if (!text) continue;

    const normalizedKey = normalizeJsonLikeKey(rawKey);
    if (aliasSet.has(normalizedKey)) {
      return text;
    }
    if (!fuzzyMatch && rule.patterns.some((pattern) => pattern.test(normalizedKey))) {
      fuzzyMatch = text;
    }
  }

  return fuzzyMatch;
}

function readSemanticText(obj: Record<string, unknown>, field: SemanticTextField): string {
  return readTextByRule(obj, SEMANTIC_TEXT_RULES[field]);
}

function readNumberValue(raw: unknown): number | undefined {
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    return raw;
  }
  if (typeof raw !== 'string') {
    return undefined;
  }
  const normalized = raw.trim().replace(/[%％]/g, '');
  if (!normalized) return undefined;
  const value = Number(normalized);
  return Number.isFinite(value) ? value : undefined;
}

function readNumberByRule(obj: Record<string, unknown>, rule: SemanticRule): number | undefined {
  const aliasSet = buildNormalizedAliasSet(rule.aliases);
  let fuzzyMatch: number | undefined;

  for (const [rawKey, rawValue] of Object.entries(obj)) {
    const value = readNumberValue(rawValue);
    if (!Number.isFinite(value)) continue;

    const normalizedKey = normalizeJsonLikeKey(rawKey);
    if (aliasSet.has(normalizedKey)) {
      return value;
    }
    if (fuzzyMatch === undefined && rule.patterns.some((pattern) => pattern.test(normalizedKey))) {
      fuzzyMatch = value;
    }
  }

  return fuzzyMatch;
}

function readSemanticNumber(obj: Record<string, unknown>, field: SemanticNumberField): number | undefined {
  return readNumberByRule(obj, SEMANTIC_NUMBER_RULES[field]);
}

function readValueFromAliases(obj: Record<string, unknown>, aliases: string[]): unknown {
  const aliasSet = buildNormalizedAliasSet(aliases);
  for (const [rawKey, value] of Object.entries(obj)) {
    if (aliasSet.has(normalizeJsonLikeKey(rawKey))) {
      return value;
    }
  }
  return undefined;
}

function normalizeConfidencePercent(raw?: number): number | undefined {
  if (!Number.isFinite(raw)) return undefined;
  if ((raw as number) <= 1) return (raw as number) * 100;
  return raw;
}

function extractEvidenceTextsFromJsonLikeObject(obj: Record<string, unknown>): string[] {
  const out: string[] = [];
  const pushIfUseful = (raw: unknown) => {
    const text = stripBulletPrefix(String(raw || '').trim())
      .replace(/[（(]\s*证据\s*[:：]\s*[）)]/g, '')
      .replace(/[（(]\s*证据\s*ID\s*[:：]\s*[）)]/gi, '')
      .replace(/证据\s*ID\s*[:：]\s*和\s*$/gi, '')
      .trim();
    if (!text) return;
    if (/^ev_[0-9a-f]{12}$/i.test(text)) return;
    if (!out.includes(text)) out.push(text);
  };

  const preferredFields = [
    'data', 'description', 'detail', 'statement', 'observation', 'metric', 'reason',
    '数据', '描述', '详情', '说明', '观察', '指标', '原因',
  ];
  for (const key of preferredFields) {
    pushIfUseful(obj[key]);
  }

  const evidence = readValueFromAliases(obj, ['evidence', '证据']);
  if (Array.isArray(evidence)) {
    for (const item of evidence) {
      if (typeof item === 'string') {
        pushIfUseful(item);
        continue;
      }
      const evidenceObject = asEvidenceObject(item);
      if (evidenceObject) {
        pushIfUseful(evidenceObject.title);
        pushIfUseful(evidenceObject.description);
        pushIfUseful(evidenceObject.summary);
      }
    }
  } else if (typeof evidence === 'string') {
    pushIfUseful(evidence);
  }

  const source = readSemanticText(obj, 'source');
  if (source && out.length > 0) {
    const last = out[out.length - 1];
    if (!last.includes('来源:')) {
      out[out.length - 1] = `${last}（来源: ${source}）`;
    }
  }

  return out.slice(0, 4);
}

function normalizeUncertaintyWording(text: string): string {
  const line = String(text || '').trim();
  if (!line) return line;

  const isContradiction = /矛盾|不一致|冲突/.test(line);
  const hasPercentSignals = /\d+(?:\.\d+)?%/.test(line);
  const hasDefinitionContext = /口径|分母|定义|时间窗|统计方式/.test(line);
  if (isContradiction && hasPercentSignals && !hasDefinitionContext) {
    return `${line}（可能由统计口径/分母差异导致，需统一时间窗与分母定义后再比较）`;
  }

  return line;
}

function normalizeNextStepWording(text: string): string {
  const line = String(text || '').trim();
  if (!line) return line;

  const asksMoreData = /补充/.test(line) && /数据/.test(line);
  const mentionsContradiction = /矛盾|冲突|不一致/.test(line);
  if (asksMoreData && mentionsContradiction) {
    const subject = line
      .replace(/^补充/, '')
      .replace(/的?矛盾数据.*/, '')
      .replace(/矛盾数据.*/, '')
      .replace(/数据.*/, '')
      .trim();
    if (subject) {
      return `在同一帧同一时间窗统一统计口径，复核${subject}的分母与计算方式`;
    }
    return '在同一帧同一时间窗统一统计口径，复核矛盾指标的分母与计算方式';
  }

  return line;
}

function formatClusterLineFromJsonLikeObject(obj: Record<string, unknown>): string | null {
  const clusterRaw = readSemanticText(obj, 'cluster_label');
  const description = readSemanticText(obj, 'cluster_description');
  const rankNum = readSemanticNumber(obj, 'cluster_rank');
  const rankPrefix = typeof rankNum === 'number' && rankNum > 0 ? `K${Math.round(rankNum)}` : '';

  let clusterLabel = clusterRaw;
  if (!clusterLabel && description) {
    clusterLabel = description;
  } else if (clusterLabel && description && !clusterLabel.includes(description)) {
    if (/^K\d+\b/i.test(clusterLabel) || !/[:：]/.test(clusterLabel)) {
      clusterLabel = `${clusterLabel}: ${description}`;
    }
  }

  if (rankPrefix) {
    if (!clusterLabel) {
      clusterLabel = rankPrefix;
    } else if (!new RegExp(`^${rankPrefix}\\b`, 'i').test(clusterLabel)) {
      clusterLabel = `${rankPrefix}: ${clusterLabel}`;
    }
  }
  if (!clusterLabel) {
    return null;
  }

  const frames = readSemanticNumber(obj, 'cluster_frames');
  const percentage = readSemanticNumber(obj, 'cluster_percentage');
  const metrics: string[] = [];
  if (typeof frames === 'number' && frames > 0) {
    metrics.push(`${Math.round(frames)}帧`);
  }
  if (typeof percentage === 'number') {
    metrics.push(`${percentage.toFixed(1)}%`);
  }

  const frameRefs = parseClusterFrameRefs(obj);
  const frameRefText = frameRefs.length > 0 ? `；帧: ${frameRefs.join(' / ')}` : '';

  return `- ${clusterLabel}${metrics.length > 0 ? `（${metrics.join(', ')}）` : ''}${frameRefText}`;
}

function stripBulletPrefix(text: string): string {
  return String(text || '').replace(/^\s*-\s*/, '').trim();
}

/**
 * Convert JSON response to Markdown when LLM ignores format instructions.
 * This is a fallback to ensure human-readable output.
 */
function convertJsonToMarkdown(jsonStr: string): string {
  // 1. Remove code block markers if present
  let cleaned = jsonStr
    .replace(/^```(?:json)?\s*\n?/, '')
    .replace(/\n?```$/, '')
    .trim();

  // 2. Try to parse as JSON
  try {
    const parsed = JSON.parse(cleaned);
    const lines: string[] = [];

    // Extract root cause analysis
    if (parsed.rootCauseAnalysis && Array.isArray(parsed.rootCauseAnalysis)) {
      lines.push('## 根因分析\n');
      for (const item of parsed.rootCauseAnalysis) {
        const conclusion = item.conclusion || item.title || '结论';
        const confidence = item.confidence ? ` (置信度: ${item.confidence})` : '';
        lines.push(`### ${conclusion}${confidence}\n`);

        if (item.evidence && Array.isArray(item.evidence)) {
          lines.push('**证据:**');
          for (const e of item.evidence) {
            lines.push(`- ${typeof e === 'object' ? JSON.stringify(e) : e}`);
          }
          lines.push('');
        }
      }
    }

    // Extract conclusion field if present
    if (parsed.conclusion && typeof parsed.conclusion === 'string') {
      if (lines.length === 0) {
        lines.push('## 分析结论\n');
      }
      lines.push(parsed.conclusion);
      lines.push('');
    }

    // Extract summary if present
    if (parsed.summary && typeof parsed.summary === 'string') {
      lines.push('## 总结\n');
      lines.push(parsed.summary);
      lines.push('');
    }

    // Extract findings array if present
    if (parsed.findings && Array.isArray(parsed.findings)) {
      lines.push('## 发现\n');
      for (const f of parsed.findings) {
        const title = f.title || f.name || '发现';
        const severity = f.severity ? `[${f.severity}] ` : '';
        lines.push(`- ${severity}${title}`);
        if (f.description) {
          lines.push(`  ${f.description}`);
        }
      }
      lines.push('');
    }

    // If we extracted anything, return it
    if (lines.length > 0) {
      return lines.join('\n');
    }

    // Otherwise, format the entire object as a simple list
    return formatObjectAsMarkdown(parsed);
  } catch {
    // JSON parse failed, return cleaned string as-is
    return cleaned;
  }
}

/**
 * Format an arbitrary object as Markdown list.
 */
function formatObjectAsMarkdown(obj: Record<string, unknown>, indent = ''): string {
  const lines: string[] = [];

  for (const [key, value] of Object.entries(obj)) {
    if (value === null || value === undefined) continue;

    if (Array.isArray(value)) {
      lines.push(`${indent}**${key}:**`);
      for (const item of value) {
        if (typeof item === 'object') {
          lines.push(`${indent}- ${JSON.stringify(item).slice(0, 200)}`);
        } else {
          lines.push(`${indent}- ${item}`);
        }
      }
    } else if (typeof value === 'object') {
      lines.push(`${indent}**${key}:**`);
      lines.push(formatObjectAsMarkdown(value as Record<string, unknown>, indent + '  '));
    } else {
      lines.push(`${indent}- **${key}:** ${value}`);
    }
  }

  return lines.join('\n');
}
