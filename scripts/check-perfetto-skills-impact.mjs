#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

export const TRIGGERS = Object.freeze([
  'backend/skills/',
  'backend/strategies/',
  'backend/src/services/skillEngine/',
  'backend/src/services/skillPacks/',
  'backend/src/services/evidence/',
  'backend/src/services/processIdentity/',
  'backend/src/services/verifier/',
  'backend/src/services/perfetto',
  'backend/src/services/smartperfettoSqlPackage.ts',
  'backend/src/services/renderingPipelineDetectionSkillGenerator.ts',
  'backend/src/services/stdlibSkillCoverage.ts',
  'backend/src/services/finalReportContractGate',
  'backend/src/services/report',
  'backend/src/services/comparison',
  'backend/src/services/analysisResultSnapshot',
  'backend/src/services/multiTraceComparison',
  'backend/src/agent/decision/',
  'backend/src/agent/core/executors/directSkillExecutor.ts',
  'backend/src/agent/core/executors/comparisonExecutor.ts',
  'backend/src/types/claimVerification.ts',
  'backend/src/types/evidenceContract.ts',
  'backend/src/types/identityContract.ts',
  'backend/src/types/multiTraceComparison.ts',
  'backend/src/services/sqlValidator.ts',
  'backend/data/perfettoStdlibSymbols.json',
  'backend/data/perfettoSqlDocs.json',
  'perfetto',
  'docs/rendering_pipelines/',
  'scripts/trace-processor-pin.env',
  'scripts/verify-public-skill-export.sh',
  '.claude/rules/skills.md',
  '.claude/rules/perfetto-sync.md',
]);

const DECISIONS = new Set(['required', 'not_required', 'deferred']);

function matches(path, trigger) {
  return trigger.endsWith('/') ? path.startsWith(trigger) : path.startsWith(trigger);
}

function normalizePath(path) {
  const normalized = path.startsWith('./') ? path.slice(2) : path;
  if (normalized.startsWith('/') || normalized.split('/').includes('..')) {
    throw new Error(`unsafe changed path: ${path}`);
  }
  return normalized;
}

export function classify(paths) {
  const normalizedPaths = [...new Set(paths.filter(Boolean).map(normalizePath))].sort();
  const matchedPaths = normalizedPaths.filter((path) =>
    TRIGGERS.some((trigger) => matches(path, trigger)),
  );
  return {
    repository: 'SmartPerfetto',
    pairedRepository: 'Perfetto-Skills',
    reviewRequired: matchedPaths.length > 0,
    matchedPaths,
    changeFingerprint: createHash('sha256')
      .update(`SmartPerfetto\0${normalizedPaths.join('\0')}`)
      .digest('hex'),
    decision: null,
  };
}

export function evaluate(paths, { decision, reason, handoff, pairedPath, pairedRef }) {
  const result = classify(paths);
  if (!result.reviewRequired && decision === undefined) {
    decision = 'not_required';
    reason = 'no paired-contract paths changed';
  } else if (result.reviewRequired && decision === undefined) {
    throw new Error('triggered changes require an explicit --decision');
  }

  if (!DECISIONS.has(decision)) {
    throw new Error('decision must be required, not_required, or deferred');
  }
  if (typeof reason !== 'string' || reason.trim() === '') {
    throw new Error(`${decision} requires a non-empty --reason`);
  }
  if (decision === 'deferred' && (typeof handoff !== 'string' || handoff.trim() === '')) {
    throw new Error('deferred requires a durable --handoff');
  }
  const pairedEvidence =
    decision === 'required' ? validatePairedRepository(pairedPath, pairedRef) : null;
  return {
    ...result,
    decision,
    reason: reason.trim(),
    handoff: typeof handoff === 'string' && handoff.trim() !== '' ? handoff.trim() : null,
    pairedEvidence,
  };
}

function run(command, args) {
  return execFileSync(command, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

export function collectChangedPaths(base, runner = run) {
  const resolvedBase =
    base ?? runner('git', ['merge-base', 'HEAD', 'origin/main']).trim();
  const commands = [
    ['git', ['diff', '--name-only', `${resolvedBase}...HEAD`]],
    ['git', ['diff', '--cached', '--name-only']],
    ['git', ['diff', '--name-only']],
    ['git', ['ls-files', '--others', '--exclude-standard']],
  ];
  return [
    ...new Set(
      commands.flatMap(([command, args]) =>
        runner(command, args).split('\n').filter(Boolean),
      ),
    ),
  ].sort();
}

function validatePairedRepository(pairedPath, pairedRef) {
  if (typeof pairedPath !== 'string' || !existsSync(resolve(pairedPath))) {
    throw new Error('required requires a valid --paired-path');
  }
  const path = resolve(pairedPath);
  const remote = run('git', ['-C', path, 'config', '--get', 'remote.origin.url']).trim();
  const normalizedRemote = remote
    .replace(/\.git$/, '')
    .replace('git@github.com:', 'https://github.com/');
  if (!normalizedRemote.endsWith('Gracker/Perfetto-Skills')) {
    throw new Error(`paired repository identity mismatch: ${remote}`);
  }
  const head = run('git', ['-C', path, 'rev-parse', 'HEAD']).trim();
  if (pairedRef === undefined) {
    throw new Error('required requires an immutable --paired-ref');
  }
  if (pairedRef !== undefined) {
    if (!/^[0-9a-f]{40}$/.test(pairedRef)) {
      throw new Error('--paired-ref must be a lowercase 40-character commit');
    }
    try {
      run('git', ['-C', path, 'cat-file', '-e', `${pairedRef}^{commit}`]);
    } catch {
      throw new Error(`paired ref does not exist: ${pairedRef}`);
    }
    const resolvedRef = run('git', [
      '-C',
      path,
      'rev-parse',
      `${pairedRef}^{commit}`,
    ]).trim();
    if (resolvedRef !== pairedRef) {
      throw new Error(`paired ref does not resolve exactly: ${pairedRef}`);
    }
    if (head !== pairedRef) {
      throw new Error(`paired ref must equal paired checkout HEAD: ${pairedRef} != ${head}`);
    }
  }
  return { repository: remote, head, validatedRef: pairedRef ?? head };
}

export function main(argv = process.argv.slice(2)) {
  try {
    const { values } = parseArgs({
      args: argv,
      options: {
        base: { type: 'string' },
        path: { type: 'string', multiple: true, default: [] },
        decision: { type: 'string' },
        reason: { type: 'string' },
        handoff: { type: 'string' },
        'paired-path': { type: 'string' },
        'paired-ref': { type: 'string' },
      },
      strict: true,
    });
    const paths =
      values.path.length > 0 ? values.path : collectChangedPaths(values.base);
    const result = evaluate(paths, {
      decision: values.decision,
      reason: values.reason,
      handoff: values.handoff,
      pairedPath: values['paired-path'],
      pairedRef: values['paired-ref'],
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return 0;
  } catch (error) {
    process.stderr.write(`Perfetto-Skills impact check failed: ${error.message}\n`);
    return 2;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main();
}
