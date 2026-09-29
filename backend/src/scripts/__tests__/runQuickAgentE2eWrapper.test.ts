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
const {frameFactExpectation, buildChildEnv, evaluateSemanticConditionReport, semanticDeltaQueries, semanticConditionArgs, sameTraceOccurrence} = require(path.join(backendRoot, 'scripts/run-deepseek-agent-e2e.cjs')) as {
  frameFactExpectation: () => {facts: Array<{id: string; oracle: {sql: string}}>};
  buildChildEnv: (apiKey: string, runtimeKind: string, isolatedRoot: string) => Record<string, string | undefined>;
  evaluateSemanticConditionReport: (input: {report: unknown; query: {kind: string}; condition: string; sourceRoot: string}) => {
    traceFactPassed: boolean; overallTaskChecksPassed: boolean;
    sourceBindingPassed: boolean; sourceIdentityPassed: boolean; sourceSemanticPassed: boolean; privacyCanaryCovered: boolean; uncoveredFacets: string[];
  };
  semanticDeltaQueries: () => Array<{id: string; kind: string; text: string}>;
  semanticConditionArgs: (query: unknown, condition: string, output: string, timeoutMs: number) => string[];
  sameTraceOccurrence: (anchor: unknown, oracle: unknown, anchorProof?: unknown, oracleProof?: unknown) => boolean;
};
const execFileAsync = promisify(execFile);
const launchLightTracePath = resolveTraceCase('launch_light.pftrace', path.resolve(backendRoot, '..'));
const traceProcessorPath = getTraceProcessorPath();
const itWithLaunchLightTraceProcessor = fs.existsSync(traceProcessorPath) && fs.existsSync(launchLightTracePath)
  ? it
  : it.skip;

describe('declarative system-analysis suite', () => {
  const wrapper = require(path.join(backendRoot, 'scripts/run-deepseek-agent-e2e.cjs'));
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
  it('does not label the three DeepSeek native adapters as five-runtime acceptance', () => {
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
        const isolated = require(path.join(backendRoot, 'scripts/run-deepseek-agent-e2e.cjs'));
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

describe('source binding acceptance', () => {
  const sourceText = fs.readFileSync(path.join(backendRoot, 'tests/e2e/context-fixtures/app/StartupHooks.kt'), 'utf8');
  const sourceLineCount = sourceText.trimEnd().split(/\r?\n/).length;
  const canaryLine = sourceText.split(/\r?\n/).findIndex(line => line.includes('SEMANTIC_DELTA_PRIVATE_SOURCE_CANARY_NEVER_EMIT')) + 1;
  const requiredSourceRange = JSON.parse(fs.readFileSync(path.resolve(backendRoot,
    '../Trace/constructed/source-analysis-semantic/analysis/expected.json'), 'utf8')).source_trace_ground_truth.lineRange;
  it('uses the original source oracle query with an explicit native ID column and no copied fingerprint', () => {
    const query = semanticDeltaQueries().find(item => item.kind === 'quantitative-only')!;
    const args = semanticConditionArgs(query, 'A0', 'a0.json', 1000);
    const expected = JSON.parse(args[args.indexOf('--expectation-json') + 1]);
    expect(expected.facts[0].oracle.sql).toContain('s.id AS row_id');
    expect(expected.facts[0].oracle.anchorMatch).toEqual({startTs: 'start_ts', upid: 'upid',
      nativeRow: {relation: 'slice', idColumn: 'id', oracleColumn: 'row_id'}});
    expect(JSON.stringify(expected)).not.toContain('schemaFingerprint');
    expect(args[args.indexOf('--query') + 1]).toBe(query.text);
  });

  function fixture() {
    const sourceId = 'source-ref-v1-issued';
    const oracle = {anchorId: 'oracle-anchor', evidenceRefId: 'data-duration',
      context: {traceId: 'trace', traceSide: 'current'},
      timeRange: {startTs: '1000', endTs: '42001000', unit: 'ns'}, identity: {upid: 10, utid: 11},
      cells: [{column: 'dur', rowSelector: {slice_id: 50, track_id: 5}}]};
    const report: any = {traceId: 'trace', passed: true,
      analysisContext: {codebaseIds: ['selected-source'], setup: {codebases: [{setupMode: 'register-only',
        chunkCount: 0, activeIndexState: 'none', pendingGeneration: false, reindexRequests: 0}]}},
      taskVerification: {checks: {originalClaimsVerified: true, 'fact:source_marker_duration': true}, facts: {source_marker_duration: {
        matched: true, proposition: 'proved', matchedClaimIds: ['duration'], matchedAnchorIds: [oracle.anchorId],
      }}},
      summary: {analysisCompletedSourceReferenceCount: 1, analysisCompletedSourceBindingCount: 2,
        analysisCompletedSourceClaimVerifierStatus: 'passed', analysisCompletedSourceReferenceMembershipPassed: true,
        analysisCompletedSourceMechanismStatuses: ['compatible', 'unverified'],
        analysisCompletedVerifiedSourceBindings: [
          {claimId: 'mapping', mechanismStatus: 'compatible', sourceReferenceIds: [sourceId], traceEvidenceRefIds: ['data-mapping']},
          {claimId: 'location', mechanismStatus: 'unverified', sourceReferenceIds: [sourceId], traceEvidenceRefIds: []},
        ],
        analysisCompletedSourceUseDecision: {references: [{id: sourceId, codebaseId: 'selected-source',
          filePath: 'StartupHooks.kt', lineRange: {start: 1, end: sourceLineCount}, lookupKind: 'body'}]},
        terminalAnalysis: {conclusionContract: {claims: [{id: 'duration', kind: 'numeric'}, {id: 'mapping', kind: 'numeric'}]},
          claimVerificationResult: {schemaVersion: 'claim_verifier@2', status: 'passed', passed: true, claimResults: [
            {claimId: 'duration', status: 'verified', deterministicProof: {kind: 'numeric_cell', status: 'proved',
              anchorIds: [oracle.anchorId], evidenceRefIds: [oracle.evidenceRefId]},
              propositionCoverage: {status: 'complete', uncovered: []},
              referenceCells: [{anchorId: oracle.anchorId, evidenceRefId: oracle.evidenceRefId, column: 'dur', status: 'matched'}]},
          ]}, claimSupport: [{claimId: 'duration', anchors: [oracle]},
          {claimId: 'mapping', anchors: [{...structuredClone(oracle), anchorId: 'mapping-anchor', evidenceRefId: 'data-mapping'}]}]},
      }};
    return {report, evaluate: () => evaluateSemanticConditionReport({report, query: {kind: 'explicit-source-location'},
      condition: 'A2', sourceRoot: path.join(backendRoot, 'tests/e2e/context-fixtures/app')})};
  }

  function nativeFixture() {
    const target = fixture();
    const terminal: any = target.report.summary.terminalAnalysis;
    const oracle = terminal.claimSupport[0].anchors[0];
    const mapped = terminal.claimSupport[1].anchors[0];
    for (const anchor of [oracle, mapped]) {
      delete anchor.timeRange;
      delete anchor.identity;
      anchor.context.captureId = `capture-${anchor.anchorId}`;
    }
    const proof = (anchor: any, claimId: string) => ({claimId, status: 'verified',
      referenceCells: [{anchorId: anchor.anchorId, evidenceRefId: anchor.evidenceRefId, column: 'dur', status: 'matched'}],
      deterministicProof: {kind: 'numeric_cell', status: 'proved', anchorIds: [anchor.anchorId], evidenceRefIds: [anchor.evidenceRefId],
        nativeRows: [{anchorId: anchor.anchorId, evidenceRefId: anchor.evidenceRefId, captureId: anchor.context.captureId,
          traceId: 'trace', traceSide: 'current', relation: 'slice', idColumn: 'id', id: 50, schemaFingerprint: 'a'.repeat(64)}]},
      propositionCoverage: {status: 'complete', uncovered: []}});
    const oracleProof = proof(oracle, 'duration');
    const mappedProof = proof(mapped, 'mapping');
    terminal.claimVerificationResult = {schemaVersion: 'claim_verifier@2', status: 'passed', passed: true,
      unsupportedClaimCount: 0, claimResults: [oracleProof, mappedProof]};
    return {...target, oracle, mapped, oracleProof, mappedProof};
  }

  it('joins two current finite proofs by native row identity without promoting source compatibility', () => {
    const target = nativeFixture();
    const before = structuredClone(target.report);
    expect(target.evaluate()).toMatchObject({sourceIdentityPassed: true, sourceSemanticPassed: true});
    expect(target.report).toEqual(before);
    expect(target.report.summary.analysisCompletedVerifiedSourceBindings[0].mechanismStatus).toBe('compatible');
  });

  it('retains the proved Trace fact when other source claims remain partial', () => {
    const target = fixture();
    target.report.taskVerification.checks.originalClaimsVerified = false;
    target.report.summary.terminalAnalysis.claimVerificationResult.status = 'partial';
    target.report.summary.terminalAnalysis.claimVerificationResult.passed = false;
    expect(target.evaluate()).toMatchObject({traceFactPassed: true, overallTaskChecksPassed: false});
  });

  it.each(['factCheck', 'matched', 'proposition', 'missingClaim', 'duplicateClaim', 'missingProof', 'duplicateProof',
    'partialProof', 'missingSupport', 'duplicateSupport', 'missingAnchor', 'duplicateAnchor', 'wrongAnchor',
    'wrongEvidence', 'wrongTrace', 'wrongSide', 'unmatchedCell', 'wrongOracleClaim', 'wrongOracleAnchor'] as const)(
    'does not retain a Trace fact with a broken %s association', change => {
      const target = fixture();
      const report = target.report;
      const terminal = report.summary.terminalAnalysis;
      const proof = terminal.claimVerificationResult.claimResults[0];
      const support = terminal.claimSupport[0];
      const fact = report.taskVerification.facts.source_marker_duration;
      if (change === 'factCheck') report.taskVerification.checks['fact:source_marker_duration'] = false;
      if (change === 'matched') fact.matched = false;
      if (change === 'proposition') fact.proposition = 'unknown';
      if (change === 'missingClaim') terminal.conclusionContract.claims.shift();
      if (change === 'duplicateClaim') terminal.conclusionContract.claims.push({...terminal.conclusionContract.claims[0]});
      if (change === 'missingProof') terminal.claimVerificationResult.claimResults = [];
      if (change === 'duplicateProof') terminal.claimVerificationResult.claimResults.push({...proof});
      if (change === 'partialProof') proof.status = 'partial';
      if (change === 'missingSupport') terminal.claimSupport.shift();
      if (change === 'duplicateSupport') terminal.claimSupport.push({...support});
      if (change === 'missingAnchor') support.anchors = [];
      if (change === 'duplicateAnchor') support.anchors.push({...support.anchors[0]});
      if (change === 'wrongAnchor') proof.deterministicProof.anchorIds = ['other'];
      if (change === 'wrongEvidence') proof.deterministicProof.evidenceRefIds = ['other'];
      if (change === 'wrongTrace') support.anchors[0].context.traceId = 'other';
      if (change === 'wrongSide') support.anchors[0].context.traceSide = 'reference';
      if (change === 'unmatchedCell') proof.referenceCells[0].status = 'missing';
      if (change === 'wrongOracleClaim') fact.matchedClaimIds = ['other'];
      if (change === 'wrongOracleAnchor') fact.matchedAnchorIds = ['other'];
      expect(target.evaluate()).toMatchObject({traceFactPassed: false, sourceSemanticPassed: false});
    });

  function withMockedVerifier(
    mutate: (report: any, args: string[]) => void,
    run: (wrapper: any, outputDir: string) => void,
  ) {
    const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'smartperfetto-layered-acceptance-'));
    const environment = jest.replaceProperty(process, 'env', {...process.env, DEEPSEEK_API_KEY: 'test-only-key'});
    const logging = jest.spyOn(console, 'log').mockImplementation(() => {});
    const spawn = jest.fn((_command: string, args: string[]) => {
      expect(args[1]).toBe(path.join(backendRoot, 'src/scripts/verifyAgentSseScrolling.ts'));
      const output = args[args.indexOf('--output') + 1];
      const report = fixture().report;
      if (args[args.indexOf('--code-aware') + 1] === 'off') {
        report.analysisContext.codebaseIds = [];
        report.summary.analysisCompletedSourceReferenceCount = 0;
        report.summary.analysisCompletedSourceBindingCount = 0;
        report.summary.analysisCompletedSourceMechanismStatuses = [];
        report.summary.analysisCompletedVerifiedSourceBindings = [];
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
      jest.isolateModules(() => run(require(path.join(backendRoot, 'scripts/run-deepseek-agent-e2e.cjs')), outputDir));
      expect(spawn).toHaveBeenCalled();
    } finally {
      jest.dontMock('child_process');
      environment.restore();
      logging.mockRestore();
      fs.rmSync(outputDir, {recursive: true, force: true});
    }
  }

  it.each(['otherClaimPartial', 'traceFactMissing'] as const)(
    'keeps preflight, paired and runtime acceptance failed for %s despite a successful child exit', failure => {
      withMockedVerifier(report => {
        if (failure === 'otherClaimPartial') report.taskVerification.checks.originalClaimsVerified = false;
        else report.taskVerification.facts.source_marker_duration.matched = false;
      }, (wrapper, outputDir) => {
        const preflight = wrapper.runSemanticPreflight({runtime: 'openai-agents-sdk', queryId: 'explicit-source-location',
          condition: 'A2', outputDir, timeoutMs: 1000});
        expect(preflight).toMatchObject({preflightPassed: false, completeAcceptance: false,
          record: {passed: true, hardAssertions: {traceFactPassed: failure === 'otherClaimPartial',
            overallTaskChecksPassed: failure !== 'otherClaimPartial'}}});
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

  it.each(['id', 'relation', 'idColumn', 'traceId', 'traceSide', 'schemaFingerprint', 'anchorId', 'evidenceRefId', 'captureId'] as const)(
    'does not join a different native %s merely because the duration scalar matches', field => {
      const target = nativeFixture();
      const row = target.mappedProof.deterministicProof.nativeRows[0];
      if (field === 'id') row.id = 51;
      else if (field === 'schemaFingerprint') row.schemaFingerprint = 'b'.repeat(64);
      else row[field] = 'different';
      expect(target.evaluate()).toMatchObject({sourceIdentityPassed: false, sourceSemanticPassed: false});
    });

  it.each(['candidate', 'inference', 'missingCapture', 'duplicate', 'unmatchedCell', 'missingNativeRows', 'missingOracleProof'] as const)(
    'requires both current proofs for the native association: %s', change => {
      const target = nativeFixture();
      if (change === 'candidate') target.mappedProof.deterministicProof.status = 'candidate';
      if (change === 'inference') target.mappedProof.status = 'inference';
      if (change === 'missingCapture') delete target.mapped.context.captureId;
      if (change === 'duplicate') target.mappedProof.deterministicProof.nativeRows.push({...target.mappedProof.deterministicProof.nativeRows[0]});
      if (change === 'unmatchedCell') target.mappedProof.referenceCells[0].status = 'value_mismatch';
      if (change === 'missingNativeRows') target.mappedProof.deterministicProof.nativeRows = [];
      expect(sameTraceOccurrence(target.mapped, target.oracle, target.mappedProof,
        change === 'missingOracleProof' ? undefined : target.oracleProof)).toBe(false);
    });

  it('accepts an unverified location beside an oracle-linked compatible binding without promoting its mechanism', () => {
    const target = fixture();
    const before = structuredClone(target.report);
    expect(target.evaluate()).toMatchObject({sourceBindingPassed: true, sourceIdentityPassed: true, sourceSemanticPassed: true,
      uncoveredFacets: ['source recommendation action semantics']});
    expect(target.report).toEqual(before);
  });

  it.each(['unverified', 'ambiguous'])('does not let a %s target binding establish the oracle association', status => {
    const target = fixture();
    target.report.summary.analysisCompletedSourceMechanismStatuses[0] = status;
    target.report.summary.analysisCompletedVerifiedSourceBindings[0].mechanismStatus = status;
    expect(target.evaluate()).toMatchObject({sourceIdentityPassed: false, sourceSemanticPassed: false});
  });

  it.each(['start', 'end'] as const)('rejects a body read missing the required %s boundary', boundary => {
    const target = nativeFixture();
    const reference = target.report.summary.analysisCompletedSourceUseDecision.references[0];
    reference.lineRange[boundary] = requiredSourceRange[boundary] + (boundary === 'start' ? 1 : -1);
    expect(target.evaluate()).toMatchObject({sourceBindingPassed: true, sourceIdentityPassed: false, sourceSemanticPassed: false});
  });

  it('counts a read covering the canary independently of complete mechanism coverage', () => {
    const target = nativeFixture();
    const reference = target.report.summary.analysisCompletedSourceUseDecision.references[0];
    expect(canaryLine).toBeGreaterThan(0);
    expect(canaryLine).toBeLessThan(requiredSourceRange.end);
    reference.lineRange = {start: 1, end: canaryLine};
    expect(target.evaluate()).toMatchObject({privacyCanaryCovered: true, sourceIdentityPassed: false, sourceSemanticPassed: false});
  });

  it.each(['miss_canary', 'metadata', 'graph', 'wrong_codebase', 'wrong_file', 'unissued_id', 'inverted', 'zero_start', 'unsafe_end'])(
    'rejects %s when checking source canary coverage', failure => {
      const target = nativeFixture();
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

  it.each(['thread', 'end', 'row'])('retains strict occurrence identity when the %s differs', field => {
    const target = fixture();
    const anchor = target.report.summary.terminalAnalysis.claimSupport[1].anchors[0];
    if (field === 'thread') anchor.identity.utid = 12;
    if (field === 'end') anchor.timeRange.endTs = '1100';
    if (field === 'row') anchor.cells[0].rowSelector.slice_id = 51;
    expect(target.evaluate()).toMatchObject({sourceBindingPassed: true, sourceIdentityPassed: false, sourceSemanticPassed: false});
  });

  it.each(['verdict', 'membership'])('requires the current production binding %s', field => {
    const target = fixture();
    if (field === 'verdict') target.report.summary.analysisCompletedSourceClaimVerifierStatus = 'partial';
    else target.report.summary.analysisCompletedSourceReferenceMembershipPassed = false;
    expect(target.evaluate()).toMatchObject({sourceBindingPassed: false, sourceIdentityPassed: false, sourceSemanticPassed: false});
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
    const {stdout} = await execFileAsync(traceProcessorPath, ['query', launchLightTracePath, fact!.oracle.sql], {
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
    expect(result.stdout).not.toContain('DEEPSEEK_API_KEY');
    expect(result.stdout).not.toContain('OPENAI_API_KEY is required');
  });
});

describe('DeepSeek E2E explicit output limit', () => {
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

  it('preserves other runtimes model and protocol pins', () => {
    jest.replaceProperty(process, 'env', {...process.env, OPENAI_MAX_OUTPUT_TOKENS: '16384',
      SMARTPERFETTO_PI_AGENT_CORE_MODEL_JSON: '{"id":"pi-explicit"}',
      SMARTPERFETTO_OPENCODE_MODEL_JSON: '{"modelID":"opencode-explicit"}',
      DEEPSEEK_MODEL: 'pinned-main-model', DEEPSEEK_LIGHT_MODEL: 'pinned-light-model'});
    const pi = buildChildEnv('test-key', 'pi-agent-core', '/tmp/wrapper-test');
    expect(pi.SMARTPERFETTO_PI_AGENT_CORE_MODEL_JSON).toBe('{"id":"pi-explicit"}');
    const opencode = buildChildEnv('test-key', 'opencode', '/tmp/wrapper-test');
    expect(opencode.SMARTPERFETTO_OPENCODE_MODEL_JSON).toBe('{"modelID":"opencode-explicit"}');
    const qoder = buildChildEnv('test-key', 'qoder-agent-sdk', '/tmp/wrapper-test');
    expect(qoder.QODER_MODEL).toBe('pinned-main-model');
    expect(qoder.QODER_LIGHT_MODEL).toBe('pinned-light-model');
    expect(qoder.QODER_BYOK_STYLE).toBe('openai');
  });

  it.each(['deepseek-v4-flash', 'deepseek-v4-pro'])('loads accurate SDK model capabilities for %s without a wrapper cap', modelId => {
    const environment: NodeJS.ProcessEnv = {...process.env, DEEPSEEK_MODEL: modelId, DEEPSEEK_BASE_URL: 'https://api.deepseek.com/v1'};
    delete environment.OPENAI_MAX_OUTPUT_TOKENS;
    delete environment.SMARTPERFETTO_PI_AGENT_CORE_MODEL_JSON;
    jest.replaceProperty(process, 'env', environment);
    const child = buildChildEnv('test-key', 'pi-agent-core', '/tmp/wrapper-test');
    const model = JSON.parse(child.SMARTPERFETTO_PI_AGENT_CORE_MODEL_JSON!);
    expect(model).toMatchObject({id: modelId, provider: 'deepseek', api: 'openai-completions',
      contextWindow: 1_000_000, maxTokens: 384_000, reasoning: true,
      baseUrl: 'https://api.deepseek.com/v1', apiKeyEnv: 'DEEPSEEK_API_KEY',
      compat: {requiresReasoningContentOnAssistantMessages: true, thinkingFormat: 'deepseek'},
      thinkingLevelMap: expect.any(Object)});
    expect(Object.prototype.hasOwnProperty.call(model, 'thinkingLevel')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(child, 'OPENAI_MAX_OUTPUT_TOKENS')).toBe(false);
  });

  it('requires explicit model configuration for an unknown SDK model instead of borrowing v4 capabilities', () => {
    const environment: NodeJS.ProcessEnv = {...process.env, DEEPSEEK_MODEL: 'unlisted-model'};
    delete environment.SMARTPERFETTO_PI_AGENT_CORE_MODEL_JSON;
    jest.replaceProperty(process, 'env', environment);
    expect(() => buildChildEnv('test-key', 'pi-agent-core', '/tmp/wrapper-test'))
      .toThrow('Unknown DeepSeek model in the installed Pi SDK');
    process.env.SMARTPERFETTO_PI_AGENT_CORE_MODEL_JSON = '{"id":"unlisted-model","custom":true}';
    expect(buildChildEnv('test-key', 'pi-agent-core', '/tmp/wrapper-test').SMARTPERFETTO_PI_AGENT_CORE_MODEL_JSON)
      .toBe('{"id":"unlisted-model","custom":true}');
  });
});
