// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import express from 'express';
import {projectDataEnvelopePreview, projectDataEventPayload, projectSerializedDataEvent} from './dataEnvelopePreview';
import type { StreamingUpdate } from '../../agent';
import {
  generateEventId,
  isDataEvent,
  isLegacySkillEvent,
  type DataEnvelope,
  type ValidationError,
  validateDataEnvelope,
} from '../../types/dataContract';

/**
 * A buffered SSE event for replay on reconnect.
 * Stored in a per-session ring buffer so late-joining clients can catch up.
 */
export interface BufferedSseEvent {
  seqId: number;
  eventType: string;
  eventData: string;
  runId?: string;
}

/** Max events retained in the per-session ring buffer. */
export const SSE_RING_BUFFER_SIZE = 200;

export interface BroadcastStreamingUpdateOptions {
  observability?: {
    runId?: string;
    requestId?: string;
    runSequence?: number;
  };
  /** Monotonic sequence ID — set by the caller from the session counter. */
  seqId?: number;
  /** Called with the buffered event so the caller can push it to the ring buffer. */
  onBufferedEvent?: (event: BufferedSseEvent) => void;
  onValidDataEnvelopes?: (envelopes: DataEnvelope[]) => void;
  /** Called per rejected envelope with log-safe fields only (`dataEnvelopeValidationLogFields`). */
  onDataEnvelopeValidationWarning?: (payload: DataEnvelopeValidationWarning) => void;
}

/**
 * What a log may record about an envelope that failed validation: where each
 * error is and what it says, and the envelope's schema identity. Never the
 * envelope itself or an error's `value`, which can hold its rows, columns or
 * a source-derived string.
 */
export interface DataEnvelopeValidationWarning {
  sessionId: string;
  envelopeIndex: number;
  errors: Array<{path: string; message: string}>;
  totalErrors: number;
  envelope: {
    metaType?: string;
    metaVersion?: string;
    metaSource?: string;
    skillId?: string;
    stepId?: string;
    displayLayer?: string;
    displayFormat?: string;
  };
}

const LOGGED_VALIDATION_ERRORS = 5;
const LOGGED_FIELD_CHARS = 160;

function loggedIdentifier(value: unknown): string | undefined {
  return typeof value === 'string' ? value.slice(0, LOGGED_FIELD_CHARS) : undefined;
}

function dataEnvelopeValidationLogFields(
  sessionId: string,
  envelopeIndex: number,
  envelope: any,
  errors: ValidationError[],
): DataEnvelopeValidationWarning {
  return {
    sessionId,
    envelopeIndex,
    errors: errors.slice(0, LOGGED_VALIDATION_ERRORS).map(error => ({
      path: String(error.path).slice(0, LOGGED_FIELD_CHARS),
      message: String(error.message).slice(0, LOGGED_FIELD_CHARS),
    })),
    totalErrors: errors.length,
    envelope: {
      metaType: loggedIdentifier(envelope?.meta?.type),
      metaVersion: loggedIdentifier(envelope?.meta?.version),
      metaSource: loggedIdentifier(envelope?.meta?.source),
      skillId: loggedIdentifier(envelope?.meta?.skillId),
      stepId: loggedIdentifier(envelope?.meta?.stepId),
      displayLayer: loggedIdentifier(envelope?.display?.layer),
      displayFormat: loggedIdentifier(envelope?.display?.format),
    },
  };
}

export class StreamProjector {
  private withObservability(
    payload: Record<string, unknown>,
    observability?: BroadcastStreamingUpdateOptions['observability']
  ): Record<string, unknown> {
    if (!observability) return payload;
    const next: Record<string, unknown> = { ...payload };
    if (typeof observability.runId === 'string' && observability.runId.trim()) {
      next.runId = observability.runId.trim();
    }
    if (typeof observability.requestId === 'string' && observability.requestId.trim()) {
      next.requestId = observability.requestId.trim();
    }
    if (typeof observability.runSequence === 'number' && Number.isFinite(observability.runSequence)) {
      next.runSequence = Math.max(0, Math.floor(observability.runSequence));
    }
    return next;
  }

  setSseHeaders(res: express.Response): void {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
  }

  sendEvent(res: express.Response, eventType: string, payload: unknown, seqId?: number): void {
    if (seqId !== undefined) {
      res.write(`id: ${seqId}\n`);
    }
    res.write(`event: ${eventType}\n`);
    res.write(`data: ${JSON.stringify(projectDataEventPayload(eventType, payload))}\n\n`);
  }

  sendConnected(res: express.Response, payload: unknown): void {
    this.sendEvent(res, 'connected', payload);
  }

  sendError(
    res: express.Response,
    errorMessage: string | undefined,
    observability?: BroadcastStreamingUpdateOptions['observability']
  ): void {
      this.sendEvent(
      res,
      'error',
      this.withObservability(
        { error: errorMessage, message: errorMessage, timestamp: Date.now() },
        observability
      )
    );
  }

  sendEnd(
    res: express.Response,
    observability?: BroadcastStreamingUpdateOptions['observability']
  ): void {
    this.sendEvent(res, 'end', this.withObservability({ timestamp: Date.now() }, observability));
  }

  bindKeepAlive(req: express.Request, res: express.Response, intervalMs = 30000): void {
    const keepAlive = setInterval(() => {
      try {
        res.write(`: keep-alive\n\n`);
      } catch {
        clearInterval(keepAlive);
      }
    }, intervalMs);

    req.on('close', () => {
      clearInterval(keepAlive);
    });
  }

  broadcastStreamingUpdate(
    sessionId: string,
    clients: express.Response[],
    update: StreamingUpdate,
    options: BroadcastStreamingUpdateOptions = {}
  ): void {
    const eventType = update.type;
    let eventData: string;

    if (isDataEvent(eventType)) {
      const envelopes = Array.isArray(update.content) ? update.content : [update.content];
      const validationResults = envelopes.map((envelope) => ({
        envelope,
        errors: validateDataEnvelope(envelope),
      }));
      for (let i = 0; i < validationResults.length; i++) {
        const {envelope, errors} = validationResults[i];
        if (errors.length > 0) {
          options.onDataEnvelopeValidationWarning?.(dataEnvelopeValidationLogFields(sessionId, i, envelope, errors));
        }
      }

      const validEnvelopes = validationResults
        .filter(({errors}) => errors.length === 0)
        .map(({envelope}) => envelope as DataEnvelope);
      if (validEnvelopes.length > 0) {
        options.onValidDataEnvelopes?.(validEnvelopes);
      }

      const previews = validEnvelopes.map(projectDataEnvelopePreview);
      const projectedEnvelope = Array.isArray(update.content)
        ? previews
        : previews[0] ?? [];

      eventData = JSON.stringify(this.withObservability({
        type: 'data',
        id: update.id || generateEventId('sse', sessionId),
        envelope: projectedEnvelope,
        timestamp: update.timestamp,
      }, options.observability));
    } else if (isLegacySkillEvent(eventType)) {
      eventData = JSON.stringify(this.withObservability({
        type: update.type,
        id: update.id || generateEventId('sse', sessionId),
        data: update.content,
        timestamp: update.timestamp,
      }, options.observability));
    } else {
      eventData = JSON.stringify(this.withObservability({
        type: update.type,
        id: update.id || generateEventId('sse', sessionId),
        data: update.content,
        timestamp: update.timestamp,
      }, options.observability));
    }

    // Buffer the event for replay on reconnect
    if (options.seqId !== undefined) {
      options.onBufferedEvent?.({ seqId: options.seqId, eventType, eventData });
    }

    for (const client of clients) {
      try {
        if (options.seqId !== undefined) {
          client.write(`id: ${options.seqId}\n`);
        }
        client.write(`event: ${eventType}\n`);
        client.write(`data: ${eventData}\n\n`);
      } catch {
        // Ignore broken pipe errors; disconnection is handled elsewhere.
      }
    }
  }

  /**
   * Replay buffered events to a single client that reconnected.
   * Sends all events with seqId > lastEventId.
   */
  replayBufferedEvents(
    res: express.Response,
    buffer: BufferedSseEvent[],
    lastEventId: number
  ): number {
    let replayed = 0;
    for (const event of buffer) {
      if (event.seqId > lastEventId) {
        try {
          res.write(`id: ${event.seqId}\n`);
          res.write(`event: ${event.eventType}\n`);
          res.write(`data: ${projectSerializedDataEvent(event.eventType, event.eventData)}\n\n`);
          replayed++;
        } catch {
          break; // Client disconnected during replay
        }
      }
    }
    return replayed;
  }
}
