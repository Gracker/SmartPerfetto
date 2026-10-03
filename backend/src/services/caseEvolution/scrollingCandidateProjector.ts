// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import type { CaseKnowledgeResponsibility } from '../../types/caseKnowledge';
import type { DataEnvelope } from '../../types/dataContract';
import { dataEnvelopeRefId } from './dataEnvelopeRef';
import {rowObject} from '../../utils/traceProcessorRowUtils';

export interface CaseCandidateCluster {
  scene: string;
  domainPack: 'scrolling.v1';
  rootCause: string;
  responsibility: CaseKnowledgeResponsibility;
  evidenceSignatures: Record<string, unknown>;
  evidenceRefIds: string[];
}

const MIN_PROMOTABLE_FRAME_COUNT = 3;
const MIN_PROMOTABLE_PERCENTAGE = 15;

export function projectScrollingCandidateClusters(dataEnvelopes: DataEnvelope[]): CaseCandidateCluster[] {
  const clusters: CaseCandidateCluster[] = [];
  const duplicateEvidenceRefIds = new Set(
    [...countEvidenceRefIds(dataEnvelopes).entries()].filter(([, count]) => count > 1).map(([id]) => id),
  );
  for (const env of dataEnvelopes) {
    if (env.meta?.skillId !== 'scrolling_analysis' || env.meta?.stepId !== 'batch_frame_root_cause') {
      continue;
    }
    const rows = Array.isArray(env.data?.rows) ? env.data.rows : [];
    const columns = Array.isArray(env.data?.columns) ? env.data.columns : [];
    for (const row of rows) {
      const record = rowToRecord(columns, row);
      const frameCount = toNumber(record.frame_count);
      const percentage = toNumber(record.percentage);
      if (frameCount < MIN_PROMOTABLE_FRAME_COUNT || percentage < MIN_PROMOTABLE_PERCENTAGE) {
        continue;
      }
      const rootCause = readString(record.reason_code) || 'unknown';
      clusters.push({
        scene: 'scrolling',
        domainPack: 'scrolling.v1',
        rootCause,
        responsibility: mapResponsibility(readString(record.jank_responsibility)),
        evidenceSignatures: {
          reason_code: rootCause,
          jank_responsibility: readString(record.jank_responsibility) || 'unknown',
          vsync_missed: toNumber(record.vsync_missed),
          render_slices: readStringArray(record.render_slices_json),
        },
        evidenceRefIds: [dataEnvelopeRefId(env, duplicateEvidenceRefIds)],
      });
    }
  }
  return clusters;
}

function countEvidenceRefIds(dataEnvelopes: DataEnvelope[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const env of dataEnvelopes) {
    if (!env.meta?.evidenceRefId) continue;
    counts.set(env.meta.evidenceRefId, (counts.get(env.meta.evidenceRefId) || 0) + 1);
  }
  return counts;
}

function rowToRecord(columns: string[], row: unknown): Record<string, unknown> {
  return rowObject(columns, Array.isArray(row) ? row : []);
}

function toNumber(value: unknown): number {
  const num = Number(value);
  return Number.isFinite(num) ? num : 0;
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function readStringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String).filter(Boolean);
  if (typeof value !== 'string' || !value.trim()) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.map(String).filter(Boolean) : [];
  } catch {
    return [];
  }
}

function mapResponsibility(value: string | undefined): CaseKnowledgeResponsibility {
  const normalized = (value || '').trim().toLowerCase();
  if (normalized === 'app' || normalized.includes('app')) return 'app';
  if (normalized === 'sf' || normalized.includes('surfaceflinger') || normalized.includes('display')) return 'oem';
  if (normalized.includes('mixed')) return 'mixed';
  return 'unknown';
}
