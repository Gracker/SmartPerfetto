// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

export interface ArtifactAccessPolicy {
  forbidRows: boolean;
  requireSummaryBeforeRows: boolean;
  forbidRowsWhenSummaryComplete: boolean;
}

const NO_ROWS_DIRECTIVE = /(?:不要|不用|禁止|严禁|别|无需|不(?:再)?(?:读|读取|查看|获取|拉取|展开|加载|访问|使用))\s*(?:再\s*)?(?:读|读取|查看|获取|拉取|展开|加载|访问|使用)?\s*(?:任何|所有|全部|任意)?\s*(?:artifact\s*的?\s*)?(?:原始\s*)?(?:rows?|row|行数据|数据行|逐行数据)/i;
const ENGLISH_NO_ROWS_DIRECTIVE = /\b(?:(?:do\s+not|don't|never)\s+(?:(?:read|fetch|load|inspect|page(?:\s+through)?|use|access)\s+)?(?:any\s+|all\s+)?(?:raw\s+)?rows?|no\s+raw\s+rows?)\b/i;
const COMPLETE_CONDITION = /(?:aggregate\s*\.\s*complete|complete\s*=+\s*true|complete\s+is\s+true|聚合[^,，。；;\n]{0,16}完整|摘要[^,，。；;\n]{0,16}完整)/i;
const SUMMARY_FIRST = /(?:先|优先)(?:用|看|读|读取|获取|查看)?[^,，。；;\n]{0,48}(?:detail\s*=\s*["']?summary|summary|摘要)|\bsummary\s+first\b|\bfirst\s+(?:fetch|read|use|inspect)[^.;\n]{0,32}\bsummary\b/i;

function hasNoRowsDirective(text: string): boolean {
  return NO_ROWS_DIRECTIVE.test(text) || ENGLISH_NO_ROWS_DIRECTIVE.test(text);
}

/**
 * Resolve only explicit row-access constraints. General evidence preferences
 * remain in Strategies; this policy exists for user instructions that the tool
 * boundary must enforce rather than merely repeat to the model.
 */
export function resolveArtifactAccessPolicy(userQuery?: string): ArtifactAccessPolicy {
  const query = userQuery?.trim() ?? '';
  if (!query) {
    return {
      forbidRows: false,
      requireSummaryBeforeRows: false,
      forbidRowsWhenSummaryComplete: false,
    };
  }

  let forbidRows = false;
  let forbidRowsWhenSummaryComplete = false;
  for (const clause of query.split(/[。；;\n]+/)) {
    if (!hasNoRowsDirective(clause)) continue;
    if (COMPLETE_CONDITION.test(clause)) {
      forbidRowsWhenSummaryComplete = true;
    } else {
      forbidRows = true;
    }
  }

  return {
    forbidRows,
    requireSummaryBeforeRows: forbidRowsWhenSummaryComplete || SUMMARY_FIRST.test(query),
    forbidRowsWhenSummaryComplete,
  };
}
