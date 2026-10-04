// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

/**
 * SmartPerfetto Unified Configuration
 *
 * 集中管理所有配置值，支持环境变量覆盖
 * 遵循 12-factor app 原则
 */

import { parseFlagValue } from '../utils/envFlag';

// =============================================================================
// Helper Functions
// =============================================================================

function parseIntEnv(key: string, defaultValue: number, env: NodeJS.ProcessEnv = process.env): number {
  const value = env[key];
  if (!value) return defaultValue;
  const parsed = parseInt(value, 10);
  return isNaN(parsed) ? defaultValue : parsed;
}

function parsePositiveIntEnv(key: string, defaultValue: number, env: NodeJS.ProcessEnv = process.env): number {
  const parsed = parseIntEnv(key, defaultValue, env);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : defaultValue;
}

function parseFloatEnv(key: string, defaultValue: number, env: NodeJS.ProcessEnv = process.env): number {
  const value = env[key];
  if (!value) return defaultValue;
  const parsed = parseFloat(value);
  return isNaN(parsed) ? defaultValue : parsed;
}

function parseArrayEnv(key: string, defaultValue: string[], env: NodeJS.ProcessEnv = process.env): string[] {
  const value = env[key];
  if (!value) return defaultValue;
  return value.split(',').map(s => s.trim()).filter(s => s.length > 0);
}

function parseBoolEnv(key: string, defaultValue: boolean, env: NodeJS.ProcessEnv = process.env): boolean {
  const value = env[key];
  if (!value) return defaultValue;
  return value.toLowerCase() === 'true' || value === '1';
}

function parseFeatureFlag(value: string | undefined, defaultValue: boolean = false): boolean {
  return parseFlagValue(value) ?? defaultValue;
}

// =============================================================================
// Feature Flags
// =============================================================================

export const ENTERPRISE_FEATURE_FLAG_ENV = 'SMARTPERFETTO_ENTERPRISE';
export const SMARTPERFETTO_OIDC_ALLOW_INSECURE_HTTP_ENV = 'SMARTPERFETTO_OIDC_ALLOW_INSECURE_HTTP';
export const SMARTPERFETTO_SERVER_SECRET_ENV = 'SMARTPERFETTO_SERVER_SECRET';
const SMARTPERFETTO_SSO_COOKIE_SECRET_ENV = 'SMARTPERFETTO_SSO_COOKIE_SECRET';
export const SMARTPERFETTO_API_KEY_ENV = 'SMARTPERFETTO_API_KEY';
export const SMARTPERFETTO_BACKEND_PORT_ENV = 'SMARTPERFETTO_BACKEND_PORT';
export const SMARTPERFETTO_FRONTEND_PORT_ENV = 'SMARTPERFETTO_FRONTEND_PORT';
export const SMARTPERFETTO_BACKEND_PUBLIC_PORT_ENV = 'SMARTPERFETTO_BACKEND_PUBLIC_PORT';
export const SMARTPERFETTO_BACKEND_PUBLIC_URL_ENV = 'SMARTPERFETTO_BACKEND_PUBLIC_URL';
export const SMARTPERFETTO_BIND_HOST_ENV = 'SMARTPERFETTO_BIND_HOST';
export const DEFAULT_BACKEND_PORT = 3000;
export const DEFAULT_FRONTEND_PORT = 10000;

export interface FeatureConfig {
  /**
   * Enables enterprise multi-tenant code paths.
   *
   * Keep this default-off until RequestContext, lease proxy, and DB-authoritative
   * paths are fully covered by the enterprise regression matrix.
   */
  enterprise: boolean;
}

export type SmartPerfettoAuthMode = 'local' | 'api_key' | 'oidc';

export interface AuthConfig {
  mode: SmartPerfettoAuthMode;
  oidcEnabled: boolean;
  cookieSecure: boolean;
  allowInsecureHttp: boolean;
}

const OIDC_ENV = {
  issuerUrl: 'SMARTPERFETTO_OIDC_ISSUER_URL',
  clientId: 'SMARTPERFETTO_OIDC_CLIENT_ID',
  clientSecret: 'SMARTPERFETTO_OIDC_CLIENT_SECRET',
  redirectUri: 'SMARTPERFETTO_OIDC_REDIRECT_URI',
} as const;

export type OidcEnvValues = Partial<Record<keyof typeof OIDC_ENV, string>>;

/**
 * The built-in OIDC values, each trimmed; an empty value is absent. The
 * startup guard, the OIDC client and the callback cookie path all read OIDC
 * configuration through this one function.
 */
export function readOidcEnv(env: NodeJS.ProcessEnv = process.env): OidcEnvValues {
  const values: OidcEnvValues = {};
  for (const [field, key] of Object.entries(OIDC_ENV) as Array<[keyof typeof OIDC_ENV, string]>) {
    const value = env[key]?.trim();
    if (value) values[field] = value;
  }
  return values;
}

/** The env keys a server secret root is chosen from, in priority order. */
export function serverSecretCandidateKeys(preferredEnvKeys: readonly string[] = []): string[] {
  return [
    ...preferredEnvKeys,
    SMARTPERFETTO_SERVER_SECRET_ENV,
    SMARTPERFETTO_SSO_COOKIE_SECRET_ENV,
    SMARTPERFETTO_API_KEY_ENV,
  ];
}

/**
 * Picks the root secret every server-side signing purpose derives from: the
 * first candidate whose trimmed value has at least `minimumBytes` UTF-8 bytes.
 * Shorter values are skipped. Signing and the OIDC startup guard both choose
 * the root through this function.
 */
export function selectServerSecretRoot(
  env: NodeJS.ProcessEnv,
  options: {preferredEnvKeys?: readonly string[]; minimumBytes: number},
): string | undefined {
  return serverSecretCandidateKeys(options.preferredEnvKeys)
    .map(key => env[key]?.trim())
    .find((value): value is string =>
      typeof value === 'string' && Buffer.byteLength(value, 'utf8') >= options.minimumBytes);
}

/**
 * Whether request headers from a trusted SSO proxy carry identity. The OIDC
 * startup guard and request authentication must read the flag identically.
 */
export function isSsoTrustedHeadersEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return parseFeatureFlag(env.SMARTPERFETTO_SSO_TRUSTED_HEADERS);
}

/**
 * Whether built-in OIDC may use plaintext HTTP. The startup guard and the OIDC
 * client must read the flag identically: a spelling only one of them honoured
 * would let the client accept insecure discovery endpoints the guard refused.
 */
export function isOidcInsecureHttpAllowed(env: NodeJS.ProcessEnv = process.env): boolean {
  return parseFeatureFlag(env[SMARTPERFETTO_OIDC_ALLOW_INSECURE_HTTP_ENV]);
}

/**
 * Whether the operator API key is set. Any non-empty value counts, even one
 * that is only whitespace: the authenticator then demands that exact key, so
 * auth mode and startup checks must not treat it as absent.
 */
export function isOperatorApiKeyConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env[SMARTPERFETTO_API_KEY_ENV]);
}

export function isOidcConfigurationPresent(env: NodeJS.ProcessEnv = process.env): boolean {
  return Object.keys(readOidcEnv(env)).length > 0;
}

/**
 * Resolve the browser authentication contract. Supplying any built-in OIDC
 * value enables OIDC, while a partial configuration fails closed.
 */
export function resolveAuthConfig(env: NodeJS.ProcessEnv = process.env): AuthConfig {
  const oidc = readOidcEnv(env);
  const oidcConfigured = Object.keys(oidc).length > 0;
  const mode: SmartPerfettoAuthMode = oidcConfigured
    ? 'oidc'
    : isOperatorApiKeyConfigured(env) ? 'api_key' : 'local';
  const allowInsecureHttp = mode === 'oidc' && isOidcInsecureHttpAllowed(env);

  if (mode === 'oidc') {
    const missing = (Object.keys(OIDC_ENV) as Array<keyof typeof OIDC_ENV>)
      .filter(field => !oidc[field])
      .map(field => OIDC_ENV[field]);
    if (missing.length > 0) {
      throw new Error(
        `OIDC mode requires ${missing.join(', ')}; refusing to start with a partial OIDC configuration`,
      );
    }
    if (!env.FRONTEND_URL?.trim()) {
      throw new Error('OIDC mode requires FRONTEND_URL for the post-login redirect');
    }
    if (isOperatorApiKeyConfigured(env)) {
      throw new Error('OIDC mode cannot be combined with SMARTPERFETTO_API_KEY');
    }
    // The root signing will pick, with no length floor: a dedicated secret
    // that is set but too short is an operator error here, not a value to
    // skip. The API key cannot be the candidate, it was rejected above.
    const serverSecret = selectServerSecretRoot(env, {minimumBytes: 1});
    if (!serverSecret || Buffer.byteLength(serverSecret, 'utf8') < 32) {
      throw new Error(
        `OIDC mode requires ${SMARTPERFETTO_SERVER_SECRET_ENV} (at least 32 bytes)`,
      );
    }
    if (isSsoTrustedHeadersEnabled(env)) {
      throw new Error('OIDC mode cannot be combined with SMARTPERFETTO_SSO_TRUSTED_HEADERS');
    }
    const urlInputs = {
      [OIDC_ENV.issuerUrl]: oidc.issuerUrl!,
      [OIDC_ENV.redirectUri]: oidc.redirectUri!,
      FRONTEND_URL: env.FRONTEND_URL!,
    };
    const urls = new Map<string, URL>();
    for (const [key, value] of Object.entries(urlInputs)) {
      try {
        const url = new URL(value);
        if (url.protocol !== 'http:' && url.protocol !== 'https:') {
          throw new Error('http_required');
        }
        if (url.username || url.password || url.hash) {
          throw new Error('credentials_or_fragment_not_allowed');
        }
        if (key !== OIDC_ENV.redirectUri && url.search) {
          throw new Error('query_not_allowed');
        }
        if (url.protocol !== 'https:' && !allowInsecureHttp) {
          throw new Error('https_required');
        }
        urls.set(key, url);
      } catch {
        const suffix = !allowInsecureHttp
          ? 'absolute HTTPS URL'
          : 'absolute HTTP(S) URL';
        throw new Error(`${key} must be an ${suffix} in OIDC mode`);
      }
    }
    const redirectUrl = urls.get(OIDC_ENV.redirectUri)!;
    const frontendUrl = urls.get('FRONTEND_URL')!;
    if (redirectUrl.search || !redirectUrl.pathname.endsWith('/api/auth/oidc/callback')) {
      throw new Error(
        'SMARTPERFETTO_OIDC_REDIRECT_URI must end with /api/auth/oidc/callback and must not contain a query or fragment',
      );
    }
    if (frontendUrl.pathname !== '/' || frontendUrl.search || frontendUrl.hash) {
      throw new Error('FRONTEND_URL must be a browser origin without a path, query, or fragment');
    }
    if (redirectUrl.protocol !== frontendUrl.protocol
      || redirectUrl.hostname !== frontendUrl.hostname) {
      throw new Error(
        'OIDC mode requires FRONTEND_URL and SMARTPERFETTO_OIDC_REDIRECT_URI '
        + 'to use the same scheme and hostname; ports may differ',
      );
    }
    const configuredBackendUrl = env[SMARTPERFETTO_BACKEND_PUBLIC_URL_ENV]?.trim()
      || env.SMARTPERFETTO_BACKEND_URL?.trim();
    if (configuredBackendUrl) {
      let backendUrl: URL;
      try {
        backendUrl = new URL(configuredBackendUrl);
      } catch {
        throw new Error(`${SMARTPERFETTO_BACKEND_PUBLIC_URL_ENV} must be an absolute HTTP(S) URL`);
      }
      if (
        !['http:', 'https:'].includes(backendUrl.protocol)
        || backendUrl.username
        || backendUrl.password
        || backendUrl.search
        || backendUrl.hash
      ) {
        throw new Error(
          `${SMARTPERFETTO_BACKEND_PUBLIC_URL_ENV} must be an absolute HTTP(S) URL without credentials, query, or fragment`,
        );
      }
      if (backendUrl.protocol !== 'https:' && !allowInsecureHttp) {
        throw new Error(`${SMARTPERFETTO_BACKEND_PUBLIC_URL_ENV} must be an absolute HTTPS URL in OIDC mode`);
      }
      if (backendUrl.protocol !== redirectUrl.protocol
        || backendUrl.hostname !== redirectUrl.hostname) {
        throw new Error(
          `${SMARTPERFETTO_BACKEND_PUBLIC_URL_ENV} and SMARTPERFETTO_OIDC_REDIRECT_URI must use the same scheme and hostname; ports may differ`,
        );
      }
      const backendBasePath = backendUrl.pathname.replace(/\/+$/, '');
      if (redirectUrl.pathname !== `${backendBasePath}/api/auth/oidc/callback`) {
        throw new Error(
          'SMARTPERFETTO_OIDC_REDIRECT_URI must match the configured backend public URL plus /api/auth/oidc/callback',
        );
      }
    } else if (redirectUrl.pathname !== '/api/auth/oidc/callback') {
      throw new Error(
        `A callback path prefix requires ${SMARTPERFETTO_BACKEND_PUBLIC_URL_ENV}`,
      );
    }
  }

  const cookieSecure = mode === 'oidc'
    && new URL(oidc.redirectUri!).protocol === 'https:';

  return {
    mode,
    oidcEnabled: mode === 'oidc',
    cookieSecure,
    allowInsecureHttp,
  };
}

export function resolveFeatureConfig(env: NodeJS.ProcessEnv = process.env): FeatureConfig {
  return {
    enterprise: parseFeatureFlag(env[ENTERPRISE_FEATURE_FLAG_ENV], false)
      || resolveAuthConfig(env).oidcEnabled,
  };
}

/**
 * Whether the API runs without authentication, so an unauthenticated request
 * acts as the local dev identity: no operator API key and not enterprise mode
 * (which built-in OIDC implies). Request and WebSocket authentication, the
 * local Host guard and the health report all read this one predicate.
 */
export function isKeylessLocalMode(env: NodeJS.ProcessEnv = process.env): boolean {
  return !isOperatorApiKeyConfigured(env) && !resolveFeatureConfig(env).enterprise;
}

export const featureConfig = resolveFeatureConfig();

// =============================================================================
// Server Configuration
// =============================================================================

function parsePortValue(value: string | undefined): number | null {
  if (!value) return null;
  const normalized = value.trim();
  if (!/^\d+$/.test(normalized)) return null;
  const parsed = Number(normalized);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) return null;
  return parsed;
}

function resolvePort(
  env: NodeJS.ProcessEnv,
  keys: string[],
  defaultValue: number,
): number {
  for (const key of keys) {
    const parsed = parsePortValue(env[key]);
    if (parsed !== null) return parsed;
  }
  return defaultValue;
}

function defaultCorsOrigins(frontendPort: number, env: NodeJS.ProcessEnv): string[] {
  const origins = [
    'http://localhost:8080',
    'http://localhost:5173',
    'http://localhost:5174',
    `http://localhost:${frontendPort}`,
    'http://127.0.0.1:8080',
    'http://127.0.0.1:5173',
    'http://127.0.0.1:5174',
    `http://127.0.0.1:${frontendPort}`,
  ];
  if (env.FRONTEND_URL) origins.push(env.FRONTEND_URL);
  return Array.from(new Set(origins));
}

export function resolveServerConfig(env: NodeJS.ProcessEnv = process.env) {
  const frontendPort = resolvePort(
    env,
    [SMARTPERFETTO_FRONTEND_PORT_ENV],
    DEFAULT_FRONTEND_PORT,
  );

  return {
    /** Server port */
    port: resolvePort(
      env,
      [SMARTPERFETTO_BACKEND_PORT_ENV, 'PORT'],
      DEFAULT_BACKEND_PORT,
    ),

    /** Listen on loopback unless a deployment explicitly opts into a wider interface. */
    bindHost: env[SMARTPERFETTO_BIND_HOST_ENV]?.trim() || '127.0.0.1',

    /** Perfetto UI/static frontend port */
    frontendPort,

    /** Browser-visible backend port for generated runtime config. */
    backendPublicPort: resolvePort(
      env,
      [
        SMARTPERFETTO_BACKEND_PUBLIC_PORT_ENV,
        SMARTPERFETTO_BACKEND_PORT_ENV,
        'PORT',
      ],
      DEFAULT_BACKEND_PORT,
    ),

    /** Browser-visible backend URL for reverse proxy / HTTPS deployments. */
    backendPublicUrl: env[SMARTPERFETTO_BACKEND_PUBLIC_URL_ENV]
      || env.SMARTPERFETTO_BACKEND_URL
      || '',

    /** Node environment */
    nodeEnv: env.NODE_ENV || 'development',

    /** CORS allowed origins */
    corsOrigins: parseArrayEnv(
      'CORS_ORIGINS',
      defaultCorsOrigins(frontendPort, env),
      env,
    ),

    /** Request body size limit */
    bodyLimit: env.BODY_LIMIT || '50mb',
  } as const;
}

export const serverConfig = resolveServerConfig();

// =============================================================================
// Trace Processor Configuration
// =============================================================================

export const traceProcessorConfig = {
  /** Port pool range for trace processors */
  portRange: {
    min: parseIntEnv('TP_PORT_MIN', 9100),
    max: parseIntEnv('TP_PORT_MAX', 9900),
  },

  /** Perfetto UI origin for CORS */
  perfettoUiOrigin: process.env.PERFETTO_UI_ORIGIN || `http://localhost:${serverConfig.frontendPort}`,

  /** Server startup timeout (ms) */
  startupTimeoutMs: parseIntEnv('TP_STARTUP_TIMEOUT_MS', 30000),

  /**
   * Additional startup allowance for large traces. trace_processor_shell parses
   * the command-line trace before announcing HTTP readiness.
   */
  startupTimeoutPerGiBMs: parseIntEnv('TP_STARTUP_TIMEOUT_PER_GIB_MS', 2 * 60 * 1000),

  /** Upper bound for size-adjusted startup timeout (ms). */
  startupTimeoutMaxMs: parseIntEnv('TP_STARTUP_TIMEOUT_MAX_MS', 15 * 60 * 1000),

  /** Query execution timeout (ms). Enterprise v1 requires 24h by default. */
  queryTimeoutMs: parseIntEnv('TP_QUERY_TIMEOUT_MS', 24 * 60 * 60 * 1000),

  /** Dedicated health-query timeout (ms); independent from the main SQL queue. */
  healthQueryTimeoutMs: parseIntEnv('TP_HEALTH_QUERY_TIMEOUT_MS', 10000),

  /** TCP accept probe timeout (ms) for trace_processor HTTP RPC health checks. */
  healthRpcAcceptTimeoutMs: parseIntEnv('TP_HEALTH_RPC_ACCEPT_TIMEOUT_MS', 10000),

  /** Process kill timeout (ms) */
  killTimeoutMs: parseIntEnv('TP_KILL_TIMEOUT_MS', 2000),

  /** Stale allocation cleanup age (ms) - default 30 minutes */
  staleAllocationMaxAgeMs: parseIntEnv('TP_STALE_MAX_AGE_MS', 30 * 60 * 1000),

  /**
   * Preload a small critical subset of stdlib modules during processor startup.
   * Keeps key Android views available without blocking startup on full stdlib preload.
   */
  preloadCriticalStdlibModules: parseBoolEnv('TP_PRELOAD_CRITICAL_STDLIB_MODULES', true),

  /**
   * Preload all stdlib modules in the background after processor is marked ready.
   * Disabled by default to reduce upload-to-ready latency.
   */
  preloadAllStdlibModules: parseBoolEnv('TP_PRELOAD_ALL_STDLIB_MODULES', false),
} as const;

// =============================================================================
// Agent Configuration
// =============================================================================

export const DEFAULT_AGENT_MAX_TURNS = 100;
export const DEFAULT_AGENT_QUICK_MAX_TURNS = 50;
export const DEFAULT_AGENT_QUICK_TARGET_TURNS = 5;
export const DEFAULT_AGENT_SESSION_MAX_IDLE_MS = 12 * 60 * 60 * 1000;
export const DEFAULT_AGENT_SESSION_CLEANUP_INTERVAL_MS = 30 * 60 * 1000;

export interface AgentRuntimeBudgetConfig {
  /** Shared full-analysis turn budget fallback for all agent runtimes. */
  maxTurns: number;
  /** Shared quick-analysis turn budget fallback for all agent runtimes. */
  quickMaxTurns: number;
  /** Shared quick-analysis product target. This is a soft target, not a stop condition. */
  quickTargetTurns: number;
}

export function resolveAgentRuntimeBudgetConfig(
  env: NodeJS.ProcessEnv = process.env,
): AgentRuntimeBudgetConfig {
  const quickMaxTurns = parsePositiveIntEnv('AGENT_QUICK_MAX_TURNS', DEFAULT_AGENT_QUICK_MAX_TURNS, env);
  const rawQuickTargetTurns = parsePositiveIntEnv('AGENT_QUICK_TARGET_TURNS', DEFAULT_AGENT_QUICK_TARGET_TURNS, env);
  return {
    maxTurns: parsePositiveIntEnv('AGENT_MAX_TURNS', DEFAULT_AGENT_MAX_TURNS, env),
    quickMaxTurns,
    quickTargetTurns: Math.min(rawQuickTargetTurns, quickMaxTurns),
  };
}

export interface AgentSessionConfig {
  /** Idle retention for completed/failed assistant sessions. */
  terminalMaxIdleMs: number;
  /** Idle retention for abandoned pending/running/awaiting-user sessions without SSE clients. */
  nonTerminalMaxIdleMs: number;
  /** In-memory multi-turn context TTL. Keep this >= nonTerminalMaxIdleMs unless intentionally pruning context. */
  contextMaxAgeMs: number;
  /** Background cleanup cadence for session and scene-report sweeps. */
  cleanupIntervalMs: number;
}

export function resolveAgentSessionConfig(
  env: NodeJS.ProcessEnv = process.env,
): AgentSessionConfig {
  const nonTerminalMaxIdleMs = parsePositiveIntEnv(
    'AGENT_NON_TERMINAL_SESSION_MAX_IDLE_MS',
    DEFAULT_AGENT_SESSION_MAX_IDLE_MS,
    env,
  );

  return {
    terminalMaxIdleMs: parsePositiveIntEnv(
      'AGENT_TERMINAL_SESSION_MAX_IDLE_MS',
      DEFAULT_AGENT_SESSION_MAX_IDLE_MS,
      env,
    ),
    nonTerminalMaxIdleMs,
    contextMaxAgeMs: parsePositiveIntEnv(
      'AGENT_SESSION_CONTEXT_MAX_AGE_MS',
      nonTerminalMaxIdleMs,
      env,
    ),
    cleanupIntervalMs: parsePositiveIntEnv(
      'AGENT_SESSION_CLEANUP_INTERVAL_MS',
      DEFAULT_AGENT_SESSION_CLEANUP_INTERVAL_MS,
      env,
    ),
  };
}

export const agentRuntimeBudgetConfig = resolveAgentRuntimeBudgetConfig();
export const agentSessionConfig = resolveAgentSessionConfig();

export const agentConfig = {
  /** Maximum total iterations for analysis */
  maxTotalIterations: parseIntEnv('AGENT_MAX_ITERATIONS', 3),

  /** Shared runtime turn budgets; runtime-specific env vars still take precedence. */
  runtimeBudget: agentRuntimeBudgetConfig,

  /** Assistant session retention and cleanup settings. */
  sessions: agentSessionConfig,

  /** Enable trace recording */
  enableTraceRecording: parseBoolEnv('AGENT_ENABLE_TRACE_RECORDING', true),

  /** Evaluation criteria */
  evaluation: {
    /** Minimum quality score to pass (0-1) */
    minQualityScore: parseFloatEnv('AGENT_MIN_QUALITY_SCORE', 0.5),

    /** Minimum completeness score to pass (0-1) */
    minCompletenessScore: parseFloatEnv('AGENT_MIN_COMPLETENESS_SCORE', 0.5),

    /** Maximum allowed contradictions */
    maxContradictions: parseIntEnv('AGENT_MAX_CONTRADICTIONS', 0),
  },
} as const;

// =============================================================================
// Pipeline Configuration
// =============================================================================

export const pipelineConfig = {
  /** Maximum total duration for entire pipeline (ms) */
  maxTotalDurationMs: parseIntEnv('PIPELINE_MAX_DURATION_MS', 300000),

  /** Enable parallel execution of stages */
  enableParallelization: parseBoolEnv('PIPELINE_ENABLE_PARALLEL', true),

  /** Stage timeouts (ms) */
  stageTimeouts: {
    planner: parseIntEnv('PIPELINE_PLANNER_TIMEOUT_MS', 30000),
    analysis: parseIntEnv('PIPELINE_ANALYSIS_TIMEOUT_MS', 60000),
    evaluation: parseIntEnv('PIPELINE_EVALUATION_TIMEOUT_MS', 30000),
    synthesis: parseIntEnv('PIPELINE_SYNTHESIS_TIMEOUT_MS', 60000),
    decision: parseIntEnv('PIPELINE_DECISION_TIMEOUT_MS', 30000),
  },

  /** Stage max retries */
  stageMaxRetries: {
    planner: parseIntEnv('PIPELINE_PLANNER_MAX_RETRIES', 2),
    analysis: parseIntEnv('PIPELINE_ANALYSIS_MAX_RETRIES', 2),
    evaluation: parseIntEnv('PIPELINE_EVALUATION_MAX_RETRIES', 1),
    synthesis: parseIntEnv('PIPELINE_SYNTHESIS_MAX_RETRIES', 2),
    decision: parseIntEnv('PIPELINE_DECISION_MAX_RETRIES', 1),
  },

  /** Auto-save interval for state machine (ms) */
  autoSaveIntervalMs: parseIntEnv('PIPELINE_AUTO_SAVE_INTERVAL_MS', 5000),
} as const;

// =============================================================================
// Model Router Configuration
// =============================================================================

export const modelRouterConfig = {
  /** Default model to use */
  defaultModel: process.env.MODEL_DEFAULT || 'glm-5',

  /** Fallback chain for model failures */
  fallbackChain: parseArrayEnv('MODEL_FALLBACK_CHAIN', ['deepseek-reasoner', 'deepseek-chat']),

  /** Enable ensemble mode */
  enableEnsemble: parseBoolEnv('MODEL_ENABLE_ENSEMBLE', false),

  /** Ensemble confidence threshold (0-1) */
  ensembleThreshold: parseFloatEnv('MODEL_ENSEMBLE_THRESHOLD', 0.8),
} as const;

// =============================================================================
// Fork Manager Configuration
// =============================================================================

export const forkConfig = {
  /** Fork expiration time (ms) - default 24 hours */
  expirationMs: parseIntEnv('FORK_EXPIRATION_MS', 24 * 60 * 60 * 1000),
} as const;

// =============================================================================
// Analysis Configuration (SQL query limits and thresholds)
// =============================================================================

export const analysisConfig = {
  /** SQL query result limits */
  queryLimits: {
    /** VSYNC interval query limit */
    vsyncInterval: parseIntEnv('QUERY_LIMIT_VSYNC', 500),

    /** Frame data query limit */
    frameData: parseIntEnv('QUERY_LIMIT_FRAME', 1000),

    /** Jank details query limit */
    jankDetails: parseIntEnv('QUERY_LIMIT_JANK', 10),

    /** Slice details query limit */
    sliceDetails: parseIntEnv('QUERY_LIMIT_SLICE', 20),
  },

  /** Frame analysis thresholds (nanoseconds) */
  frameThresholds: {
    /** Default VSYNC period for 60Hz (16.67ms in ns) */
    defaultVsyncPeriodNs: parseIntEnv('FRAME_DEFAULT_VSYNC_NS', 16666666),

    /** Minimum VSYNC interval to consider valid (ns) */
    minVsyncIntervalNs: parseIntEnv('FRAME_MIN_VSYNC_NS', 5000000),

    /** Maximum VSYNC interval to consider valid (ns) */
    maxVsyncIntervalNs: parseIntEnv('FRAME_MAX_VSYNC_NS', 30000000),

    /** Minimum frame duration to consider (ns) */
    minFrameDurationNs: parseIntEnv('FRAME_MIN_DURATION_NS', 5000000),

    /** Maximum frame duration to consider (ns) */
    maxFrameDurationNs: parseIntEnv('FRAME_MAX_DURATION_NS', 20000000),

    /** Minimum slice duration for analysis (ns) */
    minSliceDurationNs: parseIntEnv('SLICE_MIN_DURATION_NS', 1000000),

    /** Frame analyzer minimum duration threshold (ms) */
    minDurationThresholdMs: parseFloatEnv('FRAME_MIN_DURATION_MS', 0.5),
  },

  /** Time windows for analysis (ns) */
  timeWindows: {
    /** Time window around events (ns) - 50ms */
    eventContextNs: parseIntEnv('TIME_WINDOW_EVENT_NS', 50000000),
  },

  /** Minimum counts for statistical validity */
  minCounts: {
    /** Minimum count for slice grouping */
    sliceGrouping: parseIntEnv('MIN_COUNT_SLICE_GROUP', 10),
  },
} as const;

// =============================================================================
// Context Configuration
// =============================================================================

export const contextConfig = {
  /** Maximum tokens for prompt context */
  maxPromptTokens: parseIntEnv('CONTEXT_MAX_PROMPT_TOKENS', 500),
} as const;

// =============================================================================
// Feature Flags
// =============================================================================

export const featureFlagsConfig = {
  /** Toggle scene reconstruction endpoints without redeploying code paths */
  enableAgentSceneReconstruct: parseBoolEnv('FEATURE_AGENT_SCENE_RECONSTRUCT', true),

  /** Toggle debug log endpoints */
  enableAgentLogsApi: parseBoolEnv('FEATURE_AGENT_LOGS_API', true),
} as const;

// =============================================================================
// Scene Story Pipeline Configuration
// =============================================================================

export const sceneStoryConfig = {
  /** JobRunner concurrent analysis jobs */
  analysisConcurrency: parseIntEnv('SCENE_ANALYSIS_CONCURRENCY', 3),

  /** Max retries per job after initial failure */
  jobMaxRetries: parseIntEnv('SCENE_JOB_MAX_RETRIES', 1),

  /** Disk cache TTL for file-backed trace reports */
  reportTtlMs: parseIntEnv('SCENE_REPORT_TTL_MS', 7 * 24 * 60 * 60 * 1000),

  /** Disk store directory for SceneReport JSON (relative to backend cwd) */
  reportDir: process.env.SCENE_REPORT_DIR || 'data/scene-reports',

  /** Disk store directory for out-of-band Smart job artifacts */
  jobArtifactDir: process.env.SCENE_JOB_ARTIFACT_DIR || 'data/scene-job-artifacts',

  /** Process-memory LRU size for external RPC trace reports where no content hash is available */
  memoryCacheMaxSize: parseIntEnv('SCENE_REPORT_MEMORY_CACHE_MAX', 50),

  /** Process-memory bound for legacy quick-scene extraction results */
  quickSceneCacheMaxSize: parseIntEnv('SCENE_QUICK_CACHE_MAX', 100),

  /** Expiry for legacy quick-scene extraction results */
  quickSceneCacheTtlMs: parseIntEnv('SCENE_QUICK_CACHE_TTL_MS', 10 * 60 * 1000),

  /** Optional lightweight LLM double-check for ambiguous Smart scene reconstruction */
  llmVerify: parseBoolEnv('SCENE_RECONSTRUCTION_LLM_VERIFY', false),

  /** Timeout for optional scene reconstruction LLM verifier */
  llmVerifyTimeoutMs: parseIntEnv('SCENE_RECONSTRUCTION_LLM_VERIFY_TIMEOUT_MS', 30_000),
} as const;

// =============================================================================
// Frontend Configuration (for reference, actual values in frontend)
// =============================================================================

export const frontendConfig = {
  /** Default backend URL */
  backendUrl: process.env.BACKEND_URL
    || serverConfig.backendPublicUrl
    || `http://localhost:${serverConfig.backendPublicPort}`,

  /** Default Ollama URL */
  ollamaUrl: process.env.OLLAMA_URL || 'http://localhost:11434',
} as const;

// =============================================================================
// Re-export Thresholds Configuration
// =============================================================================

// Re-export all threshold-related types and values for easy access
export * from './thresholds';

// =============================================================================
// Export all configs as single object
// =============================================================================

export const config = {
  server: serverConfig,
  traceProcessor: traceProcessorConfig,
  agent: agentConfig,
  pipeline: pipelineConfig,
  modelRouter: modelRouterConfig,
  fork: forkConfig,
  analysis: analysisConfig,
  context: contextConfig,
  featureFlags: featureFlagsConfig,
  sceneStory: sceneStoryConfig,
  frontend: frontendConfig,
} as const;
