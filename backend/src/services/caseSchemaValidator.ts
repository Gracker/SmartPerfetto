// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import * as fs from 'fs';
import * as path from 'path';

import {CASE_APP_ARCHITECTURE_FIELD, validateCaseAppArchitecture} from './caseArchitecture';
import {parseCaseMarkdown} from './caseMarkdownParser';
import {validateCaseDomainPack} from './caseDomainPacks';
import {isRetiredCaseId} from './retiredCaseData';
import type {
  CaseEvidenceSignature,
  CaseEvidenceSignatureOperator,
  CaseKnowledgeFinding,
  CaseKnowledgeFrontmatter,
  CaseKnowledgeQuality,
  CaseKnowledgeRecommendation,
  CaseKnowledgeRecommendationPriority,
  CaseKnowledgeRelations,
  CaseKnowledgeResponsibility,
  CaseKnowledgeSeverity,
  CaseKnowledgeStatus,
  CaseKnowledgeValidationIssue,
  CaseKnowledgeValidationResult,
  ParsedCaseMarkdown,
  ValidatedCaseKnowledgeFile,
} from '../types/caseKnowledge';

const STATUSES = new Set<CaseKnowledgeStatus>([
  'draft',
  'reviewed',
  'published',
  'private',
]);
const QUALITIES = new Set<CaseKnowledgeQuality>(['curated', 'imported', 'weak']);
const RESPONSIBILITIES = new Set<CaseKnowledgeResponsibility>([
  'app',
  'oem',
  'mixed',
  'unknown',
]);
const SEVERITIES = new Set<CaseKnowledgeSeverity>([
  'critical',
  'warning',
  'info',
]);
const RECOMMENDATION_PRIORITIES = new Set<CaseKnowledgeRecommendationPriority>([
  'P0',
  'P1',
  'P2',
  'P3',
]);
const SIGNATURE_OPERATORS = new Set<CaseEvidenceSignatureOperator>([
  'eq',
  'contains_any',
  'gte',
  'lte',
]);
const REQUIRED_RELATIONS = [
  'similar_root_cause',
  'same_app',
  'same_device',
  'before_after_fix',
  'derived_pattern',
  'contradicts',
] as const;

export function validateCaseKnowledgeFiles(
  casesDir: string,
): CaseKnowledgeValidationResult {
  const parsed: ParsedCaseMarkdown[] = [];
  const issues: CaseKnowledgeValidationIssue[] = [];
  for (const filePath of listMarkdownFiles(casesDir)) {
    const result = parseCaseMarkdown(filePath, fs.readFileSync(filePath, 'utf-8'));
    if (result.ok) {
      parsed.push(result.parsed);
    } else {
      issues.push(...result.issues);
    }
  }
  const schemaResult = validateParsedCaseFiles(parsed);
  return combineResults(schemaResult, issues);
}

export function validateParsedCaseFiles(
  parsedFiles: ParsedCaseMarkdown[],
): CaseKnowledgeValidationResult {
  const cases: ValidatedCaseKnowledgeFile[] = [];
  const issues: CaseKnowledgeValidationIssue[] = [];
  const seenCaseIds = new Map<string, string>();

  for (const parsed of parsedFiles) {
    const normalized = normalizeFrontmatter(parsed);
    if (normalized.ok) {
      const existingPath = seenCaseIds.get(normalized.frontmatter.case_id);
      if (existingPath) {
        issues.push(
          issue(
            parsed.filePath,
            `duplicate case_id '${normalized.frontmatter.case_id}' also used by ${existingPath}`,
            'case_id',
          ),
        );
      } else {
        seenCaseIds.set(normalized.frontmatter.case_id, parsed.filePath);
      }
      issues.push(
        ...validateCaseDomainPack(normalized.frontmatter, parsed.filePath),
      );
      cases.push({
        filePath: parsed.filePath,
        frontmatter: normalized.frontmatter,
        body: parsed.body,
      });
    } else {
      issues.push(...normalized.issues);
    }
  }

  if (issues.length > 0) {
    return {ok: false, cases, issues};
  }
  return {ok: true, cases, issues: []};
}

function normalizeFrontmatter(
  parsed: ParsedCaseMarkdown,
):
  | {ok: true; frontmatter: CaseKnowledgeFrontmatter}
  | {ok: false; issues: CaseKnowledgeValidationIssue[]} {
  const raw = parsed.frontmatter;
  const issues: CaseKnowledgeValidationIssue[] = [];

  const caseId = stringField(raw, 'case_id', parsed.filePath, issues);
  // A learned case exported to Markdown keeps its retired id; importing it
  // would launder it into a curated case.
  if (caseId && isRetiredCaseId(caseId)) {
    issues.push(issue(parsed.filePath,
      `case_id '${caseId}' uses the prefix of the retired learned cases; give the case an ordinary id`, 'case_id'));
  }
  const title = stringField(raw, 'title', parsed.filePath, issues);
  const status = enumField(
    raw,
    'status',
    STATUSES,
    parsed.filePath,
    issues,
  ) as CaseKnowledgeStatus | undefined;
  const quality = enumField(
    raw,
    'quality',
    QUALITIES,
    parsed.filePath,
    issues,
  ) as CaseKnowledgeQuality | undefined;
  const scene = stringField(raw, 'scene', parsed.filePath, issues);
  const domainPack = stringField(raw, 'domain_pack', parsed.filePath, issues);
  const curator = optionalStringField(raw, 'curator', parsed.filePath, issues);
  const taxonomy = normalizeTaxonomy(raw.taxonomy, parsed.filePath, issues);
  const context = recordField(raw, 'context', parsed.filePath, issues);
  if (context) {
    const architecture = validateCaseAppArchitecture(context[CASE_APP_ARCHITECTURE_FIELD]);
    if (!architecture.ok) {
      issues.push(issue(
        parsed.filePath,
        architecture.message,
        `context.${CASE_APP_ARCHITECTURE_FIELD}`,
      ));
    }
  }
  const evidenceSignatures = normalizeEvidenceSignatures(
    raw.evidence_signatures,
    parsed.filePath,
    issues,
  );
  const findings = normalizeFindings(raw.findings, parsed.filePath, issues);
  const recommendations = normalizeRecommendations(
    raw.recommendations,
    parsed.filePath,
    issues,
  );
  const relations = normalizeRelations(raw.relations, parsed.filePath, issues);
  const tags = optionalStringArrayField(raw, 'tags', parsed.filePath, issues);

  if (status === 'published' && !curator) {
    issues.push(
      issue(
        parsed.filePath,
        "status 'published' requires non-empty curator",
        'curator',
      ),
    );
  }

  if (
    issues.length > 0 ||
    !caseId ||
    !title ||
    !status ||
    !quality ||
    !scene ||
    !domainPack ||
    !taxonomy ||
    !context ||
    !evidenceSignatures ||
    !findings ||
    !recommendations ||
    !relations
  ) {
    return {ok: false, issues};
  }

  return {
    ok: true,
    frontmatter: {
      case_id: caseId,
      title,
      status,
      quality,
      scene,
      domain_pack: domainPack,
      ...(curator ? {curator} : {}),
      ...(tags ? {tags} : {}),
      taxonomy,
      context,
      evidence_signatures: evidenceSignatures,
      findings,
      recommendations,
      relations,
    },
  };
}

function normalizeTaxonomy(
  value: unknown,
  filePath: string,
  issues: CaseKnowledgeValidationIssue[],
): CaseKnowledgeFrontmatter['taxonomy'] | undefined {
  if (!isRecord(value)) {
    issues.push(issue(filePath, 'taxonomy must be an object', 'taxonomy'));
    return undefined;
  }
  const primary = stringField(value, 'primary_root_cause', filePath, issues, 'taxonomy.primary_root_cause');
  const secondary = stringArrayField(value, 'secondary_root_causes', filePath, issues, 'taxonomy.secondary_root_causes');
  const responsibility = enumField(
    value,
    'responsibility',
    RESPONSIBILITIES,
    filePath,
    issues,
    'taxonomy.responsibility',
  ) as CaseKnowledgeResponsibility | undefined;
  const severity = enumField(
    value,
    'severity',
    SEVERITIES,
    filePath,
    issues,
    'taxonomy.severity',
  ) as CaseKnowledgeSeverity | undefined;
  if (!primary || !secondary || !responsibility || !severity) return undefined;
  return {
    primary_root_cause: primary,
    secondary_root_causes: secondary,
    responsibility,
    severity,
  };
}

function normalizeEvidenceSignatures(
  value: unknown,
  filePath: string,
  issues: CaseKnowledgeValidationIssue[],
): CaseKnowledgeFrontmatter['evidence_signatures'] | undefined {
  if (!isRecord(value)) {
    issues.push(
      issue(
        filePath,
        'evidence_signatures must be an object',
        'evidence_signatures',
      ),
    );
    return undefined;
  }
  const required = normalizeSignatureArray(
    value.required,
    filePath,
    issues,
    'evidence_signatures.required',
  );
  const supportive = normalizeSignatureArray(
    value.supportive ?? [],
    filePath,
    issues,
    'evidence_signatures.supportive',
  );
  if (!required || !supportive) return undefined;
  if (required.length === 0) {
    issues.push(
      issue(
        filePath,
        'evidence_signatures.required must contain at least one signature',
        'evidence_signatures.required',
      ),
    );
  }
  return {required, supportive};
}

function normalizeSignatureArray(
  value: unknown,
  filePath: string,
  issues: CaseKnowledgeValidationIssue[],
  fieldPath: string,
): CaseEvidenceSignature[] | undefined {
  if (!Array.isArray(value)) {
    issues.push(issue(filePath, `${fieldPath} must be an array`, fieldPath));
    return undefined;
  }
  const signatures: CaseEvidenceSignature[] = [];
  value.forEach((entry, index) => {
    const entryPath = `${fieldPath}[${index}]`;
    if (!isRecord(entry)) {
      issues.push(issue(filePath, `${entryPath} must be an object`, entryPath));
      return;
    }
    const field = stringField(entry, 'field', filePath, issues, `${entryPath}.field`);
    const op = enumField(
      entry,
      'op',
      SIGNATURE_OPERATORS,
      filePath,
      issues,
      `${entryPath}.op`,
    ) as CaseEvidenceSignatureOperator | undefined;
    if (field && op && Object.prototype.hasOwnProperty.call(entry, 'value')) {
      signatures.push({field, op, value: entry.value});
    } else if (!Object.prototype.hasOwnProperty.call(entry, 'value')) {
      issues.push(issue(filePath, `${entryPath}.value is required`, `${entryPath}.value`));
    }
  });
  return signatures;
}

function normalizeFindings(
  value: unknown,
  filePath: string,
  issues: CaseKnowledgeValidationIssue[],
): CaseKnowledgeFinding[] | undefined {
  if (!Array.isArray(value)) {
    issues.push(issue(filePath, 'findings must be an array', 'findings'));
    return undefined;
  }
  if (value.length === 0) {
    issues.push(
      issue(filePath, 'findings must contain at least one item', 'findings'),
    );
  }
  const findings: CaseKnowledgeFinding[] = [];
  value.forEach((entry, index) => {
    const entryPath = `findings[${index}]`;
    if (!isRecord(entry)) {
      issues.push(issue(filePath, `${entryPath} must be an object`, entryPath));
      return;
    }
    const id = stringField(entry, 'id', filePath, issues, `${entryPath}.id`);
    const title = stringField(entry, 'title', filePath, issues, `${entryPath}.title`);
    let evidenceRefs: string[] = [];
    if (!Array.isArray(entry.evidence_refs)) {
      issues.push(
        issue(filePath, `${entryPath}.evidence_refs must be an array`, `${entryPath}.evidence_refs`),
      );
    } else if (!entry.evidence_refs.every(item => typeof item === 'string')) {
      issues.push(
        issue(
          filePath,
          `${entryPath}.evidence_refs must be an array of strings`,
          `${entryPath}.evidence_refs`,
        ),
      );
    } else {
      evidenceRefs = [...entry.evidence_refs];
    }
    const confidence = enumField(
      entry,
      'confidence',
      new Set(['low', 'medium', 'high']),
      filePath,
      issues,
      `${entryPath}.confidence`,
    ) as CaseKnowledgeFinding['confidence'] | undefined;
    if (id && title && confidence) {
      findings.push({id, title, evidence_refs: evidenceRefs, confidence});
    }
  });
  return findings;
}

function normalizeRecommendations(
  value: unknown,
  filePath: string,
  issues: CaseKnowledgeValidationIssue[],
): CaseKnowledgeFrontmatter['recommendations'] | undefined {
  if (!isRecord(value)) {
    issues.push(
      issue(filePath, 'recommendations must be an object', 'recommendations'),
    );
    return undefined;
  }
  const app = normalizeRecommendationArray(value.app, filePath, issues, 'recommendations.app');
  const oem = normalizeRecommendationArray(value.oem, filePath, issues, 'recommendations.oem');
  if (!app || !oem) return undefined;
  return {app, oem};
}

function normalizeRecommendationArray(
  value: unknown,
  filePath: string,
  issues: CaseKnowledgeValidationIssue[],
  fieldPath: string,
): CaseKnowledgeRecommendation[] | undefined {
  if (!Array.isArray(value)) {
    issues.push(issue(filePath, `${fieldPath} must be an array`, fieldPath));
    return undefined;
  }
  if (value.length === 0) {
    issues.push(
      issue(filePath, `${fieldPath} must contain at least one item`, fieldPath),
    );
  }
  const recommendations: CaseKnowledgeRecommendation[] = [];
  value.forEach((entry, index) => {
    const entryPath = `${fieldPath}[${index}]`;
    if (!isRecord(entry)) {
      issues.push(issue(filePath, `${entryPath} must be an object`, entryPath));
      return;
    }
    const id = stringField(entry, 'id', filePath, issues, `${entryPath}.id`);
    const priority = enumField(
      entry,
      'priority',
      RECOMMENDATION_PRIORITIES,
      filePath,
      issues,
      `${entryPath}.priority`,
    ) as CaseKnowledgeRecommendationPriority | undefined;
    const action = stringField(entry, 'action', filePath, issues, `${entryPath}.action`);
    const appliesWhen = stringField(entry, 'applies_when', filePath, issues, `${entryPath}.applies_when`);
    const risks = stringField(entry, 'risks', filePath, issues, `${entryPath}.risks`);
    if (id && priority && action && appliesWhen && risks) {
      recommendations.push({
        id,
        priority,
        action,
        applies_when: appliesWhen,
        risks,
      });
    }
  });
  return recommendations;
}

function normalizeRelations(
  value: unknown,
  filePath: string,
  issues: CaseKnowledgeValidationIssue[],
): CaseKnowledgeRelations | undefined {
  if (!isRecord(value)) {
    issues.push(issue(filePath, 'relations must be an object', 'relations'));
    return undefined;
  }
  const relations: CaseKnowledgeRelations = {};
  for (const relation of REQUIRED_RELATIONS) {
    relations[relation] = stringArrayField(
      value,
      relation,
      filePath,
      issues,
      `relations.${relation}`,
    ) ?? [];
  }
  for (const [relation, targets] of Object.entries(value)) {
    if (REQUIRED_RELATIONS.includes(relation as (typeof REQUIRED_RELATIONS)[number])) {
      continue;
    }
    if (!Array.isArray(targets) || !targets.every(item => typeof item === 'string')) {
      issues.push(
        issue(
          filePath,
          `relations.${relation} must be an array of strings`,
          `relations.${relation}`,
        ),
      );
      continue;
    }
    relations[relation] = [...targets];
  }
  for (const [relation, targets] of Object.entries(relations)) {
    for (const target of targets.filter(isRetiredCaseId)) {
      issues.push(issue(filePath,
        `relations.${relation} links the retired learned case '${target}'; remove the link`, `relations.${relation}`));
    }
  }
  return relations;
}

function stringField(
  raw: Record<string, unknown>,
  key: string,
  filePath: string,
  issues: CaseKnowledgeValidationIssue[],
  fieldPath = key,
): string | undefined {
  const value = raw[key];
  if (typeof value !== 'string' || value.trim().length === 0) {
    issues.push(issue(filePath, `${fieldPath} is required`, fieldPath));
    return undefined;
  }
  return value.trim();
}

function optionalStringField(
  raw: Record<string, unknown>,
  key: string,
  filePath: string,
  issues: CaseKnowledgeValidationIssue[],
): string | undefined {
  const value = raw[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') {
    issues.push(issue(filePath, `${key} must be a string`, key));
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function enumField<T extends string>(
  raw: Record<string, unknown>,
  key: string,
  allowed: ReadonlySet<T>,
  filePath: string,
  issues: CaseKnowledgeValidationIssue[],
  fieldPath = key,
): T | undefined {
  const value = raw[key];
  if (typeof value !== 'string' || !allowed.has(value as T)) {
    issues.push(
      issue(
        filePath,
        `${fieldPath} must be one of: ${Array.from(allowed).join(', ')}`,
        fieldPath,
      ),
    );
    return undefined;
  }
  return value as T;
}

function stringArrayField(
  raw: Record<string, unknown>,
  key: string,
  filePath: string,
  issues: CaseKnowledgeValidationIssue[],
  fieldPath = key,
): string[] | undefined {
  const value = raw[key];
  if (!Array.isArray(value) || !value.every(item => typeof item === 'string')) {
    issues.push(issue(filePath, `${fieldPath} must be an array of strings`, fieldPath));
    return undefined;
  }
  return [...value];
}

function optionalStringArrayField(
  raw: Record<string, unknown>,
  key: string,
  filePath: string,
  issues: CaseKnowledgeValidationIssue[],
): string[] | undefined {
  const value = raw[key];
  if (value === undefined || value === null) return undefined;
  return stringArrayField(raw, key, filePath, issues);
}

function recordField(
  raw: Record<string, unknown>,
  key: string,
  filePath: string,
  issues: CaseKnowledgeValidationIssue[],
): Record<string, unknown> | undefined {
  const value = raw[key];
  if (!isRecord(value)) {
    issues.push(issue(filePath, `${key} must be an object`, key));
    return undefined;
  }
  return {...value};
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function listMarkdownFiles(rootDir: string): string[] {
  if (!fs.existsSync(rootDir)) return [];
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (entry.isFile() && /\.md$/i.test(entry.name)) {
        out.push(fullPath);
      }
    }
  };
  walk(rootDir);
  out.sort();
  return out;
}

function combineResults(
  schemaResult: CaseKnowledgeValidationResult,
  parseIssues: CaseKnowledgeValidationIssue[],
): CaseKnowledgeValidationResult {
  const issues = [...parseIssues, ...schemaResult.issues];
  if (issues.length > 0) {
    return {ok: false, cases: schemaResult.cases, issues};
  }
  return schemaResult;
}

function issue(
  filePath: string,
  message: string,
  fieldPath?: string,
): CaseKnowledgeValidationIssue {
  return {filePath, message, fieldPath};
}
