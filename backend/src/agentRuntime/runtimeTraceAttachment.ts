// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import type {AnalysisOptions} from '../agent/core/orchestratorTypes';

type TraceAttachmentOptions = Pick<AnalysisOptions, 'assistantSurface' | 'conversationTraceAttached' | 'referenceTraceId'>;

/**
 * Whether this run analyzes a mounted trace. A conversation may run without
 * one; its trace id is then a session placeholder (`conversation-no-trace:<id>`)
 * that no probe, evidence read or trace identity may use. Every runtime asks
 * here instead of reading the two options itself.
 */
export function runAttachesTrace(options: TraceAttachmentOptions): boolean {
  return options.assistantSurface !== 'conversation' || options.conversationTraceAttached === true;
}

/** The MCP server's option: decided for conversations, absent elsewhere. */
export function conversationTraceAttachedOption(options: TraceAttachmentOptions): boolean | undefined {
  return options.assistantSurface === 'conversation' ? options.conversationTraceAttached === true : undefined;
}

export interface RunTraceIdentity {
  currentTraceId?: string;
  referenceTraceId?: string;
}

/** The traces a run's finalization and evidence reads are bound to; none for a trace-less conversation. */
export function runTraceIdentity(traceId: string | undefined, options: TraceAttachmentOptions): RunTraceIdentity {
  const currentTraceId = traceId && runAttachesTrace(options) ? traceId : undefined;
  return {currentTraceId, referenceTraceId: currentTraceId ? options.referenceTraceId : undefined};
}

/** The evidence read view's trace allowlist for a run's trace identity. */
export function runAllowedTraces(identity: RunTraceIdentity): Array<{traceId: string; traceSide: 'current' | 'reference'}> {
  return [
    ...(identity.currentTraceId ? [{traceId: identity.currentTraceId, traceSide: 'current' as const}] : []),
    ...(identity.referenceTraceId ? [{traceId: identity.referenceTraceId, traceSide: 'reference' as const}] : []),
  ];
}
