// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {renderRequiredLocalizedStrategyTemplate} from '../../../agentv3/localizedStrategyTemplate';
import {localize, type OutputLanguage} from '../../../agentv3/outputLanguage';
import type {ReadonlyStrategyRegistrySnapshot} from '../../../services/selfEvolution/effectiveRuntimeRegistryContext';
import type {RunSupplementNotAppliedReason} from '../../../types/runSupplementContract';
import type {AnalysisTurnIntent} from '../../analysisTurnIntent';
import {dispatchWithModelCallRecord, type IntentTransportInput, type IntentTransportResult} from '../../intentTransport';
import type {RunSupplementChannel, RunSupplementClassifier} from '../../runSupplementChannel';
import {
  buildRunSupplementIntentPrompt,
  decideRunSupplement,
  parseRunSupplementIntentDecision,
  RUN_SUPPLEMENT_INTENT_OUTPUT_BYTE_LIMIT,
  type RunSupplementRunFacts,
} from '../../runSupplementIntent';
import type {RuntimeModelCallStart, RuntimePerformanceRecorder} from '../../runtimePerformance';

const CLASSIFICATION_TIMEOUT_MS = 5_000;
const CLOSEOUT_FALLBACK_MAX_BYTES = 32 * 1024;

/** The optional steering surface; another module can supply an Agent without it. */
interface PiSteerableAgent {
  steer(message: unknown): void;
  clearSteeringQueue(): void;
}

function isSteerableAgent(agent: unknown): agent is PiSteerableAgent {
  const candidate = agent as Partial<PiSteerableAgent> | null;
  return typeof candidate?.steer === 'function' && typeof candidate?.clearSteeringQueue === 'function';
}

/**
 * Renders the supplement as the user-role message the agent receives. The
 * framing template owns the wording; the supplement text stays JSON-encoded so
 * it cannot break out of the marked data.
 */
function buildRunSupplementMessageText(text: string, outputLanguage: OutputLanguage): string {
  return renderRequiredLocalizedStrategyTemplate('prompt-run-supplement-message', outputLanguage,
    {supplement: JSON.stringify({text})});
}

/** A missing template must not lose what the agent already acted on: fall back to a plain bounded section. */
function renderDeliveredSupplements(texts: readonly string[], outputLanguage: OutputLanguage): string {
  if (texts.length === 0) return '';
  const body = JSON.stringify(texts);
  try {
    return `\n\n${renderRequiredLocalizedStrategyTemplate('prompt-run-supplement-closeout', outputLanguage, {run_supplements: body})}`;
  } catch {
    const bounded = Buffer.from(body).subarray(0, CLOSEOUT_FALLBACK_MAX_BYTES).toString('utf8').replace(/\uFFFD$/u, '');
    return `\n\n${localize(outputLanguage, '用户在运行期间提交的补充说明（JSON）：', 'User supplements submitted during this run (JSON):')}\n${bounded}`;
  }
}

export interface PiRunSupplementBinding {
  bindAgent(agent: unknown): void;
  /**
   * Called from `finishTurn` for a natural final-answer turn: closes the window.
   * True when supplements were waiting and the turn must end so the loop does
   * not spend a request on them.
   */
  closeOnFinishedAnswer(): boolean;
  closeWindow(reason: RunSupplementNotAppliedReason): void;
  onEvent(event: {type: string; message?: unknown}): void;
  onPrepareRequest(requestIndex: number | undefined): void;
  /** The section Pi appends to its closeout prompt, or '' when nothing was delivered. */
  renderCloseoutSection(): string;
}

/**
 * Pi's half of the run-bound channel. It owns the WeakMap that recognizes a
 * steered message at `message_end`, the only event that proves delivery.
 */
export function createPiRunSupplementBinding(input: {
  channel: RunSupplementChannel | undefined;
  runId: string;
  outputLanguage: OutputLanguage;
  signal: AbortSignal;
  getRunDeadlineMs: () => number;
  /** The run's pinned classification transport. */
  dispatch: (transport: IntentTransportInput) => Promise<IntentTransportResult>;
  intent: AnalysisTurnIntent;
  registry: ReadonlyStrategyRegistrySnapshot;
  run: Pick<RunSupplementRunFacts, 'sourceSelected' | 'knowledgeSelected'>;
  recorder: RuntimePerformanceRecorder | undefined;
  modelCallAttribution: Pick<RuntimeModelCallStart, 'model' | 'providerOrigin'>;
}): PiRunSupplementBinding | undefined {
  const {channel} = input;
  // Fail closed on a channel that belongs to a different run: it is not this run's mailbox.
  if (!channel || channel.runId !== input.runId) return undefined;
  const runFacts: RunSupplementRunFacts = {
    sceneId: input.intent.sceneId,
    evidenceAccess: input.intent.evidenceAccess,
    deliverable: input.intent.deliverable,
    ...input.run,
  };
  const classify: RunSupplementClassifier = async (text, closed) => {
    const unavailable = {disposition: 'rejected', reason: 'classification_unavailable'} as const;
    const prompt = buildRunSupplementIntentPrompt({text, run: runFacts, registry: input.registry});
    if (!prompt) return unavailable;
    let result;
    try {
      result = await dispatchWithModelCallRecord(input.recorder,
        {...input.modelCallAttribution, purpose: 'classification'}, {
          prompt, systemPrompt: '', signal: AbortSignal.any([input.signal, closed]),
          deadlineMs: Math.min(input.getRunDeadlineMs(), Date.now() + CLASSIFICATION_TIMEOUT_MS),
          outputByteLimit: RUN_SUPPLEMENT_INTENT_OUTPUT_BYTE_LIMIT,
        }, input.dispatch);
    } catch {
      // Stopping is not a verdict about the supplement: close so it settles as run_stopped.
      if (input.signal.aborted) channel.closeAcquisition('run_stopped');
      return unavailable;
    }
    if (result.status !== 'ok') return unavailable;
    const decision = parseRunSupplementIntentDecision(result.text, input.registry);
    return decision ? decideRunSupplement(decision, runFacts) : unavailable;
  };
  channel.bindClassifier(classify);

  const messageIds = new WeakMap<object, string>();
  return {
    bindAgent(agent) {
      if (!isSteerableAgent(agent)) { channel.markUnsupported(); return; }
      channel.bindSteerTarget({
        steer: ({id, text}) => {
          const message = {role: 'user' as const,
            content: [{type: 'text' as const, text: buildRunSupplementMessageText(text, input.outputLanguage)}],
            timestamp: Date.now()};
          messageIds.set(message, id);
          agent.steer(message);
        },
        clear: () => agent.clearSteeringQueue(),
      });
    },
    closeOnFinishedAnswer() {
      const waiting = channel.receipts().some(receipt => receipt.state === 'queued');
      channel.closeAcquisition('window_closed');
      return waiting;
    },
    closeWindow(reason) { channel.closeAcquisition(reason); },
    onEvent(event) {
      if (event.type !== 'message_end' || !event.message || typeof event.message !== 'object') return;
      const id = messageIds.get(event.message);
      if (id) channel.markDelivered(id);
    },
    onPrepareRequest(requestIndex) {
      if (requestIndex !== undefined) channel.assignRequestIndex(requestIndex);
    },
    renderCloseoutSection: () => renderDeliveredSupplements(channel.deliveredTexts(), input.outputLanguage),
  };
}
