import express from 'express';
import type { StreamingUpdate } from '../../agent';
import {
  generateEventId,
  isDataEvent,
  isLegacySkillEvent,
  type DataEnvelope,
  type ValidationError,
  validateDataEnvelope,
} from '../../types/dataContract';

export interface BroadcastStreamingUpdateOptions {
  observability?: {
    runId?: string;
    requestId?: string;
    runSequence?: number;
  };
  onValidDataEnvelopes?: (envelopes: DataEnvelope[]) => void;
  onDataEnvelopeValidationWarning?: (payload: {
    sessionId: string;
    envelopeIndex: number;
    errors: ValidationError[];
    envelope: {
      metaType?: string;
      metaSource?: string;
      displayLayer?: string;
      displayFormat?: string;
    };
  }) => void;
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

  sendEvent(res: express.Response, eventType: string, payload: unknown): void {
    res.write(`event: ${eventType}\n`);
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
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
      for (let i = 0; i < envelopes.length; i++) {
        const envelope = envelopes[i];
        const validationErrors = validateDataEnvelope(envelope);
        if (validationErrors.length > 0) {
          options.onDataEnvelopeValidationWarning?.({
            sessionId,
            envelopeIndex: i,
            errors: validationErrors,
            envelope: {
              metaType: envelope?.meta?.type,
              metaSource: envelope?.meta?.source,
              displayLayer: envelope?.display?.layer,
              displayFormat: envelope?.display?.format,
            },
          });
        }
      }

      const validEnvelopes = envelopes.filter(
        (envelope): envelope is DataEnvelope => !!envelope && !!envelope.data
      );
      if (validEnvelopes.length > 0) {
        options.onValidDataEnvelopes?.(validEnvelopes);
      }

      eventData = JSON.stringify(this.withObservability({
        type: 'data',
        id: update.id || generateEventId('sse', sessionId),
        envelope: update.content,
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

    for (const client of clients) {
      try {
        client.write(`event: ${eventType}\n`);
        client.write(`data: ${eventData}\n\n`);
      } catch {
        // Ignore broken pipe errors; disconnection is handled elsewhere.
      }
    }
  }
}
