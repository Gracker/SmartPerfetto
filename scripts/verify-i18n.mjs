#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {pairedHeadingErrors} from './i18n-heading-contract.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const errors = [];
const HAN_RE = /\p{Script=Han}/u;

function fail(message) {
  errors.push(message);
}

function read(relativePath) {
  const absolutePath = path.join(root, relativePath);
  if (!fs.existsSync(absolutePath)) {
    fail(`missing required file: ${relativePath}`);
    return '';
  }
  return fs.readFileSync(absolutePath, 'utf8');
}

function expectIncludes(relativePath, source, needles) {
  for (const needle of needles) {
    if (!source.includes(needle)) {
      fail(`${relativePath} is missing required contract: ${needle}`);
    }
  }
}

function headingLevels(source) {
  return source
    .split(/\r?\n/u)
    .filter(line => /^#{1,6}\s+/u.test(line))
    .map(line => line.match(/^#+/u)[0].length);
}

function expectPairedHeadings(leftPath, rightPath) {
  const left = read(leftPath);
  const right = read(rightPath);
  const leftLevels = headingLevels(left);
  const rightLevels = headingLevels(right);
  if (JSON.stringify(leftLevels) !== JSON.stringify(rightLevels)) {
    fail(
      `${leftPath} and ${rightPath} have different heading structures ` +
        `(${leftLevels.length} vs ${rightLevels.length})`,
    );
  }
}

function verifyLocalizedText(value, location) {
  if (!value || typeof value !== 'object') {
    fail(`${location} is not a localized text object`);
    return;
  }
  for (const locale of ['zh-CN', 'en']) {
    if (typeof value[locale] !== 'string' || !value[locale].trim()) {
      fail(`${location}.${locale} is empty`);
    }
  }
  if (typeof value.en === 'string' && HAN_RE.test(value.en)) {
    fail(`${location}.en contains Han characters: ${value.en}`);
  }
}

const catalogPath = 'backend/skills/localization.catalog.json';
const catalogSource = read(catalogPath);
if (catalogSource) {
  const catalog = JSON.parse(catalogSource);
  if (catalog.schemaVersion !== 1) fail(`${catalogPath} schemaVersion must be 1`);
  if (catalog.generationPolicy?.stableIdentifiersRemainUntranslated !== true) {
    fail(`${catalogPath} must preserve stable identifiers`);
  }
  if (catalog.generationPolicy?.authoredNarrativeRemainsVerbatim !== true) {
    fail(`${catalogPath} must preserve authored narratives`);
  }

  const skillEntries = Object.entries(catalog.skills || {});
  if (catalog.inventory?.skillCount !== skillEntries.length) {
    fail(
      `${catalogPath} inventory.skillCount=${catalog.inventory?.skillCount} ` +
        `does not match ${skillEntries.length} catalog entries`,
    );
  }
  for (const [skillId, skill] of skillEntries) {
    verifyLocalizedText(skill.displayName, `skills.${skillId}.displayName`);
    verifyLocalizedText(skill.description, `skills.${skillId}.description`);
    for (const [stepId, step] of Object.entries(skill.steps || {})) {
      verifyLocalizedText(step.title, `skills.${skillId}.steps.${stepId}.title`);
      if (step.description) {
        verifyLocalizedText(
          step.description,
          `skills.${skillId}.steps.${stepId}.description`,
        );
      }
      for (const [columnId, column] of Object.entries(step.columns || {})) {
        verifyLocalizedText(
          column.label,
          `skills.${skillId}.steps.${stepId}.columns.${columnId}.label`,
        );
        if (column.tooltip) {
          verifyLocalizedText(
            column.tooltip,
            `skills.${skillId}.steps.${stepId}.columns.${columnId}.tooltip`,
          );
        }
      }
      for (const [labelId, label] of Object.entries(
        step.synthesizeLabels || {},
      )) {
        verifyLocalizedText(
          label,
          `skills.${skillId}.steps.${stepId}.synthesizeLabels.${labelId}`,
        );
      }
    }
  }
}

expectPairedHeadings('README.md', 'README.zh-CN.md');
for (const error of pairedHeadingErrors(root)) fail(error);

const uiLanguagePath =
  'perfetto/ui/src/plugins/com.smartperfetto.AIAssistant/ui_language.ts';
expectIncludes(uiLanguagePath, read(uiLanguagePath), [
  "export type UiLanguagePreference = 'auto' | 'zh-CN' | 'en'",
  'resolveUiOutputLanguage',
  'uiOutputLanguage',
]);

const settingsPath =
  'perfetto/ui/src/plugins/com.smartperfetto.AIAssistant/settings_modal.ts';
expectIncludes(settingsPath, read(settingsPath), [
  'smartperfetto-ui-language',
  "value: 'auto'",
  "value: 'zh-CN'",
  "value: 'en'",
]);

const panelPath =
  'perfetto/ui/src/plugins/com.smartperfetto.AIAssistant/ai_panel.ts';
const panel = read(panelPath);
expectIncludes(panelPath, panel, [
  'setUiLanguagePreference',
  'uiOutputLanguage()',
  'if (uiLanguageChanged)',
  'this.retireBackendAgentSession();',
]);
for (const forbidden of [
  "content: 'Please provide a timestamp.",
  "content: '**Error:** Trace context not available.",
  "title: 'Dismiss'",
  "title: 'Jump to timestamp'",
  "content: '**No ANRs detected",
  "content: '**No jank detected",
  "content: '**No SQL results to export.",
]) {
  if (panel.includes(forbidden)) {
    fail(`${panelPath} contains unlocalized visible text: ${forbidden}`);
  }
}

const criticalPathRoute = 'backend/src/routes/criticalPathRoutes.ts';
expectIncludes(criticalPathRoute, read(criticalPathRoute), [
  'analysis: rawAnalysis',
  'presentationAnalysis: projectCriticalPathAnalysis(',
]);

const skillControllerPath = 'backend/src/controllers/skillController.ts';
expectIncludes(skillControllerPath, read(skillControllerPath), [
  'localizedError(',
  'localizedFailure(',
  "zh: '缺少 Skill ID'",
  "zh: '无法执行 Skill'",
]);

const localeAwareFrontendFiles = [
  'ai_area_selection_tab.ts',
  'ai_floating_window.ts',
  'ai_panel.ts',
  'ai_sidebar_panel.ts',
  'codebase_form.ts',
  'codebase_panel.ts',
  'critical_path_extension.ts',
  'data_formatter.ts',
  'mermaid_renderer.ts',
  'navigation_bookmark_bar.ts',
  'provider_form.ts',
  'provider_panel.ts',
  'provider_switcher.ts',
  'scene_constants.ts',
  'settings_modal.ts',
  'sql_result_table.ts',
  'sse_event_handlers.ts',
  'story_controller.ts',
  'trace_location_label.ts',
  'track_overlay.ts',
  'workspace_trace_catalog.ts',
];
for (const filename of localeAwareFrontendFiles) {
  const relativePath =
    `perfetto/ui/src/plugins/com.smartperfetto.AIAssistant/${filename}`;
  const source = read(relativePath);
  if (!/\b(uiText|text)\s*\(/u.test(source)) {
    fail(`${relativePath} has no locale-aware presentation call`);
  }
}

if (errors.length > 0) {
  console.error('Multilingual verification failed:');
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}

const inventory = JSON.parse(catalogSource).inventory;
console.log(
  `Multilingual verification passed: ${inventory.skillCount} Skills, ` +
    `${inventory.pipelineDefinitionCount} pipelines, ` +
    `${inventory.moduleExpertCount} module experts, ` +
    `${inventory.stepCount} display steps, and ` +
    `${inventory.explicitColumnCount} explicit columns.`,
);
