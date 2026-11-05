// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)

/** Product lifecycle only; none of these states grants evidence verification. */
export type AssistantWorkPhase = 'running' | 'reviewing' | 'needs_input' | 'ready' | 'finished' |
  'interrupted' | 'failed' | 'cancelled' | 'unknown';
export interface AssistantWorkSummary {
  sessionId: string;
  runId?: string;
  phase: AssistantWorkPhase;
  startedAt?: number;
  completedAt?: number;
  hasResult: boolean;
  inputReason?: 'question' | 'full_analysis';
  captureActivity?: {observation: 'observed' | 'partial'; tables: number; rowSlots: number; unavailableTables: number};
  activity?: {
    observation: 'observed' | 'partial';
    attempted: number;
    returned: number;
    inFlight: number;
    repeatedExactCalls?: number;
  } | {observation: 'unavailable'};
}
export type ConversationContextState =
  | {availability: 'available'; queueEpoch: string; pendingCount: number; durability: 'process_memory'}
  | {availability: 'unavailable'};
export interface ConversationStatusResponse {
  success: true;
  work: AssistantWorkSummary;
  context: ConversationContextState;
}
export interface ConversationContextRequest {
  expectedQueueEpoch: string;
  expectedRunId: string;
  idempotencyKey: string;
  text: string;
}
export interface ConversationContextReceipt {
  id: string;
  queueEpoch: string;
  expectedRunId: string;
  status: 'accepted' | 'consumed';
  consumedByRunId?: string;
  appliesTo: 'next_user_turn';
  durability: 'process_memory';
}
export interface ConversationContextResponse {
  success: true;
  sessionId: string;
  receipt: ConversationContextReceipt;
  context: ConversationContextState;
}
export interface ConversationTurnContextReceipt {
  queueEpoch: string;
  consumedContextIds: string[];
}

/** Owner-authorized detail metadata only; not a grant or a persisted browser locator. */
export interface ConversationSourceSelection {
  codeAwareMode: 'off' | 'metadata_only' | 'provider_send';
  codebaseIds: string[];
  knowledgeSourceIds: string[];
}

/** Owner-scoped navigation metadata; no task text or execution authority. */
export interface AssistantWorkItem {
  surface: 'conversation' | 'analysis';
  work: AssistantWorkSummary;
  metadata: 'available' | 'unavailable';
  metadataReason?: 'latest_run_ambiguous';
  result?: {kind: 'snapshot'; id: string};
  reportId?: string;
}
export interface AssistantWorkCatalogResponse {
  success: true;
  filter: 'recent' | 'needs_input';
  items: AssistantWorkItem[];
  /** Stable cursor over scanned records, including rows hidden by a live update. */
  nextCursor?: string;
}
