import {configureRuntimeEnvironment} from './runtimeEnvironment';

// Load environment variables FIRST before importing routes
configureRuntimeEnvironment();

import { installEpipeGuard } from './utils/epipeGuard';

import express from 'express';
import cors from 'cors';
import path from 'path';
import type { Server } from 'http';
import type { Duplex } from 'stream';

// Import configuration
import { resolveFeatureConfig, serverConfig } from './config';

// Import routes (now after dotenv.config())
import sqlRoutes from './routes/sql';
import simpleTraceRoutes from './routes/simpleTraceRoutes';
import perfettoLocalRoutes from './routes/perfettoLocalRoutes';
import sessionRoutes from './routes/sessionRoutes';
import perfettoSqlRoutes from './routes/perfettoSqlRoutes';
import exportRoutes from './routes/exportRoutes';
import templateAnalysisRoutes from './routes/templateAnalysisRoutes';
import skillRoutes from './routes/skillRoutes';
import skillAdminRoutes from './routes/skillAdminRoutes';
import strategyAdminRoutes from './routes/strategyAdminRoutes';
import selfEvolutionAdminRoutes from './routes/selfEvolutionAdminRoutes';
import reportRoutes from './routes/reportRoutes';
import agentRoutes from './routes/agentRoutes';
import providerRoutes from './routes/providerRoutes';
import flamegraphRoutes from './routes/flamegraphRoutes';
import criticalPathRoutes from './routes/criticalPathRoutes';
import baselineRoutes from './routes/baselineRoutes';
import ciGateRoutes from './routes/ciGateRoutes';
import memoryRoutes from './routes/memoryRoutes';
import caseRoutes from './routes/caseRoutes';
import ragAdminRoutes from './routes/ragAdminRoutes';
import enterpriseAuthRoutes from './routes/enterpriseAuthRoutes';
import enterpriseApiKeyRoutes from './routes/enterpriseApiKeyRoutes';
import enterpriseTenantRoutes from './routes/enterpriseTenantRoutes';
import enterpriseRuntimeDashboardRoutes from './routes/enterpriseRuntimeDashboardRoutes';
import analysisResultRoutes from './routes/analysisResultRoutes';
import workspaceWindowRoutes from './routes/workspaceWindowRoutes';
import comparisonRoutes from './routes/comparisonRoutes';
import traceConfigProposalRoutes from './routes/traceConfigProposalRoutes';
import skillPackRoutes from './routes/skillPackRoutes';
import batchTraceRoutes from './routes/batchTraceRoutes';
import traceProcessorProxyRoutes, { handleTraceProcessorProxyUpgrade } from './routes/traceProcessorProxyRoutes';
import applicationUpdateRoutes from './routes/applicationUpdateRoutes';
import {authenticate, requireRequestContext} from './middleware/auth';
import { collectEnvCredentialSources } from './agentRuntime/envCredentialSources';
import { buildRuntimeHealthPayload } from './agentRuntime/runtimeHealth';
import {
  getLegacyApiUsageSnapshot,
} from './services/legacyApiTelemetry';
import {
  AGENT_API_V1_BASE,
  LEGACY_AGENT_API_BASE,
  markLegacyApi,
  rejectLegacyAgentApi,
} from './middleware/legacyAgentApi';
import {
  bindWorkspaceRouteContext,
  requireWorkspaceRouteContext,
} from './middleware/workspaceRouteContext';
import {
  isCorsOriginAllowed,
  isLoopbackRequestHostname,
  isSsoCookieMutationOriginAllowed,
  normalizeCorsOrigins,
} from './security/requestOriginPolicy';
import {rejectEnterpriseUnscopedApi} from './middleware/enterpriseRouteBoundary';
import {hasRbacPermission, sendForbidden} from './services/rbac';
import {getSmartPerfettoVersion} from './version';

// Import cleanup utilities
import { TraceProcessorFactory, killOrphanProcessors } from './services/workingTraceProcessor';
import { shouldCleanOrphanProcessorsOnStartup } from './services/startupCleanupPolicy';
import { getPortPool, resetPortPool } from './services/portPool';
import { failInterruptedAnalysisRunsOnStartup } from './services/analysisRunStore';
import { startCaseEvolutionWorker } from './services/caseEvolution/caseEvolutionWorkerBootstrap';
import { startPatternMemoryAutoConfirmSweep } from './agentv3/analysisPatternMemory';
import {
  startAndroidInternalsPackUpdateWorker,
} from './services/androidInternalsPack/knowledgePackUpdateWorker';
import {startApplicationUpdateWorker} from './services/applicationUpdate/applicationUpdateWorker';
import {installRuntimeShutdownControl} from './services/runtimeShutdownControl';
import {createActiveHttpResponseTracker} from './services/activeHttpResponseTracker';
import {startTraceProcessorLeaseSupervisor} from './services/traceProcessorLeaseSupervisor';
import {
  initializeSelfEvolutionLifecycle,
} from './services/selfEvolution/selfEvolutionLifecycle';
import {
  closeSelfEvolutionAdminService,
} from './services/selfEvolution/selfEvolutionAdminRuntime';
import {
  reconcileSelfEvolutionOnStartup,
} from './services/selfEvolution/selfEvolutionStartup';

const app = express();
const activeHttpResponses = createActiveHttpResponseTracker();
app.use(activeHttpResponses.middleware);
const PORT = serverConfig.port;
const NODE_ENV = serverConfig.nodeEnv;
const corsAllowedOrigins = normalizeCorsOrigins(serverConfig.corsOrigins);
const workspaceRouteContextMiddleware: express.RequestHandler[] = [
  bindWorkspaceRouteContext,
  authenticate,
  requireWorkspaceRouteContext,
];

// Middleware — exact-origin CORS. Port-only matching permits DNS rebinding.
app.use(cors({
  origin: (requestOrigin: string | undefined, callback: (err: Error | null, allow?: boolean | string) => void) => {
    // No Origin header (server-to-server, curl, etc.) → allow
    if (!requestOrigin) return callback(null, true);
    if (isCorsOriginAllowed(requestOrigin, corsAllowedOrigins)) return callback(null, true);
    callback(new Error(`CORS blocked: ${requestOrigin}`));
  },
  credentials: true,
}));

// A browser session cookie may authenticate every API surface. CORS controls
// response visibility, but it does not stop a cross-site form from sending a
// mutation, so reject cookie-authenticated unsafe methods unless their Origin
// is an exact configured frontend origin (or the backend's own origin).
app.use('/api', (req, res, next) => {
  if (!isSsoCookieMutationOriginAllowed({
    method: req.method,
    cookieHeader: req.headers.cookie,
    authorizationHeader: req.headers.authorization,
    apiKeyHeader: typeof req.headers['x-api-key'] === 'string'
      ? req.headers['x-api-key']
      : undefined,
    requestOrigin: req.headers.origin,
    requestProtocol: req.protocol,
    requestHost: req.get('host') || '',
    allowedOrigins: corsAllowedOrigins,
  })) {
    res.status(403).json({
      success: false,
      error: 'Cookie-authenticated mutations require an allowed Origin',
    });
    return;
  }
  next();
});

app.use(express.json({ limit: serverConfig.bodyLimit }));
app.use(express.urlencoded({ extended: true, limit: serverConfig.bodyLimit }));

// In keyless local mode, reject Host-header DNS rebinding even though the
// process itself listens only on loopback by default.
app.use('/api', (req, res, next) => {
  const keylessLocalMode = !process.env.SMARTPERFETTO_API_KEY && !resolveFeatureConfig(process.env).enterprise;
  if (keylessLocalMode && !isLoopbackRequestHostname(req.hostname)) {
    res.status(403).json({success: false, error: 'Untrusted Host in local keyless mode'});
    return;
  }
  next();
});

// Authentication is the default for the complete API surface. OIDC/session
// bootstrap endpoints own their public-vs-authenticated decisions internally.
app.use('/api', (req, res, next) => {
  if (req.path === '/auth' || req.path.startsWith('/auth/')) {
    next();
    return;
  }
  authenticate(req, res, next);
});

// Health check endpoint
app.get('/health', (_req, res) => {
  res.json({status: 'OK', version: getSmartPerfettoVersion()});
});

function requireRuntimeDiagnosticsPermission(
  req: express.Request,
  res: express.Response,
  next: express.NextFunction,
): void {
  const context = requireRequestContext(req);
  if (!hasRbacPermission(context, 'runtime:manage')) {
    sendForbidden(res, 'Runtime diagnostics require runtime:manage permission');
    return;
  }
  next();
}

// Detailed runtime and caller telemetry stays behind the authenticated API
// boundary and an explicit runtime-management permission.
app.get('/api/runtime-health', requireRuntimeDiagnosticsPermission, (_req, res) => {
  res.json(buildRuntimeHealthPayload());
});

app.get('/api/debug', requireRuntimeDiagnosticsPermission, (_req, res) => {
  const legacyUsage = getLegacyApiUsageSnapshot(10);
  res.json({
    aiCredentialSources: collectEnvCredentialSources(process.env, 'health'),
    cwd: process.cwd(),
    legacyAgentApiUsage: legacyUsage,
  });
});
app.use('/api/application-update', applicationUpdateRoutes);

// API routes
app.use('/api/sql', sqlRoutes);
app.use('/api/auth', enterpriseAuthRoutes);
app.use('/api/auth', enterpriseApiKeyRoutes);
app.use('/api/tenant', enterpriseTenantRoutes);
app.use(
  '/api/workspaces/:workspaceId/traces',
  ...workspaceRouteContextMiddleware,
  simpleTraceRoutes,
);
app.use(
  '/api/workspaces/:workspaceId/reports',
  ...workspaceRouteContextMiddleware,
  reportRoutes,
);
app.use(
  '/api/workspaces/:workspaceId/agent',
  ...workspaceRouteContextMiddleware,
  agentRoutes,
);
app.use(
  '/api/workspaces/:workspaceId/providers',
  ...workspaceRouteContextMiddleware,
  providerRoutes,
);
app.use(
  '/api/workspaces/:workspaceId/analysis-results',
  ...workspaceRouteContextMiddleware,
  analysisResultRoutes,
);
app.use(
  '/api/workspaces/:workspaceId/windows',
  ...workspaceRouteContextMiddleware,
  workspaceWindowRoutes,
);
app.use(
  '/api/workspaces/:workspaceId/comparisons',
  ...workspaceRouteContextMiddleware,
  comparisonRoutes,
);
app.use(
  '/api/workspaces/:workspaceId/trace-config',
  ...workspaceRouteContextMiddleware,
  traceConfigProposalRoutes,
);
app.use(
  '/api/workspaces/:workspaceId/skill-packs',
  ...workspaceRouteContextMiddleware,
  skillPackRoutes,
);
app.use(
  '/api/workspaces/:workspaceId/batch-traces',
  ...workspaceRouteContextMiddleware,
  batchTraceRoutes,
);
app.use(
  '/api/traces',
  markLegacyApi(
    '/api/workspaces/:workspaceId/traces',
    'Legacy trace API is deprecated. Migrate to workspace-scoped trace APIs',
  ),
  simpleTraceRoutes,
);
app.use('/api/perfetto', rejectEnterpriseUnscopedApi, perfettoLocalRoutes);
app.use('/api/sessions', rejectEnterpriseUnscopedApi, sessionRoutes);
app.use('/api/perfetto-sql', rejectEnterpriseUnscopedApi, perfettoSqlRoutes);
app.use('/api/export', exportRoutes);
app.use('/api/template-analysis', rejectEnterpriseUnscopedApi, templateAnalysisRoutes);
app.use('/api/skills', rejectEnterpriseUnscopedApi, skillRoutes);
app.use('/api/admin/runtime', enterpriseRuntimeDashboardRoutes);
app.use('/api/admin', skillAdminRoutes);
app.use('/api/admin', strategyAdminRoutes);
app.use('/api/admin/self-evolution', selfEvolutionAdminRoutes);
app.use(
  '/api/reports',
  markLegacyApi(
    '/api/workspaces/:workspaceId/reports',
    'Legacy report API is deprecated. Migrate to workspace-scoped report APIs',
  ),
  reportRoutes,
);
app.use(
  AGENT_API_V1_BASE,
  markLegacyApi(
    '/api/workspaces/:workspaceId/agent',
    'Legacy agent API is deprecated. Migrate to workspace-scoped agent APIs',
  ),
  agentRoutes,
);
app.use(
  '/api/v1/providers',
  markLegacyApi(
    '/api/workspaces/:workspaceId/providers',
    'Legacy provider API is deprecated. Migrate to workspace-scoped provider APIs',
  ),
  providerRoutes,
);
app.use('/api/flamegraph', rejectEnterpriseUnscopedApi, flamegraphRoutes);
app.use('/api/critical-path', rejectEnterpriseUnscopedApi, criticalPathRoutes);
app.use('/api/baselines', baselineRoutes);
app.use('/api/ci', authenticate, ciGateRoutes);
app.use('/api/tp', traceProcessorProxyRoutes);
app.use('/api/memory', memoryRoutes);
app.use('/api/cases', caseRoutes);
app.use('/api/rag', ragAdminRoutes);
app.use(LEGACY_AGENT_API_BASE, rejectLegacyAgentApi);

const assistantShellDir = path.resolve(__dirname, '../public/assistant-shell');
app.get('/assistant-shell', (_req, res) => {
  res.sendFile(path.join(assistantShellDir, 'index.html'));
});
app.use('/assistant-shell', express.static(assistantShellDir));

const adminControlPlaneDir = path.resolve(__dirname, '../public/admin-control-plane');
app.get('/admin-control-plane', (_req, res) => {
  res.sendFile(path.join(adminControlPlaneDir, 'index.html'));
});
app.use('/admin-control-plane', express.static(adminControlPlaneDir));

// Serve uploaded files in development
if (NODE_ENV === 'development') {
  app.use('/uploads', express.static(path.join(__dirname, '../uploads')));
}

// 404 handler
app.use((req, res) => {
  res.status(404).json({
    error: 'Route not found',
    message: `Cannot ${req.method} ${req.originalUrl}`,
  });
});

// Global error handler
app.use((err: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
  console.error('Unhandled error:', err);

  res.status(err.status || 500).json({
    error: 'Internal server error',
    message: NODE_ENV === 'development' ? err.message : 'Something went wrong',
    ...(NODE_ENV === 'development' && { stack: err.stack }),
  });
});

// Initialize services
function recoverInterruptedEnterpriseRuns(): void {
  if (!resolveFeatureConfig().enterprise) return;
  try {
    const recovered = failInterruptedAnalysisRunsOnStartup();
    if (recovered.length > 0) {
      console.warn(
        `[EnterpriseRecovery] Marked ${recovered.length} interrupted analysis run(s) failed after backend startup`,
      );
    }
  } catch (error: any) {
    console.warn('[EnterpriseRecovery] Failed to recover interrupted analysis runs:', error?.message || error);
  }
}

recoverInterruptedEnterpriseRuns();

const selfEvolutionLifecycle = initializeSelfEvolutionLifecycle();
if (selfEvolutionLifecycle.persistence.persistence === 'unavailable') {
  console.warn(
    `[SelfEvolution] Persistent apply unavailable: ${selfEvolutionLifecycle.persistence.reason}`,
  );
}
if (selfEvolutionLifecycle.migration.status === 'failed') {
  console.error(
    '[SelfEvolution] Legacy data migration failed: ' +
    `${selfEvolutionLifecycle.migration.errorCode ?? 'unknown_error'}`,
  );
}
for (const warning of selfEvolutionLifecycle.warnings) {
  console.warn(`[SelfEvolution] ${warning.message}`);
}
for (const error of selfEvolutionLifecycle.errors) {
  console.error(`[SelfEvolution] ${error.message}`);
}

let caseEvolutionWorkerHandle:
  ReturnType<typeof startCaseEvolutionWorker> | undefined;
let patternMemorySweepHandle:
  ReturnType<typeof startPatternMemoryAutoConfirmSweep> | undefined;
let androidInternalsPackUpdateWorkerHandle:
  ReturnType<typeof startAndroidInternalsPackUpdateWorker> | undefined;
let applicationUpdateWorkerHandle:
  ReturnType<typeof startApplicationUpdateWorker> | undefined;
let traceProcessorLeaseSupervisorHandle:
  ReturnType<typeof startTraceProcessorLeaseSupervisor> | undefined;

// Graceful shutdown handler
let shutdownStarted = false;
let server: Server | undefined;
const upgradedSockets = new Set<Duplex>();
function gracefulShutdown(signal: string) {
  if (shutdownStarted) return;
  shutdownStarted = true;
  console.log(`\n📴 Received ${signal}, shutting down gracefully...`);

  // Cleanup all trace processors (this will also release ports)
  console.log('🧹 Cleaning up trace processors...');
  TraceProcessorFactory.cleanup();

  // Reset port pool
  console.log('🔌 Resetting port pool...');
  resetPortPool();

  console.log('🧠 Stopping case evolution worker...');
  caseEvolutionWorkerHandle?.stop();

  console.log('🧠 Stopping pattern memory sweep...');
  patternMemorySweepHandle?.stop();

  console.log('📚 Stopping Android Internals Knowledge Pack updater...');
  androidInternalsPackUpdateWorkerHandle?.stop();

  console.log('⬆️ Stopping application update checker...');
  applicationUpdateWorkerHandle?.stop();

  console.log('🧹 Stopping trace processor lease supervisor...');
  traceProcessorLeaseSupervisorHandle?.stop();

  console.log('🧬 Closing self-evolution admin control plane...');
  closeSelfEvolutionAdminService();
  const closedEventStreams = activeHttpResponses.closeEventStreams();
  if (closedEventStreams > 0) {
    console.log(`📡 Closed ${closedEventStreams} active SSE connection(s).`);
  }

  if (!server) {
    console.log('✅ Cleanup complete before listener startup, exiting...');
    process.exit(0);
  }

  for (const socket of upgradedSockets) {
    socket.end();
  }
  const forcedExit = setTimeout(() => {
    for (const socket of upgradedSockets) {
      socket.destroy();
    }
    server?.closeAllConnections();
    console.error('❌ Backend connections did not close within the shutdown deadline.');
    process.exit(1);
  }, 5_000);
  forcedExit.unref();
  server.close((error) => {
    clearTimeout(forcedExit);
    if (error) {
      console.error('❌ Backend listener shutdown failed:', error);
      process.exit(1);
    }
    console.log('✅ Cleanup complete, exiting...');
    process.exit(0);
  });
}

// Register signal handlers
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
installRuntimeShutdownControl(gracefulShutdown);

// EPIPE guard: prevent stdout/stderr/uncaughtException EPIPE from crashing the server.
// Non-EPIPE uncaught exceptions still trigger graceful shutdown.
installEpipeGuard((error) => {
  console.error('❌ Uncaught Exception:', error);
  gracefulShutdown('uncaughtException');
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('❌ Unhandled Rejection at:', promise, 'reason:', reason);
});

async function startBackend(): Promise<void> {
  const startup = await reconcileSelfEvolutionOnStartup({
    lifecycle: selfEvolutionLifecycle,
    traceProcessorVersion:
      process.env.SMARTPERFETTO_TRACE_PROCESSOR_VERSION,
  });
  if (startup.status === 'reconciled') {
    console.log(
      `[SelfEvolution] Reconciled ${startup.reconciliations.length} scope(s) before startup`,
    );
  } else if (startup.status === 'identity_unavailable') {
    console.warn(
      '[SelfEvolution] Overlay reconciliation skipped because the current build identity is not comparable; persisted overlays remain unpublished',
    );
  }

  caseEvolutionWorkerHandle = startCaseEvolutionWorker();
  patternMemorySweepHandle = startPatternMemoryAutoConfirmSweep();
  androidInternalsPackUpdateWorkerHandle =
    startAndroidInternalsPackUpdateWorker();
  applicationUpdateWorkerHandle = startApplicationUpdateWorker();
  traceProcessorLeaseSupervisorHandle =
    startTraceProcessorLeaseSupervisor();

  if (shouldCleanOrphanProcessorsOnStartup()) {
    killOrphanProcessors();
  } else {
    console.log(
      '[TraceProcessor] Skipping global orphan cleanup for isolated process ownership',
    );
  }

  server = app.listen(PORT, serverConfig.bindHost, () => {
    const advertisedHost = serverConfig.bindHost === '0.0.0.0'
      ? '127.0.0.1'
      : serverConfig.bindHost === '::'
        ? '[::1]'
        : serverConfig.bindHost.includes(':')
          ? `[${serverConfig.bindHost}]`
          : serverConfig.bindHost;
    console.log(`🚀 Server running on ${serverConfig.bindHost}:${PORT}`);
    console.log(`📊 Environment: ${NODE_ENV}`);
    console.log(`🔗 API URL: http://${advertisedHost}:${PORT}/api`);
    console.log(`❤️  Health check: http://${advertisedHost}:${PORT}/health`);
    console.log(`📈 Stats: http://${advertisedHost}:${PORT}/api/traces/stats`);
  });

  server.on('upgrade', (req, socket, head) => {
    upgradedSockets.add(socket);
    socket.once('close', () => upgradedSockets.delete(socket));
    if (handleTraceProcessorProxyUpgrade(req, socket, head)) return;
    socket.destroy();
  });

  server.on('close', () => {
    console.log('🔒 Server closed');
  });
}

void startBackend().catch(error => {
  console.error(
    '[SelfEvolution] Startup reconciliation failed; backend listener remains closed:',
    error,
  );
  process.exitCode = 1;
});
