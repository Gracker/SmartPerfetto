// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

/**
 * Analysis Pattern Memory — cross-session long-term memory for analysis insights.
 *
 * After each successful analysis, extracts trace feature fingerprints and key insights,
 * then persists them to disk. On new analyses, matches similar patterns and injects
 * relevant insights into the system prompt.
 *
 * P1 enhancements:
 * - Weighted tag matching (arch/scene weighted higher than finding titles)
 * - Confidence decay over time (exponential decay, not binary TTL)
 * - Negative memory: records what strategies FAILED for similar traces
 *
 * Storage: backend/logs/analysis_patterns.json (200 entry max, 60-day TTL)
 * Negative: backend/logs/analysis_negative_patterns.json (100 entry max, 90-day TTL)
 * Matching: Weighted Jaccard similarity on trace features
 */

import * as fs from 'fs';
import * as path from 'path';
import type { Finding } from '../agent/types';
import type {
  AnalysisPatternEntry,
  NegativePatternEntry,
  FailedApproach,
  PatternStatus,
  PatternProvenance,
} from './types';

const PATTERNS_FILE = path.resolve(__dirname, '../../logs/analysis_patterns.json');
const NEGATIVE_PATTERNS_FILE = path.resolve(__dirname, '../../logs/analysis_negative_patterns.json');
const QUICK_PATTERNS_FILE = path.resolve(__dirname, '../../logs/analysis_quick_patterns.json');
const MAX_PATTERNS = 200;
const MAX_NEGATIVE_PATTERNS = 100;
const MAX_QUICK_PATTERNS = 100;
const PATTERN_TTL_MS = 60 * 24 * 60 * 60 * 1000; // 60 days
const NEGATIVE_PATTERN_TTL_MS = 90 * 24 * 60 * 60 * 1000; // 90 days — negative memory persists longer
const QUICK_PATTERN_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days — quick-path bucket is short-lived
const MIN_MATCH_SCORE = 0.25; // Minimum weighted similarity to consider a match
const MAX_MATCHED_PATTERNS = 3; // Max patterns to inject into prompt
const MAX_MATCHED_NEGATIVE = 3; // Max negative patterns to inject

/**
 * Status-weighted multiplier applied at injection time. `confirmed` is full
 * weight; `provisional` (no feedback yet) is half; disputed entries are deeply
 * downweighted but still injected as a soft signal. `rejected` is excluded
 * entirely. Quick-path bucket entries get an additional 0.3× multiplier
 * (applied separately) so they only surface as fallbacks.
 */
const INJECTION_WEIGHTS: Record<PatternStatus, number> = {
  confirmed: 1.0,
  provisional: 0.5,
  disputed: 0.2,
  disputed_late: 0.2,
  rejected: 0,
};
const QUICK_BUCKET_WEIGHT = 0.3;

const TEN_SECONDS_MS = 10 * 1000;
const ONE_DAY_MS = 24 * 60 * 60 * 1000;
/** Provisional → confirmed promotion when no negative feedback within this window. */
const AUTO_CONFIRM_AFTER_MS = ONE_DAY_MS;

/**
 * Tag category weights for weighted Jaccard similarity.
 * Higher weight = more influence on similarity score.
 *
 * Rationale: arch + scene determine the analysis path (highest weight).
 * Domain (app family) moderately matters. Finding categories are medium.
 * Individual finding titles have low weight (too specific, may not generalize).
 */
const TAG_WEIGHTS: Record<string, number> = {
  'arch': 3.0,    // Architecture type is the strongest signal
  'scene': 3.0,   // Scene type is equally strong
  'domain': 2.0,  // App family (tencent/google/etc.)
  'cat': 1.5,     // Finding categories (GPU, CPU, etc.)
  'finding': 0.5, // Individual finding titles (too specific)
};
const DEFAULT_WEIGHT = 1.0;

/** Extract the category prefix from a tag (e.g., "arch:FLUTTER" → "arch"). */
function tagCategory(tag: string): string {
  const idx = tag.indexOf(':');
  return idx > 0 ? tag.substring(0, idx) : '';
}

/** Get the weight for a tag based on its category. */
function tagWeight(tag: string): number {
  return TAG_WEIGHTS[tagCategory(tag)] ?? DEFAULT_WEIGHT;
}

/**
 * Confidence decay factor based on pattern age.
 * Uses exponential decay with a half-life of 30 days.
 * A 60-day-old pattern retains 25% of its original confidence.
 */
function confidenceDecay(createdAt: number): number {
  const ageMs = Date.now() - createdAt;
  const halfLifeMs = 30 * 24 * 60 * 60 * 1000; // 30 days
  return Math.pow(0.5, ageMs / halfLifeMs);
}

/**
 * P1-G10: Combined eviction score for pattern retention.
 * Balances recency (confidence decay) with frequency (match count).
 * A highly-matched old pattern retains priority over a new single-match pattern.
 *
 * Score examples (matchCount, age → score):
 *   (0, 0d) → 1.0,  (10, 0d) → 4.46,  (0, 30d) → 0.5,  (10, 30d) → 2.23
 */
function evictionScore(p: { createdAt: number; matchCount: number }): number {
  return confidenceDecay(p.createdAt) * (1 + Math.log2(1 + p.matchCount));
}

/** Legacy entries (no `status` field on disk) behave as `confirmed`. */
function getEffectiveStatus(p: { status?: PatternStatus }): PatternStatus {
  return p.status ?? 'confirmed';
}

function getStatusWeight(p: { status?: PatternStatus }): number {
  return INJECTION_WEIGHTS[getEffectiveStatus(p)];
}

/**
 * Promote a `provisional` pattern to `confirmed` if it has aged past the
 * auto-confirm window without picking up negative feedback. Mutates and
 * returns true if a transition happened — caller is responsible for
 * persisting.
 */
function autoConfirmIfRipe(
  p: AnalysisPatternEntry | NegativePatternEntry,
  now: number,
): boolean {
  if (p.status !== 'provisional') return false;
  if (now - p.createdAt < AUTO_CONFIRM_AFTER_MS) return false;
  p.status = 'confirmed';
  return true;
}

/**
 * Optional metadata that callers (claudeRuntime, review agent, feedback path)
 * attach to new pattern entries. Every field is optional so existing
 * positional-argument callers keep working unchanged.
 */
export interface PatternSaveExtras {
  /** Defaults to 'provisional' on save. */
  status?: PatternStatus;
  failureModeHash?: string;
  provenance?: PatternProvenance;
  bucketKey?: string;
}

/** Load patterns from disk. */
function loadPatterns(): AnalysisPatternEntry[] {
  try {
    if (!fs.existsSync(PATTERNS_FILE)) return [];
    const data = fs.readFileSync(PATTERNS_FILE, 'utf-8');
    return JSON.parse(data) as AnalysisPatternEntry[];
  } catch {
    return [];
  }
}

/** Load negative patterns from disk. */
function loadNegativePatterns(): NegativePatternEntry[] {
  try {
    if (!fs.existsSync(NEGATIVE_PATTERNS_FILE)) return [];
    const data = fs.readFileSync(NEGATIVE_PATTERNS_FILE, 'utf-8');
    return JSON.parse(data) as NegativePatternEntry[];
  } catch {
    return [];
  }
}

/** Save patterns to disk (atomic write). */
async function savePatterns(patterns: AnalysisPatternEntry[]): Promise<void> {
  try {
    const dir = path.dirname(PATTERNS_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const tmpFile = PATTERNS_FILE + '.tmp';
    await fs.promises.writeFile(tmpFile, JSON.stringify(patterns, null, 2));
    await fs.promises.rename(tmpFile, PATTERNS_FILE);
  } catch (err) {
    console.warn('[PatternMemory] Failed to save patterns:', (err as Error).message);
  }
}

/** Save negative patterns to disk (atomic write). */
async function saveNegativePatterns(patterns: NegativePatternEntry[]): Promise<void> {
  try {
    const dir = path.dirname(NEGATIVE_PATTERNS_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const tmpFile = NEGATIVE_PATTERNS_FILE + '.tmp';
    await fs.promises.writeFile(tmpFile, JSON.stringify(patterns, null, 2));
    await fs.promises.rename(tmpFile, NEGATIVE_PATTERNS_FILE);
  } catch (err) {
    console.warn('[PatternMemory] Failed to save negative patterns:', (err as Error).message);
  }
}

/**
 * Weighted Jaccard similarity between two tag sets.
 * Each tag contributes its category weight to the intersection/union calculation.
 */
function weightedJaccardSimilarity(a: string[], b: string[]): number {
  const setA = new Set(a.map(s => s.toLowerCase()));
  const setB = new Set(b.map(s => s.toLowerCase()));
  if (setA.size === 0 && setB.size === 0) return 0;

  let intersectionWeight = 0;
  let unionWeight = 0;

  const allTags = new Set([...setA, ...setB]);
  for (const tag of allTags) {
    const w = tagWeight(tag);
    const inA = setA.has(tag);
    const inB = setB.has(tag);
    unionWeight += w;
    if (inA && inB) intersectionWeight += w;
  }

  return unionWeight > 0 ? intersectionWeight / unionWeight : 0;
}

/**
 * Extract trace feature fingerprint from analysis context.
 * Used for similarity matching across sessions.
 */
export function extractTraceFeatures(context: {
  architectureType?: string;
  sceneType?: string;
  packageName?: string;
  findingTitles?: string[];
  findingCategories?: string[];
}): string[] {
  const features: string[] = [];

  if (context.architectureType) features.push(`arch:${context.architectureType}`);
  if (context.sceneType) features.push(`scene:${context.sceneType}`);
  if (context.packageName) {
    // Extract app domain from package name (e.g. "com.tencent.mm" → "tencent")
    const parts = context.packageName.split('.');
    if (parts.length >= 2) features.push(`domain:${parts[1]}`);
  }

  // Add finding categories and key titles as features
  if (context.findingCategories) {
    for (const cat of new Set(context.findingCategories)) {
      features.push(`cat:${cat}`);
    }
  }
  if (context.findingTitles) {
    for (const title of context.findingTitles.slice(0, 5)) {
      // Normalize: take first significant words
      const normalized = title.replace(/[^\w\u4e00-\u9fff]/g, ' ').trim().substring(0, 30);
      if (normalized) features.push(`finding:${normalized}`);
    }
  }

  return features;
}

/**
 * Extract key insights from analysis findings and conclusion.
 * These are the patterns worth remembering across sessions.
 */
export function extractKeyInsights(
  findings: Finding[],
  conclusion: string,
): string[] {
  const insights: string[] = [];

  // Extract CRITICAL/HIGH findings with root cause as insights
  const important = findings.filter(f => f.severity === 'critical' || f.severity === 'high');
  for (const f of important.slice(0, 5)) {
    const insight = `${f.title}: ${f.description?.substring(0, 150) || ''}`;
    insights.push(insight);
  }

  // Extract key patterns from conclusion (look for root cause statements)
  const rootCauseMatch = conclusion.match(/根因[：:]\s*([^\n]{10,150})/);
  if (rootCauseMatch) {
    insights.push(`根因: ${rootCauseMatch[1]}`);
  }

  return insights;
}

/**
 * Save an analysis pattern to persistent storage.
 * Call after a successful analysis to build long-term memory.
 */
export async function saveAnalysisPattern(
  features: string[],
  insights: string[],
  sceneType: string,
  architectureType?: string,
  confidence?: number,
  extras: PatternSaveExtras = {},
): Promise<void> {
  if (features.length === 0 || insights.length === 0) return;

  const patterns = loadPatterns();
  const now = Date.now();

  // Deduplicate: check if a very similar pattern already exists (>70% similarity)
  const existingIdx = patterns.findIndex(p => weightedJaccardSimilarity(p.traceFeatures, features) > 0.7);

  if (existingIdx >= 0) {
    // Update existing pattern: merge insights, bump match count
    const existing = patterns[existingIdx];
    const uniqueInsights = new Set([...existing.keyInsights, ...insights]);
    existing.keyInsights = Array.from(uniqueInsights).slice(0, 10);
    existing.matchCount++;
    existing.createdAt = now; // Refresh timestamp
    if (confidence !== undefined) existing.confidence = confidence;
    if (extras.failureModeHash) existing.failureModeHash = extras.failureModeHash;
    if (extras.bucketKey) existing.bucketKey = extras.bucketKey;
    if (extras.provenance) existing.provenance = extras.provenance;
    // Re-saves don't downgrade status — a provisional pattern that has
    // already auto-confirmed must not slip back to provisional.
  } else {
    const id = `pat-${now}-${Math.random().toString(36).substring(2, 6)}`;
    patterns.push({
      id,
      traceFeatures: features,
      sceneType,
      keyInsights: insights.slice(0, 10),
      architectureType,
      confidence: confidence ?? 0.5,
      createdAt: now,
      matchCount: 0,
      status: extras.status ?? 'provisional',
      failureModeHash: extras.failureModeHash,
      bucketKey: extras.bucketKey,
      provenance: extras.provenance,
    });
  }

  // Prune expired + enforce max size (P1-G10: frequency-aware eviction)
  const cutoff = now - PATTERN_TTL_MS;
  const active = patterns
    .filter(p => p.createdAt >= cutoff)
    .sort((a, b) => evictionScore(b) - evictionScore(a))
    .slice(0, MAX_PATTERNS);

  await savePatterns(active);
}

/**
 * Save a negative pattern — records what strategies FAILED for similar traces.
 * Call after watchdog triggers, verification failures, or persistent tool errors.
 */
export async function saveNegativePattern(
  features: string[],
  failedApproaches: FailedApproach[],
  sceneType: string,
  architectureType?: string,
  extras: PatternSaveExtras = {},
): Promise<void> {
  if (features.length === 0 || failedApproaches.length === 0) return;

  const patterns = loadNegativePatterns();

  // Deduplicate: merge into existing pattern if >70% similar
  const existingIdx = patterns.findIndex(p => weightedJaccardSimilarity(p.traceFeatures, features) > 0.7);

  const now = Date.now();
  if (existingIdx >= 0) {
    const existing = patterns[existingIdx];
    const existingKeys = new Set(existing.failedApproaches.map(a => `${a.type}:${a.approach}`));
    for (const approach of failedApproaches) {
      const key = `${approach.type}:${approach.approach}`;
      if (!existingKeys.has(key)) {
        existing.failedApproaches.push(approach);
        existingKeys.add(key);
      }
    }
    existing.failedApproaches = existing.failedApproaches.slice(-10);
    existing.matchCount++;
    existing.createdAt = now;
    if (extras.failureModeHash) existing.failureModeHash = extras.failureModeHash;
    if (extras.bucketKey) existing.bucketKey = extras.bucketKey;
    if (extras.provenance) existing.provenance = extras.provenance;
  } else {
    const id = `neg-${now}-${Math.random().toString(36).substring(2, 6)}`;
    patterns.push({
      id,
      traceFeatures: features,
      sceneType,
      failedApproaches: failedApproaches.slice(0, 10),
      architectureType,
      createdAt: now,
      matchCount: 0,
      status: extras.status ?? 'provisional',
      failureModeHash: extras.failureModeHash,
      bucketKey: extras.bucketKey,
      provenance: extras.provenance,
    });
  }

  // Prune expired + enforce max size (P1-G10: frequency-aware eviction)
  const cutoff = Date.now() - NEGATIVE_PATTERN_TTL_MS;
  const active = patterns
    .filter(p => p.createdAt >= cutoff)
    .sort((a, b) => evictionScore(b) - evictionScore(a))
    .slice(0, MAX_NEGATIVE_PATTERNS);

  await saveNegativePatterns(active);
}

/**
 * Find patterns similar to the current trace features.
 * Returns matched patterns sorted by effective score (similarity × decay).
 */
export function matchPatterns(features: string[]): Array<AnalysisPatternEntry & { score: number }> {
  if (features.length === 0) return [];

  const patterns = loadPatterns();
  const cutoff = Date.now() - PATTERN_TTL_MS;

  return patterns
    .filter(p => p.createdAt >= cutoff)
    .filter(p => getEffectiveStatus(p) !== 'rejected')
    .map(p => {
      const rawSimilarity = weightedJaccardSimilarity(p.traceFeatures, features);
      const decay = confidenceDecay(p.createdAt);
      // log2(1 + matchCount): 0→1.0, 1→1.0, 2→1.58, 5→2.58, 10→3.46
      const frequencyGain = 1 + Math.log2(1 + p.matchCount) * 0.1;
      const statusWeight = getStatusWeight(p);
      return {
        ...p,
        score: rawSimilarity * decay * frequencyGain * statusWeight,
      };
    })
    .filter(p => p.score >= MIN_MATCH_SCORE)
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_MATCHED_PATTERNS);
}

/**
 * Find negative patterns similar to the current trace features.
 * Negative patterns persist longer (90 days) and use the same weighted matching.
 */
export function matchNegativePatterns(features: string[]): Array<NegativePatternEntry & { score: number }> {
  if (features.length === 0) return [];

  const patterns = loadNegativePatterns();
  const cutoff = Date.now() - NEGATIVE_PATTERN_TTL_MS;

  return patterns
    .filter(p => p.createdAt >= cutoff)
    .filter(p => getEffectiveStatus(p) !== 'rejected')
    .map(p => {
      const frequencyGain = 1 + Math.log2(1 + p.matchCount) * 0.1;
      const statusWeight = getStatusWeight(p);
      return {
        ...p,
        score:
          weightedJaccardSimilarity(p.traceFeatures, features) *
          confidenceDecay(p.createdAt) *
          frequencyGain *
          statusWeight,
      };
    })
    .filter(p => p.score >= MIN_MATCH_SCORE)
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_MATCHED_NEGATIVE);
}

// =============================================================================
// Quick-path bucket — short TTL fallback memory for analyzeQuick() runs
// =============================================================================

/** Load entries from the 7-day quick-path bucket. */
function loadQuickPatterns(): AnalysisPatternEntry[] {
  try {
    if (!fs.existsSync(QUICK_PATTERNS_FILE)) return [];
    return JSON.parse(fs.readFileSync(QUICK_PATTERNS_FILE, 'utf-8')) as AnalysisPatternEntry[];
  } catch {
    return [];
  }
}

async function saveQuickPatterns(patterns: AnalysisPatternEntry[]): Promise<void> {
  try {
    const dir = path.dirname(QUICK_PATTERNS_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const tmp = QUICK_PATTERNS_FILE + '.tmp';
    await fs.promises.writeFile(tmp, JSON.stringify(patterns, null, 2));
    await fs.promises.rename(tmp, QUICK_PATTERNS_FILE);
  } catch (err) {
    console.warn('[PatternMemory] Failed to save quick patterns:', (err as Error).message);
  }
}

/**
 * Save a pattern derived from a quick-path analysis. Quick-path conclusions
 * are weaker (5-turn budget, no verifier) so they go into a separate bucket
 * with a 7-day TTL and only surface as fallbacks (×0.3 weight) when no
 * full-path pattern matches the same features.
 */
export async function saveQuickPathPattern(
  features: string[],
  insights: string[],
  sceneType: string,
  architectureType?: string,
  extras: PatternSaveExtras = {},
): Promise<void> {
  if (features.length === 0 || insights.length === 0) return;

  const patterns = loadQuickPatterns();
  const now = Date.now();
  const id = `qp-${now}-${Math.random().toString(36).substring(2, 6)}`;
  patterns.push({
    id,
    traceFeatures: features,
    sceneType,
    keyInsights: insights.slice(0, 5),
    architectureType,
    confidence: 0.3,
    createdAt: now,
    matchCount: 0,
    status: extras.status ?? 'provisional',
    failureModeHash: extras.failureModeHash,
    bucketKey: extras.bucketKey,
    provenance: extras.provenance,
  });

  const cutoff = now - QUICK_PATTERN_TTL_MS;
  const active = patterns
    .filter(p => p.createdAt >= cutoff)
    .sort((a, b) => evictionScore(b) - evictionScore(a))
    .slice(0, MAX_QUICK_PATTERNS);

  await saveQuickPatterns(active);
}

/**
 * Match quick-path patterns as a fallback. Only used when `matchPatterns()`
 * came back empty for the current features — surfaces with ×0.3 weight on
 * top of the usual scoring chain so a stronger long-term match always wins.
 */
export function matchQuickPatternsAsBackup(
  features: string[],
): Array<AnalysisPatternEntry & { score: number }> {
  if (features.length === 0) return [];
  const patterns = loadQuickPatterns();
  const cutoff = Date.now() - QUICK_PATTERN_TTL_MS;
  return patterns
    .filter(p => p.createdAt >= cutoff)
    .filter(p => getEffectiveStatus(p) !== 'rejected')
    .map(p => {
      const rawSimilarity = weightedJaccardSimilarity(p.traceFeatures, features);
      const statusWeight = getStatusWeight(p);
      return { ...p, score: rawSimilarity * statusWeight * QUICK_BUCKET_WEIGHT };
    })
    .filter(p => p.score >= MIN_MATCH_SCORE * QUICK_BUCKET_WEIGHT)
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_MATCHED_PATTERNS);
}

/**
 * Promote a quick-path pattern to long-term memory once a full-path run
 * verifies the same features with the same scene/arch/domain and at least
 * one matching insight category. Returns true on promotion.
 *
 * Implements the six-criterion judgement from §6 of the design doc:
 *   1. same sceneType + archType + domain
 *   2. weighted Jaccard similarity ≥ 0.65
 *   3. full-path verifier passed (caller's responsibility — pass `true`)
 *   4. at least one matching insight or finding category
 *   5. quick pattern has no rejected/disputed status
 *   6. (caller may also gate on full packageName equality as bonus)
 */
export async function promoteQuickPatternIfMatching(input: {
  fullPathFeatures: string[];
  fullPathInsights: string[];
  sceneType: string;
  architectureType?: string;
  verifierPassed: boolean;
}): Promise<boolean> {
  if (!input.verifierPassed) return false;
  const candidates = loadQuickPatterns();
  const winner = candidates
    .filter(p => getEffectiveStatus(p) !== 'rejected' && getEffectiveStatus(p) !== 'disputed')
    .filter(p => p.sceneType === input.sceneType && p.architectureType === input.architectureType)
    .map(p => ({
      pattern: p,
      similarity: weightedJaccardSimilarity(p.traceFeatures, input.fullPathFeatures),
    }))
    .filter(({ similarity }) => similarity >= 0.65)
    .sort((a, b) => b.similarity - a.similarity)[0];

  if (!winner) return false;

  // Require ≥1 overlapping insight category — guards against noise promotion.
  const quickInsightTokens = new Set(
    winner.pattern.keyInsights.map(i => i.toLowerCase().substring(0, 40)),
  );
  const hasOverlap = input.fullPathInsights.some(i =>
    quickInsightTokens.has(i.toLowerCase().substring(0, 40)),
  );
  if (!hasOverlap) return false;

  await saveAnalysisPattern(
    input.fullPathFeatures,
    input.fullPathInsights,
    input.sceneType,
    input.architectureType,
    winner.pattern.confidence,
    {
      status: 'confirmed',
      failureModeHash: winner.pattern.failureModeHash,
      bucketKey: winner.pattern.bucketKey,
      provenance: winner.pattern.provenance,
    },
  );
  return true;
}

// =============================================================================
// Feedback-driven state machine
// =============================================================================

export type FeedbackRating = 'positive' | 'negative';

/**
 * Apply a feedback rating to the pattern matching `patternId` (across both
 * positive and quick buckets). Implements the time-window rules from §4.3:
 *   <10s reverse: last-write-wins (audit only)
 *   10s–24h reverse: → disputed
 *   >24h reverse: → disputed_late
 * Same-direction feedback simply refreshes lastFeedbackAt.
 *
 * Returns the resulting status, or `null` when the pattern was not found.
 */
export async function applyFeedbackToPattern(
  patternId: string,
  rating: FeedbackRating,
  now: number = Date.now(),
): Promise<PatternStatus | null> {
  const positives = loadPatterns();
  const quick = loadQuickPatterns();
  const negatives = loadNegativePatterns();

  const allBuckets: Array<{ entry: AnalysisPatternEntry | NegativePatternEntry; bucket: 'positive' | 'quick' | 'negative' }> = [];
  for (const p of positives) allBuckets.push({ entry: p, bucket: 'positive' });
  for (const p of quick) allBuckets.push({ entry: p, bucket: 'quick' });
  for (const p of negatives) allBuckets.push({ entry: p, bucket: 'negative' });

  const target = allBuckets.find(b => b.entry.id === patternId);
  if (!target) return null;

  const next = transitionStatus(target.entry, rating, now);
  target.entry.status = next;
  target.entry.lastFeedbackAt = now;
  if (target.entry.firstFeedbackAt === undefined) {
    target.entry.firstFeedbackAt = now;
  }

  if (target.bucket === 'positive') await savePatterns(positives);
  if (target.bucket === 'quick') await saveQuickPatterns(quick);
  if (target.bucket === 'negative') await saveNegativePatterns(negatives);

  return next;
}

/**
 * Pure state transition for feedback. Splits `disputed` (10s–24h reverse) from
 * `disputed_late` (>24h reverse) so the auditor can tell ergonomic flips from
 * considered re-evaluations.
 */
function transitionStatus(
  entry: { status?: PatternStatus; firstFeedbackAt?: number },
  rating: FeedbackRating,
  now: number,
): PatternStatus {
  const current = getEffectiveStatus(entry);
  if (current === 'rejected') return 'rejected';

  const targetForRating: PatternStatus = rating === 'positive' ? 'confirmed' : 'rejected';

  // Same direction or first-time feedback on a provisional/confirmed entry.
  if (current === targetForRating) return current;
  if (current === 'provisional') return targetForRating;
  if (current === 'confirmed' && rating === 'positive') return 'confirmed';

  // Reverse feedback — choose disputed window by elapsed time since first feedback.
  const since = entry.firstFeedbackAt ?? now;
  const elapsed = now - since;
  if (elapsed < TEN_SECONDS_MS) {
    // Treat as misclick: last-write-wins, no audit trail expansion.
    return targetForRating;
  }
  if (elapsed <= ONE_DAY_MS) {
    return 'disputed';
  }
  return 'disputed_late';
}

// =============================================================================
// Auto-confirm sweep — promote ripe provisional entries on the next prompt build
// =============================================================================

/**
 * Sweep each on-disk bucket and promote any provisional entries past the
 * auto-confirm window. Run lazily from the system prompt builder so the
 * cost is amortized across normal traffic.
 */
export async function sweepAutoConfirm(now: number = Date.now()): Promise<void> {
  const positives = loadPatterns();
  let positiveDirty = false;
  for (const p of positives) {
    if (autoConfirmIfRipe(p, now)) positiveDirty = true;
  }
  if (positiveDirty) await savePatterns(positives);

  const negatives = loadNegativePatterns();
  let negativeDirty = false;
  for (const p of negatives) {
    if (autoConfirmIfRipe(p, now)) negativeDirty = true;
  }
  if (negativeDirty) await saveNegativePatterns(negatives);
}

/**
 * Build a system prompt section from matched patterns.
 * Provides cross-session context to Claude.
 */
export function buildPatternContextSection(features: string[]): string | undefined {
  const matches = matchPatterns(features);
  if (matches.length === 0) return undefined;

  const lines = matches.map((m, i) => {
    const insightText = m.keyInsights.slice(0, 3).map(ins => `  - ${ins}`).join('\n');
    const decayPct = (confidenceDecay(m.createdAt) * 100).toFixed(0);
    return `${i + 1}. **${m.sceneType}${m.architectureType ? ` (${m.architectureType})` : ''}** (相似度 ${(m.score * 100).toFixed(0)}%, 信心 ${decayPct}%, 匹配 ${m.matchCount + 1} 次)\n${insightText}`;
  });

  return `## 历史分析经验（跨会话记忆）

以下是过往类似 trace 的分析经验，供参考（不一定适用于当前 trace）：

${lines.join('\n\n')}

> 这些经验来自之前的分析会话。如果当前 trace 的数据与历史经验矛盾，以当前数据为准。`;
}

/**
 * Build a system prompt section from matched negative patterns.
 * Warns Claude about strategies that previously FAILED for similar traces.
 */
export function buildNegativePatternSection(features: string[]): string | undefined {
  const matches = matchNegativePatterns(features);
  if (matches.length === 0) return undefined;

  const lines: string[] = [];
  for (const m of matches) {
    for (const a of m.failedApproaches.slice(0, 3)) {
      const workaround = a.workaround ? ` → 替代方案: ${a.workaround}` : '';
      lines.push(`- **避免**: ${a.approach} — ${a.reason}${workaround}`);
    }
  }

  // Deduplicate lines
  const uniqueLines = [...new Set(lines)].slice(0, 6);
  if (uniqueLines.length === 0) return undefined;

  return `## 历史踩坑记录（避免重复失败）

以下策略在类似 trace 的分析中**失败过**，请优先尝试其他方案：

${uniqueLines.join('\n')}

> 这些是跨会话积累的失败经验。如果没有替代方案，可以谨慎尝试，但请准备 fallback 策略。`;
}