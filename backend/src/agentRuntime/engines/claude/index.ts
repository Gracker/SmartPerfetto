// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import type { TraceProcessorService } from '../../../services/traceProcessorService';
import type { RuntimeSelection } from '../../runtimeSelection';
import type { ClaudeAgentConfig } from './claudeConfig';
import { ClaudeRuntime } from './claudeRuntime';

export function createClaudeRuntime(
  traceProcessorService: TraceProcessorService,
  config?: Partial<ClaudeAgentConfig>,
  runtimeSelection?: RuntimeSelection,
): ClaudeRuntime {
  return new ClaudeRuntime(traceProcessorService, config, runtimeSelection);
}
