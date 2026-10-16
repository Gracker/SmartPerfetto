// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

/**
 * Manual real-provider verifier for the draft / provisional-answer / stop
 * contract (`.claude/rules/backend.md`, `frontend.md`). It starts nothing: it
 * targets an explicit, already-running loopback backend, uploads a Trace
 * through the public API, drives each scenario through the agent route
 * (`/api/agent/v1/analyze`) and the conversation API, sends stops the moment
 * the triggering event arrives, then reads status, turns / history and a
 * reconnect replay for the exact session and run. Decisions live in
 * `stopSemanticsChecks.ts`; evidence is written redacted (lengths and digests,
 * never answer or draft text).
 */

import fs from 'node:fs';
import path from 'node:path';
import {
  STOP_SCENARIOS,
  classifyStopResponse,
  evaluateStopScenario,
  normalizeAgentFrame,
  normalizeConversationFrame,
  parseLoopbackOrigin,
  redactStopObservation,
  splitSseFrames,
  summarizeStopChecks,
  type SseFrame,
  type StopAttempt,
  type StopCheckResult,
  type StopEntry,
  type StopObservedEvent,
  type StopScenario,
  type StopScenarioObservation,
  type StopStorageObservation,
  type StopTrigger,
  type StoredTurnObservation,
} from './stopSemanticsChecks';

interface Options {
  baseUrl: string;
  tracePath: string;
  query: string;
  entries: StopEntry[];
  scenarios: StopScenario[];
  analysisMode?: 'fast' | 'full' | 'auto';
  providerId?: string | null;
  beforeTrigger: 'draft' | 'progress';
  timeoutMs: number;
  requestTimeoutMs: number;
  stopTimeoutMs: number;
  terminalGraceMs: number;
  outputPath: string;
}

const DEFAULT_TRACE = '../Trace/real/android-startup-light/trace.pftrace';
const DEFAULT_QUERY = '分析启动性能';
const MAX_JSON_BYTES = 32 * 1024 * 1024;
const MAX_SSE_BYTES = 64 * 1024 * 1024;

function printUsage(): void {
  console.log(`Usage: npm run verify:e2e:stop-semantics -- --base-url http://127.0.0.1:<port> [options]

Targets an already-running, isolated backend with a real provider. Starts nothing.

  --base-url <origin>          Required. http://127.0.0.1:<port> or http://[::1]:<port>
  --trace <path>               Trace to upload (default ${DEFAULT_TRACE})
  --query <text>               Question (default ${DEFAULT_QUERY})
  --entry agent|conversation|both            (default both)
  --scenario <name>[,<name>...]|all          ${STOP_SCENARIOS.join(', ')} (default all)
  --mode fast|full|auto        Agent route analysisMode (conversation is always fast)
  --provider-id <id>|null      Pin a Provider Manager profile; null = env fallback
  --before-trigger draft|progress   Trigger for stop_before_provisional (default draft)
  --timeout-ms <n>             Per-scenario live stream bound (default 900000)
  --request-timeout-ms <n>     Per-request bound (default 30000)
  --stop-timeout-ms <n>        Per-stop request bound (default 60000)
  --terminal-grace-ms <n>      Keep reading after a terminal event (default 2000)
  --output <path>              Fresh backend/test-output/e2e-stop-*.json file

Auth: SMARTPERFETTO_API_KEY, when set in the environment, is sent as a Bearer token.`);
}

function positiveInt(value: string, flag: string): number {
  if (!/^\d+$/.test(value) || Number(value) <= 0) throw new Error(`${flag} must be a positive integer`);
  return Number(value);
}

function parseArgs(argv: string[]): Options {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index];
    if (flag === '--help' || flag === '-h') {
      printUsage();
      process.exit(0);
    }
    const value = argv[index + 1];
    if (!flag.startsWith('--') || value === undefined || value.startsWith('--')) throw new Error(`Invalid argument: ${flag}`);
    values.set(flag, value);
    index++;
  }
  const known = ['--base-url', '--trace', '--query', '--entry', '--scenario', '--mode', '--provider-id',
    '--before-trigger', '--timeout-ms', '--request-timeout-ms', '--stop-timeout-ms', '--terminal-grace-ms', '--output'];
  for (const flag of values.keys()) if (!known.includes(flag)) throw new Error(`Unknown argument: ${flag}`);
  const baseUrl = values.get('--base-url');
  if (!baseUrl) throw new Error('--base-url is required');

  const entry = values.get('--entry') ?? 'both';
  if (!['agent', 'conversation', 'both'].includes(entry)) throw new Error('--entry must be agent, conversation or both');
  const scenarioArg = values.get('--scenario') ?? 'all';
  const scenarios = scenarioArg === 'all' ? [...STOP_SCENARIOS] : scenarioArg.split(',').map(name => name.trim());
  for (const name of scenarios) {
    if (!(STOP_SCENARIOS as readonly string[]).includes(name)) throw new Error(`Unknown scenario: ${name}`);
  }
  const mode = values.get('--mode');
  if (mode !== undefined && !['fast', 'full', 'auto'].includes(mode)) throw new Error('--mode must be fast, full or auto');
  const beforeTrigger = values.get('--before-trigger') ?? 'draft';
  if (beforeTrigger !== 'draft' && beforeTrigger !== 'progress') throw new Error('--before-trigger must be draft or progress');
  const providerArg = values.get('--provider-id');

  const outputPath = path.resolve(values.get('--output') ??
    path.join(process.cwd(), 'test-output', `e2e-stop-${new Date().toISOString().replace(/[:.]/g, '-')}.json`));
  if (!/^e2e-stop-[\w.-]+\.json$/.test(path.basename(outputPath))) throw new Error('--output must name an e2e-stop-*.json file');
  if (fs.existsSync(outputPath)) throw new Error(`--output already exists: ${outputPath}`);

  return {
    baseUrl: parseLoopbackOrigin(baseUrl),
    tracePath: path.resolve(values.get('--trace') ?? DEFAULT_TRACE),
    query: values.get('--query') ?? DEFAULT_QUERY,
    entries: entry === 'both' ? ['agent', 'conversation'] : [entry as StopEntry],
    scenarios: scenarios as StopScenario[],
    ...(mode ? {analysisMode: mode as Options['analysisMode']} : {}),
    ...(providerArg !== undefined ? {providerId: providerArg === 'null' ? null : providerArg} : {}),
    beforeTrigger,
    timeoutMs: positiveInt(values.get('--timeout-ms') ?? '900000', '--timeout-ms'),
    requestTimeoutMs: positiveInt(values.get('--request-timeout-ms') ?? '30000', '--request-timeout-ms'),
    stopTimeoutMs: positiveInt(values.get('--stop-timeout-ms') ?? '60000', '--stop-timeout-ms'),
    terminalGraceMs: positiveInt(values.get('--terminal-grace-ms') ?? '2000', '--terminal-grace-ms'),
    outputPath,
  };
}

// ---------------------------------------------------------------------------
// HTTP: every request is bounded, refuses redirects, and targets the one origin.
// ---------------------------------------------------------------------------

interface JsonResponse {
  status?: number;
  body?: Record<string, unknown>;
  error?: 'timeout' | 'network' | 'invalid_json';
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

async function readBoundedText(response: Response, maxBytes: number): Promise<string> {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const {done, value} = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new Error('response_too_large');
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

class Target {
  private readonly apiKey = process.env.SMARTPERFETTO_API_KEY?.trim() || undefined;

  constructor(readonly baseUrl: string) {}

  headers(extra: Record<string, string> = {}): Record<string, string> {
    return {...(this.apiKey ? {authorization: `Bearer ${this.apiKey}`} : {}), ...extra};
  }

  async json(method: 'GET' | 'POST' | 'DELETE', route: string, timeoutMs: number,
    body?: Record<string, unknown> | FormData): Promise<JsonResponse> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const isJson = body !== undefined && !(body instanceof FormData);
      const response = await fetch(`${this.baseUrl}${route}`, {
        method, redirect: 'error', signal: controller.signal,
        headers: this.headers(isJson ? {'content-type': 'application/json'} : {}),
        ...(body !== undefined ? {body: isJson ? JSON.stringify(body) : body as FormData} : {}),
      });
      const text = await readBoundedText(response, MAX_JSON_BYTES);
      try {
        return {status: response.status, body: text ? asRecord(JSON.parse(text)) : undefined};
      } catch {
        return {status: response.status, error: 'invalid_json'};
      }
    } catch {
      return {error: controller.signal.aborted ? 'timeout' : 'network'};
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Reads one SSE stream until the server closes it, the bound elapses, or
   * `graceMs` after `onFrame` reports a terminal event.
   */
  async sse(route: string, input: {timeoutMs: number; graceMs: number; onConnected?: () => void;
    onFrame(frame: SseFrame): {terminal: boolean}}): Promise<StopScenarioObservation['streamEnd']> {
    const controller = new AbortController();
    let reason: StopScenarioObservation['streamEnd'] = 'closed';
    const finish = (why: StopScenarioObservation['streamEnd']) => {
      reason = why;
      controller.abort();
    };
    const timer = setTimeout(() => finish('timeout'), input.timeoutMs);
    let grace: ReturnType<typeof setTimeout> | undefined;
    try {
      const response = await fetch(`${this.baseUrl}${route}`, {
        redirect: 'error', signal: controller.signal, headers: this.headers({accept: 'text/event-stream'}),
      });
      if (!response.ok || !response.body) return 'error';
      input.onConnected?.();
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let bytes = 0;
      for (;;) {
        const {done, value} = await reader.read();
        if (done) return 'closed';
        bytes += value.byteLength;
        if (bytes > MAX_SSE_BYTES) return 'error';
        const split = splitSseFrames(buffer + decoder.decode(value, {stream: true}));
        buffer = split.rest;
        for (const frame of split.frames) {
          if (input.onFrame(frame).terminal && !grace) grace = setTimeout(() => finish('terminal_grace'), input.graceMs);
        }
      }
    } catch {
      return controller.signal.aborted ? reason : 'error';
    } finally {
      clearTimeout(timer);
      if (grace) clearTimeout(grace);
      if (!controller.signal.aborted) controller.abort();
    }
  }
}

// ---------------------------------------------------------------------------
// Scenario execution
// ---------------------------------------------------------------------------

interface ScenarioResult {
  entry: StopEntry;
  scenario: StopScenario;
  sessionId?: string;
  runId?: string;
  error?: string;
  checks: StopCheckResult[];
  summary?: ReturnType<typeof summarizeStopChecks>;
  observation?: ReturnType<typeof redactStopObservation>;
  failureCancellation?: {httpStatus?: number; status?: string; outcome?: string; code?: string; requestError?: string};
  cleanup: {attempted: boolean; httpStatus?: number; success?: boolean; reason?: string};
}

interface RunContext {
  target: Target;
  options: Options;
  traceId: string;
  /** Persist everything collected so far (called before any failure cancellation). */
  persist(partial?: ScenarioResult): void;
}

const agentRoutes = {
  start: '/api/agent/v1/analyze',
  stream: (_sessionId: string, runId: string) => `/api/agent/v1/runs/${encodeURIComponent(runId)}/stream`,
  cancel: (sessionId: string) => `/api/agent/v1/${encodeURIComponent(sessionId)}/cancel`,
};
const conversationRoutes = {
  start: '/api/agent/v1/conversation',
  stream: (sessionId: string, runId: string) =>
    `/api/agent/v1/conversation/${encodeURIComponent(sessionId)}/stream?runId=${encodeURIComponent(runId)}`,
  cancel: (sessionId: string) => `/api/agent/v1/conversation/${encodeURIComponent(sessionId)}/cancel`,
};

const isTerminalKind = (event: StopObservedEvent) =>
  event.kind === 'completed' || event.kind === 'cancelled' || event.kind === 'failed';

async function sendStop(ctx: RunContext, entry: StopEntry, sessionId: string, runId: string,
  order: 1 | 2, trigger: StopTrigger, events: readonly StopObservedEvent[]): Promise<StopAttempt> {
  const routes = entry === 'agent' ? agentRoutes : conversationRoutes;
  const attempt: StopAttempt = {order, trigger, sentAfterEventIndex: events.length - 1};
  const response = await ctx.target.json('POST', routes.cancel(sessionId), ctx.options.stopTimeoutMs, {runId});
  attempt.respondedAfterEventIndex = events.length - 1;
  if (response.error) attempt.requestError = response.error;
  if (response.status !== undefined) attempt.httpStatus = response.status;
  const body = response.body;
  if (typeof body?.status === 'string') attempt.status = body.status;
  if (typeof body?.outcome === 'string') attempt.outcome = body.outcome;
  if (typeof body?.code === 'string') attempt.code = body.code;
  return attempt;
}

async function readAgentStorage(ctx: RunContext, sessionId: string): Promise<Omit<StopStorageObservation, 'replay'>> {
  const {target, options} = ctx;
  const sid = encodeURIComponent(sessionId);
  const status = await target.json('GET', `/api/agent/v1/${sid}/status`, options.requestTimeoutMs);
  const list = await target.json('GET', `/api/agent/v1/${sid}/turns?order=asc&limit=200`, options.requestTimeoutMs);
  let read: 'ok' | 'failed' = status.status === 200 && (list.status === 200 || list.status === 404) ? 'ok' : 'failed';
  const turns: StoredTurnObservation[] = [];
  const summaries = Array.isArray(list.body?.turns) ? list.body!.turns as unknown[] : [];
  for (const summary of summaries) {
    const turnId = asRecord(summary)?.turnId;
    if (typeof turnId !== 'string') {
      read = 'failed';
      continue;
    }
    const detail = await target.json('GET', `/api/agent/v1/${sid}/turns/${encodeURIComponent(turnId)}`, options.requestTimeoutMs);
    const turn = asRecord(detail.body?.turn);
    if (detail.status !== 200 || !turn) {
      read = 'failed';
      continue;
    }
    const result = asRecord(turn.result);
    const claims = asRecord(result?.claimVerificationResult);
    turns.push({
      ...(typeof result?.message === 'string' ? {body: result.message} : {}),
      ...(typeof result?.partial === 'boolean' ? {partial: result.partial} : {}),
      ...(typeof result?.terminationReason === 'string' ? {terminationReason: result.terminationReason} : {}),
      ...(typeof claims?.status === 'string' ? {claimVerificationStatus: claims.status} : {}),
      completed: turn.completed === true,
    });
  }
  const statusResult = asRecord(status.body?.result);
  return {read, turns,
    ...(typeof status.body?.status === 'string' ? {sessionStatus: status.body.status} : {}),
    statusReportUrlPresent: typeof statusResult?.reportUrl === 'string' && statusResult.reportUrl.length > 0};
}

interface ConversationHistoryRead {
  read: 'ok' | 'failed';
  status?: string;
  activeRunId?: string;
  messages: Array<{role?: string; content?: string; turn?: Record<string, unknown>}>;
}

async function readConversation(ctx: RunContext, sessionId: string, runId: string): Promise<ConversationHistoryRead> {
  const response = await ctx.target.json('GET', `/api/agent/v1/conversation/${encodeURIComponent(sessionId)}`,
    ctx.options.requestTimeoutMs);
  if (response.status !== 200 || !Array.isArray(response.body?.history)) return {read: 'failed', messages: []};
  const messages = (response.body!.history as unknown[]).map(asRecord)
    .filter((message): message is Record<string, unknown> => message?.turnId === runId)
    .map(message => ({role: typeof message.role === 'string' ? message.role : undefined,
      content: typeof message.content === 'string' ? message.content : undefined, turn: asRecord(message.turn)}));
  return {read: 'ok', messages,
    ...(typeof response.body?.status === 'string' ? {status: response.body.status} : {}),
    ...(typeof response.body?.activeRunId === 'string' ? {activeRunId: response.body.activeRunId} : {})};
}

async function readConversationStorage(ctx: RunContext, sessionId: string, runId: string):
  Promise<Omit<StopStorageObservation, 'replay'>> {
  const history = await readConversation(ctx, sessionId, runId);
  const turns = new Map<string, StoredTurnObservation>();
  for (const {turn} of history.messages) {
    if (!turn || typeof turn.id !== 'string') continue;
    turns.set(turn.id, {
      ...(typeof turn.partial === 'boolean' ? {partial: turn.partial} : {}),
      ...(typeof turn.terminationReason === 'string' ? {terminationReason: turn.terminationReason} : {}),
      completed: turn.completionStatus === 'completed',
    });
  }
  return {read: history.read, turns: [...turns.values()],
    ...(history.status ? {sessionStatus: history.status} : {}),
    assistantMessages: history.messages.filter(message => message.role === 'assistant').map(message => message.content ?? '')};
}

async function readReplay(ctx: RunContext, entry: StopEntry, sessionId: string, runId: string):
  Promise<StopStorageObservation['replay']> {
  const routes = entry === 'agent' ? agentRoutes : conversationRoutes;
  const normalize = entry === 'agent' ? normalizeAgentFrame : normalizeConversationFrame;
  const events: StopObservedEvent[] = [];
  const startedAt = Date.now();
  const end = await ctx.target.sse(routes.stream(sessionId, runId), {
    timeoutMs: ctx.options.requestTimeoutMs, graceMs: 500,
    onFrame: frame => {
      const event = normalize(frame, events.length, Date.now() - startedAt);
      events.push(event);
      return {terminal: isTerminalKind(event)};
    },
  });
  return {read: end === 'error' || (end === 'timeout' && !events.some(isTerminalKind)) ? 'failed' : 'ok', events};
}

async function runScenario(ctx: RunContext, entry: StopEntry, scenario: StopScenario): Promise<ScenarioResult> {
  const {target, options} = ctx;
  const routes = entry === 'agent' ? agentRoutes : conversationRoutes;
  const normalize = entry === 'agent' ? normalizeAgentFrame : normalizeConversationFrame;
  const result: ScenarioResult = {entry, scenario, checks: [], cleanup: {attempted: false}};
  const scenarioStartedAt = Date.now();

  const start = await target.json('POST', routes.start, options.requestTimeoutMs, {
    traceId: ctx.traceId,
    query: options.query,
    ...(options.providerId !== undefined ? {providerId: options.providerId} : {}),
    ...(entry === 'agent' && options.analysisMode ? {options: {analysisMode: options.analysisMode}} : {}),
  });
  const sessionId = typeof start.body?.sessionId === 'string' ? start.body.sessionId : undefined;
  const runId = typeof start.body?.runId === 'string' ? start.body.runId : undefined;
  if (!start.status || start.status >= 300 || !sessionId || !runId) {
    result.error = `start_failed:${start.status ?? start.error}${typeof start.body?.code === 'string' ? `:${start.body.code}` : ''}`;
    return result;
  }
  result.sessionId = sessionId;
  result.runId = runId;
  const acceptedAt = Date.now();

  const observation: StopScenarioObservation = {entry, scenario, runId, events: [], streamEnd: 'closed', stops: []};
  const pending: Promise<unknown>[] = [];
  let stopFired = false;
  let midRunRead = false;
  const fireStops = (trigger: StopTrigger) => {
    stopFired = true;
    pending.push((async () => {
      const first = await sendStop(ctx, entry, sessionId, runId, 1, trigger, observation.events);
      observation.stops.push(first);
      if (scenario === 'force_after_provisional' && classifyStopResponse(entry, first) === 'review_only') {
        observation.stops.push(await sendStop(ctx, entry, sessionId, runId, 2, 'after_first_stop', observation.events));
      }
    })());
  };
  let midRunHistory: StopStorageObservation['midRunHistory'];

  try {
    observation.streamEnd = await target.sse(routes.stream(sessionId, runId), {
      timeoutMs: options.timeoutMs,
      graceMs: options.terminalGraceMs,
      onConnected: () => {observation.subscriptionGapMs = Date.now() - acceptedAt;},
      onFrame: frame => {
        const event = normalize(frame, observation.events.length, Date.now() - scenarioStartedAt);
        observation.events.push(event);
        const answered = observation.events.some(seen => seen.kind === 'provisional' ||
          seen.kind === 'plain_conclusion' || isTerminalKind(seen));
        if (event.kind === 'provisional' && !stopFired &&
          (scenario === 'stop_after_provisional' || scenario === 'force_after_provisional')) fireStops('provisional');
        if (event.kind === 'provisional' && entry === 'conversation' && scenario === 'no_stop' && !midRunRead) {
          midRunRead = true;
          pending.push(readConversation(ctx, sessionId, runId).then(history => {
            midRunHistory = {read: history.read, activeRunMatches: history.activeRunId === runId,
              assistantMessageForRun: history.messages.some(message => message.role === 'assistant')};
          }));
        }
        if (scenario === 'stop_before_provisional' && !stopFired && !answered) {
          const progress = entry === 'agent' ? event.wireType === 'progress' : event.wireType.startsWith('runtime_update:');
          if (options.beforeTrigger === 'draft' ? event.kind === 'draft_token' : progress && event.kind === 'other') {
            fireStops(options.beforeTrigger === 'draft' ? 'first_draft' : 'first_progress');
          }
        }
        return {terminal: isTerminalKind(event)};
      },
    });
    // Each pending request is individually bounded.
    await Promise.all(pending);

    if (!observation.events.some(isTerminalKind)) {
      throw new Error(`no_terminal_event:${observation.streamEnd}`);
    }
    const storage = entry === 'agent'
      ? await readAgentStorage(ctx, sessionId)
      : await readConversationStorage(ctx, sessionId, runId);
    observation.storage = {...storage, ...(midRunHistory ? {midRunHistory} : {}),
      replay: await readReplay(ctx, entry, sessionId, runId)};
    result.checks = evaluateStopScenario(observation);
    result.summary = summarizeStopChecks(result.checks);
    result.observation = redactStopObservation(observation);
  } catch (error) {
    await Promise.allSettled(pending);
    result.error = error instanceof Error ? error.message : 'scenario_failed';
    result.observation = redactStopObservation(observation);
    // Evidence first: the cancellation itself may hang or the process may be killed.
    ctx.persist(result);
    if (!observation.events.some(isTerminalKind)) {
      const cancel = await sendStop(ctx, entry, sessionId, runId, 1, 'after_first_stop', observation.events);
      result.failureCancellation = {httpStatus: cancel.httpStatus, status: cancel.status, outcome: cancel.outcome,
        code: cancel.code, requestError: cancel.requestError};
      ctx.persist(result);
    }
  }

  if (entry === 'agent') {
    const deleted = await target.json('DELETE', `/api/agent/v1/${encodeURIComponent(sessionId)}`, options.requestTimeoutMs);
    result.cleanup = {attempted: true, httpStatus: deleted.status, success: deleted.body?.success === true};
  } else {
    result.cleanup = {attempted: false, reason: 'conversation API has no delete endpoint'};
  }
  return result;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (!fs.existsSync(options.tracePath)) throw new Error(`Trace file not found: ${options.tracePath}`);
  const target = new Target(options.baseUrl);
  const results: ScenarioResult[] = [];
  const output: Record<string, unknown> = {
    schemaVersion: 'agent_sse_stop_semantics@1',
    startedAt: new Date().toISOString(),
    baseUrl: options.baseUrl,
    trace: {file: path.basename(options.tracePath), bytes: fs.statSync(options.tracePath).size},
    query: options.query,
    entries: options.entries,
    scenarios: options.scenarios,
    analysisMode: options.analysisMode ?? null,
    providerId: options.providerId === undefined ? 'active_or_env' : options.providerId,
    results,
  };
  const persist = (partial?: ScenarioResult) => {
    fs.mkdirSync(path.dirname(options.outputPath), {recursive: true});
    const snapshot = partial && !results.includes(partial) ? [...results, partial] : results;
    const temporary = `${options.outputPath}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify({...output, results: snapshot}, null, 2)}\n`);
    fs.renameSync(temporary, options.outputPath);
  };

  const health = await target.json('GET', '/health', options.requestTimeoutMs);
  if (health.status !== 200) {
    output.error = `backend_unhealthy:${health.status ?? health.error}`;
    persist();
    throw new Error(String(output.error));
  }
  output.backendVersion = health.body?.version;

  const form = new FormData();
  const openAsBlob = (fs as typeof fs & {openAsBlob?: (file: string) => Promise<Blob>}).openAsBlob;
  form.append('file', openAsBlob ? await openAsBlob(options.tracePath) : new Blob([fs.readFileSync(options.tracePath)]),
    path.basename(options.tracePath));
  const upload = await target.json('POST', '/api/traces/upload', Math.max(options.requestTimeoutMs, 120_000), form);
  const trace = asRecord(upload.body?.trace);
  const traceId = typeof trace?.id === 'string' ? trace.id : undefined;
  if (upload.status !== 200 || !traceId) {
    output.error = `trace_upload_failed:${upload.status ?? upload.error}`;
    persist();
    throw new Error(String(output.error));
  }
  output.traceId = traceId;
  const ctx: RunContext = {target, options, traceId, persist};

  try {
    for (const entry of options.entries) {
      for (const scenario of options.scenarios) {
        console.log(`[stop-semantics] ${entry} / ${scenario} ...`);
        const result = await runScenario(ctx, entry, scenario);
        results.push(result);
        persist();
        const summary = result.summary;
        console.log(`[stop-semantics] ${entry} / ${scenario}: ${result.error ? `ERROR ${result.error}` :
          `pass ${summary?.pass} legal_race ${summary?.legal_race} not_exercised ${summary?.not_exercised} fail ${summary?.fail}`}`);
        for (const check of result.checks.filter(item => item.status === 'fail')) {
          console.log(`  FAIL ${check.id}: ${check.detail}`);
        }
      }
    }
  } finally {
    const deleted = await target.json('DELETE', `/api/traces/${encodeURIComponent(traceId)}`, options.requestTimeoutMs);
    output.traceCleanup = {httpStatus: deleted.status, success: deleted.body?.success === true};
    const totals = summarizeStopChecks(results.flatMap(result => result.checks));
    output.summary = {...totals, errors: results.filter(result => result.error).length,
      passed: totals.passed && results.every(result => !result.error)};
    output.finishedAt = new Date().toISOString();
    persist();
  }
  console.log(JSON.stringify({outputPath: options.outputPath, summary: output.summary}, null, 2));
  if (!(output.summary as {passed: boolean}).passed) process.exitCode = 1;
}

main().catch(error => {
  console.error(`[stop-semantics] ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
