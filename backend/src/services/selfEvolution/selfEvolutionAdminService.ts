// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {randomUUID} from 'crypto';

import type {
  AppliedProposalRevisionV1,
  ContributionBundleArtifactV1,
  CurationProposalV1,
  EvolutionOverlayRegistryEntryV1,
  RunManifestScope,
  SelfEvolutionLifecycleSnapshot,
  UpgradeReconciliationReportV1,
} from '../../types/selfEvolution';
import type {
  EvolutionGenerationHeadV1,
} from './evolutionOverlayRegistry';

const MAX_OPERATIONS = 100;
const MAX_OPERATIONS_PER_SCOPE = 20;
const MAX_RUNNING_OPERATIONS_PER_SCOPE = 4;
const MAX_EVENTS_PER_OPERATION = 64;
const TERMINAL_OPERATION_TTL_MS = 15 * 60 * 1000;
const OPERATION_TIMEOUT_MS = 5 * 60 * 1000;

export type SelfEvolutionOperationStage =
  | 'queued'
  | 'loading_feedback'
  | 'curating'
  | 'completed'
  | 'failed';

export interface SelfEvolutionOperationEvent {
  sequence: number;
  type: 'started' | 'progress' | 'completed' | 'failed';
  stage: SelfEvolutionOperationStage;
  message: string;
  createdAt: number;
  proposalId?: string;
  diagnosticCodes?: string[];
  errorCode?: string;
}

export interface SelfEvolutionOperationSnapshot {
  operationId: string;
  scope: RunManifestScope;
  kind: 'curation';
  state: 'running' | 'completed' | 'failed';
  events: SelfEvolutionOperationEvent[];
  createdAt: number;
  completedAt?: number;
}

export interface SelfEvolutionAdminOverview {
  collectedAt: number;
  config: SelfEvolutionLifecycleSnapshot['effectiveConfig'];
  requestedConfig: SelfEvolutionLifecycleSnapshot['requestedConfig'];
  persistence: SelfEvolutionLifecycleSnapshot['persistence'];
  proposalCounts: Record<CurationProposalV1['status'], number>;
  overlayCounts: {
    total: number;
    effective: number;
    byActivationState:
      Record<EvolutionOverlayRegistryEntryV1['activationState'], number>;
    byValidationState:
      Record<EvolutionOverlayRegistryEntryV1['validationState'], number>;
  };
  generationHead: EvolutionGenerationHeadV1 | null;
  latestReconciliation: UpgradeReconciliationReportV1 | null;
  operations: {
    running: number;
    retained: number;
  };
  l2Judge: {
    status: 'not_configured';
    reason: 'explicit_external_judge_consent_required';
  };
  warnings: Array<{code: string; message: string}>;
  errors: Array<{code: string; message: string}>;
}

export interface SelfEvolutionProposalDetail {
  proposal: CurationProposalV1;
  latestGateAttempt: unknown | null;
  appliedRevisions: AppliedProposalRevisionV1[];
}

export interface SelfEvolutionAdminDependencies {
  lifecycle(): SelfEvolutionLifecycleSnapshot;
  listProposals(scope: RunManifestScope): CurationProposalV1[];
  getProposal(scope: RunManifestScope, proposalId: string):
    CurationProposalV1 | undefined;
  latestGateAttempt(scope: RunManifestScope, proposalId: string):
    unknown | undefined;
  listAppliedRevisions(proposalId: string): AppliedProposalRevisionV1[];
  listOverlays(scope: RunManifestScope): EvolutionOverlayRegistryEntryV1[];
  generationHead(scope: RunManifestScope): EvolutionGenerationHeadV1 | null;
  latestReconciliation(
    scope: RunManifestScope,
  ): UpgradeReconciliationReportV1 | null;
  curate(scope: RunManifestScope): Promise<{
    proposal: CurationProposalV1 | null;
    diagnostics: Array<{code: string}>;
  }>;
  gate(
    scope: RunManifestScope,
    proposalId: string,
    actor: {userId?: string},
  ): Promise<CurationProposalV1>;
  accept(
    scope: RunManifestScope,
    proposalId: string,
  ): CurationProposalV1;
  reject(
    scope: RunManifestScope,
    proposalId: string,
  ): CurationProposalV1;
  exportContribution(
    scope: RunManifestScope,
    proposalId: string,
    actor: {userId?: string},
  ): Promise<ContributionBundleArtifactV1>;
  apply(
    scope: RunManifestScope,
    proposalId: string,
    actionId: string,
    actor: {userId?: string},
  ): Promise<AppliedProposalRevisionV1>;
  revert(
    scope: RunManifestScope,
    proposalId: string,
    actionId: string,
    actor: {userId?: string},
  ): Promise<AppliedProposalRevisionV1>;
  close(): void;
  now?: () => number;
  operationId?: () => string;
  operationTimeoutMs?: number;
}

type OperationListener = (event: SelfEvolutionOperationEvent) => void;

interface StoredOperation extends SelfEvolutionOperationSnapshot {
  listeners: Set<OperationListener>;
  timeoutHandle?: NodeJS.Timeout;
}

export class SelfEvolutionAdminService {
  private readonly operations = new Map<string, StoredOperation>();
  private readonly now: () => number;
  private readonly operationId: () => string;
  private readonly operationTimeoutMs: number;

  constructor(private readonly dependencies: SelfEvolutionAdminDependencies) {
    this.now = dependencies.now ?? Date.now;
    this.operationId =
      dependencies.operationId ?? (() => `self-evolution-${randomUUID()}`);
    this.operationTimeoutMs = Math.max(
      1,
      dependencies.operationTimeoutMs ?? OPERATION_TIMEOUT_MS,
    );
  }

  overview(scope: RunManifestScope): SelfEvolutionAdminOverview {
    this.pruneOperations();
    const lifecycle = this.dependencies.lifecycle();
    const proposals = this.dependencies.listProposals(scope);
    const overlays = this.dependencies.listOverlays(scope);
    const scopedOperations = [...this.operations.values()].filter(
      operation =>
        operation.scope.tenantId === scope.tenantId
        && operation.scope.workspaceId === scope.workspaceId,
    );
    return {
      collectedAt: this.now(),
      config: lifecycle.effectiveConfig,
      requestedConfig: lifecycle.requestedConfig,
      persistence: lifecycle.persistence,
      proposalCounts: countProposalStates(proposals),
      overlayCounts: countOverlayStates(overlays),
      generationHead: this.dependencies.generationHead(scope),
      latestReconciliation:
        this.dependencies.latestReconciliation(scope),
      operations: {
        running: scopedOperations.filter(operation =>
          operation.state === 'running').length,
        retained: scopedOperations.length,
      },
      l2Judge: {
        status: 'not_configured',
        reason: 'explicit_external_judge_consent_required',
      },
      warnings: lifecycle.warnings,
      errors: lifecycle.errors,
    };
  }

  listProposals(scope: RunManifestScope): CurationProposalV1[] {
    return this.dependencies.listProposals(scope);
  }

  proposal(
    scope: RunManifestScope,
    proposalId: string,
  ): SelfEvolutionProposalDetail {
    const proposal = this.dependencies.getProposal(scope, proposalId);
    if (!proposal) throw new Error('curation_proposal_not_found');
    return {
      proposal,
      latestGateAttempt:
        this.dependencies.latestGateAttempt(scope, proposalId) ?? null,
      appliedRevisions:
        this.dependencies.listAppliedRevisions(proposalId),
    };
  }

  startCuration(scope: RunManifestScope): {operationId: string} {
    this.assertEnabled();
    this.pruneOperations();
    this.reserveOperationCapacity(scope);
    const operationId = this.operationId();
    if (this.operations.has(operationId)) {
      throw new Error('self_evolution_operation_id_conflict');
    }
    const operation: StoredOperation = {
      operationId,
      scope: {...scope},
      kind: 'curation',
      state: 'running',
      events: [],
      createdAt: this.now(),
      listeners: new Set(),
    };
    this.operations.set(operationId, operation);
    operation.timeoutHandle = setTimeout(
      () => this.expireOperation(operation),
      this.operationTimeoutMs,
    );
    operation.timeoutHandle.unref?.();
    this.emit(operation, {
      type: 'started',
      stage: 'queued',
      message: 'curation_queued',
    });
    queueMicrotask(() => void this.runCuration(operation));
    return {operationId};
  }

  operation(
    scope: RunManifestScope,
    operationId: string,
  ): SelfEvolutionOperationSnapshot {
    this.pruneOperations();
    const operation = this.requireOperation(scope, operationId);
    return snapshotOperation(operation);
  }

  subscribe(
    scope: RunManifestScope,
    operationId: string,
    listener: OperationListener,
  ): () => void {
    const operation = this.requireOperation(scope, operationId);
    operation.listeners.add(listener);
    return () => operation.listeners.delete(listener);
  }

  async gate(
    scope: RunManifestScope,
    proposalId: string,
    actor: {userId?: string},
  ): Promise<CurationProposalV1> {
    this.assertEnabled();
    return this.dependencies.gate(scope, proposalId, actor);
  }

  accept(
    scope: RunManifestScope,
    proposalId: string,
  ): CurationProposalV1 {
    this.assertEnabled();
    return this.dependencies.accept(scope, proposalId);
  }

  reject(
    scope: RunManifestScope,
    proposalId: string,
  ): CurationProposalV1 {
    this.assertEnabled();
    return this.dependencies.reject(scope, proposalId);
  }

  async exportContribution(
    scope: RunManifestScope,
    proposalId: string,
    actor: {userId?: string},
  ): Promise<ContributionBundleArtifactV1> {
    this.assertEnabled();
    return this.dependencies.exportContribution(scope, proposalId, actor);
  }

  async apply(
    scope: RunManifestScope,
    proposalId: string,
    actionId: string,
    actor: {userId?: string},
  ): Promise<AppliedProposalRevisionV1> {
    this.assertApplyEnabled();
    assertActionId(actionId);
    return this.dependencies.apply(
      scope,
      proposalId,
      actionId,
      actor,
    );
  }

  async revert(
    scope: RunManifestScope,
    proposalId: string,
    actionId: string,
    actor: {userId?: string},
  ): Promise<AppliedProposalRevisionV1> {
    this.assertApplyEnabled();
    assertActionId(actionId);
    return this.dependencies.revert(
      scope,
      proposalId,
      actionId,
      actor,
    );
  }

  overlays(scope: RunManifestScope): EvolutionOverlayRegistryEntryV1[] {
    return this.dependencies.listOverlays(scope);
  }

  reconciliation(
    scope: RunManifestScope,
  ): UpgradeReconciliationReportV1 | null {
    return this.dependencies.latestReconciliation(scope);
  }

  operationalMetrics(scope: RunManifestScope): {
    proposalCounts: Record<CurationProposalV1['status'], number>;
    overlayCounts: SelfEvolutionAdminOverview['overlayCounts'];
    generationHead: EvolutionGenerationHeadV1 | null;
    latestReconciliationContentHash: string | null;
    activeOperations: number;
    l2Judge: SelfEvolutionAdminOverview['l2Judge'];
  } {
    const overview = this.overview(scope);
    return {
      proposalCounts: overview.proposalCounts,
      overlayCounts: overview.overlayCounts,
      generationHead: overview.generationHead,
      latestReconciliationContentHash:
        overview.latestReconciliation?.contentHash ?? null,
      activeOperations: overview.operations.running,
      l2Judge: overview.l2Judge,
    };
  }

  close(): void {
    for (const operation of this.operations.values()) {
      if (operation.timeoutHandle) clearTimeout(operation.timeoutHandle);
      operation.listeners.clear();
    }
    this.operations.clear();
    this.dependencies.close();
  }

  private async runCuration(operation: StoredOperation): Promise<void> {
    try {
      this.emit(operation, {
        type: 'progress',
        stage: 'loading_feedback',
        message: 'loading_effective_public_feedback',
      });
      this.emit(operation, {
        type: 'progress',
        stage: 'curating',
        message: 'running_single_candidate_curation',
      });
      const result = await this.dependencies.curate(operation.scope);
      if (!this.isActive(operation)) return;
      operation.state = 'completed';
      operation.completedAt = this.now();
      this.clearOperationTimeout(operation);
      this.emit(operation, {
        type: 'completed',
        stage: 'completed',
        message: result.proposal
          ? 'curation_proposal_ready'
          : 'curation_completed_without_proposal',
        ...(result.proposal
          ? {proposalId: result.proposal.proposalId}
          : {}),
        diagnosticCodes: result.diagnostics.map(diagnostic =>
          diagnostic.code),
      });
    } catch (error) {
      if (!this.isActive(operation)) return;
      operation.state = 'failed';
      operation.completedAt = this.now();
      this.clearOperationTimeout(operation);
      this.emit(operation, {
        type: 'failed',
        stage: 'failed',
        message: 'curation_failed',
        errorCode: safeErrorCode(error),
      });
    }
  }

  private emit(
    operation: StoredOperation,
    input: Omit<SelfEvolutionOperationEvent, 'sequence' | 'createdAt'>,
  ): void {
    const event: SelfEvolutionOperationEvent = {
      ...input,
      sequence: operation.events.length === 0
        ? 1
        : operation.events[operation.events.length - 1].sequence + 1,
      createdAt: this.now(),
    };
    operation.events.push(event);
    if (operation.events.length > MAX_EVENTS_PER_OPERATION) {
      operation.events.splice(
        0,
        operation.events.length - MAX_EVENTS_PER_OPERATION,
      );
    }
    for (const listener of operation.listeners) listener(event);
  }

  private requireOperation(
    scope: RunManifestScope,
    operationId: string,
  ): StoredOperation {
    const operation = this.operations.get(operationId);
    if (
      !operation
      || operation.scope.tenantId !== scope.tenantId
      || operation.scope.workspaceId !== scope.workspaceId
    ) {
      throw new Error('self_evolution_operation_not_found');
    }
    return operation;
  }

  private pruneOperations(): void {
    const now = this.now();
    for (const [operationId, operation] of this.operations) {
      if (
        operation.completedAt !== undefined
        && now - operation.completedAt > TERMINAL_OPERATION_TTL_MS
      ) {
        this.removeOperation(operationId, operation);
      }
    }
    if (this.operations.size <= MAX_OPERATIONS) return;
    const terminal = [...this.operations.values()]
      .filter(operation => operation.state !== 'running')
      .sort((left, right) =>
        (left.completedAt ?? left.createdAt)
        - (right.completedAt ?? right.createdAt));
    while (
      this.operations.size > MAX_OPERATIONS
      && terminal.length > 0
    ) {
      const operation = terminal.shift()!;
      this.removeOperation(operation.operationId, operation);
    }
  }

  private reserveOperationCapacity(scope: RunManifestScope): void {
    const scopedOperations = [...this.operations.values()]
      .filter(operation => sameScope(operation.scope, scope));
    if (
      scopedOperations.filter(operation => operation.state === 'running')
        .length >= MAX_RUNNING_OPERATIONS_PER_SCOPE
    ) {
      throw new Error(
        'self_evolution_operation_scope_capacity_exceeded',
      );
    }
    const scopedTerminal = scopedOperations
      .filter(operation => operation.state !== 'running')
      .sort(oldestOperationFirst);
    while (
      scopedOperations.length >= MAX_OPERATIONS_PER_SCOPE
      && scopedTerminal.length > 0
    ) {
      const operation = scopedTerminal.shift()!;
      this.removeOperation(operation.operationId, operation);
      scopedOperations.splice(scopedOperations.indexOf(operation), 1);
    }
    if (scopedOperations.length >= MAX_OPERATIONS_PER_SCOPE) {
      throw new Error(
        'self_evolution_operation_scope_capacity_exceeded',
      );
    }

    const terminal = [...this.operations.values()]
      .filter(operation => operation.state !== 'running')
      .sort(oldestOperationFirst);
    while (
      this.operations.size >= MAX_OPERATIONS
      && terminal.length > 0
    ) {
      const operation = terminal.shift()!;
      this.removeOperation(operation.operationId, operation);
    }
    if (this.operations.size >= MAX_OPERATIONS) {
      throw new Error('self_evolution_operation_capacity_exceeded');
    }
  }

  private expireOperation(operation: StoredOperation): void {
    if (!this.isActive(operation)) return;
    operation.state = 'failed';
    operation.completedAt = this.now();
    this.clearOperationTimeout(operation);
    this.emit(operation, {
      type: 'failed',
      stage: 'failed',
      message: 'curation_failed',
      errorCode: 'self_evolution_operation_timeout',
    });
  }

  private clearOperationTimeout(operation: StoredOperation): void {
    if (!operation.timeoutHandle) return;
    clearTimeout(operation.timeoutHandle);
    operation.timeoutHandle = undefined;
  }

  private isActive(operation: StoredOperation): boolean {
    return operation.state === 'running'
      && this.operations.get(operation.operationId) === operation;
  }

  private removeOperation(
    operationId: string,
    operation: StoredOperation,
  ): void {
    this.clearOperationTimeout(operation);
    operation.listeners.clear();
    this.operations.delete(operationId);
  }

  private assertEnabled(): void {
    if (!this.dependencies.lifecycle().effectiveConfig.enabled) {
      throw new Error('self_evolution_disabled');
    }
  }

  private assertApplyEnabled(): void {
    const lifecycle = this.dependencies.lifecycle();
    if (!lifecycle.effectiveConfig.applyEnabled) {
      throw new Error(
        lifecycle.persistence.persistence === 'available'
          ? 'self_evolution_apply_disabled'
          : 'self_evolution_persistence_unavailable',
      );
    }
  }
}

function snapshotOperation(
  operation: StoredOperation,
): SelfEvolutionOperationSnapshot {
  return {
    operationId: operation.operationId,
    scope: {...operation.scope},
    kind: operation.kind,
    state: operation.state,
    events: operation.events.map(event => ({...event})),
    createdAt: operation.createdAt,
    ...(operation.completedAt === undefined
      ? {}
      : {completedAt: operation.completedAt}),
  };
}

function countProposalStates(
  proposals: readonly CurationProposalV1[],
): Record<CurationProposalV1['status'], number> {
  const counts: Record<CurationProposalV1['status'], number> = {
    draft: 0,
    gated: 0,
    accepted: 0,
    applied: 0,
    rejected: 0,
    reverted: 0,
  };
  for (const proposal of proposals) counts[proposal.status] += 1;
  return counts;
}

function countOverlayStates(
  overlays: readonly EvolutionOverlayRegistryEntryV1[],
): SelfEvolutionAdminOverview['overlayCounts'] {
  const byActivationState: SelfEvolutionAdminOverview[
    'overlayCounts'
  ]['byActivationState'] = {
    active: 0,
    inactive: 0,
    quarantined: 0,
    obsolete: 0,
    disabled: 0,
  };
  const byValidationState: SelfEvolutionAdminOverview[
    'overlayCounts'
  ]['byValidationState'] = {
    pending: 0,
    passed: 0,
    failed: 0,
    error: 0,
  };
  for (const overlay of overlays) {
    byActivationState[overlay.activationState] += 1;
    byValidationState[overlay.validationState] += 1;
  }
  return {
    total: overlays.length,
    effective: overlays.filter(overlay => overlay.effectiveEnabled).length,
    byActivationState,
    byValidationState,
  };
}

function assertActionId(value: string): void {
  if (!/^[A-Za-z0-9._:-]{8,128}$/.test(value)) {
    throw new Error('self_evolution_action_id_invalid');
  }
}

function safeErrorCode(error: unknown): string {
  const code = error instanceof Error ? error.message : String(error);
  return /^[a-z0-9_:-]{1,160}$/.test(code)
    ? code
    : 'self_evolution_operation_failed';
}

export const selfEvolutionAdminServiceContract = Object.freeze({
  maxOperations: MAX_OPERATIONS,
  maxOperationsPerScope: MAX_OPERATIONS_PER_SCOPE,
  maxRunningOperationsPerScope: MAX_RUNNING_OPERATIONS_PER_SCOPE,
  maxEventsPerOperation: MAX_EVENTS_PER_OPERATION,
  terminalOperationTtlMs: TERMINAL_OPERATION_TTL_MS,
  operationTimeoutMs: OPERATION_TIMEOUT_MS,
});

function sameScope(left: RunManifestScope, right: RunManifestScope): boolean {
  return left.tenantId === right.tenantId
    && left.workspaceId === right.workspaceId;
}

function oldestOperationFirst(
  left: StoredOperation,
  right: StoredOperation,
): number {
  return (left.completedAt ?? left.createdAt)
    - (right.completedAt ?? right.createdAt);
}
