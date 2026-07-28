// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)

/**
 * Scenario Loader
 *
 * Loads test scenarios from YAML files.
 * Supports glob patterns and filtering by tags/categories.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'yaml';
import { glob } from 'glob';
import { TestScenario } from './types';

export interface ScenarioFile {
  scenarios: TestScenario[];
}

export interface LoadOptions {
  /** Filter by category */
  categories?: string[];

  /** Filter by tags (any match) */
  tags?: string[];

  /** Filter by priority */
  priorities?: ('critical' | 'high' | 'medium' | 'low')[];

  /** Filter by scenario IDs */
  ids?: string[];
}

/**
 * Load scenarios from a single YAML file
 */
export function loadScenarioFile(filePath: string): TestScenario[] {
  const content = fs.readFileSync(filePath, 'utf-8');
  const parsed = yaml.parse(content) as ScenarioFile;

  if (!parsed.scenarios || !Array.isArray(parsed.scenarios)) {
    console.warn(`No scenarios found in ${filePath}`);
    return [];
  }

  // Add source file info to each scenario
  return parsed.scenarios.map((scenario) => ({
    ...scenario,
    _sourceFile: filePath,
  }));
}

/**
 * Load scenarios from multiple files matching a glob pattern
 */
export async function loadScenarios(
  pattern: string | string[],
  options: LoadOptions = {},
): Promise<TestScenario[]> {
  const patterns = Array.isArray(pattern) ? pattern : [pattern];
  const allScenarios: TestScenario[] = [];

  for (const p of patterns) {
    const files = await glob(p);

    for (const file of files) {
      try {
        const scenarios = loadScenarioFile(file);
        allScenarios.push(...scenarios);
      } catch (error: any) {
        console.error(`Error loading ${file}: ${error.message}`);
      }
    }
  }

  // Apply filters
  let filtered = allScenarios;

  if (options.categories && options.categories.length > 0) {
    filtered = filtered.filter((s) => options.categories!.includes(s.category));
  }

  if (options.tags && options.tags.length > 0) {
    filtered = filtered.filter((s) =>
      s.tags?.some((tag) => options.tags!.includes(tag)),
    );
  }

  if (options.priorities && options.priorities.length > 0) {
    filtered = filtered.filter((s) => options.priorities!.includes(s.priority));
  }

  if (options.ids && options.ids.length > 0) {
    filtered = filtered.filter((s) => options.ids!.includes(s.id));
  }

  return filtered;
}

/**
 * Get the default scenarios directory
 */
export function getDefaultScenariosDir(): string {
  return path.resolve(
    __dirname,
    '../../../../tests/agent-eval/scenarios',
  );
}

/**
 * Load all scenarios from the default directory
 */
export async function loadAllScenarios(
  options: LoadOptions = {},
): Promise<TestScenario[]> {
  const defaultDir = getDefaultScenariosDir();
  const pattern = path.join(defaultDir, '**/*.scenario.yaml');
  return loadScenarios(pattern, options);
}
