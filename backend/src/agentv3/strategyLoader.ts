// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

/**
 * Loads external prompt content from `backend/strategies/`:
 *
 * 1. **Scene strategies** (`*.strategy.md`): YAML frontmatter + Markdown body.
 *    Used by `sceneClassifier.ts` for matching and `claudeSystemPrompt.ts` for injection.
 *    Adding a new scene requires only a new `.strategy.md` file, no code changes.
 *
 * 2. **Prompt templates** (`*.template.md`): Markdown with optional `{{variable}}`
 *    placeholders, substituted at runtime by `renderTemplate()`.
 *    Used by `claudeSystemPrompt.ts` for role, methodology, output format,
 *    architecture guidance, and selection context sections.
 *    Adding/editing prompt content requires only template changes, no code changes.
 *
 * Both categories are cached on first load and cleared together via `invalidateStrategyCache()`.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';
import type { ExpectedCall } from './types';
import {canonicalContentHash} from '../services/selfEvolution/canonicalJson';
import {currentRunManifestAttributionSink} from '../services/selfEvolution/runManifestLifecycle';

/** Phase-level restatement hint — loaded from strategy frontmatter `phase_hints`. */
export interface PhaseHint {
  id: string;
  keywords: string[];
  constraints: string;
  criticalTools: string[];
  /** When true, this hint is injected as unconditional fallback if keyword matching fails. */
  critical: boolean;
}

/** On-demand strategy detail section parsed from Markdown comment blocks. */
export interface StrategyDetailSection {
  /** Stable id local to the scene, e.g. `overview` or `root_cause_drill`. */
  id: string;
  /** Fully-qualified ref returned to the agent, e.g. `scrolling:overview`. */
  ref: string;
  title: string;
  keywords: string[];
  content: string;
  /** Preferred fallback when keyword matching is weak. */
  default: boolean;
}

export interface StrategyDetailMatch {
  detail: StrategyDetailSection;
  score: number;
  matchedKeywords: string[];
}

/**
 * A single mandatory aspect a plan must touch — sourced from a scene's
 * `plan_template.mandatory_aspects` frontmatter. The submit_plan /
 * revise_plan hard-gate fails when no plan phase mentions any of the
 * `matchKeywords`.
 */
export interface PlanMandatoryAspect {
  /** Stable identifier for diff-friendly tracking (e.g. `frame_jank_analysis`). */
  id: string;
  matchKeywords: string[];
  /** If present, this aspect is enforced only when the submitted plan mentions one of these terms. */
  triggerKeywords?: string[];
  suggestion: string;
  /** Calls that must be declared on at least one matching plan phase. */
  requiredExpectedCalls?: ExpectedCall[];
  /** At least one of these calls must be declared on a matching plan phase. */
  alternativeExpectedCalls?: ExpectedCall[];
  /** Calls selected by detected context; every matching group is additive. */
  conditionalRequiredExpectedCalls?: Array<{
    triggerKeywords: string[];
    requiredExpectedCalls: ExpectedCall[];
  }>;
  /** When false, submit_plan must cover this aspect in the plan; waivers are ignored. */
  waivable?: boolean;
}

/** Plan template loaded from a strategy's `plan_template:` frontmatter. */
export interface PlanTemplate {
  mandatoryAspects: PlanMandatoryAspect[];
}

/**
 * Scene-owned final report contract. Strategies declare these as data so
 * runtime quality gates can enforce scene completeness without adding
 * TypeScript branches for every analysis scenario.
 */
export interface FinalReportContractRequirement {
  id: string;
  label: string;
  description?: string;
  /**
   * Optional JavaScript regex patterns that make a required section conditional.
   * When present, the section is enforced only if the user's query mentions
   * the evidence surface described by these triggers.
   */
  triggerPatterns: string[];
  patterns: string[];
  /** AND-of-OR groups. Each inner group must match at least one pattern. */
  patternGroups: string[][];
  /** Strategy-owned deterministic recovery copy for missing report structure. */
  recoveryText: { zh: string[]; en: string[] };
  /** Defaults to true. Optional entries document nice-to-have structure. */
  required: boolean;
}

export interface FinalReportContract {
  requiredSections: FinalReportContractRequirement[];
}

export type VerifierMisdiagnosisSeverity = 'warning' | 'info';

export interface VerifierMisdiagnosisPattern {
  id: string;
  patterns: string[];
  message: string;
  severity: VerifierMisdiagnosisSeverity;
  type: 'known_misdiagnosis';
  scenes: string[];
  global: boolean;
  sourceScene: string;
}

export type StrategyKind = 'normal' | 'contract_only';

export interface StrategyDefinition {
  scene: string;
  /** contract_only strategies expose contracts without classifier/prompt injection. */
  strategyKind: StrategyKind;
  priority: number;
  effort: string;
  keywords: string[];
  compoundPatterns: RegExp[];
  /** Capability IDs required for this scene (missing = critical gap) */
  requiredCapabilities: string[];
  /** Capability IDs that enhance analysis but are not required */
  optionalCapabilities: string[];
  /** Phase-level hints for mid-analysis restatement injection. */
  phaseHints: PhaseHint[];
  /**
   * Plan template — mandatory aspects every submitted plan must cover for
   * this scene. `null` (vs. an empty mandatoryAspects array) means the
   * scene has deliberately opted out of plan-template validation.
   */
  planTemplate: PlanTemplate | null;
  /**
   * Data-only contract for final answer completeness. Runtime code must
   * execute this contract generically instead of hardcoding scene checks.
   */
  finalReportContract: FinalReportContract | null;
  verifierMisdiagnosisPatterns: VerifierMisdiagnosisPattern[];
  /**
   * Core strategy content injected into the system prompt. If the source file
   * contains `strategy-detail` blocks, those blocks are stripped from `content`
   * and exposed through `detailSections`.
   */
  content: string;
  /** Detail sections loaded on demand via plan-tool responses or lookup_strategy_detail. */
  detailSections: StrategyDetailSection[];
  /**
   * Absolute path to the source `*.strategy.md` file. Required because the
   * scene id (e.g. `touch_tracking`) is not always the file basename
   * (`touch-tracking.strategy.md`); callers that need the file itself —
   * fingerprinting, hot-reload diffing — must resolve through this field
   * instead of `${scene}.strategy.md`.
   */
  sourcePath: string;
}

const STRATEGIES_DIR = path.resolve(__dirname, '../../strategies');
/** Tolerates leading `<!-- -->` blocks (e.g. SPDX/license headers) before the frontmatter. */
const FRONTMATTER_RE = /^(?:\s*<!--[\s\S]*?-->\s*)*---\n([\s\S]*?)\n---\n?([\s\S]*)$/;
const STRATEGY_DETAIL_RE = /<!--\s*strategy-detail\b([^>]*)-->\s*([\s\S]*?)\s*<!--\s*\/strategy-detail\s*-->/g;
const DEFAULT_STRATEGY_DETAIL_EXCERPT_CHARS = 1600;
/** In dev mode, skip caching so .strategy.md / .template.md edits take effect without restart. */
const DEV_MODE = process.env.NODE_ENV !== 'production';

let cache: Map<string, StrategyDefinition> | null = null;

function parseExpectedCalls(value: unknown): ExpectedCall[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry): ExpectedCall | null => {
      if (!entry || typeof entry !== 'object') return null;
      const record = entry as Record<string, unknown>;
      const tool = typeof record.tool === 'string' ? record.tool : '';
      const skillId = typeof record.skillId === 'string'
        ? record.skillId
        : typeof record.skill_id === 'string'
          ? record.skill_id
          : undefined;
      return tool ? { tool, ...(skillId ? { skillId } : {}) } : null;
    })
    .filter((entry): entry is ExpectedCall => entry !== null);
}

function parseDetailAttributes(raw: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const attrRe = /(\w+)="([^"]*)"/g;
  let match: RegExpExecArray | null;
  while ((match = attrRe.exec(raw)) !== null) {
    attrs[match[1]] = match[2];
  }
  return attrs;
}

function parseCsv(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(/[，,]/g)
    .map(item => item.trim())
    .filter(Boolean);
}

function firstMarkdownHeading(markdown: string): string | undefined {
  const heading = markdown.match(/^#{1,6}\s+(.+)$/m)?.[1]?.trim();
  return heading ? heading.replace(/#+\s*$/, '').trim() : undefined;
}

function slugifyDetailId(value: string, fallback: string): string {
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/[`"'“”‘’]/g, '')
    .replace(/[^a-z0-9_\-\u4e00-\u9fff]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return slug || fallback;
}

function parseStrategyDetails(scene: string, markdown: string): { coreContent: string; detailSections: StrategyDetailSection[] } {
  const detailSections: StrategyDetailSection[] = [];
  let detailOrdinal = 0;
  const coreContent = markdown.replace(STRATEGY_DETAIL_RE, (_full, rawAttrs: string, rawContent: string) => {
    detailOrdinal++;
    const attrs = parseDetailAttributes(rawAttrs);
    const content = rawContent.trim();
    const fallbackId = `detail_${detailOrdinal}`;
    const id = slugifyDetailId(attrs.id || firstMarkdownHeading(content) || fallbackId, fallbackId);
    const title = (attrs.title || firstMarkdownHeading(content) || id).trim();
    const keywords = [
      ...parseCsv(attrs.keywords),
      id,
      title,
    ].filter(Boolean);
    detailSections.push({
      id,
      ref: `${scene}:${id}`,
      title,
      keywords,
      content,
      default: attrs.default === 'true' || attrs.default === '1',
    });
    return '\n';
  }).trim();

  return { coreContent, detailSections };
}

function normalizeLookupText(value: string | undefined): string {
  return (value || '').toLowerCase();
}

function phaseLikeToText(phase: {
  id?: string;
  name?: string;
  goal?: string;
  expectedTools?: string[];
  expectedCalls?: ExpectedCall[];
}): string {
  return [
    phase.id,
    phase.name,
    phase.goal,
    ...(phase.expectedTools || []),
    ...(phase.expectedCalls || []).map(call => call.skillId || call.tool),
  ].filter(Boolean).join(' ').toLowerCase();
}

function detailMatchScore(detail: StrategyDetailSection, phaseText: string): StrategyDetailMatch {
  const matchedKeywords: string[] = [];
  let score = detail.default ? 1 : 0;
  for (const keyword of detail.keywords) {
    const normalized = normalizeLookupText(keyword);
    if (!normalized) continue;
    if (phaseText.includes(normalized)) {
      matchedKeywords.push(keyword);
      score += normalized === detail.id.toLowerCase() ? 8 : 4;
    }
  }
  if (phaseText.includes(detail.title.toLowerCase())) score += 6;
  return { detail, score, matchedKeywords };
}

function parseStrategyFile(filePath: string): StrategyDefinition | null {
  const raw = fs.readFileSync(filePath, 'utf-8');
  const match = raw.match(FRONTMATTER_RE);
  if (!match) return null;

  const frontmatter = yaml.load(match[1]) as Record<string, unknown>;
  const content = match[2].trim();

  const compoundPatternStrings = (frontmatter.compound_patterns as string[] | undefined) || [];
  const compoundPatterns = compoundPatternStrings.map(p => new RegExp(p, 'i'));

  const rawHints = (frontmatter.phase_hints as Array<Record<string, unknown>> | undefined) || [];
  const phaseHints: PhaseHint[] = rawHints.map(h => ({
    id: (h.id as string) || '',
    keywords: (h.keywords as string[]) || [],
    constraints: (h.constraints as string) || '',
    criticalTools: (h.critical_tools as string[]) || [],
    critical: (h.critical as boolean) ?? false,
  }));

  const rawPlanTemplate = frontmatter.plan_template as Record<string, unknown> | undefined;
  let planTemplate: PlanTemplate | null = null;
  if (rawPlanTemplate) {
    const aspects = (rawPlanTemplate.mandatory_aspects as Array<Record<string, unknown>> | undefined) || [];
    planTemplate = {
      mandatoryAspects: aspects.map(a => {
        const triggerKeywords = Array.isArray(a.trigger_keywords)
          ? a.trigger_keywords as string[]
          : [];
        const conditionalRequiredExpectedCalls = Array.isArray(a.conditional_required_expected_calls)
          ? (a.conditional_required_expected_calls as Array<Record<string, unknown>>)
              .map(group => ({
                triggerKeywords: Array.isArray(group.trigger_keywords)
                  ? group.trigger_keywords as string[]
                  : [],
                requiredExpectedCalls: parseExpectedCalls(group.required_expected_calls),
              }))
              .filter(group => group.triggerKeywords.length > 0 && group.requiredExpectedCalls.length > 0)
          : [];
        return {
          id: (a.id as string) || '',
          matchKeywords: (a.match_keywords as string[]) || [],
          ...(triggerKeywords.length > 0 ? { triggerKeywords } : {}),
          suggestion: (a.suggestion as string) || '',
          requiredExpectedCalls: parseExpectedCalls(a.required_expected_calls),
          alternativeExpectedCalls: parseExpectedCalls(a.required_expected_call_alternatives),
          ...(conditionalRequiredExpectedCalls.length > 0
            ? { conditionalRequiredExpectedCalls }
            : {}),
          waivable: (a.waivable as boolean | undefined) ?? true,
        };
      }),
    };
  }

  const rawFinalReportContract = frontmatter.final_report_contract as Record<string, unknown> | undefined;
  let finalReportContract: FinalReportContract | null = null;
  if (rawFinalReportContract) {
    const requiredSections = (
      rawFinalReportContract.required_sections as Array<Record<string, unknown>> | undefined
    ) || [];
    finalReportContract = {
      requiredSections: requiredSections
        .map(section => {
          const patterns = (section.patterns as string[]) || [];
          const triggerPatterns = (section.trigger_patterns as string[]) || [];
          const patternGroups = Array.isArray(section.pattern_groups)
            ? (section.pattern_groups as unknown[])
              .filter(group => Array.isArray(group))
              .map(group => (group as unknown[]).filter(item => typeof item === 'string') as string[])
              .filter(group => group.length > 0)
            : [];
          const rawRecoveryText = section.recovery_text as Record<string, unknown> | undefined;
          const recoveryText = {
            zh: Array.isArray(rawRecoveryText?.zh)
              ? rawRecoveryText.zh.filter((line): line is string => typeof line === 'string')
              : [],
            en: Array.isArray(rawRecoveryText?.en)
              ? rawRecoveryText.en.filter((line): line is string => typeof line === 'string')
              : [],
          };
          return {
            id: (section.id as string) || '',
            label: (section.label as string) || (section.id as string) || '',
            description: (section.description as string | undefined) || undefined,
            triggerPatterns,
            patterns,
            patternGroups,
            recoveryText,
            required: (section.required as boolean | undefined) ?? true,
          };
        })
        .filter(section => section.id && section.label && (
          section.patterns.length > 0 || section.patternGroups.length > 0
        )),
    };
  }

  const rawVerifierMisdiagnosisPatterns =
    frontmatter.verifier_misdiagnosis_patterns as Array<Record<string, unknown>> | undefined;
  const verifierMisdiagnosisPatterns: VerifierMisdiagnosisPattern[] = (
    Array.isArray(rawVerifierMisdiagnosisPatterns) ? rawVerifierMisdiagnosisPatterns : []
  ).map(entry => ({
    id: (entry.id as string) || '',
    patterns: Array.isArray(entry.patterns)
      ? (entry.patterns as unknown[]).filter((pattern): pattern is string => typeof pattern === 'string')
      : [],
    message: (entry.message as string) || '',
    severity: entry.severity === 'info' ? 'info' : 'warning',
    type: 'known_misdiagnosis',
    scenes: Array.isArray(entry.scenes)
      ? (entry.scenes as unknown[]).filter((scene): scene is string => typeof scene === 'string')
      : [],
    global: entry.global === true,
    sourceScene: (frontmatter.scene as string) || '',
  }));

  const rawStrategyKind = frontmatter.strategy_kind as string | undefined;
  const strategyKind: StrategyKind = rawStrategyKind === 'contract_only'
    ? 'contract_only'
    : 'normal';
  const parsedContent = parseStrategyDetails(frontmatter.scene as string, content);

  return {
    scene: frontmatter.scene as string,
    strategyKind,
    priority: (frontmatter.priority as number) ?? 99,
    effort: (frontmatter.effort as string) ?? 'high',
    keywords: (frontmatter.keywords as string[]) || [],
    compoundPatterns,
    requiredCapabilities: (frontmatter.required_capabilities as string[]) || [],
    optionalCapabilities: (frontmatter.optional_capabilities as string[]) || [],
    phaseHints,
    planTemplate,
    finalReportContract,
    verifierMisdiagnosisPatterns,
    content: parsedContent.coreContent,
    detailSections: parsedContent.detailSections,
    sourcePath: filePath,
  };
}

export function loadStrategies(): Map<string, StrategyDefinition> {
  if (cache && !DEV_MODE) return cache;

  cache = new Map();
  const files = fs.readdirSync(STRATEGIES_DIR)
    .filter(f => f.endsWith('.strategy.md'));

  for (const file of files) {
    const def = parseStrategyFile(path.join(STRATEGIES_DIR, file));
    if (def) {
      cache.set(def.scene, def);
    }
  }

  return cache;
}

export function getStrategyContent(scene: string): string | undefined {
  const def = loadStrategies().get(scene);
  const content = def?.strategyKind === 'contract_only' ? undefined : def?.content;
  if (content) {
    currentRunManifestAttributionSink()?.recordScene({
      sceneType: scene,
      strategyId: scene,
      strategyContentHash: canonicalContentHash(content),
    });
  }
  return content;
}

export function getStrategyDetails(scene: string): StrategyDetailSection[] {
  const def = loadStrategies().get(scene);
  if (def?.strategyKind === 'contract_only') return [];
  return def?.detailSections || [];
}

export function getStrategyDetailByRef(
  detailRef: string,
  fallbackScene?: string,
): StrategyDetailSection | undefined {
  const trimmed = detailRef.trim();
  if (!trimmed) return undefined;
  const [sceneFromRef, idFromRef] = trimmed.includes(':')
    ? trimmed.split(':', 2)
    : [fallbackScene || '', trimmed];
  if (!sceneFromRef || !idFromRef) return undefined;
  return getStrategyDetails(sceneFromRef)
    .find(detail => detail.id === idFromRef || detail.ref === `${sceneFromRef}:${idFromRef}`);
}

export function matchStrategyDetailForPhase(
  scene: string | undefined,
  phase: {
    id?: string;
    name?: string;
    goal?: string;
    expectedTools?: string[];
    expectedCalls?: ExpectedCall[];
  } | undefined,
): StrategyDetailMatch | undefined {
  if (!scene || !phase) return undefined;
  const details = getStrategyDetails(scene);
  if (details.length === 0) return undefined;
  const phaseText = phaseLikeToText(phase);
  const scored = details
    .map(detail => detailMatchScore(detail, phaseText))
    .sort((a, b) => b.score - a.score);
  const best = scored[0];
  if (best && best.score > 0) return best;
  const fallback = details.find(detail => detail.default) || details[0];
  return { detail: fallback, score: 0, matchedKeywords: [] };
}

export function buildStrategyDetailExcerpt(
  detail: StrategyDetailSection,
  maxChars = DEFAULT_STRATEGY_DETAIL_EXCERPT_CHARS,
): { excerpt: string; truncated: boolean; maxChars: number } {
  const content = detail.content.trim();
  if (content.length <= maxChars) {
    return { excerpt: content, truncated: false, maxChars };
  }

  const clipped = content.slice(0, maxChars);
  const boundary = Math.max(
    clipped.lastIndexOf('\n### '),
    clipped.lastIndexOf('\n#### '),
    clipped.lastIndexOf('\n\n'),
  );
  const excerpt = clipped.slice(0, boundary > Math.floor(maxChars * 0.35) ? boundary : maxChars).trimEnd();
  return { excerpt, truncated: excerpt.length < content.length, maxChars };
}

export function getRegisteredScenes(): StrategyDefinition[] {
  return Array.from(loadStrategies().values())
    .filter(def => def.strategyKind !== 'contract_only');
}

/** Get phase-level restatement hints for a scene. Returns [] if scene has no hints. */
export function getPhaseHints(scene: string): PhaseHint[] {
  const def = loadStrategies().get(scene);
  if (def?.strategyKind === 'contract_only') return [];
  return def?.phaseHints || [];
}

/**
 * Get the plan template for a scene loaded from `plan_template:`
 * frontmatter. Returns `null` for unknown scenes and for scenes that
 * deliberately opted out (no `plan_template` block in their frontmatter).
 *
 * Phase 2.1 of v2.1 — strategies migrated to frontmatter take priority
 * over the legacy hardcoded `SCENE_PLAN_TEMPLATES` map; the legacy map
 * remains as a fallback in `scenePlanTemplates.ts` until every strategy
 * has migrated.
 */
export function getPlanTemplate(scene: string): PlanTemplate | null {
  const def = loadStrategies().get(scene);
  if (def?.strategyKind === 'contract_only') return null;
  return def?.planTemplate ?? null;
}

/**
 * Get the scene-owned final report completeness contract. Returns null for
 * scenes that have no declarative contract yet.
 */
export function getFinalReportContract(scene: string): FinalReportContract | null {
  return loadStrategies().get(scene)?.finalReportContract ?? null;
}

export function getAllVerifierMisdiagnosisPatterns(): VerifierMisdiagnosisPattern[] {
  return Array.from(loadStrategies().values())
    .flatMap(def => def.verifierMisdiagnosisPatterns);
}

export function getVerifierMisdiagnosisPatterns(scene: string): VerifierMisdiagnosisPattern[] {
  return getAllVerifierMisdiagnosisPatterns()
    .filter(pattern => pattern.global || pattern.scenes.includes(scene));
}

/**
 * Resolve the absolute path of the `*.strategy.md` file backing a scene.
 * Returns `undefined` for unknown scenes. Use this instead of `${scene}.strategy.md`
 * — file basenames may use hyphens (`touch-tracking.strategy.md`) where
 * the scene id uses underscores (`touch_tracking`).
 */
export function getStrategyFilePath(scene: string): string | undefined {
  return loadStrategies().get(scene)?.sourcePath;
}

const registryCache = new Map<string, unknown>();

/** Clear cached strategies, templates, and registries — useful for dev/test reloads. */
export function invalidateStrategyCache(): void {
  cache = null;
  templateCache.clear();
  registryCache.clear();
}

// ---------------------------------------------------------------------------
// Prompt & selection context templates ({{variable}} substitution)
// ---------------------------------------------------------------------------

const templateCache = new Map<string, string>();

/**
 * Load a prompt template from `backend/strategies/<name>.template.md`.
 * Templates use `{{variable}}` placeholders that callers substitute at runtime via `renderTemplate()`.
 * Static templates (no variables) can be used directly as-is.
 *
 * Results are cached in `templateCache` and cleared by `invalidateStrategyCache()`.
 */
export function loadPromptTemplate(name: string): string | undefined {
  if (templateCache.has(name) && !DEV_MODE) {
    const cached = templateCache.get(name);
    if (cached) {
      currentRunManifestAttributionSink()?.recordPromptTemplate(
        name,
        canonicalContentHash(cached),
      );
    }
    return cached;
  }

  const filePath = path.join(STRATEGIES_DIR, `${name}.template.md`);
  if (!fs.existsSync(filePath)) return undefined;

  const content = fs.readFileSync(filePath, 'utf-8').trim();
  templateCache.set(name, content);
  currentRunManifestAttributionSink()?.recordPromptTemplate(
    name,
    canonicalContentHash(content),
  );
  return content;
}

/** Load a structured YAML registry from `backend/strategies/<name>.registry.yaml`. */
export function loadStrategyRegistry<T>(name: string): T | undefined {
  if (registryCache.has(name) && !DEV_MODE) return registryCache.get(name) as T;
  const filePath = path.join(STRATEGIES_DIR, `${name}.registry.yaml`);
  if (!fs.existsSync(filePath)) return undefined;
  const parsed = yaml.load(fs.readFileSync(filePath, 'utf-8')) as T;
  registryCache.set(name, parsed);
  return parsed;
}

/**
 * Load a selection context template from `backend/strategies/selection-<kind>.template.md`.
 * Delegates to `loadPromptTemplate()` with the `selection-` prefix.
 */
export function loadSelectionTemplate(kind: string): string | undefined {
  return loadPromptTemplate(`selection-${kind}`);
}

/**
 * Substitute `{{key}}` placeholders in a template string with provided values.
 */
export function renderTemplate(template: string, vars: Record<string, string | number | undefined>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key) => {
    const val = vars[key];
    return val !== undefined ? String(val) : `{{${key}}}`;
  });
}
