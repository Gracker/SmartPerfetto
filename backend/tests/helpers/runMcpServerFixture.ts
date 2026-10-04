// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

/**
 * A run's MCP server as a runtime builds it, with stub trace and Skill
 * executors, plus a caller that returns a tool's parsed payload. Registries,
 * stores and the code lookup ledger default to the production defaults, so a
 * test that spies the default getters sees the production wiring.
 */

import {createClaudeMcpServer} from '../../src/agentv3/claudeMcpServer';
import {ArtifactStore} from '../../src/agentv3/artifactStore';
import type {CodebaseRegistry} from '../../src/services/codebase/codebaseRegistry';
import type {CodeAwareMode} from '../../src/services/codebase/codeAwareFeature';
import type {SourceDepthDecisionV1} from '../../src/services/codebase/sourceDepthPolicy';

export interface RunMcpServerInput {
  sessionId: string;
  traceId?: string;
  runId?: string;
  knowledgeScope: {tenantId: string; workspaceId: string; userId?: string};
  codeAwareMode?: CodeAwareMode;
  codebaseIds?: string[];
  knowledgeSourceIds?: string[];
  analysisContextFingerprint?: string;
  sourceDepthDecision?: SourceDepthDecisionV1;
  allowNewEvidence?: boolean;
  codebaseRegistry?: CodebaseRegistry;
}

export function createRunMcpServer(input: RunMcpServerInput) {
  const server = createClaudeMcpServer({
    traceId: input.traceId ?? `trace-${input.sessionId}`,
    userQuery: 'fixture',
    sessionId: input.sessionId,
    runId: input.runId,
    traceProcessorService: {query: async () => ({columns: [], rows: [], durationMs: 0})},
    skillExecutor: {
      execute: async () => ({skillId: 'fixture', success: true, displayResults: [], diagnostics: [], executionTimeMs: 0}),
      replaceRegisteredSkills: () => undefined, registerSkills: () => undefined, registerSkill: () => undefined,
      setFragmentRegistry: () => undefined, setRunManifestAttributionSink: () => undefined,
    },
    analysisNotes: [], hypotheses: [], uncertaintyFlags: [], watchdogWarning: {current: null},
    analysisPlan: {current: null}, artifactStore: new ArtifactStore(), androidInternalsPackStore: null,
    codeAwareMode: input.codeAwareMode,
    codebaseIds: input.codebaseIds,
    knowledgeSourceIds: input.knowledgeSourceIds,
    analysisContextFingerprint: input.analysisContextFingerprint,
    knowledgeScope: input.knowledgeScope,
    allowNewEvidence: input.allowNewEvidence,
    ...(input.sourceDepthDecision ? {sourceDepthDecision: input.sourceDepthDecision} : {}),
    ...(input.codebaseRegistry ? {codebaseRegistry: input.codebaseRegistry} : {}),
  } as any);
  const names = server.toolDefinitions.map(definition => definition.name).sort();
  /** The tool's parsed payload; `{notRegistered}` when the run does not have the tool. */
  const invoke = async (name: string, args: Record<string, unknown>): Promise<Record<string, any>> => {
    const definition = server.toolDefinitions.find(candidate => candidate.name === name);
    if (!definition) return {notRegistered: name};
    const result = await definition.shared.handler(args, {}) as {content?: Array<{text?: string}>};
    return JSON.parse(result.content?.[0]?.text ?? '{}');
  };
  return {...server, names, invoke};
}
