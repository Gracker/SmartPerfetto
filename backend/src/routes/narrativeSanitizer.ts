// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

/**
 * Sanitizes assistant narrative text for end users.
 * Keeps human-readable reasoning but removes internal evidence IDs.
 */
import { LEGACY_TO_PLAIN_PHRASE_RULES } from '../utils/analysisNarrative';

const EVIDENCE_ID_RE = /\bev_[0-9a-f]{12}\b/gi;
// Artifact handles (`art-11`) and tool-call ids (`execute_sql:6:07787eaf`) are
// the same class of internal plumbing as `ev_*`: the structured conclusion
// contract is derived before display sanitization, so reports, snapshots and
// claim verification keep them while the text users read does not.
// The lookbehind keeps ordinary words such as `smart-artifact` / `chart-1`.
const ARTIFACT_ID_RE = /(?<![\w-])art-\d+\b/g;
const TOOL_CALL_ID_RE = /(?<![\w-])(?:execute_sql|execute_sql_on|invoke_skill|fetch_artifact|compare_skill):[0-9]+(?::[0-9a-f]+)?\b/gi;

type PhraseRule = {
  pattern: RegExp;
  replacement: string;
};

type AnnotationRule = {
  term: string;
  plainMeaning: string;
};

const PHRASE_RULES: PhraseRule[] = [
  ...LEGACY_TO_PLAIN_PHRASE_RULES,
  {
    pattern: /(?<!显示系统处理不过来（)SF消费端背压/g,
    replacement: '显示系统处理不过来（SF消费端背压）',
  },
  {
    pattern: /SF\/消费端放大信号存在/g,
    replacement: '显示系统侧存在放大效应',
  },
  {
    pattern: /(?<!线程更多跑在小核上（)核心摆放偏小核/g,
    replacement: '线程更多跑在小核上（核心摆放偏小核）',
  },
  {
    pattern: /(?<!应用没赶上当前刷新周期（)APP 截止超时/g,
    replacement: '应用没赶上当前刷新周期（APP 截止超时）',
  },
];

const ANNOTATION_RULES: AnnotationRule[] = [
  { term: '阻塞等待', plainMeaning: '线程等待锁/IO/Binder' },
  { term: '调度延迟', plainMeaning: '线程排队等CPU' },
  { term: '频率不足', plainMeaning: 'CPU频率偏低' },
];

const CLUSTER_SECTION_HEADER_RE = /^##\s*(?:掉帧聚类（先看大头）|掉帧聚类|聚类（先看大头）|聚类)\s*$/;
const NEXT_HEADER_RE = /^##\s+/;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function annotateTerm(text: string, rule: AnnotationRule): string {
  const term = escapeRegExp(rule.term);
  const plainMeaning = escapeRegExp(rule.plainMeaning);
  const pattern = new RegExp(`${term}(?!（${plainMeaning}）)`, 'g');
  return text.replace(pattern, `${rule.term}（${rule.plainMeaning}）`);
}

function humanizeNarrativeTerms(text: string): string {
  let out = text;

  for (const rule of PHRASE_RULES) {
    out = out.replace(rule.pattern, rule.replacement);
  }

  for (const rule of ANNOTATION_RULES) {
    out = annotateTerm(out, rule);
  }

  return out;
}

function humanizeClusterToken(text: string): string {
  return String(text || '')
    .replace(/\bK(\d+)\s*聚类\b/g, '第$1类分组')
    .replace(/\bK(\d+)\s*[:：]\s*/g, '第$1类：')
    .replace(/\bK(\d+)\s*(?=[（(])/g, '第$1类')
    .replace(/\bK(\d+)\b/g, '第$1类')
    .replace(/第(\d+)类：\s+/g, '第$1类：');
}

function humanizeEvidenceLabels(text: string): string {
  let out = String(text || '');

  out = out.replace(
    /^(\s*[-*]\s*)C(\d+)\s*[（(]自动补全[）)]\s*[:：]\s*/gim,
    '$1证据$2（对应结论$2）：'
  );
  out = out.replace(
    /^(\s*[-*]\s*)C(\d+)\s*[:：]\s*/gim,
    '$1证据$2（对应结论$2）：'
  );
  out = out.replace(
    /(证据链\s*[:：]\s*)C(\d+)\s*[:：]\s*/gi,
    '$1证据$2（对应结论$2）：'
  );

  return out;
}

function normalizeClusterHierarchy(text: string): string {
  const lines = String(text || '').split('\n');
  const rewritten: string[] = [];
  let inClusterSection = false;
  let hasParentLine = false;
  let insertedParentLine = false;

  for (const line of lines) {
    const trimmed = line.trim();

    if (CLUSTER_SECTION_HEADER_RE.test(trimmed)) {
      inClusterSection = true;
      hasParentLine = false;
      insertedParentLine = false;
      rewritten.push(line);
      continue;
    }

    if (inClusterSection && NEXT_HEADER_RE.test(trimmed)) {
      inClusterSection = false;
      rewritten.push(line);
      continue;
    }

    if (!inClusterSection) {
      rewritten.push(line);
      continue;
    }

    if (!trimmed) {
      rewritten.push(line);
      continue;
    }

    const withoutBullet = trimmed.replace(/^[-*]\s*/, '');
    if (/^聚类帧聚合（/.test(withoutBullet) || /^聚类帧分组（/.test(withoutBullet)) {
      hasParentLine = true;
      rewritten.push(`- ${humanizeClusterToken(withoutBullet.replace(/^聚类帧聚合/, '聚类帧分组'))}`);
      continue;
    }

    if (/^(?:K\d+|第\d+类)(?:\s*[（(:：]|$)/.test(withoutBullet)) {
      if (!hasParentLine && !insertedParentLine) {
        rewritten.push('- 聚类分组明细');
        insertedParentLine = true;
      }
      rewritten.push(`  - ${humanizeClusterToken(withoutBullet)}`);
      continue;
    }

    rewritten.push(humanizeClusterToken(line));
  }

  return rewritten.join('\n');
}

function humanizeOpaqueLabels(text: string): string {
  let out = String(text || '');

  out = normalizeClusterHierarchy(out);
  out = humanizeEvidenceLabels(out);
  out = out.replace(/(负载主导簇\s*[:：]\s*)K(\d+)/g, '$1第$2类');
  out = out.replace(/对\s*K(\d+)\s*聚类/g, '对第$1类分组');
  out = humanizeClusterToken(out);

  return out;
}

function collapseRepeatedInnerSpaces(text: string): string {
  return String(text || '')
    .split('\n')
    .map((line) => {
      const indentMatch = line.match(/^[ \t]*/);
      const indent = indentMatch ? indentMatch[0] : '';
      const body = line.slice(indent.length).replace(/[ \t]{2,}/g, ' ');
      return `${indent}${body}`;
    })
    .join('\n');
}

export function sanitizeNarrativeForClient(narrative: string): string {
  let out = String(narrative || '');
  if (!out.trim()) return out;

  // Hide internal evidence index line from user-facing output.
  out = out.replace(/^\s*-\s*证据索引（自动补全）:.*$/gim, '');

  // Remove compact "(ev_xxx|ev_yyy)" groups first to avoid leftover wrappers.
  out = out.replace(
    /[（(]\s*ev_[0-9a-f]{12}(?:\s*[|｜]\s*ev_[0-9a-f]{12})*\s*[）)]/gi,
    ''
  );

  // Remove any remaining standalone internal identifiers.
  out = out.replace(EVIDENCE_ID_RE, '');
  out = out.replace(TOOL_CALL_ID_RE, '');
  out = out.replace(ARTIFACT_ID_RE, '');

  // Remove empty JSON evidence field after evidence-id stripping.
  out = out.replace(/,\s*"evidence"\s*:\s*""/g, '');
  out = out.replace(/"evidence"\s*:\s*"",\s*/g, '');

  // Remove connector-only placeholders left inside parentheses after ID removal.
  // Example: "（ vs ）", "( | )", "（ / ）"
  out = out.replace(/[（(]\s*(?:vs|VS)\s*[）)]/g, '');
  out = out.replace(/[（(]\s*(?:[|｜/:,+-]\s*)+[）)]/g, '');
  // Drop a separator left dangling before the closing paren, e.g.
  // "（定向 SQL，execute_sql:6:ab）" -> "（定向 SQL）".
  out = out.replace(/([（(][^（()）]*?)[\s，,、;；|｜/+-]+([）)])/g, '$1$2');

  // Replace jargon-heavy wording with plain-language phrasing.
  out = humanizeNarrativeTerms(out);
  out = humanizeOpaqueLabels(out);

  // Cleanup artifacts introduced by ID removal.
  out = out.replace(/[（(]\s*[）)]/g, '');
  out = out.replace(/[·]\s*$/gm, '');
  out = out.replace(/[ \t]+$/gm, '');
  out = collapseRepeatedInnerSpaces(out);
  out = out.replace(/\n{3,}/g, '\n\n');

  return out.trim();
}