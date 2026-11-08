// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import type {AgentOptions} from '@earendil-works/pi-agent-core';
import type {InvestigationViewSource} from '../../investigation/investigationView';
import {decideInvestigationTurn} from '../../investigation/investigationTurnDecision';
import {projectInvestigationReceipt, type AGENT_REQUEST_PURPOSES} from '../../investigation/investigationReceipt';
import type {RuntimeInvestigationRequestReceiptV1} from '../../runtimePerformance';

type PiPrepareRequest = NonNullable<AgentOptions['prepareRequest']>;
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
 * The Pi `prepareRequest` adapter: before each native provider request it
 * fixes the request's ordinal and purpose, then derives the run's investigation
 * view and turn decision and records one bounded receipt. It returns no update,
 * so the loop's context, model and thinking level stay exactly as built. A
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
}): PiInvestigationAdapter {
  const messageMeter = createContextMeter();
  const toolMeter = createContextMeter();
  let requests = 0;
  let current: PiAgentRequest | undefined;
  let disposed = false;
  const prepareRequest: PiPrepareRequest = (request, signal) => {
    if (disposed) return undefined;
    try {
      current = Object.freeze({index: ++requests, purpose: input.purpose()});
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
        const view = input.view.derive(base.attempt);
        receipt = {...base, status: 'observed', agentContext, ...projectInvestigationReceipt(view, decideInvestigationTurn(view))};
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
    currentRequest: () => current,
    dispose() { disposed = true; },
  };
}
