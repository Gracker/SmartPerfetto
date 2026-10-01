// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import * as fs from 'fs';
import * as path from 'path';

import { backendLogPath } from '../../runtimePaths';
import type { CaseKnowledgeRecommendation } from '../../types/caseKnowledge';
import type { CaseFindingLink, CaseNode } from '../../types/sparkContracts';
import {
  CASE_APP_ARCHITECTURE_FIELD,
  detectedCaseArchitecture,
  validateCaseAppArchitecture,
} from '../caseArchitecture';
import { CaseLibrary } from '../caseLibrary';
import type { KnowledgeScope } from '../scopedKnowledgeStore';

export type CaseEvolutionPromotionTarget = 'reviewed' | 'published' | 'markdown';

export type PromoteCaseCandidateResult =
  | { ok: true; caseId: string; status: string; markdownPath?: string }
  | { ok: false; reason: 'not_found' | 'missing_reviewer' | 'io_error'; details?: string };

export type RetractCaseEvolutionCaseResult =
  | { ok: true; caseId: string; status: 'private' }
  | { ok: false; reason: 'not_found'; details?: string };

export interface PromoteCaseCandidateOptions {
  to: CaseEvolutionPromotionTarget;
  reviewer?: string;
  library?: CaseLibrary;
  knowledgeScope?: KnowledgeScope;
  markdownRoot?: string;
}

export interface RetractCaseEvolutionCaseOptions {
  library?: CaseLibrary;
  knowledgeScope?: KnowledgeScope;
  reason?: string;
  clock?: () => number;
}

export function promoteCaseCandidate(
  candidateId: string,
  opts: PromoteCaseCandidateOptions,
): PromoteCaseCandidateResult {
  const library = opts.library ?? new CaseLibrary(backendLogPath('case_library.json'));
  const caseNode = resolveLearnedCase(library, candidateId, opts.knowledgeScope);
  if (!caseNode) return { ok: false, reason: 'not_found', details: `candidate '${candidateId}' not found` };

  if (opts.to === 'reviewed') {
    const reviewed = { ...caseNode, status: 'reviewed' as const };
    library.saveCase(reviewed, opts.knowledgeScope);
    return { ok: true, caseId: reviewed.caseId, status: reviewed.status };
  }

  if (opts.to === 'published') {
    const reviewer = opts.reviewer?.trim();
    if (!reviewer) return { ok: false, reason: 'missing_reviewer' };
    const published = library.publishCase(caseNode.caseId, { reviewer }, opts.knowledgeScope);
    return { ok: true, caseId: published.caseId, status: published.status };
  }

  try {
    const markdownPath = writeCaseMarkdown(caseNode, opts.markdownRoot);
    return { ok: true, caseId: caseNode.caseId, status: caseNode.status, markdownPath };
  } catch (err) {
    return { ok: false, reason: 'io_error', details: err instanceof Error ? err.message : String(err) };
  }
}

export function retractCaseEvolutionCase(
  caseId: string,
  opts: RetractCaseEvolutionCaseOptions = {},
): RetractCaseEvolutionCaseResult {
  const library = opts.library ?? new CaseLibrary(backendLogPath('case_library.json'));
  const existing = library.getCase(caseId, opts.knowledgeScope);
  if (!existing) return { ok: false, reason: 'not_found', details: `case '${caseId}' not found` };
  const marker = existing.knowledge?.context?.['caseEvolution.v1'];
  const markerObject = marker && typeof marker === 'object' && !Array.isArray(marker)
    ? marker as Record<string, unknown>
    : {};
  const retracted: CaseNode = {
    ...existing,
    status: 'private',
    knowledge: existing.knowledge ? {
      ...existing.knowledge,
      context: {
        ...existing.knowledge.context,
        'caseEvolution.v1': {
          ...markerObject,
          retracted: true,
          retractedAt: opts.clock?.() ?? Date.now(),
          retractionReason: opts.reason?.trim() || 'manual retraction',
        },
      },
    } : existing.knowledge,
  };
  library.saveCase(retracted, opts.knowledgeScope);
  return { ok: true, caseId: retracted.caseId, status: 'private' };
}

function resolveLearnedCase(
  library: CaseLibrary,
  candidateId: string,
  scope?: KnowledgeScope,
): CaseNode | undefined {
  const direct = library.getCase(candidateId.startsWith('learned:') ? candidateId : `learned:${candidateId}`, scope);
  if (direct) return direct;
  return library.listCases({}, scope).find(caseNode => {
    const marker = caseNode.knowledge?.context?.['caseEvolution.v1'];
    return !!marker &&
      typeof marker === 'object' &&
      !Array.isArray(marker) &&
      (marker as Record<string, unknown>).candidateId === candidateId;
  });
}

function writeCaseMarkdown(caseNode: CaseNode, markdownRoot?: string): string {
  if (!caseNode.knowledge) throw new Error(`case '${caseNode.caseId}' has no knowledge payload`);
  // validate:cases requires at least one finding; refuse to emit a file that
  // would fail re-ingest rather than silently writing a broken case.
  if (caseNode.findings.length === 0) {
    throw new Error(`case '${caseNode.caseId}' has no findings; cannot emit validator-passing Markdown`);
  }
  const exportableContext = exportableCaseContext(caseNode.caseId, caseNode.knowledge.context);
  const root = markdownRoot ?? path.resolve(__dirname, '..', '..', '..', 'knowledge', 'cases');
  const dir = path.join(root, caseNode.knowledge.scene);
  fs.mkdirSync(dir, { recursive: true });
  const target = path.join(dir, `${caseNode.caseId}.md`);
  const fm = caseNode.knowledge;
  const markdown = [
    '---',
    `case_id: ${caseNode.caseId}`,
    `title: ${yamlString(caseNode.title)}`,
    `status: ${caseNode.status}`,
    'quality: imported',
    `scene: ${fm.scene}`,
    `domain_pack: ${fm.domainPack}`,
    ...(caseNode.curatedBy ? [`curator: ${yamlString(caseNode.curatedBy)}`] : []),
    `tags: [${caseNode.tags.map(yamlString).join(', ')}]`,
    'taxonomy:',
    `  primary_root_cause: ${fm.taxonomy.primary_root_cause}`,
    `  secondary_root_causes: [${fm.taxonomy.secondary_root_causes.map(yamlString).join(', ')}]`,
    `  responsibility: ${fm.taxonomy.responsibility}`,
    `  severity: ${fm.taxonomy.severity}`,
    'context:',
    ...Object.entries(exportableContext).map(
      ([key, value]) => `  ${yamlKey(key)}: ${yamlScalar(value)}`,
    ),
    'evidence_signatures:',
    '  required:',
    ...fm.evidenceSignatures.required.map(signature => `    - field: ${signature.field}\n      op: ${signature.op}\n      value: ${yamlScalar(signature.value)}`),
    '  supportive:',
    ...fm.evidenceSignatures.supportive.map(signature => `    - field: ${signature.field}\n      op: ${signature.op}\n      value: ${yamlScalar(signature.value)}`),
    'findings:',
    ...caseNode.findings.map(finding => `  - id: ${finding.id}\n    title: ${yamlString(finding.title)}\n    evidence_refs: ${findingEvidenceRefs(finding)}\n    confidence: ${severityToConfidence(finding.severity)}`),
    'recommendations:',
    '  app:',
    ...formatRecommendations(fm.recommendations.app),
    '  oem:',
    ...formatRecommendations(fm.recommendations.oem),
    'relations:',
    '  similar_root_cause: []',
    '  same_app: []',
    '  same_device: []',
    '  before_after_fix: []',
    '  derived_pattern: []',
    '  contradicts: []',
    '---',
    '',
    fm.body,
    '',
  ].join('\n');
  fs.writeFileSync(target, markdown, 'utf-8');
  return target;
}

/**
 * The context a curated Markdown case may carry. The caseEvolution.v1 marker is
 * a runtime-only audit artifact (candidateId, feedback counts); re-exported, the
 * curated path would inherit stale learned provenance on re-ingest. Cases
 * learned before the `app_architecture` contract stored the detected type under
 * `architectureType`; it is exported under the contract's field, and a case
 * with neither cannot pass `validate:cases`.
 */
function exportableCaseContext(caseId: string, context: Record<string, unknown>): Record<string, unknown> {
  const { 'caseEvolution.v1': _marker, architectureType: legacyArchitecture, ...rest } = context;
  const declared = validateCaseAppArchitecture(rest[CASE_APP_ARCHITECTURE_FIELD]).ok
    ? rest[CASE_APP_ARCHITECTURE_FIELD]
    : detectedCaseArchitecture(legacyArchitecture)[CASE_APP_ARCHITECTURE_FIELD];
  if (!declared) {
    throw new Error(`case '${caseId}' declares no ${CASE_APP_ARCHITECTURE_FIELD}; cannot emit validator-passing Markdown`);
  }
  return { ...rest, [CASE_APP_ARCHITECTURE_FIELD]: declared };
}

/** Quote a YAML mapping key so dotted runtime keys (e.g. caseEvolution.v1)
 * survive as a flat string key rather than a nested mapping. */
function yamlKey(key: string): string {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(key) ? key : JSON.stringify(key);
}

/** Render a scalar/array value as a YAML-safe inline token. Uses JSON for
 * anything that is not a bare scalar, which is valid YAML (JSON ⊂ YAML). */
function yamlScalar(value: unknown): string {
  if (typeof value === 'string') return yamlString(value);
  return JSON.stringify(value);
}

/** Recover the validator-facing confidence enum from a CaseFindingLink's
 * severity. Mirrors the severity→confidence mapping the projection uses in
 * reverse (critical→high, warning→medium, info→low). */
function severityToConfidence(severity: string | undefined): 'high' | 'medium' | 'low' {
  switch (severity) {
    case 'critical':
      return 'high';
    case 'warning':
      return 'medium';
    default:
      return 'low';
  }
}

/** Emit evidence_refs from a CaseFindingLink's evidence handle, falling back
 * to an empty array (which the validator accepts) when none are recorded. */
function findingEvidenceRefs(finding: CaseFindingLink): string {
  const externalRef = finding.evidence?.externalRef;
  if (typeof externalRef === 'string' && externalRef) {
    return `[${JSON.stringify(externalRef)}]`;
  }
  return '[]';
}

function formatRecommendations(items: CaseKnowledgeRecommendation[]): string[] {
  if (items.length === 0) return [];
  return items.map(item => [
    `    - id: ${item.id}`,
    `      priority: ${item.priority}`,
    `      action: ${yamlString(item.action)}`,
    `      applies_when: ${yamlString(item.applies_when)}`,
    `      risks: ${yamlString(item.risks)}`,
  ].join('\n'));
}

function yamlString(value: string): string {
  if (/^[a-zA-Z0-9_:. -]+$/.test(value)) return value;
  return JSON.stringify(value);
}
