// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

/**
 * What the model actually receives after a source authorization change.
 *
 * A real OpenAI runtime builds its real system prompt and real MCP tools,
 * `read_codebase_file` and `read_session_history` included; only the model
 * transport and the trace preflight (architecture, completeness) are faked.
 * Turn 1 reads a registered file through the run's own source tool and the
 * model quotes it. Turn 2 runs on the same session under another
 * authorization fingerprint: no model request (system prompt, history
 * preview, tool results), classification input or history read may carry the
 * quotation. The same session under the same authorization reads it back,
 * which proves the probe can see it.
 */

import {afterEach, beforeEach, describe, expect, it, jest} from '@jest/globals';
import fs from 'fs';
import os from 'os';
import path from 'path';

import {OpenAIRuntime} from '../engines/openai/openAiRuntime';
import * as configModule from '../engines/openai/openAiConfig';
import * as intentTransport from '../engines/openai/openAiIntentTransport';
import {chatCompletionResponse, chatCompletionToolCall, createOpenAiConfigForTest} from '../../../tests/helpers/openAiRuntimeFixture';
import type {AnalysisOptions} from '../../agent/core/orchestratorTypes';
import {takeFinalizationContext} from '../analysisFinalizationContext';
import {sessionContextManager} from '../../agent/context/enhancedSessionContext';
import {createClaudeMcpServer} from '../../agentv3/claudeMcpServer';
import * as defaultCodebaseServices from '../../services/codebase/defaultCodebaseServices';
import {ENTERPRISE_DB_PATH_ENV} from '../../services/enterpriseDb';
import {createRuntimeSourceFinalizationFixture, SOURCE_FINALIZATION_CANARY, SOURCE_FINALIZATION_FILE_PATH,
  type RuntimeSourceFinalizationFixture} from './sourceFinalizationFixture';
import type {TraceProcessorService} from '../../services/traceProcessorService';
import {buildAnalysisContextAuthorizationFingerprint} from '../../services/resolvedAnalysisContext';

const TRACE_ID = 'trace-source-history-gate';
const FIRST_RUN_ID = 'source-history-gate-run-1';
const SYSTEM_PROMPT_PROBE = 'source_authorization';

const answer = (id: string, text: string) => chatCompletionResponse(id, {role: 'assistant', content: text}, 'stop');

interface ProviderRequest {
  messages: Array<{role: string; content?: unknown; tool_call_id?: string}>;
  tools?: Array<{function?: {name?: string}}>;
}

let tmpDir: string;
let fixture: RuntimeSourceFinalizationFixture;
let runtime: OpenAIRuntime;
let sessionId: string;
let intentInputs: unknown[];
const previousDbPath = process.env[ENTERPRISE_DB_PATH_ENV];

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'source-history-gate-'));
  process.env[ENTERPRISE_DB_PATH_ENV] = path.join(tmpDir, 'history.sqlite');
  sessionId = `source-history-gate-${Math.random().toString(36).slice(2, 10)}`;
  fixture = createRuntimeSourceFinalizationFixture({createMcpServer: createClaudeMcpServer, sessionId});
  // The run's MCP server, its authorization checks and the fingerprint all read the fixture's registry.
  jest.spyOn(defaultCodebaseServices, 'getDefaultCodebaseRegistry').mockReturnValue(fixture.codebaseRegistry);
  jest.spyOn(configModule, 'loadOpenAIConfig').mockReturnValue(createOpenAiConfigForTest({protocol: 'chat_completions',
    maxTurns: 6, quickMaxTurns: 6, quickTargetTurns: 3, outputLanguage: 'en'}));
  intentInputs = [];
  jest.spyOn(intentTransport, 'runOpenAiIntentTransport').mockImplementation(async input => {
    intentInputs.push(input);
    return {status: 'ok', actualModel: 'pinned-light', finishReason: 'stop', text: JSON.stringify({
      schemaVersion: 1, taskKind: 'fact', sceneId: 'general', scope: 'bounded_question',
      recommendedComplexity: 'quick', deliverable: 'answer', evidenceAccess: 'read_new'})};
  });
  runtime = new OpenAIRuntime({query: jest.fn(async () => ({columns: [], rows: [], durationMs: 0})),
    getTrace: jest.fn()} as unknown as TraceProcessorService);
  jest.spyOn(runtime as any, 'recordPatternMemory').mockImplementation(() => undefined);
  // Trace preflight is irrelevant to source history; the stubbed processor holds no trace.
  jest.spyOn(runtime as any, 'detectArchitecture').mockResolvedValue(undefined);
  jest.spyOn(runtime as any, 'detectCompleteness').mockResolvedValue(undefined);
});

afterEach(() => {
  runtime.reset();
  sessionContextManager.remove(sessionId);
  fixture.cleanup();
  jest.restoreAllMocks();
  if (previousDbPath === undefined) delete process.env[ENTERPRISE_DB_PATH_ENV];
  else process.env[ENTERPRISE_DB_PATH_ENV] = previousDbPath;
  fs.rmSync(tmpDir, {recursive: true, force: true});
});

/** As every product caller does, the run carries the fingerprint of its own authorization and owner. */
async function analyze(selection: AnalysisOptions, runId: string) {
  const options: AnalysisOptions = {providerId: null, analysisMode: 'fast', runId, ...fixture.scope, ...selection};
  options.analysisContextFingerprint = buildAnalysisContextAuthorizationFingerprint(options, fixture.scope);
  const result = await runtime.analyze('What does the startup marker say?', sessionId, TRACE_ID, options);
  takeFinalizationContext(result)?.dispose();
  return result;
}

/** Scripted model responses; a declaration repair the runtime asks for gets the last body back. */
function modelTransport(responses: Response[], fallbackBody: string) {
  const fetchMock = jest.spyOn(globalThis, 'fetch').mockImplementation(async () => answer('repair', fallbackBody));
  for (const response of responses) fetchMock.mockResolvedValueOnce(response);
  return {
    fetchMock,
    requests: (): ProviderRequest[] => fetchMock.mock.calls.map(([, init]) => JSON.parse(String(init?.body))),
  };
}

/** Turn 1: the model calls the run's real source tool and quotes what it returned. */
async function readSourceThenAnswer(): Promise<void> {
  const quoted = `The startup marker is ${SOURCE_FINALIZATION_CANARY}.`;
  const transport = modelTransport([
    chatCompletionToolCall('read', 'read_codebase_file', {codebase_id: fixture.codebaseId, file_path: SOURCE_FINALIZATION_FILE_PATH,
      start_line: 1, max_lines: 1}),
    answer('quote', quoted),
  ], quoted);
  const result = await analyze({codeAwareMode: 'provider_send', codebaseIds: [fixture.codebaseId]}, FIRST_RUN_ID);
  const [first, second] = transport.requests();
  expect(first.tools?.map(entry => entry.function?.name)).toEqual(
    expect.arrayContaining(['read_codebase_file', 'read_session_history']));
  // The real tool delivered the body to the model, and the answer kept it.
  const toolResult = second.messages.find(message => message.role === 'tool');
  expect(String(toolResult?.content)).toContain(SOURCE_FINALIZATION_CANARY);
  expect(result.conclusion).toContain(SOURCE_FINALIZATION_CANARY);
  const stored = sessionContextManager.get(sessionId, TRACE_ID)!.getAnalysisHistory();
  expect(stored).toEqual([expect.objectContaining({id: FIRST_RUN_ID, sourceDerived: true,
    analysisContextFingerprint: expect.stringMatching(/^acf2:/)})]);
  expect(JSON.stringify(stored)).toContain(SOURCE_FINALIZATION_CANARY);
  transport.fetchMock.mockRestore();
}

/** Turn 2 on the same session: every model-facing channel, read through the production tools. */
async function nextTurnModelInput(options: AnalysisOptions) {
  intentInputs.length = 0;
  const final = 'The earlier turn is not needed.';
  const transport = modelTransport([
    chatCompletionToolCall('history-turn', 'read_session_history', {turnId: FIRST_RUN_ID}),
    chatCompletionToolCall('history-index', 'read_session_history', {}),
    answer('final', final),
  ], final);
  await analyze(options, 'source-history-gate-run-2');
  const requests = transport.requests();
  transport.fetchMock.mockRestore();
  // The tool message carries the MCP result envelope; its text part is the reader's payload.
  const toolResult = (callId: string) => {
    const envelope = JSON.parse(String(requests.flatMap(request => request.messages)
      .find(message => message.role === 'tool' && message.tool_call_id === callId)?.content));
    const text = (Array.isArray(envelope) ? envelope : envelope.content)?.find((part: {type?: string}) => part.type === 'text')?.text;
    return JSON.parse(text);
  };
  return {
    systemPrompt: String(requests[0].messages.find(message => message.role === 'system')?.content),
    requests: JSON.stringify(requests),
    classification: JSON.stringify(intentInputs),
    historyTurn: toolResult('history-turn-call'),
    historyIndex: toolResult('history-index-call'),
  };
}

describe('source-derived history after an authorization change (real runtime model input)', () => {
  it.each([
    ['off', {codeAwareMode: 'off' as const}],
    ['off with codebase ids', {codeAwareMode: 'off' as const, codebaseIds: ['ignored-under-off']}],
    ['metadata_only', {codeAwareMode: 'metadata_only' as const}],
  ])('keeps the quoted source out of every model channel under %s', async (_label, selection) => {
    await readSourceThenAnswer();
    const codebaseIds = 'codebaseIds' in selection ? selection.codebaseIds : [fixture.codebaseId];
    const input = await nextTurnModelInput({...selection, codebaseIds});
    // The production system prompt was built for this run.
    expect(input.systemPrompt).toContain(SYSTEM_PROMPT_PROBE);
    // System and user messages, the history preview and tool results of every request.
    expect(input.requests).not.toContain(SOURCE_FINALIZATION_CANARY);
    // The classifier's context, which carries the history preview too.
    expect(input.classification).not.toContain(SOURCE_FINALIZATION_CANARY);
    // The production read_session_history neither serves nor lists the earlier turn.
    expect(input.historyTurn).toMatchObject({success: false, error: 'analysis_history_turn_unavailable'});
    expect(input.historyIndex).toMatchObject({success: true});
    expect(JSON.stringify(input.historyIndex.entries)).not.toContain(FIRST_RUN_ID);
  });

  it('reads the quotation back under the same authorization (probe control)', async () => {
    await readSourceThenAnswer();
    const input = await nextTurnModelInput({codeAwareMode: 'provider_send', codebaseIds: [fixture.codebaseId]});
    expect(input.systemPrompt).toContain(SYSTEM_PROMPT_PROBE);
    expect(input.requests).toContain(SOURCE_FINALIZATION_CANARY);
    expect(input.classification).toContain(SOURCE_FINALIZATION_CANARY);
    expect(input.historyTurn).toMatchObject({success: true, id: FIRST_RUN_ID});
    expect(JSON.stringify(input.historyTurn)).toContain(SOURCE_FINALIZATION_CANARY);
    expect(JSON.stringify(input.historyIndex.entries)).toContain(FIRST_RUN_ID);
  });
});
