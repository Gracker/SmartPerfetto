// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)

import {createHash, randomUUID} from 'node:crypto';
import {PublicRequestError} from '../../utils/publicRequestError';
import {renderRequiredLocalizedStrategyTemplate} from '../../agentv3/localizedStrategyTemplate';
import type {OutputLanguage} from '../../agentv3/outputLanguage';
import type {ConversationContextRequest, ConversationContextReceipt, ConversationContextState} from '../contracts/assistantWorkContract';

export class ConversationContextError extends PublicRequestError {}
const MAX_PENDING = 8;
const MAX_PENDING_BYTES = 16 * 1024;
const MAX_RECEIPTS = 64;
const MAX_EFFECTIVE_QUERY_CHARS = 50_000;
const ID = /^[a-zA-Z0-9_.:-]{1,128}$/;
interface Entry {receipt: ConversationContextReceipt; payloadHash: string; text?: string}

/** Process-memory inbox, owned by one logical session instance; never serialized. */
export class ConversationPendingContext {
  readonly epoch = randomUUID();
  private readonly entries = new Map<string, Entry>();
  state(): ConversationContextState {
    return {availability: 'available', queueEpoch: this.epoch, pendingCount: this.pending().length, durability: 'process_memory'};
  }
  private pending(): Entry[] { return [...this.entries.values()].filter(entry => entry.receipt.status === 'accepted'); }
  append(request: ConversationContextRequest, latestRunId: string | undefined): ConversationContextReceipt {
    if (request.expectedQueueEpoch !== this.epoch) throw new ConversationContextError('CONVERSATION_CONTEXT_EXPIRED',
      'Pending context is no longer available; read the current status and submit it again', 409);
    if (typeof request.idempotencyKey !== 'string' || typeof request.expectedRunId !== 'string' ||
      !ID.test(request.idempotencyKey) || !ID.test(request.expectedRunId) || typeof request.text !== 'string' || !request.text.trim()) {
      throw new ConversationContextError('CONVERSATION_CONTEXT_INVALID', 'A context request needs valid identifiers and nonempty text', 400);
    }
    if (Buffer.byteLength(request.text, 'utf8') > MAX_PENDING_BYTES) {
      throw new ConversationContextError('CONVERSATION_CONTEXT_TOO_LARGE', 'Supplemental context exceeds the byte limit', 413);
    }
    const payloadHash = createHash('sha256').update(JSON.stringify([request.expectedRunId, request.text])).digest('hex');
    const previous = this.entries.get(request.idempotencyKey);
    if (previous) {
      if (previous.payloadHash !== payloadHash) throw new ConversationContextError('CONVERSATION_CONTEXT_KEY_REUSED',
        'This context request identifier already belongs to different input', 409);
      return {...previous.receipt};
    }
    if (latestRunId !== request.expectedRunId) throw new ConversationContextError('CONVERSATION_CONTEXT_RUN_CHANGED',
      'The conversation has moved to another turn; read its status before adding context', 409);
    // Old consumed keys may expire only once their run can no longer accept new input.
    if (this.entries.size >= MAX_RECEIPTS) {
      for (const [key, entry] of this.entries) {
        if (entry.receipt.status === 'consumed' && entry.receipt.expectedRunId !== latestRunId) this.entries.delete(key);
        if (this.entries.size < MAX_RECEIPTS) break;
      }
    }
    const pending = this.pending();
    if (this.entries.size >= MAX_RECEIPTS || pending.length >= MAX_PENDING ||
      pending.reduce((sum, entry) => sum + Buffer.byteLength(entry.text!, 'utf8'), 0) + Buffer.byteLength(request.text, 'utf8') > MAX_PENDING_BYTES) {
      throw new ConversationContextError('CONVERSATION_CONTEXT_FULL', 'Pending context capacity has been reached', 409);
    }
    const receipt: ConversationContextReceipt = {id: request.idempotencyKey, queueEpoch: this.epoch,
      expectedRunId: request.expectedRunId, status: 'accepted', appliesTo: 'next_user_turn', durability: 'process_memory'};
    this.entries.set(request.idempotencyKey, {receipt, payloadHash, text: request.text});
    return {...receipt};
  }
  prepare(question: string, language: OutputLanguage): {query: string; ids: string[]} {
    const pending = this.pending();
    const query = pending.length ? renderRequiredLocalizedStrategyTemplate('prompt-conversation-supplement', language,
      {question, supplements: JSON.stringify(pending.map(entry => ({text: entry.text})))}) : question;
    if (query.length > MAX_EFFECTIVE_QUERY_CHARS) throw new ConversationContextError('CONVERSATION_QUERY_TOO_LARGE',
      'The question and pending context exceed the conversation input limit', 413);
    return {query, ids: pending.map(entry => entry.receipt.id)};
  }
  consume(ids: readonly string[], runId: string): void {
    for (const id of ids) {
      const entry = this.entries.get(id);
      if (entry?.receipt.status !== 'accepted') continue;
      entry.receipt = {...entry.receipt, status: 'consumed', consumedByRunId: runId};
      delete entry.text;
    }
  }
}
