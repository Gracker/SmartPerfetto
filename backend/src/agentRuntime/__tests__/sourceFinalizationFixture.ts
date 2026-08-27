// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import fs from 'fs';
import os from 'os';
import path from 'path';

import type {AnalysisResult} from '../../agent/core/orchestratorTypes';
import type {createClaudeMcpServer} from '../../agentv3/claudeMcpServer';
import {ArtifactStore} from '../../agentv3/artifactStore';
import {CodebaseRegistry} from '../../services/codebase/codebaseRegistry';
import type {
  SourceReferenceV1,
  SourceUseDecisionV1,
} from '../../services/codebase/sourceUseDecision';
import {clearCodeAwareOutputGuards} from '../../services/security/codeAwareOutputRegistry';

export const SOURCE_FINALIZATION_CANARY = 'TASK7_RUNTIME_RAW_SOURCE_CANARY';
export const SOURCE_FINALIZATION_FILE_PATH = 'src/Task7Source.kt';
export const SOURCE_FINALIZATION_RAW_SOURCE =
  `object Task7Source { const val marker = "${SOURCE_FINALIZATION_CANARY}" }`;

type CreateClaudeMcpServer = typeof createClaudeMcpServer;
type CreatedClaudeMcpServer = ReturnType<CreateClaudeMcpServer>;

export interface RuntimeSourceFinalizationFixture {
  sessionId: string;
  codebaseId: string;
  sourceUse: CreatedClaudeMcpServer['sourceUse'];
  mcp: CreatedClaudeMcpServer;
  invoke(toolName: string, args?: Record<string, unknown>): Promise<unknown>;
  executeProviderSourceLookup(): Promise<{
    decision: SourceUseDecisionV1;
    reference: SourceReferenceV1;
  }>;
  cleanup(): void;
}

function parseToolResult(value: unknown): unknown {
  if (!value || typeof value !== 'object') return value;
  const content = (value as {content?: Array<{type?: string; text?: string}>}).content;
  const text = content?.find(item => item.type === 'text')?.text;
  if (!text) return value;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export function createRuntimeSourceFinalizationFixture(input: {
  createMcpServer: CreateClaudeMcpServer;
  sessionId: string;
}): RuntimeSourceFinalizationFixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'smartperfetto-task7-source-'));
  const codebaseRoot = path.join(root, 'app');
  const scope = {
    tenantId: 'tenant-task7',
    workspaceId: 'workspace-task7',
    userId: 'user-task7',
  };
  fs.mkdirSync(path.join(codebaseRoot, 'src'), {recursive: true});
  fs.writeFileSync(
    path.join(codebaseRoot, SOURCE_FINALIZATION_FILE_PATH),
    `${SOURCE_FINALIZATION_RAW_SOURCE}\n`,
  );

  const codebaseRegistry = new CodebaseRegistry(path.join(root, 'codebases.json'));
  const registered = codebaseRegistry.register({
    kind: 'app_source',
    displayName: 'Task 7 App',
    rootPath: codebaseRoot,
    rootAuthorization: 'native_picker',
    pathFilters: ['src'],
    sendToProvider: true,
    ...scope,
  });
  const mcp = input.createMcpServer({
    traceId: `trace-${input.sessionId}`,
    userQuery: 'Analyze the registered Task 7 source fixture.',
    traceProcessorService: {
      query: async () => ({columns: [], rows: [], durationMs: 0}),
    },
    skillExecutor: {
      execute: async () => ({
        skillId: 'task7-fixture',
        success: true,
        displayResults: [],
        diagnostics: [],
        executionTimeMs: 0,
      }),
      replaceRegisteredSkills: () => undefined,
      registerSkills: () => undefined,
      registerSkill: () => undefined,
      setFragmentRegistry: () => undefined,
      setRunManifestAttributionSink: () => undefined,
    },
    analysisNotes: [],
    hypotheses: [],
    uncertaintyFlags: [],
    watchdogWarning: {current: null},
    artifactStore: new ArtifactStore(),
    codeAwareMode: 'provider_send',
    codebaseIds: [registered.codebaseId],
    codebaseRegistry,
    knowledgeScope: scope,
    sessionId: input.sessionId,
    lightweight: true,
    conversationTraceAttached: true,
  } as any);

  const invoke = async (
    toolName: string,
    args: Record<string, unknown> = {},
  ): Promise<unknown> => {
    const definition = mcp.toolDefinitions.find(candidate => candidate.name === toolName);
    if (!definition) throw new Error(`Task 7 fixture tool not found: ${toolName}`);
    return parseToolResult(await definition.shared.handler(args, {}));
  };

  return {
    sessionId: input.sessionId,
    codebaseId: registered.codebaseId,
    sourceUse: mcp.sourceUse,
    mcp,
    invoke,
    async executeProviderSourceLookup() {
      const searchResult = await invoke('search_codebase', {
        query: 'TASK7_RUNTIME_RAW_SOURCE_CANARY',
        max_results: 4,
      });
      if (!searchResult || (searchResult as {success?: boolean}).success !== true) {
        throw new Error('Task 7 real search_codebase handler did not succeed');
      }
      const readResult = await invoke('read_codebase_file', {
        file_path: SOURCE_FINALIZATION_FILE_PATH,
        start_line: 1,
        end_line: 1,
      });
      if (!readResult || (readResult as {success?: boolean}).success !== true) {
        throw new Error('Task 7 real read_codebase_file handler did not succeed');
      }
      const decision = mcp.sourceUse.getSourceUseDecision();
      const reference = decision?.references.find(candidate => candidate.lookupKind === 'body');
      if (!decision || !reference) {
        throw new Error('Task 7 real source handler did not produce body provenance');
      }
      return {decision, reference};
    },
    cleanup() {
      clearCodeAwareOutputGuards(input.sessionId);
      fs.rmSync(root, {recursive: true, force: true});
    },
  };
}

export function createSourceAuthoredAnalysisResult(sessionId: string): AnalysisResult {
  return {
    sessionId,
    success: true,
    findings: [{
      id: 'finding-task7',
      severity: 'high',
      title: `Finding ${SOURCE_FINALIZATION_RAW_SOURCE}`,
      description: `Description ${SOURCE_FINALIZATION_RAW_SOURCE}`,
      details: {
        traceId: 'trace-task7',
        narrative: SOURCE_FINALIZATION_RAW_SOURCE,
      },
    }],
    hypotheses: [{
      id: 'hypothesis-task7',
      description: `Hypothesis ${SOURCE_FINALIZATION_RAW_SOURCE}`,
      confidence: 0.8,
      status: 'confirmed',
      supportingEvidence: [{
        id: 'trace-evidence-task7',
        description: SOURCE_FINALIZATION_RAW_SOURCE,
        source: 'trace-task7',
        type: 'observation',
        strength: 0.8,
      }],
      contradictingEvidence: [],
      proposedBy: 'task7-fixture',
      createdAt: 1,
      updatedAt: 2,
    }],
    conclusion: `Final conclusion ${SOURCE_FINALIZATION_RAW_SOURCE}`,
    conclusionContract: {
      schemaVersion: 'conclusion_contract_v1',
      mode: 'focused_answer',
      conclusions: [{rank: 1, statement: `Statement ${SOURCE_FINALIZATION_RAW_SOURCE}`}],
      clusters: [],
      evidenceChain: [{conclusionId: 'conclusion-task7', text: SOURCE_FINALIZATION_RAW_SOURCE}],
      claims: [{
        id: 'claim-task7',
        text: `Claim ${SOURCE_FINALIZATION_RAW_SOURCE}`,
        references: [{sourceRef: SOURCE_FINALIZATION_RAW_SOURCE}],
      }],
      uncertainties: [SOURCE_FINALIZATION_RAW_SOURCE],
      nextSteps: [SOURCE_FINALIZATION_RAW_SOURCE],
    },
    confidence: 0.8,
    rounds: 1,
    totalDurationMs: 10,
    terminationMessage: `Termination ${SOURCE_FINALIZATION_RAW_SOURCE}`,
  };
}
