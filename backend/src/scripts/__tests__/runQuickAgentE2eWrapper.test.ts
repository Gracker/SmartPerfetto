// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import { execFile, spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { promisify } from 'util';
import { getTraceProcessorPath } from '../../services/workingTraceProcessor';
import { resolveTraceCase } from '../../../tests/helpers/traceCorpus';

const backendRoot = path.resolve(__dirname, '../../..');
const wrapperPath = path.join(backendRoot, 'scripts/run-quick-agent-e2e.cjs');
const {frameFactExpectation, buildChildEnv, evaluateSemanticConditionReport, semanticDeltaQueries, semanticConditionArgs} = require(path.join(backendRoot, 'scripts/run-glm-agent-e2e.cjs')) as {
  frameFactExpectation: () => {facts: Array<{id: string; oracle: {sql: string}}>};
  buildChildEnv: (apiKey: string, runtimeKind: string, isolatedRoot: string) => Record<string, string | undefined>;
  evaluateSemanticConditionReport: (input: {report: unknown; query: {kind: string}; condition: string; sourceRoot: string}) => {
    traceFactPassed: boolean; overallTaskChecksPassed: boolean;
    sourceBindingPassed: boolean; sourceIdentityPassed: boolean; sourceSemanticPassed: boolean; privacyCanaryCovered: boolean; uncoveredFacets: string[];
  };
  semanticDeltaQueries: () => Array<{id: string; kind: string; text: string}>;
  semanticConditionArgs: (query: unknown, condition: string, output: string, timeoutMs: number) => string[];
};
const execFileAsync = promisify(execFile);
const launchLightTracePath = resolveTraceCase('launch_light.pftrace', path.resolve(backendRoot, '..'));
const traceProcessorPath = getTraceProcessorPath();
const itWithLaunchLightTraceProcessor = fs.existsSync(traceProcessorPath) && fs.existsSync(launchLightTracePath)
  ? it
  : it.skip;

describe('declarative system-analysis suite', () => {
  const wrapper = require(path.join(backendRoot, 'scripts/run-glm-agent-e2e.cjs'));
  it('exposes a bounded suite with separate real and constructed scenario labels', () => {
    expect(wrapper.parseArgs(['--suite', 'system-analysis', '--runtime', 'openai']).suite).toBe('system-analysis');
    const scenarios = wrapper.systemAnalysisScenarios();
    expect(scenarios.filter((item: any) => item.evidenceTier === 'real').map((item: any) => item.id))
      .toEqual(['startup-real', 'scrolling-real', 'startup-pair-real']);
    expect(scenarios.filter((item: any) => item.evidenceTier === 'constructed').map((item: any) => item.id))
      .toEqual(['scheduler-constructed', 'input-constructed', 'anr-constructed', 'game-constructed', 'media-constructed',
        'io-constructed', 'memory-constructed', 'power-constructed', 'linux-constructed', 'network-constructed', 'pipeline-constructed']);
    for (const scenario of scenarios) {
      expect(scenario.args).toContain('--require-non-partial');
      expect(scenario.args).not.toContain('--require-text');
      expect(scenario.args).not.toContain('--require-tool');
      const fixture = scenario.args[scenario.args.indexOf('--expectation-json') + 1];
      expect(fixture.startsWith('@')).toBe(true);
      const expectation = JSON.parse(fs.readFileSync(fixture.slice(1), 'utf8'));
      expect(expectation.investigation.requirements[0].records[0].oracleScope.factId).toBe(expectation.facts[0].id);
      expect(expectation.investigation.requirements[0].records[0].origin).toBe('current_run');
      if (scenario.evidenceTier === 'constructed') expect(scenario.args).toContain('--select-slice-json');
    }
  });
  it('does not label the three GLM Coding Plan native adapters as five-runtime acceptance', () => {
    expect(wrapper.resolveRuntimeKinds('all')).toEqual(['openai-agents-sdk', 'pi-agent-core', 'opencode']);
    expect(wrapper.resolveRuntimeKinds('claude')).toEqual(['claude-agent-sdk']);
    expect(wrapper.resolveRuntimeKinds('qoder')).toEqual(['qoder-agent-sdk']);
  });
  it('selects a single known system scenario without claiming the whole matrix', () => {
    expect(wrapper.parseArgs(['--suite', 'system-analysis', '--system-scenario', 'scheduler-constructed']).systemScenario)
      .toBe('scheduler-constructed');
    expect(() => wrapper.parseArgs(['--suite', 'startup', '--system-scenario', 'startup-real'])).toThrow('system-analysis suite');
    expect(() => wrapper.parseArgs(['--suite', 'system-analysis', '--system-scenario', 'absent'])).toThrow('existing manifest ID');
  });
  it('keeps legacy real output names compatible and isolates every constructed runtime artifact', () => {
    const runtimes = wrapper.resolveRuntimeKinds('all');
    expect(wrapper.withRuntimeOutputPath(['--output', 'test-output/e2e-startup-real.json'],
      'test-output/e2e-startup-real.json', 'pi-agent-core'))
      .toEqual(['--output', 'test-output/e2e-startup-pi-agent-core-real.json']);
    for (const scenario of wrapper.systemAnalysisScenarios()) {
      const outputs = runtimes.map((runtime: string) => {
        const args = wrapper.withRuntimeOutputPath(scenario.args, scenario.output, runtime);
        const output = args[args.indexOf('--output') + 1];
        expect(output).toContain(runtime);
        expect(scenario.args[scenario.args.indexOf('--output') + 1]).toBe(scenario.output);
        return output;
      });
      expect(new Set(outputs).size).toBe(runtimes.length);
      for (const suffix of ['.diagnostics.json', '.session-log.jsonl', '.isolated-session-log.jsonl']) {
        expect(new Set(outputs.map((output: string) => `${output}${suffix}`)).size).toBe(runtimes.length);
      }
    }
    expect(wrapper.withRuntimeOutputPath([], 'test-output/system-analysis/scheduler-constructed.json', 'opencode'))
      .toEqual(['--output', 'test-output/system-analysis/scheduler-constructed-opencode.json']);
  });

  it('keeps every coverage-matrix test pointer current and selects real non-main actors from constructed fixtures', () => {
    const directory = path.join(backendRoot, 'tests/e2e/system-analysis-fixtures');
    const matrix = JSON.parse(fs.readFileSync(path.join(directory, 'coverage-matrix.json'), 'utf8'));
    expect(matrix.providerDefinitions.map((item: any) => item.id)).toEqual(wrapper.systemAnalysisScenarios().map((item: any) => item.id));
    for (const item of matrix.deterministicDefinitions) expect(fs.readFileSync(path.join(backendRoot, item.testFile), 'utf8')).toContain(item.testTitle);
    const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'manifest.json'), 'utf8'));
    for (const row of manifest.scenarios.filter((item: any) => item.evidenceTier === 'constructed')) {
      const caseId = row.trace.split('/').at(-2);
      const fixture = JSON.parse(fs.readFileSync(path.resolve(backendRoot, '../Trace/constructed', caseId, 'scenario.json'), 'utf8'));
      const threads = new Map(fixture.actors.threads.map((thread: any) => [thread.id, thread]));
      const selected = fixture.signals.filter((signal: any) => signal.type === 'atrace-slice' && signal.name === row.selectSlice.eventName &&
        (threads.get(signal.thread) as any)?.name === row.selectSlice.threadName);
      expect(selected).toHaveLength(1);
    }
    expect(manifest.scenarios.find((item: any) => item.id === 'game-constructed').selectSlice.threadName).toBe('GameThread');
    expect(manifest.scenarios.find((item: any) => item.id === 'media-constructed').selectSlice.threadName).toBe('RenderThread');
  });

  it('preserves redacted child logs and releases isolated roots when the verifier fails', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wrapper-failure-'));
    const output = path.join(directory, 'result.json');
    const previousExitCode = process.exitCode;
    let isolatedRoot = '';
    const spawn = jest.fn((_command: string, _args: string[], options: any) => {
      isolatedRoot = path.dirname(options.env.SMARTPERFETTO_BACKEND_LOG_DIR);
      const logs = path.join(options.env.SMARTPERFETTO_BACKEND_LOG_DIR, 'sessions');
      fs.mkdirSync(logs, {recursive: true});
      fs.writeFileSync(path.join(logs, 'session_owned_2026.jsonl'), JSON.stringify({level: 'error',
        error: {message: 'analysis_history_parent_not_authorized'}, apiKey: 'secret-not-for-artifact'}));
      return {status: 1};
    });
    jest.doMock('child_process', () => ({...jest.requireActual('child_process'), spawnSync: spawn}));
    const logging = jest.spyOn(console, 'log').mockImplementation(() => {});
    try {
      jest.isolateModules(() => {
        const isolated = require(path.join(backendRoot, 'scripts/run-glm-agent-e2e.cjs'));
        expect(() => isolated.runSuite('system-analysis', {apiKey: 'fake', credentialKind: 'test'}, 'openai-agents-sdk', false, 10,
          {label: 'test', output, args: ['--output', output]})).toThrow('exited with status 1');
      });
      expect(fs.existsSync(isolatedRoot)).toBe(false);
      const log = fs.readFileSync(`${output}.isolated-session-log.jsonl`, 'utf8');
      expect(log).toContain('analysis_history_parent_not_authorized');
      expect(log).not.toContain('secret-not-for-artifact');
    } finally {
      process.exitCode = previousExitCode;
      jest.dontMock('child_process'); logging.mockRestore();
      fs.rmSync(directory, {recursive: true, force: true});
    }
  });
});

describe('source citation acceptance', () => {
  const sourceText = fs.readFileSync(path.join(backendRoot, 'tests/e2e/context-fixtures/app/StartupHooks.kt'), 'utf8');
  const sourceLineCount = sourceText.trimEnd().split(/\r?\n/).length;
  const canaryLine = sourceText.split(/\r?\n/).findIndex(line => line.includes('SEMANTIC_DELTA_PRIVATE_SOURCE_CANARY_NEVER_EMIT')) + 1;
  const requiredSourceRange = JSON.parse(fs.readFileSync(path.resolve(backendRoot,
    '../Trace/constructed/source-analysis-semantic/analysis/expected.json'), 'utf8')).source_trace_ground_truth.lineRange;
  it('checks the source oracle value against the answer body without row anchors or copied fingerprints', () => {
    const query = semanticDeltaQueries().find(item => item.kind === 'quantitative-only')!;
    const args = semanticConditionArgs(query, 'A0', 'a0.json', 1000);
    const expected = JSON.parse(args[args.indexOf('--expectation-json') + 1]);
    expect(expected.facts[0]).toMatchObject({id: 'source_marker_duration', kind: 'numeric', unit: 'ns',
      oracle: {column: 'duration_ns', unit: 'ns'}});
    expect(expected.facts[0].oracle.sql).toContain('s.dur AS duration_ns');
    expect(expected.facts[0].oracle).not.toHaveProperty('anchorMatch');
    expect(JSON.stringify(expected)).not.toContain('schemaFingerprint');
    expect(args).not.toContain('--require-claim-verifier-ok');
    expect(args[args.indexOf('--query') + 1]).toBe(query.text);
  });

  function fixture() {
    const sourceId = 'source-ref-v1-issued';
    const report: any = {traceId: 'trace', passed: true,
      analysisContext: {codebaseIds: ['selected-source'], setup: {codebases: [{setupMode: 'register-only',
        chunkCount: 0, activeIndexState: 'none', pendingGeneration: false, reindexRequests: 0}]}},
      taskVerification: {checks: {nonPartial: true, 'fact:source_marker_duration': true},
        facts: {source_marker_duration: {matched: true}}},
      summary: {analysisCompletedSourceReferenceCount: 1, analysisCompletedSourceCitationCount: 1,
        analysisCompletedSourceCitationsMatched: true, analysisCompletedSourceCitedReferenceIds: [sourceId],
        analysisCompletedSourceClaimVerifierStatus: 'passed',
        analysisCompletedSourceUseDecision: {references: [{id: sourceId, codebaseId: 'selected-source',
          filePath: 'StartupHooks.kt', lineRange: {start: 1, end: sourceLineCount}, lookupKind: 'body'}]}}};
    return {report, evaluate: () => evaluateSemanticConditionReport({report, query: {kind: 'explicit-source-location'},
      condition: 'A2', sourceRoot: path.join(backendRoot, 'tests/e2e/context-fixtures/app')})};
  }

  it('accepts a cited body read of the ground-truth source beside the matched Trace fact', () => {
    const target = fixture();
    const before = structuredClone(target.report);
    expect(target.evaluate()).toMatchObject({traceFactPassed: true, sourceBindingPassed: true, sourceIdentityPassed: true,
      sourceSemanticPassed: true, privacyCanaryCovered: true, uncoveredFacets: ['source recommendation action semantics']});
    expect(target.report).toEqual(before);
  });

  it('retains the matched Trace fact when another task check fails', () => {
    const target = fixture();
    target.report.taskVerification.checks.nonPartial = false;
    expect(target.evaluate()).toMatchObject({traceFactPassed: true, overallTaskChecksPassed: false});
  });

  it.each(['factCheck', 'matched', 'missingFact'] as const)('does not retain a Trace fact with a broken %s', change => {
    const target = fixture();
    const task = target.report.taskVerification;
    if (change === 'factCheck') task.checks['fact:source_marker_duration'] = false;
    if (change === 'matched') task.facts.source_marker_duration.matched = false;
    if (change === 'missingFact') delete task.facts.source_marker_duration;
    expect(target.evaluate()).toMatchObject({traceFactPassed: false, sourceSemanticPassed: false});
  });

  function withMockedVerifier(
    mutate: (report: any, args: string[]) => void,
    run: (wrapper: any, outputDir: string) => void,
  ) {
    const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'smartperfetto-layered-acceptance-'));
    const environment = jest.replaceProperty(process, 'env', {...process.env, GLM_API_KEY: 'test-only-key'});
    const logging = jest.spyOn(console, 'log').mockImplementation(() => {});
    const spawn = jest.fn((_command: string, args: string[]) => {
      expect(args[1]).toBe(path.join(backendRoot, 'src/scripts/verifyAgentSseScrolling.ts'));
      const output = args[args.indexOf('--output') + 1];
      const report = fixture().report;
      if (args[args.indexOf('--code-aware') + 1] === 'off') {
        report.analysisContext.codebaseIds = [];
        report.summary.analysisCompletedSourceReferenceCount = 0;
        report.summary.analysisCompletedSourceCitationCount = 0;
        report.summary.analysisCompletedSourceCitedReferenceIds = [];
        delete report.summary.analysisCompletedSourceCitationsMatched;
        delete report.summary.analysisCompletedSourceClaimVerifierStatus;
        report.summary.analysisCompletedSourceUseDecision.references = [];
      } else if (args[args.indexOf('--setup-codebase-mode') + 1] === 'register-and-index') {
        report.analysisContext.setup.codebases[0] = {setupMode: 'register-and-index', chunkCount: 1,
          activeIndexState: 'active', activeGeneration: 'test-generation', pendingGeneration: false, reindexRequests: 1};
      }
      mutate(report, args);
      fs.mkdirSync(path.dirname(output), {recursive: true});
      fs.writeFileSync(output, JSON.stringify(report));
      return {status: 0, stdout: '', stderr: ''};
    });
    jest.doMock('child_process', () => ({...jest.requireActual('child_process'), spawnSync: spawn}));
    try {
      jest.isolateModules(() => run(require(path.join(backendRoot, 'scripts/run-glm-agent-e2e.cjs')), outputDir));
      expect(spawn).toHaveBeenCalled();
    } finally {
      jest.dontMock('child_process');
      environment.restore();
      logging.mockRestore();
      fs.rmSync(outputDir, {recursive: true, force: true});
    }
  }

  it.each(['otherCheckFailed', 'traceFactMissing'] as const)(
    'keeps preflight, paired and runtime acceptance failed for %s despite a successful child exit', failure => {
      withMockedVerifier(report => {
        if (failure === 'otherCheckFailed') report.taskVerification.checks.nonPartial = false;
        else report.taskVerification.facts.source_marker_duration.matched = false;
      }, (wrapper, outputDir) => {
        const preflight = wrapper.runSemanticPreflight({runtime: 'openai-agents-sdk', queryId: 'explicit-source-location',
          condition: 'A2', outputDir, timeoutMs: 1000});
        expect(preflight).toMatchObject({preflightPassed: false, completeAcceptance: false,
          record: {passed: true, hardAssertions: {traceFactPassed: failure === 'otherCheckFailed',
            overallTaskChecksPassed: failure !== 'otherCheckFailed'}}});
        const paired = wrapper.runSemanticPairedAttempt({runtimeKind: 'openai-agents-sdk', attempt: 1,
          availability: {available: true, apiKey: 'test-only-key'}, outputDir, timeoutMs: 1000});
        expect(paired.hardPassed).toBe(false);
        expect(wrapper.summarizeSemanticRuntimeRecords([paired], 1)).toMatchObject({observedChecksPassed: false,
          completeAcceptance: false, status: 'REAL PROVIDER FAILED'});
      });
    });

  it('keeps all successful observed checks inconclusive while source action semantics remain uncovered', () => {
    withMockedVerifier(() => {}, (wrapper, outputDir) => {
      const preflight = wrapper.runSemanticPreflight({runtime: 'openai-agents-sdk', queryId: 'explicit-source-location',
        condition: 'A2', outputDir, timeoutMs: 1000});
      expect(preflight).toMatchObject({preflightPassed: true, completeAcceptance: false});
      const paired = wrapper.runSemanticPairedAttempt({runtimeKind: 'openai-agents-sdk', attempt: 1,
        availability: {available: true, apiKey: 'test-only-key'}, outputDir, timeoutMs: 1000});
      expect(paired.hardPassed).toBe(true);
      expect(wrapper.summarizeSemanticRuntimeRecords([paired], 1)).toMatchObject({observedChecksPassed: true,
        completeAcceptance: false, semanticAcceptance: 'INCONCLUSIVE', status: 'REAL PROVIDER INCONCLUSIVE'});
    });
  });

  it.each(['uncited', 'otherCitation', 'noCitations'] as const)(
    'does not establish source identity from a body read the answer does not cite: %s', change => {
      const target = fixture();
      const summary = target.report.summary;
      if (change === 'uncited') summary.analysisCompletedSourceCitedReferenceIds = [];
      if (change === 'otherCitation') summary.analysisCompletedSourceCitedReferenceIds = ['source-ref-v1-other'];
      if (change === 'noCitations') {
        summary.analysisCompletedSourceCitationCount = 0;
        summary.analysisCompletedSourceCitedReferenceIds = [];
      }
      expect(target.evaluate()).toMatchObject({sourceBindingPassed: true, sourceIdentityPassed: false, sourceSemanticPassed: false});
    });

  it.each(['start', 'end'] as const)('rejects a body read missing the required %s boundary', boundary => {
    const target = fixture();
    const reference = target.report.summary.analysisCompletedSourceUseDecision.references[0];
    reference.lineRange[boundary] = requiredSourceRange[boundary] + (boundary === 'start' ? 1 : -1);
    expect(target.evaluate()).toMatchObject({sourceBindingPassed: true, sourceIdentityPassed: false, sourceSemanticPassed: false});
  });

  it('counts a read covering the canary independently of complete mechanism coverage', () => {
    const target = fixture();
    const reference = target.report.summary.analysisCompletedSourceUseDecision.references[0];
    expect(canaryLine).toBeGreaterThan(0);
    expect(canaryLine).toBeLessThan(requiredSourceRange.end);
    reference.lineRange = {start: 1, end: canaryLine};
    expect(target.evaluate()).toMatchObject({privacyCanaryCovered: true, sourceIdentityPassed: false, sourceSemanticPassed: false});
  });

  it.each(['miss_canary', 'metadata', 'graph', 'wrong_codebase', 'wrong_file', 'unissued_id', 'inverted', 'zero_start', 'unsafe_end'])(
    'rejects %s when checking source canary coverage', failure => {
      const target = fixture();
      const reference = target.report.summary.analysisCompletedSourceUseDecision.references[0];
      if (failure === 'miss_canary') reference.lineRange.end = canaryLine - 1;
      if (failure === 'metadata' || failure === 'graph') reference.lookupKind = failure;
      if (failure === 'wrong_codebase') reference.codebaseId = 'unselected-source';
      if (failure === 'wrong_file') reference.filePath = 'Other.kt';
      if (failure === 'unissued_id') reference.id = 'unissued-source';
      if (failure === 'inverted') reference.lineRange = {start: sourceLineCount, end: 1};
      if (failure === 'zero_start') reference.lineRange.start = 0;
      if (failure === 'unsafe_end') reference.lineRange.end = Number.MAX_SAFE_INTEGER + 1;
      expect(target.evaluate()).toMatchObject({privacyCanaryCovered: false, sourceIdentityPassed: false, sourceSemanticPassed: false});
    });

  it.each(['metadata', 'graph'])('does not treat a %s location as source body evidence', lookupKind => {
    const target = fixture();
    target.report.summary.analysisCompletedSourceUseDecision.references[0].lookupKind = lookupKind;
    expect(target.evaluate()).toMatchObject({sourceBindingPassed: true, sourceIdentityPassed: false, sourceSemanticPassed: false});
  });

  it('blocks only on an unissued citation; an unmatched one stays advisory', () => {
    const advisory = fixture();
    advisory.report.summary.analysisCompletedSourceClaimVerifierStatus = 'partial';
    expect(advisory.evaluate()).toMatchObject({sourceBindingPassed: true, sourceIdentityPassed: true, sourceSemanticPassed: true});
    const failed = fixture();
    failed.report.summary.analysisCompletedSourceClaimVerifierStatus = 'failed';
    expect(failed.evaluate()).toMatchObject({sourceBindingPassed: false, sourceIdentityPassed: false, sourceSemanticPassed: false});
  });
});

function runWrapper(args: string[]) {
  return spawnSync(process.execPath, [wrapperPath, ...args], {
    cwd: backendRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      DOTENV_CONFIG_QUIET: 'true',
    },
  });
}

describe('run-quick-agent-e2e wrapper', () => {
  itWithLaunchLightTraceProcessor('matches the independent frame population oracle to launch_light', async () => {
    const fact = frameFactExpectation().facts.find(item => item.id === 'total_frames');
    expect(fact).toBeDefined();
    const {stdout} = await execFileAsync(traceProcessorPath, ['query', '--no-agent', '--format', 'csv', launchLightTracePath, fact!.oracle.sql], {
      maxBuffer: 5 * 1024 * 1024,
      timeout: 30_000,
    });
    const text = String(stdout);
    expect(text).toMatch(/^"total_frames","jank_frames"\r?$/m);
    expect(text).toMatch(/^291,\d+\r?$/m);
    expect(text).not.toMatch(/^248,\d+\r?$/m);
  }, 45_000);

  it('dry-runs the mixed trace/scrolling quick suite with strict quick-mode gates', () => {
    const result = runWrapper([
      '--suite',
      'mixed-trace-scrolling',
      '--runtime',
      'claude-agent-sdk',
      '--dry-run',
    ]);

    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout).toContain('[quick-e2e] suite=mixed-trace-scrolling');
    expect(result.stdout).toContain('[quick-e2e] runtime=claude-agent-sdk');
    expect(result.stdout).toContain('SMARTPERFETTO_AGENT_RUNTIME=claude-agent-sdk');
    expect(result.stdout).toContain('--require-quick-run');
    expect(result.stdout).toContain('--require-data-envelope');
    expect(result.stdout).toContain('--forbid-degraded-fallback quick_full_report_shape');
    expect(result.stdout).toContain('--max-analysis-completed-conclusion-chars 900');
    expect(result.stdout).not.toContain('--max-rounds');
    expect(result.stdout).toContain('--expectation-json');
    expect(result.stdout).toContain('total_frames');
    expect(result.stdout).toContain('jank_frames');
    expect(result.stdout).not.toContain('--require-text');
    expect(result.stdout).not.toContain('--require-skill');
  });

  it('dry-runs the all-runtime matrix without provider credential requirements', () => {
    const result = runWrapper([
      '--suite',
      'trace-fact',
      '--runtime',
      'all',
      '--dry-run',
    ]);

    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout).toContain('[quick-e2e] runtime=claude-agent-sdk');
    expect(result.stdout).toContain('[quick-e2e] runtime=openai-agents-sdk');
    expect(result.stdout).toContain('[quick-e2e] runtime=pi-agent-core');
    expect(result.stdout).toContain('[quick-e2e] runtime=opencode');
    expect(result.stdout).not.toContain('GLM_API_KEY');
    expect(result.stdout).not.toContain('OPENAI_API_KEY is required');
  });
});

describe('GLM Coding Plan E2E explicit output limit', () => {
  afterEach(() => jest.restoreAllMocks());

  it('does not impose an output cap when no explicit setting exists', () => {
    const environment = {...process.env};
    delete environment.OPENAI_MAX_OUTPUT_TOKENS;
    jest.replaceProperty(process, 'env', environment);
    const child = buildChildEnv('test-key', 'openai-agents-sdk', '/tmp/wrapper-test');
    expect(Object.prototype.hasOwnProperty.call(child, 'OPENAI_MAX_OUTPUT_TOKENS')).toBe(false);
  });

  it.each([['16384', '16384'], [' 4096 ', '4096'], ['000512', '512']])(
    'honors a validated explicit integer %s', (configured, expected) => {
      jest.replaceProperty(process, 'env', {...process.env, OPENAI_MAX_OUTPUT_TOKENS: configured});
      const child = buildChildEnv('test-key', 'openai-agents-sdk', '/tmp/wrapper-test');
      expect(child.OPENAI_MAX_OUTPUT_TOKENS).toBe(expected);
      expect(child.SMARTPERFETTO_AGENT_RUNTIME).toBe('openai-agents-sdk');
      expect(child.OPENAI_AGENTS_PROTOCOL).toBe('chat_completions');
    });

  it.each(['', ' ', '0', '-1', '1.5', '1e4', 'Infinity', 'invalid', '9007199254740992'])(
    'fails closed for an explicit invalid output limit %j', configured => {
      jest.replaceProperty(process, 'env', {...process.env, OPENAI_MAX_OUTPUT_TOKENS: configured});
      expect(() => buildChildEnv('test-key', 'openai-agents-sdk', '/tmp/wrapper-test'))
        .toThrow('OPENAI_MAX_OUTPUT_TOKENS must be a positive safe integer');
    });

  it('refuses unpinned runtime JSON and preserves GLM models without changing the main reasoning policy', () => {
    jest.replaceProperty(process, 'env', {...process.env, OPENAI_MAX_OUTPUT_TOKENS: '16384',
      SMARTPERFETTO_PI_AGENT_CORE_MODEL_JSON: '{"id":"pi-explicit"}',
      SMARTPERFETTO_OPENCODE_MODEL_JSON: '{"modelID":"opencode-explicit"}',
      GLM_MODEL: 'glm-5.3', GLM_LIGHT_MODEL: 'glm-5.3-flash'});
    expect(() => buildChildEnv('test-key', 'pi-agent-core', '/tmp/wrapper-test')).toThrow('Pi model JSON must match');
    expect(() => buildChildEnv('test-key', 'opencode', '/tmp/wrapper-test')).toThrow('OpenCode model JSON must match');
    const qoder = buildChildEnv('test-key', 'qoder-agent-sdk', '/tmp/wrapper-test');
    expect(qoder.QODER_MODEL).toBe('glm-5.3');
    expect(qoder.QODER_LIGHT_MODEL).toBe('glm-5.3-flash');
    expect(qoder.QODER_BYOK_STYLE).toBe('openai');
  });

  it.each(['glm-5.3-flash', 'glm-5.3'])('loads accurate SDK model capabilities for %s without a wrapper cap', modelId => {
    const environment: NodeJS.ProcessEnv = {...process.env, GLM_MODEL: modelId, GLM_BASE_URL: 'https://open.bigmodel.cn/api/coding/paas/v4'};
    delete environment.OPENAI_MAX_OUTPUT_TOKENS;
    delete environment.SMARTPERFETTO_PI_AGENT_CORE_MODEL_JSON;
    jest.replaceProperty(process, 'env', environment);
    const child = buildChildEnv('test-key', 'pi-agent-core', '/tmp/wrapper-test');
    const model = JSON.parse(child.SMARTPERFETTO_PI_AGENT_CORE_MODEL_JSON!);
    expect(model).toMatchObject({id: modelId, provider: 'zai-coding-cn', api: 'openai-completions',
      contextWindow: 1_000_000, maxTokens: 131_072, reasoning: true,
      baseUrl: 'https://open.bigmodel.cn/api/coding/paas/v4', apiKeyEnv: 'GLM_API_KEY',
      compat: {thinkingFormat: 'zai'},
      thinkingLevelMap: expect.any(Object)});
    expect(Object.prototype.hasOwnProperty.call(model, 'thinkingLevel')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(child, 'OPENAI_MAX_OUTPUT_TOKENS')).toBe(false);
  });

  it('refuses an unknown SDK model instead of inventing GLM capabilities', () => {
    const environment: NodeJS.ProcessEnv = {...process.env, GLM_MODEL: 'glm-unlisted-model'};
    delete environment.SMARTPERFETTO_PI_AGENT_CORE_MODEL_JSON;
    jest.replaceProperty(process, 'env', environment);
    expect(() => buildChildEnv('test-key', 'pi-agent-core', '/tmp/wrapper-test'))
      .toThrow('Unknown GLM Coding Plan model in the installed Pi SDK');
    process.env.SMARTPERFETTO_PI_AGENT_CORE_MODEL_JSON = '{"id":"glm-unlisted-model","custom":true}';
    expect(() => buildChildEnv('test-key', 'pi-agent-core', '/tmp/wrapper-test'))
      .toThrow('Unknown GLM Coding Plan model in the installed Pi SDK');
  });
});

describe('GLM Coding Plan Pi explicit thinking fence', () => {
  beforeEach(() => {
    const environment: NodeJS.ProcessEnv = {...process.env, GLM_BASE_URL: 'https://open.bigmodel.cn/api/coding/paas/v4',
      GLM_MODEL: 'glm-5.3', GLM_LIGHT_MODEL: 'glm-5.3-flash'};
    delete environment.SMARTPERFETTO_PI_AGENT_CORE_MODEL_JSON;
    delete environment.SMARTPERFETTO_OPENCODE_MODEL_JSON;
    delete environment.OPENAI_MAX_OUTPUT_TOKENS;
    jest.replaceProperty(process, 'env', environment);
  });
  afterEach(() => jest.restoreAllMocks());
  const pinned = () => JSON.parse(buildChildEnv('test-key', 'pi-agent-core', '/tmp/pi-thinking-fence').SMARTPERFETTO_PI_AGENT_CORE_MODEL_JSON!);
  const configured = (value: unknown) => {
    process.env.SMARTPERFETTO_PI_AGENT_CORE_MODEL_JSON = JSON.stringify(value);
    return buildChildEnv('test-key', 'pi-agent-core', '/tmp/pi-thinking-fence');
  };
  it('keeps the default unchanged and accepts an explicit supported low level without changing capabilities or budgets', () => {
    const model = pinned();
    expect(model).not.toHaveProperty('thinkingLevel');
    const child = configured({...model, thinkingLevel: 'low'});
    expect(JSON.parse(child.SMARTPERFETTO_PI_AGENT_CORE_MODEL_JSON!)).toEqual({...model, thinkingLevel: 'low'});
    expect(child.OPENAI_MAX_OUTPUT_TOKENS).toBeUndefined();
    expect(child.SMARTPERFETTO_PI_AGENT_CORE_REQUEST_TIMEOUT_MS).toBe(process.env.SMARTPERFETTO_PI_AGENT_CORE_REQUEST_TIMEOUT_MS);
    expect(child.AGENT_FULL_REQUEST_TIMEOUT_MS).toBe(process.env.AGENT_FULL_REQUEST_TIMEOUT_MS);
  });
  it.each(['not-a-level', 'minimal', null, 42])('rejects unsupported or malformed thinkingLevel %j', thinkingLevel => {
    expect(() => configured({...pinned(), thinkingLevel})).toThrow('Pi thinkingLevel is not supported by the installed SDK model');
  });
  it.each([
    ['baseUrl', 'https://open.bigmodel.cn/api/paas/v4'], ['baseUrl', 'https://other.example/api/coding/paas/v4'],
    ['id', 'glm-5.3-flash'], ['provider', 'zai'], ['apiKeyEnv', 'OPENAI_API_KEY'],
    ['contextWindow', 2_000_000], ['maxTokens', 2048], ['reasoning', false],
    ['compat', {thinkingFormat: 'zai', supportsReasoningEffort: false}], ['thinkingBudgets', {low: 1024}],
  ])('still refuses a %s change under an explicit supported level', (field, value) => {
    expect(() => configured({...pinned(), thinkingLevel: 'low', [field as string]: value}))
      .toThrow('Pi model JSON must match the pinned GLM Coding Plan configuration');
  });
  it('does not extend the OpenCode fence to accept thinking controls', () => {
    process.env.SMARTPERFETTO_OPENCODE_MODEL_JSON = JSON.stringify({providerID: 'zai-coding-cn', modelID: 'glm-5.3',
      baseURL: 'https://open.bigmodel.cn/api/coding/paas/v4', apiKeyEnv: 'GLM_API_KEY', smallModel: 'glm-5.3-flash', thinkingLevel: 'low'});
    expect(() => buildChildEnv('test-key', 'opencode', '/tmp/pi-thinking-fence')).toThrow('OpenCode model JSON must match');
  });
});

describe('GLM Coding Plan canonical E2E provider boundary', () => {
  const wrapper = require(path.join(backendRoot, 'scripts/run-glm-agent-e2e.cjs'));
  afterEach(() => jest.restoreAllMocks());
  it('requires GLM-specific credentials with no DeepSeek or generic OpenAI fallback', () => {
    const legacy = {DEEPSEEK_API_KEY: 'unused-deepseek-test-key', OPENAI_API_KEY: 'unused-openai-test-key'};
    for (const runtime of ['openai-agents-sdk', 'pi-agent-core', 'opencode']) {
      expect(wrapper.realProviderAvailability(runtime, legacy)).toEqual({available: false, reason: 'GLM_CODING_PLAN_API_KEY_MISSING'});
      expect(wrapper.realProviderAvailability(runtime, {...legacy, GLM_API_KEY: 'glm-test-key'}))
        .toMatchObject({available: true, credentialKind: 'GLM_API_KEY', apiKey: 'glm-test-key'});
    }
    for (const key of ['GLM_CODING_API_KEY', 'ZAI_CODING_CN_API_KEY'])
      expect(wrapper.realProviderAvailability('openai-agents-sdk', {[key]: 'glm-alias-test-key'}))
        .toMatchObject({available: true, credentialKind: key});
  });
  it.each(['https://open.bigmodel.cn/api/paas/v4', 'https://api.deepseek.com/v1',
    'http://open.bigmodel.cn/api/coding/paas/v4', 'https://other.example/api/coding/paas/v4',
    'https://user:password@open.bigmodel.cn/api/coding/paas/v4', 'https://open.bigmodel.cn/api/coding/paas/v4?key=private'])
  ('refuses generic paid and untrusted endpoint %s', baseUrl => {
    expect(() => wrapper.parseArgs(['--base-url', baseUrl])).toThrow('generic paid or other endpoints are refused');
  });
  it('supports explicit Coding Plan selection and preserves the native three-runtime matrix', () => {
    expect(wrapper.parseArgs(['--suite', 'flagship', '--strict', '--runtime', 'all-glm', '--provider', 'zai-coding-cn',
      '--base-url', 'https://open.bigmodel.cn/api/coding/paas/v4/', '--model', 'glm-5.3', '--light-model', 'glm-5.3-flash']))
      .toMatchObject({provider: 'zai-coding-cn', baseUrl: 'https://open.bigmodel.cn/api/coding/paas/v4',
        model: 'glm-5.3', lightModel: 'glm-5.3-flash', strict: true, timeoutMs: 20 * 60_000});
    expect(wrapper.resolveRuntimeKinds('all-glm')).toEqual(['openai-agents-sdk', 'pi-agent-core', 'opencode']);
    expect(() => wrapper.parseArgs(['--provider', 'deepseek'])).toThrow('requires --provider zai-coding-cn');
    expect(() => wrapper.parseArgs(['--model', 'deepseek-v4-pro'])).toThrow('requires GLM model names');
  });
  it('pins endpoint and models in the child instead of inheriting a paid-provider override', () => {
    jest.replaceProperty(process, 'env', {...process.env, GLM_MODEL: 'glm-5.3', GLM_LIGHT_MODEL: 'glm-5.3-flash',
      DEEPSEEK_API_KEY: 'must-not-reach-child', DEEPSEEK_BASE_URL: 'https://api.deepseek.com/v1',
      OPENAI_BASE_URL: 'https://api.deepseek.com/v1', OPENAI_MODEL: 'deepseek-v4-pro'});
    const env = buildChildEnv('glm-test-key', 'openai-agents-sdk', '/tmp/glm-wrapper-test');
    expect(env).toMatchObject({OPENAI_API_KEY: 'glm-test-key', OPENAI_BASE_URL: 'https://open.bigmodel.cn/api/coding/paas/v4',
      OPENAI_MODEL: 'glm-5.3', OPENAI_LIGHT_MODEL: 'glm-5.3-flash'});
    expect(env.DEEPSEEK_API_KEY).toBeUndefined();
    expect(env.DEEPSEEK_BASE_URL).toBeUndefined();
  });
  it('keeps the restored DeepSeek CLI independently discoverable without loading credentials', () => {
    const result = spawnSync(process.execPath, [path.join(backendRoot, 'scripts/run-deepseek-agent-e2e.cjs'), '--help'],
      {cwd: backendRoot, encoding: 'utf8'});
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('DeepSeek V4.1 Flash');
    expect(result.stdout).toContain('--model deepseek-flash --light-model deepseek-flash');
    expect(result.stdout).not.toContain('GLM_API_KEY');
    expect(result.stderr).toBe('');
  });
});

describe('flagship gate wrapper: file expectations, strict acceptance and regression deltas', () => {
  const wrapper = require(path.join(backendRoot, 'scripts/run-glm-agent-e2e.cjs'));
  const fingerprint = {suite: 'scrolling', runtime: 'openai-agents-sdk', traceSha256: 'a'.repeat(64), query: 'q',
    expectationHash: 'b'.repeat(64), providerOrigin: 'https://open.bigmodel.cn', model: 'glm-5.3', commit: 'c'.repeat(40),
    gateSchemaVersion: 'agent_sse_gate@3',
    traceProcessorVersion: `bundled:${'d'.repeat(40)}`, stdlibRevision: 'stdlib'};
  const report = (overrides: Record<string, unknown> = {}) => ({
    runIdentity: {schemaVersion: 1, gateSchemaVersion: 'agent_sse_gate@3',
      runtime: 'openai-agents-sdk', query: 'q', traceSha256: 'a'.repeat(64), expectationHash: 'b'.repeat(64),
      traceProcessorVersion: `bundled:${'d'.repeat(40)}`, stdlibRevision: 'stdlib', reportedVersion: 'v59'},
    semanticAcceptance: 'INCONCLUSIVE', observedChecksPassed: true, hardGatesPassed: true,
    completeAcceptance: false, uncoveredFacets: ['scrolling root cause semantics'],
    checkGroups: {value: {'fact:total_frames': true, taskCompleted: true}, delivery: {hasAnalysisCompletedEvent: true}},
    taskVerification: {facts: {total_frames: {matched: true}}},
    ...overrides,
  });
  const summary = (overrides: Record<string, unknown> = {}, at = Date.parse('2026-10-09T00:00:00Z')) =>
    wrapper.buildFlagshipSummary({suiteName: 'scrolling', runtimeKind: 'openai-agents-sdk', report: report(overrides),
      reportPath: 'test-output/e2e-glm-scrolling-real.json', exitCode: 0,
      provider: {providerOrigin: 'https://open.bigmodel.cn', model: 'glm-5.3'},
      git: {commit: 'c'.repeat(40), worktreeDirty: false}, strict: false, now: at});
  const baseline = (value: unknown) => ({status: 'ok', path: path.join(backendRoot, 'test-output/e2e-baselines/scrolling.json'),
    summary: value});

  it('runs startup and scrolling from files and keeps --strict/--delta-baseline on flagship suites only', () => {
    expect(wrapper.FLAGSHIP_EXPECTATIONS).toEqual({startup: 'tests/e2e/flagship/startup-heavy.expectation.json',
      scrolling: 'tests/e2e/flagship/scrolling-customer.expectation.json'});
    for (const suite of ['startup', 'scrolling']) {
      const args: string[] = wrapper.suites[suite].args;
      const value = args[args.indexOf('--expectation-json') + 1];
      expect(value).toBe(`@${wrapper.FLAGSHIP_EXPECTATIONS[suite]}`);
      // verifyCodeAwareSemanticDelta.test.ts parses these through the closed verifier schema.
      expect(JSON.parse(fs.readFileSync(path.join(backendRoot, value.slice(1)), 'utf8')).schemaVersion).toBe(1);
      expect(args).not.toContain('--strict');
    }
    expect(wrapper.parseArgs(['--suite', 'flagship'])).toMatchObject({suite: 'flagship', strict: false});
    expect(wrapper.parseArgs(['--suite', 'flagship', '--strict', '--delta-baseline', 'test-output/e2e-baselines']))
      .toMatchObject({strict: true, deltaBaseline: path.join(backendRoot, 'test-output/e2e-baselines')});
    expect(() => wrapper.parseArgs(['--suite', 'context', '--strict'])).toThrow('--strict and --delta-baseline');
    expect(() => wrapper.parseArgs(['--suite', 'scrolling', '--delta-baseline'])).toThrow('--delta-baseline requires');
    const scripts = JSON.parse(fs.readFileSync(path.join(backendRoot, 'package.json'), 'utf8')).scripts;
    expect(scripts['verify:e2e:glm-flagship']).toBe('node scripts/run-glm-agent-e2e.cjs --suite flagship --runtime all-glm');
    expect(scripts['verify:e2e:glm-flagship:strict']).toBe(`${scripts['verify:e2e:glm-flagship']} --strict`);
    for (const name of ['verify:e2e:glm-startup', 'verify:e2e:glm-scrolling', 'verify:e2e:glm']) {
      expect(scripts[name]).not.toContain('--strict');
    }
  });

  it('records the provider by origin and model only', () => {
    expect(wrapper.providerFingerprint('openai-agents-sdk', {OPENAI_BASE_URL: 'https://user:secret@open.bigmodel.cn/api/coding/paas/v4?key=x',
      OPENAI_MODEL: 'glm-5.3'})).toEqual({providerOrigin: 'https://open.bigmodel.cn', model: 'glm-5.3'});
    expect(wrapper.providerFingerprint('claude-agent-sdk', {})).toEqual({providerOrigin: 'anthropic-default', model: 'claude-runtime-default'});
    expect(wrapper.providerFingerprint('qoder-agent-sdk', {QODER_BYOK_BASE_URL: 'not a url', QODER_MODEL: 'm'}))
      .toEqual({providerOrigin: 'invalid-base-url', model: 'm'});
    // Pi and OpenCode read their model JSON, not the OpenAI env, so their provider is not 'openai-default'.
    expect(wrapper.providerFingerprint('pi-agent-core', {SMARTPERFETTO_PI_AGENT_CORE_MODEL_JSON: JSON.stringify({
      id: 'glm-5.3', baseUrl: 'https://open.bigmodel.cn/api/coding/paas/v4', apiKeyEnv: 'GLM_API_KEY'})}))
      .toEqual({providerOrigin: 'https://open.bigmodel.cn', model: 'glm-5.3'});
    expect(wrapper.providerFingerprint('opencode', {SMARTPERFETTO_OPENCODE_MODEL_JSON: JSON.stringify({
      providerID: 'zai-coding-cn', modelID: 'glm-5.3', baseURL: 'https://open.bigmodel.cn/api/coding/paas/v4'})}))
      .toEqual({providerOrigin: 'https://open.bigmodel.cn', model: 'glm-5.3'});
    expect(wrapper.providerFingerprint('opencode', {SMARTPERFETTO_OPENCODE_MODEL_JSON: 'not json'}))
      .toEqual({providerOrigin: 'opencode-default', model: 'opencode-runtime-default'});
  });

  it('summarizes a run with its full fingerprint and per-fact body matches', () => {
    const current = summary();
    expect(current).toMatchObject({schemaVersion: 'agent_sse_flagship_summary@2', fingerprint, reportAvailable: true,
      semanticAcceptance: 'INCONCLUSIVE', facts: {total_frames: 'matched'}, traceProcessorReportedVersion: 'v59',
      report: 'test-output/e2e-glm-scrolling-real.json'});
    expect(Object.keys(current.fingerprint)).toEqual(wrapper.FLAGSHIP_FINGERPRINT_KEYS);
  });

  it('refuses a missing, corrupt, incomplete or differently fingerprinted baseline instead of reporting no change', () => {
    const current = summary();
    expect(wrapper.compareFlagshipSummaries({status: 'missing'}, current)).toEqual({status: 'refused', reason: 'baseline_missing'});
    expect(wrapper.compareFlagshipSummaries({status: 'corrupt'}, current)).toEqual({status: 'refused', reason: 'baseline_corrupt'});
    expect(wrapper.compareFlagshipSummaries(baseline({...current, checkGroups: null}), current).reason).toBe('baseline_corrupt');
    for (const [key, value] of [['model', 'glm-5.3-flash'], ['traceSha256', 'e'.repeat(64)], ['expectationHash', 'f'.repeat(64)],
      ['stdlibRevision', 'other'], ['traceProcessorVersion', `custom:${'0'.repeat(64)}`], ['gateSchemaVersion', 'agent_sse_gate@1']]) {
      const changed = {...current, fingerprint: {...current.fingerprint, [key]: value}};
      expect(wrapper.compareFlagshipSummaries(baseline(changed), current)).toEqual({status: 'refused', reason: 'fingerprint_mismatch',
        mismatchedKeys: [key]});
    }
    const unknownProcessor = summary({runIdentity: {...report().runIdentity, traceProcessorVersion: 'unknown:external_rpc_binary_unavailable'}});
    expect(wrapper.compareFlagshipSummaries(baseline(unknownProcessor), unknownProcessor)).toMatchObject({status: 'refused',
      reason: 'fingerprint_incomplete', incompleteKeys: {baseline: ['traceProcessorVersion'], current: ['traceProcessorVersion']}});
    expect(wrapper.flagshipRunVerdict({...current, delta: {status: 'refused', reason: 'baseline_missing'}}))
      .toEqual({passed: false, reasons: ['delta_refused:baseline_missing']});
  });

  it('reports new failures, fixes and unchanged checks across commits and fails only on new failures', () => {
    const before = summary({checkGroups: {value: {'fact:total_frames': true, taskCompleted: false, nonPartial: true},
      delivery: {hasAnalysisCompletedEvent: true}}, taskVerification: {facts: {total_frames: {matched: true}}}},
    Date.parse('2026-10-01T00:00:00Z'));
    const current = {...summary({checkGroups: {value: {'fact:total_frames': false, taskCompleted: true, nonPartial: true,
      'fact:jank_frames': true}, delivery: {}}, taskVerification: {facts: {total_frames: {matched: false}}}}),
    fingerprint: {...fingerprint, commit: '9'.repeat(40)}};
    const delta = wrapper.compareFlagshipSummaries(baseline(before), current, {now: Date.parse('2026-10-09T00:00:00Z')});
    expect(delta).toMatchObject({status: 'compared', evidence: 'regression_delta_only_not_acceptance', stale: false,
      commits: {baseline: 'c'.repeat(40), current: '9'.repeat(40)},
      newFailures: ['value:fact:total_frames'], fixed: ['value:taskCompleted'], unchanged: ['value:nonPartial'],
      added: ['value:fact:jank_frames'], removed: ['delivery:hasAnalysisCompletedEvent'],
      factChanges: {total_frames: {from: 'matched', to: 'none'}}});
    expect(wrapper.flagshipRunVerdict({...current, exitCode: 1, delta}))
      .toEqual({passed: false, reasons: ['delta_new_failures:1']});
    const steady = wrapper.compareFlagshipSummaries(baseline(before), before, {now: Date.parse('2026-11-01T00:00:00Z')});
    expect(steady).toMatchObject({status: 'compared', newFailures: [], stale: true});
    // A known failure that did not regress is not a delta failure; it is still not acceptance.
    expect(wrapper.flagshipRunVerdict({...before, exitCode: 1, delta: steady})).toEqual({passed: true, reasons: []});
  });

  it('fails --strict on anything short of complete acceptance and diagnostic runs on the verifier exit', () => {
    const inconclusive = summary();
    expect(wrapper.flagshipRunVerdict({...inconclusive, strict: true})).toEqual({passed: false,
      reasons: ['strict_acceptance_INCONCLUSIVE']});
    expect(wrapper.flagshipRunVerdict({...inconclusive, strict: true, completeAcceptance: true, semanticAcceptance: 'PASSED'}))
      .toEqual({passed: true, reasons: []});
    expect(wrapper.flagshipRunVerdict(inconclusive)).toEqual({passed: true, reasons: []});
    expect(wrapper.flagshipRunVerdict({...inconclusive, exitCode: 1})).toEqual({passed: false, reasons: ['verifier_exit_1']});
    const missing = wrapper.buildFlagshipSummary({suiteName: 'startup', runtimeKind: 'opencode', report: undefined, exitCode: 1,
      git: {commit: 'unknown', worktreeDirty: null}, strict: false});
    expect(missing).toMatchObject({reportAvailable: false, semanticAcceptance: 'FAILED', checkGroups: null});
    expect(wrapper.flagshipRunVerdict(missing).reasons).toEqual(['report_unavailable', 'verifier_exit_1']);
    // A timed-out run's failure artifact says INCONCLUSIVE for older readers; undelivered is FAILED here.
    const timedOut = wrapper.buildFlagshipSummary({suiteName: 'startup', runtimeKind: 'opencode', exitCode: 1,
      report: {schemaVersion: 'agent_sse_verification_failure@1', phase: 'analysis_stream', errorCode: 'SSE_TIMEOUT',
        semanticAcceptance: 'INCONCLUSIVE', passed: false}, git: {commit: 'unknown', worktreeDirty: null}, strict: false});
    expect(timedOut).toMatchObject({reportAvailable: false, semanticAcceptance: 'FAILED',
      verificationFailure: {phase: 'analysis_stream', errorCode: 'SSE_TIMEOUT'}});
    expect(missing).not.toHaveProperty('verificationFailure');
  });

  it('reads a baseline file or the matching file in a baseline directory', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'flagship-baseline-'));
    try {
      fs.writeFileSync(path.join(directory, 'scrolling-pi-agent-core.json'), JSON.stringify({schemaVersion: 'x'}));
      fs.writeFileSync(path.join(directory, 'broken.json'), '{');
      expect(wrapper.readFlagshipBaseline(directory, 'scrolling-pi-agent-core.json')).toMatchObject({status: 'ok', summary: {schemaVersion: 'x'}});
      expect(wrapper.readFlagshipBaseline(directory, 'startup.json').status).toBe('missing');
      expect(wrapper.readFlagshipBaseline(path.join(directory, 'broken.json'), 'ignored.json').status).toBe('corrupt');
      expect(wrapper.readFlagshipBaseline(path.join(directory, 'absent.json'), 'x.json').status).toBe('missing');
    } finally {
      fs.rmSync(directory, {recursive: true, force: true});
    }
  });
});

describe('GLM configured suite output isolation', () => {
  let directory: string;
  let previousExitCode: string | number | null | undefined;
  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'glm-output-isolation-'));
    previousExitCode = process.exitCode;
    const env: NodeJS.ProcessEnv = {...process.env, GLM_API_KEY: 'glm-harness-fixture-key',
      GLM_BASE_URL: 'https://open.bigmodel.cn/api/coding/paas/v4', GLM_MODEL: 'glm-5.3-flash', GLM_LIGHT_MODEL: 'glm-5.3-flash'};
    delete env.SMARTPERFETTO_PI_AGENT_CORE_MODEL_JSON;
    delete env.SMARTPERFETTO_OPENCODE_MODEL_JSON;
    jest.replaceProperty(process, 'env', env);
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    process.exitCode = previousExitCode;
    jest.dontMock('child_process'); jest.restoreAllMocks();
    fs.rmSync(directory, {recursive: true, force: true});
  });

  function mocked(run: (wrapper: any, calls: Array<{args: string[]; env: NodeJS.ProcessEnv}>) => void,
    options: {fail?: boolean; writeReports?: boolean; logs?: boolean} = {}) {
    const calls: Array<{args: string[]; env: NodeJS.ProcessEnv}> = [];
    const spawn = jest.fn((command: string, args: string[], child: any) => {
      if (command === 'git') return {status: 0, stdout: args[0] === 'rev-parse' ? 'a'.repeat(40) : ''};
      if (args[0] === '--input-type=module') return {status: 0, stdout: JSON.stringify({
        model: {id: 'glm-5.3-flash', provider: 'zai-coding-cn', contextWindow: 100_000, maxTokens: 8192},
        supportedThinkingLevels: ['off', 'low'],
      })};
      expect(args[1]).toBe(path.join(backendRoot, 'src/scripts/verifyAgentSseScrolling.ts'));
      calls.push({args: [...args], env: {...child.env}});
      const output = args[args.indexOf('--output') + 1];
      if (options.writeReports) {
        fs.mkdirSync(path.dirname(output), {recursive: true});
        fs.writeFileSync(output, JSON.stringify({checkGroups: {}, semanticAcceptance: 'INCONCLUSIVE'}));
        fs.writeFileSync(`${output}.diagnostics.json`, '{}');
      }
      if (options.logs) {
        const logs = path.join(child.env.SMARTPERFETTO_BACKEND_LOG_DIR, 'sessions');
        fs.mkdirSync(logs, {recursive: true});
        fs.writeFileSync(path.join(logs, 'session_fixture.jsonl'), JSON.stringify({message: 'fixture_failure', apiKey: 'never-export-this'}));
      }
      return {status: options.fail ? 1 : 0};
    });
    jest.doMock('child_process', () => ({...jest.requireActual('child_process'), spawnSync: spawn}));
    jest.isolateModules(() => run(require(path.join(backendRoot, 'scripts/run-glm-agent-e2e.cjs')), calls));
  }
  const flashArgs = ['--model', 'glm-5.3-flash', '--light-model', 'glm-5.3-flash'];

  it.each(['startup', 'context', 'system-analysis'])('routes actual %s child outputs to the explicit directory with Flash pins', suite => {
    mocked((wrapper, calls) => {
      const originals = JSON.stringify(wrapper.suites);
      const scenarios = JSON.stringify(wrapper.systemAnalysisScenarios());
      const args = ['--suite', suite, '--runtime', 'all-glm', '--output-dir', directory, ...flashArgs,
        ...(suite === 'system-analysis' ? ['--system-scenario', 'scheduler-constructed'] : [])];
      const parsed = wrapper.parseArgs(args);
      expect(parsed.outputDirExplicit).toBe(true);
      wrapper.runConfiguredSuites(parsed);
      expect(calls).toHaveLength(suite === 'context' ? 9 : 3);
      const outputs = calls.map(call => {
        expect(call.args.filter(arg => arg === '--output')).toHaveLength(1);
        const output = call.args[call.args.indexOf('--output') + 1];
        expect(path.dirname(output)).toBe(directory);
        expect(output).toContain(call.env.SMARTPERFETTO_AGENT_RUNTIME);
        expect(call.env).toMatchObject({OPENAI_MODEL: 'glm-5.3-flash', OPENAI_LIGHT_MODEL: 'glm-5.3-flash',
          OPENAI_BASE_URL: 'https://open.bigmodel.cn/api/coding/paas/v4'});
        if (call.env.SMARTPERFETTO_OPENCODE_MODEL_JSON) expect(JSON.parse(call.env.SMARTPERFETTO_OPENCODE_MODEL_JSON))
          .toMatchObject({modelID: 'glm-5.3-flash', smallModel: 'glm-5.3-flash', baseURL: 'https://open.bigmodel.cn/api/coding/paas/v4'});
        if (call.env.SMARTPERFETTO_PI_AGENT_CORE_MODEL_JSON) expect(JSON.parse(call.env.SMARTPERFETTO_PI_AGENT_CORE_MODEL_JSON))
          .toMatchObject({id: 'glm-5.3-flash', baseUrl: 'https://open.bigmodel.cn/api/coding/paas/v4'});
        return output;
      });
      expect(new Set(outputs).size).toBe(outputs.length);
      expect(JSON.stringify(wrapper.suites)).toBe(originals);
      expect(JSON.stringify(wrapper.systemAnalysisScenarios())).toBe(scenarios);
    });
  });

  it('keeps omitted output-dir defaults', () => {
    mocked((wrapper, calls) => {
      const defaults = wrapper.parseArgs(['--suite', 'startup', ...flashArgs]);
      expect(defaults.outputDirExplicit).toBe(false);
      wrapper.runConfiguredSuites(defaults);
      expect(calls[0].args[calls[0].args.indexOf('--output') + 1]).toBe(wrapper.suites.startup.output);
    });
  });

  it('does not overwrite a default sentinel when an explicit directory is requested', () => {
    mocked((wrapper, calls) => {
      const defaultFile = path.resolve(backendRoot, wrapper.suites.startup.output);
      const previous = fs.existsSync(defaultFile) ? fs.readFileSync(defaultFile) : undefined;
      fs.mkdirSync(path.dirname(defaultFile), {recursive: true});
      fs.writeFileSync(defaultFile, 'default-sentinel');
      try {
        wrapper.runConfiguredSuites(wrapper.parseArgs(['--suite', 'startup', '--output-dir', directory, ...flashArgs]));
        expect(fs.readFileSync(defaultFile, 'utf8')).toBe('default-sentinel');
        const output = calls[0].args[calls[0].args.indexOf('--output') + 1];
        expect(path.dirname(output)).toBe(directory);
        expect(fs.existsSync(output)).toBe(true);
      } finally {if (previous) fs.writeFileSync(defaultFile, previous); else fs.unlinkSync(defaultFile);}
    }, {writeReports: true});
  });

  it('writes flagship summaries and verifier diagnostics under the explicit directory', () => {
    mocked((wrapper, calls) => {
      wrapper.runConfiguredSuites(wrapper.parseArgs(['--suite', 'flagship', '--runtime', 'all-glm', '--output-dir', directory, ...flashArgs]));
      expect(calls).toHaveLength(6);
      for (const call of calls) {
        const output = call.args[call.args.indexOf('--output') + 1];
        expect(fs.existsSync(`${output}.diagnostics.json`)).toBe(true);
        expect(path.dirname(output)).toBe(directory);
      }
      for (const suite of ['startup', 'scrolling']) for (const runtime of wrapper.resolveRuntimeKinds('all-glm')) {
        const summary = JSON.parse(fs.readFileSync(path.join(directory, `${suite}-${runtime}.json`), 'utf8'));
        expect(summary.fingerprint.model).toBe('glm-5.3-flash');
        expect(path.resolve(backendRoot, summary.report).startsWith(directory + path.sep)).toBe(true);
      }
    }, {writeReports: true});
  });

  it('preserves failure logs next to the relocated output even when the child exits nonzero', () => {
    mocked((wrapper, calls) => {
      expect(() => wrapper.runConfiguredSuites(wrapper.parseArgs(['--suite', 'startup', '--output-dir', directory, ...flashArgs])))
        .toThrow('exited with status 1');
      const output = calls[0].args[calls[0].args.indexOf('--output') + 1];
      const log = fs.readFileSync(`${output}.isolated-session-log.jsonl`, 'utf8');
      expect(path.dirname(output)).toBe(directory); expect(log).toContain('fixture_failure');
      expect(fs.existsSync(`${output}.diagnostics.json`)).toBe(true);
      expect(log).not.toContain('never-export-this');
      expect(fs.existsSync(path.dirname(calls[0].env.SMARTPERFETTO_BACKEND_LOG_DIR!))).toBe(false);
    }, {fail: true, logs: true, writeReports: true});
  });

  it('rewrites duplicate output switches to one without mutating an explicit scenario', () => {
    mocked((wrapper, calls) => {
      const scenario = {label: 'fixture', output: 'test-output/scenario.json',
        args: Object.freeze(['--output', 'old.json', '--query', 'q', '--output', 'duplicate.json'])};
      wrapper.runSuite('system-analysis', {apiKey: 'fixture', credentialKind: 'test'}, 'opencode', true, 123,
        scenario, {outputDir: directory});
      expect(calls[0].args.filter(arg => arg === '--output')).toHaveLength(1);
      expect(calls[0].args[calls[0].args.indexOf('--output') + 1]).toBe(path.join(directory, 'scenario-opencode.json'));
      expect(scenario.args).toEqual(['--output', 'old.json', '--query', 'q', '--output', 'duplicate.json']);
      expect(calls[0].args).toContain('--query'); expect(calls[0].args).toContain('q');
    });
  });
});

describe('DeepSeek Flash provider-bound E2E harness', () => {
  const deepseekPath = path.join(backendRoot, 'scripts/run-deepseek-agent-e2e.cjs');
  const glmPath = path.join(backendRoot, 'scripts/run-glm-agent-e2e.cjs');
  const wrapper = require(deepseekPath);
  let directory: string;
  let previousExitCode: typeof process.exitCode;

  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'provider-e2e-isolation-'));
    previousExitCode = process.exitCode;
    const env: NodeJS.ProcessEnv = {...process.env, DEEPSEEK_API_KEY: 'deepseek-fixture-key',
      GLM_API_KEY: 'glm-fixture-key', GLM_MODEL: 'glm-5.3', GLM_LIGHT_MODEL: 'glm-5.3-flash'};
    for (const key of ['DEEPSEEK_MODEL', 'DEEPSEEK_LIGHT_MODEL', 'DEEPSEEK_BASE_URL',
      'SMARTPERFETTO_PI_AGENT_CORE_MODEL_JSON', 'SMARTPERFETTO_OPENCODE_MODEL_JSON']) delete env[key];
    jest.replaceProperty(process, 'env', env);
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    process.exitCode = previousExitCode;
    jest.dontMock('child_process'); jest.restoreAllMocks();
    fs.rmSync(directory, {recursive: true, force: true});
  });

  it('pins both models to the official Flash ID and keeps the same task/oracle suite', () => {
    const parsed = wrapper.parseArgs(['--suite', 'system-analysis', '--runtime', 'all-deepseek',
      '--system-scenario', 'scheduler-constructed', '--base-url', 'https://api.deepseek.com/']);
    expect(parsed).toMatchObject({provider: 'deepseek', baseUrl: 'https://api.deepseek.com/v1',
      model: 'deepseek-flash', lightModel: 'deepseek-flash', timeoutMs: 20 * 60_000});
    expect(wrapper.resolveRuntimeKinds(parsed.runtime)).toEqual(['openai-agents-sdk', 'pi-agent-core', 'opencode']);
    const glm = require(glmPath);
    expect(wrapper.FLAGSHIP_EXPECTATIONS).toEqual(glm.FLAGSHIP_EXPECTATIONS);
    expect(wrapper.frameFactExpectation()).toEqual(glm.frameFactExpectation());
    const selected = (harness: any) => harness.systemAnalysisScenarios().map((scenario: any) => ({
      id: scenario.id, trace: scenario.args[scenario.args.indexOf('--trace') + 1],
      query: scenario.args[scenario.args.indexOf('--query') + 1],
      expectation: scenario.args[scenario.args.indexOf('--expectation-json') + 1],
    }));
    expect(selected(wrapper)).toEqual(selected(glm));
    expect(wrapper.suites.startup.output).not.toBe(glm.suites.startup.output);
    expect(wrapper.systemAnalysisScenarios()[0].output).not.toBe(glm.systemAnalysisScenarios()[0].output);
  });

  it.each(['http://api.deepseek.com/v1', 'https://api.deepseek.com:8443/v1',
    'https://api.deepseek.com.evil.test/v1', 'https://api.deepseek.com/anthropic',
    'https://user:secret@api.deepseek.com/v1', 'https://api.deepseek.com/v1?key=secret',
    'https://open.bigmodel.cn/api/coding/paas/v4'])(
    'refuses a non-pinned endpoint without echoing its credentials: %s', baseUrl => {
      expect(() => wrapper.parseArgs(['--base-url', baseUrl])).toThrow('other endpoints and URL credentials are refused');
      try {wrapper.parseArgs(['--base-url', baseUrl]);} catch (error) {
        expect(String(error)).not.toContain('secret');
      }
    });

  it('rejects another provider, runtime group, Pro or a legacy model alias', () => {
    expect(() => wrapper.parseArgs(['--provider', 'zai-coding-cn'])).toThrow('requires --provider deepseek');
    expect(() => wrapper.parseArgs(['--runtime', 'all-glm'])).toThrow('Invalid runtime');
    for (const model of ['deepseek-v4-pro', 'deepseek-v4-flash', 'glm-5.3-flash']) {
      expect(() => wrapper.parseArgs(['--model', model])).toThrow('requires --model deepseek-flash');
      expect(() => wrapper.parseArgs(['--light-model', model])).toThrow('requires --model deepseek-flash');
    }
  });

  it('never uses GLM, generic OpenAI or Anthropic credentials for DeepSeek', () => {
    for (const runtime of ['openai-agents-sdk', 'pi-agent-core', 'opencode', 'claude-agent-sdk']) {
      expect(wrapper.realProviderAvailability(runtime, {GLM_API_KEY: 'other-key',
        OPENAI_API_KEY: 'other-key', ANTHROPIC_API_KEY: 'other-key'}))
        .toEqual({available: false, reason: 'DEEPSEEK_API_KEY_MISSING'});
    }
    expect(wrapper.realProviderAvailability('openai-agents-sdk', {DEEPSEEK_API_KEY: 'own-key'}))
      .toEqual({available: true, credentialKind: 'DEEPSEEK_API_KEY', apiKey: 'own-key'});
    expect(wrapper.realProviderAvailability('qoder-agent-sdk', {DEEPSEEK_API_KEY: 'own-key'}))
      .toEqual({available: false, reason: 'QODER_PERSONAL_ACCESS_TOKEN_OR_QODERCLI_PATH_MISSING'});
  });

  it('isolates child connection credentials while retaining explicit runtime budgets', () => {
    Object.assign(process.env, {GLM_CODING_API_KEY: 'foreign-glm', ZAI_CODING_CN_API_KEY: 'foreign-zai',
      ANTHROPIC_AUTH_TOKEN: 'foreign-anthropic', CLAUDE_CODE_OAUTH_TOKEN: 'foreign-oauth',
      OPENAI_API_KEY: 'foreign-openai', OPENAI_BASE_URL: 'https://foreign.test/v1', OPENAI_MODEL: 'foreign-model',
      QODER_BYOK_API_KEY: 'foreign-qoder', OPENAI_MAX_OUTPUT_TOKENS: '4096', OPENAI_FULL_PER_TURN_MS: '60000'});
    for (const runtime of ['openai-agents-sdk', 'opencode', 'claude-agent-sdk', 'qoder-agent-sdk']) {
      const child = wrapper.buildChildEnv('own-key', runtime, directory);
      expect(child).toMatchObject({DEEPSEEK_API_KEY: 'own-key', OPENAI_API_KEY: 'own-key',
        OPENAI_BASE_URL: 'https://api.deepseek.com/v1', OPENAI_MODEL: 'deepseek-flash', OPENAI_LIGHT_MODEL: 'deepseek-flash',
        OPENAI_MAX_OUTPUT_TOKENS: '4096', OPENAI_FULL_PER_TURN_MS: '60000'});
      expect(JSON.stringify(child)).not.toMatch(/foreign-(glm|zai|anthropic|oauth|openai|model|qoder)/);
      expect(child.GLM_API_KEY).toBeUndefined();
      expect(child.GLM_MODEL).toBeUndefined();
      expect(child.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
      if (runtime === 'claude-agent-sdk') expect(child).toMatchObject({ANTHROPIC_BASE_URL: 'https://api.deepseek.com/anthropic',
        ANTHROPIC_AUTH_TOKEN: 'own-key', CLAUDE_MODEL: 'deepseek-flash', CLAUDE_LIGHT_MODEL: 'deepseek-flash'});
      if (runtime === 'opencode') expect(JSON.parse(child.SMARTPERFETTO_OPENCODE_MODEL_JSON)).toEqual({
        providerID: 'deepseek', modelID: 'deepseek-flash', baseURL: 'https://api.deepseek.com/v1',
        apiKeyEnv: 'DEEPSEEK_API_KEY', smallModel: 'deepseek-flash'});
      if (runtime === 'qoder-agent-sdk') expect(child).toMatchObject({QODER_BYOK_PROVIDER: 'deepseek',
        QODER_BYOK_API_KEY: 'own-key', QODER_MODEL: 'deepseek-flash', QODER_LIGHT_MODEL: 'deepseek-flash'});
      expect(wrapper.providerFingerprint(runtime, child)).toEqual({providerOrigin: 'https://api.deepseek.com', model: 'deepseek-flash'});
    }
  });

  it('passes a Qoder PAT only to the selected Qoder runtime across both provider entries', () => {
    process.env.QODER_PERSONAL_ACCESS_TOKEN = 'qoder-native-fixture-token';
    for (const harness of [wrapper, require(glmPath)]) {
      for (const runtime of ['openai-agents-sdk', 'opencode', 'claude-agent-sdk']) {
        const child = harness.buildSemanticChildEnv(runtime, {apiKey: 'own-key'}, directory);
        expect(Object.prototype.hasOwnProperty.call(child, 'QODER_PERSONAL_ACCESS_TOKEN')).toBe(false);
      }
      expect(harness.buildSemanticChildEnv('qoder-agent-sdk', {apiKey: 'own-key'}, directory)
        .QODER_PERSONAL_ACCESS_TOKEN).toBe('qoder-native-fixture-token');
    }
  });

  it('reports missing installed Pi model metadata without substituting an older Flash ID or dispatching', () => {
    const spawn = jest.fn((_command: string, args: string[]) => {
      expect(args[0]).toBe('--input-type=module');
      expect(args[args.length - 1]).toBe('deepseek-flash');
      return {status: 2};
    });
    jest.doMock('child_process', () => ({...jest.requireActual('child_process'), spawnSync: spawn}));
    jest.isolateModules(() => {
      const isolated = require(deepseekPath);
      expect(isolated.realProviderAvailability('pi-agent-core', {DEEPSEEK_API_KEY: 'own-key'}))
        .toEqual({available: false, reason: 'UNSUPPORTED_INSTALLED_MODEL_METADATA'});
      expect(() => isolated.buildChildEnv('own-key', 'pi-agent-core', directory)).toThrow('Unknown DeepSeek V4.1 Flash model');
    });
    expect(spawn).toHaveBeenCalledTimes(2);
  });

  it('dispatches both provider instances with their own explicit pins without changing process environment', () => {
    const before = {...process.env};
    const calls: Array<{args: string[]; env: NodeJS.ProcessEnv}> = [];
    const spawn = jest.fn((_command: string, args: string[], options: any) => {
      expect(args[1]).toBe(path.join(backendRoot, 'src/scripts/verifyAgentSseScrolling.ts'));
      calls.push({args, env: options.env});
      return {status: 0};
    });
    jest.doMock('child_process', () => ({...jest.requireActual('child_process'), spawnSync: spawn}));
    jest.isolateModules(() => {
      const glm = require(glmPath), deepseek = require(deepseekPath);
      glm.runConfiguredSuites(glm.parseArgs(['--suite', 'startup', '--model', 'glm-5.3-flash',
        '--light-model', 'glm-5.3-flash', '--output-dir', directory]));
      deepseek.runConfiguredSuites(deepseek.parseArgs(['--suite', 'startup', '--output-dir', directory]));
      expect(glm.providerConfiguration().model).toBe('glm-5.3');
    });
    expect(process.env).toEqual(before);
    expect(calls).toHaveLength(2);
    expect(calls[0].env).toMatchObject({OPENAI_API_KEY: 'glm-fixture-key', OPENAI_MODEL: 'glm-5.3-flash',
      OPENAI_BASE_URL: 'https://open.bigmodel.cn/api/coding/paas/v4'});
    expect(calls[0].env.DEEPSEEK_API_KEY).toBeUndefined();
    expect(calls[1].env).toMatchObject({OPENAI_API_KEY: 'deepseek-fixture-key', OPENAI_MODEL: 'deepseek-flash',
      OPENAI_BASE_URL: 'https://api.deepseek.com/v1'});
    expect(calls[1].env.GLM_API_KEY).toBeUndefined();
    expect(calls[0].env.SMARTPERFETTO_BACKEND_DATA_DIR).not.toBe(calls[1].env.SMARTPERFETTO_BACKEND_DATA_DIR);
    expect(calls[0].args[calls[0].args.indexOf('--output') + 1]).not.toBe(calls[1].args[calls[1].args.indexOf('--output') + 1]);
  });

  it('refuses a reused explicit output before starting the verifier and preserves the prior report', () => {
    const report = path.join(directory, path.basename(wrapper.suites.startup.output));
    fs.writeFileSync(report, 'prior-report');
    const spawn = jest.fn();
    jest.doMock('child_process', () => ({...jest.requireActual('child_process'), spawnSync: spawn}));
    jest.isolateModules(() => {
      const isolated = require(deepseekPath);
      expect(() => isolated.runConfiguredSuites(isolated.parseArgs(['--suite', 'startup', '--output-dir', directory])))
        .toThrow('select a fresh --output-dir');
    });
    expect(spawn).not.toHaveBeenCalled();
    expect(fs.readFileSync(report, 'utf8')).toBe('prior-report');
  });

  it('protects an explicit flagship summary before any model dispatch', () => {
    const summary = path.join(directory, 'startup.json');
    fs.writeFileSync(summary, 'prior-summary');
    const spawn = jest.fn((command: string, args: string[]) => {
      if (command === 'git') return {status: 0, stdout: args[0] === 'rev-parse' ? 'a'.repeat(40) : ''};
      throw new Error('Verifier must not start');
    });
    jest.doMock('child_process', () => ({...jest.requireActual('child_process'), spawnSync: spawn}));
    jest.isolateModules(() => {
      const isolated = require(deepseekPath);
      expect(() => isolated.runConfiguredSuites(isolated.parseArgs(['--suite', 'flagship', '--output-dir', directory])))
        .toThrow('select a fresh --output-dir');
    });
    expect(spawn.mock.calls.every(([command]) => command === 'git')).toBe(true);
    expect(fs.readFileSync(summary, 'utf8')).toBe('prior-summary');
  });

  it('redacts a credential before diagnostic truncation can expose its prefix', () => {
    const credential = process.env.DEEPSEEK_API_KEY!;
    const spawn = jest.fn(() => ({status: 1, stderr: 'x'.repeat(990) + credential, stdout: ''}));
    jest.doMock('child_process', () => ({...jest.requireActual('child_process'), spawnSync: spawn}));
    jest.isolateModules(() => {
      const isolated = require(deepseekPath);
      const result = isolated.runSemanticPreflight({runtime: 'openai-agents-sdk', queryId: 'quantitative-only',
        condition: 'A0', outputDir: directory, timeoutMs: 1000});
      expect(result.preflightPassed).toBe(false);
      expect(result.record.diagnostic.length).toBeLessThanOrEqual(1000);
      expect(result.record.diagnostic).not.toContain(credential.slice(0, 8));
      expect(JSON.stringify(result)).not.toContain(credential);
    });
  });


  it.each([
    ['preflight report', true, 'openai-agents-sdk/preflight/quantitative-only/A0.json'],
    ['preflight summary', true, 'openai-agents-sdk/preflight/quantitative-only/A0.preflight.json'],
    ['preflight diagnostic', true, 'openai-agents-sdk/preflight/quantitative-only/A0.json.diagnostics.json'],
    ['late repeated report', false, 'openai-agents-sdk/run-05/explicit-source-location/A3.json'],
    ['late repeated diagnostic', false, 'openai-agents-sdk/run-05/explicit-source-location/A3.json.diagnostics.json'],
    ['paired summary', false, 'openai-agents-sdk/paired-run-05.json'],
    ['aggregate summary', false, 'aggregate.json'],
  ] as const)('rejects existing source %s before any provider dispatch', (_label, preflight, relative) => {
    const output = path.join(directory, relative);
    fs.mkdirSync(path.dirname(output), {recursive: true});
    fs.writeFileSync(output, 'prior-source-evidence');
    const spawn = jest.fn(() => {throw new Error('Verifier must not start');});
    jest.doMock('child_process', () => ({...jest.requireActual('child_process'), spawnSync: spawn}));
    jest.isolateModules(() => {
      for (const harnessPath of [glmPath, deepseekPath]) {
        const isolated = require(harnessPath);
        const args = ['--suite', 'code-aware-semantic-delta', '--runtime', 'openai', '--output-dir', directory,
          ...(preflight ? ['--preflight', '--query-id', 'quantitative-only', '--condition', 'A0'] : ['--repeat', '5'])];
        expect(() => isolated.runConfiguredSuites(isolated.parseArgs(args))).toThrow('select a fresh --output-dir');
      }
    });
    expect(spawn).not.toHaveBeenCalled();
    expect(fs.readFileSync(output, 'utf8')).toBe('prior-source-evidence');
  });

  it('refuses cross-provider reuse of a source output directory without reading the old result as a new run', () => {
    const spawn = jest.fn(() => ({status: 1, stderr: 'fixture failure', stdout: ''}));
    jest.doMock('child_process', () => ({...jest.requireActual('child_process'), spawnSync: spawn}));
    jest.isolateModules(() => {
      const glm = require(glmPath), deepseek = require(deepseekPath);
      glm.runConfiguredSuites(glm.parseArgs(['--suite', 'code-aware-semantic-delta', '--runtime', 'openai',
        '--preflight', '--query-id', 'quantitative-only', '--condition', 'A0', '--output-dir', directory]));
      const output = path.join(directory, 'openai-agents-sdk/preflight/quantitative-only/A0.preflight.json');
      const previous = fs.readFileSync(output, 'utf8');
      expect(spawn).toHaveBeenCalledTimes(1);
      expect(() => deepseek.runConfiguredSuites(deepseek.parseArgs(['--suite', 'code-aware-semantic-delta',
        '--runtime', 'openai', '--preflight', '--query-id', 'quantitative-only', '--condition', 'A0',
        '--output-dir', directory]))).toThrow('select a fresh --output-dir');
      expect(spawn).toHaveBeenCalledTimes(1);
      expect(fs.readFileSync(output, 'utf8')).toBe(previous);
    });
  });

  it('protects direct source helpers against an existing attempt root or paired summary', () => {
    const preflight = path.join(directory, 'openai-agents-sdk/preflight');
    fs.mkdirSync(preflight, {recursive: true});
    const paired = path.join(directory, 'openai-agents-sdk/paired-run-01.json');
    fs.writeFileSync(paired, 'prior-paired-summary');
    const spawn = jest.fn(() => {throw new Error('Verifier must not start');});
    jest.doMock('child_process', () => ({...jest.requireActual('child_process'), spawnSync: spawn}));
    jest.isolateModules(() => {
      const isolated = require(deepseekPath);
      expect(() => isolated.runSemanticPreflight({runtime: 'openai-agents-sdk', queryId: 'quantitative-only',
        condition: 'A0', outputDir: directory, timeoutMs: 1000})).toThrow('select a fresh --output-dir');
      expect(() => isolated.runSemanticPairedAttempt({runtimeKind: 'openai-agents-sdk', attempt: 1,
        availability: {available: true, apiKey: 'own-key'}, outputDir: directory, timeoutMs: 1000}))
        .toThrow('select a fresh --output-dir');
    });
    expect(spawn).not.toHaveBeenCalled();
    expect(fs.readFileSync(paired, 'utf8')).toBe('prior-paired-summary');
  });


  it('prepares an explicitly pinned child from one captured environment without global or instance mutation', () => {
    Object.assign(process.env, {OPENAI_MAX_OUTPUT_TOKENS: '8192', QODER_PERSONAL_ACCESS_TOKEN: 'global-qoder-token',
      SMARTPERFETTO_OPENCODE_MODEL_JSON: 'global-override-must-not-be-read'});
    const before = {...process.env};
    const captured = Object.freeze({DEEPSEEK_API_KEY: 'captured-deepseek-key', GLM_API_KEY: 'captured-glm-key',
      OPENAI_MAX_OUTPUT_TOKENS: '1234', OPENAI_FULL_PER_TURN_MS: '2345',
      QODER_PERSONAL_ACCESS_TOKEN: 'captured-qoder-token', OPENAI_BASE_URL: 'https://wrong.example/v1'});
    for (const [harness, provider, model, origin] of [
      [wrapper, 'deepseek', 'deepseek-flash', 'https://api.deepseek.com/v1'],
      [require(glmPath), 'zai-coding-cn', 'glm-5.3-flash', 'https://open.bigmodel.cn/api/coding/paas/v4'],
    ] as const) {
      for (const runtimeKind of ['openai-agents-sdk', 'opencode', 'qoder-agent-sdk']) {
        const prepared = harness.prepareProviderChild({runtimeKind, isolatedRoot: directory,
          provider, model, lightModel: model}, captured);
        expect(prepared.configuration).toEqual({provider, model, lightModel: model, baseUrl: origin});
        expect(prepared.availability.available).toBe(true);
        expect(prepared.env).toMatchObject({OPENAI_BASE_URL: origin, OPENAI_MODEL: model, OPENAI_LIGHT_MODEL: model,
          OPENAI_API_KEY: provider === 'deepseek' ? 'captured-deepseek-key' : 'captured-glm-key',
          OPENAI_MAX_OUTPUT_TOKENS: '1234', OPENAI_FULL_PER_TURN_MS: '2345'});
        expect(prepared.env.QODER_PERSONAL_ACCESS_TOKEN).toBe(runtimeKind === 'qoder-agent-sdk' ? 'captured-qoder-token' : undefined);
      }
    }
    expect(process.env).toEqual(before);
    expect(captured.OPENAI_BASE_URL).toBe('https://wrong.example/v1');
    expect(require(glmPath).providerConfiguration().model).toBe('glm-5.3');
  });

  it('does not prepare an authenticated child from a global key missing in the captured environment', () => {
    const prepared = wrapper.prepareProviderChild({runtimeKind: 'openai-agents-sdk', isolatedRoot: directory,
      provider: 'deepseek', model: 'deepseek-flash', lightModel: 'deepseek-flash'}, {OPENAI_API_KEY: 'unrelated-key'});
    expect(prepared.availability).toEqual({available: false, reason: 'DEEPSEEK_API_KEY_MISSING'});
    expect(prepared.env).toBeUndefined();
  });

  it('applies the same route/model and native override validation to controller preparation', () => {
    const input = {runtimeKind: 'opencode', isolatedRoot: directory,
      provider: 'deepseek', model: 'deepseek-flash', lightModel: 'deepseek-flash'};
    const captured = {DEEPSEEK_API_KEY: 'captured-key'};
    expect(() => wrapper.prepareProviderChild({...input, provider: 'zai-coding-cn'}, captured)).toThrow('requires --provider deepseek');
    expect(() => wrapper.prepareProviderChild({...input, baseUrl: 'https://other.example/v1'}, captured)).toThrow('other endpoints');
    expect(() => wrapper.prepareProviderChild({...input, model: 'deepseek-v4-pro'}, captured)).toThrow('requires --model deepseek-flash');
    expect(() => wrapper.prepareProviderChild(input, {...captured,
      SMARTPERFETTO_OPENCODE_MODEL_JSON: JSON.stringify({providerID: 'other'})})).toThrow('OpenCode model JSON must match');
  });

  it('keeps legacy unpinned Claude outside controller preparation while preserving its explicit environment API', () => {
    process.env.ANTHROPIC_AUTH_TOKEN = 'global-anthropic-key';
    const glm = require(glmPath);
    const captured = Object.freeze({ANTHROPIC_AUTH_TOKEN: 'captured-anthropic-key', CLAUDE_MODEL: 'configured-native-model',
      QODER_PERSONAL_ACCESS_TOKEN: 'never-pass-to-claude'});
    const prepared = glm.prepareProviderChild({runtimeKind: 'claude-agent-sdk', isolatedRoot: directory,
      provider: 'zai-coding-cn', model: 'glm-5.3-flash', lightModel: 'glm-5.3-flash'}, captured);
    expect(prepared.availability).toEqual({available: false, reason: 'PROVIDER_BOUND_PREPARATION_UNAVAILABLE'});
    expect(prepared.env).toBeUndefined();
    const legacy = glm.buildSemanticChildEnv('claude-agent-sdk', {available: true}, directory, captured);
    expect(legacy.ANTHROPIC_AUTH_TOKEN).toBe('captured-anthropic-key');
    expect(legacy.CLAUDE_MODEL).toBe('configured-native-model');
    expect(legacy.QODER_PERSONAL_ACCESS_TOKEN).toBeUndefined();
    const deepseek = wrapper.prepareProviderChild({runtimeKind: 'claude-agent-sdk', isolatedRoot: directory,
      provider: 'deepseek', model: 'deepseek-flash', lightModel: 'deepseek-flash'}, {DEEPSEEK_API_KEY: 'captured-deepseek-key'});
    expect(deepseek.env).toMatchObject({ANTHROPIC_AUTH_TOKEN: 'captured-deepseek-key',
      ANTHROPIC_BASE_URL: 'https://api.deepseek.com/anthropic', CLAUDE_MODEL: 'deepseek-flash'});
  });

  it('prepares Pi from the captured environment and installed metadata without reading a global override', () => {
    process.env.SMARTPERFETTO_PI_AGENT_CORE_MODEL_JSON = 'global-override-must-not-be-read';
    const spawn = jest.fn((_command: string, args: string[], options: any) => {
      expect(args[0]).toBe('--input-type=module');
      expect(options.env.GLM_API_KEY).toBe('captured-glm-key');
      expect(options.env.SMARTPERFETTO_PI_AGENT_CORE_MODEL_JSON).toBeUndefined();
      return {status: 0, stdout: JSON.stringify({model: {id: 'glm-5.3-flash', provider: 'zai-coding-cn',
        contextWindow: 1000000, maxTokens: 128000}, supportedThinkingLevels: ['low', 'high']})};
    });
    jest.doMock('child_process', () => ({...jest.requireActual('child_process'), spawnSync: spawn}));
    jest.isolateModules(() => {
      const isolated = require(glmPath);
      const prepared = isolated.prepareProviderChild({runtimeKind: 'pi-agent-core', isolatedRoot: directory,
        provider: 'zai-coding-cn', model: 'glm-5.3-flash', lightModel: 'glm-5.3-flash'}, {GLM_API_KEY: 'captured-glm-key'});
      expect(prepared.availability.available).toBe(true);
      expect(JSON.parse(prepared.env.SMARTPERFETTO_PI_AGENT_CORE_MODEL_JSON)).toMatchObject({id: 'glm-5.3-flash',
        baseUrl: 'https://open.bigmodel.cn/api/coding/paas/v4', apiKeyEnv: 'GLM_API_KEY'});
    });
    expect(spawn).toHaveBeenCalledTimes(1);
  });

});
