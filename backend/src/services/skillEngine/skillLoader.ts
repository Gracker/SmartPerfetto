// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

/**
 * Skill Loader
 *
 * 加载 skill 文件，包括普通 skills 和 module expert skills
 *
 * Module Expert Skills:
 * - 位于 skills/modules/ 目录下
 * - 包含 module 和 dialogue 字段
 * - 可以被跨领域专家调用
 */

import fs from 'fs';
import path from 'path';
import yaml from 'js-yaml';
import { SkillDefinition, ModuleLayer, DialogueCapability } from './types';
import { generateRenderingPipelineDetectionSkill } from '../renderingPipelineDetectionSkillGenerator';
import logger from '../../utils/logger';
import { validateSkillConditions, validateFragmentReferences } from './skillValidator';
import { validateSkillBatchAnalysis } from './skillBatchAnalysis';
import {
  DisplayContractIssue,
  formatDisplayContractIssue,
  validateSkillDisplayContract,
} from './displayContractValidator';
import type { SkillOriginMetadata, SkillPackTrustState } from '../skillPacks/skillPackTypes';

// =============================================================================
// Skill Normalization (Backward Compatibility)
// =============================================================================

function firstNonEmptyLine(text: string): string {
  const lines = String(text || '').split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  return lines[0] || '';
}

/**
 * Normalize skill YAML variants into a stable runtime shape.
 *
 * Why:
 * - Some legacy skills use `description` + `tags` at top-level instead of `meta`.
 * - Some atomic skills define SQL via `steps` (single atomic step) instead of `sql`.
 * - Some legacy steps omit `type` but include `sql` (should be treated as atomic).
 *
 * The executor assumes `meta.display_name` / `meta.description` exist.
 */
export function normalizeSkillDefinition(raw: any, filePath: string): SkillDefinition | null {
  if (!raw || typeof raw !== 'object') return null;

  const skill: any = raw;

  // Normalize triggers variants (legacy YAML may use array form with pattern/confidence objects)
  if (skill.triggers) {
    const t = skill.triggers;

    // Legacy: triggers: [{ pattern: '...', confidence: 0.9 }, ...] OR triggers: ['foo', '(bar|baz)']
    if (Array.isArray(t)) {
      const keywords: string[] = [];
      const patterns: string[] = [];
      const looksLikeRegex = (s: string): boolean => /[\\^$.*+?()[\]{}|]/.test(s);

      for (const item of t) {
        if (typeof item === 'string') {
          const s = item.trim();
          if (!s) continue;
          if (looksLikeRegex(s)) patterns.push(s);
          else keywords.push(s);
          continue;
        }
        if (item && typeof item === 'object') {
          if (typeof (item as any).pattern === 'string' && String((item as any).pattern).trim()) {
            patterns.push(String((item as any).pattern).trim());
          }
          if (typeof (item as any).keyword === 'string' && String((item as any).keyword).trim()) {
            keywords.push(String((item as any).keyword).trim());
          }
        }
      }

      const normalized: any = {};
      if (keywords.length > 0) normalized.keywords = keywords;
      if (patterns.length > 0) normalized.patterns = patterns;
      if (Object.keys(normalized).length > 0) {
        skill.triggers = normalized;
      }
    } else if (t && typeof t === 'object') {
      // Legacy: triggers: { pattern: '...' }
      if (typeof (t as any).pattern === 'string' && !(t as any).patterns) {
        const p = String((t as any).pattern).trim();
        delete (t as any).pattern;
        if (p) (t as any).patterns = [p];
      }
      // Ensure patterns/keywords are arrays when provided as a single string
      if (typeof (t as any).patterns === 'string') {
        (t as any).patterns = [String((t as any).patterns)];
      }
      if (typeof (t as any).keywords === 'string') {
        (t as any).keywords = [String((t as any).keywords)];
      }
    }
  }

  // Normalize legacy root-level display to output.display (executor reads output.display)
  if (skill.display && typeof skill.display === 'object') {
    if (!skill.output || typeof skill.output !== 'object') {
      skill.output = {};
    }
    if (!skill.output.display) {
      skill.output.display = skill.display;
    }
  }

  // Fill meta if missing (best-effort)
  if (!skill.meta || typeof skill.meta !== 'object') {
    const fallbackDisplayName =
      (typeof skill.display_name === 'string' && skill.display_name.trim()) ||
      (typeof skill.displayName === 'string' && skill.displayName.trim()) ||
      (typeof skill.name === 'string' && skill.name.trim()) ||
      path.basename(filePath).replace(/\.skill\.ya?ml$/i, '');

    const fallbackDescription =
      (typeof skill.description === 'string' && firstNonEmptyLine(skill.description)) ||
      `Skill: ${fallbackDisplayName}`;

    const tags = Array.isArray(skill.tags) ? skill.tags.map(String) : undefined;
    const icon = typeof skill.icon === 'string' && skill.icon.trim() ? String(skill.icon) : undefined;

    skill.meta = {
      display_name: fallbackDisplayName,
      description: fallbackDescription,
      ...(icon ? { icon } : {}),
      ...(tags && tags.length > 0 ? { tags } : {}),
    };
  } else {
    // Ensure required meta fields exist
    if (!skill.meta.display_name && typeof skill.name === 'string') {
      skill.meta.display_name = skill.name;
    }
    if (!skill.meta.description) {
      const fromTop = typeof skill.description === 'string' ? firstNonEmptyLine(skill.description) : '';
      skill.meta.description = fromTop || `Skill: ${skill.meta.display_name || skill.name || 'unknown'}`;
    }
    // Backfill tags/icon from legacy fields
    if (!Array.isArray(skill.meta.tags) && Array.isArray(skill.tags)) {
      skill.meta.tags = skill.tags.map(String);
    }
    if (!skill.meta.icon && typeof skill.icon === 'string') {
      skill.meta.icon = String(skill.icon);
    }
  }

  // Normalize step variants (type inference, iterator item_skill alias)
  if (Array.isArray(skill.steps)) {
    const toNumber = (v: any): number | null => {
      if (typeof v === 'number' && Number.isFinite(v)) return v;
      if (typeof v === 'string') {
        const s = v.trim();
        if (!s) return null;
        const n = Number(s);
        return Number.isFinite(n) ? n : null;
      }
      return null;
    };

    const normalizeConditionToJsExpr = (expr: string): string => {
      let e = String(expr || '').trim();
      if (!e) return '';
      e = e.replace(/\bAND\b/gi, '&&').replace(/\bOR\b/gi, '||');
      // Convert SQL-style '=' into JS '==' (but preserve >=, <=, !=, ==).
      e = e.replace(/([^<>=!])=([^=])/g, '$1==$2');
      return e;
    };

    const convertInterpretationToSynthesize = (step: any): any | null => {
      const interp = step?.interpretation;
      if (!interp || typeof interp !== 'object') return null;

      const keyMetrics = Array.isArray((interp as any).key_metrics)
        ? (interp as any).key_metrics
        : Array.isArray((interp as any).keyMetrics)
          ? (interp as any).keyMetrics
          : [];

      const analysisHints = Array.isArray((interp as any).analysis_hints)
        ? (interp as any).analysis_hints
        : Array.isArray((interp as any).analysisHints)
          ? (interp as any).analysisHints
          : [];

      const fields: any[] = [];
      const insights: any[] = [];

      for (const km of keyMetrics) {
        if (!km || typeof km !== 'object') continue;
        const key = typeof (km as any).name === 'string' ? String((km as any).name).trim() : '';
        if (!key) continue;
        const label = typeof (km as any).description === 'string' && String((km as any).description).trim()
          ? String((km as any).description).trim()
          : key;
        fields.push({ key, label });

        const th = (km as any).thresholds;
        if (th && typeof th === 'object') {
          const warning = toNumber((th as any).warning);
          const critical = toNumber((th as any).critical);
          if (typeof critical === 'number') {
            insights.push({
              condition: `${key} >= ${critical}`,
              template: `${label} 偏高：{{${key}}} (≥${critical})`,
            });
          }
          if (typeof warning === 'number') {
            const cond = typeof critical === 'number'
              ? `${key} >= ${warning} && ${key} < ${critical}`
              : `${key} >= ${warning}`;
            insights.push({
              condition: cond,
              template: `${label} 略高：{{${key}}} (≥${warning})`,
            });
          }
        }
      }

      for (const hint of analysisHints) {
        if (!hint || typeof hint !== 'object') continue;
        const condRaw = typeof (hint as any).condition === 'string' ? String((hint as any).condition) : '';
        const template = typeof (hint as any).insight === 'string' ? String((hint as any).insight).trim() : '';
        if (!template) continue;
        const condition = condRaw ? normalizeConditionToJsExpr(condRaw) : undefined;
        insights.push({
          ...(condition ? { condition } : {}),
          template,
        });
      }

      if (fields.length === 0 && insights.length === 0) return null;

      const layer = step?.display && typeof step.display === 'object' ? (step.display as any).layer : undefined;
      const role = layer === 'list' ? 'list' : 'overview';

      return {
        role,
        ...(fields.length > 0 ? { fields } : {}),
        ...(insights.length > 0 ? { insights } : {}),
      };
    };

    const normalizeStep = (step: any): void => {
      if (!step || typeof step !== 'object') return;

      // Legacy: step without type but with sql => atomic
      if (!(step as any).type && typeof (step as any).sql === 'string') {
        (step as any).type = 'atomic';
      }

      // Backward compatibility: iterator may use `skill:` instead of `item_skill:`
      if ((step as any).type === 'iterator' && typeof (step as any).skill === 'string' && typeof (step as any).item_skill !== 'string') {
        (step as any).item_skill = (step as any).skill;
      }

      // Legacy: many skills carry an "interpretation" block which used to be ignored.
      // Convert it into synthesize config so SkillExecutor can generate deterministic summaries.
      if (!(step as any).synthesize && (step as any).interpretation) {
        const synth = convertInterpretationToSynthesize(step);
        if (synth) {
          (step as any).synthesize = synth;
        }
      }

      // Recurse into parallel steps
      if ((step as any).type === 'parallel' && Array.isArray((step as any).steps)) {
        for (const nested of (step as any).steps) {
          normalizeStep(nested);
        }
      }
    };

    for (const step of skill.steps) {
      normalizeStep(step);
    }
  }

  return skill as SkillDefinition;
}

// =============================================================================
// Vendor Override Types
// =============================================================================

export interface VendorOverrideSignature {
  pattern: string;
  confidence: 'high' | 'medium' | 'low';
}

export interface VendorOverride {
  vendor: string;
  extends: string;
  displayName?: string;
  description?: string;
  detection: { signatures: VendorOverrideSignature[] };
  additionalSteps: any[];
  overrideParams?: Record<string, any>;
}

export interface VendorOverrideLoadIssue {
  kind: 'orphan' | 'parse_failure';
  sourcePath: string;
  vendor: string;
  extends?: string;
  reasonCode:
    | 'vendor_override_base_missing'
    | 'vendor_override_base_not_built_in'
    | 'vendor_override_parse_failure';
  message: string;
}

export interface SkillRootDescriptor {
  rootPath: string;
  origin: 'built_in' | 'external_pack';
  packId?: string;
  packVersion?: string;
  trustState?: SkillPackTrustState;
  sourcePath?: string;
}

// =============================================================================
// Skill Registry
// =============================================================================

export class SkillRegistry {
  private skills: Map<string, SkillDefinition> = new Map();
  private moduleSkills: Map<string, SkillDefinition> = new Map();  // Skills with module metadata
  private fragmentCache: Map<string, string> = new Map();  // SQL fragment path → content
  /** Vendor overrides keyed by base skill ID (from `extends` field) */
  private vendorOverrides: Map<string, VendorOverride[]> = new Map();
  private vendorOverrideLoadIssues: VendorOverrideLoadIssue[] = [];
  private skillOrigins: Map<string, SkillOriginMetadata> = new Map();
  private displayContractIssues: DisplayContractIssue[] = [];
  private displayContractIssueKeys: Set<string> = new Set();
  private initialized = false;

  /**
   * 加载所有 skills
   */
  async loadSkills(skillsDir: string): Promise<void> {
    if (this.initialized) return;

    await this.loadSkillRoots([{ rootPath: skillsDir, origin: 'built_in' }]);
  }

  async loadSkillRoots(roots: SkillRootDescriptor[]): Promise<void> {
    if (this.initialized) return;

    for (const root of roots) {
      await this.loadSkillRoot(root);
    }
    for (const root of roots) {
      if (root.origin !== 'built_in') continue;
      const vendorsDir = path.join(root.rootPath, 'vendors');
      if (fs.existsSync(vendorsDir)) {
        this.loadVendorOverrides(vendorsDir);
      }
    }

    this.initialized = true;
    this.logDisplayContractSummary();
    logger.info('SkillLoader', `Loaded ${this.skills.size} skills (${this.moduleSkills.size} module experts, ${this.vendorOverrides.size} vendor-overridden skills)`);
  }

  private async loadSkillRoot(root: SkillRootDescriptor): Promise<void> {
    const skillsDir = root.rootPath;
    logger.info('SkillLoader', `Loading skills from: ${skillsDir}`);

    this.loadFragments(skillsDir, root);

    for (const dirName of ['atomic', 'composite', 'deep', 'system', 'comparison']) {
      const skillDir = path.join(skillsDir, dirName);
      if (fs.existsSync(skillDir)) {
        await this.loadSkillsFromDir(skillDir, root);
      }
    }

    if (root.origin === 'built_in') {
      const customDir = path.join(skillsDir, 'custom');
      if (fs.existsSync(customDir)) {
        await this.loadSkillsFromDir(customDir, root);
      }
    }

    const modulesDir = path.join(skillsDir, 'modules');
    if (fs.existsSync(modulesDir)) {
      await this.loadModuleSkillsRecursively(modulesDir, root);
    }

    const pipelinesDir = path.join(skillsDir, 'pipelines');
    if (fs.existsSync(pipelinesDir)) {
      await this.loadPipelineSkills(pipelinesDir, root);
    }

  }

  /**
   * Load SQL fragments from skills/fragments/ directory.
   * Fragments are reusable CTE definitions that can be injected into step SQL.
   */
  private loadFragments(skillsDir: string, root?: SkillRootDescriptor): void {
    const fragmentsDir = path.join(skillsDir, 'fragments');
    if (!fs.existsSync(fragmentsDir)) return;

    const files = fs.readdirSync(fragmentsDir);
    for (const file of files) {
      if (!file.endsWith('.sql')) continue;
      const filePath = path.join(fragmentsDir, file);
      try {
        const content = fs.readFileSync(filePath, 'utf-8').trim();
        const key = `fragments/${file}`;
        const existing = this.fragmentCache.get(key);
        if (root?.origin === 'external_pack' && existing !== undefined && existing !== content) {
          throw new Error(`fragment_key_collision:${key}`);
        }
        this.fragmentCache.set(key, content);
        logger.debug('SkillLoader', `Loaded SQL fragment: ${key}`);
      } catch (error: any) {
        if (root?.origin === 'external_pack') {
          throw error;
        }
        logger.error('SkillLoader', `Failed to load fragment ${file}: ${error.message}`);
      }
    }
    logger.info('SkillLoader', `Loaded ${this.fragmentCache.size} SQL fragments`);
  }

  /** Get a loaded SQL fragment by its path key (e.g., 'fragments/target_threads.sql') */
  getFragment(fragmentPath: string): string | undefined {
    return this.fragmentCache.get(fragmentPath);
  }

  /** Get all loaded fragment path keys */
  getFragmentPaths(): Set<string> {
    return new Set(this.fragmentCache.keys());
  }

  /** Get the full fragment cache (for passing to SkillExecutor) */
  getFragmentCache(): Map<string, string> {
    return this.fragmentCache;
  }

  /**
   * Run all load-time validations on a skill and log warnings.
   */
  private validateAndLogWarnings(skill: SkillDefinition, filePath?: string): {
    displayIssues: DisplayContractIssue[];
    conditionIssueCount: number;
    fragmentIssueCount: number;
    batchAnalysisIssueCount: number;
  } {
    const displayWarnings = this.validateAndLogDisplayWarnings(skill, filePath);

    const condWarnings = validateSkillConditions(skill);
    for (const w of condWarnings) {
      logger.warn('SkillLoader', `[${skill.name}.${w.stepId}] ${w.message}`);
    }

    const fragWarnings = validateFragmentReferences(skill, this.getFragmentPaths());
    for (const w of fragWarnings) {
      logger.warn('SkillLoader', `[${skill.name}.${w.stepId}] ${w.message}`);
    }

    const batchAnalysisIssues = validateSkillBatchAnalysis(skill);
    for (const validationIssue of batchAnalysisIssues) {
      logger.warn('SkillLoader', `[${skill.name}.${validationIssue.path}] ${validationIssue.message}`);
    }

    return {
      displayIssues: displayWarnings,
      conditionIssueCount: condWarnings.length,
      fragmentIssueCount: fragWarnings.length,
      batchAnalysisIssueCount: batchAnalysisIssues.length,
    };
  }

  private originForRoot(root?: SkillRootDescriptor): SkillOriginMetadata {
    if (root?.origin === 'external_pack') {
      return {
        origin: 'external_pack',
        packId: root.packId,
        packVersion: root.packVersion,
        trustState: root.trustState,
        sourcePath: root.sourcePath ?? root.rootPath,
      };
    }
    return { origin: 'built_in' };
  }

  private registerLoadedSkill(
    skill: SkillDefinition,
    filePath: string | undefined,
    root?: SkillRootDescriptor,
  ): void {
    if (root?.origin === 'external_pack' && this.skills.has(skill.name)) {
      throw new Error(`skill_id_collision:${skill.name}`);
    }
    const validation = this.validateAndLogWarnings(skill, filePath);
    if (
      root?.origin === 'external_pack'
      && (
        validation.displayIssues.length > 0
        || validation.conditionIssueCount > 0
        || validation.fragmentIssueCount > 0
        || validation.batchAnalysisIssueCount > 0
      )
    ) {
      throw new Error(`skill_validation_failed:${skill.name}`);
    }
    this.skills.set(skill.name, skill);
    this.skillOrigins.set(skill.name, this.originForRoot(root));

    if (skill.module) {
      this.moduleSkills.set(skill.name, skill);
    } else {
      this.moduleSkills.delete(skill.name);
    }
  }

  /**
   * Run only the display contract validator. Vendor overrides are fragments of a
   * base skill, so condition/fragment validation would produce false positives.
   */
  private validateAndLogDisplayWarnings(skill: SkillDefinition | Record<string, unknown>, filePath?: string): DisplayContractIssue[] {
    const displayWarnings = validateSkillDisplayContract(skill, { filePath });
    const newlyRecorded = this.recordDisplayContractIssues(displayWarnings);
    if (process.env.SMARTPERFETTO_VERBOSE_SKILL_WARNINGS === '1') {
      for (const warn of newlyRecorded) {
        logger.warn('SkillLoader', `Validation warning in ${formatDisplayContractIssue(warn)}`);
      }
    }
    return newlyRecorded;
  }

  private recordDisplayContractIssues(issues: DisplayContractIssue[]): DisplayContractIssue[] {
    const newlyRecorded: DisplayContractIssue[] = [];
    for (const issue of issues) {
      const key = [
        issue.filePath || '',
        issue.skillName,
        issue.stepId || '',
        issue.path,
        String(issue.value),
      ].join('\0');
      if (this.displayContractIssueKeys.has(key)) continue;
      this.displayContractIssueKeys.add(key);
      this.displayContractIssues.push(issue);
      newlyRecorded.push(issue);
    }
    return newlyRecorded;
  }

  private logDisplayContractSummary(): void {
    if (this.displayContractIssues.length === 0) return;

    const skills = new Set(this.displayContractIssues.map(issue => issue.skillName));
    const files = new Set(this.displayContractIssues.map(issue => issue.filePath).filter(Boolean));
    logger.warn(
      'SkillLoader',
      `Display contract warnings: ${this.displayContractIssues.length} issues across ${skills.size} skills` +
        (files.size > 0 ? ` (${files.size} files)` : '') +
        '. Run `cd backend && npm run validate:skills` for details. ' +
        'Set SMARTPERFETTO_VERBOSE_SKILL_WARNINGS=1 to print every load-time issue.'
    );
  }

  /**
   * 递归加载 modules 目录下的 skills
   * modules/
   *   ├── app/
   *   ├── framework/
   *   ├── kernel/
   *   └── hardware/
   */
  private async loadModuleSkillsRecursively(dir: string, root?: SkillRootDescriptor): Promise<void> {
    const entries = fs.readdirSync(dir, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        await this.loadModuleSkillsRecursively(fullPath, root);
      } else if (entry.name.endsWith('.skill.yaml') || entry.name.endsWith('.skill.yml')) {
        try {
          const content = fs.readFileSync(fullPath, 'utf-8');
          const loaded = yaml.load(content) as any;
          const skill = normalizeSkillDefinition(loaded, fullPath);

          if (skill && skill.name) {
            this.registerLoadedSkill(skill, fullPath, root);
            if (skill.module) {
              logger.debug('SkillLoader', `Loaded module skill: ${skill.name} (${skill.module.layer}/${skill.module.component})`);
            } else {
              logger.debug('SkillLoader', `Loaded skill: ${skill.name} (${skill.type})`);
            }
          }
        } catch (error: any) {
          if (root?.origin === 'external_pack') {
            throw error;
          }
          logger.error('SkillLoader', `Failed to load ${fullPath}:`, error.message);
        }
      }
    }
  }

  /**
   * 加载 pipeline skills
   * Pipeline skills are a special type that define rendering pipeline configurations
   */
  private async loadPipelineSkills(dir: string, root?: SkillRootDescriptor): Promise<void> {
    const files = fs.readdirSync(dir);

    for (const file of files) {
      // Skip non-skill files and template files
      if (!file.endsWith('.skill.yaml') && !file.endsWith('.skill.yml')) continue;
      if (file.startsWith('_')) continue;

      const filePath = path.join(dir, file);
      try {
        const content = fs.readFileSync(filePath, 'utf-8');
        const skill = yaml.load(content) as SkillDefinition;

        if (skill && skill.name && skill.type === 'pipeline_definition') {
          this.registerLoadedSkill(skill, filePath, root);
          logger.debug('SkillLoader', `Loaded pipeline skill: ${skill.name}`);
        }
      } catch (error: any) {
        if (root?.origin === 'external_pack') {
          throw error;
        }
        logger.error('SkillLoader', `Failed to load pipeline ${file}:`, error.message);
      }
    }
  }

  /**
   * 加载 vendor overrides
   * vendors/ 下每个厂商子目录包含 *.override.yaml 文件
   * 每个 override 声明 `extends: <base_skill_id>` 和 `additional_steps`
   */
  private loadVendorOverrides(dir: string): void {
    const vendorDirs = fs.readdirSync(dir, { withFileTypes: true });

    for (const entry of vendorDirs) {
      if (!entry.isDirectory()) continue;
      const vendorName = entry.name;
      const vendorDir = path.join(dir, vendorName);

      const files = fs.readdirSync(vendorDir);
      for (const file of files) {
        if (!file.endsWith('.override.yaml') && !file.endsWith('.override.yml')) continue;

        const filePath = path.join(vendorDir, file);
        try {
          const content = fs.readFileSync(filePath, 'utf-8');
          const raw = parseVendorOverrideSource(yaml.load(content));

          // Normalize the base skill ID: "composite/startup_analysis" → "startup_analysis"
          const baseSkillId = raw.extends.includes('/')
            ? raw.extends.split('/').pop()!
            : raw.extends;
          const baseOrigin = this.skillOrigins.get(baseSkillId);
          if (!baseOrigin) {
            this.recordVendorOverrideLoadIssue({
              kind: 'orphan',
              sourcePath: vendorOverrideSourcePath(dir, filePath),
              vendor: vendorName,
              extends: baseSkillId,
              reasonCode: 'vendor_override_base_missing',
              message: `Vendor override base skill is missing: ${baseSkillId}`,
            });
            continue;
          }
          if (baseOrigin.origin !== 'built_in') {
            this.recordVendorOverrideLoadIssue({
              kind: 'orphan',
              sourcePath: vendorOverrideSourcePath(dir, filePath),
              vendor: vendorName,
              extends: baseSkillId,
              reasonCode: 'vendor_override_base_not_built_in',
              message:
                `Vendor override base must be built in: ${baseSkillId}`,
            });
            continue;
          }

          const override: VendorOverride = {
            vendor: isNonEmptyString(raw.meta?.vendor)
              ? raw.meta.vendor
              : vendorName,
            extends: baseSkillId,
            displayName: optionalNonEmptyString(raw.meta?.display_name),
            description: optionalNonEmptyString(raw.meta?.description),
            detection: {
              signatures: Array.isArray(raw.vendor_detection?.signatures)
                ? raw.vendor_detection.signatures.map((s: any) => ({
                    pattern: String(s.pattern || ''),
                    confidence: s.confidence || 'medium',
                  }))
                : [],
            },
            additionalSteps: Array.isArray(raw.additional_steps) ? raw.additional_steps : [],
            overrideParams: raw.override_params,
          };

          if (override.additionalSteps.length > 0 || raw.output?.display) {
            this.validateAndLogDisplayWarnings({
              name: `${baseSkillId}@${override.vendor}:${path.basename(file, path.extname(file))}`,
              version: String(raw.version || '1'),
              meta: {
                display_name: raw.meta?.display_name || `${baseSkillId} ${override.vendor} override`,
                description: raw.meta?.description || `Vendor override for ${baseSkillId}`,
              },
              output: raw.output,
              steps: override.additionalSteps,
            } as any, filePath);
          }

          // Store keyed by base skill ID
          const existing = this.vendorOverrides.get(baseSkillId) || [];
          existing.push(override);
          this.vendorOverrides.set(baseSkillId, existing);

          logger.debug('SkillLoader', `Loaded vendor override: ${vendorName}/${file} → extends ${baseSkillId}`);
        } catch (error: any) {
          const message = error instanceof Error ? error.message : String(error);
          this.recordVendorOverrideLoadIssue({
            kind: 'parse_failure',
            sourcePath: vendorOverrideSourcePath(dir, filePath),
            vendor: vendorName,
            reasonCode: 'vendor_override_parse_failure',
            message,
          });
        }
      }
    }

    // Log summary
    let totalOverrides = 0;
    for (const overrides of this.vendorOverrides.values()) {
      totalOverrides += overrides.length;
    }
    logger.info('SkillLoader', `Loaded ${totalOverrides} vendor overrides across ${this.vendorOverrides.size} base skills`);
  }

  /**
   * 获取指定 skill 的特定厂商覆盖
   * @param skillId 基础 skill ID (e.g. "startup_analysis")
   * @param vendor 厂商标识 (e.g. "xiaomi", "pixel")
   * @returns 匹配的 VendorOverride，不存在则返回 undefined
   */
  getVendorOverride(skillId: string, vendor: string): VendorOverride | undefined {
    const overrides = this.vendorOverrides.get(skillId);
    if (!overrides) return undefined;
    return overrides.find(o => o.vendor.toLowerCase() === vendor.toLowerCase());
  }

  /**
   * 获取指定 skill 的所有厂商覆盖
   * @param skillId 基础 skill ID
   * @returns 所有匹配的 VendorOverride 列表
   */
  getVendorOverridesForSkill(skillId: string): VendorOverride[] {
    return this.vendorOverrides.get(skillId) || [];
  }

  /**
   * 获取所有已加载的 vendor override 数量
   */
  getVendorOverrideCount(): number {
    let count = 0;
    for (const overrides of this.vendorOverrides.values()) {
      count += overrides.length;
    }
    return count;
  }

  getVendorOverrideLoadIssues(): VendorOverrideLoadIssue[] {
    return this.vendorOverrideLoadIssues.map(issue => ({...issue}));
  }

  private recordVendorOverrideLoadIssue(issue: VendorOverrideLoadIssue): void {
    this.vendorOverrideLoadIssues.push(issue);
    logger.warn(
      'SkillLoader',
      `${issue.kind} vendor override ${issue.sourcePath}: ${issue.message}`,
    );
  }

  /**
   * 从目录加载 skills
   */
  private async loadSkillsFromDir(dir: string, root?: SkillRootDescriptor): Promise<void> {
    const files = fs.readdirSync(dir);

    for (const file of files) {
      if (!file.endsWith('.skill.yaml') && !file.endsWith('.skill.yml')) {
        continue;
      }

      const filePath = path.join(dir, file);
      try {
        const content = fs.readFileSync(filePath, 'utf-8');
        const loaded = yaml.load(content) as any;
        const skill = normalizeSkillDefinition(loaded, filePath);

        if (skill && skill.name) {
          this.registerLoadedSkill(skill, filePath, root);
          logger.debug('SkillLoader', `Loaded skill: ${skill.name} (${skill.type})`);
        }
      } catch (error: any) {
        if (root?.origin === 'external_pack') {
          throw error;
        }
        logger.error('SkillLoader', `Failed to load ${file}:`, error.message);
      }
    }
  }

  /**
   * Load one YAML skill into this registry without marking the registry fully
   * initialized. This is used by latency-sensitive runtime pre-evidence paths
   * that need one deterministic Skill while the full registry initializes in
   * parallel.
   */
  loadSingleSkill(skillsDir: string, relativeSkillPath: string): SkillDefinition | undefined {
    if (this.fragmentCache.size === 0) {
      this.loadFragments(skillsDir);
    }

    const filePath = path.isAbsolute(relativeSkillPath)
      ? relativeSkillPath
      : path.join(skillsDir, relativeSkillPath);
    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      const loaded: unknown = yaml.load(content);
      const skill = normalizeSkillDefinition(loaded, filePath);

      if (!skill?.name) {
        logger.warn('SkillLoader', `Single skill ${filePath} missing 'name', skipping`);
        return undefined;
      }

      this.registerLoadedSkill(skill, filePath);
      logger.debug('SkillLoader', `Loaded single skill: ${skill.name} (${skill.type})`);
      return skill;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error('SkillLoader', `Failed to load single skill ${filePath}:`, message);
      return undefined;
    }
  }

  /**
   * 获取 skill
   */
  getSkill(name: string): SkillDefinition | undefined {
    return this.skills.get(name);
  }

  getSkillOrigin(name: string): SkillOriginMetadata | undefined {
    return this.skillOrigins.get(name);
  }

  /**
   * 获取所有 skills
   */
  getAllSkills(): SkillDefinition[] {
    return Array.from(this.skills.values());
  }

  /**
   * Programmatically insert/override a skill definition.
   * Used for runtime-generated skills where YAML should be the single source of truth.
   */
  upsertSkill(skill: SkillDefinition): void {
    const validation = this.validateAndLogWarnings(skill);
    this.skills.set(skill.name, skill);
    this.skillOrigins.set(skill.name, { origin: 'built_in' });

    // Keep moduleSkills map consistent
    if (skill.module) {
      this.moduleSkills.set(skill.name, skill);
    } else {
      this.moduleSkills.delete(skill.name);
    }

    if (this.initialized && validation.displayIssues.length > 0) {
      this.logDisplayContractSummary();
    }
  }

  /**
   * 获取所有模块专家 skills
   */
  getAllModuleSkills(): SkillDefinition[] {
    return Array.from(this.moduleSkills.values());
  }

  /**
   * 根据模块层级查找 skills
   */
  findSkillsByLayer(layer: ModuleLayer): SkillDefinition[] {
    return Array.from(this.moduleSkills.values()).filter(
      (skill) => skill.module?.layer === layer
    );
  }

  /**
   * 根据组件名查找 skill
   */
  findSkillByComponent(component: string): SkillDefinition | undefined {
    return Array.from(this.moduleSkills.values()).find(
      (skill) => skill.module?.component.toLowerCase() === component.toLowerCase()
    );
  }

  /**
   * 根据层级和组件查找 skill
   */
  findModuleSkill(layer: ModuleLayer, component: string): SkillDefinition | undefined {
    return Array.from(this.moduleSkills.values()).find(
      (skill) =>
        skill.module?.layer === layer &&
        skill.module?.component.toLowerCase() === component.toLowerCase()
    );
  }

  /**
   * 根据对话能力查找 skill
   * 查找能够回答特定问题类型的模块
   */
  findSkillByCapability(capabilityId: string): SkillDefinition | undefined {
    return Array.from(this.moduleSkills.values()).find((skill) =>
      skill.dialogue?.capabilities?.some((cap) => cap.id === capabilityId)
    );
  }

  /**
   * 获取所有可用的对话能力
   */
  getAllCapabilities(): Array<{ skillName: string; capability: DialogueCapability }> {
    const capabilities: Array<{ skillName: string; capability: DialogueCapability }> = [];

    for (const skill of this.moduleSkills.values()) {
      if (skill.dialogue?.capabilities) {
        for (const cap of skill.dialogue.capabilities) {
          capabilities.push({ skillName: skill.name, capability: cap });
        }
      }
    }

    return capabilities;
  }

  /**
   * 检查 skill 是否为模块专家
   */
  isModuleSkill(skillName: string): boolean {
    return this.moduleSkills.has(skillName);
  }

  /**
   * 根据关键词匹配 skill
   */
  findMatchingSkill(question: string): SkillDefinition | undefined {
    const lowerQuestion = question.toLowerCase();

    for (const skill of this.skills.values()) {
      if (!skill.triggers) continue;

      // 检查关键词
      const keywords = skill.triggers.keywords;
      if (keywords) {
        let keywordList: string[] = [];

        if (Array.isArray(keywords)) {
          keywordList = keywords;
        } else {
          keywordList = [
            ...(keywords.zh || []),
            ...(keywords.en || []),
          ];
        }

        for (const keyword of keywordList) {
          if (lowerQuestion.includes(keyword.toLowerCase())) {
            return skill;
          }
        }
      }

      // 检查模式
      if (skill.triggers.patterns) {
        for (const pattern of skill.triggers.patterns) {
          try {
            const regex = new RegExp(pattern, 'i');
            if (regex.test(question)) {
              return skill;
            }
          } catch {
            // 无效的正则表达式，跳过
          }
        }
      }
    }

    return undefined;
  }

  /**
   * 检查是否已初始化
   */
  isInitialized(): boolean {
    return this.initialized;
  }

  /**
   * 重新加载所有 skills
   */
  async reload(): Promise<void> {
    this.skills.clear();
    this.moduleSkills.clear();
    this.fragmentCache.clear();
    this.vendorOverrides.clear();
    this.vendorOverrideLoadIssues = [];
    this.skillOrigins.clear();
    this.displayContractIssues = [];
    this.displayContractIssueKeys.clear();
    this.initialized = false;
    const skillsDir = path.resolve(__dirname, '../../../skills');
    await this.loadSkills(skillsDir);
  }

  getDisplayContractIssues(): DisplayContractIssue[] {
    return [...this.displayContractIssues];
  }
}

interface ParsedVendorOverrideSource {
  extends: string;
  version?: unknown;
  meta?: Record<string, unknown>;
  vendor_detection?: {
    signatures?: Array<{
      pattern: string;
      confidence: 'high' | 'medium' | 'low';
    }>;
  };
  additional_steps?: unknown[];
  override_params?: Record<string, unknown>;
  output?: Record<string, unknown>;
}

function parseVendorOverrideSource(value: unknown): ParsedVendorOverrideSource {
  if (!isPlainRecord(value) || !isNonEmptyString(value.extends)) {
    throw new Error('vendor_override_schema_invalid:extends');
  }
  if (value.meta !== undefined && !isPlainRecord(value.meta)) {
    throw new Error('vendor_override_schema_invalid:meta');
  }
  if (isPlainRecord(value.meta)) {
    for (const field of ['vendor', 'display_name', 'description']) {
      if (
        value.meta[field] !== undefined
        && !isNonEmptyString(value.meta[field])
      ) {
        throw new Error(`vendor_override_schema_invalid:meta.${field}`);
      }
    }
  }
  if (
    value.additional_steps !== undefined
    && !Array.isArray(value.additional_steps)
  ) {
    throw new Error('vendor_override_schema_invalid:additional_steps');
  }
  if (
    value.override_params !== undefined
    && !isPlainRecord(value.override_params)
  ) {
    throw new Error('vendor_override_schema_invalid:override_params');
  }
  if (value.output !== undefined && !isPlainRecord(value.output)) {
    throw new Error('vendor_override_schema_invalid:output');
  }
  let vendorDetection: ParsedVendorOverrideSource['vendor_detection'];
  if (value.vendor_detection !== undefined) {
    if (!isPlainRecord(value.vendor_detection)) {
      throw new Error('vendor_override_schema_invalid:vendor_detection');
    }
    const signatures = value.vendor_detection.signatures;
    if (signatures !== undefined && !Array.isArray(signatures)) {
      throw new Error(
        'vendor_override_schema_invalid:vendor_detection.signatures',
      );
    }
    if (Array.isArray(signatures) && signatures.length === 0) {
      throw new Error(
        'vendor_override_schema_invalid:vendor_detection.signatures',
      );
    }
    vendorDetection = {
      ...(signatures === undefined
        ? {}
        : {
            signatures: signatures.map((entry, index) => {
              if (
                !isPlainRecord(entry)
                || !isNonEmptyString(entry.pattern)
                || !['high', 'medium', 'low'].includes(
                  String(entry.confidence),
                )
              ) {
                throw new Error(
                  `vendor_override_schema_invalid:signature[${index}]`,
                );
              }
              return {
                pattern: entry.pattern,
                confidence:
                  entry.confidence as 'high' | 'medium' | 'low',
              };
            }),
          }),
    };
  }
  return {
    extends: value.extends,
    ...(value.version === undefined ? {} : {version: value.version}),
    ...(value.meta === undefined
      ? {}
      : {meta: value.meta as Record<string, unknown>}),
    ...(vendorDetection ? {vendor_detection: vendorDetection} : {}),
    ...(value.additional_steps === undefined
      ? {}
      : {additional_steps: value.additional_steps}),
    ...(value.override_params === undefined
      ? {}
      : {override_params: value.override_params as Record<string, unknown>}),
    ...(value.output === undefined
      ? {}
      : {output: value.output as Record<string, unknown>}),
  };
}

function vendorOverrideSourcePath(
  vendorDirectory: string,
  filePath: string,
): string {
  return path.relative(path.dirname(vendorDirectory), filePath)
    .split(path.sep)
    .join('/');
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object'
    && value !== null
    && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function optionalNonEmptyString(value: unknown): string | undefined {
  return isNonEmptyString(value) ? value : undefined;
}

// 单例
export const skillRegistry = new SkillRegistry();

// =============================================================================
// 辅助函数
// =============================================================================

// Promise-based lock to prevent concurrent initialization
let initializationPromise: Promise<void> | null = null;

/**
 * 确保 skill registry 已初始化
 * NOTE: This function is safe to call concurrently - it will only initialize once
 */
export async function ensureSkillRegistryInitialized(): Promise<void> {
  // Fast path: already initialized
  if (skillRegistry.isInitialized()) return;

  // If initialization is in progress, wait for it
  if (initializationPromise) {
    await initializationPromise;
    return;
  }

  // Start initialization (only one caller will reach here)
  const skillsDir = path.resolve(__dirname, '../../../skills');
  initializationPromise = (async () => {
    await skillRegistry.loadSkills(skillsDir);

    // Runtime-generated skills (YAML-driven single source of truth)
    try {
      const generated = await generateRenderingPipelineDetectionSkill();
      skillRegistry.upsertSkill(generated);
      logger.debug('SkillLoader', `Overrode skill with YAML-driven generator: ${generated.name} (v${generated.version})`);
    } catch (error: any) {
      logger.warn(
        'SkillLoader',
        `Failed to generate YAML-driven rendering pipeline detection skill: ${error?.message || error}`
      );
    }
  })();

  try {
    await initializationPromise;
  } finally {
    // Clear the promise after completion (success or failure)
    // This allows retry on failure
    if (!skillRegistry.isInitialized()) {
      initializationPromise = null;
    }
  }
}

/**
 * 获取默认的 skills 目录
 */
export function getSkillsDir(): string {
  return path.resolve(__dirname, '../../../skills');
}
