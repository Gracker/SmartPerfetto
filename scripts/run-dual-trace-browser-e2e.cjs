#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

'use strict';

const fs = require('fs');
const path = require('path');
const {
  PATHS,
  DUMMY_BACKEND_API_KEY,
  DUMMY_OPENAI_API_KEY,
  childEnvironments,
  configureServices,
  fetchBackendDiagnostics,
  prepareRunWorkspace,
  resolveTooling,
  secureEvidenceTree,
  validateBackendHealth,
  writeJson,
} = require('./e2e/dual-trace-e2e-environment.cjs');
const {resolveRealProvider} = require('./e2e/dual-trace-e2e-services.cjs');
const {startHangingOpenAIStub} = require('./e2e/hanging-openai-stub.cjs');
const {ProcessHarness} = require('./e2e/process-harness.cjs');

function playwrightArguments(args) {
  if (args.some((argument) => argument === '--config' || argument.startsWith('--config='))) {
    throw new Error('The dual-trace runner owns the Playwright config; do not pass --config');
  }
  return args;
}

async function attemptCleanup(errors, label, action) {
  try {
    await action();
  } catch (error) {
    errors.push(`${label}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function serviceEvidence(services, providerBaseUrl) {
  return {
    backend: services.backendPort,
    frontend: services.frontendPort,
    provider: Number(new URL(providerBaseUrl).port),
    traceProcessor: [services.traceProcessorPortMin, services.traceProcessorPortMax],
  };
}

async function run() {
  const realProvider = process.argv.includes('--real-provider');
  const forwardedArgs = process.argv.slice(2).filter((arg) => arg !== '--real-provider');
  const tooling = resolveTooling();
  const workspace = prepareRunWorkspace();
  const harness = new ProcessHarness(workspace.artifactDir);
  harness.installSignalHandlers();
  const summaryPath = path.join(workspace.artifactDir, 'run.json');
  const summary = {
    schemaVersion: 1,
    runId: workspace.runId,
    status: 'starting',
    startedAt: new Date().toISOString(),
    artifactDir: workspace.artifactDir,
    fixtures: ['launch_light.pftrace', 'lacunh_heavy.pftrace'],
  };
  writeJson(summaryPath, summary);

  let stub = null;
  let backend = null;
  let frontend = null;
  let playwright = null;
  let failure = null;
  let exitCode = 1;

  try {
    if (harness.receivedSignal) throw new Error(`Interrupted by ${harness.receivedSignal}`);
    const provider = realProvider ? resolveRealProvider() : null;
    if (!realProvider) {
      stub = await startHangingOpenAIStub(
        path.join(workspace.artifactDir, 'provider-stub.log'),
        DUMMY_OPENAI_API_KEY,
      );
    }
    const providerBaseUrl = provider ? provider.baseUrl : stub.baseUrl;
    const services = await configureServices(
      workspace,
      provider || stub.baseUrl,
    );
    const environments = childEnvironments(workspace, services, providerBaseUrl);
    if (realProvider) environments.playwright.SMARTPERFETTO_E2E_REAL_PROVIDER = '1';
    Object.assign(summary, {
      status: 'services_starting',
      ports: serviceEvidence(services, providerBaseUrl),
      providerMode: realProvider ? 'glm-coding-plan' : 'hanging-stub',
    });
    writeJson(summaryPath, summary);

    backend = harness.start(
      'backend',
      process.execPath,
      [tooling.tsxCli, 'src/index.ts'],
      {cwd: PATHS.backend, env: environments.backend},
    );
    const liveness = await harness.waitForHttp(
      `${services.backendUrl}/health`,
      'Backend',
      backend,
      async (response) => await response.json(),
    );
    if (liveness?.status !== 'OK') {
      throw new Error('Backend liveness status must be OK');
    }
    writeJson(path.join(workspace.artifactDir, 'backend-health.json'), liveness);
    const diagnostics = await fetchBackendDiagnostics(
      services.backendUrl,
      DUMMY_BACKEND_API_KEY,
    );
    writeJson(
      path.join(workspace.artifactDir, 'backend-runtime-health.json'),
      diagnostics,
    );
    validateBackendHealth(diagnostics);

    frontend = harness.start(
      'frontend',
      process.execPath,
      ['server.js'],
      {cwd: PATHS.frontend, env: environments.frontend},
    );
    await harness.waitForHttp(services.frontendUrl, 'Frontend', frontend, async (response) => {
      const html = await response.text();
      if (!html.includes('__SMARTPERFETTO_CONFIG__')) {
        throw new Error('Frontend index does not contain SmartPerfetto runtime config');
      }
      return html;
    });

    Object.assign(summary, {
      status: 'playwright_running',
      servicesReadyAt: new Date().toISOString(),
    });
    writeJson(summaryPath, summary);
    console.log(`Dual-trace E2E run: ${workspace.runId}`);
    console.log(`Evidence: ${workspace.artifactDir}`);

    playwright = harness.start(
      'playwright',
      process.execPath,
      [
        tooling.playwrightCli,
        'test',
        '--config',
        PATHS.playwrightConfig,
        ...(realProvider ? ['dual_trace_real_provider.test.ts'] : []),
        ...playwrightArguments(forwardedArgs),
      ],
      {cwd: PATHS.ui, env: environments.playwright},
      true,
    );
    const result = await playwright.result;
    summary.playwright = {
      exitCode: result.code,
      signal: result.signal,
      ...(result.error ? {error: result.error.message} : {}),
    };
    if (harness.receivedSignal) throw new Error(`Interrupted by ${harness.receivedSignal}`);
    if (result.error) throw result.error;
    if (result.code !== 0) throw new Error(`Playwright exited with code ${result.code ?? 'unknown'}`);
    summary.status = 'passed';
    exitCode = 0;
  } catch (error) {
    failure = error;
    summary.status = harness.receivedSignal ? 'interrupted' : 'failed';
    summary.error = error instanceof Error ? error.message : String(error);
  } finally {
    harness.cancelSignalEscalation();
    const cleanupErrors = [];
    await attemptCleanup(cleanupErrors, 'Playwright process group', () => harness.stop(playwright));
    await attemptCleanup(cleanupErrors, 'backend process group', () => harness.stop(backend));
    await attemptCleanup(cleanupErrors, 'frontend process group', () => harness.stop(frontend));
    if (stub) {
      await attemptCleanup(cleanupErrors, 'provider state evidence', async () => {
        writeJson(path.join(workspace.artifactDir, 'provider-state.json'), stub.snapshot());
      });
      await attemptCleanup(cleanupErrors, 'provider stub', () => stub.close());
    }
    await attemptCleanup(cleanupErrors, 'temporary directory', async () => {
      fs.rmSync(workspace.temporaryDir, {recursive: true, force: true});
    });
    harness.disposeSignalHandlers();
    if (cleanupErrors.length > 0) {
      summary.cleanupErrors = cleanupErrors;
      if (!failure) {
        failure = new Error(`E2E cleanup failed: ${cleanupErrors.join('; ')}`);
        summary.status = 'failed';
        summary.error = failure.message;
        exitCode = 1;
      }
    }
    summary.finishedAt = new Date().toISOString();
    writeJson(summaryPath, summary);
    secureEvidenceTree(workspace.artifactDir);
  }

  if (failure) console.error(failure.stack || failure.message || String(failure));
  return harness.signalExitCode() ?? exitCode;
}

run().then(
  (exitCode) => {
    process.exitCode = exitCode;
  },
  (error) => {
    console.error(error.stack || error.message || String(error));
    process.exitCode = 1;
  },
);
