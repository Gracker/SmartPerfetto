// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)

import {currentRunManifestAttributionSink} from '../services/selfEvolution/runManifestLifecycle';
import {bindRuntimePerformanceContext, currentModelRequestPurpose, resolveRuntimePerformanceRecorder,
  type RuntimePerformanceSource} from './runtimePerformanceContext';
import {MODEL_REQUEST_COMPONENTS, type ModelRequestBodyMetrics, type RuntimeModelDispatchPurpose,
  type RuntimeModelCallTrigger, type RuntimeModelRequestSpan} from './runtimePerformance';

type Component = typeof MODEL_REQUEST_COMPONENTS[number];

const MAX_NORMALIZED_BODY_BYTES = 2 * 1024 * 1024;
const object = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const jsonBytes = (value: unknown): number => Buffer.byteLength(JSON.stringify(value) ?? '', 'utf8');

/** Only directly available bodies: never inspect, clone or consume a Request/stream. */
export function measureModelRequestBody(body: unknown): ModelRequestBodyMetrics {
  let bodyBytes: number;
  let text: string;
  if (typeof body === 'string') {
    bodyBytes = Buffer.byteLength(body, 'utf8');
    if (bodyBytes > MAX_NORMALIZED_BODY_BYTES) return {status: 'observed', bodyBytes, normalizedUnavailableReason: 'too_large'};
    text = body;
  } else if (body instanceof ArrayBuffer || ArrayBuffer.isView(body)) {
    const bytes = body instanceof ArrayBuffer ? new Uint8Array(body)
      : new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
    bodyBytes = bytes.byteLength;
    if (bodyBytes > MAX_NORMALIZED_BODY_BYTES) return {status: 'observed', bodyBytes, normalizedUnavailableReason: 'too_large'};
    try { text = new TextDecoder('utf-8', {fatal: true}).decode(bytes); }
    catch { return {status: 'observed', bodyBytes, normalizedUnavailableReason: 'non_json'}; }
  } else return {status: 'body_unobservable'};
  let parsed: unknown;
  try { parsed = JSON.parse(text); }
  catch { return {status: 'observed', bodyBytes, normalizedUnavailableReason: 'non_json'}; }
  const root = object(parsed);
  if (!root) return {status: 'observed', bodyBytes, normalizedUnavailableReason: 'unsupported_shape'};
  try {
    const components = Object.fromEntries(MODEL_REQUEST_COMPONENTS.map(key => [key, 0])) as Record<Component, number>;
    const add = (key: Component, value: unknown) => { if (value !== undefined) components[key] += jsonBytes(value); };
    const content = (value: unknown, role: Component) => {
      if (!Array.isArray(value)) { add(role, value); return; }
      for (const part of value) {
        const block = object(part);
        if (block?.type === 'tool_use') add('toolArguments', block.input);
        else if (block?.type === 'tool_result') add('toolResults', block.content);
        else if (block?.type === 'thinking') add('reasoning', block.thinking);
        else add(role, part);
      }
    };
    add('system', root.instructions);
    add('system', root.system);
    if (Array.isArray(root.tools)) for (const raw of root.tools) {
      const tool = object(raw);
      const spec = object(tool?.function) ?? tool;
      add('toolDescription', spec?.description);
      add('toolSchema', spec?.parameters ?? spec?.input_schema);
    }
    const messages = root.messages ?? root.input;
    if (typeof messages === 'string') add('user', messages);
    else if (Array.isArray(messages)) for (const raw of messages) {
      const message = object(raw);
      if (!message) continue;
      if (message.type === 'function_call') add('toolArguments', message.arguments);
      else if (message.type === 'function_call_output') add('toolResults', message.output);
      else if (message.type === 'reasoning') add('reasoning', message);
      else {
        const role = message.role === 'system' || message.role === 'developer' ? 'system'
          : message.role === 'user' ? 'user' : message.role === 'assistant' ? 'assistant'
            : message.role === 'tool' ? 'toolResults' : undefined;
        if (role) content(message.content, role);
        add('reasoning', message.reasoning_content);
        add('reasoning', message.reasoning);
        if (Array.isArray(message.tool_calls)) for (const call of message.tool_calls) {
          add('toolArguments', object(object(call)?.function)?.arguments);
        }
      }
    }
    const totalBytes = jsonBytes(root);
    // The remainder includes JSON framing, identities, options and unknown fields.
    components.other = totalBytes - Object.values(components).reduce((sum, value) => sum + value, 0);
    return {status: 'observed', bodyBytes,
      normalized: {measurement: 'normalized_json_utf8', totalBytes, components}};
  } catch { return {status: 'observed', bodyBytes, normalizedUnavailableReason: 'unsupported_shape'}; }
}

const observedFetches = new WeakSet<typeof fetch>();
export function createModelRequestMetricsFetch(baseFetch: typeof fetch, options: {
  source?: RuntimePerformanceSource;
  purpose?: () => {purpose?: RuntimeModelDispatchPurpose; trigger?: RuntimeModelCallTrigger};
} = {}): typeof fetch {
  if (observedFetches.has(baseFetch)) return baseFetch;
  const wrapped: typeof fetch = bindRuntimePerformanceContext((input, init) => {
    let span: RuntimeModelRequestSpan | undefined;
    try {
      const recorder = resolveRuntimePerformanceRecorder(options.source, currentRunManifestAttributionSink());
      if (recorder) span = recorder.startModelRequest({
        ...(currentModelRequestPurpose() ?? options.purpose?.()), body: measureModelRequestBody(init?.body),
      });
    } catch { /* Measurement cannot affect a provider request. */ }
    const observe = (callback: (value: RuntimeModelRequestSpan) => void) => {
      try { if (span) callback(span); } catch { /* Observability only. */ }
    };
    let signal: AbortSignal | null | undefined;
    const onAbort = () => observe(value => value.fail(true));
    try {
      signal = init?.signal ?? (typeof Request !== 'undefined' && input instanceof Request ? input.signal : undefined);
      if (span && signal) {
        if (signal.aborted) onAbort();
        else signal.addEventListener('abort', onAbort, {once: true});
      }
    } catch { /* Signal observation does not change dispatch. */ }
    const cleanup = () => { try { signal?.removeEventListener('abort', onAbort); } catch { /* Observability only. */ } };
    try {
      return baseFetch(input, init).then(response => {
        cleanup();
        observe(value => value.headers(response.status));
        return response;
      }, error => {
        cleanup();
        observe(value => value.fail(signal?.aborted === true));
        throw error;
      });
    } catch (error) {
      cleanup();
      observe(value => value.fail(signal?.aborted === true));
      throw error;
    }
  });
  observedFetches.add(wrapped);
  return wrapped;
}
