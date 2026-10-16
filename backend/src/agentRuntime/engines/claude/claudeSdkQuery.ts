// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {query} from '@anthropic-ai/claude-agent-sdk';

/**
 * The only way SmartPerfetto calls the Claude Agent SDK `query`.
 *
 * The SDK persists every session transcript to the local Claude session store
 * unless told otherwise. Nothing here reads one back: follow-ups start a fresh
 * native context, and within a run the CLI keeps the conversation, sub-agents
 * and auto-compaction in memory. A persisted transcript would be trace and
 * source content written to disk for no reader, so persistence is forced off
 * here rather than left to each caller.
 */
export function claudeSdkQuery(params: Parameters<typeof query>[0]): ReturnType<typeof query> {
  return query({...params, options: {...params.options, persistSession: false}});
}
