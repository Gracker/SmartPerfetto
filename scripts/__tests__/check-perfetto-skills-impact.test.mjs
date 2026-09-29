import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

import {
  TRIGGERS,
  classify,
  collectChangedPaths,
  evaluate,
} from '../check-perfetto-skills-impact.mjs';

test('classifies portable Skill source changes', () => {
  assert.equal(classify(['backend/skills/atomic/example.skill.yaml']).reviewRequired, true);
  assert.equal(
    classify(['backend/src/services/skillEngine/skillExecutor.ts']).reviewRequired,
    true,
  );
  assert.equal(classify(['frontend/index.html']).reviewRequired, false);
});

test('covers dotfile rules and shared runtime/report surfaces', () => {
  for (const path of [
    '.claude/rules/skills.md',
    'backend/src/services/verifier/claimVerificationRunner.ts',
    'backend/src/services/processIdentity/identityGate.ts',
    'backend/src/services/perfettoService.ts',
    'backend/src/services/renderingPipelineDetectionSkillGenerator.ts',
    'backend/src/agent/decision/skillExecutorAdapter.ts',
    'backend/data/perfettoStdlibSymbols.json',
    'perfetto',
  ]) {
    assert.equal(classify([path]).reviewRequired, true, path);
  }
  assert.throws(() => classify(['../outside.ts']), /unsafe/);
  assert.throws(() => classify(['/tmp/outside.ts']), /unsafe/);
});

test('every trigger names a tracked path', () => {
  // A trigger for a deleted module matches nothing and silently stops
  // guarding the contract it was listed for.
  const repoRoot = resolve(import.meta.dirname, '../..');
  const tracked = execFileSync('git', ['ls-files'], { cwd: repoRoot, encoding: 'utf8' }).split('\n');
  const stale = TRIGGERS.filter(trigger => !tracked.some(path => path.startsWith(trigger)));
  assert.deepEqual(stale, []);
});

test('requires a semantic decision for triggered changes', () => {
  assert.throws(
    () => evaluate(['backend/strategies/general.md'], {}),
    /decision/,
  );
});

test('requires reasons and a durable deferred handoff', () => {
  const paths = ['backend/skills/public-export.yaml'];
  assert.throws(
    () => evaluate(paths, { decision: 'required' }),
    /reason/,
  );
  assert.throws(
    () => evaluate(paths, { decision: 'deferred', reason: 'split rollout' }),
    /handoff/,
  );
  assert.equal(
    evaluate(paths, {
      decision: 'deferred',
      reason: 'split rollout',
      handoff: 'issue #123',
    }).decision,
    'deferred',
  );
});

test('required decision needs a paired checkout', () => {
  assert.throws(
    () =>
      evaluate(['backend/skills/public-export.yaml'], {
        decision: 'required',
        reason: 'portable contract changed',
      }),
    /paired-path/,
  );
});

test('required rejects a syntactic but missing paired commit', () => {
  const repository = mkdtempSync(join(tmpdir(), 'perfetto-skills-impact-'));
  try {
    execFileSync('git', ['init', '-q', repository]);
    execFileSync('git', ['-C', repository, 'config', 'user.email', 'test@example.com']);
    execFileSync('git', ['-C', repository, 'config', 'user.name', 'Test']);
    writeFileSync(join(repository, 'file'), 'data');
    execFileSync('git', ['-C', repository, 'add', 'file']);
    execFileSync('git', ['-C', repository, 'commit', '-qm', 'test']);
    execFileSync('git', [
      '-C',
      repository,
      'remote',
      'add',
      'origin',
      'https://github.com/Gracker/Perfetto-Skills',
    ]);
    assert.throws(
      () =>
        evaluate(['backend/skills/public-export.yaml'], {
          decision: 'required',
          reason: 'portable contract changed',
          pairedPath: repository,
          pairedRef: 'f'.repeat(40),
        }),
      /does not exist/,
    );
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
});

test('required accepts only the paired checkout exact HEAD', () => {
  const repository = mkdtempSync(join(tmpdir(), 'perfetto-skills-impact-head-'));
  try {
    execFileSync('git', ['init', '-q', repository]);
    execFileSync('git', ['-C', repository, 'config', 'user.email', 'test@example.com']);
    execFileSync('git', ['-C', repository, 'config', 'user.name', 'Test']);
    execFileSync('git', [
      '-C',
      repository,
      'remote',
      'add',
      'origin',
      'https://github.com/Gracker/Perfetto-Skills',
    ]);
    writeFileSync(join(repository, 'file'), 'first');
    execFileSync('git', ['-C', repository, 'add', 'file']);
    execFileSync('git', ['-C', repository, 'commit', '-qm', 'first']);
    const previous = execFileSync('git', ['-C', repository, 'rev-parse', 'HEAD'], {
      encoding: 'utf8',
    }).trim();
    writeFileSync(join(repository, 'file'), 'second');
    execFileSync('git', ['-C', repository, 'commit', '-qam', 'second']);
    const head = execFileSync('git', ['-C', repository, 'rev-parse', 'HEAD'], {
      encoding: 'utf8',
    }).trim();
    const options = {
      decision: 'required',
      reason: 'portable contract changed',
      pairedPath: repository,
    };
    assert.throws(
      () => evaluate(['backend/skills/public-export.yaml'], { ...options, pairedRef: previous }),
      /must equal paired checkout HEAD/,
    );
    assert.equal(
      evaluate(['backend/skills/public-export.yaml'], { ...options, pairedRef: head })
        .pairedEvidence.validatedRef,
      head,
    );
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
});

test('defaults untriggered changes to not_required', () => {
  const result = evaluate(['README.md'], {});
  assert.equal(result.decision, 'not_required');
  assert.equal(result.reason, 'no paired-contract paths changed');
});

test('collects branch, staged, unstaged, and untracked paths', () => {
  const outputs = new Map([
    ['git diff --name-only base...HEAD', 'committed.ts\n'],
    ['git diff --cached --name-only', 'staged.ts\n'],
    ['git diff --name-only', 'unstaged.ts\n'],
    ['git ls-files --others --exclude-standard', 'untracked.ts\n'],
  ]);
  const runner = (command, args) => outputs.get([command, ...args].join(' '));
  assert.deepEqual(collectChangedPaths('base', runner), [
    'committed.ts',
    'staged.ts',
    'unstaged.ts',
    'untracked.ts',
  ]);
});

test('Claude imports the canonical rules exposing the impact gate and decision states', () => {
  const agents = readFileSync(new URL('../../AGENTS.md', import.meta.url), 'utf8');
  const claude = readFileSync(new URL('../../CLAUDE.md', import.meta.url), 'utf8');
  assert.deepEqual(claude.match(/^@\S+$/gm), ['@AGENTS.md']);
  assert.doesNotMatch(claude, /^```|^~~~|^##\s|^<!-- gitnexus:start -->/m);
  assert.doesNotMatch(agents, /^@CLAUDE\.md$/m);
  for (const token of [
    'check:perfetto-skills-impact',
    'required',
    'not_required',
    'deferred',
  ]) {
    assert.match(agents, new RegExp(token));
  }
});

test('public Skill verification checks the pinned imported snapshot', () => {
  const script = readFileSync(
    new URL('../verify-public-skill-export.sh', import.meta.url),
    'utf8',
  );
  assert.match(script, /tools\/sync_smartperfetto\.py/);
  assert.match(script, /tools\/validate_catalog\.py/);
  assert.match(script, /--check/);
  assert.doesNotMatch(script, /tools\/export_from_smartperfetto\.py/);
  assert.match(script, /PYTHON_BIN/);
  assert.match(script, /\/usr\/bin\/python3/);
  assert.match(script, /import json,sys,yaml/);
  assert.ok(
    script.indexOf('"$PYTHON_BIN" "$SYNC_CHECKER"') <
      script.indexOf('"$PYTHON_BIN" "$VALIDATOR"'),
  );
});
