// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {buildRuntimeConfigCommitments, alignRuntimeConfigCommitments, runtimeConfigCommitmentsFingerprint,
  runtimeConfigControlsFingerprint, parseRuntimeBenchmarkConfigCommitments} from '../../agentRuntime/runtimePerformance';
import {parseArgs as parseVerifierArgs} from '../verifyAgentSseScrolling';
import {CONCLUSION_AUTHORING_ENV} from '../../agent/core/conclusionAuthoring';
import {SMARTPERFETTO_FINAL_SUBMISSION_ENV} from '../../agentRuntime/finalSubmissionConfig';
import {SMARTPERFETTO_ADMITTED_RUNTIME_CANDIDATES_ENV} from '../../agentRuntime/runtimeCandidateAdmission';
import {SMARTPERFETTO_SAFE_TOOL_CONCURRENCY_ENV} from '../../agentRuntime/runtimeToolConcurrency';
import {OPENAI_TYPED_FINAL_CONTRACTS, OPENAI_ASSISTANT_OUTPUT_IMPLEMENTATION,
  getOpenAiTypedFinalContractIdentity} from '../../agentRuntime/finalSubmissionImplementation';

const backendRoot = path.resolve(__dirname, '../../..');
const controller = require(path.join(backendRoot, 'scripts/run-llm-execution-benchmark.cjs'));
const lifecycle = require(path.join(backendRoot, 'scripts/llm-execution-lifecycle.cjs'));
const HOOK = 'a'.repeat(64);

function write(root: string, file: string, contents: string) {
  fs.mkdirSync(path.dirname(path.join(root, file)), {recursive: true});
  fs.writeFileSync(path.join(root, file), contents);
}

function checkout(root: string, changed = false) {
  write(root, 'backend/src/example.ts', changed ? 'candidate' : 'baseline');
  for (const name of ['modelRequestMetrics', 'runtimePerformance', 'runtimePerformanceContext']) {
    write(root, `backend/src/agentRuntime/${name}.ts`, 'common observer');
  }
  write(root, 'backend/src/agentRuntime/typedOutputMaterial.ts', 'common material schema');
  write(root, 'backend/src/agentRuntime/finalSubmissionImplementation.ts', 'common exact version table');
  write(root, 'backend/src/agentRuntime/engines/openai/openAiTypedFinalOutputMaterial.ts', 'common material observer');
  write(root, 'Trace/fixture.pftrace', 'shared trace');
  return fs.realpathSync(root);
}

function cli(base: string, candidate: string, extra: string[] = []) {
  return ['--baseline-root', base, '--candidate-root', candidate, '--provider', 'glm', '--runtime', 'openai-agents-sdk',
    '--model', 'glm-5.3-flash', '--light-model', 'glm-5.3-flash', '--base-port', '19881', '--candidate-port', '19882',
    '--observer-hook-fingerprint', HOOK, '--output-dir', 'test-output/runtime-concurrency/llm-execution-v1/run', ...extra];
}

function request(overrides: Record<string, unknown> = {}) {
  return {schemaVersion: 'llm_execution_target_request@1', nonce: 'a'.repeat(32), side: 'base', pairId: 'scheduler-01',
    cellId: 'scheduler', repetition: 1, port: 19881, expectedSourceFingerprint: 'b'.repeat(64),
    observerFingerprint: 'c'.repeat(64), configFingerprint: 'd'.repeat(64), dataRootHash: 'e'.repeat(64), ...overrides};
}

function controllerFixture(directory: string, behavior = 'normal') {
  const base = checkout(path.join(directory, 'base'));
  const candidate = checkout(path.join(directory, 'candidate'), true);
  const options = controller.parseArgs(cli(base, candidate, ['--cells', 'scheduler', '--seed', 'seed']));
  let counter = 0;
  const fakeLoad = (root: string) => ({root, backendRoot: path.join(root, 'backend'), launcherArgs: [], verifier: 'verifier',
    sourceFingerprint: lifecycle.fingerprintSourceTree(root), observer: lifecycle.fingerprintObserver(root, HOOK),
    api: {prepareProviderChild: () => ({availability: {available: true},
      configuration: {provider: 'zai-coding-cn', baseUrl: 'https://open.bigmodel.cn/api/coding/paas/v4',
        model: 'glm-5.3-flash', lightModel: 'glm-5.3-flash'}, env: {OPENAI_MODEL: 'glm-5.3-flash'}}),
    systemAnalysisScenarios: () => [{id: 'scheduler-constructed', args: ['--trace', '../Trace/fixture.pftrace',
      '--expectation-json', '{}']}], preserveIsolatedSessionLogs: () => true}});
  const execute = jest.fn(async (input: any) => {
    if (behavior === 'spawn_error') throw new Error('arbitrary private native error');
    const ordinal = ++counter;
    const reportPath = input.args[input.args.indexOf('--output') + 1];
    const dataRoot = path.join(path.dirname(reportPath), 'runtime/data');
    const target = lifecycle.observeExecutionTarget({request: input.request,
      repositoryRoot: path.dirname(input.backendRoot), dataRoot, port: input.request.port, processId: 100 + ordinal});
    if (behavior === 'wrong_hash') target.sourceFingerprint = 'f'.repeat(64);
    if (behavior === 'foreign_nonce') target.nonce = 'f'.repeat(32);
    if (behavior !== 'missing_report') {
      fs.writeFileSync(reportPath, JSON.stringify({executionTarget: target, sessionId: `session-${ordinal}`,
        executionMetrics: {runId: `run-${behavior === 'reused_run' ? 1 : ordinal}`, sessionId: `session-${ordinal}`},
        completeAcceptance: false}));
    }
    if (behavior === 'source_changed') write(path.dirname(input.backendRoot), 'backend/src/changed.ts', 'changed during run');
    return {preparedAt: 1, settledAt: 2, processId: 100 + ordinal, exitCode: 1, outcome: 'nonzero_exit',
      cleanup: behavior === 'cleanup_failed' ? 'failed' : 'confirmed', censored: false};
  });
  const dependencies = {loadCheckout: fakeLoad,
    createHarness: () => ({installSignalHandlers() {}, disposeSignalHandlers() {}, receivedSignal: null}),
    runOwnedVerifier: execute, environment: {GLM_API_KEY: 'TEST_ONLY_NOT_REAL'}};
  return {options, dependencies, execute};
}

function sourceControllerFixture(directory: string, behavior: string) {
  const test = controllerFixture(directory), repository = path.dirname(backendRoot);
  test.options.cells = ['source'];
  const sourceApi = require(path.join(backendRoot, 'scripts/agent-e2e-harness.cjs')).createProviderE2eHarness('glm');
  for (const root of [test.options.baselineRoot, test.options.candidateRoot]) {
    for (const relative of ['backend/scripts/agent-e2e-harness.cjs', 'backend/scripts/agent-e2e-provider.cjs',
      'backend/tests/e2e/context-fixtures/app', 'Trace/constructed/source-analysis-semantic/analysis/expected.json',
      'Trace/.generated/constructed/source-analysis-semantic/trace.pftrace']) {
      fs.mkdirSync(path.dirname(path.join(root, relative)), {recursive: true});
      fs.cpSync(path.join(repository, relative), path.join(root, relative), {recursive: true});
    }
  }
  if (behavior === 'preflightMismatch') fs.appendFileSync(path.join(test.options.candidateRoot,
    'backend/tests/e2e/context-fixtures/app/StartupHooks.kt'), '\n// changed fixture');
  const load = test.dependencies.loadCheckout;
  test.dependencies.loadCheckout = (root: string) => ({...load(root), api: {...load(root).api,
    semanticDeltaQueries: sourceApi.semanticDeltaQueries, semanticConditionArgs: sourceApi.semanticConditionArgs}});
  let ordinal = 0;
  const execute = jest.fn(async (input: any) => {
    const now = Date.now(), id = ++ordinal, root = path.dirname(input.backendRoot);
    const context = lifecycle.sourceFacetContext(root), reportPath = input.args[input.args.indexOf('--output') + 1];
    const target = {...lifecycle.observeExecutionTarget({request: input.request, repositoryRoot: root,
      dataRoot: path.join(path.dirname(reportPath), 'runtime/data'), port: input.request.port, processId: 100 + id}),
      runId: `run-${id}`, sessionId: `session-${id}`};
    const anchor = {anchorId: 'anchor', evidenceRefId: 'duration', context: {traceId: 'trace', traceSide: 'current'},
      timeRange: {startTs: '1000', endTs: '42001000', unit: 'ns'}, identity: {upid: 10, utid: 11}};
    const report: any = {traceId: 'trace', sessionId: target.sessionId, executionTarget: target, query: context.inputs.query.text,
      strict: true, passed: false, completeAcceptance: false, semanticAcceptance: 'INCONCLUSIVE', proofAcceptance: 'PASSED',
      observedChecksPassed: true, hardGatesPassed: true, checks: {oracle: true}, ungroupedChecks: {},
      checkGroups: {value: {oracle: true}, proof: {proved: true}, delivery: {native: true}},
      uncoveredFacets: [lifecycle.SOURCE_FACET.facetId], runIdentity: {runtime: 'openai-agents-sdk', query: context.inputs.query.text,
        traceSha256: context.contract.traceSha256, expectationHash: context.contract.expectationHash},
      executionMetrics: {schemaVersion: 'llm_execution_metrics_artifact@1', status: 'sealed', runId: target.runId,
        sessionId: target.sessionId, runtime: 'openai-agents-sdk', sealedAt: now, wallclockMs: 100},
      analysisContext: {codeAwareMode: 'provider_send', codebaseIds: ['source'], setup: {codebases: [{setupMode: 'register-only',
        chunkCount: 0, activeIndexState: 'none', pendingGeneration: false, reindexRequests: 0}]}},
      taskVerification: {checks: {'fact:source_marker_duration': true}, uncoveredFacets: [lifecycle.SOURCE_FACET.facetId],
        facts: {source_marker_duration: {matched: true, proposition: 'proved', matchedClaimIds: ['duration'], matchedAnchorIds: ['anchor']}}},
      summary: {analysisCompletedSourceReferenceCount: 1, analysisCompletedSourceBindingCount: 1,
        analysisCompletedSourceClaimVerifierStatus: 'passed', analysisCompletedSourceReferenceMembershipPassed: true,
        analysisCompletedSourceClaimStatuses: ['trace_linked'], analysisCompletedVerifiedSourceBindings: [{claimId: 'duration',
          status: 'trace_linked', sourceReferenceIds: ['source-ref-v1-test'], traceEvidenceRefIds: ['duration']}],
        analysisCompletedSourceUseDecision: {references: [{id: 'source-ref-v1-test', codebaseId: 'source', filePath: 'StartupHooks.kt',
          lookupKind: 'body', lineRange: {start: 1, end: 47}}]}, terminalAnalysis: {conclusion: 'Synthetic collection fixture.',
          completion: {schemaVersion: 1, status: 'completed', runId: target.runId, runtimeKind: 'openai-agents-sdk'},
          conclusionContract: {claims: [{id: 'duration', kind: 'numeric'}]},
          claimSupport: [{claimId: 'duration', anchors: [anchor]}], claimVerificationResult: {schemaVersion: 'claim_verifier@2',
            claimResults: [{claimId: 'duration', status: 'verified', propositionCoverage: {status: 'complete', uncovered: []},
              deterministicProof: {kind: 'numeric_cell', status: 'proved', anchorIds: ['anchor'], evidenceRefIds: ['duration']},
              referenceCells: [{anchorId: 'anchor', evidenceRefId: 'duration', status: 'matched'}]}]}}}};
    fs.writeFileSync(reportPath, JSON.stringify(report));
    const settlement = lifecycle.createSourceFacetSettlement({repositoryRoot: root, reportPath, request: input.request});
    const token = settlement.issue(report);
    expect(token).toBeDefined();
    const code = await settlement.settle(token, {cleanup() {}, flush: async () => {}, exitCode: () => undefined});
    if (behavior === 'fakeExit3') fs.unlinkSync(path.join(path.dirname(reportPath), lifecycle.SOURCE_FACET.receiptFile));
    if (behavior === 'changedOracle') fs.appendFileSync(context.inputs.groundTruthPath, ' ');
    if (behavior === 'lateOtherCheckoutChange' && id === 6) {
      const other = root === test.options.baselineRoot ? test.options.candidateRoot : test.options.baselineRoot;
      fs.appendFileSync(path.join(other, 'Trace/constructed/source-analysis-semantic/analysis/expected.json'), ' ');
    }
    return {preparedAt: now - 1, settledAt: Date.now() + 1, processId: target.processId,
      exitCode: behavior === 'exit1' ? 1 : code, outcome: 'nonzero_exit', signal: behavior === 'signal' ? 'SIGTERM' : null,
      cleanup: behavior === 'cleanupFailed' ? 'failed' : 'confirmed', censored: false};
  });
  test.dependencies.runOwnedVerifier = execute;
  return {...test, execute};
}

describe('LLM execution benchmark controller contracts', () => {
  let directory: string;
  beforeEach(() => {directory = fs.mkdtempSync(path.join(os.tmpdir(), 'llm-controller-'));});
  afterEach(() => {fs.rmSync(directory, {recursive: true, force: true});});

  it('collects the dedicated source pending disposition without rewriting raw strict quality or actual code 3', async () => {
    const test = sourceControllerFixture(directory, 'normal');
    const {artifact} = await controller.runBenchmark(test.options, test.dependencies);
    expect(artifact.lifecycle).toBe('collected');
    expect(artifact.samples).toHaveLength(6);
    expect(artifact.samples.every((sample: any) => sample.lifecycle.outcome === 'nonzero_exit' && sample.lifecycle.exitCode === 3 &&
      sample.sourceFacetCollection.disposition === 'collected_pending_independent_review' && sample.quality === 'not_scored')).toBe(true);
    expect(artifact.qualityAdmission).toBe('not_scored');
  });

  it('rechecks both fixed fixture/oracle roots after the entire collection and retains valid earlier receipts', async () => {
    const test = sourceControllerFixture(directory, 'lateOtherCheckoutChange');
    const {artifact} = await controller.runBenchmark(test.options, test.dependencies);
    expect(artifact.samples).toHaveLength(6);
    expect(artifact).toMatchObject({lifecycle: 'incomplete', sourceFacetStatus: 'mismatch', qualityAdmission: 'not_scored'});
    expect(artifact.samples.every((sample: any) => sample.sourceFacetCollection !== undefined && sample.lifecycle.exitCode === 3)).toBe(true);
  });

  it.each(['fakeExit3', 'signal', 'cleanupFailed', 'changedOracle', 'exit1', 'preflightMismatch'])(
    'does not grant source pending disposition after %s', async behavior => {
      const test = sourceControllerFixture(directory, behavior);
      if (behavior === 'preflightMismatch') {
        await expect(controller.runBenchmark(test.options, test.dependencies)).rejects.toThrow('benchmark_source_facet_mismatch');
        expect(test.execute).not.toHaveBeenCalled();
      } else {
        const {artifact} = await controller.runBenchmark(test.options, test.dependencies);
        expect(artifact.samples.every((sample: any) => sample.sourceFacetCollection === undefined)).toBe(true);
        expect(artifact.qualityAdmission).toBe('not_scored');
        if (behavior === 'exit1') expect(artifact.samples[0].lifecycle.exitCode).toBe(1);
        else expect(artifact.lifecycle).toBe('incomplete');
      }
    });

  it('requires distinct explicit loopback ports, complete pins and at least three repetitions', () => {
    expect(controller.parseArgs(cli('/base', '/candidate'))).toMatchObject({provider: 'glm', runtime: 'openai-agents-sdk',
      model: 'glm-5.3-flash', repetitions: 3, sampleKind: 'local-cold', cells: lifecycle.CELLS});
    for (const extra of [['--repetitions', '2'], ['--sample-kind', 'warm'], ['--cells', 'scheduler,scheduler'],
      ['--base-url', 'https://example.com'], ['--provider', 'deepseek']]) {
      expect(() => controller.parseArgs(cli('/base', '/candidate', extra))).toThrow();
    }
    const identicalPorts = cli('/base', '/candidate');
    identicalPorts[identicalPorts.indexOf('--candidate-port') + 1] = '19881';
    expect(() => controller.parseArgs(identicalPorts)).toThrow('benchmark_targets_must_differ');
    expect(controller.parseArgs(['--help'])).toEqual({help: true});
  });

  it('hashes new source/assets while excluding secrets and generated output', () => {
    const root = checkout(path.join(directory, 'candidate'));
    const before = lifecycle.fingerprintSourceTree(root);
    write(root, 'backend/.env', 'SECRET_KEY_NOT_TO_READ');
    write(root, 'backend/src/.env.private', 'SECRET_KEY_NOT_TO_READ');
    write(root, 'backend/src/logs/trace.log', 'generated');
    write(root, 'backend/dist/runtime.js', 'generated');
    expect(lifecycle.fingerprintSourceTree(root)).toBe(before);
    write(root, 'backend/src/new-runtime.ts', 'new code');
    expect(lifecycle.fingerprintSourceTree(root)).not.toBe(before);
    expect(lifecycle.fingerprintObserver(root, HOOK).hookEvidence).toBe('reviewed_contract_not_automatic_wire_equivalence');
    fs.symlinkSync(path.join(root, 'backend/src/example.ts'), path.join(root, 'backend/src/foreign.ts'));
    expect(() => lifecycle.fingerprintSourceTree(root)).toThrow('benchmark_source_symlink');
  });

  it('binds the neutral material observer and schema in final transport fingerprints without importing candidate-only schema', () => {
    const root = checkout(path.join(directory, 'candidate'));
    write(root, 'backend/src/scripts/agentE2eMetrics.ts', 'common metrics');
    const legacy = lifecycle.fingerprintObserver(root, HOOK);
    const before = lifecycle.fingerprintObserver(root, HOOK, true);
    for (const relative of ['backend/src/agentRuntime/typedOutputMaterial.ts', 'backend/src/agentRuntime/finalSubmissionImplementation.ts',
      'backend/src/agentRuntime/engines/openai/openAiTypedFinalOutputMaterial.ts']) {
      const previous = fs.readFileSync(path.join(root, relative));
      write(root, relative, 'changed observer material');
      expect(lifecycle.fingerprintObserver(root, HOOK, true).coreFingerprint).not.toBe(before.coreFingerprint);
      expect(lifecycle.fingerprintObserver(root, HOOK)).toEqual(legacy);
      fs.writeFileSync(path.join(root, relative), previous);
    }
    write(root, 'backend/src/agent/core/authoredClaimObjectSchema.ts', 'candidate-only injected schema');
    expect(lifecycle.fingerprintObserver(root, HOOK, true)).toEqual(before);
    fs.unlinkSync(path.join(root, 'backend/src/agentRuntime/typedOutputMaterial.ts'));
    expect(() => lifecycle.fingerprintObserver(root, HOOK, true)).toThrow();
  });

  it('fingerprints token budgets independently of credential fields', () => {
    const common = {configuration: {provider: 'deepseek', model: 'deepseek-flash'}, runtime: 'openai-agents-sdk',
      repositoryRoot: '/checkout', isolatedRoot: '/owned', timeoutMs: 120000};
    const environment = {OPENAI_MAX_OUTPUT_TOKENS: '8192', CLAUDE_MAX_OUTPUT_TOKENS: '16384',
      OPENAI_API_KEY: 'fake-one', CLAUDE_CODE_OAUTH_TOKEN: 'fake-two', QODER_PERSONAL_ACCESS_TOKEN: 'fake-three'};
    const before = controller.configFingerprint({...common, env: environment});
    for (const key of ['OPENAI_MAX_OUTPUT_TOKENS', 'CLAUDE_MAX_OUTPUT_TOKENS']) {
      expect(controller.configFingerprint({...common, env: {...environment, [key]: '32768'}})).not.toBe(before);
    }
    for (const key of ['OPENAI_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'QODER_PERSONAL_ACCESS_TOKEN']) {
      expect(controller.configFingerprint({...common, env: {...environment, [key]: 'changed-fake-credential'}})).toBe(before);
    }
  });

  it.each([
    [CONCLUSION_AUTHORING_ENV, 'canonical_v1', 'authoring_v1'],
    [SMARTPERFETTO_FINAL_SUBMISSION_ENV, 'assistant_text', 'authored_claim_document_v1'],
    [SMARTPERFETTO_ADMITTED_RUNTIME_CANDIDATES_ENV, 'task4', 'task4,task5'],
    [SMARTPERFETTO_SAFE_TOOL_CONCURRENCY_ENV, 'false', 'true'],
  ])('fingerprints the execution behavior switch %s without collecting unrelated environment', (key, before, after) => {
    const common = {configuration: {provider: 'deepseek', model: 'deepseek-flash'}, runtime: 'openai-agents-sdk',
      repositoryRoot: '/checkout', isolatedRoot: '/owned', timeoutMs: 120000};
    const env = {[SMARTPERFETTO_ADMITTED_RUNTIME_CANDIDATES_ENV]: 'task5', [key]: before,
      OPENAI_API_KEY: 'PRIVATE_CREDENTIAL_NOT_FOR_FINGERPRINT_OUTPUT'};
    const first = controller.configFingerprint({...common, env});
    expect(controller.configFingerprint({...common, env: {...env, [key]: after}})).not.toBe(first);
    expect(controller.configFingerprint({...common, env: {...env,
      SMARTPERFETTO_UNRELATED_DIAGNOSTIC_FIELD: 'PRIVATE_UNRELATED_ENV_VALUE'}})).toBe(first);
    expect(first).toMatch(/^[a-f0-9]{64}$/);
    expect(first).not.toContain(env.OPENAI_API_KEY);
  });

  it('prevents two checkout dotenv files from changing either frozen or absent child settings', async () => {
    const dotenvEntry = require.resolve('dotenv/config', {paths: [backendRoot]});
    const probe = `require(${JSON.stringify(dotenvEntry)}); process.stdout.write(JSON.stringify({
      budget: process.env.OPENAI_MAX_OUTPUT_TOKENS ?? null,
      absentBudget: process.env.CLAUDE_MAX_OUTPUT_TOKENS ?? null,
      injected: process.env.LLM_DOTENV_FIXTURE_CANARY ?? null,
      override: process.env.DOTENV_CONFIG_OVERRIDE ?? null,
      vaultKey: process.env.DOTENV_KEY ?? null
    }));`;
    for (const [side, budget] of [['base', '8192'], ['candidate', '32768']]) {
      const cwd = path.join(directory, side);
      const owned = path.join(directory, `owned-${side}`);
      fs.mkdirSync(cwd); fs.mkdirSync(owned);
      fs.writeFileSync(path.join(cwd, '.env'), `OPENAI_MAX_OUTPUT_TOKENS=${budget}\nCLAUDE_MAX_OUTPUT_TOKENS=${budget}\nLLM_DOTENV_FIXTURE_CANARY=${side}\n`);
      const foreignPath = path.join(cwd, 'foreign.env');
      fs.writeFileSync(foreignPath, 'OPENAI_MAX_OUTPUT_TOKENS=999999\nLLM_DOTENV_FIXTURE_CANARY=foreign\n');
      const env = lifecycle.isolateChildDotenv({OPENAI_MAX_OUTPUT_TOKENS: '16384', DOTENV_CONFIG_PATH: foreignPath,
        DOTENV_CONFIG_OVERRIDE: 'true', DOTENV_KEY: 'fake-vault-key', DOTENV_CONFIG_DOTENV_KEY: 'fake-vault-key'}, owned);
      expect(fs.statSync(env.DOTENV_CONFIG_PATH).size).toBe(0);
      expect(env).not.toHaveProperty('DOTENV_CONFIG_OVERRIDE');
      const child = spawn(process.execPath, ['--eval', probe], {cwd, env, stdio: ['ignore', 'pipe', 'pipe']});
      let stdout = '';
      child.stdout.on('data', value => {stdout += value.toString();});
      const code = await new Promise<number | null>((resolve, reject) => {child.once('error', reject); child.once('close', resolve);});
      expect(code).toBe(0);
      expect(JSON.parse(stdout)).toEqual({budget: '16384', absentBudget: null, injected: null, override: null, vaultKey: null});
    }
  });

  it('creates evidence only under a new ignored namespace and rejects reused or redirected paths', () => {
    const root = checkout(path.join(directory, 'candidate'));
    const relative = 'test-output/runtime-concurrency/llm-execution-v1/one';
    const output = lifecycle.prepareFreshOutputDirectory(root, relative);
    expect(output).toBe(path.join(root, 'backend', relative));
    expect(() => lifecycle.prepareFreshOutputDirectory(root, relative)).toThrow('benchmark_output_exists');
    expect(() => lifecycle.prepareFreshOutputDirectory(root, '../outside')).toThrow('benchmark_output_outside_boundary');
    const alias = path.join(root, 'backend/test-output/runtime-concurrency/llm-execution-v1/alias');
    fs.symlinkSync(directory, alias);
    expect(() => lifecycle.prepareFreshOutputDirectory(root,
      'test-output/runtime-concurrency/llm-execution-v1/alias/child')).toThrow();
  });

  it('observes real source/data/port independently and rejects a forged or foreign target', () => {
    const root = checkout(path.join(directory, 'candidate'));
    const dataRoot = path.join(root, 'backend/test-output/data');
    fs.mkdirSync(dataRoot, {recursive: true});
    const asked = request({expectedSourceFingerprint: lifecycle.fingerprintSourceTree(root),
      dataRootHash: lifecycle.hash(fs.realpathSync(dataRoot))});
    const observed = lifecycle.observeExecutionTarget({request: JSON.stringify(asked), repositoryRoot: root,
      dataRoot, port: 19881, processId: 42});
    expect(observed.status).toBe('matched');
    expect(() => lifecycle.assertExecutionTarget(observed, asked, 42)).not.toThrow();
    for (const changed of [{nonce: 'b'.repeat(32)}, {processId: 43}, {sourceFingerprint: 'f'.repeat(64)},
      {origin: 'http://127.0.0.1:19882'}, {origin: 'http://example.com:19881'}]) {
      expect(() => lifecycle.assertExecutionTarget({...observed, ...changed}, asked, 42)).toThrow('benchmark_target_mismatch');
    }
    expect(lifecycle.observeExecutionTarget({request: asked, repositoryRoot: root, dataRoot,
      port: 19882, processId: 42}).status).toBe('mismatch');
    expect(() => lifecycle.parseTargetRequest({...asked, rawPrompt: 'PRIVATE'})).toThrow('benchmark_target_invalid');
  });

  it('reuses oracle-bearing maintained cells, fixes output and never mutates the source request', () => {
    const common = ['--trace', '../Trace/fixture.pftrace', '--expectation-json', '{}', '--output', 'old.json'];
    const api = {
      systemAnalysisScenarios: () => [{id: 'scheduler-constructed', args: common}, {id: 'startup-pair-real', args: common}],
      suites: {startup: {args: common}, scrolling: {args: common}},
      semanticDeltaQueries: () => [{id: 'diagnosis', kind: 'autonomous-diagnosis'}],
      semanticConditionArgs: jest.fn(() => common),
    };
    for (const cell of lifecycle.CELLS) {
      const result = lifecycle.buildCell(api, cell, 'new.json', 5000);
      expect(result.args).toContain('--strict');
      expect(result.args[result.args.indexOf('--output') + 1]).toBe('new.json');
    }
    expect(api.semanticConditionArgs).toHaveBeenCalledWith(expect.anything(), 'A2', 'new.json', 5000);
    expect(common).toContain('old.json');
    const noOracle = {...api, suites: {startup: {args: ['--query', 'x']}}};
    expect(() => lifecycle.buildCell(noOracle, 'startup', 'new.json', 5000)).toThrow('benchmark_oracle_missing');
  });

  it('uses deterministic randomized pair order and preserves every requested side', () => {
    const a = lifecycle.pairedSchedule(['scheduler', 'source'], 3, 'seed-a');
    expect(a).toEqual(lifecycle.pairedSchedule(['scheduler', 'source'], 3, 'seed-a'));
    expect(a).toHaveLength(6);
    for (const pair of a) expect([...pair.order].sort()).toEqual(['base', 'candidate']);
  });

  it('closes only its owned process and verifies port release before recording cleanup', async () => {
    const tracked = {child: {pid: 42}, logPath: '/local/sample.log', result: Promise.resolve({code: 1, signal: null})};
    const harness = {start: jest.fn(() => tracked), stop: jest.fn(async () => {}), receivedSignal: null};
    const ports = jest.fn(async () => {});
    const result = await lifecycle.runOwnedVerifier({label: 'sample', backendRoot: directory, args: ['fixture'],
      env: {}, request: request(), observationTimeoutMs: 100}, {harness, assertPortFree: ports});
    expect(harness.stop).toHaveBeenCalledWith(tracked);
    expect(ports).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({outcome: 'nonzero_exit', exitCode: 1, cleanup: 'confirmed', censored: false});
    harness.stop.mockImplementationOnce(async () => {throw new Error('raw details');});
    const failed = await lifecycle.runOwnedVerifier({label: 'sample', backendRoot: directory, args: ['fixture'],
      env: {}, request: request(), observationTimeoutMs: 100}, {harness, assertPortFree: ports});
    expect(failed.cleanup).toBe('failed');
  });

  it('keeps timeout and cancellation censored, even if cleanup succeeds', async () => {
    const tracked = {child: {pid: 42}, logPath: '/local/sample.log', result: new Promise(() => {})};
    const harness = {start: () => tracked, stop: async () => {}, receivedSignal: null as string | null};
    const input = {label: 'sample', backendRoot: directory, args: ['fixture'], env: {}, request: request(), observationTimeoutMs: 1};
    expect(await lifecycle.runOwnedVerifier(input, {harness, assertPortFree: async () => {}}))
      .toMatchObject({outcome: 'observation_timeout', censored: true, cleanup: 'confirmed'});
    harness.receivedSignal = 'SIGINT';
    expect(await lifecycle.runOwnedVerifier(input, {harness, assertPortFree: async () => {}}))
      .toMatchObject({outcome: 'cancelled', censored: true});
  });

  it('marks injected local-cold measurements synthetic even when a caller asks for real-provider origin', async () => {
    const {options, dependencies, execute} = controllerFixture(directory);
    const result = await controller.runBenchmark({...options, measurementOrigin: 'real_provider'},
      {...dependencies, measurementOrigin: 'real_provider'});
    expect(result.artifact.samples).toHaveLength(6);
    expect(result.artifact).toMatchObject({measurementOrigin: 'synthetic', sampleKind: 'local-cold',
      lifecycle: 'collected', qualityAdmission: 'not_scored', performanceAdmission: 'not_scored'});
    expect(result.artifact.samples.every((sample: any) => sample.measurementOrigin === 'synthetic')).toBe(true);
    const persisted = JSON.parse(fs.readFileSync(result.outputPath, 'utf8'));
    expect(persisted.measurementOrigin).toBe('synthetic');
    expect(result.artifact.samples.every((sample: any) => sample.reset.status === 'observed')).toBe(true);
    expect(JSON.stringify(result.artifact)).not.toContain('TEST_ONLY_NOT_REAL');
    expect(result.artifact.samples[0].lifecycle.exitCode).toBe(1);
    for (const [input] of execute.mock.calls) {
      expect(input.env.DOTENV_CONFIG_PATH).toContain('.benchmark-empty.env');
      expect(input.env).not.toHaveProperty('DOTENV_CONFIG_OVERRIDE');
    }
    expect(() => lifecycle.writeNewJson(result.outputPath, {})).toThrow();
  });

  it.each([
    ['wrong_hash', 'benchmark_target_mismatch', 1], ['foreign_nonce', 'benchmark_target_mismatch', 1],
    ['reused_run', 'benchmark_session_not_fresh', 2], ['cleanup_failed', 'benchmark_cleanup_failed', 1],
    ['source_changed', 'benchmark_source_changed', 1], ['spawn_error', 'benchmark_sample_failed', 1],
  ])('retains %s and stops issuing later paid work', async (behavior, code, calls) => {
    const {options, dependencies, execute} = controllerFixture(directory, String(behavior));
    const result = await controller.runBenchmark(options, dependencies);
    expect(result.artifact.lifecycle).toBe('incomplete');
    expect(result.artifact.samples[result.artifact.samples.length - 1].failureCode).toBe(code);
    expect(execute).toHaveBeenCalledTimes(Number(calls));
    expect(result.artifact.qualityAdmission).toBe('not_scored');
    expect(JSON.stringify(result.artifact)).not.toContain('arbitrary private native error');
    if (behavior === 'spawn_error') expect(result.artifact.samples[0].reset.actions).not.toContain('spawned_process');
  });

  it('retains missing reports as unknown samples instead of silently excluding failures', async () => {
    const {options, dependencies} = controllerFixture(directory, 'missing_report');
    const {artifact} = await controller.runBenchmark(options, dependencies);
    expect(artifact.samples).toHaveLength(6);
    expect(artifact.samples.every((sample: any) => sample.reportStatus === 'missing' && sample.targetStatus === 'unavailable')).toBe(true);
    expect(artifact.lifecycle).toBe('incomplete');
  });

  it('starts the verifier with the owned Node pid through the installed public tsx loader', async () => {
    const filename = path.join(directory, 'verifier.ts');
    fs.writeFileSync(filename, 'const value: number = process.pid; if (require.main === module) console.log(value);');
    const preflight = require.resolve('tsx/preflight', {paths: [backendRoot]});
    const loader = require.resolve('tsx', {paths: [backendRoot]});
    const child = spawn(process.execPath, ['--require', preflight, '--import', pathToFileURL(loader).href, filename],
      {cwd: backendRoot, env: {...process.env, NODE_OPTIONS: ''}, stdio: ['ignore', 'pipe', 'pipe']});
    let stdout = '';
    child.stdout.on('data', value => {stdout += value.toString();});
    const exitCode = await new Promise<number | null>((resolve, reject) => {child.once('error', reject); child.once('close', resolve);});
    expect(exitCode).toBe(0);
    expect(Number(stdout.trim())).toBe(child.pid);
  });
});


describe('W0 default-text to native-v2 controller', () => {
  type ProbeInput = {args: string[]; label: string; backendRoot: string; env: NodeJS.ProcessEnv; request: {port: number}};
  type ProbeLifecycle = {preparedAt: number; settledAt: number; processId: number; exitCode: number;
    signal: null; outcome: 'exited' | 'nonzero_exit'; censored: false; cleanup: 'confirmed'};
  const directories: string[] = [];
  afterEach(() => {for (const directory of directories.splice(0)) fs.rmSync(directory, {recursive: true, force: true});});
  function treatmentFixture(mutation?: (input: any, request: any, result: any) => void) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'llm-treatment-')); directories.push(directory);
    const fixture = controllerFixture(directory);
    fixture.options.treatment = lifecycle.TREATMENT_ID;
    const load = fixture.dependencies.loadCheckout;
    fixture.dependencies.loadCheckout = (root: string) => {
      write(root, 'backend/src/scripts/agentE2eMetrics.ts', 'common observed projection');
      const loaded: any = load(root);
      const prepare = loaded.api.prepareProviderChild;
      loaded.api.prepareProviderChild = (input: any, env: any) => ({...prepare(), env: {...env,
        OPENAI_MODEL: 'glm-5.3-flash', SMARTPERFETTO_BACKEND_DATA_DIR: path.join(input.isolatedRoot, 'data'),
        SMARTPERFETTO_BACKEND_LOG_DIR: path.join(input.isolatedRoot, 'logs')}});
      loaded.observer = lifecycle.fingerprintObserver(root, HOOK, true);
      return loaded;
    };
    const order: string[] = [];
    const paid = fixture.dependencies.runOwnedVerifier;
    fixture.dependencies.runOwnedVerifier = jest.fn(async (input: any) => {order.push('paid'); return paid(input);});
    let probeOrdinal = 0;
    const probe = jest.fn(async (input: ProbeInput): Promise<ProbeLifecycle> => {
      const ordinal = ++probeOrdinal;
      const requestPath = input.args[input.args.indexOf('--input') + 1], outputPath = input.args[input.args.indexOf('--output') + 1];
      const request = JSON.parse(fs.readFileSync(requestPath, 'utf8'));
      order.push(`probe:${request.side}`);
      const sdk = {agentsCoreVersion: '0.13.0', agentsOpenAiVersion: '0.13.0', identity: 'matched'};
      const result: any = {schemaVersion: 'llm_target_preflight@2', nonce: request.nonce, side: request.side, cellId: request.cellId,
        requestedMode: request.requestedMode, observedSourceFingerprint: request.expectedSourceFingerprint,
        declaredConfigFingerprint: request.declaredConfig.fullFingerprint, declaredControlsFingerprint: request.declaredConfig.controlsFingerprint,
        declaredTreatmentHash: request.treatmentHash, status: 'ready', capturedOutput: lifecycle.TREATMENT_OUTPUTS[request.side], sdk: {...sdk, nodeVersion: process.versions.node},
        actualResolvedConfig: lifecycle.buildConfigCommitments({model: 'glm-5.3-flash', lightModel: 'glm-5.3-flash',
          baseURL: 'https://open.bigmodel.cn/api/coding/paas/v4', protocol: 'chat_completions',
          runtime: 'openai-agents-sdk', sdk, outputConfig: lifecycle.TREATMENT_OUTPUTS[request.side]}),
        purposeContracts: {schemaVersion: 'llm_purpose_controls@1', classification: {
          commonConfig: lifecycle.buildConfigCommitments({model: 'glm-5.3-flash', lightModel: 'glm-5.3-flash'}),
          tokenLimit: {status: 'explicit', field: 'max_tokens', valueCommitment: lifecycle.hash(lifecycle.canonicalJson(['number', '2048']))}},
          review: {commonConfig: lifecycle.buildConfigCommitments({lightModel: 'glm-5.3-flash'}), tokenLimit: {status: 'absent'}}}};
      mutation?.(input, request, result);
      fs.writeFileSync(outputPath, JSON.stringify(result));
      return {preparedAt: Date.now(), settledAt: Date.now(), processId: 900 + ordinal,
        exitCode: result.status === 'ready' ? 0 : 1, signal: null, outcome: result.status === 'ready' ? 'exited' : 'nonzero_exit',
        censored: false, cleanup: 'confirmed'};
    });
    return {...fixture, probe, order, dependencies: {...fixture.dependencies, runPreflight: probe}};
  }

  it('keeps TS/native-CLI config commitments identical across private values, paths, arrays and treatment masking', () => {
    const base = {environment: {SMARTPERFETTO_FINAL_SUBMISSION: 'assistant_text', SMARTPERFETTO_CONCLUSION_AUTHORING: 'canonical_v1',
      OPENAI_PRIVATE_TEST: 'VALUE_CANARY_9beec'}, weird: {'a/b': {'~': -0}}, options: [true, null, undefined]};
    const candidate = {...base, environment: {...base.environment, SMARTPERFETTO_FINAL_SUBMISSION: 'authored_claim_document_v2',
      SMARTPERFETTO_CONCLUSION_AUTHORING: 'authoring_v2'}, extra: false};
    const left = lifecycle.buildConfigCommitments(base), right = lifecycle.buildConfigCommitments(candidate);
    expect(left).toEqual(buildRuntimeConfigCommitments(base)); expect(right).toEqual(buildRuntimeConfigCommitments(candidate));
    expect(lifecycle.alignConfigCommitments(left, right)).toEqual(alignRuntimeConfigCommitments(left, right));
    for (const fields of lifecycle.alignConfigCommitments(left, right)) {
      const config = lifecycle.makeConfigCommitments(fields, 'a'.repeat(64));
      expect(config.fullFingerprint).toBe(runtimeConfigCommitmentsFingerprint(fields));
      expect(config.controlsFingerprint).toBe(runtimeConfigControlsFingerprint(fields));
      expect(parseRuntimeBenchmarkConfigCommitments(config)).toEqual(config);
      expect(JSON.stringify(config)).not.toContain('VALUE_CANARY_9beec');
    }
  });

  it('requires an explicit supported treatment selection and preserves the no-treatment path', () => {
    expect(controller.parseArgs(cli('/base', '/candidate'))).not.toHaveProperty('treatment');
    for (const id of [lifecycle.TREATMENT_ID, lifecycle.MIXED_CONTENT_TREATMENT_ID]) {
      expect(controller.parseArgs(cli('/base', '/candidate', ['--treatment', id])).treatment).toBe(id);
    }
    expect(() => controller.parseArgs(cli('/base', '/candidate', ['--treatment', 'assistant_text_to_native_v2@3']))).toThrow('benchmark_treatment_invalid');
  });

  it('keeps the historical constructor byte hash captured from actual Stage A source', () => {
    const inputs = ['base', 'candidate'].map(side => ({runtime: 'openai-agents-sdk', control: {budget: 4096}, environment: {
      SMARTPERFETTO_FINAL_SUBMISSION: lifecycle.TREATMENT_OUTPUTS[side].finalSubmission,
      SMARTPERFETTO_CONCLUSION_AUTHORING: lifecycle.TREATMENT_OUTPUTS[side].declarationSyntax,
    }}));
    const aligned = lifecycle.alignConfigCommitments(...inputs.map(input => lifecycle.buildConfigCommitments(input)));
    const configurations = aligned.map((fields: unknown, index: number) => lifecycle.makeConfigCommitments(fields, lifecycle.hash(JSON.stringify(inputs[index]))));
    // Captured before any production edit: r11/d-stage-b/legacy-treatment-before.json.
    const capturedSha = 'fb0f2a9b4774eb5242108186c489c48ef6331bf96e245a65ebc87630772a8b65';
    expect(lifecycle.hash(JSON.stringify(lifecycle.makeRepresentationTreatment(...configurations)))).toBe(capturedSha);
    expect(lifecycle.hash(JSON.stringify(lifecycle.makeRepresentationTreatment(...configurations, lifecycle.TREATMENT_ID)))).toBe(capturedSha);
    const mixed = lifecycle.makeRepresentationTreatment(...configurations, lifecycle.MIXED_CONTENT_TREATMENT_ID);
    expect(mixed).toMatchObject({schemaVersion: 'representation_treatment@2', implementationContracts: {
      candidate: OPENAI_TYPED_FINAL_CONTRACTS['openai_typed_final_admission@3']}});
    expect(() => lifecycle.makeRepresentationTreatment(...configurations, 'unknown')).toThrow('benchmark_treatment_invalid');
  });

  it('keeps the native CLI exact tuple mirror in parity without widening to Cartesian versions', () => {
    expect(lifecycle.parseOutputImplementation(OPENAI_ASSISTANT_OUTPUT_IMPLEMENTATION)).toEqual(OPENAI_ASSISTANT_OUTPUT_IMPLEMENTATION);
    for (const [admission, identity] of Object.entries(OPENAI_TYPED_FINAL_CONTRACTS)) {
      expect(lifecycle.getOpenAiTypedFinalContractIdentity(admission)).toEqual(getOpenAiTypedFinalContractIdentity(admission));
      expect(lifecycle.parseOutputImplementation({kind: 'typed', ...identity})).toEqual({kind: 'typed', ...identity});
      for (const field of Object.keys(identity)) {
        const partial: Record<string, unknown> = {kind: 'typed', ...identity}; delete partial[field];
        expect(() => lifecycle.parseOutputImplementation(partial)).toThrow('benchmark_output_implementation_invalid');
        for (const other of Object.values(OPENAI_TYPED_FINAL_CONTRACTS)) {
          if (other[field as keyof typeof other] === identity[field as keyof typeof identity]) continue;
          expect(() => lifecycle.parseOutputImplementation({...identity, kind: 'typed', [field]: other[field as keyof typeof other]}))
            .toThrow('benchmark_output_implementation_invalid');
        }
      }
      expect(() => lifecycle.parseOutputImplementation({kind: 'typed', ...identity, raw: 'PRIVATE'})).toThrow('benchmark_output_implementation_invalid');
    }
    for (const value of ['__proto__', 'unknown', undefined, null, 3]) expect(lifecycle.getOpenAiTypedFinalContractIdentity(value)).toBeUndefined();
    expect(() => lifecycle.parseOutputImplementation({...OPENAI_ASSISTANT_OUTPUT_IMPLEMENTATION, wireVersion: 'openai_chat_final_wire@2'})).toThrow();
  });

  it.each([
    [], ['--mode', 'full'], ['--mode', 'fast'], ['--mode', 'smart'], ['--provider-id', ' ENV '],
    ['--follow-up-query', 'next', '--follow-up-mode', 'fast'],
  ].map(extra => ({extra})))('matches maintained verifier mode/provider selection: %j', ({extra}) => {
    const args = ['--trace', 'fixture.pftrace', '--output', 'unused.json', ...extra];
    const parsed = parseVerifierArgs(args);
    const expected = [{requestedMode: parsed.analysisMode ?? 'auto', ...(parsed.providerId === undefined ? {} : {providerId: parsed.providerId})}];
    if (parsed.followUpQuery) expected.push({requestedMode: parsed.followUpAnalysisMode, ...(parsed.providerId === undefined ? {} : {providerId: parsed.providerId})});
    expect(lifecycle.cellPreflightSelections(args)).toEqual(expected);
  });

  it('awaits both initial real-gate receipts before any sample, and rechecks every sample without granting admission', async () => {
    const fixture = treatmentFixture();
    const result = await controller.runBenchmark(fixture.options, fixture.dependencies);
    expect(fixture.order.slice(0, 2)).toEqual(['probe:base', 'probe:candidate']);
    expect(fixture.order.indexOf('paid')).toBeGreaterThanOrEqual(3);
    expect(fixture.probe).toHaveBeenCalledTimes(8);
    expect(new Set(fixture.probe.mock.calls.map((call: [ProbeInput]) => call[0].label)).size).toBe(8);
    expect(result.artifact).toMatchObject({schemaVersion: 'llm_execution_benchmark@2', candidate: lifecycle.TREATMENT_ID,
      measurementOrigin: 'synthetic', performanceAdmission: 'not_scored', qualityAdmission: 'not_scored'});
    expect(result.artifact.samples).toHaveLength(6);
    expect(result.artifact.samples.every((sample: any) => sample.schemaVersion === 'llm_execution_sample@2' && sample.preflights.length === 1)).toBe(true);
    const [base, candidate] = ['base', 'candidate'].map(side => result.artifact.samples.find((sample: any) => sample.side === side).configuration);
    expect(base.fullFingerprint).not.toBe(candidate.fullFingerprint);
    expect(base.controlsFingerprint).toBe(candidate.controlsFingerprint);
  });

  it.each(['sdk', 'nonce', 'mode', 'gate', 'captured', 'actual_control'])('fails before both sides pay for a candidate preflight fault: %s', fault => {
    const fixture = treatmentFixture((_input, request, result) => {
      if (request.side !== 'candidate') return;
      if (fault === 'sdk') result.sdk.agentsCoreVersion = 'unknown';
      if (fault === 'nonce') result.nonce = 'f'.repeat(32);
      if (fault === 'mode') result.requestedMode = 'invalid';
      if (fault === 'gate') {result.status = 'failed'; result.failureCode = 'unsupported_final_submission';}
      if (fault === 'captured') result.capturedOutput = lifecycle.TREATMENT_OUTPUTS.base;
      if (fault === 'actual_control') result.actualResolvedConfig = lifecycle.buildConfigCommitments({changedBudget: 42});
    });
    return expect(controller.runBenchmark(fixture.options, fixture.dependencies)).rejects.toThrow('benchmark_').then(() => {
      expect(fixture.dependencies.runOwnedVerifier).not.toHaveBeenCalled();
    });
  });

  it('rejects new implementation claims smuggled into a historical preflight before any paid sample', async () => {
    const fixture = treatmentFixture((_input, request, result) => {
      if (request.side === 'candidate') result.outputImplementation = {kind: 'typed', ...OPENAI_TYPED_FINAL_CONTRACTS['openai_typed_final_admission@3']};
    });
    await expect(controller.runBenchmark(fixture.options, fixture.dependencies)).rejects.toThrow('benchmark_preflight_failed');
    expect(fixture.dependencies.runOwnedVerifier).not.toHaveBeenCalled();
  });

  it('supports the explicitly selected mixed transport without silently relabeling the historical treatment', async () => {
    const fixture = treatmentFixture((_input, request, result) => {
      result.schemaVersion = 'llm_target_preflight@3';
      result.outputImplementation = request.side === 'base' ? OPENAI_ASSISTANT_OUTPUT_IMPLEMENTATION
        : {kind: 'typed', ...OPENAI_TYPED_FINAL_CONTRACTS['openai_typed_final_admission@3']};
    });
    fixture.options.treatment = 'assistant_text_to_native_v2@2';
    const result = await controller.runBenchmark(fixture.options, fixture.dependencies);
    expect(result.artifact.treatment).toMatchObject({schemaVersion: 'representation_treatment@2', id: 'assistant_text_to_native_v2@2',
      implementationContracts: {candidate: OPENAI_TYPED_FINAL_CONTRACTS['openai_typed_final_admission@3']}});
    expect(result.artifact.measurementOrigin).toBe('synthetic');
    expect(fixture.dependencies.runOwnedVerifier).toHaveBeenCalledTimes(6);
  });

  it.each(['old_receipt', 'missing', 'old_contract', 'wrong_wire', 'wrong_compiler', 'base_typed', 'extra', 'old_id_new_contract'])(
    'rejects a mixed implementation preflight mismatch before any paid sample: %s', fault => {
      const fixture = treatmentFixture((_input, request, result) => {
        result.schemaVersion = 'llm_target_preflight@3';
        result.outputImplementation = request.side === 'base' ? OPENAI_ASSISTANT_OUTPUT_IMPLEMENTATION
          : {kind: 'typed', ...OPENAI_TYPED_FINAL_CONTRACTS['openai_typed_final_admission@3']};
        if (fault === 'base_typed' && request.side === 'base') result.outputImplementation = {kind: 'typed', ...OPENAI_TYPED_FINAL_CONTRACTS['openai_typed_final_admission@3']};
        if (request.side !== 'candidate') return;
        if (fault === 'old_receipt') {result.schemaVersion = 'llm_target_preflight@2'; delete result.outputImplementation;}
        if (fault === 'missing') delete result.outputImplementation;
        if (fault === 'old_contract') result.outputImplementation = {kind: 'typed', ...OPENAI_TYPED_FINAL_CONTRACTS['openai_typed_final_admission@2']};
        if (fault === 'wrong_wire') result.outputImplementation.wireVersion = 'openai_chat_final_wire@1';
        if (fault === 'wrong_compiler') result.outputImplementation.compilerVersion = 'authored_claim_document_compiler@1';
        if (fault === 'extra') result.outputImplementation.privatePayload = 'PRIVATE';
      });
      fixture.options.treatment = fault === 'old_id_new_contract' ? lifecycle.TREATMENT_ID : lifecycle.MIXED_CONTENT_TREATMENT_ID;
      return expect(controller.runBenchmark(fixture.options, fixture.dependencies)).rejects.toThrow('benchmark_preflight_failed').then(() => {
        expect(fixture.dependencies.runOwnedVerifier).not.toHaveBeenCalled();
      });
    });

  it('finishes every initial cell implementation gate before any paid sample', async () => {
    const fixture = treatmentFixture((_input, request, result) => {
      result.schemaVersion = 'llm_target_preflight@3';
      result.outputImplementation = request.side === 'base' ? OPENAI_ASSISTANT_OUTPUT_IMPLEMENTATION
        : {kind: 'typed', ...OPENAI_TYPED_FINAL_CONTRACTS[request.cellId === 'startup'
          ? 'openai_typed_final_admission@2' : 'openai_typed_final_admission@3']};
    });
    fixture.options.treatment = lifecycle.MIXED_CONTENT_TREATMENT_ID;
    fixture.options.cells = ['scheduler', 'startup'];
    const load = fixture.dependencies.loadCheckout;
    fixture.dependencies.loadCheckout = (root: string) => {
      const checkout = load(root);
      return {...checkout, api: {...checkout.api,
        suites: {startup: {args: ['--trace', '../Trace/fixture.pftrace', '--expectation-json', '{}']}}}};
    };
    await expect(controller.runBenchmark(fixture.options, fixture.dependencies)).rejects.toThrow('benchmark_preflight_failed');
    expect(fixture.order).toEqual(['probe:base', 'probe:candidate', 'probe:base', 'probe:candidate']);
    expect(fixture.dependencies.runOwnedVerifier).not.toHaveBeenCalled();
    const lastProbe = fixture.probe.mock.calls[3][0];
    const saved = JSON.parse(fs.readFileSync(lastProbe.args[lastProbe.args.indexOf('--output') + 1], 'utf8'));
    expect(saved).toMatchObject({status: 'ready', cellId: 'startup', side: 'candidate',
      outputImplementation: {admissionVersion: 'openai_typed_final_admission@2'}});
  });

  it('accepts an actual @3 receipt for the exact historical implementation without upgrading it', async () => {
    const fixture = treatmentFixture((_input, request, result) => {
      result.schemaVersion = 'llm_target_preflight@3'; result.outputImplementation = request.side === 'base' ? OPENAI_ASSISTANT_OUTPUT_IMPLEMENTATION
        : {kind: 'typed', ...OPENAI_TYPED_FINAL_CONTRACTS['openai_typed_final_admission@2']};
    });
    const result = await controller.runBenchmark(fixture.options, fixture.dependencies);
    expect(result.artifact.treatment.id).toBe(lifecycle.TREATMENT_ID);
    expect(result.artifact.treatment.implementationContracts.candidate).not.toHaveProperty('wireVersion');
    expect(fixture.dependencies.runOwnedVerifier).toHaveBeenCalledTimes(6);
  });

  it('blocks an implementation drift in the first sample reprobe before that paid invocation', async () => {
    let probeCount = 0;
    const fixture = treatmentFixture((_input, request, result) => {
      result.schemaVersion = 'llm_target_preflight@3';
      result.outputImplementation = request.side === 'base' ? OPENAI_ASSISTANT_OUTPUT_IMPLEMENTATION
        : {kind: 'typed', ...OPENAI_TYPED_FINAL_CONTRACTS['openai_typed_final_admission@3']};
      if (++probeCount === 3) result.outputImplementation = {kind: 'typed', ...OPENAI_TYPED_FINAL_CONTRACTS['openai_typed_final_admission@2']};
    });
    fixture.options.treatment = lifecycle.MIXED_CONTENT_TREATMENT_ID;
    const result = await controller.runBenchmark(fixture.options, fixture.dependencies);
    expect(fixture.dependencies.runOwnedVerifier).not.toHaveBeenCalled();
    expect(result.artifact.lifecycle).toBe('incomplete');
    expect(result.artifact.samples[0].failureCode).toBe('benchmark_preflight_failed');
  });

  it('refuses a later probe change before dispatching that sample', async () => {
    let count = 0;
    const fixture = treatmentFixture((_input, _request, result) => {if (++count === 3) result.sdk.agentsCoreVersion = '0.14.0';});
    const result = await controller.runBenchmark(fixture.options, fixture.dependencies);
    expect(fixture.dependencies.runOwnedVerifier).not.toHaveBeenCalled();
    expect(result.artifact.lifecycle).toBe('incomplete');
    expect(result.artifact.samples[0].failureCode).toBe('benchmark_preflight_changed');
  });
});
