// SPDX-License-Identifier: AGPL-3.0-or-later

import {createHash} from 'node:crypto';
import {constants, rmSync} from 'node:fs';
import {access, lstat, mkdir, mkdtemp, readdir, readFile, realpath, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import path from 'node:path';

export const SKILL_COMMIT = '3afbec19393b21dc2d83c4659327fd6440776ac6';
const BUNDLE_DIGEST = 'e874fde5d71b2423cd417fa923cc03f3d0f86b65204d2c147aeb97e729196bd6';
const RUNTIME = 'references/generated/runtime/';
const RESOURCE_LIMIT = 16_000;

export interface Bundle {
  name: string;
  description: string;
  files: ReadonlyMap<string, Buffer>;
}
export interface SkillRuntime {
  bundle: Bundle;
  root: string;
  python: string;
  processor: string;
  processorDigest: string;
}

async function collectFiles(
  root: string, files: Map<string, Buffer>, budget: {bytes: number}, relative = '',
): Promise<void> {
  const entries = await readdir(path.join(root, relative), {withFileTypes: true});
  for (const entry of entries) {
    if (entry.name === '__pycache__' && entry.isDirectory()) continue;
    if (!/^[\w.-]+$/.test(entry.name)) throw new Error('INVALID_SKILL_BUNDLE');
    const file = relative + entry.name;
    if (entry.isDirectory()) {
      await collectFiles(root, files, budget, file + '/');
    } else if (entry.isFile()) {
      const full = path.join(root, file);
      const {size} = await lstat(full);
      budget.bytes -= size;
      if (files.size >= 3000 || size > 4 * 1024 * 1024 || budget.bytes < 0) {
        throw new Error('INVALID_SKILL_BUNDLE');
      }
      files.set(file, await readFile(full));
    } else {
      throw new Error('INVALID_SKILL_BUNDLE');
    }
  }
}

let cachedBundle: {configuredRoot: string; bundle: Promise<Bundle | undefined>} | undefined;

export function loadSkillBundle(): Promise<Bundle | undefined> {
  const configuredRoot = process.env.SMARTPERFETTO_PERFETTO_CHAT_SKILL_DIR;
  if (!configuredRoot || !path.isAbsolute(configuredRoot)) return Promise.resolve(undefined);
  if (cachedBundle?.configuredRoot === configuredRoot) return cachedBundle.bundle;
  const bundle = (async () => {
    const root = await realpath(configuredRoot);
    const files = new Map<string, Buffer>();
    await collectFiles(root, files, {bytes: 48 * 1024 * 1024});
    const hash = createHash('sha256');
    for (const name of [...files.keys()].sort()) {
      const digest = createHash('sha256').update(files.get(name)!).digest('hex');
      hash.update(`${name}\0${digest}\n`);
    }
    if (hash.digest('hex') !== BUNDLE_DIGEST) return undefined;
    const frontmatter = files.get('SKILL.md')?.toString('utf8').match(/^---\nname: ([^\n]+)\ndescription: ([^\n]+)\n---/);
    if (!frontmatter) return undefined;
    return {files, name: frontmatter[1], description: frontmatter[2]};
  })().catch(() => undefined);
  cachedBundle = {configuredRoot, bundle};
  return bundle;
}

let cachedRuntime: {key: string; bundle: Bundle; runtime: Promise<SkillRuntime | undefined>} | undefined;
const runtimeDirectories = new Set<string>();
const runFile = promisify(execFile);

export function loadSkillRuntime(bundle?: Bundle): Promise<SkillRuntime | undefined> {
  const {SMARTPERFETTO_PERFETTO_CHAT_PYTHON: py,
    SMARTPERFETTO_PERFETTO_CHAT_PROCESSOR: tp} = process.env;
  if (!bundle || !py || !tp || !path.isAbsolute(py) || !path.isAbsolute(tp)) return Promise.resolve(undefined);
  const key = JSON.stringify([py, tp]);
  if (cachedRuntime?.key === key && cachedRuntime.bundle === bundle) return cachedRuntime.runtime;
  const runtime = (async () => {
    let root: string | undefined;
    try {
      const [python, sourceProcessor] = await Promise.all([realpath(py), realpath(tp)]);
      await Promise.all([access(python, constants.X_OK), access(sourceProcessor, constants.X_OK)]);
      await runFile(python, ['-I', '-B', '-c', 'import sys; assert sys.version_info >= (3, 11)'], {
        timeout: 3000, env: {PATH: '/usr/bin:/bin'},
      });
      const lock = JSON.parse(bundle.files.get('references/trace-processor-lock.json')!.toString('utf8'));
      const processorDigest: string = lock.platforms['mac-arm64'].sha256;
      if ((await lstat(sourceProcessor)).size > 64 * 1024 * 1024) return undefined;
      const processorBytes = await readFile(sourceProcessor);
      if (createHash('sha256').update(processorBytes).digest('hex') !== processorDigest) return undefined;
      root = await mkdtemp(path.join(tmpdir(), 'smartperfetto-chat-skill-'));
      if (!runtimeDirectories.size) {
        process.once('exit', () => {
          for (const dir of runtimeDirectories) {
            try { rmSync(dir, {force: true, recursive: true}); } catch { /* OS temp aging */ }
          }
        });
      }
      runtimeDirectories.add(root);
      const dirs = new Set<string>();
      for (const [name, contents] of bundle.files) {
        const filename = path.join(root, name);
        const dir = path.dirname(filename);
        if (!dirs.has(dir)) {
          await mkdir(dir, {recursive: true, mode: 0o700});
          dirs.add(dir);
        }
        await writeFile(filename, contents, {flag: 'wx', mode: 0o400});
      }
      const processor = path.join(root, 'trace_processor_shell');
      await writeFile(processor, processorBytes, {flag: 'wx', mode: 0o500});
      return {bundle, root, python, processor, processorDigest};
    } catch {
      if (root) {
        try { rmSync(root, {force: true, recursive: true}); } catch { /* retry at process exit */ }
      }
      return undefined;
    }
  })();
  cachedRuntime = {key, bundle, runtime};
  return runtime;
}

export function readSkillResource(bundle: Bundle, name: string, offset: number): object {
  const readable = name === 'SKILL.md' ||
    (/^(references|assets)\//.test(name) && /\.(md|json|sql)$/.test(name));
  const buffer = readable ? bundle.files.get(name) : undefined;
  if (!buffer) throw new Error('RESOURCE_UNAVAILABLE');
  const text = buffer.toString('utf8');
  return {
    path: name, text: text.slice(offset, offset + RESOURCE_LIMIT),
    nextOffset: offset + RESOURCE_LIMIT < text.length ? offset + RESOURCE_LIMIT : undefined,
  };
}

export function describeSkillCatalog(bundle: Bundle, skillId?: string, prefix = '', offset = 0): object {
  const findJson = <T>(name: string): T | undefined => {
    const contents = bundle.files.get(RUNTIME + name);
    return contents && JSON.parse(contents.toString('utf8')) as T;
  };
  const skills = findJson<{skills: Record<string, string>}>('skill-index.json')?.skills ?? {};
  if (skillId) {
    if (!/^[\w-]+$/.test(skillId) || !Object.prototype.hasOwnProperty.call(skills, skillId)) {
      throw new Error('UNKNOWN_SKILL_OR_QUERY');
    }
    const manifest = findJson<SkillManifest>(skills[skillId]);
    const shard = findJson<{queries: QueryManifest[]}>(`queries/${skillId}.json`);
    const queries = shard?.queries ?? [];
    return {
      skillId, manifest: RUNTIME + skills[skillId], inputs: manifest?.inputs ?? [],
      queries: queries.slice(offset, offset + 30).map(query => ({
        id: query.id, parameters: query.template?.parameters ?? [],
      })),
      nextOffset: offset + 30 < queries.length ? offset + 30 : undefined,
    };
  }
  const ids = Object.keys(skills).filter(id => id.includes(prefix));
  return {
    skills: ids.slice(offset, offset + 60),
    nextOffset: offset + 60 < ids.length ? offset + 60 : undefined,
  };
}

interface DeclaredInput { name: string; type: string }
interface SkillManifest { inputs?: DeclaredInput[] }
interface QueryManifest { id: string; template?: {parameters?: string[]} }

export function parameterArgs(bundle: Bundle, mode: 'query' | 'skill', id: string, input: Record<string, unknown>): string[] {
  const idPattern = mode === 'query' ? /^[\w-]+\/[\w.-]+$/ : /^[\w-]+$/;
  if (!idPattern.test(id)) throw new Error('UNKNOWN_SKILL_OR_QUERY');
  const skill = id.split('/')[0];
  const load = <T>(file: string): T | undefined => {
    const bytes = bundle.files.get(RUNTIME + file);
    return bytes && JSON.parse(bytes.toString('utf8')) as T;
  };
  const manifest = load<SkillManifest>(`skills/${skill}.json`);
  const query = mode === 'query'
    ? load<{queries: QueryManifest[]}>(`queries/${skill}.json`)?.queries.find(entry => entry.id === id)
    : undefined;
  if (!manifest || (mode === 'query' && !query)) throw new Error('UNKNOWN_SKILL_OR_QUERY');
  const declared = new Map((manifest.inputs ?? []).map(item => [item.name, item.type]));
  const names = query ? query.template?.parameters ?? [] : [...declared.keys()];
  return Object.entries(input).flatMap(([name, value]) => {
    if (!names.includes(name) || !/^[a-zA-Z_]\w*$/.test(name)) throw new Error('INVALID_SKILL_PARAMETER');
    let serialized: string;
    if (declared.get(name) === 'timestamp' || /^(start|end)_(ts|ns)$/.test(name)) {
      if (typeof value !== 'string' || !isTraceTimestamp(value)) throw new Error('INVALID_SKILL_PARAMETER');
      // The public runner expects a JSON integer. Keep its decimal without a JS number conversion.
      serialized = value;
    } else {
      const items = Array.isArray(value) ? value : [value];
      if (items.length > 20 || items.some(item => !(
        typeof item === 'string' && item.length <= 500 ||
        typeof item === 'number' && Number.isFinite(item) && Math.abs(item) <= Number.MAX_SAFE_INTEGER ||
        typeof item === 'boolean'
      ))) throw new Error('INVALID_SKILL_PARAMETER');
      serialized = JSON.stringify(value);
    }
    return ['--param', `${name}=${serialized}`];
  });
}

export function isTraceTimestamp(value: string): boolean {
  return /^(0|-?[1-9]\d{0,18})$/.test(value) &&
    BigInt(value) >= -(1n << 63n) && BigInt(value) < (1n << 63n);
}
