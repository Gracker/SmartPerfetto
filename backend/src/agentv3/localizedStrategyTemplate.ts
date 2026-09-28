// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import type {OutputLanguage} from './outputLanguage';
import {loadPromptTemplate, renderTemplate, stripPromptComments} from './strategyLoader';

/**
 * Render a required bilingual strategy asset without a TypeScript copy
 * fallback. Authoring comments go before substitution: they never reach a
 * model or a report, and a substituted value is never altered.
 */
export function renderRequiredLocalizedStrategyTemplate(
  baseName: string,
  outputLanguage: OutputLanguage,
  vars: Record<string, string | number | undefined>,
): string {
  const languageSuffix = outputLanguage === 'zh-CN' ? 'zh' : 'en';
  const templateName = `${baseName}-${languageSuffix}`;
  const template = loadPromptTemplate(templateName);
  if (!template) {
    throw new Error(`Required strategy template is missing: ${templateName}.template.md`);
  }
  return renderTemplate(stripPromptComments(template), vars);
}
