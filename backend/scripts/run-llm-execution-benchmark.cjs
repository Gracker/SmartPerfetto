#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const {randomBytes} = require('node:crypto');
const {pathToFileURL} = require('node:url');
const {ProcessHarness} = require('../../scripts/e2e/process-harness.cjs');
const {TARGET_ENV, CELLS, SOURCE_FACET, sourceFacetContext, validateSourceFacetCollection,
  canonicalJson, hash, fingerprintSourceTree, fingerprintFixtureDirectory, fingerprintObserver,
  parseTargetRequest, assertExecutionTarget, prepareFreshOutputDirectory, writeNewJson,
  isolateChildDotenv, buildCell, pairedSchedule, runOwnedVerifier} = require('./llm-execution-lifecycle.cjs');

const FLAGS = new Set(['--baseline-root', '--candidate-root', '--provider', '--runtime', '--model', '--light-model',
  '--base-port', '--candidate-port', '--output-dir', '--repetitions', '--timeout-ms', '--seed', '--cells',
  '--sample-kind', '--observer-hook-fingerprint']);

// Cross-runtime execution switches outside the adapter-specific prefixes below.
// Keep this closed: unrelated SMARTPERFETTO environment values are not measurement inputs.
const EXECUTION_BEHAVIOR_ENV_KEYS = new Set(['SMARTPERFETTO_CONCLUSION_AUTHORING', 'SMARTPERFETTO_FINAL_SUBMISSION',
  'SMARTPERFETTO_ADMITTED_RUNTIME_CANDIDATES', 'SMARTPERFETTO_SAFE_TOOL_CONCURRENCY']);

function parseArgs(argv) {
  if (argv.length === 1 && ['--help', '-h'].includes(argv[0])) return {help: true};
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!FLAGS.has(key) || Object.hasOwn(values, key) || !value || value.startsWith('--')) {
      throw new Error('benchmark_arguments_invalid');
    }
    values[key] = value;
  }
  for (const required of ['--baseline-root', '--candidate-root', '--provider', '--runtime', '--model', '--light-model',
    '--base-port', '--candidate-port', '--output-dir', '--observer-hook-fingerprint']) {
    if (!values[required]) throw new Error('benchmark_required_argument_missing');
  }
  const positive = (key, fallback, minimum, maximum) => {
    const raw = values[key] ?? String(fallback);
    const value = Number(raw);
    if (!/^\d+$/.test(raw) || !Number.isSafeInteger(value) || value < minimum || value > maximum) {
      throw new Error('benchmark_numeric_argument_invalid');
    }
    return value;
  };
  const basePort = positive('--base-port', 0, 1024, 65535);
  const candidatePort = positive('--candidate-port', 0, 1024, 65535);
  if (basePort === candidatePort) throw new Error('benchmark_targets_must_differ');
  if (!['glm', 'deepseek'].includes(values['--provider'])) throw new Error('benchmark_provider_invalid');
  if (!/^[a-z][a-z0-9-]+$/.test(values['--runtime'])) throw new Error('benchmark_runtime_invalid');
  if ((values['--sample-kind'] ?? 'local-cold') !== 'local-cold') throw new Error('benchmark_warm_not_configured');
  if (!/^[a-f0-9]{64}$/.test(values['--observer-hook-fingerprint'])) throw new Error('benchmark_observer_hook_fingerprint_invalid');
  const cells = values['--cells'] === undefined ? [...CELLS] : values['--cells'].split(',');
  if (!cells.length || cells.some(cell => !CELLS.includes(cell)) || new Set(cells).size !== cells.length) {
    throw new Error('benchmark_cells_invalid');
  }
  const seed = values['--seed'] ?? randomBytes(16).toString('hex');
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(seed)) throw new Error('benchmark_seed_invalid');
  return {baselineRoot: values['--baseline-root'], candidateRoot: values['--candidate-root'],
    provider: values['--provider'], runtime: values['--runtime'], model: values['--model'], lightModel: values['--light-model'],
    basePort, candidatePort, outputDir: values['--output-dir'], repetitions: positive('--repetitions', 3, 3, 30),
    timeoutMs: positive('--timeout-ms', 20 * 60_000, 1_000, 2 * 60 * 60_000), seed, cells,
    sampleKind: 'local-cold', observerHookFingerprint: values['--observer-hook-fingerprint']};
}

function loadCheckout(repositoryRoot, options) {
  const root = fs.realpathSync(repositoryRoot);
  const backendRoot = path.join(root, 'backend');
  const api = require(path.join(backendRoot, 'scripts/agent-e2e-harness.cjs')).createProviderE2eHarness(options.provider);
  if (typeof api.prepareProviderChild !== 'function') throw new Error('benchmark_provider_preparation_not_configured');
  const runtimeKinds = api.resolveRuntimeKinds(options.runtime);
  if (runtimeKinds.length !== 1 || runtimeKinds[0] !== options.runtime) throw new Error('benchmark_requires_one_canonical_runtime');
  const preflight = require.resolve('tsx/preflight', {paths: [backendRoot]});
  const loader = require.resolve('tsx', {paths: [backendRoot]});
  const verifier = path.join(backendRoot, 'src/scripts/verifyAgentSseScrolling.ts');
  for (const filename of [preflight, loader, verifier]) if (!fs.statSync(filename).isFile()) throw new Error('benchmark_target_entry_unavailable');
  const launcherArgs = ['--require', preflight, '--import', pathToFileURL(loader).href];
  return {root, backendRoot, api, launcherArgs, verifier, sourceFingerprint: fingerprintSourceTree(root),
    observer: fingerprintObserver(root, options.observerHookFingerprint)};
}

function configFingerprint(input) {
  // Keep behavior-affecting runtime env in the hash, never in the artifact. Replace only the
  // controller-owned per-checkout/data paths so two otherwise identical targets can compare.
  const values = Object.fromEntries(Object.entries(input.env).filter(([key, value]) => value !== undefined &&
    (/^(?:OPENAI_|CLAUDE_|AGENT_|QODER_|DOTENV_CONFIG_|SMARTPERFETTO_(?:AGENT_RUNTIME|PI_|OPENCODE_|QODER_))/.test(key) ||
      key === 'NODE_OPTIONS' || key === 'SMARTPERFETTO_ENV_FILE' || EXECUTION_BEHAVIOR_ENV_KEYS.has(key)))
    // Credential names are not token-count names: MAX_OUTPUT_TOKENS must affect the fingerprint.
    .filter(([key]) => key !== 'DOTENV_CONFIG_DOTENV_KEY' &&
      !/(?:^|_)(?:API_KEY|AUTH_TOKEN|ACCESS_TOKEN|REFRESH_TOKEN|BEARER_TOKEN|OAUTH_TOKEN|SECRET|SECRET_KEY|PASSWORD|CREDENTIALS?)$/i.test(key))
    .map(([key, value]) => [key, String(value).split(input.isolatedRoot).join('<isolated>')
      .split(input.repositoryRoot).join('<checkout>')]));
  return hash(canonicalJson({configuration: input.configuration, runtime: input.runtime,
    timeoutMs: input.timeoutMs, environment: values}));
}

function taskFingerprint(checkout, args) {
  const items = [];
  for (let index = 0; index < args.length; index++) {
    const key = args[index];
    if (key === '--output') {index++; continue;}
    if (['--trace', '--reference-trace', '--expectation-json', '--setup-codebase-root'].includes(key)) {
      const value = args[++index];
      if (key === '--expectation-json' && !value.startsWith('@')) {items.push(key, hash(value)); continue;}
      const relative = value.startsWith('@') ? value.slice(1) : value;
      const filename = path.resolve(checkout.backendRoot, relative);
      if (key === '--setup-codebase-root') {
        items.push(key, fingerprintFixtureDirectory(filename));
      } else items.push(key, hash(fs.readFileSync(filename)));
      continue;
    }
    items.push(key);
  }
  return hash(canonicalJson(items));
}

function readReport(filename) {
  try {
    const stat = fs.lstatSync(filename);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 64 * 1024 * 1024) return {status: 'invalid'};
    const bytes = fs.readFileSync(filename);
    const report = JSON.parse(bytes.toString('utf8'));
    if (!report || typeof report !== 'object' || Array.isArray(report)) return {status: 'invalid'};
    return {status: 'available', report, hash: hash(bytes)};
  } catch (error) {return {status: error.code === 'ENOENT' ? 'missing' : 'invalid'};}
}

async function runBenchmark(options, injectedDependencies) {
  const dependencies = injectedDependencies ?? {};
  // Cache/lifecycle state says nothing about measurement origin. Injected/test executions
  // cannot request promotion to real-provider evidence through options or fake receipts.
  const measurementOrigin = injectedDependencies !== undefined || process.env.NODE_ENV === 'test' ||
    process.env.JEST_WORKER_ID !== undefined ? 'synthetic' : 'real_provider';
  const load = dependencies.loadCheckout ?? loadCheckout;
  const sides = {base: load(options.baselineRoot, options), candidate: load(options.candidateRoot, options)};
  if (sides.base.root === sides.candidate.root) throw new Error('benchmark_checkouts_must_differ');
  if (sides.base.observer.fingerprint !== sides.candidate.observer.fingerprint) throw new Error('benchmark_observer_mismatch');
  const prepareOutput = dependencies.prepareOutput ?? prepareFreshOutputDirectory;
  const output = prepareOutput(sides.candidate.root, options.outputDir);
  const nonce = (dependencies.randomBytes ?? randomBytes)(16).toString('hex');
  const schedule = pairedSchedule(options.cells, options.repetitions, options.seed);
  const harness = dependencies.createHarness ? dependencies.createHarness(output) : new ProcessHarness(output);
  const execute = dependencies.runOwnedVerifier ?? runOwnedVerifier;
  const sessions = new Set();
  const runs = new Set();
  const samples = [];
  const configHashes = new Map();
  const taskHashes = new Map();
  let sourceFacet;
  let sourceFacetStatus;
  let interrupted = false;
  let lifecycleFailure = false;
  harness.installSignalHandlers();
  try {
    // Refuse mismatched tasks/oracles before the first paid call, not after one side has run.
    for (const cellId of options.cells) {
      for (const side of ['base', 'candidate']) {
        const checkout = sides[side];
        const cell = buildCell(checkout.api, cellId, path.join(output, 'unused-preflight.json'), options.timeoutMs);
        if (cellId === 'source') {
          const contract = sourceFacetContext(checkout.root).contract;
          if (sourceFacet && canonicalJson(sourceFacet) !== canonicalJson(contract)) throw new Error('benchmark_source_facet_mismatch');
          sourceFacet = contract;
        }
        const inputHash = hash(canonicalJson({task: taskFingerprint(checkout, cell.args),
          ...(cellId === 'source' ? {sourceFacet} : {})}));
        if (taskHashes.has(cellId) && taskHashes.get(cellId) !== inputHash) throw new Error('benchmark_task_mismatch');
        taskHashes.set(cellId, inputHash);
      }
    }
    for (const pair of schedule) {
      for (const side of pair.order) {
        if (harness.receivedSignal || lifecycleFailure) {interrupted = true; break;}
        const checkout = sides[side];
        const sampleDirectory = path.join(output, pair.pairId, side);
        fs.mkdirSync(sampleDirectory, {recursive: true, mode: 0o700});
        const isolatedRoot = path.join(sampleDirectory, 'runtime');
        const dataRoot = path.join(isolatedRoot, 'data');
        fs.mkdirSync(dataRoot, {recursive: true, mode: 0o700});
        const reportPath = path.join(sampleDirectory, 'report.json');
        const reset = {schemaVersion: 'llm_execution_pair_reset@1', nonce, ...pair, side,
          sampleKind: 'local-cold', providerCacheState: 'unknown',
          preparedAt: Date.now(), actions: ['created_fresh_data_root'],
          dataRootHash: hash(fs.realpathSync(dataRoot)), status: 'prepared'};
        writeNewJson(path.join(sampleDirectory, 'reset-prepared.json'), reset);
        let lifecycle;
        let reportRead = {status: 'missing'};
        let targetStatus = 'unavailable';
        let failureCode;
        let request;
        let pin;
        let sourceFacetCollection;
        try {
          if (pair.cellId === 'source' && canonicalJson(sourceFacetContext(checkout.root).contract) !== canonicalJson(sourceFacet)) {
            throw new Error('benchmark_source_facet_changed');
          }
          const prepared = checkout.api.prepareProviderChild({runtimeKind: options.runtime, isolatedRoot,
            provider: options.provider === 'glm' ? 'zai-coding-cn' : 'deepseek',
            model: options.model, lightModel: options.lightModel}, dependencies.environment ?? process.env);
          if (!prepared.availability.available) throw new Error('benchmark_provider_unavailable');
          pin = {provider: prepared.configuration.provider, model: prepared.configuration.model,
            lightModel: prepared.configuration.lightModel, origin: new URL(prepared.configuration.baseUrl).origin,
            runtime: options.runtime};
          const childEnv = isolateChildDotenv(prepared.env, isolatedRoot);
          const configHash = configFingerprint({env: childEnv, configuration: prepared.configuration,
            repositoryRoot: checkout.root, isolatedRoot, runtime: options.runtime, timeoutMs: options.timeoutMs});
          if (configHashes.has(pair.cellId) && configHashes.get(pair.cellId) !== configHash) throw new Error('benchmark_config_mismatch');
          configHashes.set(pair.cellId, configHash);
          const cell = buildCell(checkout.api, pair.cellId, reportPath, options.timeoutMs);
          const inputHash = hash(canonicalJson({task: taskFingerprint(checkout, cell.args),
            ...(pair.cellId === 'source' ? {sourceFacet} : {})}));
          if (taskHashes.has(pair.cellId) && taskHashes.get(pair.cellId) !== inputHash) throw new Error('benchmark_task_mismatch');
          taskHashes.set(pair.cellId, inputHash);
          request = parseTargetRequest({schemaVersion: 'llm_execution_target_request@1', nonce,
            side, pairId: pair.pairId, cellId: pair.cellId, repetition: pair.repetition,
            port: side === 'base' ? options.basePort : options.candidatePort,
            expectedSourceFingerprint: checkout.sourceFingerprint, observerFingerprint: checkout.observer.fingerprint,
            configFingerprint: configHash, dataRootHash: reset.dataRootHash,
            ...(pair.cellId === 'source' ? {sourceFacet} : {})});
          lifecycle = await execute({label: `${pair.pairId}-${side}`, backendRoot: checkout.backendRoot,
            args: [...checkout.launcherArgs, checkout.verifier, ...cell.args],
            env: {...childEnv, [TARGET_ENV]: JSON.stringify(request)}, request,
            observationTimeoutMs: options.timeoutMs + 120_000}, {harness});
          reportRead = (dependencies.readReport ?? readReport)(reportPath);
          if (reportRead.status === 'available') {
            const report = reportRead.report;
            assertExecutionTarget(report.executionTarget, request, lifecycle.processId);
            const runId = report.executionMetrics?.runId ?? report.runId ?? report.summary?.terminalAnalysis?.runId;
            const sessionId = report.executionMetrics?.sessionId ?? report.sessionId;
            if (typeof runId !== 'string' || typeof sessionId !== 'string' || !runId || !sessionId ||
                runs.has(runId) || sessions.has(sessionId)) throw new Error('benchmark_session_not_fresh');
            runs.add(runId); sessions.add(sessionId);
            targetStatus = 'matched';
          }
          if (lifecycle.cleanup !== 'confirmed') throw new Error('benchmark_cleanup_failed');
          if ((dependencies.fingerprintSourceTree ?? fingerprintSourceTree)(checkout.root) !== checkout.sourceFingerprint) {
            throw new Error('benchmark_source_changed');
          }
          if (pair.cellId === 'source') {
            if (canonicalJson(sourceFacetContext(checkout.root).contract) !== canonicalJson(sourceFacet)) {
              throw new Error('benchmark_source_facet_changed');
            }
            if (lifecycle.exitCode === SOURCE_FACET.exitCode) {
              const receiptPath = path.join(sampleDirectory, SOURCE_FACET.receiptFile);
              const receiptRead = readReport(receiptPath);
              if (receiptRead.status !== 'available' || !validateSourceFacetCollection({report: reportRead.report,
                reportHash: reportRead.hash, receipt: receiptRead.report, request, lifecycle, repositoryRoot: checkout.root})) {
                throw new Error('benchmark_source_facet_collection_invalid');
              }
              sourceFacetCollection = {path: path.relative(output, receiptPath).split(path.sep).join('/'),
                sha256: receiptRead.hash, disposition: 'collected_pending_independent_review'};
            }
          }
        } catch (error) {
          failureCode = error instanceof Error && /^benchmark_[a-z_]+$/.test(error.message)
            ? error.message : 'benchmark_sample_failed';
          lifecycleFailure = true;
        }
        let dataCleanup = 'retained';
        try {
          if (lifecycle?.cleanup === 'confirmed' && checkout.api.preserveIsolatedSessionLogs(isolatedRoot, reportPath)) {
            fs.rmSync(isolatedRoot, {recursive: true, force: true}); dataCleanup = 'removed';
          }
        } catch { /* Preserve task-owned evidence; never broaden cleanup after an error. */ }
        const sample = {schemaVersion: 'llm_execution_sample@1', measurementOrigin, nonce, ...pair, side,
          sampleKind: 'local-cold', providerCacheState: 'unknown', pin,
          sourceFingerprint: checkout.sourceFingerprint, observer: checkout.observer,
          configFingerprint: request?.configFingerprint, taskFingerprint: taskHashes.get(pair.cellId),
          targetStatus, lifecycle, dataCleanup, failureCode,
          ...(pair.cellId === 'source' ? {sourceFacet, sourceFacetCollection} : {}),
          report: path.relative(output, reportPath).split(path.sep).join('/'),
          reportStatus: reportRead.status, reportHash: reportRead.hash,
          reset: {...reset, status: targetStatus === 'matched' && lifecycle?.cleanup === 'confirmed' ? 'observed' : 'unconfirmed',
            completedAt: Date.now(), actions: [...reset.actions,
              ...(Number.isSafeInteger(lifecycle?.processId) ? ['spawned_process', 'awaited_process'] : []),
              ...(lifecycle?.cleanup === 'confirmed' ? ['confirmed_process_group_exit', 'confirmed_backend_port_release'] : [])]},
          quality: 'not_scored'};
        writeNewJson(path.join(sampleDirectory, 'receipt.json'), sample);
        samples.push(sample);
      }
      if (interrupted || lifecycleFailure) break;
    }
    if (sourceFacet) {
      try {
        sourceFacetStatus = Object.values(sides).every(checkout =>
          canonicalJson(sourceFacetContext(checkout.root).contract) === canonicalJson(sourceFacet)) ? 'matched' : 'mismatch';
      } catch {sourceFacetStatus = 'mismatch';}
      if (sourceFacetStatus !== 'matched') lifecycleFailure = true;
    }
  } finally {harness.disposeSignalHandlers();}
  const artifact = {schemaVersion: 'llm_execution_benchmark@1', measurementOrigin, candidate: 'llm-execution-v1', nonce,
    createdAt: new Date().toISOString(), provider: options.provider, runtime: options.runtime,
    model: options.model, lightModel: options.lightModel, seed: options.seed,
    ...(sourceFacet ? {sourceFacet, sourceFacetStatus} : {}),
    sampleKind: 'local-cold', providerCacheState: 'unknown',
    coverage: {cells: options.cells, requiredCells: CELLS, repetitions: options.repetitions,
      scheduledSamples: schedule.length * 2, observedSamples: samples.length},
    differentSources: sides.base.sourceFingerprint !== sides.candidate.sourceFingerprint,
    lifecycle: !interrupted && !lifecycleFailure && samples.length === schedule.length * 2 &&
      samples.every(sample => sample.reset.status === 'observed') ? 'collected' : 'incomplete',
    performanceAdmission: 'not_scored', qualityAdmission: 'not_scored',
    limitations: ['local_warm_not_configured', 'provider_cache_not_controlled', 'hook_equivalence_requires_review'],
    samples};
  const outputPath = path.join(output, 'benchmark.json');
  writeNewJson(outputPath, artifact);
  return {artifact, outputPath};
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log('Usage: run-llm-execution-benchmark.cjs --baseline-root <checkout> --candidate-root <checkout> --provider glm|deepseek --runtime <canonical-runtime> --model <id> --light-model <id> --base-port <port> --candidate-port <port> --observer-hook-fingerprint <sha256> --output-dir test-output/runtime-concurrency/llm-execution-v1/<fresh-run> [--repetitions 3] [--cells scheduler,startup,scrolling,source,dual] [--sample-kind local-cold]');
    console.log('Collects paired lifecycle/report evidence. It does not grant quality or performance admission. Warm provider cache is not controlled.');
    return;
  }
  const {artifact, outputPath} = await runBenchmark(options);
  console.log(JSON.stringify({outputPath, lifecycle: artifact.lifecycle, performanceAdmission: artifact.performanceAdmission,
    qualityAdmission: artifact.qualityAdmission, samples: artifact.samples.length}));
  if (artifact.lifecycle !== 'collected') process.exitCode = 1;
}

module.exports = {parseArgs, loadCheckout, configFingerprint, taskFingerprint, readReport, runBenchmark};
if (require.main === module) main().catch(() => {
  console.error('LLM execution benchmark failed; inspect task-owned evidence.');
  process.exitCode = 1;
});
