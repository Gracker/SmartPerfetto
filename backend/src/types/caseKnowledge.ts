// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

/**
 * Curated Markdown case knowledge contract.
 *
 * Markdown files are the source of truth. Runtime stores consume this richer
 * payload through CaseNode.knowledge without changing the legacy CaseNode
 * browsing and publish-gate fields.
 */

export type CaseKnowledgeStatus = 'draft' | 'reviewed' | 'published' | 'private';
export type CaseKnowledgeQuality = 'curated' | 'imported' | 'weak';
export type CaseKnowledgeResponsibility = 'app' | 'oem' | 'mixed' | 'unknown';
export type CaseKnowledgeSeverity = 'critical' | 'warning' | 'info';
export type CaseKnowledgeRecommendationPriority = 'P0' | 'P1' | 'P2' | 'P3';
export type CaseEvidenceSignatureOperator = 'eq' | 'contains_any' | 'gte' | 'lte';
export type CaseKnowledgeMatchStrength = 'strong' | 'partial' | 'background';

/** Only cases a curator reviewed or published reach an analysis. */
export const CURATED_CASE_STATUSES: readonly CaseKnowledgeStatus[] = ['published', 'reviewed'];

/**
 * How recall and the case background order cases: higher first. (Markdown
 * ingest ranks statuses its own way to decide which copy wins a merge.)
 */
export function caseStatusRank(status: CaseKnowledgeStatus): number {
  return status === 'published' ? 3 : status === 'reviewed' ? 2 : status === 'draft' ? 1 : 0;
}

export function caseKnowledgeQualityRank(quality: CaseKnowledgeQuality | undefined): number {
  return quality === 'curated' ? 3 : quality === 'imported' ? 2 : quality === 'weak' ? 1 : 0;
}

export interface CaseKnowledgeValidationIssue {
  filePath: string;
  message: string;
  fieldPath?: string;
}

export interface ParsedCaseMarkdown {
  filePath: string;
  frontmatter: Record<string, unknown>;
  body: string;
}

export type CaseMarkdownParseResult =
  | {ok: true; parsed: ParsedCaseMarkdown}
  | {ok: false; issues: CaseKnowledgeValidationIssue[]};

export interface CaseEvidenceSignature {
  field: string;
  op: CaseEvidenceSignatureOperator;
  value: unknown;
}

export interface CaseKnowledgeFinding {
  id: string;
  title: string;
  evidence_refs: string[];
  confidence: 'low' | 'medium' | 'high';
}

export interface CaseKnowledgeRecommendation {
  id: string;
  priority: CaseKnowledgeRecommendationPriority;
  action: string;
  applies_when: string;
  risks: string;
}

export type CaseKnowledgeRelations = Record<string, string[]>;

export interface CaseKnowledgeFrontmatter {
  case_id: string;
  title: string;
  status: CaseKnowledgeStatus;
  quality: CaseKnowledgeQuality;
  scene: string;
  domain_pack: string;
  curator?: string;
  tags?: string[];
  taxonomy: {
    primary_root_cause: string;
    secondary_root_causes: string[];
    responsibility: CaseKnowledgeResponsibility;
    severity: CaseKnowledgeSeverity;
  };
  context: Record<string, unknown>;
  evidence_signatures: {
    required: CaseEvidenceSignature[];
    supportive: CaseEvidenceSignature[];
  };
  findings: CaseKnowledgeFinding[];
  recommendations: {
    app: CaseKnowledgeRecommendation[];
    oem: CaseKnowledgeRecommendation[];
  };
  relations: CaseKnowledgeRelations;
}

export interface ValidatedCaseKnowledgeFile {
  filePath: string;
  frontmatter: CaseKnowledgeFrontmatter;
  body: string;
}

export type CaseKnowledgeValidationResult =
  | {
      ok: true;
      cases: ValidatedCaseKnowledgeFile[];
      issues: [];
    }
  | {
      ok: false;
      cases: ValidatedCaseKnowledgeFile[];
      issues: CaseKnowledgeValidationIssue[];
    };

export interface CaseKnowledgeExtension {
  sourceFile: string;
  body: string;
  quality: CaseKnowledgeQuality;
  scene: string;
  domainPack: string;
  taxonomy: CaseKnowledgeFrontmatter['taxonomy'];
  context: Record<string, unknown>;
  evidenceSignatures: CaseKnowledgeFrontmatter['evidence_signatures'];
  recommendations: CaseKnowledgeFrontmatter['recommendations'];
}

/**
 * Structured case citation consumed by reports.
 *
 * Retrieval and evidence-signature matching decide which cases become hits.
 * The report renderer only displays this bounded projection and must treat
 * non-strong hits as context with an explicit evidence gap.
 */
export interface CaseKnowledgeReportRecommendation {
  caseId: string;
  title: string;
  scene?: string;
  primaryRootCause?: string;
  matchStrength: CaseKnowledgeMatchStrength;
  evidenceGap?: string;
  evidenceRefs?: string[];
  matchedSignatures?: string[];
  missingRequiredSignatures?: string[];
  recommendations: CaseKnowledgeFrontmatter['recommendations'];
  /**
   * Only on results from before learned cases were retired; kept so their
   * reports still show it. Nothing produces it any more.
   */
  learnedProvenance?: {
    candidateId: string;
    supportingEvidence: number;
    contradictingEvidence: number;
    supported: boolean;
  };
}
