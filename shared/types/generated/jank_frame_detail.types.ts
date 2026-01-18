/**
 * Auto-generated types for skill: jank_frame_detail
 * DO NOT EDIT - Generated from jank_frame_detail.skill.yaml
 */

import { z } from 'zod';

// ===== quadrant_analysis =====
export interface QuadrantDataItem {
  /** 象限标识 (如 MainThread Q1_大核运行) */
  quadrant: string;
  /** 象限名称 */
  name: string;
  /** 持续时间(ms) */
  dur_ms: number;
  /** 百分比 */
  percentage: number;
}

export const QuadrantDataItemSchema = z.object({
  quadrant: z.string(),
  name: z.string(),
  dur_ms: z.number(),
  percentage: z.number(),
});

// ===== binder_calls =====
export interface BinderDataItem {
  /** 服务端进程名 */
  interface: string;
  /** 调用次数 */
  count: number;
  /** 总耗时(ms) */
  dur_ms: number;
  /** 最大单次耗时(ms) */
  max_ms: number;
  /** 同步调用次数 */
  sync_count: number;
}

export const BinderDataItemSchema = z.object({
  interface: z.string(),
  count: z.number(),
  dur_ms: z.number(),
  max_ms: z.number(),
  sync_count: z.number(),
});

// ===== cpu_freq_analysis =====
export interface FreqDataItem {
  /** 核心类型 (big/little) */
  core_type: string;
  /** 平均频率(MHz) */
  avg_freq_mhz: number;
  /** 最大频率(MHz) */
  max_freq_mhz: number;
  /** 最小频率(MHz) */
  min_freq_mhz: number;
}

export const FreqDataItemSchema = z.object({
  core_type: z.string(),
  avg_freq_mhz: z.number(),
  max_freq_mhz: z.number(),
  min_freq_mhz: z.number(),
});

// ===== main_thread_slices =====
export interface MainSlicesItem {
  /** 操作名称 */
  name: string;
  /** 总耗时(ms) */
  dur_ms: number;
  /** 执行次数 */
  count: number;
  /** 最大单次耗时(ms) */
  max_ms: number;
  /** 首次时间戳(ns字符串) */
  ts: string;
}

export const MainSlicesItemSchema = z.object({
  name: z.string(),
  dur_ms: z.number(),
  count: z.number(),
  max_ms: z.number(),
  ts: z.string(),
});

// ===== render_thread_slices =====
export interface RenderSlicesItem {
  /** 操作名称 */
  name: string;
  /** 总耗时(ms) */
  dur_ms: number;
  /** 执行次数 */
  count: number;
  /** 最大单次耗时(ms) */
  max_ms: number;
  /** 平均耗时(ms) */
  avg_ms: number;
  /** 首次时间戳(ns字符串) */
  ts: string;
}

export const RenderSlicesItemSchema = z.object({
  name: z.string(),
  dur_ms: z.number(),
  count: z.number(),
  max_ms: z.number(),
  avg_ms: z.number(),
  ts: z.string(),
});

// ===== Combined Result =====
export interface JankFrameDetailResult {
  quadrant_data: QuadrantDataItem[];
  binder_data?: BinderDataItem[];
  freq_data?: FreqDataItem[];
  main_slices: MainSlicesItem[];
  render_slices?: RenderSlicesItem[];
}

export const JankFrameDetailResultSchema = z.object({
  quadrant_data: z.array(QuadrantDataItemSchema),
  binder_data: z.array(BinderDataItemSchema).optional(),
  freq_data: z.array(FreqDataItemSchema).optional(),
  main_slices: z.array(MainSlicesItemSchema),
  render_slices: z.array(RenderSlicesItemSchema).optional(),
});

// Step schema lookup for runtime validation
export const JankFrameDetailStepSchemas: Record<string, z.ZodSchema> = {
  'quadrant_data': z.array(QuadrantDataItemSchema),
  'binder_data': z.array(BinderDataItemSchema),
  'freq_data': z.array(FreqDataItemSchema),
  'main_slices': z.array(MainSlicesItemSchema),
  'render_slices': z.array(RenderSlicesItemSchema),
};