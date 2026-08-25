// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

"use strict";

const fs = require("fs");
const net = require("net");

const { PATHS } = require("./dual-trace-e2e-paths.cjs");

const DUMMY_OPENAI_API_KEY = "smartperfetto-e2e-local";
const DUMMY_BACKEND_API_KEY = "smartperfetto-e2e-backend";
const SAFE_INHERITED_ENVIRONMENT_KEYS = new Set([
  "APPDATA",
  "CI",
  "COLORTERM",
  "ComSpec",
  "DBUS_SESSION_BUS_ADDRESS",
  "DISPLAY",
  "DYLD_LIBRARY_PATH",
  "HOME",
  "LANG",
  "LD_LIBRARY_PATH",
  "LOCALAPPDATA",
  "LOGNAME",
  "PATH",
  "PATHEXT",
  "SHELL",
  "SystemRoot",
  "TEMP",
  "TERM",
  "TMP",
  "TMPDIR",
  "TZ",
  "USER",
  "USERPROFILE",
  "WAYLAND_DISPLAY",
  "XDG_RUNTIME_DIR",
  "windir",
]);

function isolatedInheritedEnvironment() {
  const environment = {};
  for (const key of Object.keys(process.env)) {
    if (!SAFE_INHERITED_ENVIRONMENT_KEYS.has(key) && !key.startsWith("LC_"))
      continue;
    const value = process.env[key];
    if (value !== undefined) environment[key] = value;
  }
  return {
    ...environment,
    NO_PROXY: "127.0.0.1,localhost",
    no_proxy: "127.0.0.1,localhost",
  };
}

function dotenvLine(key, value) {
  const text = String(value);
  if (/[\r\n']/.test(text)) {
    throw new Error(
      `Unsafe character in isolated E2E environment value: ${key}`,
    );
  }
  return `${key}='${text}'`;
}

async function getAvailablePort() {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("Unable to allocate a local TCP port"));
        return;
      }
      server.close((error) => (error ? reject(error) : resolve(address.port)));
    });
  });
}

async function configureServices(workspace, providerOptions) {
  const provider =
    typeof providerOptions === 'string'
      ? {
          baseUrl: `${providerOptions}/v1`,
          apiKey: DUMMY_OPENAI_API_KEY,
          model: 'smartperfetto-e2e-hang',
          lightModel: 'smartperfetto-e2e-hang',
          maxOutputTokens: 1024,
          maxTurns: 5,
        }
      : providerOptions;
  const backendPort = await getAvailablePort();
  let frontendPort = await getAvailablePort();
  while (frontendPort === backendPort) frontendPort = await getAvailablePort();
  const traceProcessorPortMin = 20_000 + Math.floor(Math.random() * 20_000);
  const traceProcessorPortMax = traceProcessorPortMin + 15;
  const backendUrl = `http://127.0.0.1:${backendPort}`;
  const frontendUrl = `http://127.0.0.1:${frontendPort}`;
  const values = {
    NODE_ENV: "test",
    PORT: backendPort,
    SMARTPERFETTO_BACKEND_PORT: backendPort,
    SMARTPERFETTO_BACKEND_PUBLIC_PORT: backendPort,
    SMARTPERFETTO_BACKEND_PUBLIC_URL: backendUrl,
    SMARTPERFETTO_BACKEND_URL: backendUrl,
    SMARTPERFETTO_FRONTEND_PORT: frontendPort,
    FRONTEND_URL: frontendUrl,
    CORS_ORIGINS: frontendUrl,
    PERFETTO_UI_ORIGIN: frontendUrl,
    SMARTPERFETTO_AI_ENABLED: "true",
    SMARTPERFETTO_AGENT_RUNTIME: "openai-agents-sdk",
    OPENAI_AGENTS_PROTOCOL: "chat_completions",
    OPENAI_BASE_URL: provider.baseUrl,
    OPENAI_API_KEY: provider.apiKey,
    DEEPSEEK_API_KEY: provider.apiKey,
    OPENAI_MODEL: provider.model,
    OPENAI_LIGHT_MODEL: provider.lightModel,
    OPENAI_MAX_OUTPUT_TOKENS: provider.maxOutputTokens,
    OPENAI_MAX_TURNS: provider.maxTurns,
    OPENAI_FULL_PER_TURN_MS: 120_000,
    OPENAI_QUICK_PER_TURN_MS: 120_000,
    OPENAI_CLASSIFIER_TIMEOUT_MS: 1_000,
    PROVIDER_DATA_DIR_OVERRIDE: workspace.providerDir,
    SMARTPERFETTO_BACKEND_DATA_DIR: workspace.backendDataDir,
    SMARTPERFETTO_BACKEND_LOG_DIR: workspace.backendLogDir,
    UPLOAD_DIR: workspace.uploadDir,
    SMARTPERFETTO_TRACE_UPLOAD_DIR: workspace.traceUploadDir,
    SMARTPERFETTO_DATA_DIR: workspace.enterpriseDataDir,
    SCENE_REPORT_DIR: workspace.sceneReportDir,
    SCENE_JOB_ARTIFACT_DIR: workspace.sceneJobArtifactDir,
    SMARTPERFETTO_ENTERPRISE_DB_PATH: workspace.enterpriseDbPath,
    SMARTPERFETTO_ENTERPRISE: "false",
    SMARTPERFETTO_API_KEY: DUMMY_BACKEND_API_KEY,
    SMARTPERFETTO_OIDC_ISSUER_URL: "",
    SMARTPERFETTO_SKIP_ORPHAN_TRACE_PROCESSOR_CLEANUP: "1",
    TP_PORT_MIN: traceProcessorPortMin,
    TP_PORT_MAX: traceProcessorPortMax,
  };
  fs.writeFileSync(
    workspace.envFile,
    `${Object.entries(values)
      .map(([key, value]) => dotenvLine(key, value))
      .join("\n")}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
  const backendEnvironment = Object.fromEntries(
    Object.entries(values).map(([key, value]) => [key, String(value)]),
  );
  return {
    backendPort,
    frontendPort,
    traceProcessorPortMin,
    traceProcessorPortMax,
    backendUrl,
    frontendUrl,
    backendEnvironment,
  };
}

function childEnvironments(workspace, services, providerBaseUrl) {
  const base = isolatedInheritedEnvironment();
  const sharedPorts = {
    SMARTPERFETTO_BACKEND_PORT: String(services.backendPort),
    SMARTPERFETTO_FRONTEND_PORT: String(services.frontendPort),
    SMARTPERFETTO_BACKEND_PUBLIC_PORT: String(services.backendPort),
    SMARTPERFETTO_BACKEND_PUBLIC_URL: services.backendUrl,
  };
  return {
    backend: {
      ...base,
      ...services.backendEnvironment,
      ...sharedPorts,
      PORT: String(services.backendPort),
      SMARTPERFETTO_ENV_FILE: workspace.envFile,
      SMARTPERFETTO_LOCK_SERVICE_PORTS: "1",
      FRONTEND_URL: services.frontendUrl,
    },
    frontend: { ...base, ...sharedPorts, PORT: String(services.frontendPort) },
    playwright: {
      ...base,
      SMARTPERFETTO_E2E_RUN_ID: workspace.runId,
      SMARTPERFETTO_E2E_FRONTEND_URL: services.frontendUrl,
      SMARTPERFETTO_E2E_BACKEND_URL: services.backendUrl,
      SMARTPERFETTO_E2E_BACKEND_API_KEY: DUMMY_BACKEND_API_KEY,
      SMARTPERFETTO_E2E_LOCALE: "zh-CN",
      SMARTPERFETTO_E2E_PROVIDER_URL: providerBaseUrl,
      SMARTPERFETTO_E2E_STUB_STATE_URL: `${providerBaseUrl}/__state`,
      SMARTPERFETTO_E2E_ARTIFACT_DIR: workspace.artifactDir,
      SMARTPERFETTO_E2E_FIXTURE_DIR: workspace.fixtureDir,
      SMARTPERFETTO_E2E_TP_PORT_MIN: String(services.traceProcessorPortMin),
      SMARTPERFETTO_E2E_TP_PORT_MAX: String(services.traceProcessorPortMax),
      SMARTPERFETTO_E2E_CHROME_CHANNEL:
        process.env.SMARTPERFETTO_E2E_CHROME_CHANNEL || "chrome",
      SMARTPERFETTO_E2E_HEADLESS:
        process.env.SMARTPERFETTO_E2E_HEADLESS || "1",
    },
  };
}

async function fetchBackendDiagnostics(
  backendUrl,
  apiKey,
  fetchImpl = globalThis.fetch,
  options = {},
) {
  const attempts = Number.isInteger(options.attempts) && options.attempts > 0
    ? options.attempts
    : 4;
  const requestTimeoutMs = Number.isFinite(options.requestTimeoutMs)
    ? Math.max(1, options.requestTimeoutMs)
    : 5_000;
  const retryDelayMs = Number.isFinite(options.retryDelayMs)
    ? Math.max(0, options.retryDelayMs)
    : 250;
  const url = `${backendUrl.replace(/\/+$/, "")}/api/runtime-health`;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const response = await fetchImpl(url, {
        headers: {
          "x-api-key": apiKey,
          Authorization: `Bearer ${apiKey}`,
        },
        signal: AbortSignal.timeout(requestTimeoutMs),
      });
      if (!response.ok) {
        throw new Error(
          `Authenticated runtime health returned HTTP ${response.status}`,
        );
      }
      return await response.json();
    } catch (error) {
      const retryable =
        error?.name === "TimeoutError" ||
        error?.name === "AbortError" ||
        error instanceof TypeError;
      if (!retryable || attempt === attempts) throw error;
      if (retryDelayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
      }
    }
  }
  throw new Error("Runtime health diagnostics exhausted all attempts");
}

function validateBackendHealth(health) {
  const engine = health?.aiEngine;
  const errors = [];
  if (health?.status !== "OK") errors.push("status must be OK");
  if (health?.environment !== "test") errors.push("environment must be test");
  if (engine?.runtime !== "openai-agents-sdk")
    errors.push("runtime must be openai-agents-sdk");
  if (engine?.source !== "env") errors.push("runtime source must be env");
  if (engine?.providerMode !== "openai_chat_completions_compatible")
    errors.push("invalid provider mode");
  if (engine?.configured !== true) errors.push("runtime must be configured");
  if (engine?.aiEnabled !== true) errors.push("AI must be enabled");
  if (engine?.activeProvider !== undefined)
    errors.push("Provider Manager must be empty");
  if (engine?.authRequired !== true)
    errors.push("API authentication must be enabled");
  if (errors.length > 0)
    throw new Error(
      `Isolated backend health check failed: ${errors.join("; ")}`,
    );
}

module.exports = {
  DUMMY_BACKEND_API_KEY,
  DUMMY_OPENAI_API_KEY,
  childEnvironments,
  configureServices,
  fetchBackendDiagnostics,
  validateBackendHealth,
};
