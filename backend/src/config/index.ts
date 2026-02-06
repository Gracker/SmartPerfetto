/**
 * SmartPerfetto Unified Configuration
 *
 * 集中管理所有配置值，支持环境变量覆盖
 * 遵循 12-factor app 原则
 */

// =============================================================================
// Helper Functions
// =============================================================================

function parseIntEnv(key: string, defaultValue: number): number {
  const value = process.env[key];
  if (!value) return defaultValue;
  const parsed = parseInt(value, 10);
  return isNaN(parsed) ? defaultValue : parsed;
}

function parseFloatEnv(key: string, defaultValue: number): number {
  const value = process.env[key];
  if (!value) return defaultValue;
  const parsed = parseFloat(value);
  return isNaN(parsed) ? defaultValue : parsed;
}

function parseArrayEnv(key: string, defaultValue: string[]): string[] {
  const value = process.env[key];
  if (!value) return defaultValue;
  return value.split(',').map(s => s.trim()).filter(s => s.length > 0);
}

function parseBoolEnv(key: string, defaultValue: boolean): boolean {
  const value = process.env[key];
  if (!value) return defaultValue;
  return value.toLowerCase() === 'true' || value === '1';
}

// =============================================================================
// Server Configuration
// =============================================================================

export const serverConfig = {
  /** Server port */
  port: parseIntEnv('PORT', 3000),

  /** Node environment */
  nodeEnv: process.env.NODE_ENV || 'development',

  /** CORS allowed origins */
  corsOrigins: parseArrayEnv('CORS_ORIGINS', [
    'http://localhost:8080',
    'http://localhost:5173',
    'http://localhost:5174',
    'http://localhost:10000',
    'http://127.0.0.1:8080',
    'http://127.0.0.1:5173',
    'http://127.0.0.1:5174',
    'http://127.0.0.1:10000',
  ]),

  /** Request body size limit */
  bodyLimit: process.env.BODY_LIMIT || '50mb',
} as const;

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
  perfettoUiOrigin: process.env.PERFETTO_UI_ORIGIN || 'http://localhost:10000',

  /** Server startup timeout (ms) */
  startupTimeoutMs: parseIntEnv('TP_STARTUP_TIMEOUT_MS', 30000),

  /** Query execution timeout (ms) */
  queryTimeoutMs: parseIntEnv('TP_QUERY_TIMEOUT_MS', 60000),

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

export const agentConfig = {
  /** Maximum total iterations for analysis */
  maxTotalIterations: parseIntEnv('AGENT_MAX_ITERATIONS', 3),

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
// Circuit Breaker Configuration
// =============================================================================

export const circuitBreakerConfig = {
  /** Maximum retries per agent */
  maxRetriesPerAgent: parseIntEnv('CB_MAX_RETRIES_PER_AGENT', 3),

  /** Maximum iterations per stage */
  maxIterationsPerStage: parseIntEnv('CB_MAX_ITERATIONS_PER_STAGE', 5),

  /** Cooldown period after tripping (ms) */
  cooldownMs: parseIntEnv('CB_COOLDOWN_MS', 30000),

  /** Number of attempts in half-open state */
  halfOpenAttempts: parseIntEnv('CB_HALF_OPEN_ATTEMPTS', 1),

  /** Number of failures before tripping */
  failureThreshold: parseIntEnv('CB_FAILURE_THRESHOLD', 3),

  /** Number of successes to close circuit */
  successThreshold: parseIntEnv('CB_SUCCESS_THRESHOLD', 2),

  /** Base delay for exponential backoff (ms) */
  backoffBaseDelayMs: parseIntEnv('CB_BACKOFF_BASE_DELAY_MS', 1000),

  /** Maximum delay for exponential backoff (ms) */
  backoffMaxDelayMs: parseIntEnv('CB_BACKOFF_MAX_DELAY_MS', 30000),

  // === User Intervention Thresholds ===

  /** Timeout waiting for user response (ms) - default 5 minutes */
  userResponseTimeoutMs: parseIntEnv('CB_USER_RESPONSE_TIMEOUT_MS', 5 * 60 * 1000),

  /** Cooldown period between forceClose calls (ms) - default 30 seconds */
  forceCloseCooldownMs: parseIntEnv('CB_FORCE_CLOSE_COOLDOWN_MS', 30000),

  /** Maximum forceClose calls per session */
  maxForceCloseCount: parseIntEnv('CB_MAX_FORCE_CLOSE_COUNT', 5),

  /** Successes needed in half-open state to fully close */
  halfOpenSuccessThreshold: parseIntEnv('CB_HALF_OPEN_SUCCESS_THRESHOLD', 3),
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
  defaultModel: process.env.MODEL_DEFAULT || 'deepseek-chat',

  /** Fallback chain for model failures */
  fallbackChain: parseArrayEnv('MODEL_FALLBACK_CHAIN', ['deepseek-chat']),

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
// Frontend Configuration (for reference, actual values in frontend)
// =============================================================================

export const frontendConfig = {
  /** Default backend URL */
  backendUrl: process.env.BACKEND_URL || 'http://localhost:3000',

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
  circuitBreaker: circuitBreakerConfig,
  pipeline: pipelineConfig,
  modelRouter: modelRouterConfig,
  fork: forkConfig,
  analysis: analysisConfig,
  context: contextConfig,
  frontend: frontendConfig,
} as const;

export default config;
