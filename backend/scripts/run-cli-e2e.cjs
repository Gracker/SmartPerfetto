#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {pathToFileURL} = require('url');
const { spawnSync } = require('child_process');

const backendRoot = path.resolve(__dirname, '..');
const repoRoot = path.resolve(backendRoot, '..');
const mode = parseMode(process.argv.slice(2));
const workRoot = fs.mkdtempSync(path.join(os.tmpdir(), `smartperfetto-cli-e2e-${mode}-`));
const keepArtifacts = process.env.SMARTPERFETTO_CLI_E2E_KEEP === '1';
const tracePath = path.join(repoRoot, 'perfetto/test/data/api31_startup_cold.perfetto-trace');
const traceProcessorPath = resolveTraceProcessorPath();
const rawSecret = 'cli-e2e-secret-do-not-leak';

let failure = false;

main()
  .then(() => {
    if (!keepArtifacts) fs.rmSync(workRoot, { recursive: true, force: true });
  })
  .catch((err) => {
    failure = true;
    console.error(`\nCLI E2E failed: ${err.message}`);
    if (err.stack) console.error(err.stack);
    console.error(`Artifacts kept at: ${workRoot}`);
    process.exit(1);
  });

async function main() {
  assertFile(tracePath, 'test trace');
  assertFile(traceProcessorPath, 'trace_processor_shell');

  const cli = mode === 'pack' ? buildPackedCli() : buildDistCli();
  const sessionHome = path.join(workRoot, 'home');
  const backendTraceUploadsBefore = listTraceUploadFiles(path.join(backendRoot, 'uploads', 'traces'));
  const outputDir = path.join(workRoot, 'output');
  const envFile = path.join(workRoot, 'cli-e2e.env');
  fs.mkdirSync(outputDir, { recursive: true });
  const fakeAdbPath = createFakeAdbScript(workRoot);

  const baseEnv = {
    ...process.env,
    HOME: path.join(workRoot, 'user-home'),
    SMARTPERFETTO_HOME: sessionHome,
    SMARTPERFETTO_AGENT_RUNTIME: 'openai-agents-sdk',
    SMARTPERFETTO_CLI_E2E_FAKE: '1',
    SMARTPERFETTO_CLI_E2E_FAKE_RESPONSE: 'CLI E2E fake conclusion: startup analysis completed.',
    SMARTPERFETTO_CLI_E2E_SECRET: rawSecret,
    OPENAI_API_KEY: 'cli-e2e-openai-key',
    OPENAI_BASE_URL: 'http://127.0.0.1:11434/v1',
    OPENAI_MODEL: 'cli-e2e-model',
    TRACE_PROCESSOR_PATH: traceProcessorPath,
    NODE_ENV: 'test',
    NO_COLOR: '1',
  };
  writeEnvFile(envFile, {
    NODE_ENV: baseEnv.NODE_ENV,
    SMARTPERFETTO_HOME: baseEnv.SMARTPERFETTO_HOME,
    SMARTPERFETTO_AGENT_RUNTIME: baseEnv.SMARTPERFETTO_AGENT_RUNTIME,
    SMARTPERFETTO_CLI_E2E_FAKE: baseEnv.SMARTPERFETTO_CLI_E2E_FAKE,
    SMARTPERFETTO_CLI_E2E_FAKE_RESPONSE: baseEnv.SMARTPERFETTO_CLI_E2E_FAKE_RESPONSE,
    OPENAI_API_KEY: baseEnv.OPENAI_API_KEY,
    OPENAI_BASE_URL: baseEnv.OPENAI_BASE_URL,
    OPENAI_MODEL: baseEnv.OPENAI_MODEL,
    TRACE_PROCESSOR_PATH: baseEnv.TRACE_PROCESSOR_PATH,
  });

  const runCli = (name, args, options = {}) => {
    const fullArgs = options.noSessionDir ? args : ['--env-file', envFile, '--session-dir', sessionHome, ...args];
    const result = runProcess(name, cli.command, [...cli.prefixArgs, ...fullArgs], {
      cwd: repoRoot,
      env: { ...baseEnv, ...(options.env || {}) },
      timeoutMs: options.timeoutMs ?? 120000,
      expectExit: options.expectExit ?? 0,
    });
    assertNoSecret(result, name);
    return result;
  };

  console.log(`[cli-e2e] mode=${mode}`);
  console.log(`[cli-e2e] cli=${cli.command} ${cli.prefixArgs.join(' ')}`.trim());
  console.log(`[cli-e2e] home=${sessionHome}`);

  const version = runCli('version', ['--version'], { noSessionDir: true });
  assert.match(version.stdout.trim(), /^\d+\.\d+\.\d+/);

  const help = runCli('help', ['--help'], { noSessionDir: true });
  assert.match(help.stdout, /SmartPerfetto CLI/);
  assert.match(help.stdout, /\brun\b/);
  assert.match(help.stdout, /\bdoctor\b/);

  const config = parseJson(runCli('config init', ['config', 'init', '--format', 'json']).stdout);
  assert.equal(config.ok, true);
  assert.equal(config.path, path.join(sessionHome, 'env'));
  assertFile(config.path, 'generated CLI env');

  const doctor = parseJson(runCli('doctor json', ['doctor', '--format', 'json']).stdout);
  assert.equal(doctor.ok, true);
  assert.equal(doctor.runtime.kind, 'openai-agents-sdk');
  assert.equal(doctor.cliHome, sessionHome);

  const providers = parseJson(runCli('provider list', ['provider', 'list', '--format', 'json']).stdout);
  assert.equal(providers.ok, true);
  assert(Array.isArray(providers.providers));

  const providerTest = parseJson(runCli('provider test system', ['provider', 'test', 'system', '--format', 'json']).stdout);
  assert.equal(providerTest.ok, true);
  assert.equal(providerTest.runtime.kind, 'openai-agents-sdk');

  const capturePresets = parseJson(runCli('capture presets json', ['capture', 'presets', '--format', 'json']).stdout);
  assert.equal(capturePresets.ok, true);
  assert(capturePresets.presets.some((preset) => preset.id === 'startup'));

  const captureConfigPath = path.join(outputDir, 'startup.pbtxt');
  const captureConfig = parseJson(runCli('capture config json', [
    'capture',
    'config',
    '--preset',
    'startup',
    '--app',
    'com.example.app',
    '--duration',
    '3',
    '--categories',
    'dalvikviktime',
    'my_custom_tag',
    '--out',
    captureConfigPath,
    '--format',
    'json',
  ]).stdout);
  assert.equal(captureConfig.ok, true);
  assert.equal(captureConfig.out, captureConfigPath);
  assertFileContains(captureConfigPath, 'duration_ms: 3000', 'capture preset config');
  assertFileContains(captureConfigPath, 'atrace_categories: "dalvikviktime"', 'capture preset config custom category');
  assertFileContains(captureConfigPath, 'atrace_categories: "my_custom_tag"', 'capture preset config custom category');

  const capturedTracePath = path.join(outputDir, 'fake-capture.perfetto-trace');
  const captureOnly = parseJson(runCli('capture android fake json', [
    'capture',
    'android',
    '--format',
    'json',
    '--preset',
    'startup',
    '--app',
    'com.example.app',
    '--duration',
    '3',
    '--out',
    capturedTracePath,
  ], {
    env: {
      ADB_PATH: fakeAdbPath,
      SMARTPERFETTO_CLI_E2E_FAKE_CAPTURE_SOURCE: tracePath,
    },
    timeoutMs: 240000,
  }).stdout);
  assert.equal(captureOnly.ok, true);
  assert.equal(captureOnly.capture.target, 'android');
  assert.equal(captureOnly.capture.preset, 'startup');
  assert.equal(captureOnly.capture.usedSideload, false);
  assertFile(capturedTracePath, 'fake captured Android trace');

  const captureAnalyzeTracePath = path.join(outputDir, 'fake-capture-analyze.perfetto-trace');
  const captureAnalyze = parseJson(runCli('capture android fake analyze json', [
    'capture',
    'android',
    '--format',
    'json',
    '--config',
    captureConfigPath,
    '--out',
    captureAnalyzeTracePath,
    '--analyze',
    '--query',
    'Analyze captured startup trace',
    '--mode',
    'fast',
  ], {
    env: {
      ADB_PATH: fakeAdbPath,
      SMARTPERFETTO_CLI_E2E_FAKE_CAPTURE_SOURCE: tracePath,
    },
    timeoutMs: 240000,
  }).stdout);
  assert.equal(captureAnalyze.ok, true);
  assert.match(captureAnalyze.sessionId, /^agent-/);
  assert.match(captureAnalyze.conclusion, /CLI E2E fake conclusion/);
  const captureAnalyzeConfig = parseJson(fs.readFileSync(path.join(captureAnalyze.sessionDir, 'config.json'), 'utf-8'));
  assert.equal(captureAnalyzeConfig.analysisMode, 'fast');
  assert.equal(captureAnalyzeConfig.capture.target, 'android');
  assert.equal(captureAnalyzeConfig.capture.configPath, captureConfigPath);
  assert.equal(captureAnalyzeConfig.capture.out, captureAnalyzeTracePath);
  assertFile(captureAnalyzeTracePath, 'fake captured Android trace for analysis');

  const emptyList = parseJson(runCli('list empty', ['list', '--json']).stdout);
  assert(Array.isArray(emptyList));
  assert.equal(emptyList.length, 1);

  const query = parseJson(runCli(
    'query json',
    ['query', '--format', 'json', tracePath, '--sql', 'select count(*) as slice_count from slice'],
    { timeoutMs: 180000 },
  ).stdout);
  assert.equal(query.ok, true);
  assert(query.result.rows[0][0] > 1000);
  assertCliTraceCopies(sessionHome, 1);

  const queryNdjson = parseNdjson(runCli(
    'query ndjson',
    ['query', '--format', 'ndjson', tracePath, '--sql', 'select count(*) as slice_count from slice'],
    { timeoutMs: 180000 },
  ).stdout);
  assert(queryNdjson.some((line) => line.type === 'metadata'));
  assert(queryNdjson.some((line) => line.type === 'row'));
  assert(queryNdjson.some((line) => line.type === 'complete' && line.ok === true));

  const badQuery = runCli(
    'query invalid sql',
    ['query', '--format', 'json', tracePath, '--sql', 'select * from smartperfetto_cli_e2e_missing_table'],
    { timeoutMs: 180000, expectExit: 1 },
  );
  const badQueryPayload = parseJson(badQuery.stdout);
  assert.equal(badQueryPayload.ok, false);

  const skill = parseJson(runCli(
    'skill json',
    ['skill', '--format', 'json', tracePath, 'startup_slow_reasons'],
    { timeoutMs: 180000 },
  ).stdout);
  assert.equal(skill.ok, true);
  assert.equal(skill.skillId, 'startup_slow_reasons');

  const analyze = parseJson(runCli(
    'analyze compatibility json',
    ['analyze', tracePath, '--query', '兼容 analyze 入口', '--format', 'json'],
    { timeoutMs: 180000 },
  ).stdout);
  assert.equal(analyze.ok, true);
  assert.match(analyze.sessionId, /^agent-/);

  const run = parseJson(runCli(
    'run json',
    ['run', '--format', 'json', tracePath, '分析启动慢的原因'],
    { timeoutMs: 180000 },
  ).stdout);
  assert.equal(run.ok, true);
  assert.match(run.sessionId, /^agent-/);
  assert.match(run.conclusion, /CLI E2E fake conclusion/);
  assertFile(run.reportPath, 'run report');
  assertFile(run.turnReportPath, 'run turn report');
  assert(run.reportPath.startsWith(path.join(sessionHome, 'sessions')), 'run report should live under CLI session home');
  assert(run.turnReportPath.startsWith(path.join(sessionHome, 'sessions')), 'run turn report should live under CLI session home');
  assertFile(path.join(run.sessionDir, 'claim-support.json'), 'run claim-support sidecar');
  assertFile(path.join(run.sessionDir, 'claim-verification.json'), 'run claim-verification sidecar');
  assertFile(path.join(run.sessionDir, 'identity-resolutions.json'), 'run identity-resolutions sidecar');
  assertFile(path.join(run.sessionDir, 'turns', '001.claim-support.json'), 'run turn claim-support sidecar');
  const runClaimVerification = parseJson(fs.readFileSync(path.join(run.sessionDir, 'claim-verification.json'), 'utf-8'));
  assert.equal(runClaimVerification.schemaVersion, 'claim_verifier@1');

  const sessionId = run.sessionId;
  const ask = parseJson(runCli(
    'ask json',
    ['ask', '--format', 'json', sessionId, '继续分析'],
    { timeoutMs: 180000 },
  ).stdout);
  assert.equal(ask.ok, true);
  assert.equal(ask.sessionId, sessionId);

  const resume = parseJson(runCli(
    'resume compatibility json',
    ['resume', sessionId, '--query', '兼容 resume 入口', '--format', 'json'],
    { timeoutMs: 180000 },
  ).stdout);
  assert.equal(resume.ok, true);
  assert.equal(resume.sessionId, sessionId);

  const reportJsonPath = path.join(outputDir, 'report.json');
  runCli('report export json', ['report', 'export', sessionId, '--format', 'json', '--out', reportJsonPath]);
  const reportJson = parseJson(fs.readFileSync(reportJsonPath, 'utf-8'));
  assert.equal(reportJson.ok, true);
  assert.equal(reportJson.config.sessionId, sessionId);
  assert.equal(reportJson.config.turnCount, 3);
  assert.match(reportJson.conclusion, /CLI E2E fake conclusion/);
  assert(Array.isArray(reportJson.claimSupport), 'report json should include claimSupport sidecar');
  assert.equal(reportJson.claimVerificationResult.schemaVersion, 'claim_verifier@1');
  assert(Array.isArray(reportJson.identityResolutions), 'report json should include identityResolutions sidecar');

    const reportMdPath = path.join(outputDir, 'report.md');
    runCli('report export md', ['report', 'export', sessionId, '--format', 'md', '--out', reportMdPath]);
    const reportMd = fs.readFileSync(reportMdPath, 'utf-8');
    assert.match(reportMd, /SmartPerfetto CLI Report/);
    assert.match(reportMd, /## Claim Verification/);

  const reportHtmlPath = path.join(outputDir, 'report.html');
  runCli('report export html', ['report', 'export', sessionId, '--format', 'html', '--out', reportHtmlPath]);
  const exportedHtml = fs.readFileSync(reportHtmlPath, 'utf-8');
  assert.match(exportedHtml, /SmartPerfetto Agent-Driven/);
  assert.match(exportedHtml, /断言验证结果|Claim Verification/);

  const turnReportJsonPath = path.join(outputDir, 'turn-001.json');
  runCli('report export turn json', ['report', 'export', sessionId, '--turn', '1', '--format', 'json', '--out', turnReportJsonPath]);
    const turnReportJson = parseJson(fs.readFileSync(turnReportJsonPath, 'utf-8'));
    assert.equal(turnReportJson.ok, true);
    assert.equal(turnReportJson.turn, 1);
    assert.match(turnReportJson.turnMarkdown, /分析启动慢的原因/);
    assert(Array.isArray(turnReportJson.claimSupport), 'turn json should include claimSupport sidecar');
    assert.equal(turnReportJson.claimVerificationResult.schemaVersion, 'claim_verifier@1');

    const turnReportMdPath = path.join(outputDir, 'turn-001.md');
    runCli('report export turn md', ['report', 'export', sessionId, '--turn', '1', '--format', 'md', '--out', turnReportMdPath]);
    const turnReportMd = fs.readFileSync(turnReportMdPath, 'utf-8');
    assert.match(turnReportMd, /SmartPerfetto CLI Turn Report/);
    assert.match(turnReportMd, /## Claim Verification/);

  const refTracePath = path.join(workRoot, 'reference.perfetto-trace');
  fs.copyFileSync(tracePath, refTracePath);
  const compare = parseJson(runCli(
    'compare json',
    ['compare', '--format', 'json', '--query', '对比启动差异', tracePath, refTracePath],
    { timeoutMs: 180000 },
  ).stdout);
  assert.equal(compare.ok, true);
  assert.match(compare.sessionId, /^agent-/);
  assertFile(compare.reportPath, 'compare report');
  assertFile(compare.turnReportPath, 'compare turn report');
  assertFileContains(compare.reportPath, 'SmartPerfetto 确定性对比附录', 'compare report comparison section');
  assertFileContains(compare.turnReportPath, 'SmartPerfetto 确定性对比附录', 'compare turn report comparison section');
  const compareConfig = parseJson(fs.readFileSync(path.join(compare.sessionDir, 'config.json'), 'utf-8'));
  assert.equal(typeof compareConfig.referenceTraceId, 'string');
  assert(compareConfig.referenceTraceId.length > 0, 'compare config should persist referenceTraceId');
  const compareTranscript = parseJson(
    fs.readFileSync(path.join(compare.sessionDir, 'transcript.jsonl'), 'utf-8').trim().split(/\n/)[0],
  );
  assert.equal(compareTranscript.question, '对比启动差异');
  assert(!compareTranscript.question.includes('SmartPerfetto CLI 深度对比契约'));

  const list = parseJson(runCli('list after run', ['list', '--json']).stdout);
  assert(list.some((entry) => entry.sessionId === sessionId && entry.turnCount === 3));
  assert(list.some((entry) => entry.sessionId === compare.sessionId));

  runCli('rm main session', ['rm', sessionId, '--yes']);
  const listAfterRm = parseJson(runCli('list after rm', ['list', '--json']).stdout);
  assert(!listAfterRm.some((entry) => entry.sessionId === sessionId));
  runCli('rm analyze compatibility session', ['rm', analyze.sessionId, '--yes']);
  runCli('rm capture analyze session', ['rm', captureAnalyze.sessionId, '--yes']);
  assertNoNewBackendTraceUploads(backendTraceUploadsBefore);

  if (mode === 'live') {
    runLiveOptionalCases(runCli, outputDir);
  }

  console.log(`[cli-e2e] ${mode} passed`);
}

function listTraceUploadFiles(dir) {
  if (!fs.existsSync(dir)) return new Set();
  return new Set(
    fs.readdirSync(dir)
      .filter((name) => name.endsWith('.trace'))
      .map((name) => path.join(dir, name)),
  );
}

function assertCliTraceCopies(sessionHome, minCount) {
  const tracesDir = path.join(sessionHome, 'traces');
  assert(fs.existsSync(tracesDir), `CLI traces dir missing: ${tracesDir}`);
  const traceFiles = fs.readdirSync(tracesDir).filter((name) => name.endsWith('.trace'));
  assert(
    traceFiles.length >= minCount,
    `expected at least ${minCount} CLI trace copy/copies in ${tracesDir}, got ${traceFiles.length}`,
  );
}

function assertNoNewBackendTraceUploads(before) {
  const after = listTraceUploadFiles(path.join(backendRoot, 'uploads', 'traces'));
  const created = [...after].filter((file) => !before.has(file));
  assert.deepEqual(created, [], 'CLI E2E should not write trace copies to backend/uploads/traces');
}

function buildDistCli() {
  const bin = path.join(backendRoot, 'dist/cli-user/bin.js');
  assertFile(bin, 'dist CLI entry');
  return { command: process.execPath, prefixArgs: [bin] };
}

function buildPackedCli() {
  const distBin = path.join(backendRoot, 'dist/cli-user/bin.js');
  assertFile(distBin, 'dist CLI entry');
  const packDir = path.join(workRoot, 'pack');
  const installDir = path.join(workRoot, 'install');
  fs.mkdirSync(packDir, { recursive: true });
  fs.mkdirSync(installDir, { recursive: true });

  const pack = runProcess('npm pack', 'npm', ['pack', '--json', '--ignore-scripts', '--pack-destination', packDir], {
    cwd: backendRoot,
    env: process.env,
    timeoutMs: 120000,
    expectExit: 0,
  });
  const packJson = parseJson(pack.stdout);
  const tarballName = Array.isArray(packJson) ? packJson[0]?.filename : packJson?.filename;
  assert(tarballName, 'npm pack did not return a tarball filename');
  const tarballPath = path.join(packDir, tarballName);
  assertFile(tarballPath, 'packed CLI tarball');

  runProcess('npm install packed CLI', 'npm', [
    'install',
    '--no-audit',
    '--no-fund',
    '--omit=dev',
    '--prefix',
    installDir,
    tarballPath,
  ], {
    cwd: backendRoot,
    env: process.env,
    timeoutMs: 180000,
    expectExit: 0,
  });

  const installedPackageRoot = path.join(
    installDir,
    'node_modules/@gracker/smartperfetto',
  );
  const piRuntimePath = path.join(
    installedPackageRoot,
    'dist/agentRuntime/engines/pi/piAgentCoreRuntime.js',
  );
  assertFile(piRuntimePath, 'packed Pi runtime adapter');
  const piRuntimeUrl = pathToFileURL(piRuntimePath).href;
  runProcess('packed Pi runtime construction', process.execPath, [
    '--input-type=module',
    '--eval',
    `const runtime = await import(${JSON.stringify(piRuntimeUrl)});
const {Agent} = await runtime.loadPiAgentCoreModule();
const provider = await runtime.createPiAgentCoreProviderRuntime({
  model: {
    id: 'packed-pi-model',
    name: 'Packed Pi Model',
    provider: 'packed-pi',
    api: 'openai-completions',
    baseUrl: 'https://example.invalid/v1',
    reasoning: false,
    input: ['text'],
    cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0},
    contextWindow: 8192,
    maxTokens: 1024,
  },
  apiKey: 'packed-pi-secret',
}, {});
new Agent({initialState: {model: provider.model, tools: []}, streamFn: provider.streamFn});
console.log('packed Pi runtime construction: PASS');`,
  ], {
    cwd: installDir,
    env: process.env,
    timeoutMs: 120000,
    expectExit: 0,
  });

  const bin = process.platform === 'win32'
    ? path.join(installDir, 'node_modules/.bin/smp.cmd')
    : path.join(installDir, 'node_modules/.bin/smp');
  assertFile(bin, 'installed smp binary');
  return { command: bin, prefixArgs: [] };
}

function createFakeAdbScript(rootDir) {
  const scriptPath = path.join(rootDir, process.platform === 'win32' ? 'fake-adb.cmd' : 'fake-adb');
  if (process.platform === 'win32') {
    fs.writeFileSync(scriptPath, `@echo off\r\nnode "%~dp0\\fake-adb.cjs" %*\r\n`, 'utf-8');
    fs.writeFileSync(path.join(rootDir, 'fake-adb.cjs'), fakeAdbSource(), 'utf-8');
    return scriptPath;
  }
  fs.writeFileSync(scriptPath, fakeAdbSource(), 'utf-8');
  fs.chmodSync(scriptPath, 0o755);
  return scriptPath;
}

function fakeAdbSource() {
  return `#!/usr/bin/env node
const fs = require('fs');

let args = process.argv.slice(2);
if (args[0] === '-s') args = args.slice(2);

if (args[0] === 'version') {
  console.log('Android Debug Bridge version 1.0.41');
  process.exit(0);
}

if (args[0] === 'devices') {
  console.log('List of devices attached');
  console.log('fake-device-1 device product:fake model:FakePhone transport_id:1');
  process.exit(0);
}

if (args[0] === 'push') process.exit(0);

if (args[0] === 'pull') {
  const source = process.env.SMARTPERFETTO_CLI_E2E_FAKE_CAPTURE_SOURCE;
  const out = args[2];
  if (!source || !out) {
    console.error('missing fake capture source or pull destination');
    process.exit(1);
  }
  fs.copyFileSync(source, out);
  process.exit(0);
}

if (args[0] === 'shell') {
  const command = args.slice(1).join(' ');
  if (command.includes('getprop ro.build.version.sdk')) {
    console.log('33');
    console.log('arm64-v8a');
    console.log('shell');
    process.exit(0);
  }
  if (command.includes('test -d /proc/4242')) {
    console.log('TERM');
    process.exit(0);
  }
  if (args.includes('--background') || command.includes('--background')) {
    console.log('4242');
    process.exit(0);
  }
  process.exit(0);
}

process.exit(0);
`;
}

function runLiveOptionalCases(runCli, outputDir) {
  if (process.env.SMARTPERFETTO_E2E_ADB !== '1') {
    console.log('[cli-e2e] live mode: SMARTPERFETTO_E2E_ADB is not set; skipping adb capture');
    return;
  }
  const out = path.join(outputDir, 'capture.perfetto-trace');
  runCli('capture android', [
    'capture',
    'android',
    '--format',
    'json',
    '--app',
    process.env.SMARTPERFETTO_E2E_ANDROID_APP || 'android',
    '--duration',
    process.env.SMARTPERFETTO_E2E_CAPTURE_DURATION || '3',
    '--out',
    out,
  ], { timeoutMs: 240000 });
  assertFile(out, 'captured Android trace');
}

function runProcess(name, command, args, options) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env,
    encoding: 'utf-8',
    timeout: options.timeoutMs,
    maxBuffer: 32 * 1024 * 1024,
  });
  const stdout = result.stdout || '';
  const stderr = result.stderr || '';
  const status = typeof result.status === 'number' ? result.status : 1;

  writeArtifact(`${sanitizeName(name)}.stdout.txt`, stdout);
  writeArtifact(`${sanitizeName(name)}.stderr.txt`, stderr);

  if (result.error) {
    throw new Error(`${name} failed to spawn: ${result.error.message}\nstdout:\n${stdout}\nstderr:\n${stderr}`);
  }
  if (status !== options.expectExit) {
    throw new Error(`${name} exited ${status}, expected ${options.expectExit}\ncommand: ${command} ${args.join(' ')}\nstdout:\n${stdout}\nstderr:\n${stderr}`);
  }
  return { stdout, stderr, status };
}

function parseMode(argv) {
  const idx = argv.indexOf('--mode');
  const value = idx >= 0 ? argv[idx + 1] : 'dist';
  if (value === 'dist' || value === 'pack' || value === 'live') return value;
  throw new Error(`Invalid --mode ${value}. Expected dist, pack, or live.`);
}

function resolveTraceProcessorPath() {
  if (process.env.TRACE_PROCESSOR_PATH && fs.existsSync(process.env.TRACE_PROCESSOR_PATH)) {
    return path.resolve(process.env.TRACE_PROCESSOR_PATH);
  }
  const executableName = process.platform === 'win32' ? 'trace_processor_shell.exe' : 'trace_processor_shell';
  const platformKey =
    process.platform === 'linux' && process.arch === 'x64'
      ? 'linux-x64'
      : process.platform === 'darwin' && process.arch === 'arm64'
        ? 'darwin-arm64'
        : process.platform === 'win32' && process.arch === 'x64'
          ? 'win32-x64'
          : undefined;
  const candidates = [
    ...(platformKey
      ? [path.join(backendRoot, 'prebuilts', 'trace_processor', platformKey, executableName)]
      : []),
    path.join(repoRoot, 'perfetto/out/ui', executableName),
    path.join(backendRoot, 'bin', executableName),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  throw new Error('trace_processor_shell not found. Run `npm --prefix backend run trace-processor:ensure` first.');
}

function parseJson(raw) {
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(`Failed to parse JSON output: ${err.message}\n${raw}`);
  }
}

function parseNdjson(raw) {
  return raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => parseJson(line));
}

function assertFile(filePath, label) {
  assert(fs.existsSync(filePath), `${label} not found: ${filePath}`);
}

function assertFileContains(filePath, needle, label) {
  const content = fs.readFileSync(filePath, 'utf-8');
  assert(content.includes(needle), `${label} missing ${needle} in ${filePath}`);
}

function assertNoSecret(result, name) {
  const combined = `${result.stdout}\n${result.stderr}`;
  assert(!combined.includes(rawSecret), `${name} leaked CLI E2E secret`);
}

function writeEnvFile(filePath, values) {
  const lines = Object.entries(values).map(([key, value]) => `${key}=${JSON.stringify(String(value))}`);
  fs.writeFileSync(filePath, `${lines.join('\n')}\n`, { encoding: 'utf-8', mode: 0o600 });
}

function sanitizeName(name) {
  return name.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-|-$/g, '') || 'command';
}

function writeArtifact(fileName, content) {
  const artifactDir = path.join(workRoot, 'artifacts');
  fs.mkdirSync(artifactDir, { recursive: true });
  fs.writeFileSync(path.join(artifactDir, fileName), content, 'utf-8');
}
