// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import type {AgentOptions} from '@earendil-works/pi-agent-core';
import type {InvestigationViewSource, InvestigationViewV1} from '../../investigation/investigationView';
import {
  applyProgress,
  decideInvestigationTurn,
  INVESTIGATION_TURN_UNCHANGED,
  progressGateOpen,
  type InvestigationProgressState,
  type InvestigationTurnDecisionV1,
} from '../../investigation/investigationTurnDecision';
import {projectInvestigationReceipt, type AGENT_REQUEST_PURPOSES} from '../../investigation/investigationReceipt';
import type {RuntimeInvestigationRequestReceiptV1} from '../../runtimePerformance';
import {piInvestigationProgressMessage} from './piInvestigationProgress';

type PiPrepareRequest = NonNullable<AgentOptions['prepareRequest']>;
type PiPrepareNextTurn = NonNullable<AgentOptions['prepareNextTurn']>;
type AgentRequestPurpose = typeof AGENT_REQUEST_PURPOSES[number];
type AgentContextSize = NonNullable<RuntimeInvestigationRequestReceiptV1['agentContext']>;

/** Nodes one top-level message or tool may walk; past it, that value counts as a lower bound. */
const CONTEXT_WALK_NODE_BUDGET = 50_000;
const CONTEXT_WALK_MAX_DEPTH = 32;

/** One native request, fixed when Pi prepares it; its stream dispatch reads the same facts. */
export interface PiAgentRequest {
  index: number;
  purpose: AgentRequestPurpose;
}

export interface PiInvestigationAdapter {
  /** Pi calls this before every provider request, the first included. Never throws, never changes the request. */
  readonly prepareRequest: PiPrepareRequest;
  /**
   * Pi calls this only at a turn boundary where the loop continues, so a
   * returned message rides the request already scheduled: it never adds a
   * provider request or extends the run. Never throws.
   */
  readonly prepareNextTurn: PiPrepareNextTurn;
  /** The request most recently prepared, which the next stream dispatch answers. */
  currentRequest(): PiAgentRequest | undefined;
  /** Finalization: later calls record nothing. */
  dispose(): void;
}

/**
 * Approximate Agent-context size: string lengths plus key names, functions
 * skipped. Each top-level message or tool is walked within its own node budget
 * and, when fully walked, measured once per run (they are stable references in
 * Pi's context). An overrun marks only that value as a lower bound.
 */
function createContextMeter() {
  const measured = new WeakMap<object, number>();
  const measure = (root: object): {chars: number; complete: boolean} => {
    let nodes = 0;
    let complete = true;
    const walk = (value: unknown, depth: number): number => {
      if (typeof value === 'string') return value.length;
      if (typeof value === 'number' || typeof value === 'boolean') return String(value).length;
      if (!value || typeof value !== 'object') return 0;
      if (++nodes > CONTEXT_WALK_NODE_BUDGET || depth > CONTEXT_WALK_MAX_DEPTH) {complete = false; return 0;}
      let total = 0;
      for (const [key, child] of Object.entries(value)) {
        if (typeof child === 'function') continue;
        total += key.length + walk(child, depth + 1);
      }
      return total;
    };
    const chars = walk(root, 0);
    return {chars, complete};
  };
  return (values: readonly unknown[]) => {
    let chars = 0;
    let lowerBound = false;
    for (const value of values) {
      if (!value || typeof value !== 'object') continue;
      const cached = measured.get(value);
      if (cached !== undefined) {chars += cached; continue;}
      const size = measure(value);
      // A partial walk is never cached as the value's size.
      if (size.complete) measured.set(value, size.chars);
      else lowerBound = true;
      chars += size.chars;
    }
    return {chars, lowerBound};
  };
}

/**
 * The Pi investigation adapter. A turn decision is made at the turn boundary
 * (`prepareNextTurn`) for the next request and held until that request. Before
 * each native provider request, `prepareRequest` fixes the request's ordinal
 * and purpose, reads the view (the boundary's ledger with a fresh budget, when
 * a decision just read it) and records one bounded receipt naming that
 * request's decision. It returns
 * no update, so the loop's context, model and thinking level stay as built: a
 * returned context would replace the loop's own for the rest of the run.
 */
export function createPiInvestigationAdapter(input: {
  view: InvestigationViewSource;
  /** Lease/work liveness without side effects; never the throwing run guard. */
  isActive(): boolean;
  attempt(): number;
  /** Read once per request; `currentRequest()` then carries it to the stream dispatch. */
  purpose(): AgentRequestPurpose;
  /** False when the recorder would drop the receipt: no sink, not collecting, or at its cap. */
  accepts(): boolean;
  record(receipt: Omit<RuntimeInvestigationRequestReceiptV1, 'offsetMs'>): void;
  /** Contract progress, present only when the feature is on; otherwise no decision is ever made. */
  progress?: Pick<InvestigationProgressState, 'catalog'>;
}): PiInvestigationAdapter {
  const messageMeter = createContextMeter();
  const toolMeter = createContextMeter();
  let requests = 0;
  let current: PiAgentRequest | undefined;
  let disposed = false;
  /** The decision made at the last turn boundary, for the request it was made for. */
  let pending: {index: number; decision: InvestigationTurnDecisionV1; view: InvestigationViewV1} | undefined;
  let progress: InvestigationProgressState | undefined = input.progress
    && {catalog: input.progress.catalog, named: new Set(), messagesSent: 0};
  const prepareNextTurn: PiPrepareNextTurn = signal => {
    if (disposed || !progress || !input.isActive() || signal?.aborted) return undefined;
    try {
      const request = {index: requests + 1, purpose: input.purpose()};
      if (!progressGateOpen(request, progress)) return undefined;
      const view = input.view.derive(input.attempt());
      const decision = decideInvestigationTurn({view, request, progress});
      pending = {index: request.index, decision, view};
      progress = applyProgress(progress, decision);
      return decision.progressMessages.length
        ? {messages: decision.progressMessages.map(piInvestigationProgressMessage)} : undefined;
    } catch {
      // A failed decision changes nothing about the request.
      return undefined;
    }
  };
  const prepareRequest: PiPrepareRequest = (request, signal) => {
    if (disposed) return undefined;
    try {
      current = Object.freeze({index: ++requests, purpose: input.purpose()});
      // Recording only: the decision was made at the turn boundary before this request.
      const decided = pending?.index === current.index ? pending : undefined;
      pending = undefined;
      const decision = decided?.decision ?? INVESTIGATION_TURN_UNCHANGED;
      const base = {requestIndex: current.index, attempt: input.attempt(), purpose: current.purpose};
      // A receipt the recorder drops skips the measurement; recording it still counts the drop.
      if (!input.accepts() || signal?.aborted || !input.isActive()) {
        input.record({...base, status: 'inactive'});
        return undefined;
      }
      const messages = Array.isArray(request?.context?.messages) ? request.context.messages : [];
      const tools = Array.isArray(request?.context?.tools) ? request.context.tools : [];
      const messageSize = messageMeter(messages);
      const toolSize = toolMeter(tools);
      const agentContext: AgentContextSize = {messageCount: messages.length, toolCount: tools.length,
        approxMessageChars: messageSize.chars, approxToolChars: toolSize.chars,
        ...(messageSize.lowerBound || toolSize.lowerBound ? {lowerBound: true as const} : {})};
      let receipt: Omit<RuntimeInvestigationRequestReceiptV1, 'offsetMs'>;
      try {
        // The ledger has not moved since the boundary read it for this request.
        const view = decided?.view.attempt === base.attempt
          ? input.view.refreshBudget(decided.view) : input.view.derive(base.attempt);
        receipt = {...base, status: 'observed', agentContext, ...projectInvestigationReceipt(view, decision)};
      } catch {
        // A bounded marker only: no error text reaches the receipt.
        receipt = {...base, status: 'view_failed', agentContext};
      }
      input.record(receipt);
    } catch {
      // Observation never fails the request it observes.
    }
    return undefined;
  };
  return {
    prepareRequest,
    prepareNextTurn,
    currentRequest: () => current,
    dispose() { disposed = true; pending = undefined; },
  };
}
