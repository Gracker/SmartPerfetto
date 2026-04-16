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

/** Phase-level restatement hint — loaded from strategy frontmatter `phase_hints`. */
export interface PhaseHint {
  id: string;
  keywords: string[];
  constraints: string;
  criticalTools: string[];
  /** When true, this hint is injected as unconditional fallback if keyword matching fails. */
  critical: boolean;
}

export interface StrategyDefinition {
  scene: string;
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
  content: string;
}

const STRATEGIES_DIR = path.resolve(__dirname, '../../strategies');
const FRONTMATTER_RE = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/;
/** In dev mode, skip caching so .strategy.md / .template.md edits take effect without restart. */
const DEV_MODE = process.env.NODE_ENV !== 'production';

let cache: Map<string, StrategyDefinition> | null = null;

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

  return {
    scene: frontmatter.scene as string,
    priority: (frontmatter.priority as number) ?? 99,
    effort: (frontmatter.effort as string) ?? 'high',
    keywords: (frontmatter.keywords as string[]) || [],
    compoundPatterns,
    requiredCapabilities: (frontmatter.required_capabilities as string[]) || [],
    optionalCapabilities: (frontmatter.optional_capabilities as string[]) || [],
    phaseHints,
    content,
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
  return loadStrategies().get(scene)?.content;
}

export function getRegisteredScenes(): StrategyDefinition[] {
  return Array.from(loadStrategies().values());
}

/** Get phase-level restatement hints for a scene. Returns [] if scene has no hints. */
export function getPhaseHints(scene: string): PhaseHint[] {
  return loadStrategies().get(scene)?.phaseHints || [];
}

/** Clear cached strategies and templates — useful for dev/test reloads. */
export function invalidateStrategyCache(): void {
  cache = null;
  templateCache.clear();
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
  if (templateCache.has(name) && !DEV_MODE) return templateCache.get(name);

  const filePath = path.join(STRATEGIES_DIR, `${name}.template.md`);
  if (!fs.existsSync(filePath)) return undefined;

  const content = fs.readFileSync(filePath, 'utf-8').trim();
  templateCache.set(name, content);
  return content;
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