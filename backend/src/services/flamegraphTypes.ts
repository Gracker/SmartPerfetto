// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

export interface FlamegraphAnalyzeOptions {
  startTs?: number | string;
  endTs?: number | string;
  packageName?: string;
  threadName?: string;
  sampleSource?: string;
  maxDepth?: number;
  maxNodes?: number;
  minSampleCount?: number;
  maxSampleBuckets?: number;
  includeAi?: boolean;
  question?: string;
}

export interface FlamegraphPerfettoSummaryRow {
  id: number;
  parentId: number | null;
  name: string;
  mappingName: string | null;
  selfCount: number;
  cumulativeCount: number;
}

export interface FlamegraphNode {
  id: string;
  name: string;
  value: number;
  selfValue: number;
  depth: number;
  mappingName?: string | null;
  children: FlamegraphNode[];
}

export type FlamegraphFrameCategory =
  | 'app'
  | 'android-framework'
  | 'art-runtime'
  | 'graphics-rendering'
  | 'native'
  | 'kernel'
  | 'unknown';

export interface FlamegraphFunctionStat {
  name: string;
  mappingName?: string | null;
  sampleCount: number;
  selfCount: number;
  percentage: number;
  selfPercentage: number;
  cumulativePercentage: number;
  category: FlamegraphFrameCategory;
  categoryLabel: string;
}

export interface FlamegraphHotPath {
  frames: string[];
  compressedFrames: string[];
  sampleCount: number;
  percentage: number;
  leafCategory: FlamegraphFrameCategory;
  leafCategoryLabel: string;
}

export interface FlamegraphCategoryStat {
  category: FlamegraphFrameCategory;
  label: string;
  sampleCount: number;
  selfCount: number;
  percentage: number;
}

export interface FlamegraphThreadStat {
  utid?: number | null;
  threadName: string;
  processName: string;
  sampleCount: number;
  percentage: number;
}

export interface FlamegraphAnalysis {
  available: boolean;
  sampleCount: number;
  filteredSampleCount: number;
  root: FlamegraphNode;
  topFunctions: FlamegraphFunctionStat[];
  topCumulativeFunctions: FlamegraphFunctionStat[];
  hotPaths: FlamegraphHotPath[];
  categoryBreakdown: FlamegraphCategoryStat[];
  threadBreakdown: FlamegraphThreadStat[];
  warnings: string[];
  analyzer?: {
    engine: 'rust' | 'typescript-fallback';
    command?: string;
  };
  source?: {
    sampleTable: string;
    hasThreadInfo: boolean;
    filtersApplied: string[];
    truncated: boolean;
  };
}

export interface FlamegraphAvailability {
  available: boolean;
  sampleSource?: string;
  availableSources: Array<{
    name: string;
    hasCallsiteId: boolean;
    hasTimestamp: boolean;
    hasThreadId: boolean;
  }>;
  missing: string[];
  warnings: string[];
}

export interface FlamegraphAiSummary {
  generated: boolean;
  model?: string;
  summary: string;
  warnings: string[];
  redactionApplied?: boolean;
}
