// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import { uuidv4 } from '../utils/uuid';
import type { Finding } from '../agent/types';

const SEVERITY_MAP: Record<string, Finding['severity']> = {
  CRITICAL: 'critical',
  HIGH: 'high',
  MEDIUM: 'medium',
  LOW: 'low',
  INFO: 'info',
};

const PREFIX_SEVERITY_REGEX = /^[ \t]*(?:#{1,6}[ \t]+|[-+*][ \t]+|\d+[.)][ \t]+)?\*{0,2}\[(CRITICAL|HIGH|MEDIUM|LOW|INFO)\]\*{0,2}[^\S\r\n]*(\S[^\r\n]*)/gm;
const SUFFIX_SEVERITY_REGEX = /^([^\r\n]*?\S)[^\S\r\n]+\*{0,2}\[(CRITICAL|HIGH|MEDIUM|LOW|INFO)\]\*{0,2}[^\S\r\n]*$/gm;

interface SeverityMatch {
  severityLabel: string;
  title: string;
  markerIndex: number;
  sectionStart: number;
  afterTitleStart: number;
}

/**
 * Strip fenced code blocks (``` ... ```) from text to prevent extracting
 * false findings from Mermaid diagrams, SQL snippets, etc.
 * E.g., Mermaid nodes like `E["[HIGH] ...]"` contain [SEVERITY] patterns
 * that the regex would incorrectly match as findings.
 */
function stripCodeBlocks(text: string): string {
  return text.replace(/```[\s\S]*?```/g, '');
}

function maskCodeBlocksForFindingScan(text: string): string {
  return text.replace(/```[\s\S]*?```/g, block => block.replace(/[^\n]/g, ' '));
}

function maskMarkdownTableRowsForFindingScan(text: string): string {
  return text
    .split('\n')
    .map(line => isMarkdownTableRow(line) ? line.replace(/[^\n]/g, ' ') : line)
    .join('\n');
}

function isMarkdownTableRow(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed.includes('|')) return false;
  if (/^(?:#{1,6}\s+|[-*+]\s+|\d+\.\s+)/.test(trimmed)) return false;

  const cells = trimmed
    .split('|')
    .map(cell => cell.trim())
    .filter(Boolean);
  if (cells.length >= 3) return true;
  if ((trimmed.startsWith('|') || trimmed.endsWith('|')) && cells.length >= 2) return true;

  return isMarkdownTableSeparatorRow(trimmed);
}

function isMarkdownTableSeparatorRow(line: string): boolean {
  return /^\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(line.trim());
}

function collectSeverityMatches(scanText: string): SeverityMatch[] {
  const matches: SeverityMatch[] = [];

  PREFIX_SEVERITY_REGEX.lastIndex = 0;
  let prefixMatch: RegExpExecArray | null;
  while ((prefixMatch = PREFIX_SEVERITY_REGEX.exec(scanText)) !== null) {
    const sectionStart = scanText.lastIndexOf('\n', prefixMatch.index - 1) + 1;
    const markerIndex = prefixMatch.index + prefixMatch[0].indexOf(`[${prefixMatch[1]}]`);
    matches.push({
      severityLabel: prefixMatch[1],
      title: normalizeFindingTitle(prefixMatch[2]),
      markerIndex,
      sectionStart,
      afterTitleStart: prefixMatch.index + prefixMatch[0].length,
    });
  }

  SUFFIX_SEVERITY_REGEX.lastIndex = 0;
  let suffixMatch: RegExpExecArray | null;
  while ((suffixMatch = SUFFIX_SEVERITY_REGEX.exec(scanText)) !== null) {
    if (!isStructuredSuffixTitle(suffixMatch[1])) continue;
    matches.push({
      severityLabel: suffixMatch[2],
      title: normalizeFindingTitle(suffixMatch[1]),
      markerIndex: suffixMatch.index + suffixMatch[0].indexOf(`[${suffixMatch[2]}]`),
      sectionStart: suffixMatch.index,
      afterTitleStart: suffixMatch.index + suffixMatch[0].length,
    });
  }

  return matches
    .filter(match => match.title.length > 0)
    .sort((a, b) => a.markerIndex - b.markerIndex);
}

function isStructuredSuffixTitle(title: string): boolean {
  const trimmed = title.trim();
  return /^(?:#{1,6}\s+|[-+]\s+|\d+[.)]\s+|\*\*\S.*\*\*)/.test(trimmed);
}

function normalizeFindingTitle(title: string): string {
  return title
    .replace(/\*+/g, '')
    .trim()
    .replace(/^(?:#{1,6}\s+|[-+]\s+|\d+[.)]\s+)/, '')
    .trim();
}

/**
 * Extract Finding objects from Claude's free-text analysis output.
 * Scans for lines matching the pattern: **[SEVERITY] Title**
 */
export function extractFindingsFromText(text: string): Finding[] {
  const findings: Finding[] = [];
  if (!text) return findings;

  // Mask code blocks to avoid extracting findings from Mermaid/SQL/code content
  // while preserving indices so evidence can still be read from the original text.
  const scanText = maskMarkdownTableRowsForFindingScan(maskCodeBlocksForFindingScan(text));

  const severityMatches = collectSeverityMatches(scanText);
  for (const [index, match] of severityMatches.entries()) {
    const severity = SEVERITY_MAP[match.severityLabel] ?? 'info';
    const title = match.title;
    const afterTitleStart = match.afterTitleStart;
    const sectionEnd = severityMatches[index + 1]?.sectionStart ?? text.length;
    const afterTitle = text.substring(afterTitleStart, Math.min(sectionEnd, afterTitleStart + 1600));
    const afterTitleWithoutCode = stripCodeBlocks(afterTitle);
    const evidence = extractEvidence(afterTitle) ?? extractInlineHeadingEvidence(title) ?? extractQuantifiedRecommendationEvidence(afterTitle);

    findings.push({
      id: `claude-${uuidv4().slice(0, 8)}`,
      severity,
      title: title.substring(0, 200),
      description: extractDescription(afterTitleWithoutCode) || evidence || title,
      source: 'claude-agent',
      confidence: severityToConfidence(severity),
      evidence: evidence ? [{ text: evidence }] : undefined,
      recommendations: extractRecommendations(afterTitle),
    });
  }

  return findings;
}

/**
 * Extract Finding objects from an invoke_skill tool result.
 */
export function extractFindingsFromSkillResult(skillResult: any): Finding[] {
  const findings: Finding[] = [];
  if (!skillResult?.success) return findings;

  if (Array.isArray(skillResult.diagnostics)) {
    for (const diag of skillResult.diagnostics) {
      findings.push({
        id: `skill-${uuidv4().slice(0, 8)}`,
        severity: mapDiagnosticSeverity(diag.severity || diag.level),
        title: diag.title || diag.condition || 'Skill diagnostic',
        description: diag.description || diag.message || '',
        source: `skill:${skillResult.skillId || 'unknown'}`,
        confidence: diag.confidence ?? 0.8,
        details: diag.details,
      });
    }
  }

  return findings;
}

/**
 * Merge findings from multiple sources, deduplicating by title and sorting by severity.
 */
export function mergeFindings(sources: Finding[][]): Finding[] {
  const merged: Finding[] = [];
  const seenTitles = new Set<string>();

  for (const source of sources) {
    for (const finding of source) {
      const normalizedTitle = finding.title.toLowerCase().trim();
      if (!seenTitles.has(normalizedTitle)) {
        seenTitles.add(normalizedTitle);
        merged.push(finding);
      }
    }
  }

  const severityOrder: Record<string, number> = {
    critical: 0, high: 1, warning: 2, medium: 3, low: 4, info: 5,
  };
  merged.sort((a, b) => (severityOrder[a.severity] ?? 5) - (severityOrder[b.severity] ?? 5));

  return merged;
}

function extractDescription(text: string): string {
  const descMatch = text.match(/(?:描述[：:]|Description:)\s*(.+?)(?=\n(?:证据|建议|Evidence|Suggestion|\*\*\[)|$)/s);
  if (descMatch) return descMatch[1].trim().substring(0, 500);

  const firstLine = text.split('\n').find(l => {
    const trimmed = l.trim();
    return trimmed.length > 0 && !isListMarkerFragment(trimmed);
  });
  return firstLine?.trim().substring(0, 500) || '';
}

function isListMarkerFragment(text: string): boolean {
  return /^(?:[-*+]|\d+[.)])\s*\*{0,2}$/.test(text);
}

function extractEvidence(text: string): string | undefined {
  const labelPrefix = String.raw`\*{0,2}`;
  const labelDelimiter = String.raw`(?:\s*[：:]\s*\*{0,2}|\*{0,2}\s*[：:])`;
  // Try explicit "证据:" or "Evidence:" label first
  const explicit = text.match(new RegExp(
    `(?:${labelPrefix}证据(?:类型(?:\\s*[/／]\\s*置信度)?|来源|链)?${labelDelimiter}|${labelPrefix}Evidence(?:\\s*(?:Type(?:\\s*[/／]\\s*Confidence)?|Sources?|Chain))?${labelDelimiter})\\s*(.+?)(?=\\n(?:建议|Suggestion|Recommendation|${labelPrefix}\\[(?:CRITICAL|HIGH|MEDIUM|LOW|INFO)\\])|$)`,
    'is',
  ));
  if (explicit) return explicit[1].trim().substring(0, 500);

  const metricList = extractMetricListEvidence(text);
  if (metricList) return metricList;

  // Also match "根因推理链:" format (used by strategy-compliant conclusions)
  const rootCause = text.match(new RegExp(
    `(?:${labelPrefix}根因推理链${labelDelimiter}|${labelPrefix}根因${labelDelimiter}|${labelPrefix}Root\\s+Cause(?:\\s+Chain)?${labelDelimiter})\\s*(.+?)(?=\\n(?:建议|结论|Suggestion|Recommendation|${labelPrefix}\\[(?:CRITICAL|HIGH|MEDIUM|LOW|INFO)\\])|$)`,
    'is',
  ));
  if (rootCause) return rootCause[1].trim().substring(0, 500);

  const fencedMetricBlock = text.match(/^\s*```[^\n]*\n([\s\S]{20,1200}?)\n```/);
  if (fencedMetricBlock && looksLikeEvidenceMetricBlock(fencedMetricBlock[1])) {
    return fencedMetricBlock[1].trim().substring(0, 500);
  }

  const markdownTable = extractMarkdownTableEvidence(text);
  if (markdownTable) return markdownTable;

  return undefined;
}

function extractMetricListEvidence(text: string): string | undefined {
  const lines = text.split('\n');
  let cursor = 0;
  while (cursor < lines.length && lines[cursor].trim().length === 0) cursor += 1;

  const evidenceLines: string[] = [];
  let hasMetricField = false;
  let hasObservedConcreteMetric = false;
  for (; cursor < lines.length && evidenceLines.length < 8; cursor += 1) {
    const line = lines[cursor].trim();
    const bullet = line.match(/^[-*+]\s+(.+)$/);
    if (!bullet) break;

    evidenceLines.push(line);
    const field = bullet[1].match(/^\*{0,2}([^：:]{1,40})\*{0,2}\s*[：:]/);
    if (field && /耗时|duration|VSync|帧|MainThread|RenderThread|主线程|渲染线程|CPU|Binder|GC|IO|FPS/i.test(field[1])) {
      hasMetricField = true;
      const hasConcreteMetric = /(?:evidence_ref_id|source_ref|\d+(?:\.\d+)?\s*(?:ms|%|GHz|MHz|帧)|vsync_missed\s*[:=]\s*\d+)/i.test(bullet[1]);
      const isProjectedMetric = /预计|预期|期望|预估|估算|目标|收益|优化后|expected\b|estimate|estimated|target|projected|after\s+optimization/i.test(bullet[1]);
      if (hasConcreteMetric && !isProjectedMetric) hasObservedConcreteMetric = true;
    }
  }

  const evidence = evidenceLines.join('\n').trim();
  if (!hasMetricField || !hasObservedConcreteMetric || !looksLikeEvidenceMetricBlock(evidence)) return undefined;
  return evidence.substring(0, 500);
}

function extractInlineHeadingEvidence(title: string): string | undefined {
  const inline = title.match(/(?:\s+[—-]\s+|[：:]\s*)(.{20,})$/s);
  if (!inline) return undefined;

  const evidence = inline[1].trim();
  if (!looksLikeEvidenceMetricBlock(evidence) || !hasObservedConcreteMetric(evidence)) return undefined;
  return evidence.substring(0, 500);
}

function hasObservedConcreteMetric(text: string): boolean {
  const statements = text
    .replace(/(\d)\.(\d)/g, '$1\u0000$2')
    .split(/[\n。！？!?;；.]+/)
    .map(statement => statement.replace(/\u0000/g, '.').trim())
    .filter(Boolean);
  const concreteMetric = /(?:(?:evidence_ref_id|source_ref)\s*[:=]\s*\S+|art-\d+|vsync_missed\s*[:=]\s*\d+|\d+(?:\.\d+)?\s*(?:ms|%|GHz|MHz|帧|次|calls?|frames?))/gi;
  const projectedMetric = /预计|预期|期望|预估|估算|目标|收益|优化后|如果|若|可能|(?:将|会|能够|可以|可|能)\s*(?:降低|减少|提升|缩短|达到|改善|带来|节省)|降低|减少|提升|缩短|达到|改善|expected\b|estimate|estimated|target|projected|after\s+optimization|\bif\b|\bwould\b|\bcould\b|\bmay\b|\bmight\b|\bwill\b|\bcan\b|\bshould\b|\bshall\b|\b(?:reduce|improve|lower|decrease|save)\b/gi;
  const observedContext = /当前|现有|实测|观测|测得|记录|显示|[A-Za-z_][\w.-]*\s*=|\bcurrent\b|\bobserved\b|\bmeasured\b|\brecorded\b|\bshows?\b|\btakes?\b|\btook\b/i;
  const observedChangeContext = /(?:(?:实测|观测|测得|记录|显示)[^。！？!?]{0,120})?(?:已|已经)\s*(?:降低|减少|提升|缩短|达到|改善)/i;
  const sourceReference = /^(?:(?:evidence_ref_id|source_ref)\s*[:=]|art-\d+)/i;

  return statements.some(statement => {
    const concreteMatches = [...statement.matchAll(concreteMetric)];
    if (concreteMatches.length === 0) return false;
    const projectedMatches = [...statement.matchAll(projectedMetric)];
    if (projectedMatches.length === 0) return true;

    return concreteMatches.some(match => {
      const metricIndex = match.index ?? 0;
      if (sourceReference.test(match[0])) return true;
      const context = statement.slice(Math.max(0, metricIndex - 120), metricIndex + match[0].length);
      const hasProjectedBeforeMetric = projectedMatches.some(projected => (projected.index ?? 0) < metricIndex);
      if (hasProjectedBeforeMetric) return observedChangeContext.test(context);
      return observedContext.test(context);
    });
  });
}

function extractMarkdownTableEvidence(text: string): string | undefined {
  const lines = text.split('\n');
  let start = 0;
  while (start < lines.length && lines[start].trim().length === 0) start += 1;
  if (start >= lines.length || !isMarkdownTableRow(lines[start])) return undefined;

  const separator = start + 1;
  if (!isMarkdownTableSeparatorRow(lines[separator] ?? '')) return undefined;

  const evidenceLines = [lines[start].trimEnd(), lines[separator].trimEnd()];
  let cursor = separator + 1;
  for (; cursor < lines.length; cursor += 1) {
    const line = lines[cursor];
    if (line.trim().length === 0) break;
    if (!isMarkdownTableRow(line)) break;
    evidenceLines.push(line.trimEnd());
  }

  while (cursor < lines.length && lines[cursor].trim().length === 0) cursor += 1;
  if (isCausalEvidenceLine(lines[cursor] ?? '')) {
    evidenceLines.push('');
    evidenceLines.push(lines[cursor].trim());
  }

  const evidence = evidenceLines.join('\n').trim();
  if (!looksLikeEvidenceMetricBlock(evidence)) return undefined;
  return evidence.substring(0, 500);
}

function extractQuantifiedRecommendationEvidence(text: string): string | undefined {
  const lines = text
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean);

  const evidenceLines: string[] = [];
  const observedEvidenceLines: string[] = [];
  let hasCausalSupportLine = false;
  for (const line of lines) {
    if (/^(?:#{1,6}\s+|\*{0,2}\[(?:CRITICAL|HIGH|MEDIUM|LOW|INFO)\])/.test(line)) break;
    if (/^\d+[.)]\s+/.test(line)) break;
    const content = line.replace(/^[-*+]\s*/, '');
    if (/^[-*+]\s+/.test(line) && hasObservedConcreteMetric(content)) {
      observedEvidenceLines.push(content);
    }
    const labeledEvidence = content.match(/^\*{0,2}(收益|影响|WHY|为什么|依据|证据|Evidence|Impact|Why)\*{0,2}\s*[：:]/i);
    if (labeledEvidence) {
      evidenceLines.push(content);
      if (/^(?:WHY|为什么|依据|证据|Evidence|Why)$/i.test(labeledEvidence[1])) {
        hasCausalSupportLine = true;
      }
      continue;
    }
    if (evidenceLines.length > 0 && /^[-*+]\s+/.test(line) && looksLikeEvidenceMetricBlock(content)) {
      evidenceLines.push(content);
    }
    if (evidenceLines.length >= 4) break;
  }

  const observedEvidence = observedEvidenceLines.join('\n').trim();
  if (observedEvidence && looksLikeEvidenceMetricBlock(observedEvidence)) {
    return observedEvidence.substring(0, 500);
  }
  const evidence = evidenceLines.join('\n').trim();
  if (!evidence || !hasCausalSupportLine || !looksLikeEvidenceMetricBlock(evidence)) return undefined;
  return evidence.substring(0, 500);
}

function isCausalEvidenceLine(line: string): boolean {
  return /^\*{0,2}(?:因果链|根因推理链|证据|Evidence|Root\s+Cause(?:\s+Chain)?)\*{0,2}\s*[：:]/i
    .test(line.trim());
}

function looksLikeEvidenceMetricBlock(text: string): boolean {
  return /(?:帧耗时|掉帧|VSync|vsync_missed|MainThread|RenderThread|Choreographer|CPU\s*频率|CPU频率|Binder|GC|IO|FPS|frame\s*duration|evidence_ref_id|source_ref|\d+(?:\.\d+)?\s*(?:ms|%|GHz)|\d+\s*帧)/i
    .test(text);
}

function extractRecommendations(text: string): Finding['recommendations'] | undefined {
  const match = text.match(/(?:建议[：:]|Suggestion:|Recommendation:)\s*(.+?)(?=\n\*\*\[|$)/s);
  if (!match) return undefined;

  const lines = match[1].split('\n').filter(l => l.trim().length > 0);
  return lines.slice(0, 5).map((line, i) => ({
    id: `rec-${uuidv4().slice(0, 6)}`,
    text: line.replace(/^[-\d.)\s]+/, '').trim(),
    priority: i + 1,
  }));
}

function severityToConfidence(severity: Finding['severity']): number {
  const map: Record<string, number> = {
    critical: 0.95, high: 0.85, medium: 0.7, low: 0.6, warning: 0.7, info: 0.5,
  };
  return map[severity] ?? 0.5;
}

function mapDiagnosticSeverity(level: string | undefined): Finding['severity'] {
  if (!level) return 'info';
  const lower = level.toLowerCase();
  if (lower === 'error' || lower === 'critical') return 'critical';
  if (lower === 'warning' || lower === 'high') return 'high';
  if (lower === 'medium') return 'medium';
  if (lower === 'low') return 'low';
  return 'info';
}
