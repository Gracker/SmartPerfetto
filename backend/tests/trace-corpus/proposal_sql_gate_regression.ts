// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)

import path from 'path';

import type {
  CurationProposalV1,
} from '../../src/types/selfEvolution';
import {canonicalContentHash} from '../../src/services/selfEvolution/canonicalJson';
import {
  createProposalCandidateMaterializationV1,
  proposalDraftContentHash,
} from '../../src/services/selfEvolution/proposalGateContract';
import {
  runManagedProposalSqlRegression,
} from '../../src/services/selfEvolution/proposalSqlRegression';
import {TraceProcessorService} from '../../src/services/traceProcessorService';

async function main(): Promise<void> {
  const repoRoot = path.resolve(__dirname, '../../..');
  const proposalId = 'proposal-sql-regression-smoke';
  const sql = 'SELECT 1 AS smoke_value';
  const gateAttemptId = 'proposal-sql-regression-smoke-attempt';
  const gatePolicyFingerprint = canonicalContentHash(
    'proposal-sql-regression-smoke-policy',
  );
  const proposal: CurationProposalV1 = {
    schemaVersion: 1,
    proposalId,
    revision: 1,
    idempotencyKey: canonicalContentHash(proposalId),
    kind: 'skill_sql',
    tier: 'T4',
    title: 'Trace SQL regression smoke',
    rationale: 'Exercise the managed bounded SQL proposal gate.',
    deltas: [{
      op: 'modify',
      targetKind: 'skill_overlay',
      targetId: 'android_kernel_wakelock_summary',
      operationId: 'wakelock_summary',
      anchor:
        'skills[id="android_kernel_wakelock_summary"].sql[stepId="wakelock_summary"]',
      baseContentHash: canonicalContentHash('wakelock-summary-base'),
      before: sql,
      after: sql,
    }],
    expectedRegistryFingerprint: canonicalContentHash('registry-smoke'),
    expectedOverlayGeneration: 'builtin:registry-smoke',
    evidence: {
      negativeRunIds: ['run-0', 'run-1', 'run-2'],
      positiveRunIds: ['run-3', 'run-4', 'run-5', 'run-6', 'run-7'],
      labeledCount: 8,
      negativeCount: 3,
      distinctTraceCount: 1,
      distinctSessionCount: 8,
      statisticalVerdict: 'hypothesis_only',
    },
    pairedGateVerdict: 'not_run',
    expectedEffect: 'Preserve the managed SQL contract.',
    riskLevel: 'high',
    status: 'draft',
    scope: {tenantId: 'local', workspaceId: 'local'},
    createdAt: '2026-07-29T00:00:00.000Z',
  };
  const draftContentHash = proposalDraftContentHash(proposal);
  const candidate = createProposalCandidateMaterializationV1({
    proposalId,
    proposalRevision: 1,
    draftContentHash,
    planContentHash: canonicalContentHash('sql-regression-plan'),
    artifactId: [
      'proposal',
      proposalId,
      1,
      draftContentHash,
      canonicalContentHash('sql-regression-plan'),
    ].join(':'),
    targetKind: 'skill_overlay',
    serializedContent: sql,
  });
  const uploadDir = path.join(
    repoRoot,
    'backend/uploads/proposal-sql-gate-regression',
  );
  const traceProcessorService = new TraceProcessorService(uploadDir);
  const initialTraceCount = traceProcessorService.getAllTraces().length;
  const proof = await runManagedProposalSqlRegression({
    proposal,
    candidate,
    baselineSql: proposal.deltas[0].before!,
    gateAttemptId,
    gateAttemptOrdinal: 1,
    gatePolicyFingerprint,
    repoRoot,
    uploadDir,
    traceProcessorService,
  });
  if (
    proof.verdict !== 'passed'
    || proof.cases.length !== 1
    || proof.cases[0].verdict !== 'passed'
  ) {
    throw new Error(
      `Proposal SQL gate regression failed: ${JSON.stringify(proof.cases)}`,
    );
  }
  if (traceProcessorService.getAllTraces().length !== initialTraceCount) {
    throw new Error('Proposal SQL gate leaked registered trace metadata');
  }
  console.log(
    `Proposal SQL gate regression passed: ${proof.cases[0].caseId}`,
  );
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
