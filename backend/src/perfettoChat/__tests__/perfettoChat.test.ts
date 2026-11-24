// SPDX-License-Identifier: AGPL-3.0-or-later

import {execFile, execFileSync} from 'node:child_process';
import {mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {promisify} from 'node:util';
import {describe, expect, it} from '@jest/globals';
import {beginChatTurn, closeChatSession, executeChatTurn, findChatSession, openChatSession, stopChatTurn} from '../sessions';
import {describeSkillCatalog, parameterArgs, readSkillResource, type Bundle} from '../skillBundle';
import {runStandardSkill} from '../runner';
import {chatProfileRevision} from '../config';
import {parseSelection, prepareTraceInput, resolveChatTrace, selectionWithinBounds} from '../trace';
import {buildTraceOwnerMetadata, writeTraceMetadata} from '../../services/traceMetadataStore';
import type {RequestContext} from '../../middleware/auth';

const context: RequestContext = {
  authType: 'dev', userId: 'local', workspaceId: 'workspace-a', tenantId: 'tenant-a',
  scopes: ['trace:read'], roles: [], requestId: 'test',
};
const profile = {endpoint: new URL('http://127.0.0.1:3210/v1'), model: 'fixture', apiKey: 'fixture'};

describe('Perfetto chat contracts', () => {
  it('binds the immutable session scope and fences repeat or competing turns', async () => {
    const id = await openChatSession(context, profile);
    const session = findChatSession(context, id)!;
    expect(findChatSession({...context, workspaceId: 'workspace-b'}, id)).toBeUndefined();
    expect(findChatSession({...context, userId: 'another-user'}, id)).toBeUndefined();
    const turn = beginChatTurn(session, 'turn-1', 'question', undefined);
    expect(() => beginChatTurn(session, 'turn-1', 'question', undefined)).toThrow('TURN_ALREADY_SUBMITTED');
    expect(() => beginChatTurn(session, 'turn-1', 'different question', undefined)).toThrow('TURN_ID_CONFLICT');
    expect(() => beginChatTurn(session, 'turn-2', 'question', undefined)).toThrow('TURN_ALREADY_ACTIVE');
    stopChatTurn(session, 'another-turn');
    expect(turn.controller.signal.aborted).toBe(false);
    closeChatSession(session);
    expect(turn.controller.signal.aborted).toBe(true);
    expect(findChatSession(context, id)).toBeUndefined();
    const events: string[] = [];
    await executeChatTurn(context, session, turn, profile, 'question', undefined, event => events.push(event.type));
    expect(events).toEqual(['turn_started', 'turn_cancelled']);
  });

  it('revises the opaque model profile across configuration changes', () => {
    expect(chatProfileRevision(profile)).toBe(chatProfileRevision({...profile}));
    expect(chatProfileRevision(profile)).not.toBe(chatProfileRevision({...profile, apiKey: 'different-key'}));
    expect(chatProfileRevision(profile)).not.toBe(chatProfileRevision({...profile, endpoint: new URL('http://127.0.0.1:3210/another-v1')}));
  });

  it('resolves relative store paths and holds the exact file beyond a rename', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'sp-chat-trace-test-'));
    const previous = process.env.SMARTPERFETTO_TRACE_UPLOAD_DIR;
    process.env.SMARTPERFETTO_TRACE_UPLOAD_DIR = path.relative(process.cwd(), dir);
    try {
      const id = 'asset-a';
      const filepath = path.join(dir, id + '.trace');
      await writeFile(filepath, 'original');
      await writeTraceMetadata({id, filename: 'same-name.trace', size: 8, status: 'ready',
        uploadedAt: new Date().toISOString(), path: path.relative(process.cwd(), filepath),
        ...buildTraceOwnerMetadata(context)});
      await expect(resolveChatTrace(id, {...context, workspaceId: 'other-workspace'}))
        .rejects.toThrow('TRACE_UNAVAILABLE');
      const asset = await resolveChatTrace(id, context);
      expect(path.isAbsolute(asset.path)).toBe(true);
      const pinned = await prepareTraceInput(asset);
      try {
        await rename(filepath, filepath + '.old');
        await writeFile(filepath, 'different');
        expect((await resolveChatTrace(id, context)).identity).not.toBe(asset.identity);
        expect(await readFile(pinned.file, 'utf8')).toBe('original');
        await expect(prepareTraceInput(asset)).rejects.toThrow('TRACE_UNAVAILABLE');
      } finally {
        await pinned.dispose();
      }
    } finally {
      if (previous === undefined) delete process.env.SMARTPERFETTO_TRACE_UPLOAD_DIR;
      else process.env.SMARTPERFETTO_TRACE_UPLOAD_DIR = previous;
      await rm(dir, {recursive: true, force: true});
    }
  });

  it('validates time ranges with signed decimal precision and binds the Trace', () => {
    const input = {kind: 'area', traceId: 'trace-a', startNs: '9007199254740993', endNs: '9007199254740995'};
    const selection = parseSelection(input, 'trace-a')!;
    expect(selection).toEqual(input);
    expect(selectionWithinBounds(selection, {start_ns: '9007199254740992', end_ns: '9007199254740994'})).toBe(false);
    expect(selectionWithinBounds(selection, {start_ns: '9007199254740992', end_ns: '9007199254740995'})).toBe(true);
    expect(() => parseSelection(input, 'trace-b')).toThrow('INVALID_SELECTION');
    expect(() => parseSelection({...input, startNs: 42}, 'trace-a')).toThrow('INVALID_SELECTION');
    expect(() => parseSelection({...input, startNs: '00042'}, 'trace-a')).toThrow('INVALID_SELECTION');
    expect(() => parseSelection({...input, endNs: '9223372036854775808'}, 'trace-a')).toThrow('INVALID_SELECTION');
  });

  it('discovers exact query IDs and sends only declared scalar parameters', () => {
    const root = 'references/generated/runtime/';
    const files = new Map<string, Buffer>();
    files.set('SKILL.md', Buffer.from('fixture skill'));
    files.set(root + 'skill-index.json', Buffer.from(JSON.stringify({skills: {startup: 'skills/startup.json'}})));
    files.set(root + 'skills/startup.json', Buffer.from(JSON.stringify({inputs: [
      {name: 'start_ts', type: 'timestamp', required: true},
      {name: 'package', type: 'string', required: false},
    ]})));
    files.set(root + 'queries/startup.json', Buffer.from(JSON.stringify({queries: [
      {id: 'startup/overview', template: {parameters: ['start_ts', 'package']}},
    ]})));
    const bundle: Bundle = {name: 'fixture', description: 'fixture', files};
    expect(describeSkillCatalog(bundle, undefined, 'start')).toEqual({skills: ['startup']});
    expect(describeSkillCatalog(bundle, 'startup')).toMatchObject({
      queries: [{id: 'startup/overview', parameters: ['start_ts', 'package'], nullableParameters: ['package']}],
    });
    expect(parameterArgs(bundle, 'query', 'startup/overview', {start_ts: '9007199254740993', package: null}))
      .toEqual(['--param', 'start_ts=9007199254740993', '--param', 'package=null']);
    expect(parameterArgs(bundle, 'skill', 'startup', {start_ts: '9007199254740993'}))
      .toEqual(['--param', 'start_ts=9007199254740993']);
    expect(() => parameterArgs(bundle, 'query', 'startup/overview', {start_ts: null}))
      .toThrow('INVALID_SKILL_PARAMETER');
    expect(() => parameterArgs(bundle, 'skill', 'startup', {package: null}))
      .toThrow('INVALID_SKILL_PARAMETER');
    expect(() => parameterArgs(bundle, 'query', 'startup/overview', {sql: 'DROP TABLE slice'}))
      .toThrow('INVALID_SKILL_PARAMETER');
    expect(() => readSkillResource(bundle, '../SKILL.md', 0)).toThrow('RESOURCE_UNAVAILABLE');
    expect(() => readSkillResource(bundle, '/SKILL.md', 0)).toThrow('RESOURCE_UNAVAILABLE');
  });

  it('drives the real Pi SDK through fetch and fences each outbound request', async () => {
    const {stdout} = await promisify(execFile)(process.execPath, [
      '--import', 'tsx', 'src/perfettoChat/__tests__/piTransportFixture.ts',
    ], {timeout: 15_000});
    expect(stdout.trim()).toBe('transport-ok');
  }, 20_000);
});

function resolvePython(): string | undefined {
  if (process.platform === 'win32') return undefined;
  try {
    return execFileSync('python3', [
      '-I', '-c', 'import sys; assert sys.version_info >= (3, 11); print(sys.executable)',
    ], {encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 3000}).trim();
  } catch {
    return undefined;
  }
}

const python = resolvePython();
const processGroupTest = python ? it : it.skip;
processGroupTest('cancels the Python supervisor and its separate native process group (POSIX, Python 3.11+)', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'perfetto-chat-cancel-'));
  const scripts = path.join(dir, 'scripts');
  const marks = path.join(dir, 'pids');
  const input = path.join(dir, 'input.trace');
  const abort = new AbortController();
  const prevEstimate = process.env.SMARTPERFETTO_TP_MIN_ESTIMATE_BYTES;
  process.env.SMARTPERFETTO_TP_MIN_ESTIMATE_BYTES = '1';
  let result: Promise<unknown> | undefined;
  try {
    await mkdir(scripts);
    await writeFile(input, 'fixture');
    // Emulate the pinned runner's detached guardian and its native child.
    await writeFile(path.join(scripts, 'perfetto_probe.py'), `
import os, subprocess, sys, time
source = "import os, subprocess, sys; child = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(60)']); from pathlib import Path; marker = Path(sys.argv[1]); staging = marker.with_suffix('.tmp'); staging.write_text(str(os.getpid()) + ':' + str(child.pid)); staging.replace(marker); child.wait()"
subprocess.Popen([sys.executable, '-c', source, ${JSON.stringify(marks)}], start_new_session=True)
time.sleep(60)
`);
    const stopping = runStandardSkill({
      root: dir, python: python!, processor: '/unused', processorDigest: '',
      bundle: {name: 'fixture', description: '', files: new Map()},
    }, input, 'probe', '', {}, abort.signal);
    result = stopping.then(() => 'unexpected-success', error => error);
    let pids: number[] | undefined;
    for (let i = 0; i < 150 && !pids; i++) {
      try { pids = (await readFile(marks, 'utf8')).split(':').map(Number); }
      catch { await new Promise(resolve => setTimeout(resolve, 20)); }
    }
    expect(pids).toHaveLength(2);
    abort.abort('test-cancel');
    expect(await result).toBe('test-cancel');
    for (const pid of pids!) {
      let exited = false;
      for (let i = 0; i < 150 && !exited; i++) {
        try { process.kill(pid, 0); }
        catch (error) { exited = (error as NodeJS.ErrnoException).code === 'ESRCH'; }
        if (!exited) {
          // A killed grandchild may remain a zombie briefly until PID 1 reaps it.
          const processState = await promisify(execFile)('ps', ['-o', 'stat=', '-p', String(pid)])
            .then(value => value.stdout.trim(), () => '');
          exited = processState === '' || processState.startsWith('Z');
        }
        if (!exited) await new Promise(resolve => setTimeout(resolve, 20));
      }
      expect(exited).toBe(true);
    }
    expect((await readdir(dir)).some(name => name.startsWith('run-'))).toBe(false);
  } finally {
    abort.abort('test-cleanup');
    await result;
    if (prevEstimate === undefined) delete process.env.SMARTPERFETTO_TP_MIN_ESTIMATE_BYTES;
    else process.env.SMARTPERFETTO_TP_MIN_ESTIMATE_BYTES = prevEstimate;
    await rm(dir, {recursive: true, force: true});
  }
}, 10_000);
