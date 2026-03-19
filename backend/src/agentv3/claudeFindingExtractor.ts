import { v4 as uuidv4 } from 'uuid';
import type { Finding } from '../agent/types';

const SEVERITY_MAP: Record<string, Finding['severity']> = {
  CRITICAL: 'critical',
  HIGH: 'high',
  MEDIUM: 'medium',
  LOW: 'low',
  INFO: 'info',
};

const SEVERITY_REGEX = /\*?\*?\[(CRITICAL|HIGH|MEDIUM|LOW|INFO)\]\*?\*?\s*(.+)/g;

/**
 * Strip fenced code blocks (``` ... ```) from text to prevent extracting
 * false findings from Mermaid diagrams, SQL snippets, etc.
 * E.g., Mermaid nodes like `E["[HIGH] ...]"` contain [SEVERITY] patterns
 * that the regex would incorrectly match as findings.
 */
function stripCodeBlocks(text: string): string {
  return text.replace(/```[\s\S]*?```/g, '');
}

/**
 * Extract Finding objects from Claude's free-text analysis output.
 * Scans for lines matching the pattern: **[SEVERITY] Title**
 */
export function extractFindingsFromText(text: string): Finding[] {
  const findings: Finding[] = [];
  if (!text) return findings;

  // Strip code blocks to avoid extracting findings from Mermaid/SQL/code content
  const cleanText = stripCodeBlocks(text);

  SEVERITY_REGEX.lastIndex = 0;

  let match: RegExpExecArray | null;
  while ((match = SEVERITY_REGEX.exec(cleanText)) !== null) {
    const severity = SEVERITY_MAP[match[1]] ?? 'info';
    const title = match[2].replace(/\*+/g, '').trim();
    // Use cleanText for description/evidence extraction (code blocks already stripped)
    const afterTitle = cleanText.substring(match.index + match[0].length, match.index + match[0].length + 500);
    const evidence = extractEvidence(afterTitle);

    findings.push({
      id: `claude-${uuidv4().slice(0, 8)}`,
      severity,
      title: title.substring(0, 200),
      description: extractDescription(afterTitle) || title,
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

  const firstLine = text.split('\n').find(l => l.trim().length > 0);
  return firstLine?.trim().substring(0, 500) || '';
}

function extractEvidence(text: string): string | undefined {
  // Try explicit "证据:" or "Evidence:" label first
  const explicit = text.match(/(?:证据[：:]|Evidence:)\s*(.+?)(?=\n(?:建议|Suggestion|\*\*\[)|$)/s);
  if (explicit) return explicit[1].trim().substring(0, 500);

  // Also match "根因推理链:" format (used by strategy-compliant conclusions)
  const rootCause = text.match(/(?:根因推理链[：:]|根因[：:])\s*(.+?)(?=\n(?:建议|结论|Suggestion|\*\*\[)|$)/s);
  if (rootCause) return rootCause[1].trim().substring(0, 500);

  return undefined;
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
