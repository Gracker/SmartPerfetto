/**
 * Frame Analysis Types - Transformed format from backend
 *
 * This file defines the output format of transformDeepFrameAnalysis() in skillExecutor.ts.
 * Unlike the auto-generated jank_frame_detail.types.ts (raw skill output),
 * these types represent the final format sent to frontend.
 *
 * Data flow:
 *   YAML output_schema → raw skill data → transformDeepFrameAnalysis() → THIS FORMAT → frontend
 */

import { z } from 'zod';

// ===== Quadrant Analysis (transformed) =====
export interface QuadrantValues {
  q1: number;
  q2: number;
  q3: number;
  q4: number;
}

export interface TransformedQuadrants {
  main_thread: QuadrantValues;
  render_thread: QuadrantValues;
}

export const QuadrantValuesSchema = z.object({
  q1: z.number(),
  q2: z.number(),
  q3: z.number(),
  q4: z.number(),
});

export const TransformedQuadrantsSchema = z.object({
  main_thread: QuadrantValuesSchema,
  render_thread: QuadrantValuesSchema,
});

// ===== CPU Frequency (transformed) =====
export interface TransformedCpuFrequency {
  big_avg_mhz: number;
  little_avg_mhz: number;
}

export const TransformedCpuFrequencySchema = z.object({
  big_avg_mhz: z.number(),
  little_avg_mhz: z.number(),
});

// ===== Binder Call Item =====
export interface BinderCallItem {
  interface: string;
  count: number;
  dur_ms: number;
  max_ms: number;
  sync_count?: number;
}

export const BinderCallItemSchema = z.object({
  interface: z.string(),
  count: z.number(),
  dur_ms: z.number(),
  max_ms: z.number(),
  sync_count: z.number().optional(),
});

// ===== Thread Slice Item =====
export interface ThreadSliceItem {
  name: string;
  dur_ms: number;
  count: number;
  max_ms: number;
  avg_ms?: number;
  ts?: string;
}

export const ThreadSliceItemSchema = z.object({
  name: z.string(),
  dur_ms: z.number(),
  count: z.number(),
  max_ms: z.number(),
  avg_ms: z.number().optional(),
  ts: z.string().optional(),
});

// ===== CPU Frequency Timeline Item =====
export interface CpuFreqTimelineItem {
  ts: string;
  cpu: number;
  freq_mhz: number;
}

export const CpuFreqTimelineItemSchema = z.object({
  ts: z.string(),
  cpu: z.number(),
  freq_mhz: z.number(),
});

// ===== Lock Contention Item =====
export interface LockContentionItem {
  name: string;
  blocked_dur_ms: number;
  count: number;
}

export const LockContentionItemSchema = z.object({
  name: z.string(),
  blocked_dur_ms: z.number(),
  count: z.number(),
});

// ===== Full Analysis Object (output of transformDeepFrameAnalysis) =====
export interface FullAnalysis {
  quadrants: TransformedQuadrants;
  binder_calls: BinderCallItem[];
  cpu_frequency: TransformedCpuFrequency;
  main_thread_slices: ThreadSliceItem[];
  render_thread_slices: ThreadSliceItem[];
  cpu_freq_timeline: CpuFreqTimelineItem[];
  lock_contentions: LockContentionItem[];
}

export const FullAnalysisSchema = z.object({
  quadrants: TransformedQuadrantsSchema,
  binder_calls: z.array(BinderCallItemSchema),
  cpu_frequency: TransformedCpuFrequencySchema,
  main_thread_slices: z.array(ThreadSliceItemSchema),
  render_thread_slices: z.array(ThreadSliceItemSchema),
  cpu_freq_timeline: z.array(CpuFreqTimelineItemSchema),
  lock_contentions: z.array(LockContentionItemSchema),
});

// ===== Frame Detail Data (what frontend receives) =====
export interface FrameDetailData {
  diagnosis_summary: string;
  full_analysis: FullAnalysis;
}

export const FrameDetailDataSchema = z.object({
  diagnosis_summary: z.string(),
  full_analysis: FullAnalysisSchema,
});

// ===== Expandable Section (frontend display format) =====
export interface ExpandableSection {
  title: string;
  data: unknown[];
}

export interface ExpandableSections {
  [sectionId: string]: ExpandableSection;
}

// ===== Type Guards =====
export function isFrameDetailData(data: unknown): data is FrameDetailData {
  if (!data || typeof data !== 'object') return false;
  const d = data as Record<string, unknown>;
  return (
    typeof d.diagnosis_summary === 'string' ||
    (d.full_analysis !== undefined && typeof d.full_analysis === 'object')
  );
}

// ===== Validation Helper =====
export function validateFrameDetailData(data: unknown): {
  success: boolean;
  data?: FrameDetailData;
  error?: string;
} {
  const result = FrameDetailDataSchema.safeParse(data);
  if (result.success) {
    return { success: true, data: result.data };
  }
  return {
    success: false,
    error: result.error.errors.map((e) => `${e.path.join('.')}: ${e.message}`).join('; '),
  };
}
