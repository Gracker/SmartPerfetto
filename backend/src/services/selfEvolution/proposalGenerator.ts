// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {loadPromptTemplate, renderTemplate} from '../../agentv3/strategyLoader';
import type {
  CurationProposalV1,
  ProposalDelta,
} from '../../types/selfEvolution';
import {projectArtifact} from '../evolutionLifecycle/artifactProjection';
import {
  executeStructuredReview,
  type StructuredReviewExecutionResult,
} from '../evolutionLifecycle/reviewExecution';
import {canonicalContentHash, canonicalJsonString} from './canonicalJson';
import type {
  ProposalGeneratedBody,
  SelectedCurationCandidate,
} from './curationContracts';
import {sanitizeProposalData} from './proposalDataSanitizer';
import {parseM6DraftProposal} from './proposalContract';

const TEMPLATE_NAME = 'selfevolve-proposal';
const DEFAULT_MODEL = 'claude-haiku-4-5';
const DEFAULT_TIMEOUT_MS = 90_000;
const MAX_TURNS = 4;

export type ProposalBodyExecutor = (
  prompt: string,
) => Promise<StructuredReviewExecutionResult>;

export interface ProposalGenerationResult {
  ok: boolean;
  proposal?: CurationProposalV1;
  reason?:
    | 'input_rejected'
    | 'review_failed'
    | 'output_rejected'
    | 'template_missing';
  details?: string[];
  warnings: string[];
}

export function loadProposalTemplate(): {
  content: string;
  contentHash: string;
} | null {
  const content = loadPromptTemplate(TEMPLATE_NAME);
  return content
    ? {content, contentHash: canonicalContentHash(content)}
    : null;
}

export async function generateCurationProposal(input: {
  candidate: SelectedCurationCandidate;
  template?: string;
  execute?: ProposalBodyExecutor;
  now?: () => Date;
}): Promise<ProposalGenerationResult> {
  const template = input.template ?? loadPromptTemplate(TEMPLATE_NAME);
  if (!template) {
    return {
      ok: false,
      reason: 'template_missing',
      details: [`${TEMPLATE_NAME} prompt template not found`],
      warnings: [],
    };
  }
  if (canonicalContentHash(template) !== input.candidate.templateContentHash) {
    return {
      ok: false,
      reason: 'input_rejected',
      details: ['proposal template changed after candidate selection'],
      warnings: [],
    };
  }
  const sanitizedInput = sanitizeProposalData(input.candidate.promptData);
  if (!sanitizedInput.ok) {
    return {
      ok: false,
      reason: 'input_rejected',
      details: sanitizedInput.errors,
      warnings: sanitizedInput.warnings,
    };
  }
  const prompt = renderTemplate(template, {
    proposal_kind: input.candidate.kind,
    proposal_tier: input.candidate.tier,
    delta_operation: input.candidate.delta.op,
    curation_data_json: serializeUntrustedJson(sanitizedInput.value),
  });
  const execute = input.execute ?? (value => executeStructuredReview({
    prompt: value,
    logPrefix: 'SelfEvolutionProposalGenerator',
    defaultModel: DEFAULT_MODEL,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    maxTurns: MAX_TURNS,
  }));
  const reviewed = await execute(prompt);
  if (!reviewed.ok) {
    return {
      ok: false,
      reason: 'review_failed',
      details: [`${reviewed.reason}: ${reviewed.details}`],
      warnings: sanitizedInput.warnings,
    };
  }
  const projection = projectArtifact(reviewed.value, {
    validate(value) {
      const parsed = parseGeneratedBody(
        value,
        input.candidate.delta.afterMode,
      );
      return parsed.ok
        ? {ok: true as const, value: parsed.value}
        : {ok: false as const, errors: parsed.errors};
    },
    sanitize(value: ProposalGeneratedBody) {
      return sanitizeProposalData(value);
    },
    project(body: ProposalGeneratedBody) {
      try {
        return {
          ok: true as const,
          value: parseM6DraftProposal(buildProposal(
            input.candidate,
            body,
            input.now?.() ?? new Date(),
          )),
        };
      } catch (error) {
        return {
          ok: false as const,
          errors: [error instanceof Error ? error.message : String(error)],
        };
      }
    },
  });
  if (!projection.ok) {
    return {
      ok: false,
      reason: 'output_rejected',
      details: projection.errors,
      warnings: [...sanitizedInput.warnings, ...projection.warnings],
    };
  }
  return {
    ok: true,
    proposal: projection.artifact,
    warnings: [...sanitizedInput.warnings, ...projection.warnings],
  };
}

function serializeUntrustedJson(value: unknown): string {
  return canonicalJsonString(value).replace(
    /[<>&]/g,
    character => ({
      '<': '\\u003c',
      '>': '\\u003e',
      '&': '\\u0026',
    })[character]!,
  );
}

function buildProposal(
  candidate: SelectedCurationCandidate,
  body: ProposalGeneratedBody,
  now: Date,
): CurationProposalV1 {
  const {
    afterMode: _afterMode,
    ...structuralDelta
  } = candidate.delta;
  const delta: ProposalDelta = {
    ...structuralDelta,
    operationId: candidate.operationId,
    ...(candidate.delta.afterMode === 'generated'
      ? {after: body.after!}
      : {}),
  };
  return {
    schemaVersion: 1,
    proposalId: candidate.proposalId,
    revision: 1,
    idempotencyKey: candidate.idempotencyKey,
    kind: candidate.kind,
    tier: candidate.tier,
    title: body.title,
    rationale: body.rationale,
    deltas: [delta],
    expectedRegistryFingerprint:
      candidate.sourceState.expectedRegistryFingerprint,
    expectedOverlayGeneration:
      candidate.sourceState.expectedOverlayGeneration,
    evidence: {
      ...candidate.evidence,
      statisticalVerdict: 'hypothesis_only',
    },
    pairedGateVerdict: 'not_run',
    expectedEffect: body.expectedEffect,
    riskLevel: body.riskLevel,
    status: 'draft',
    scope: {...candidate.sourceState.scope},
    createdAt: now.toISOString(),
  };
}

function parseGeneratedBody(
  value: Record<string, unknown>,
  afterMode: 'generated' | 'none',
):
  | {ok: true; value: ProposalGeneratedBody}
  | {ok: false; errors: string[]} {
  const allowed = new Set([
    'title',
    'rationale',
    'after',
    'expectedEffect',
    'riskLevel',
  ]);
  const unknown = Object.keys(value).filter(key => !allowed.has(key));
  const errors: string[] = [];
  if (unknown.length > 0) {
    errors.push(`proposal body has unknown fields: ${unknown.sort().join(',')}`);
  }
  for (const field of ['title', 'rationale', 'expectedEffect'] as const) {
    if (
      typeof value[field] !== 'string' ||
      !(value[field] as string).trim()
    ) {
      errors.push(`${field} must be a non-empty string`);
    }
  }
  if (!['low', 'medium', 'high'].includes(String(value.riskLevel))) {
    errors.push('riskLevel must be low, medium, or high');
  }
  if (
    afterMode === 'generated' &&
    (typeof value.after !== 'string' || !value.after.trim())
  ) {
    errors.push('after must be a non-empty string');
  }
  if (afterMode === 'none' && value.after !== undefined) {
    errors.push('after is forbidden for remove proposals');
  }
  if (errors.length > 0) return {ok: false, errors};
  return {
    ok: true,
    value: {
      title: value.title as string,
      rationale: value.rationale as string,
      ...(afterMode === 'generated' ? {after: value.after as string} : {}),
      expectedEffect: value.expectedEffect as string,
      riskLevel: value.riskLevel as ProposalGeneratedBody['riskLevel'],
    },
  };
}

export const proposalGeneratorTesting = {
  TEMPLATE_NAME,
  DEFAULT_MODEL,
  DEFAULT_TIMEOUT_MS,
  MAX_TURNS,
  parseGeneratedBody,
};
