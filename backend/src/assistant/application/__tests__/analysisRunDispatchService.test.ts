// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)

import {afterEach, beforeEach, describe, expect, it, jest} from '@jest/globals';
import {dispatchAnalysisRun, type AnalysisDispatchSession, type AnalysisRunDispatchDependencies,
  type AnalysisRunDispatchInput} from '../analysisRunDispatchService';
import {AssistantApplicationService} from '../assistantApplicationService';
import {AgentAnalyzeSessionService} from '../agentAnalyzeSessionService';
import * as rbac from '../../../services/rbac';
import * as tenant from '../../../services/enterpriseTenantLifecycleService';
import * as quota from '../../../services/enterpriseQuotaPolicyService';
import * as metadata from '../../../services/traceMetadataStore';
import * as processor from '../../../services/traceProcessorService';
import * as lease from '../../../services/analysisRunTraceProcessorLease';
import * as manifests from '../../../services/selfEvolution/runManifestLifecycle';
import {SessionPersistenceService} from '../../../services/sessionPersistenceService';
import {getDefaultAndroidInternalsPackResolver} from '../../../services/androidInternalsPack/androidInternalsPackResolver';
import {assertAiFeatureEnabled} from '../../../services/aiCapabilityPolicy';
import type {SessionLogger} from '../../../services/sessionLogger';
import {resolveAnalysisPrivateContext} from '../../../services/security/analysisPrivateContext';

type Deps = AnalysisRunDispatchDependencies<AnalysisDispatchSession>;

const originalAiEnabled = process.env.SMARTPERFETTO_AI_ENABLED;
const context = {tenantId: 'tenant', workspaceId: 'workspace', userId: 'user', authType: 'dev' as const,
  roles: ['analyst'], scopes: ['agent:run'], requestId: 'request'};
const tick = () => new Promise(resolve => setImmediate(resolve));
function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  return {promise, resolve, reject};
}

function fixture(entry: AnalysisRunDispatchInput['entry'] = 'analysis') {
  const session = {sessionId: 'session', traceId: 'trace', query: 'inspect', status: 'pending',
    providerId: 'pinned-provider', ...context,
    logger: {setMetadata: jest.fn(), info: jest.fn(), error: jest.fn()} as unknown as SessionLogger,
  } as unknown as AnalysisDispatchSession;
  const app = new AssistantApplicationService<AnalysisDispatchSession>();
  const prepare = jest.spyOn(AgentAnalyzeSessionService.prototype, 'prepareSession').mockImplementation(() => {
    app.setSession(session.sessionId, session);
    return {sessionId: session.sessionId, session, isNewSession: true};
  });
  const leases = {entries: [], run: async <T>(fn: () => Promise<T>) => fn(),
    assertCurrent: jest.fn(), release: jest.fn()};
  const admit = jest.spyOn(lease, 'prepareAnalysisRunTraceProcessorLeases').mockResolvedValue(leases);
  const runner = jest.fn<Deps['runAgentDrivenAnalysis']>(async () => {});
  const smart = jest.fn<Deps['runSmartAnalysis']>(async () => {});
  const releaseScene = jest.fn<() => void | Promise<void>>();
  const sceneHook = jest.fn(async () => ({bindOptions: <T>(options: T) => options, seal: () => undefined, release: releaseScene}));
  const lifecycle = {builder: {}} as manifests.RunManifestLifecycle;
  let runSequence = 0;
  const deps: AnalysisRunDispatchDependencies<AnalysisDispatchSession> = {
    assistantAppService: app, httpAnalysisRunLeaseControllers: new WeakMap(), admittedLocalAnalysisRuns: new WeakMap(),
    blockedSceneStrategyIds: ['legacy-scene'], sceneRunHooks: {onAdmitted: sceneHook},
    configuredOutputLanguage: () => 'en', sessionOutputLanguage: () => 'en',
    enterpriseLeasesEnabled: () => false, leaseScopeFromRequestContext: () => context,
    buildLeaseModeDecisionForTrace: () => {throw new Error('enterprise-only');},
    startSessionRun: jest.fn<Deps['startSessionRun']>((value, query, requestId) => {
      const sequence = ++runSequence;
      const run = {runId: sequence === 1 ? 'run' : `run-${sequence}`, sequence, query, requestId,
        startedAt: Date.now(), status: 'pending' as const, privateContext: resolveAnalysisPrivateContext(value)};
      value.activeRun = run;
      return run;
    }),
    markSessionRunStatus: jest.fn<Deps['markSessionRunStatus']>((value, status, error, runId) => {
      if (value.activeRun && value.activeRun.runId === runId) Object.assign(value.activeRun, {status, error});
    }),
    isSessionRunCancelled: value => value.activeRun?.status === 'cancelled',
    abortHttpFinalizationRuns: jest.fn(), isStaleRun: (value, runId) => value.activeRun?.runId !== runId,
    settleSessionRunExecution: jest.fn(), resetSessionRuntimeForSourceActivation: async () => {},
    createHttpRunManifestLifecycle: jest.fn(async () => lifecycle),
    sealCompletedHttpRunManifest: jest.fn(), finalizeHttpRunManifestLifecycle: jest.fn(), persistSessionRunState: jest.fn(),
    cancelActiveAnalysisSourceEnrichment: async () => false, assignSessionOwner: () => {},
    requestedSessionIsVisible: () => true, resolveVisibleSessionReferenceTraceIdForTrace: () => undefined,
    buildRecoveredResultFromContext: () => null, ensureToolsRegistered: jest.fn(),
    isDedicatedSceneReplayRequest: query => query === 'scene reconstruction',
    runSmartAnalysis: smart, smartSelectionReportId: () => undefined,
    analyzeOptionsErrorMessage: error => error.message, smartPreviewSelectionErrorMessage: () => 'stale',
    resolveSmartPreviewReportForSelection: async () => null,
    runAgentDrivenAnalysis: runner, broadcastToAgentDrivenClients: jest.fn(),
  };
  const input: AnalysisRunDispatchInput = {entry, context, requestId: 'request',
    body: {traceId: 'trace', query: entry === 'analysis' ? 'inspect' : 'scene reconstruction', providerId: 'requested-provider'}};
  return {input, deps, session, prepare, leases, admit, runner, smart, sceneHook, releaseScene};
}

beforeEach(() => {
  process.env.SMARTPERFETTO_AI_ENABLED = 'true';
  jest.spyOn(rbac, 'hasRbacPermission').mockReturnValue(true);
  jest.spyOn(tenant, 'evaluateTenantMutationPolicy').mockReturnValue({allowed: true, httpStatus: 200,
    code: 'OK', status: 'active', message: 'allowed'});
  jest.spyOn(quota, 'evaluateAnalysisRunQuota').mockReturnValue({allowed: true, httpStatus: 200,
    code: 'OK', status: 'allowed', message: 'allowed', details: {}});
  jest.spyOn(metadata, 'readTraceMetadataForContext').mockResolvedValue({id: 'trace'} as metadata.TraceMetadata);
  jest.spyOn(processor, 'getTraceProcessorService').mockReturnValue({
    getOrLoadTrace: jest.fn(async () => ({id: 'trace'})),
  } as unknown as processor.TraceProcessorService);
  jest.spyOn(SessionPersistenceService, 'getInstance').mockReturnValue({} as SessionPersistenceService);
  jest.spyOn(getDefaultAndroidInternalsPackResolver(), 'resolve').mockReturnValue(undefined);
  jest.spyOn(manifests, 'withRunManifestLifecycle').mockImplementation((_lifecycle, execute) => execute());
  jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  jest.restoreAllMocks();
  if (originalAiEnabled === undefined) delete process.env.SMARTPERFETTO_AI_ENABLED;
  else process.env.SMARTPERFETTO_AI_ENABLED = originalAiEnabled;
});

describe('shared analysis run dispatch', () => {
  it.each(['analysis', 'scene_reconstruction'] as const)('%s cannot bypass RBAC', async entry => {
    const f = fixture(entry);
    jest.mocked(rbac.hasRbacPermission).mockReturnValue(false);
    expect(await dispatchAnalysisRun(f.input, f.deps)).toMatchObject({status: 403, body: {error: 'Forbidden'}});
    expect(f.prepare).not.toHaveBeenCalled();
    expect(f.admit).not.toHaveBeenCalled();
    expect(f.runner).not.toHaveBeenCalled();
    expect(f.sceneHook).not.toHaveBeenCalled();
  });

  it.each(['analysis', 'scene_reconstruction'] as const)('%s cannot bypass AI disable', async entry => {
    const f = fixture(entry);
    process.env.SMARTPERFETTO_AI_ENABLED = 'false';
    expect(await dispatchAnalysisRun(f.input, f.deps)).toMatchObject({status: 403, body: {code: 'AI_DISABLED'}});
    expect(f.prepare).not.toHaveBeenCalled();
    expect(f.runner).not.toHaveBeenCalled();
  });

  it.each(['tenant', 'trace', 'quota'] as const)('scene entry enforces %s access before preparation', async boundary => {
    const f = fixture('scene_reconstruction');
    if (boundary === 'tenant') jest.mocked(tenant.evaluateTenantMutationPolicy).mockReturnValue({allowed: false,
      httpStatus: 409, code: 'TENANT_READ_ONLY', status: 'tombstoned', message: 'denied'});
    if (boundary === 'trace') jest.mocked(metadata.readTraceMetadataForContext).mockResolvedValue(null);
    if (boundary === 'quota') jest.mocked(quota.evaluateAnalysisRunQuota).mockReturnValue({allowed: false,
      httpStatus: 429, code: 'CONCURRENT_RUN_QUOTA_EXCEEDED', status: 'quota_exceeded', message: 'denied', details: {}});
    const response = await dispatchAnalysisRun(f.input, f.deps);
    expect(response.status).toBe(boundary === 'tenant' ? 409 : boundary === 'trace' ? 404 : 429);
    expect(f.prepare).not.toHaveBeenCalled();
    expect(f.runner).not.toHaveBeenCalled();
    expect(f.sceneHook).not.toHaveBeenCalled();
  });

  it('body entry and capability-shaped JSON cannot change the server-selected entry', async () => {
    const f = fixture();
    Object.assign(f.input.body, {entry: 'scene_reconstruction', sceneRunBinding: {verified: true}});
    f.input.body.query = 'scene reconstruction';
    expect(await dispatchAnalysisRun(f.input, f.deps)).toMatchObject({status: 400,
      body: {code: 'SCENE_REPLAY_SEPARATED'}});
    expect(f.sceneHook).not.toHaveBeenCalled();
    expect(f.prepare).not.toHaveBeenCalled();
  });

  it('preserves the accepted run response and dispatches the session-pinned provider', async () => {
    const f = fixture();
    const response = await dispatchAnalysisRun(f.input, f.deps);
    await tick();
    expect(response).toMatchObject({status: 200, body: {success: true, sessionId: 'session', runId: 'run',
      requestId: 'request', runSequence: 1, isNewSession: true, architecture: 'agent-driven',
      observability: {runId: 'run', requestId: 'request', runSequence: 1}}});
    expect(f.prepare).toHaveBeenCalledWith(expect.objectContaining({providerId: 'requested-provider', providerScope: {tenantId: context.tenantId, workspaceId: context.workspaceId, userId: context.userId}}));
    expect(f.runner).toHaveBeenCalledWith('session', 'inspect', 'trace', expect.objectContaining({
      providerId: 'pinned-provider', runContext: expect.objectContaining({runId: 'run'}), blockedStrategyIds: ['legacy-scene']}));
    expect(f.leases.release).toHaveBeenCalledTimes(1);
    expect(f.deps.settleSessionRunExecution).toHaveBeenCalledWith(f.session, 'run');
    expect(f.deps.finalizeHttpRunManifestLifecycle).toHaveBeenCalledTimes(1);
    expect(f.sceneHook).not.toHaveBeenCalled();
  });

  it('keeps Smart on its original shared admission and runner branch', async () => {
    const f = fixture();
    f.input.body.options = {preset: 'smart'};
    expect(await dispatchAnalysisRun(f.input, f.deps)).toMatchObject({status: 200, body: {preset: 'smart'}});
    await tick();
    expect(f.admit).toHaveBeenCalledTimes(1);
    expect(f.smart).toHaveBeenCalledWith('session', 'inspect', 'trace', expect.objectContaining({smartAction: 'preview', providerId: 'pinned-provider'}));
    expect(f.runner).not.toHaveBeenCalled();
    expect(f.leases.release).toHaveBeenCalledTimes(1);
  });

  it('runs the scene hook only after successful admission, passes its binding, and releases it once', async () => {
    const f = fixture('scene_reconstruction');
    const response = await dispatchAnalysisRun(f.input, f.deps);
    await tick();
    expect(response.status).toBe(200);
    expect(f.admit.mock.invocationCallOrder[0]).toBeLessThan(f.sceneHook.mock.invocationCallOrder[0]);
    expect(f.sceneHook.mock.invocationCallOrder[0]).toBeLessThan(f.runner.mock.invocationCallOrder[0]);
    expect(f.runner).toHaveBeenCalledWith('session', 'scene reconstruction', 'trace', expect.objectContaining({
      providerId: 'pinned-provider', blockedStrategyIds: [], sceneRunBinding: expect.objectContaining({release: f.releaseScene})}));
    expect(f.releaseScene).toHaveBeenCalledTimes(1);
    expect(f.leases.release).toHaveBeenCalledTimes(1);
  });

  it('an admission failure does not invoke scene hooks or runtime and settles the created run', async () => {
    const f = fixture('scene_reconstruction');
    f.admit.mockRejectedValue(new Error('lease unavailable'));
    expect(await dispatchAnalysisRun(f.input, f.deps)).toMatchObject({status: 409,
      body: {code: 'TRACE_PROCESSOR_LEASE_UNAVAILABLE'}});
    expect(f.sceneHook).not.toHaveBeenCalled();
    expect(f.runner).not.toHaveBeenCalled();
    expect(f.session.activeRun?.status).toBe('failed');
    expect(f.deps.finalizeHttpRunManifestLifecycle).toHaveBeenCalledTimes(1);
    expect(f.deps.settleSessionRunExecution).toHaveBeenCalledWith(f.session, 'run');
  });

  it('a manifest setup failure settles and fails the run before dispatch', async () => {
    const f = fixture();
    jest.mocked(f.deps.createHttpRunManifestLifecycle).mockRejectedValue(new Error('manifest failed'));
    expect(await dispatchAnalysisRun(f.input, f.deps)).toMatchObject({status: 500});
    expect(f.session.activeRun?.status).toBe('failed');
    expect(f.deps.settleSessionRunExecution).toHaveBeenCalledWith(f.session, 'run');
    expect(f.runner).not.toHaveBeenCalled();
  });

  it('does not emit a second error when the same run already published failure', async () => {
    const f = fixture();
    f.runner.mockImplementation(async () => {
      f.session.activeRun!.status = 'failed';
      f.session.status = 'failed';
      throw new Error('runtime error already published');
    });
    await dispatchAnalysisRun(f.input, f.deps);
    await tick();
    expect(f.deps.broadcastToAgentDrivenClients).not.toHaveBeenCalled();
    expect(f.leases.release).toHaveBeenCalledTimes(1);
    expect(f.deps.settleSessionRunExecution).toHaveBeenCalledTimes(1);
  });

  it('publishes one fallback error when runtime failed before claiming its terminal state', async () => {
    const f = fixture();
    f.runner.mockRejectedValue(new Error('early runtime failure'));
    await dispatchAnalysisRun(f.input, f.deps);
    await tick();
    expect(f.deps.broadcastToAgentDrivenClients).toHaveBeenCalledTimes(1);
    expect(f.session.activeRun?.status).toBe('failed');
    expect(f.leases.release).toHaveBeenCalledTimes(1);
  });

  it('refuses the internal scene entry while its product hook is not configured', async () => {
    const f = fixture('scene_reconstruction');
    delete f.deps.sceneRunHooks;
    expect(await dispatchAnalysisRun(f.input, f.deps)).toMatchObject({status: 503,
      body: {code: 'SCENE_DISPATCH_NOT_CONFIGURED'}});
    expect(f.prepare).not.toHaveBeenCalled();
    expect(f.admit).not.toHaveBeenCalled();
    expect(f.runner).not.toHaveBeenCalled();
  });

  it('releases admitted leases if scene capability creation fails', async () => {
    const f = fixture('scene_reconstruction');
    f.sceneHook.mockRejectedValue(new Error('scene capability failed'));
    expect(await dispatchAnalysisRun(f.input, f.deps)).toMatchObject({status: 500});
    expect(f.runner).not.toHaveBeenCalled();
    expect(f.leases.release).toHaveBeenCalledTimes(1);
    expect(f.session.activeRun?.status).toBe('failed');
    expect(f.deps.settleSessionRunExecution).toHaveBeenCalledTimes(1);
    expect(f.deps.httpAnalysisRunLeaseControllers.get(f.session)?.size).toBe(0);
  });

  it('still releases leases and settles when a scene binding cleanup throws', async () => {
    const f = fixture('scene_reconstruction');
    f.releaseScene.mockImplementation(() => {throw new Error('cleanup failed');});
    expect(await dispatchAnalysisRun(f.input, f.deps)).toMatchObject({status: 200});
    await tick();
    expect(f.releaseScene).toHaveBeenCalledTimes(1);
    expect(f.leases.release).toHaveBeenCalledTimes(1);
    expect(f.deps.finalizeHttpRunManifestLifecycle).toHaveBeenCalledTimes(1);
    expect(f.deps.settleSessionRunExecution).toHaveBeenCalledTimes(1);
    expect(f.deps.httpAnalysisRunLeaseControllers.get(f.session)?.size).toBe(0);
    expect(f.session.sceneExecutionInFlightRunId).toBeUndefined();
  });

  it.each(['analysis', 'scene_reconstruction'] as const)(
    'blocks a following %s run through asynchronous scene cleanup, then admits it', async entry => {
      const f = fixture('scene_reconstruction');
      const cleanup = deferred();
      f.releaseScene.mockReturnValueOnce(cleanup.promise);
      f.runner.mockImplementation(async () => {
        f.session.activeRun!.status = 'completed';
        f.session.status = 'completed';
      });
      expect(await dispatchAnalysisRun(f.input, f.deps)).toMatchObject({status: 200});
      await tick();
      expect(f.releaseScene).toHaveBeenCalledTimes(1);
      expect(f.session.sceneExecutionInFlightRunId).toBe('run');
      expect(f.leases.release).not.toHaveBeenCalled();
      expect(f.deps.settleSessionRunExecution).not.toHaveBeenCalled();
      expect(f.deps.httpAnalysisRunLeaseControllers.get(f.session)?.has('run')).toBe(true);
      const followup = {...f.input, entry,
        body: {...f.input.body, sessionId: 'session', query: entry === 'analysis' ? 'follow up' : 'scene reconstruction'}};
      try {
        expect(await dispatchAnalysisRun(followup, f.deps)).toMatchObject({status: 409,
          body: {code: 'RUN_ALREADY_ACTIVE', runId: 'run'}});
        expect(f.prepare).toHaveBeenCalledTimes(1);
        expect(f.deps.startSessionRun).toHaveBeenCalledTimes(1);
        expect(f.runner).toHaveBeenCalledTimes(1);
      } finally { cleanup.resolve(); }
      await tick();
      expect(f.leases.release).toHaveBeenCalledTimes(1);
      expect(f.deps.settleSessionRunExecution).toHaveBeenCalledTimes(1);
      expect(f.deps.httpAnalysisRunLeaseControllers.get(f.session)?.size).toBe(0);
      expect(f.session.sceneExecutionInFlightRunId).toBeUndefined();
      expect(f.leases.release.mock.invocationCallOrder[0]).toBeLessThan(
        jest.mocked(f.deps.settleSessionRunExecution).mock.invocationCallOrder[0]);
      expect(await dispatchAnalysisRun(followup, f.deps)).toMatchObject({status: 200,
        body: {success: true, runId: 'run-2'}});
      await tick();
      expect(f.prepare).toHaveBeenCalledTimes(2);
      expect(f.runner).toHaveBeenCalledTimes(2);
    });

  it('keeps cancellation conflict precedence while scene cleanup is pending', async () => {
    const f = fixture('scene_reconstruction');
    const cleanup = deferred();
    f.releaseScene.mockReturnValue(cleanup.promise);
    f.runner.mockImplementation(async () => {
      f.session.activeRun!.status = 'cancelled';
      f.session.status = 'cancelled';
      f.session.cancellationInFlightRunId = 'run';
    });
    await dispatchAnalysisRun(f.input, f.deps);
    await tick();
    try {
      expect(await dispatchAnalysisRun({...f.input, body: {...f.input.body, sessionId: 'session'}}, f.deps))
        .toMatchObject({status: 409, body: {code: 'CANCELLATION_IN_PROGRESS', runId: 'run'}});
      expect(f.prepare).toHaveBeenCalledTimes(1);
      expect(f.deps.settleSessionRunExecution).not.toHaveBeenCalled();
    } finally { cleanup.resolve(); }
    await tick();
    expect(f.deps.settleSessionRunExecution).toHaveBeenCalledTimes(1);
    expect(f.session.sceneExecutionInFlightRunId).toBeUndefined();
  });

  it.each(['completed', 'failed'] as const)(
    'settles a %s scene exactly once when asynchronous cleanup rejects', async status => {
      const f = fixture('scene_reconstruction');
      const cleanup = deferred();
      f.releaseScene.mockReturnValue(cleanup.promise);
      f.runner.mockImplementation(async () => {
        f.deps.markSessionRunStatus(f.session, status, undefined, 'run');
        f.session.status = status;
        if (status === 'failed') throw new Error('runtime already published failure');
      });
      await dispatchAnalysisRun(f.input, f.deps);
      await tick();
      expect(f.deps.finalizeHttpRunManifestLifecycle).toHaveBeenCalledTimes(1);
      expect(f.deps.settleSessionRunExecution).not.toHaveBeenCalled();
      cleanup.reject(new Error('async cleanup failed'));
      await tick();
      expect(f.releaseScene).toHaveBeenCalledTimes(1);
      expect(f.leases.release).toHaveBeenCalledTimes(1);
      expect(f.deps.settleSessionRunExecution).toHaveBeenCalledTimes(1);
      expect(f.deps.markSessionRunStatus).toHaveBeenCalledTimes(1);
      expect(f.deps.broadcastToAgentDrivenClients).not.toHaveBeenCalled();
      expect(f.session.activeRun?.status).toBe(status);
      expect(f.session.sceneExecutionInFlightRunId).toBeUndefined();
      expect(f.deps.httpAnalysisRunLeaseControllers.get(f.session)?.size).toBe(0);
      expect(f.session.logger.error).toHaveBeenCalledWith('AnalysisRunDispatch',
        'Failed to release scene runtime', expect.objectContaining({message: 'async cleanup failed'}));
    });

  it('attempts every cleanup and clears only its own execution marker on failures', async () => {
    const f = fixture('scene_reconstruction');
    const cleanup = deferred();
    f.releaseScene.mockReturnValue(cleanup.promise);
    jest.mocked(f.deps.finalizeHttpRunManifestLifecycle).mockImplementation(() => {throw new Error('manifest failed');});
    f.leases.release.mockImplementation(() => {throw new Error('lease release failed');});
    jest.mocked(f.deps.settleSessionRunExecution).mockImplementation(() => {throw new Error('settle failed');});
    await dispatchAnalysisRun(f.input, f.deps);
    await tick();
    f.session.sceneExecutionInFlightRunId = 'replacement-run';
    cleanup.reject(new Error('binding failed'));
    await tick();
    expect(f.deps.finalizeHttpRunManifestLifecycle).toHaveBeenCalledTimes(1);
    expect(f.releaseScene).toHaveBeenCalledTimes(1);
    expect(f.leases.release).toHaveBeenCalledTimes(1);
    expect(f.deps.settleSessionRunExecution).toHaveBeenCalledTimes(1);
    expect(f.deps.httpAnalysisRunLeaseControllers.get(f.session)?.size).toBe(0);
    expect(f.session.sceneExecutionInFlightRunId).toBe('replacement-run');
  });

  it('does not start scene acquisition when cancellation wins admission', async () => {
    const f = fixture('scene_reconstruction');
    f.admit.mockImplementation(async () => {
      f.session.activeRun!.status = 'cancelled';
      throw new DOMException('cancelled', 'AbortError');
    });
    expect(await dispatchAnalysisRun(f.input, f.deps)).toMatchObject({status: 200,
      body: {success: false, status: 'cancelled', runId: 'run'}});
    expect(f.sceneHook).not.toHaveBeenCalled();
    expect(f.runner).not.toHaveBeenCalled();
    expect(f.session.activeRun?.status).toBe('cancelled');
    expect(f.deps.settleSessionRunExecution).toHaveBeenCalledTimes(1);
  });

  it('settles a created scene run if AI is disabled during its admitted hook', async () => {
    const f = fixture('scene_reconstruction');
    f.sceneHook.mockImplementation(async () => {
      process.env.SMARTPERFETTO_AI_ENABLED = 'false';
      assertAiFeatureEnabled('scene_reconstruct_start');
      throw new Error('unreachable');
    });
    expect(await dispatchAnalysisRun(f.input, f.deps)).toMatchObject({status: 403, body: {code: 'AI_DISABLED'}});
    expect(f.session.activeRun?.status).toBe('failed');
    expect(f.deps.settleSessionRunExecution).toHaveBeenCalledTimes(1);
    expect(f.leases.release).toHaveBeenCalledTimes(1);
    expect(f.runner).not.toHaveBeenCalled();
  });

  it('releases an admitted scene binding when cancellation wins its asynchronous creation', async () => {
    const f = fixture('scene_reconstruction');
    const cleanup = deferred();
    f.releaseScene.mockReturnValue(cleanup.promise);
    f.leases.assertCurrent.mockImplementation(() => {
      if (f.session.activeRun?.status === 'cancelled') throw new DOMException('cancelled', 'AbortError');
    });
    f.sceneHook.mockImplementation(async () => {
      f.session.activeRun!.status = 'cancelled';
      return {bindOptions: <T>(options: T) => options, seal: () => undefined, release: f.releaseScene};
    });
    let responded = false;
    const response = dispatchAnalysisRun(f.input, f.deps).then(value => {responded = true; return value;});
    await tick();
    try {
      expect(f.releaseScene).toHaveBeenCalledTimes(1);
      expect(responded).toBe(false);
      expect(f.session.sceneExecutionInFlightRunId).toBe('run');
      expect(f.leases.release).not.toHaveBeenCalled();
      expect(f.deps.settleSessionRunExecution).not.toHaveBeenCalled();
    } finally { cleanup.resolve(); }
    expect(await response).toMatchObject({status: 200,
      body: {success: false, status: 'cancelled', runId: 'run'}});
    expect(f.releaseScene).toHaveBeenCalledTimes(1);
    expect(f.leases.release).toHaveBeenCalledTimes(1);
    expect(f.deps.settleSessionRunExecution).toHaveBeenCalledTimes(1);
    expect(f.runner).not.toHaveBeenCalled();
    expect(f.session.activeRun?.status).toBe('cancelled');
    expect(f.session.sceneExecutionInFlightRunId).toBeUndefined();
  });

  it('late failures cannot mutate a replacement run or publish errors for it', async () => {
    const f = fixture();
    f.runner.mockImplementation(async () => {
      f.session.activeRun = {...f.session.activeRun!, runId: 'new-run', status: 'running'};
      throw new Error('old run failed');
    });
    await dispatchAnalysisRun(f.input, f.deps);
    await tick();
    expect(f.deps.broadcastToAgentDrivenClients).not.toHaveBeenCalled();
    expect(f.session.activeRun?.status).toBe('running');
    expect(f.leases.release).toHaveBeenCalledTimes(1);
    expect(f.deps.settleSessionRunExecution).toHaveBeenCalledWith(f.session, 'run');
  });
});
