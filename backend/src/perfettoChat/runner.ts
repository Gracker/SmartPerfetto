// SPDX-License-Identifier: AGPL-3.0-or-later

import {execFile, spawn} from 'node:child_process';
import {mkdtemp, rm, stat} from 'node:fs/promises';
import {freemem, totalmem} from 'node:os';
import path from 'node:path';
import {promisify} from 'node:util';
import {estimateTraceProcessorRssBytes} from '../services/traceProcessorRamBudget';
import {TraceProcessorFactory} from '../services/workingTraceProcessor';
import {parameterArgs, type SkillRuntime} from './skillBundle';

export type RunnerMode = 'probe' | 'query' | 'skill';
const RUN_TIMEOUT_SECONDS = 60;
let runnerActive = false;
let runnerUnsafe = false;
const runFile = promisify(execFile);

export function isSkillRunnerAvailable(): boolean {
  return !runnerUnsafe;
}

async function hasRunnerRam(estimate: number): Promise<boolean> {
  const {availableForNewLeaseBytes} = TraceProcessorFactory.getStats().ramBudget;
  if (estimate > availableForNewLeaseBytes) return false;
  if (estimate <= freemem()) return true;
  if (process.platform !== 'darwin') return false;
  // macOS keeps reclaimable memory out of Node's free-page count. Ask the
  // OS for its system-wide estimate when the raw free pages are insufficient.
  try {
    const {stdout} = await runFile('/usr/bin/memory_pressure', [], {
      timeout: 1000, maxBuffer: 16_384, env: {LC_ALL: 'C'},
    });
    const match = stdout.match(/^System-wide memory free percentage: (\d{1,3})%$/m);
    const percent = match ? Number(match[1]) : 0;
    return percent > 0 && percent <= 100 && estimate <= Math.floor(totalmem() * percent / 100);
  } catch {
    return false;
  }
}

// The standard RPC runner creates an independent guardian process group.
// Track those groups in the Python process before accepting a stop signal.
const SUPERVISOR = String.raw`
import contextlib, json, os, resource, runpy, signal, subprocess, sys
from pathlib import Path
resource.setrlimit(resource.RLIMIT_CPU, (65, 65))
resource.setrlimit(resource.RLIMIT_FSIZE, (8 * 1024 * 1024, 8 * 1024 * 1024))
groups = {}
original_popen = subprocess.Popen
def stop(_signal, _frame):
    children = [(pid, child) for pid, child in groups.items() if child.returncode is None]
    for pid, child in children:
        try:
            os.killpg(pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
    for pid, child in children:
        child.wait()
    os._exit(143)
def spawn(*args, **kwargs):
    if not kwargs.get("start_new_session"):
        return original_popen(*args, **kwargs)
    previous = signal.pthread_sigmask(signal.SIG_BLOCK, {signal.SIGTERM})
    try:
        child = original_popen(*args, **kwargs)
        groups[child.pid] = child
        return child
    finally:
        signal.pthread_sigmask(signal.SIG_SETMASK, previous)
signal.signal(signal.SIGTERM, stop)
subprocess.Popen = spawn

mode, script, output, *argv = sys.argv[1:]
# -I ignores inherited packages and PYTHONPATH. Only the pinned scripts are added.
sys.path.insert(0, str(Path(script).parent))
sys.argv = [script, *argv]
try:
    with open(os.devnull, "w") as silent, contextlib.redirect_stdout(silent):
        runpy.run_path(script, run_name="__main__")
except SystemExit as exc:
    if exc.code:
        sys.exit(exc.code)

def value(key, item):
    if isinstance(item, bool) or item is None:
        return item
    if isinstance(item, int):
        if key in {"ts", "dur", "start_ts", "end_ts"} or key.endswith("_ns") or abs(item) > 9007199254740991:
            return str(item)
        return item
    if isinstance(item, float):
        return item if abs(item) != float("inf") and item == item else None
    if isinstance(item, str):
        return item[:1000]
    return None
def evidence(item):
    rows = item.get("rows", [])
    projected = [{key: value(key, val) for key, val in list(row.items())[:40]} for row in rows[:30]]
    query_id = item.get("query_id") or item.get("query", {}).get("id")
    return dict(queryId=query_id, status=item.get("status"), rowCount=item.get("row_count"),
        rows=projected, truncated=len(rows) > 30 or any(len(row) > 40 or any(
            isinstance(field, str) and len(field) > 1000 for field in row.values()) for row in rows[:30]))
document = json.loads(Path(output).read_text())
if mode == "probe":
    trace = document["trace"]
    result = dict(bounds={key: str(trace[key]) for key in ("start_ns", "end_ns")},
        available=document.get("available"), missing=document.get("missing"),
        notRecorded=document.get("not_recorded"), recordedEmpty=document.get("recorded_empty"))
elif mode == "query":
    result = evidence(document)
else:
    items = document.get("evidence", [])
    result = dict(skillId=document.get("skill_id"), status=document.get("status"),
        evidence=[evidence(item) for item in items[:15]], truncated=len(items) > 15)
print("CHAT_RESULT " + json.dumps(result, ensure_ascii=False, allow_nan=False))
`;

export async function runStandardSkill(
  runtime: SkillRuntime,
  tracePath: string,
  mode: RunnerMode,
  id: string,
  parameters: Record<string, unknown>,
  signal: AbortSignal,
): Promise<unknown> {
  signal.throwIfAborted();
  if (runnerUnsafe) throw new Error('SKILL_RUNTIME_UNAVAILABLE');
  if (runnerActive) throw new Error('CAPACITY_EXCEEDED');
  runnerActive = true;
  let temp: string | undefined;
  try {
    const estimate = estimateTraceProcessorRssBytes((await stat(tracePath)).size);
    if (!await hasRunnerRam(estimate)) throw new Error('CAPACITY_EXCEEDED');
    temp = await mkdtemp(path.join(path.dirname(tracePath), 'run-'));
    const command = `perfetto_${mode}.py`;
    const base = [tracePath, '--trace-processor', runtime.processor, '--timeout', String(RUN_TIMEOUT_SECONDS)];
    const output = path.join(temp, 'result.json');
    const argv = mode === 'probe' ? [...base, '--output', output] : [
      ...(mode === 'skill' ? ['run'] : []), ...base,
      mode === 'skill' ? '--skill' : '--query-id', id,
      ...parameterArgs(runtime.bundle, mode, id, parameters),
      '--max-output-bytes', '4194304',
      mode === 'skill' ? '--output-dir' : '--evidence-output',
      mode === 'skill' ? temp : output,
    ];
    signal.throwIfAborted();
    return await execute(runtime, command, temp, output, mode, argv, signal);
  } finally {
    try {
      if (temp) await rm(temp, {recursive: true, force: true});
    } finally {
      runnerActive = false;
    }
  }
}

function execute(
  runtime: SkillRuntime, command: string, cwd: string, output: string,
  mode: RunnerMode, argv: string[], signal: AbortSignal,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const child = spawn(runtime.python, [
      '-I', '-B', '-c', SUPERVISOR, mode, path.join(runtime.root, 'scripts', command), output, ...argv,
    ], {
      cwd, detached: true, shell: false,
      env: {PATH: '/usr/bin:/bin', HOME: cwd, TMPDIR: cwd, LC_ALL: 'en_US.UTF-8'},
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    let stdout = '';
    let stopping = false;
    let emergency: NodeJS.Timeout | undefined;
    const stop = () => {
      if (stopping || !child.pid) return;
      stopping = true;
      // Signal only the supervisor first so it can wait for the RPC guardians.
      child.kill('SIGTERM');
      emergency = setTimeout(() => {
        runnerUnsafe = true;
        try { process.kill(-child.pid!, 'SIGKILL'); } catch { /* process group is gone */ }
      }, 3000);
      emergency.unref();
    };
    const timeout = setTimeout(stop, RUN_TIMEOUT_SECONDS * 1000);
    timeout.unref();
    signal.addEventListener('abort', stop, {once: true});
    if (signal.aborted) stop();
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      if (stopping) return;
      stdout += chunk;
      if (stdout.length > 1024 * 1024) stop();
    });
    child.once('error', () => stop());
    child.once('close', (code, exitSignal) => {
      clearTimeout(timeout);
      if (emergency) clearTimeout(emergency);
      signal.removeEventListener('abort', stop);
      if (stopping && child.pid) {
        try { process.kill(-child.pid, 'SIGKILL'); } catch { /* CLI group already gone */ }
      }
      if (exitSignal === 'SIGKILL' && !stopping) runnerUnsafe = true;
      if (signal.aborted) return reject(signal.reason);
      if (stopping || code !== 0) return reject(new Error('SKILL_EXECUTION_FAILED'));
      const marker = stdout.lastIndexOf('CHAT_RESULT ');
      try {
        if (marker < 0) throw new Error('missing result');
        resolve(JSON.parse(stdout.slice(marker + 'CHAT_RESULT '.length)));
      } catch {
        reject(new Error('SKILL_OUTPUT_INVALID'));
      }
    });
  });
}
