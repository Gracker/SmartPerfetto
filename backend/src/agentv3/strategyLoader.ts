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
import type {AnalysisReportRequirementCondition} from '../types/analysisDelivery';
import {canonicalContentHash} from '../services/selfEvolution/canonicalJson';
import {
  currentEffectiveRuntimeRegistrySnapshot,
  type ReadonlyStrategyRegistrySnapshot,
} from '../services/selfEvolution/effectiveRuntimeRegistryContext';
import {currentRunManifestAttributionSink} from '../services/selfEvolution/runManifestLifecycle';
import type {RunManifestScope} from '../types/selfEvolution';
import {INVESTIGATION_CONDITION_OPERATORS, type AnalysisInvestigationContract,
  type AnalysisInvestigationRequirement} from '../types/analysisInvestigation';
import {ENTRY_SKILL_BINDINGS, ENTRY_SKILL_END_BINDINGS, ENTRY_SKILL_PROCESS_BINDINGS, ENTRY_SKILL_START_BINDINGS,
  type EntrySkillBinding, type StrategyEntrySkill} from '../types/sceneEntryEvidence';

/** On-demand strategy detail section parsed from Markdown comment blocks. */
export interface StrategyDetailSection {
  /** Stable id local to the scene, e.g. `overview` or `root_cause_drill`. */
  id: string;
  /** Fully-qualified ref returned to the agent, e.g. `scrolling:overview`. */
  ref: string;
  title: string;
  keywords: string[];
  content: string;
  /** Author-designated default detail for discovery; never selects a plan phase. */
  default: boolean;
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
  condition?: AnalysisReportRequirementCondition;
  /** @deprecated Historical configuration only; semantic review decides applicability. */
  triggerPatterns: string[];
  /** @deprecated Historical configuration only; never proves semantic coverage. */
  patterns: string[];
  /** @deprecated Historical AND-of-OR groups, retained for readable old snapshots. */
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
  /** Scene meaning for semantic classification; contains no execution steps. */
  classificationDescription?: string;
  /** contract_only strategies expose contracts without classifier/prompt injection. */
  strategyKind: StrategyKind;
  priority: number;
  effort: string;
  keywords: string[];
  /** Capability IDs required for this scene (missing = critical gap) */
  requiredCapabilities: string[];
  /** Capability IDs that enhance analysis but are not required */
  optionalCapabilities: string[];
  /** Scoped evidence obligations for typed investigations, independent of report presentation. */
  investigationRequirements?: string[];
  /** Expanded profile contents travel with the same immutable registry pin. */
  investigationContract?: AnalysisInvestigationContract;
  /**
   * The Skill a scene-wide investigation of this scene runs before the model's
   * first turn (product-owned scene evidence). Its parameters are closed
   * bindings, resolved per run; executability is checked by `validate:strategies`.
   */
  entrySkill?: StrategyEntrySkill;
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

/**
 * Frontmatter fields that no longer exist. `phase_hints` (with
 * `critical_tools`) and `plan_template` (with `mandatory_aspects` and its
 * expected calls) were never injected into an analysis and were removed.
 * `validate:strategies` rejects a strategy file that declares one; loading
 * ignores it with a warning, so a stray declaration cannot stop every session
 * from starting. Obligations that must bind to what a run measured belong in
 * `investigation_contract`.
 */
export const REMOVED_STRATEGY_FRONTMATTER_KEYS = ['phase_hints', 'plan_template'] as const;
const reportedRemovedFrontmatterKeys = new Set<string>();

const STRATEGIES_DIR = path.resolve(__dirname, '../../strategies');
/** Tolerates leading `<!-- -->` blocks (e.g. SPDX/license headers) before the frontmatter. */
const FRONTMATTER_RE = /^(?:\s*<!--[\s\S]*?-->\s*)*---\n([\s\S]*?)\n---\n?([\s\S]*)$/;
const STRATEGY_DETAIL_RE = /<!--\s*strategy-detail\b([^>]*)-->\s*([\s\S]*?)\s*<!--\s*\/strategy-detail\s*-->/g;
/** In dev mode, skip caching so .strategy.md / .template.md edits take effect without restart. */
const DEV_MODE = process.env.NODE_ENV !== 'production';

let baseCache: Map<string, StrategyDefinition> | null = null;

/**
 * An `append_phase_hints` operation persisted in a Self-Evolution overlay
 * before phase hints were removed. Its hints are kept verbatim so the overlay's
 * content hash still verifies; overlay reconciliation quarantines it, and no
 * registry build or new contribution accepts it.
 */
export interface LegacyAppendPhaseHintsOperation {
  op: 'append_phase_hints';
  operationId: string;
  hints: readonly unknown[];
}

export type StrategyRegistryContributionOperation =
  | {
      op: 'append_core';
      operationId: string;
      content: string;
    }
  | LegacyAppendPhaseHintsOperation
  | {
      op: 'append_detail_sections';
      operationId: string;
      sections: StrategyDetailSection[];
    };

/**
 * Non-persistent M3 runtime composition input. This is deliberately not the
 * durable strategy-overlay schema owned by later self-evolution milestones.
 */
export interface StrategyRegistryContribution {
  contributionId: string;
  scope: RunManifestScope;
  scene: string;
  baseStrategyFingerprint: string;
  createdAt: string;
  operations: StrategyRegistryContributionOperation[];
}

export function buildStrategyRegistrySnapshotFromDefinitions(input: {
  definitions: readonly StrategyDefinition[];
  overlayGeneration: string;
}): ReadonlyStrategyRegistrySnapshot {
  const orderedDefinitions = input.definitions
    .map(cloneStrategyDefinition)
    .sort((left, right) => left.scene.localeCompare(right.scene));
  const definitions = new Map(
    orderedDefinitions.map(definition => [definition.scene, definition]),
  );
  if (definitions.size !== orderedDefinitions.length) {
    throw new Error('strategy_snapshot_duplicate_scene');
  }
  const registryFingerprint = canonicalContentHash(
    orderedDefinitions.map(definition =>
      strategyFingerprintPayload(definition)),
  );
  return Object.freeze({
    registryFingerprint,
    overlayGeneration: input.overlayGeneration,
    getStrategy(scene: string): StrategyDefinition | undefined {
      return definitions.get(scene);
    },
    getAllStrategies(): StrategyDefinition[] {
      return [...orderedDefinitions];
    },
  });
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

/** Read semantic requirement declarations; legacy patterns remain inert metadata. */
export function parseFinalReportContract(value: unknown): FinalReportContract | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const strings = (items: unknown): string[] => Array.isArray(items)
    ? items.filter((item): item is string => typeof item === 'string') : [];
  const sections = Array.isArray(raw.required_sections) ? raw.required_sections : [];
  return {
    requiredSections: sections.flatMap((value): FinalReportContractRequirement[] => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
      const section = value as Record<string, unknown>;
      const id = typeof section.id === 'string' ? section.id.trim() : '';
      if (!id) return [];
      const recovery = section.recovery_text && typeof section.recovery_text === 'object'
        ? section.recovery_text as Record<string, unknown> : undefined;
      const rawCondition = section.condition && typeof section.condition === 'object'
        ? section.condition as Record<string, unknown> : undefined;
      const condition: AnalysisReportRequirementCondition | undefined =
        rawCondition?.kind === 'semantic' && typeof rawCondition.description === 'string' && rawCondition.description.trim()
          ? {kind: 'semantic', description: rawCondition.description.trim()}
          : 'condition' in section ? {kind: 'unresolved', reason: 'invalid_condition'}
            : 'trigger_patterns' in section ? {kind: 'unresolved', reason: 'legacy_trigger_patterns'} : undefined;
      return [{
        id,
        label: typeof section.label === 'string' && section.label.trim() ? section.label.trim() : id,
        ...(typeof section.description === 'string' && section.description.trim()
          ? {description: section.description.trim()} : {}),
        required: section.required !== false,
        ...(condition ? {condition} : {}),
        triggerPatterns: strings(section.trigger_patterns),
        patterns: strings(section.patterns),
        patternGroups: Array.isArray(section.pattern_groups)
          ? section.pattern_groups.map(strings).filter(group => group.length > 0) : [],
        recoveryText: {zh: strings(recovery?.zh), en: strings(recovery?.en)},
      }];
    }),
  };
}

export type InvestigationProfiles = ReadonlyMap<string, {
  version: number;
  requirements: readonly AnalysisInvestigationRequirement[];
}>;

/**
 * Attach load context to strict parse failures. The error code prefix stays
 * intact so substring matching (tests, `strategy_invalid_*` handling) keeps
 * working; only files that were parseable before but lost context gain it.
 */
function withStrategyParseContext<T>(run: () => T, context: string): T {
  try {
    return run();
  } catch (error) {
    // Bare code, or a code already tagged with `#requirementId` but no file yet.
    if (error instanceof Error && /^strategy_[a-z0-9_]+(#[^\s:]+)?$/.test(error.message)) {
      throw new Error(`${error.message}:${context}`);
    }
    throw error;
  }
}

/** Tag a requirement-level failure with the requirement id when it is readable. */
function withRequirementTag<T>(run: () => T, raw: unknown): T {
  const record = isRecord(raw) ? raw : undefined;
  const id = typeof record?.id === 'string' && /^[a-z][a-z0-9_]*$/.test(record.id.trim())
    ? record.id.trim() : undefined;
  try {
    return run();
  } catch (error) {
    if (error instanceof Error && id && /^strategy_[a-z0-9_]+$/.test(error.message)) {
      throw new Error(`${error.message}#${id}`);
    }
    throw error;
  }
}

function parseInvestigationRequirement(value: unknown): AnalysisInvestigationRequirement {
  if (!isRecord(value) || !hasOnlyKeys(value, ['id', 'domain', 'description', 'required', 'condition', 'evidence_metrics'])
    || !nonEmptyString(value.id) || !/^[a-z][a-z0-9_]*$/.test(value.id)
    || !nonEmptyString(value.domain) || !nonEmptyString(value.description)
    || (value.required !== undefined && typeof value.required !== 'boolean')) {
    throw new Error('strategy_invalid_investigation_requirement');
  }
  let condition: AnalysisInvestigationRequirement['condition'];
  if (value.condition !== undefined) {
    if (!isRecord(value.condition) || !nonEmptyString(value.condition.description)) {
      throw new Error('strategy_invalid_investigation_condition');
    }
    if (value.condition.kind === 'semantic') {
      if (!hasOnlyKeys(value.condition, ['kind', 'description'])) {
        throw new Error('strategy_invalid_investigation_condition');
      }
      condition = {kind: 'semantic', description: value.condition.description.trim()};
    } else if (value.condition.kind === 'evidence') {
      // An evidence condition is resolved from the ledger, so its metric and
      // threshold have to be exact; a loose value would silently activate or
      // suppress the obligation on every run of the scene.
      if (!hasOnlyKeys(value.condition, ['kind', 'description', 'metric_id', 'operator', 'value'])
        || !nonEmptyString(value.condition.metric_id)
        || !(INVESTIGATION_CONDITION_OPERATORS as readonly string[]).includes(String(value.condition.operator))
        || typeof value.condition.value !== 'number' || !Number.isFinite(value.condition.value)) {
        throw new Error('strategy_invalid_investigation_condition');
      }
      condition = {kind: 'evidence', description: value.condition.description.trim(),
        metricId: value.condition.metric_id.trim(),
        operator: value.condition.operator as 'gt' | 'gte' | 'lt' | 'lte',
        value: value.condition.value};
    } else {
      throw new Error('strategy_invalid_investigation_condition');
    }
  }
  let evidenceMetrics: string[] | undefined;
  if (value.evidence_metrics !== undefined) {
    if (!Array.isArray(value.evidence_metrics) || !value.evidence_metrics.length
      || !value.evidence_metrics.every(nonEmptyString)) throw new Error('strategy_invalid_investigation_metrics');
    evidenceMetrics = value.evidence_metrics.map(metric => metric.trim());
    if (new Set(evidenceMetrics).size !== evidenceMetrics.length) throw new Error('strategy_duplicate_investigation_metric');
  }
  return {id: value.id, domain: value.domain.trim(), description: value.description.trim(),
    required: value.required !== false, ...(condition ? {condition} : {}),
    ...(evidenceMetrics ? {evidenceMetrics} : {})};
}

/** Strict configuration parser shared by runtime loading and strategy validation. */
export function parseInvestigationProfiles(value: unknown): InvestigationProfiles {
  if (!isRecord(value) || !hasOnlyKeys(value, ['schema_version', 'profiles'])
    || value.schema_version !== 1 || !isRecord(value.profiles)) {
    throw new Error('strategy_invalid_investigation_profiles');
  }
  const profiles = new Map<string, {version: number; requirements: AnalysisInvestigationRequirement[]}>();
  for (const [id, entry] of Object.entries(value.profiles)) {
    if (!/^[a-z][a-z0-9_]*$/.test(id) || !isRecord(entry) || !hasOnlyKeys(entry, ['version', 'requirements'])
      || !Number.isSafeInteger(entry.version) || (entry.version as number) <= 0
      || !Array.isArray(entry.requirements) || !entry.requirements.length) {
      throw new Error('strategy_invalid_investigation_profile');
    }
    const requirements = entry.requirements.map(requirement =>
      withRequirementTag(() => parseInvestigationRequirement(requirement), requirement));
    if (new Set(requirements.map(requirement => requirement.id)).size !== requirements.length) {
      throw new Error('strategy_duplicate_investigation_requirement');
    }
    profiles.set(id, {version: entry.version as number, requirements});
  }
  return profiles;
}

export function parseInvestigationContract(value: unknown, profiles: InvestigationProfiles): AnalysisInvestigationContract | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value) || !hasOnlyKeys(value, ['schema_version', 'profiles', 'requirements', 'not_applicable_reason'])
    || value.schema_version !== 1) throw new Error('strategy_invalid_investigation_contract');
  if (value.not_applicable_reason !== undefined) {
    if (!nonEmptyString(value.not_applicable_reason) || value.profiles !== undefined || value.requirements !== undefined) {
      throw new Error('strategy_invalid_investigation_exemption');
    }
    return {schemaVersion: 1, profileRefs: [], requirements: [], notApplicableReason: value.not_applicable_reason.trim()};
  }
  if ((value.profiles !== undefined && !Array.isArray(value.profiles))
    || (value.requirements !== undefined && !Array.isArray(value.requirements))) {
    throw new Error('strategy_invalid_investigation_contract');
  }
  const profileRefs: AnalysisInvestigationContract['profileRefs'] = [];
  const requirements = new Map<string, AnalysisInvestigationRequirement>();
  const append = (requirement: AnalysisInvestigationRequirement) => {
    const previous = requirements.get(requirement.id);
    if (previous) {
      // Shared IDs may be reused unchanged; conflicting obligations cannot silently win.
      const {profileId: _a, profileVersion: _b, ...left} = previous;
      const {profileId: _c, profileVersion: _d, ...right} = requirement;
      if (canonicalContentHash(left) !== canonicalContentHash(right)) throw new Error('strategy_conflicting_investigation_requirement');
    } else requirements.set(requirement.id, requirement);
  };
  for (const ref of (value.profiles ?? []) as unknown[]) {
    if (!isRecord(ref) || !hasOnlyKeys(ref, ['id', 'version']) || !nonEmptyString(ref.id)
      || !Number.isSafeInteger(ref.version)) throw new Error('strategy_invalid_investigation_profile_ref');
    const profile = profiles.get(ref.id);
    if (!profile || profile.version !== ref.version) throw new Error('strategy_investigation_profile_unavailable');
    if (profileRefs.some(existing => existing.id === ref.id)) throw new Error('strategy_duplicate_investigation_profile_ref');
    profileRefs.push({id: ref.id, version: profile.version});
    profile.requirements.forEach(requirement => append({...requirement, profileId: ref.id as string, profileVersion: profile.version}));
  }
  const localRequirements = ((value.requirements ?? []) as unknown[]).map(requirement =>
    withRequirementTag(() => parseInvestigationRequirement(requirement), requirement));
  if (new Set(localRequirements.map(requirement => requirement.id)).size !== localRequirements.length) {
    throw new Error('strategy_duplicate_investigation_requirement');
  }
  localRequirements.forEach(append);
  if (!requirements.size) throw new Error('strategy_empty_investigation_contract');
  return {schemaVersion: 1, profileRefs, requirements: [...requirements.values()]};
}

const ENTRY_SKILL_NAME_RE = /^[a-z][a-z0-9_]*$/;

/**
 * Strict parser for frontmatter `entry_skill`, shared by runtime loading and
 * strategy validation. Each parameter takes one closed binding, and a Skill
 * gets at most one process, one start and one end binding. Whether the Skill
 * exists and may run unattended is a registry question (`entrySkillPolicy.ts`).
 */
export function parseEntrySkill(value: unknown): StrategyEntrySkill | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value) || !hasOnlyKeys(value, ['id', 'params']) || !nonEmptyString(value.id)
    || !ENTRY_SKILL_NAME_RE.test(value.id.trim())) {
    throw new Error('strategy_invalid_entry_skill');
  }
  const rawParams = value.params ?? {};
  if (!isRecord(rawParams)) throw new Error('strategy_invalid_entry_skill');
  const params: Record<string, EntrySkillBinding> = {};
  for (const [name, binding] of Object.entries(rawParams)) {
    if (!ENTRY_SKILL_NAME_RE.test(name) || typeof binding !== 'string'
      || !(ENTRY_SKILL_BINDINGS as readonly string[]).includes(binding)) {
      throw new Error('strategy_invalid_entry_skill');
    }
    params[name] = binding as EntrySkillBinding;
  }
  const bound = Object.values(params);
  for (const kind of [ENTRY_SKILL_PROCESS_BINDINGS, ENTRY_SKILL_START_BINDINGS, ENTRY_SKILL_END_BINDINGS]) {
    if (bound.filter(binding => kind.includes(binding)).length > 1) throw new Error('strategy_invalid_entry_skill');
  }
  return {id: value.id.trim(), params};
}

/** The author-designated default detail section, if any (the first one marked `default`). */
export function defaultStrategyDetail(
  strategy: Pick<StrategyDefinition, 'detailSections'> | undefined,
): StrategyDetailSection | undefined {
  return strategy?.detailSections.find(detail => detail.default);
}

function parseStrategyFile(filePath: string, investigationProfiles: InvestigationProfiles): StrategyDefinition | null {
  const raw = fs.readFileSync(filePath, 'utf-8');
  const match = raw.match(FRONTMATTER_RE);
  if (!match) return null;

  const frontmatter = yaml.load(match[1]) as Record<string, unknown>;
  const content = match[2].trim();
  for (const key of REMOVED_STRATEGY_FRONTMATTER_KEYS) {
    const report = `${path.basename(filePath)}:${key}`;
    if (frontmatter[key] === undefined || reportedRemovedFrontmatterKeys.has(report)) continue;
    reportedRemovedFrontmatterKeys.add(report);
    console.warn(`[StrategyLoader] strategy_frontmatter_removed_field:${report} is ignored`);
  }

  const rawInvestigationRequirements = frontmatter.investigation_requirements;
  let investigationRequirements: string[] | undefined;
  if (rawInvestigationRequirements !== undefined) {
    if (!Array.isArray(rawInvestigationRequirements) || rawInvestigationRequirements.length === 0
      || !rawInvestigationRequirements.every(nonEmptyString)) {
      throw new Error(`strategy_invalid_investigation_requirements:${filePath}`);
    }
    investigationRequirements = rawInvestigationRequirements.map(requirement => requirement.trim());
  }
  const investigationContract = withStrategyParseContext(
    () => parseInvestigationContract(frontmatter.investigation_contract, investigationProfiles),
    filePath);

  const finalReportContract = parseFinalReportContract(frontmatter.final_report_contract);
  const entrySkill = withStrategyParseContext(() => parseEntrySkill(frontmatter.entry_skill), filePath);

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
    ...(typeof frontmatter.classification_description === 'string' && frontmatter.classification_description.trim()
      ? {classificationDescription: frontmatter.classification_description.trim()} : {}),
    strategyKind,
    priority: (frontmatter.priority as number) ?? 99,
    effort: (frontmatter.effort as string) ?? 'high',
    keywords: (frontmatter.keywords as string[]) || [],
    requiredCapabilities: (frontmatter.required_capabilities as string[]) || [],
    optionalCapabilities: (frontmatter.optional_capabilities as string[]) || [],
    ...(investigationRequirements ? {investigationRequirements} : {}),
    ...(investigationContract ? {investigationContract} : {}),
    ...(entrySkill ? {entrySkill} : {}),
    finalReportContract,
    verifierMisdiagnosisPatterns,
    content: parsedContent.coreContent,
    detailSections: parsedContent.detailSections,
    sourcePath: filePath,
  };
}

function deepFreezeStrategy<T>(value: T, seen = new Set<object>()): T {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  if (seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value as Record<string, unknown>)) {
    deepFreezeStrategy(child, seen);
  }
  return Object.freeze(value);
}

function cloneStrategyDefinition(definition: StrategyDefinition): StrategyDefinition {
  return deepFreezeStrategy({
    ...definition,
    keywords: [...definition.keywords],
    requiredCapabilities: [...definition.requiredCapabilities],
    optionalCapabilities: [...definition.optionalCapabilities],
    ...(definition.investigationRequirements
      ? {investigationRequirements: [...definition.investigationRequirements]} : {}),
    ...(definition.investigationContract ? {investigationContract: {
      ...definition.investigationContract,
      profileRefs: definition.investigationContract.profileRefs.map(ref => ({...ref})),
      requirements: definition.investigationContract.requirements.map(requirement => ({
        ...requirement,
        ...(requirement.condition ? {condition: {...requirement.condition}} : {}),
        ...(requirement.evidenceMetrics ? {evidenceMetrics: [...requirement.evidenceMetrics]} : {}),
      })),
    }} : {}),
    ...(definition.entrySkill
      ? {entrySkill: {id: definition.entrySkill.id, params: {...definition.entrySkill.params}}} : {}),
    finalReportContract: definition.finalReportContract
      ? {
          requiredSections:
            definition.finalReportContract.requiredSections.map(section => ({
              ...section,
              ...(section.condition ? {condition: {...section.condition}} : {}),
              triggerPatterns: [...section.triggerPatterns],
              patterns: [...section.patterns],
              patternGroups: section.patternGroups.map(group => [...group]),
              recoveryText: {
                zh: [...section.recoveryText.zh],
                en: [...section.recoveryText.en],
              },
            })),
        }
      : null,
    verifierMisdiagnosisPatterns:
      definition.verifierMisdiagnosisPatterns.map(pattern => ({
        ...pattern,
        patterns: [...pattern.patterns],
        scenes: [...pattern.scenes],
      })),
    detailSections: definition.detailSections.map(detail => ({
      ...detail,
      keywords: [...detail.keywords],
    })),
  });
}

function strategyFingerprintPayload(definition: StrategyDefinition): unknown {
  const {sourcePath: _sourcePath, ...semanticDefinition} = definition;
  return semanticDefinition;
}

export function fingerprintStrategyDefinition(
  definition: StrategyDefinition,
): string {
  return canonicalContentHash(strategyFingerprintPayload(definition));
}

function baseStrategies(): Map<string, StrategyDefinition> {
  if (baseCache && !DEV_MODE) return baseCache;

  const loaded = new Map<string, StrategyDefinition>();
  const investigationProfiles = withStrategyParseContext(() => parseInvestigationProfiles(yaml.load(
    fs.readFileSync(path.join(STRATEGIES_DIR, 'investigation-profiles.yaml'), 'utf8'),
  )), path.join(STRATEGIES_DIR, 'investigation-profiles.yaml'));
  const files = fs.readdirSync(STRATEGIES_DIR)
    .filter(file => file.endsWith('.strategy.md'))
    .sort();

  for (const file of files) {
    const definition = parseStrategyFile(path.join(STRATEGIES_DIR, file), investigationProfiles);
    if (definition) {
      loaded.set(definition.scene, cloneStrategyDefinition(definition));
    }
  }
  baseCache = loaded;
  return loaded;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function hasOnlyKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  const allowed = new Set(keys);
  return Object.keys(value).every(key => allowed.has(key));
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function validScope(value: unknown): value is RunManifestScope {
  return isRecord(value)
    && hasOnlyKeys(value, ['tenantId', 'workspaceId'])
    && nonEmptyString(value.tenantId)
    && nonEmptyString(value.workspaceId);
}

function assertStringArray(value: unknown, code: string): asserts value is string[] {
  if (!Array.isArray(value) || value.some(entry => typeof entry !== 'string')) {
    throw new Error(code);
  }
}

function parseDetailContribution(
  value: unknown,
  contributionId: string,
  scene: string,
): StrategyDetailSection {
  if (
    !isRecord(value)
    || !hasOnlyKeys(value, [
      'id',
      'ref',
      'title',
      'keywords',
      'content',
      'default',
    ])
    || !nonEmptyString(value.id)
    || value.ref !== `${scene}:${value.id}`
    || !nonEmptyString(value.title)
    || !nonEmptyString(value.content)
    || typeof value.default !== 'boolean'
  ) {
    throw new Error(`strategy_contribution_invalid_detail:${contributionId}`);
  }
  assertStringArray(
    value.keywords,
    `strategy_contribution_invalid_detail_keywords:${contributionId}`,
  );
  return {
    id: value.id,
    ref: value.ref,
    title: value.title,
    keywords: [...value.keywords],
    content: value.content,
    default: value.default,
  };
}

/**
 * Parse a strategy contribution. `append_phase_hints` targets a field no
 * analysis reads and is refused, except when `legacyPhaseHints: 'read'` reads
 * back an overlay persisted before phase hints were removed.
 */
export function parseStrategyContribution(
  value: unknown,
  options: {legacyPhaseHints?: 'read'} = {},
): StrategyRegistryContribution {
  if (
    !isRecord(value)
    || !hasOnlyKeys(value, [
      'contributionId',
      'scope',
      'scene',
      'baseStrategyFingerprint',
      'createdAt',
      'operations',
    ])
    || !nonEmptyString(value.contributionId)
    || !validScope(value.scope)
    || !nonEmptyString(value.scene)
    || !nonEmptyString(value.baseStrategyFingerprint)
    || typeof value.createdAt !== 'string'
    || !Number.isFinite(Date.parse(value.createdAt))
    || !Array.isArray(value.operations)
    || value.operations.length === 0
  ) {
    throw new Error('strategy_contribution_invalid');
  }
  const contributionId = value.contributionId;
  const scene = value.scene;
  const operationIds = new Set<string>();
  const operations: StrategyRegistryContributionOperation[] =
    value.operations.map((operation): StrategyRegistryContributionOperation => {
      if (
        !isRecord(operation)
        || !nonEmptyString(operation.operationId)
        || typeof operation.op !== 'string'
        || operationIds.has(operation.operationId)
      ) {
        throw new Error(
          `strategy_contribution_invalid_operation:${value.contributionId}`,
        );
      }
      operationIds.add(operation.operationId);
      if (operation.op === 'append_core') {
        if (
          !hasOnlyKeys(operation, ['op', 'operationId', 'content'])
          || !nonEmptyString(operation.content)
        ) {
          throw new Error(
            `strategy_contribution_invalid_append_core:${contributionId}`,
          );
        }
        return {
          op: 'append_core',
          operationId: operation.operationId,
          content: operation.content,
        };
      }
      if (operation.op === 'append_phase_hints') {
        if (options.legacyPhaseHints !== 'read') {
          throw new Error(
            `strategy_contribution_inert_operation:${contributionId}:append_phase_hints`,
          );
        }
        if (
          !hasOnlyKeys(operation, ['op', 'operationId', 'hints'])
          || !Array.isArray(operation.hints)
          || operation.hints.length === 0
          || !operation.hints.every(isRecord)
        ) {
          throw new Error(
            `strategy_contribution_invalid_append_phase_hints:${contributionId}`,
          );
        }
        return {
          op: 'append_phase_hints',
          operationId: operation.operationId,
          hints: JSON.parse(JSON.stringify(operation.hints)) as unknown[],
        };
      }
      if (operation.op === 'append_detail_sections') {
        if (
          !hasOnlyKeys(operation, ['op', 'operationId', 'sections'])
          || !Array.isArray(operation.sections)
          || operation.sections.length === 0
        ) {
          throw new Error(
            `strategy_contribution_invalid_append_details:${contributionId}`,
          );
        }
        return {
          op: 'append_detail_sections',
          operationId: operation.operationId,
          sections: operation.sections.map(section =>
            parseDetailContribution(section, contributionId, scene)),
        };
      }
      throw new Error(
        `strategy_contribution_unknown_operation:${contributionId}:${operation.op}`,
      );
    });
  return {
    contributionId,
    scope: value.scope,
    scene,
    baseStrategyFingerprint: value.baseStrategyFingerprint,
    createdAt: value.createdAt,
    operations,
  };
}

function sameScope(left: RunManifestScope, right: RunManifestScope): boolean {
  return left.tenantId === right.tenantId
    && left.workspaceId === right.workspaceId;
}

export function buildStrategyRegistrySnapshot(input: {
  scope: RunManifestScope;
  overlayGeneration: string;
  contributions?: readonly unknown[];
}): ReadonlyStrategyRegistrySnapshot {
  const definitions = new Map(
    [...baseStrategies()].map(([scene, definition]) => [
      scene,
      cloneStrategyDefinition(definition),
    ]),
  );
  const parsedContributions = (input.contributions ?? [])
    .map(contribution => parseStrategyContribution(contribution));
  const byScene = new Map<string, StrategyRegistryContributionOperation[]>();

  for (const contribution of parsedContributions.sort((left, right) => {
    const byTime = Date.parse(left.createdAt) - Date.parse(right.createdAt);
    return byTime !== 0
      ? byTime
      : left.contributionId.localeCompare(right.contributionId);
  })) {
    if (!sameScope(contribution.scope, input.scope)) {
      throw new Error(
        `strategy_contribution_scope_mismatch:${contribution.contributionId}`,
      );
    }
    const base = baseStrategies().get(contribution.scene);
    if (!base) {
      throw new Error(
        `strategy_contribution_base_missing:${contribution.contributionId}:${contribution.scene}`,
      );
    }
    if (
      fingerprintStrategyDefinition(base)
      !== contribution.baseStrategyFingerprint
    ) {
      throw new Error(
        `strategy_contribution_base_fingerprint_mismatch:${contribution.contributionId}`,
      );
    }
    const sortedOperations = [...contribution.operations]
      .sort((left, right) => left.operationId.localeCompare(right.operationId));
    const existing = byScene.get(contribution.scene) ?? [];
    existing.push(...sortedOperations);
    byScene.set(contribution.scene, existing);
  }

  for (const [scene, operations] of byScene) {
    const current = definitions.get(scene)!;
    let content = current.content;
    const detailSections = current.detailSections.map(detail => ({
      ...detail,
      keywords: [...detail.keywords],
    }));
    const operationIds = new Set<string>();
    const detailIds = new Set(detailSections.map(detail => detail.id));

    for (const operation of operations) {
      if (operationIds.has(operation.operationId)) {
        throw new Error(`strategy_overlay_conflict:operation:${operation.operationId}`);
      }
      operationIds.add(operation.operationId);
      if (operation.op === 'append_core') {
        content = `${content}\n\n${operation.content}`.trim();
      } else if (operation.op === 'append_detail_sections') {
        for (const detail of operation.sections) {
          if (detailIds.has(detail.id)) {
            throw new Error(`strategy_overlay_conflict:detail:${scene}:${detail.id}`);
          }
          detailIds.add(detail.id);
          detailSections.push(detail);
        }
      } else {
        // The strict parse above already refused it; never apply one.
        throw new Error(`strategy_contribution_inert_operation:${operation.operationId}`);
      }
    }

    definitions.set(scene, cloneStrategyDefinition({
      ...current,
      content,
      detailSections,
    }));
  }

  return buildStrategyRegistrySnapshotFromDefinitions({
    definitions: [...definitions.values()],
    overlayGeneration: input.overlayGeneration,
  });
}

export function loadStrategies(): Map<string, StrategyDefinition> {
  const currentSnapshot = currentEffectiveRuntimeRegistrySnapshot();
  if (currentSnapshot) {
    return new Map(
      currentSnapshot.strategyRegistry
        .getAllStrategies()
        .map(definition => [definition.scene, definition]),
    );
  }
  return new Map(baseStrategies());
}

export function getStrategyContent(scene: string, registry?: ReadonlyStrategyRegistrySnapshot): string | undefined {
  const def = registry ? registry.getStrategy(scene) : loadStrategies().get(scene);
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

export function getStrategyDetails(scene: string, registry?: ReadonlyStrategyRegistrySnapshot): StrategyDetailSection[] {
  const def = registry ? registry.getStrategy(scene) : loadStrategies().get(scene);
  if (def?.strategyKind === 'contract_only') return [];
  return def?.detailSections || [];
}

export function getStrategyDetailByRef(
  detailRef: string,
  fallbackScene?: string,
  registry?: ReadonlyStrategyRegistrySnapshot,
): StrategyDetailSection | undefined {
  const trimmed = detailRef.trim();
  if (!trimmed) return undefined;
  const [sceneFromRef, idFromRef] = trimmed.includes(':')
    ? trimmed.split(':', 2)
    : [fallbackScene || '', trimmed];
  if (!sceneFromRef || !idFromRef) return undefined;
  return getStrategyDetails(sceneFromRef, registry)
    .find(detail => detail.id === idFromRef || detail.ref === `${sceneFromRef}:${idFromRef}`);
}

export function getRegisteredScenes(): StrategyDefinition[] {
  return Array.from(loadStrategies().values())
    .filter(def => def.strategyKind !== 'contract_only');
}

/**
 * Get the scene-owned final report completeness contract. Returns null for
 * scenes that have no declarative contract yet.
 */
export function getFinalReportContract(scene: string, registry?: ReadonlyStrategyRegistrySnapshot): FinalReportContract | null {
  return (registry ? registry.getStrategy(scene) : loadStrategies().get(scene))?.finalReportContract ?? null;
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
  baseCache = null;
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

/** Authoring comments (SPDX, notes) never reach the model. */
export function stripPromptComments(text: string): string {
  return text.replace(/<!--[\s\S]*?-->/g, '').trim();
}

/** A template as a model-facing segment; a missing or blank template is undefined. */
export function loadPromptSegment(name: string): string | undefined {
  const template = loadPromptTemplate(name);
  return template === undefined ? undefined : stripPromptComments(template) || undefined;
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

/** Load and validate a structured YAML asset from `backend/strategies/<name>.yaml`. */
export function loadStrategyYaml<T>(
  name: string,
  parse: (value: unknown) => T,
): T | undefined {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) {
    throw new Error(`strategy_yaml_invalid_name:${name}`);
  }
  const cacheKey = `yaml:${name}`;
  if (registryCache.has(cacheKey) && !DEV_MODE) {
    return registryCache.get(cacheKey) as T;
  }
  const filePath = path.join(STRATEGIES_DIR, `${name}.yaml`);
  if (!fs.existsSync(filePath)) return undefined;
  const parsed = parse(yaml.load(fs.readFileSync(filePath, 'utf-8')));
  registryCache.set(cacheKey, parsed);
  return parsed;
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
