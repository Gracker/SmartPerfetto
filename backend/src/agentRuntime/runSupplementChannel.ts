// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {createHash, randomUUID} from 'crypto';
import type {
  RunSupplementDisposition,
  RunSupplementNotAppliedReason,
  RunSupplementReason,
  RunSupplementReceipt,
  RunSupplementRecord,
  RunSupplementRejectedReason,
  RunSupplementRestartReason,
  RunSupplementState,
} from '../types/runSupplementContract';
import {redactSecrets} from '../services/security/secretPatterns';
import {parseFlagValue} from '../utils/envFlag';

export const RUN_SUPPLEMENT_FLAG_ENV = 'SMARTPERFETTO_RUN_SUPPLEMENT';
export const RUN_SUPPLEMENT_MAX_PER_RUN = 6;
export const RUN_SUPPLEMENT_MAX_BYTES = 4096;

/** Default off until the release gate passes; only an explicit truthy value enables it. */
export function runSupplementFeatureEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return parseFlagValue(env[RUN_SUPPLEMENT_FLAG_ENV]) === true;
}

/** The classifier's verdict, already passed through the deterministic decision table. */
export type RunSupplementDecision =
  | {disposition: 'in_place'}
  | {disposition: 'restart_required'; reason: RunSupplementRestartReason}
  | {disposition: 'rejected'; reason: RunSupplementRejectedReason};

/** `signal` aborts when the window closes, so no provider call carrying the text outlives the run. */
export type RunSupplementClassifier = (text: string, signal: AbortSignal) => Promise<RunSupplementDecision>;

/** Where an applied supplement goes. Enqueuing is not delivery; `markDelivered` is. */
export interface RunSupplementSteerTarget {
  steer(delivery: {id: string; sequence: number; text: string}): void;
  /** Drop every supplement the agent queued but did not take into its context. */
  clear(): void;
}

export interface RunSupplementUpdate {
  receipt: RunSupplementReceipt;
  /** Size only; the text and its hash never reach a log, receipt or event. */
  byteLength: number;
}

export type RunSupplementReplayResult =
  | {status: 'replayed'; receipt: RunSupplementReceipt}
  | {status: 'idempotency_conflict'};

export type RunSupplementSubmitResult =
  | {status: 'accepted'; receipt: RunSupplementReceipt; redactedText: string}
  | {status: 'capacity_exceeded' | 'window_closed' | 'not_active' | 'unsupported'};

interface RunSupplementItem {
  id: string;
  sequence: number;
  /** Secret-redacted at intake; every consumer (classifier, steer, memory) sees this copy. Dropped on terminate. */
  text: string;
  /** Answers a replay after the text is gone. In memory only: never logged, receipted or sent. */
  textDigest: string;
  byteLength: number;
  state: RunSupplementState;
  reason?: RunSupplementReason;
  disposition?: RunSupplementDisposition;
  deliveredRequestIndex?: number;
}

const ALLOWED_TRANSITIONS: Readonly<Record<RunSupplementState, readonly RunSupplementState[]>> = {
  classifying: ['queued', 'restart_required', 'rejected', 'not_applied'],
  queued: ['delivered', 'not_applied'],
  delivered: [],
  restart_required: [],
  rejected: [],
  not_applied: [],
};

/**
 * Per-run mailbox for user supplements. In-memory only: it owns the run's
 * supplements from intake to a terminal state, and it serializes classification
 * so a slow verdict never reorders delivery. Every path that ends a run settles
 * it through `terminate`, so no supplement is left pending once its run is over.
 */
export class RunSupplementChannel {
  readonly runId: string;
  private onUpdate?: (update: RunSupplementUpdate) => void;
  private readonly itemsById = new Map<string, RunSupplementItem>();
  private readonly itemsByKey = new Map<string, RunSupplementItem>();
  private sequence = 0;
  private classifier?: RunSupplementClassifier;
  private steerTarget?: RunSupplementSteerTarget;
  private closedReason?: RunSupplementNotAppliedReason;
  private terminated = false;
  private unsupported = false;
  private pumping = false;
  private classification?: AbortController;
  private requestIndexPending: RunSupplementItem[] = [];

  constructor(input: {runId: string; onUpdate?: (update: RunSupplementUpdate) => void}) {
    this.runId = input.runId;
    this.onUpdate = input.onUpdate;
  }

  get isTerminated(): boolean { return this.terminated; }
  get isUnsupported(): boolean { return this.unsupported; }

  /** A resubmission of the same key: the original receipt, or a conflict for different text. */
  replay(input: {idempotencyKey: string; text: string}): RunSupplementReplayResult | undefined {
    const existing = this.itemsByKey.get(input.idempotencyKey);
    if (!existing) return undefined;
    return existing.textDigest === digestOf(redactSecrets(input.text).text)
      ? {status: 'replayed', receipt: receiptOf(this.runId, existing)}
      : {status: 'idempotency_conflict'};
  }

  /** Callers answer a repeated key with `replay` first; this only accepts new supplements. */
  submit(input: {idempotencyKey: string; text: string}): RunSupplementSubmitResult {
    if (this.unsupported) return {status: 'unsupported'};
    if (this.terminated) return {status: 'not_active'};
    if (this.closedReason) return {status: 'window_closed'};
    if (this.itemsById.size >= RUN_SUPPLEMENT_MAX_PER_RUN) return {status: 'capacity_exceeded'};
    const redactedText = redactSecrets(input.text).text;
    const item: RunSupplementItem = {
      id: `run-supplement-${randomUUID()}`, sequence: ++this.sequence, text: redactedText,
      textDigest: digestOf(redactedText), byteLength: Buffer.byteLength(input.text, 'utf8'), state: 'classifying',
    };
    this.itemsById.set(item.id, item);
    this.itemsByKey.set(input.idempotencyKey, item);
    this.emit(item);
    this.pump();
    return {status: 'accepted', receipt: receiptOf(this.runId, item), redactedText};
  }

  /** Classification waits for the run's resolved intent; items submitted earlier are held until then. */
  bindClassifier(classifier: RunSupplementClassifier): void {
    if (this.closedReason) return;
    this.classifier = classifier;
    this.pump();
  }

  /** Before the first request: everything already classified joins request 1, in sequence order. */
  bindSteerTarget(target: RunSupplementSteerTarget): void {
    if (this.closedReason) return;
    this.steerTarget = target;
    for (const item of this.inSequence()) if (item.state === 'queued') this.steer(item);
  }

  /** The module cannot steer, so the run is reported as unsupported rather than silently ignoring it. */
  markUnsupported(): void {
    this.unsupported = true;
    this.closeAcquisition('window_closed');
  }

  markDelivered(id: string): void {
    const item = this.itemsById.get(id);
    if (!item || !this.transition(item, 'delivered')) return;
    this.requestIndexPending.push(item);
  }

  /** The request that actually carries what the last `markDelivered` calls let in. */
  assignRequestIndex(requestIndex: number): void {
    for (const item of this.requestIndexPending) item.deliveredRequestIndex = requestIndex;
    this.requestIndexPending = [];
  }

  /** First close wins; later reasons cannot rewrite a supplement that already settled. */
  closeAcquisition(reason: RunSupplementNotAppliedReason): void {
    if (this.closedReason) return;
    this.closedReason = reason;
    try { this.steerTarget?.clear(); } catch { /* Settling below never depends on the agent. */ }
    this.settleOpenItems(reason);
    this.classification?.abort();
  }

  /** Idempotent terminal owner, reached from every run-end path. */
  terminate(reason: RunSupplementNotAppliedReason): void {
    if (this.terminated) return;
    this.closeAcquisition(reason);
    this.terminated = true;
    // The channel stays on the session for replay; it must not pin the request or the text.
    this.classifier = undefined;
    this.steerTarget = undefined;
    this.onUpdate = undefined;
    this.requestIndexPending = [];
    for (const item of this.itemsById.values()) item.text = '';
  }

  /** Only supplements that entered the agent's context; a queued one was never seen by the model. */
  deliveredRecords(options: {includeText: boolean}): RunSupplementRecord[] {
    return this.inSequence().filter(item => item.state === 'delivered').map(item => ({
      id: item.id,
      sequence: item.sequence,
      ...(item.deliveredRequestIndex === undefined ? {} : {deliveredRequestIndex: item.deliveredRequestIndex}),
      ...(options.includeText && item.text ? {text: item.text} : {}),
    }));
  }

  deliveredTexts(): string[] {
    return this.inSequence().filter(item => item.state === 'delivered').map(item => item.text);
  }

  receipts(): RunSupplementReceipt[] {
    return this.inSequence().map(item => receiptOf(this.runId, item));
  }

  /** A sidecar object: it can reach the agent but never a serialized options payload. */
  toJSON(): undefined { return undefined; }

  private inSequence(): RunSupplementItem[] {
    return [...this.itemsById.values()];
  }

  private settleOpenItems(reason: RunSupplementNotAppliedReason): void {
    for (const item of this.inSequence()) {
      if (item.state === 'classifying' || item.state === 'queued') {
        this.transition(item, 'not_applied', reason);
      }
    }
  }

  private pump(): void {
    if (this.pumping || !this.classifier || this.closedReason) return;
    this.pumping = true;
    void this.runPump();
  }

  /** The loop exits with no await after its last check, so a concurrent `submit` is never missed. */
  private async runPump(): Promise<void> {
    try {
      for (;;) {
        const item = this.inSequence().find(candidate => candidate.state === 'classifying');
        if (!item || !this.classifier) return;
        let decision: RunSupplementDecision;
        const classification = new AbortController();
        this.classification = classification;
        try {
          decision = await this.classifier(item.text, classification.signal);
        } catch {
          decision = {disposition: 'rejected', reason: 'classification_unavailable'};
        } finally {
          this.classification = undefined;
        }
        // Closing settles the item while the verdict was outstanding, so it is checked again here.
        if (item.state !== 'classifying') continue;
        if (decision.disposition === 'restart_required') {
          this.transition(item, 'restart_required', decision.reason, 'restart_required');
        } else if (decision.disposition === 'rejected') {
          this.transition(item, 'rejected', decision.reason);
        } else if (this.transition(item, 'queued', undefined, 'in_place') && this.steerTarget) {
          this.steer(item);
        }
      }
    } finally {
      this.pumping = false;
    }
  }

  private steer(item: RunSupplementItem): void {
    if (!this.steerTarget) return;
    try {
      this.steerTarget.steer({id: item.id, sequence: item.sequence, text: item.text});
    } catch {
      this.transition(item, 'not_applied', 'window_closed');
    }
  }

  private transition(item: RunSupplementItem, next: RunSupplementState, reason?: RunSupplementReason,
    disposition?: RunSupplementDisposition): boolean {
    if (!ALLOWED_TRANSITIONS[item.state].includes(next)) return false;
    item.state = next;
    if (reason !== undefined) item.reason = reason;
    if (disposition !== undefined) item.disposition = disposition;
    this.emit(item);
    return true;
  }

  private emit(item: RunSupplementItem): void {
    try {
      this.onUpdate?.({receipt: receiptOf(this.runId, item), byteLength: item.byteLength});
    } catch { /* Publishing an update never changes a supplement's state. */ }
  }
}

function digestOf(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function receiptOf(runId: string, item: RunSupplementItem): RunSupplementReceipt {
  return {
    id: item.id, runId, sequence: item.sequence, state: item.state,
    ...(item.reason === undefined ? {} : {reason: item.reason}),
    ...(item.disposition === undefined ? {} : {disposition: item.disposition}),
  };
}
