// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {describe, expect, it} from '@jest/globals';
import express from 'express';
import request from 'supertest';

import {authenticate} from '../../middleware/auth';
import type {ExternalIssueSourceRun} from '../../services/externalIssueReporting/sourceRunResolver';
import type {
  ExternalIssueProviderPinResolution,
} from '../../services/externalIssueReporting/providerPin';
import type {AnalysisReceiptV2} from '../../types/dataContract';
import type {RunManifestV1} from '../../types/selfEvolution';
import {registerAgentExternalIssueRoutes} from '../agentExternalIssueRoutes';

function source(
  manifestOverrides: Partial<RunManifestV1> = {},
): ExternalIssueSourceRun {
  const receipt: AnalysisReceiptV2 = {
    schemaVersion: 2,
    runId: 'run-1',
    sessionId: 'session-1',
    traceId: 'trace-1',
    mode: 'full',
    resolvedMode: 'full',
    runtime: 'openai-agents-sdk',
    providerId: null,
    generatedAt: 1,
    runManifestId: 'manifest-1',
    traceEvidence: {
      sqlCount: 1,
      skillCount: 1,
      dataEnvelopeCount: 1,
      artifactCount: 0,
      evidenceRefCount: 0,
    },
    nonEvidenceContext: {
      frontendPrequeryCount: 0,
      memoryHintCount: 0,
      conversationContextCount: 0,
      strategyHintCount: 0,
    },
    claimAudit: {
      totalClaims: 0,
      verifiedClaims: 0,
      unsupportedClaims: 0,
      uncertainClaims: 0,
    },
    qualityGates: {
      finalReportContract: 'passed',
      claimVerification: 'passed',
      identityResolution: 'passed',
    },
    outputs: {},
  };
  const manifest: RunManifestV1 = {
    schemaVersion: 1,
    runManifestId: 'manifest-1',
    runId: 'run-1',
    sessionId: 'session-1',
    sealedAt: 1,
    scope: {
      tenantId: 'default-dev-tenant',
      workspaceId: 'default-workspace',
    },
    actor: {userId: 'dev-user-123'},
    sceneType: 'scrolling',
    promptTemplateHashes: [],
    skills: [{
      skillId: 'scrolling_analysis',
      version: '1',
      contentFingerprint: 'hash',
      origin: 'built_in',
      appliedOverlayIds: [],
      invocations: 1,
      okCount: 0,
      emptyResultCount: 0,
      errorCount: 1,
    }],
    skillRegistryFingerprint: 'registry',
    evolutionOverlayGeneration: 'builtin:registry',
    sqlStatementCount: 1,
    sqlErrorCount: 0,
    runtime: 'openai-agents-sdk',
    providerId: null,
    providerSnapshotHash: 'historical-provider-hash',
    outputLanguage: 'en',
    toolAllowlistHash: 'tools',
    featureFlagSnapshot: {},
    analysisMode: 'full',
    resolvedMode: 'full',
    capabilityFlags: [],
    injections: {
      patterns: [],
      skillNotes: [],
      cases: [],
      phaseHints: [],
      knowledgeDocs: [],
    },
    turns: 1,
    wallclockMs: 100,
    ...manifestOverrides,
  };
  return {
    receipt,
    manifest,
    completedData: {analysisReceipt: receipt, findings: []},
    completedEvent: {
      cursor: 1,
      eventType: 'analysis_completed',
      eventData: '{}',
      createdAt: 1,
    },
    privateAnalysis: false,
    userReportedInaccuracy: false,
  };
}

function makeApp(options: {
  privateAnalysis?: boolean;
  wrongOwner?: boolean;
  manifestOverrides?: Partial<RunManifestV1>;
  useRealTriage?: boolean;
  pinResolution?: ExternalIssueProviderPinResolution;
} = {}) {
  const router = express.Router();
  const run = source(options.manifestOverrides);
  registerAgentExternalIssueRoutes(router, {
    getSessionOwner: () => options.wrongOwner
      ? {
          tenantId: 'other-tenant',
          workspaceId: 'default-workspace',
          userId: 'dev-user-123',
        }
      : {
          tenantId: 'default-dev-tenant',
          workspaceId: 'default-workspace',
          userId: 'dev-user-123',
        },
    resolveSourceRun: () => options.privateAnalysis
      ? {
          ok: false,
          code: 'private_analysis',
          message: 'private analysis',
        }
      : {ok: true, source: run},
    resolveProviderPin: manifest => options.pinResolution ??
      (manifest.providerSnapshotHash
        ? {
            ok: true,
            providerId: manifest.providerId,
            runtime: manifest.runtime === 'claude-agent-sdk'
              ? 'claude-agent-sdk'
              : 'openai-agents-sdk',
            model: 'test-light-model',
          }
        : {ok: false, reason: 'legacy_provider_pin_missing'}),
    ...(options.useRealTriage
      ? {}
      : {
          runTriage: async ({opportunity}) => {
            const signal = opportunity.signals.find(
              item => item.kind === 'skill_error',
            )!;
            return {
              ok: true as const,
              model: 'test-light-model',
              value: {
                candidates: [{
                  candidateId: 'candidate-1',
                  decision: 'needs_user_input',
                  ownership: 'skill',
                  contributionKind: 'skill_improvement',
                  confidence: 'medium',
                  title: 'Scrolling skill failed',
                  agentAssessment:
                    'The run recorded a concrete skill failure.',
                  basisSignalIds: [signal.signalId],
                  references: {
                    claimIds: [],
                    findingIds: [],
                    evidenceRefIds: [],
                    skillIds: ['scrolling_analysis'],
                  },
                  missingEvidence: ['Reproduction steps'],
                  userQuestions: [{
                    questionId: 'repro-1',
                    prompt: 'How can this be reproduced?',
                    required: true,
                  }],
                  draftSeed: {
                    problemStatement: 'The Skill failed during analysis.',
                    expectedBehavior: 'The Skill should return a result.',
                    reproductionHint: 'Run the scrolling analysis.',
                    suggestedContribution:
                      'Contribute a minimal Skill fixture.',
                  },
                }],
              },
            };
          },
        }),
  });
  const app = express();
  app.use(express.json());
  app.use(authenticate);
  app.use('/api/agent/v1', router);
  return app;
}

const refs = {
  runId: 'run-1',
  runManifestId: 'manifest-1',
};

describe('Agent external issue routes', () => {
  it('runs Agent triage and creates only a user-confirmed GitHub draft', async () => {
    const app = makeApp();
    const opportunity = await request(app)
      .post('/api/agent/v1/session-1/external-issue/opportunity')
      .send(refs);
    expect(opportunity.status).toBe(200);
    expect(opportunity.body.opportunity.status).toBe('available');

    const review = await request(app)
      .post('/api/agent/v1/session-1/external-issue/review')
      .send(refs);
    expect(review.status).toBe(200);
    expect(review.body.review.source).toBe('agent');
    expect(review.body.review.serverAttestation)
      .toMatch(/^smartperfetto\.external-issue-review\./);
    expect(review.body.review.candidates[0].contributionKind)
      .toBe('skill_improvement');

    const draft = await request(app)
      .post('/api/agent/v1/session-1/external-issue/draft')
      .send({
        ...refs,
        review: review.body.review,
        candidateId: 'candidate-1',
        answers: [{
          questionId: 'repro-1',
          answer: 'Run scrolling analysis with the same selected range.',
        }],
        sensitiveDataReviewed: true,
      });
    expect(draft.status).toBe(200);
    expect(draft.body.draft.notSubmitted).toBe(true);
    expect(draft.body.draft.githubUrl).toContain('github.com');
  });

  it('fails closed for private analysis and cross-owner access', async () => {
    const privateResult = await request(makeApp({privateAnalysis: true}))
      .post('/api/agent/v1/session-1/external-issue/opportunity')
      .send(refs);
    expect(privateResult.status).toBe(200);
    expect(privateResult.body.opportunity).toEqual(expect.objectContaining({
      status: 'disabled',
      agentReviewUnavailableReason: 'private_analysis',
    }));

    const wrongOwner = await request(makeApp({wrongOwner: true}))
      .post('/api/agent/v1/session-1/external-issue/opportunity')
      .send(refs);
    expect(wrongOwner.status).toBe(404);
  });

  it('routes security-sensitive feedback away from public GitHub issues', async () => {
    const response = await request(makeApp())
      .post('/api/agent/v1/session-1/external-issue/draft')
      .send({...refs, securitySensitive: true});
    expect(response.status).toBe(409);
    expect(response.body.code).toBe('PRIVATE_SECURITY_ADVISORY_REQUIRED');
  });

  it('exposes Provider pin mismatch and uses deterministic review fallback', async () => {
    const app = makeApp({
      pinResolution: {ok: false, reason: 'provider_snapshot_changed'},
      useRealTriage: true,
    });
    const opportunity = await request(app)
      .post('/api/agent/v1/session-1/external-issue/opportunity')
      .send(refs);
    expect(opportunity.status).toBe(200);
    expect(opportunity.body.opportunity).toEqual(expect.objectContaining({
      status: 'available',
      agentReviewAvailable: false,
      agentReviewUnavailableReason: 'provider_snapshot_changed',
    }));

    const review = await request(app)
      .post('/api/agent/v1/session-1/external-issue/review')
      .send(refs);
    expect(review.status).toBe(200);
    expect(review.body.review).toEqual(expect.objectContaining({
      source: 'deterministic_fallback',
      fallbackReason: 'provider_snapshot_changed',
    }));
    expect(review.body.review.serverAttestation)
      .toMatch(/^smartperfetto\.external-issue-review\./);
  });

  it('fails legacy runs closed when the persisted Provider pin is missing', async () => {
    const app = makeApp({
      manifestOverrides: {providerSnapshotHash: undefined},
      useRealTriage: true,
    });
    const opportunity = await request(app)
      .post('/api/agent/v1/session-1/external-issue/opportunity')
      .send(refs);
    expect(opportunity.status).toBe(200);
    expect(opportunity.body.opportunity).toEqual(expect.objectContaining({
      status: 'available',
      agentReviewAvailable: false,
      agentReviewUnavailableReason: 'legacy_provider_pin_missing',
    }));
  });

  it('rejects forged or altered reviews and rechecks the Provider pin for drafts', async () => {
    const app = makeApp();
    const review = await request(app)
      .post('/api/agent/v1/session-1/external-issue/review')
      .send(refs);
    expect(review.status).toBe(200);

    const altered = structuredClone(review.body.review);
    altered.candidates[0].title = 'Client-forged title';
    const alteredDraft = await request(app)
      .post('/api/agent/v1/session-1/external-issue/draft')
      .send({
        ...refs,
        review: altered,
        candidateId: 'candidate-1',
        answers: [{
          questionId: 'repro-1',
          answer: 'Run the same scrolling analysis.',
        }],
        sensitiveDataReviewed: true,
      });
    expect(alteredDraft.status).toBe(400);
    expect(alteredDraft.body.code)
      .toBe('EXTERNAL_ISSUE_REVIEW_ATTESTATION_INVALID');

    const changedProvider = makeApp({
      pinResolution: {ok: false, reason: 'provider_snapshot_changed'},
    });
    const staleDraft = await request(changedProvider)
      .post('/api/agent/v1/session-1/external-issue/draft')
      .send({
        ...refs,
        review: review.body.review,
        candidateId: 'candidate-1',
        answers: [{
          questionId: 'repro-1',
          answer: 'Run the same scrolling analysis.',
        }],
        sensitiveDataReviewed: true,
      });
    expect(staleDraft.status).toBe(409);
    expect(staleDraft.body.code)
      .toBe('EXTERNAL_ISSUE_AGENT_REVIEW_UNAVAILABLE');
  });
});
