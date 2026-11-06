// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {createHash} from 'crypto';
import * as fs from 'fs';
import {mkdtemp, rename, rm, symlink, utimes, writeFile} from 'fs/promises';
import os from 'os';
import path from 'path';
import {
  clearCapabilityRuntimeIdentityCaches,
  resolveCapabilityTraceIdentity,
  resolveCapabilityTraceProcessorIdentity,
  sanitizeCapabilityTraceProcessorReportedVersion,
  type CapabilityRuntimeIdentityDependencies,
  copyManagedTraceInput, moveManagedTraceInput, bindManagedTraceInput, revokeManagedTraceInput,
  beginManagedTraceLoad, completeManagedTraceLoad, readLoadedTraceSourcePin, revokeLoadedTraceSourcePin,
  assertLoadedTraceSourcePinCurrent, type ManagedTraceInputGrant, type LoadedTraceSourcePin,
} from '../capabilityManifestRuntimeIdentity';

const TRACE_SHA =
  '83927f72a4a8366beba093e79cc55d7c68344f0f80753946bf4cfed60ba9ca2c';
const BINARY_SHA =
  '7e05c51acb826b8580714d6558a1b701255b51582ca7a1b3af52fb46de432924';
const GIT_A = 'a'.repeat(40);
const GIT_B = 'b'.repeat(40);
const SHA_KEYS = {
  'linux/x64': 'PERFETTO_SHELL_SHA256_LINUX_AMD64',
  'linux/arm64': 'PERFETTO_SHELL_SHA256_LINUX_ARM64',
  'darwin/x64': 'PERFETTO_SHELL_SHA256_MAC_AMD64',
  'darwin/arm64': 'PERFETTO_SHELL_SHA256_MAC_ARM64',
  'win32/x64': 'PERFETTO_SHELL_SHA256_WINDOWS_AMD64',
} as const;

let tempRoots: string[] = [];

async function makeTempRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'capability-runtime-'));
  tempRoots.push(root);
  return root;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function pinText(
  key: string,
  binarySha = BINARY_SHA,
  revision = GIT_A,
): string {
  return [
    '# exact trace processor identity',
    `PERFETTO_VERSION=${revision}`,
    'PERFETTO_ARTIFACT_VERSION=v58.2',
    'PERFETTO_LUCI_URL_BASE=https://example.invalid/perfetto',
    ...Object.values(SHA_KEYS).map(shaKey => `${shaKey}=${shaKey === key ? binarySha : '0'.repeat(64)}`),
    '',
  ].join('\n');
}

async function writePin(
  root: string,
  contents = pinText(SHA_KEYS['darwin/arm64']),
  name = 'trace-processor-pin.env',
): Promise<string> {
  const pinPath = path.join(root, name);
  await writeFile(pinPath, contents);
  return pinPath;
}

async function writeStdlibAsset(root: string, revision = GIT_B): Promise<string> {
  const assetPath = path.join(root, 'perfettoStdlibSymbols.json');
  await writeFile(assetPath, JSON.stringify({version: 1, generatedFrom: revision}));
  return assetPath;
}

function localDependencies(
  overrides: Partial<CapabilityRuntimeIdentityDependencies> = {},
): CapabilityRuntimeIdentityDependencies {
  return {
    platform: 'darwin',
    arch: 'arm64',
    canonicalSlotResolver: () => ({}),
    pinCandidates: [],
    stdlibAssetPath: path.join(os.tmpdir(), 'missing-stdlib-asset.json'),
    ...overrides,
  };
}

async function resolveLocalBinary(
  selectedPath: string,
  dependencies: CapabilityRuntimeIdentityDependencies,
  selectionOrigin: 'default' | 'env_override' | 'explicit' = 'default',
) {
  return resolveCapabilityTraceProcessorIdentity(
    {source: 'local_binary', selectedPath, selectionOrigin},
    dependencies,
  );
}

afterEach(async () => {
  clearCapabilityRuntimeIdentityCaches();
  jest.restoreAllMocks();
  const roots = tempRoots;
  tempRoots = [];
  await Promise.all(roots.map(root => rm(root, {recursive: true, force: true})));
});

describe('managed trace materialization and actual-load source pins', () => {
  const binary = {source: 'bundled' as const, gitRevision: GIT_A, stdlibRevision: GIT_A};
  async function fixture(mode: 'copy' | 'move' = 'copy') {
    const root = await makeTempRoot(), original = path.join(root, 'external.trace'), finalPath = path.join(root, 'managed.trace');
    await writeFile(original, 'immutable trace bytes');
    const grant = mode === 'copy' ? await copyManagedTraceInput({sourcePath: original, finalPath, traceId: 'trace'})
      : await moveManagedTraceInput({tempPath: original, finalPath, traceId: 'trace'});
    expect(grant).toBeDefined();
    const binding = {serviceOwner: {}, registration: {}, traceId: 'trace', finalPath};
    bindManagedTraceInput({...binding, grant: grant!});
    let current = true;
    const assertCurrent = () => {if (!current) throw new Error('PRIVATE_OWNER_CAUSE');};
    const context = {grant: grant!, serviceOwner: binding.serviceOwner, registration: binding.registration, assertCurrent};
    const processorOwner = {};
    const begin = () => beginManagedTraceLoad({...binding, context, processorOwner, binaryIdentity: binary});
    return {root, original, finalPath, grant: grant!, binding, context, processorOwner, begin,
      invalidate: () => {current = false;}, current: {...binding, assertCurrent}};
  }

  it.each(['copy', 'move'] as const)('issues only from a real %s and the same first-load bytes', async mode => {
    const f = await fixture(mode);
    if (mode === 'copy') await writeFile(f.original, 'external file can change after materialization');
    else await expect(fs.promises.stat(f.original)).rejects.toMatchObject({code: 'ENOENT'});
    expect(readLoadedTraceSourcePin(f.processorOwner)).toBeUndefined();
    const attempt = await f.begin(); expect(attempt).toBeDefined();
    const pin = await completeManagedTraceLoad(attempt!, binary); expect(pin).toBeDefined();
    expect(readLoadedTraceSourcePin(f.processorOwner)).toBe(pin);
    await expect(assertLoadedTraceSourcePinCurrent(pin!, f.current)).resolves.toBeUndefined();
    await expect(completeManagedTraceLoad(attempt!, binary)).resolves.toBeUndefined();
    revokeManagedTraceInput(f.grant);
    expect(readLoadedTraceSourcePin(f.processorOwner)).toBeUndefined();
    expect(await fs.promises.readFile(f.finalPath, 'utf8')).toBe('immutable trace bytes');
  });

  it('does not turn a path, copied token, foreign service or registration into a grant', async () => {
    const f = await fixture();
    for (const grant of [{kind: 'managed_trace_input'}, {...f.grant}, JSON.parse(JSON.stringify(f.grant))] as ManagedTraceInputGrant[]) {
      expect(() => bindManagedTraceInput({...f.binding, grant})).toThrow('managed_trace_source_unavailable');
      await expect(beginManagedTraceLoad({...f.binding, processorOwner: {}, binaryIdentity: binary,
        context: {...f.context, grant}})).resolves.toBeUndefined();
    }
    expect(() => bindManagedTraceInput({...f.binding, grant: f.grant})).toThrow('managed_trace_source_unavailable');
    for (const changed of [{serviceOwner: {}}, {registration: {}}, {traceId: 'other'}, {finalPath: f.original}]) {
      await expect(beginManagedTraceLoad({...f.binding, ...changed, context: {...f.context, ...changed},
        processorOwner: {}, binaryIdentity: binary})).resolves.toBeUndefined();
    }
  });

  it.each(['before', 'during', 'after'] as const)('rejects a managed-path replacement %s the actual load', async when => {
    const f = await fixture();
    const replacement = path.join(f.root, 'replacement');
    await writeFile(replacement, 'immutable trace bytes'); // Even identical bytes cannot replace the materialized identity.
    const attempt = when === 'before' ? undefined : await f.begin();
    const pin = when === 'after' ? await completeManagedTraceLoad(attempt!, binary) : undefined;
    await rename(replacement, f.finalPath);
    if (when === 'before') await expect(f.begin()).resolves.toBeUndefined();
    else if (when === 'during') await expect(completeManagedTraceLoad(attempt!, binary)).resolves.toBeUndefined();
    else await expect(assertLoadedTraceSourcePinCurrent(pin!, f.current)).rejects.toMatchObject({code: 'managed_trace_source_unavailable'});
    expect(readLoadedTraceSourcePin(f.processorOwner)).toBeUndefined();
  });

  it.each(['cancel', 'revoke', 'destroy'] as const)('never publishes a late load after %s', async reason => {
    const f = await fixture(), attempt = await f.begin();
    if (reason === 'cancel') f.invalidate();
    else if (reason === 'revoke') revokeManagedTraceInput(f.grant);
    else revokeLoadedTraceSourcePin(f.processorOwner);
    await expect(completeManagedTraceLoad(attempt!, binary)).resolves.toBeUndefined();
    expect(readLoadedTraceSourcePin(f.processorOwner)).toBeUndefined();
  });

  it('rejects a changed binary or documentation pin instead of publishing a new source fact', async () => {
    for (const changed of [{...binary, gitRevision: GIT_B}, {...binary, stdlibRevision: GIT_B},
      {source: 'custom' as const, binarySha256: BINARY_SHA, stdlibRevision: GIT_A}]) {
      const f = await fixture(), attempt = await f.begin();
      await expect(completeManagedTraceLoad(attempt!, changed)).resolves.toBeUndefined();
      expect(readLoadedTraceSourcePin(f.processorOwner)).toBeUndefined();
    }
  });

  it('binds the child to the original live parent pin and rejects copied pins', async () => {
    const f = await fixture(), parentPin = (await completeManagedTraceLoad((await f.begin())!, binary))!;
    for (const sourcePin of [{...parentPin}, JSON.parse(JSON.stringify(parentPin))] as LoadedTraceSourcePin[]) {
      await expect(beginManagedTraceLoad({...f.binding, context: {...f.context, sourcePin}, processorOwner: {},
        binaryIdentity: binary})).resolves.toBeUndefined();
      await expect(assertLoadedTraceSourcePinCurrent(sourcePin, f.current)).rejects.toMatchObject({code: 'managed_trace_source_unavailable'});
    }
    const child = {}, childAttempt = await beginManagedTraceLoad({...f.binding, context: {...f.context, sourcePin: parentPin},
      processorOwner: child, binaryIdentity: binary});
    const childPin = (await completeManagedTraceLoad(childAttempt!, binary))!;
    await expect(assertLoadedTraceSourcePinCurrent(childPin, f.current)).resolves.toBeUndefined();
    revokeLoadedTraceSourcePin(f.processorOwner);
    expect(readLoadedTraceSourcePin(child)).toBeUndefined();
    await expect(assertLoadedTraceSourcePinCurrent(childPin, f.current)).rejects.toMatchObject({code: 'managed_trace_source_unavailable'});
  });

  it('preserves a successful copy without granting source authority when hashing is unavailable', async () => {
    const root = await makeTempRoot(), sourcePath = path.join(root, 'source'), finalPath = path.join(root, 'managed');
    await writeFile(sourcePath, 'retained bytes');
    jest.spyOn(fs.promises, 'open').mockRejectedValueOnce(new Error('PRIVATE_HASH_CAUSE'));
    await expect(copyManagedTraceInput({sourcePath, finalPath, traceId: 'trace'})).resolves.toBeUndefined();
    expect(await fs.promises.readFile(finalPath, 'utf8')).toBe('retained bytes');
  });

  it.each(['copy', 'move'] as const)('does not issue a token when the real %s fails', async mode => {
    const root = await makeTempRoot(), missing = path.join(root, 'missing'), finalPath = path.join(root, 'managed');
    await expect(mode === 'copy' ? copyManagedTraceInput({sourcePath: missing, finalPath, traceId: 'trace'})
      : moveManagedTraceInput({tempPath: missing, finalPath, traceId: 'trace'})).rejects.toMatchObject({code: 'ENOENT'});
    await expect(fs.promises.stat(finalPath)).rejects.toMatchObject({code: 'ENOENT'});
  });
});

describe('CapabilityManifest reported trace processor version sanitizer', () => {
  it.each([
    ['trace_processor v50.1', 'trace_processor v50.1'],
    ['  Perfetto 50.1 (stable)  ', 'Perfetto 50.1 (stable)'],
    ['version: v50.1', 'version: v50.1'],
  ])('accepts a bounded printable single-line value: %p', (value, expected) => {
    expect(sanitizeCapabilityTraceProcessorReportedVersion(value)).toBe(expected);
  });

  it.each([
    ['non-string', 50],
    ['empty', '   '],
    ['line feed', 'v50\n/private/path'],
    ['carriage return', 'v50\r/private/path'],
    ['leading line feed', '\nv50'],
    ['trailing carriage return', 'v50\r'],
    ['control byte', 'v50\u0000'],
    ['overlong', 'v'.repeat(257)],
    ['POSIX path at start', '/Users/private/trace_processor_shell'],
    ['POSIX path after equals', 'path=/private/trace_processor_shell'],
    ['Windows drive path', 'C:\\private\\trace_processor_shell.exe'],
    ['Windows path after semicolon', 'version;C:\\private\\trace_processor_shell.exe'],
    ['UNC path', '\\\\server\\share'],
    ['quoted POSIX path', 'version "/opt/private/trace_processor_shell"'],
    ['parenthesized Windows path', 'version (D:\\private\\trace_processor_shell.exe)'],
  ])('rejects %s without returning a modified unsafe substring', (_name, value) => {
    expect(sanitizeCapabilityTraceProcessorReportedVersion(value)).toBeUndefined();
  });
});

describe('CapabilityManifest trace runtime identity', () => {
  it('hashes the exact trace bytes and preserves already-probed metadata', async () => {
    const root = await makeTempRoot();
    const tracePath = path.join(root, 'trace.pftrace');
    await writeFile(tracePath, 'trace bytes');

    await expect(resolveCapabilityTraceIdentity({
      source: 'local_file',
      filePath: tracePath,
      traceSide: 'reference',
      androidApiLevel: 35,
      machineId: 'device-1',
      clockRangeNs: {startNs: '10', endNs: '20'},
    })).resolves.toEqual({
      status: 'ready',
      identity: {
        fingerprintSha256: TRACE_SHA,
        fingerprintKind: 'trace_bytes_sha256',
        traceSide: 'reference',
        androidApiLevel: 35,
        machineId: 'device-1',
        clockRangeNs: {startNs: '10', endNs: '20'},
      },
    });
  });

  it('invalidates the digest cache when size or mtime changes', async () => {
    const root = await makeTempRoot();
    const tracePath = path.join(root, 'trace.pftrace');
    await writeFile(tracePath, 'trace bytes');
    const first = await resolveCapabilityTraceIdentity({
      source: 'local_file', filePath: tracePath, traceSide: 'current',
    });

    await writeFile(tracePath, 'trace bytes changed');
    const future = new Date(Date.now() + 10_000);
    await utimes(tracePath, future, future);
    const second = await resolveCapabilityTraceIdentity({
      source: 'local_file', filePath: tracePath, traceSide: 'current',
    });

    expect(first.status).toBe('ready');
    expect(second).toEqual({
      status: 'ready',
      identity: expect.objectContaining({
        fingerprintSha256: sha256('trace bytes changed'),
      }),
    });
    expect(second).not.toEqual(first);
  });

  it('uses a verified stat-identity cache and cache clearing forces a re-read', async () => {
    const root = await makeTempRoot();
    const tracePath = path.join(root, 'trace.pftrace');
    await writeFile(tracePath, 'trace bytes');
    const realOpen = fs.promises.open.bind(fs.promises);
    const openSpy = jest.spyOn(fs.promises, 'open');

    await resolveCapabilityTraceIdentity({
      source: 'local_file', filePath: tracePath, traceSide: 'current',
    });
    await resolveCapabilityTraceIdentity({
      source: 'local_file', filePath: tracePath, traceSide: 'current',
    });
    expect(openSpy).toHaveBeenCalledTimes(1);

    clearCapabilityRuntimeIdentityCaches();
    openSpy.mockImplementation(realOpen);
    await resolveCapabilityTraceIdentity({
      source: 'local_file', filePath: tracePath, traceSide: 'current',
    });
    expect(openSpy).toHaveBeenCalledTimes(2);
  });

  it('never exposes the absolute trace path', async () => {
    const root = await makeTempRoot();
    const tracePath = path.join(root, 'secret-trace.pftrace');
    await writeFile(tracePath, 'trace bytes');

    const result = await resolveCapabilityTraceIdentity({
      source: 'local_file', filePath: tracePath, traceSide: 'current',
    });
    expect(JSON.stringify(result)).not.toContain(root);
    expect(JSON.stringify(result)).not.toContain(tracePath);
  });

  it('returns fixed unavailable results for missing local and external traces', async () => {
    const root = await makeTempRoot();
    await expect(resolveCapabilityTraceIdentity({
      source: 'local_file',
      filePath: path.join(root, 'missing.pftrace'),
      traceSide: 'current',
    })).resolves.toMatchObject({
      status: 'unavailable',
      reason: 'trace_file_unavailable',
    });
    await expect(resolveCapabilityTraceIdentity({
      source: 'external_rpc',
      traceSide: 'current',
      traceId: 'must-not-be-hashed',
      port: 9001,
    } as never)).resolves.toEqual({
      status: 'unavailable',
      reason: 'external_rpc_trace_fingerprint_unavailable',
    });
  });

  it('rejects trace symlinks before hashing', async () => {
    const root = await makeTempRoot();
    const targetPath = path.join(root, 'target.pftrace');
    const linkPath = path.join(root, 'link.pftrace');
    await writeFile(targetPath, 'trace bytes');
    await symlink(targetPath, linkPath);

    await expect(resolveCapabilityTraceIdentity({
      source: 'local_file', filePath: linkPath, traceSide: 'current',
    })).resolves.toMatchObject({
      status: 'unavailable',
      reason: 'trace_file_unavailable',
    });
  });

  it('rejects a lstat/open swap and never caches the replacement digest', async () => {
    const root = await makeTempRoot();
    const tracePath = path.join(root, 'trace.pftrace');
    const targetPath = path.join(root, 'target.pftrace');
    await writeFile(tracePath, 'trace bytes');
    await writeFile(targetPath, 'other bytes');
    const realOpen = fs.promises.open.bind(fs.promises);
    jest.spyOn(fs.promises, 'open').mockImplementation(async (filePath, flags, mode) => {
      if (path.resolve(String(filePath)) === tracePath) {
        await rm(tracePath, {force: true});
        await symlink(targetPath, tracePath);
      }
      return realOpen(filePath, flags, mode);
    });

    const result = await resolveCapabilityTraceIdentity({
      source: 'local_file', filePath: tracePath, traceSide: 'current',
    });
    expect(result).toMatchObject({status: 'unavailable'});
    expect(JSON.stringify(result)).not.toContain(sha256('other bytes'));
  });

  it('returns trace_hash_failed after identity changes on both read attempts', async () => {
    const root = await makeTempRoot();
    const tracePath = path.join(root, 'trace.pftrace');
    await writeFile(tracePath, 'trace bytes');
    const realOpen = fs.promises.open.bind(fs.promises);
    let generation = 0;
    jest.spyOn(fs.promises, 'open').mockImplementation(async (filePath, flags, mode) => {
      const handle = await realOpen(filePath, flags, mode);
      if (path.resolve(String(filePath)) !== tracePath) return handle;
      const originalRead = handle.read.bind(handle);
      return Object.assign(handle, {
        read: async (...args: Parameters<typeof handle.read>) => {
          generation++;
          await writeFile(tracePath, `changed-during-read-${generation}`);
          return originalRead(...args);
        },
      });
    });

    await expect(resolveCapabilityTraceIdentity({
      source: 'local_file', filePath: tracePath, traceSide: 'current',
    })).resolves.toEqual({
      status: 'unavailable',
      reason: 'trace_hash_failed',
      detail: 'file_identity_changed',
    });
  });

  it('rejects a cache-hit path replaced by a symlink', async () => {
    const root = await makeTempRoot();
    const tracePath = path.join(root, 'trace.pftrace');
    const targetPath = path.join(root, 'target.pftrace');
    await writeFile(tracePath, 'trace bytes');
    await writeFile(targetPath, 'other bytes');
    await resolveCapabilityTraceIdentity({
      source: 'local_file', filePath: tracePath, traceSide: 'current',
    });
    await rm(tracePath);
    await symlink(targetPath, tracePath);

    await expect(resolveCapabilityTraceIdentity({
      source: 'local_file', filePath: tracePath, traceSide: 'current',
    })).resolves.toMatchObject({
      status: 'unavailable',
      reason: 'trace_file_unavailable',
    });
  });
});

describe('CapabilityManifest trace processor runtime identity', () => {
  it.each(['prebuiltPath', 'bundledPath'] as const)(
    'classifies a matching trusted %s as bundled',
    async slotName => {
      const root = await makeTempRoot();
      const binaryPath = path.join(root, `${slotName}-trace_processor_shell`);
      await writeFile(binaryPath, 'prebuilt binary');
      const pinPath = await writePin(root);

      await expect(resolveLocalBinary(binaryPath, localDependencies({
        canonicalSlotResolver: () => ({[slotName]: binaryPath}),
        pinCandidates: [pinPath],
      }))).resolves.toEqual({
        source: 'bundled',
        gitRevision: GIT_A,
      });
    },
  );

  it('classifies a trusted path with pin mismatch as custom actual bytes', async () => {
    const root = await makeTempRoot();
    const binaryPath = path.join(root, 'trace_processor_shell');
    await writeFile(binaryPath, 'prebuilt binary');
    const pinPath = await writePin(
      root,
      pinText(SHA_KEYS['darwin/arm64'], 'f'.repeat(64)),
    );

    await expect(resolveLocalBinary(binaryPath, localDependencies({
      canonicalSlotResolver: () => ({prebuiltPath: binaryPath}),
      pinCandidates: [pinPath],
    }))).resolves.toMatchObject({
      source: 'custom',
      binarySha256: BINARY_SHA,
    });
  });

  it.each(['backend-bin', 'user-bin', 'env-style']) (
    'classifies readable non-slot %s bytes as custom',
    async directoryName => {
      const root = await makeTempRoot();
      const binaryPath = path.join(root, directoryName, 'trace_processor_shell');
      await fs.promises.mkdir(path.dirname(binaryPath), {recursive: true});
      await writeFile(binaryPath, 'prebuilt binary');
      const pinPath = await writePin(root);

      await expect(resolveLocalBinary(binaryPath, localDependencies({
        canonicalSlotResolver: () => ({
          prebuiltPath: path.join(root, 'trusted-prebuilt'),
          bundledPath: path.join(root, 'trusted-bundled'),
        }),
        pinCandidates: [pinPath],
      }))).resolves.toMatchObject({source: 'custom', binarySha256: BINARY_SHA});
    },
  );

  it.each(['env_override', 'explicit'] as const)(
    'keeps %s at the exact trusted path custom',
    async selectionOrigin => {
      const root = await makeTempRoot();
      const binaryPath = path.join(root, 'trace_processor_shell');
      await writeFile(binaryPath, 'prebuilt binary');
      const pinPath = await writePin(root);

      await expect(resolveLocalBinary(binaryPath, localDependencies({
        canonicalSlotResolver: () => ({prebuiltPath: binaryPath}),
        pinCandidates: [pinPath],
      }), selectionOrigin)).resolves.toMatchObject({
        source: 'custom', binarySha256: BINARY_SHA,
      });
    },
  );

  it('returns closed unknown reasons for external RPC and a missing binary', async () => {
    const root = await makeTempRoot();
    const pinPath = await writePin(root);

    await expect(resolveCapabilityTraceProcessorIdentity(
      {source: 'external_rpc'},
      localDependencies(),
    )).resolves.toEqual({
      source: 'unknown',
      unavailableReason: 'external_rpc_binary_unavailable',
    });
    await expect(resolveLocalBinary(
      path.join(root, 'missing-trace-processor'),
      localDependencies({pinCandidates: [pinPath]}),
    )).resolves.toEqual({
      source: 'unknown',
      unavailableReason: 'trace_processor_binary_unavailable',
    });
  });

  it('returns platform/pin reasons only when no readable binary exists', async () => {
    const root = await makeTempRoot();
    const missingPath = path.join(root, 'missing-trace-processor');
    await expect(resolveLocalBinary(missingPath, localDependencies({
      platform: 'freebsd', arch: 'x64',
    }))).resolves.toEqual({
      source: 'unknown', unavailableReason: 'unsupported_platform',
    });
    await expect(resolveLocalBinary(missingPath, localDependencies({
      pinCandidates: [path.join(root, 'missing-pin.env')],
    }))).resolves.toEqual({
      source: 'unknown', unavailableReason: 'trace_processor_pin_unavailable',
    });

    const readablePath = path.join(root, 'readable-trace-processor');
    await writeFile(readablePath, 'prebuilt binary');
    await expect(resolveLocalBinary(readablePath, localDependencies({
      platform: 'freebsd', arch: 'x64',
    }))).resolves.toMatchObject({source: 'custom', binarySha256: BINARY_SHA});
  });

  it('never executes the selected pathname or reports a local binary version', async () => {
    const root = await makeTempRoot();
    const binaryPath = path.join(root, 'trace_processor_shell');
    await writeFile(binaryPath, 'prebuilt binary');
    const pinPath = await writePin(root);
    const versionRunner = jest.fn(async () => ({
      stdout: `trace_processor ${binaryPath}`,
    }));
    const hostileDependencies = {
      ...localDependencies({
        canonicalSlotResolver: () => ({prebuiltPath: binaryPath}),
        pinCandidates: [pinPath],
      }),
      versionRunner,
    } as CapabilityRuntimeIdentityDependencies;

    const bundled = await resolveLocalBinary(binaryPath, hostileDependencies);
    const custom = await resolveLocalBinary(
      binaryPath,
      hostileDependencies,
      'explicit',
    );

    expect(versionRunner).not.toHaveBeenCalled();
    expect(bundled).toEqual({source: 'bundled', gitRevision: GIT_A});
    expect(custom).toEqual({source: 'custom', binarySha256: BINARY_SHA});
    expect(bundled).not.toHaveProperty('reportedVersion');
    expect(custom).not.toHaveProperty('reportedVersion');
  });

  it('adds only a valid stdlib asset revision', async () => {
    const root = await makeTempRoot();
    const binaryPath = path.join(root, 'trace_processor_shell');
    await writeFile(binaryPath, 'prebuilt binary');
    const validAsset = await writeStdlibAsset(root);

    await expect(resolveLocalBinary(binaryPath, localDependencies({
      stdlibAssetPath: validAsset,
    }))).resolves.toMatchObject({stdlibRevision: GIT_B});
    await writeFile(validAsset, JSON.stringify({version: 1, generatedFrom: 'not-a-git-revision'}));
    clearCapabilityRuntimeIdentityCaches();
    const malformed = await resolveLocalBinary(binaryPath, localDependencies({
      stdlibAssetPath: validAsset,
    }));
    expect(malformed).not.toHaveProperty('stdlibRevision');
    const missing = await resolveLocalBinary(binaryPath, localDependencies({
      stdlibAssetPath: path.join(root, 'missing.json'),
    }));
    expect(missing).not.toHaveProperty('stdlibRevision');
  });

  it.each(Object.entries(SHA_KEYS))(
    'maps %s to the exact supported pin key',
    async (platformArch, shaKey) => {
      const root = await makeTempRoot();
      const binaryPath = path.join(root, 'trace_processor_shell');
      await writeFile(binaryPath, 'prebuilt binary');
      const pinPath = await writePin(root, pinText(shaKey));
      const [platform, arch] = platformArch.split('/') as [NodeJS.Platform, string];

      await expect(resolveLocalBinary(binaryPath, localDependencies({
        platform,
        arch,
        canonicalSlotResolver: () => ({prebuiltPath: binaryPath}),
        pinCandidates: [pinPath],
      }))).resolves.toMatchObject({source: 'bundled', gitRevision: GIT_A});
    },
  );

  it('supports source and dist candidate layouts without merging candidates', async () => {
    const root = await makeTempRoot();
    const binaryPath = path.join(root, 'trace_processor_shell');
    await writeFile(binaryPath, 'prebuilt binary');
    const sourcePin = await writePin(root, pinText(SHA_KEYS['darwin/arm64']), 'source-pin.env');
    const distPin = await writePin(root, pinText(SHA_KEYS['darwin/arm64']), 'dist-pin.env');
    const trusted = {canonicalSlotResolver: () => ({prebuiltPath: binaryPath})};

    await expect(resolveLocalBinary(binaryPath, localDependencies({
      ...trusted,
      pinCandidates: [path.join(root, 'missing-source.env'), distPin],
    }))).resolves.toMatchObject({source: 'bundled'});
    clearCapabilityRuntimeIdentityCaches();
    await expect(resolveLocalBinary(binaryPath, localDependencies({
      ...trusted,
      pinCandidates: [sourcePin, distPin],
    }))).resolves.toMatchObject({source: 'bundled'});
  });

  it.each([
    ['malformed line', `PERFETTO_VERSION=${GIT_A}\nnot an assignment\n${SHA_KEYS['darwin/arm64']}=${BINARY_SHA}\n`],
    ['malformed version', `PERFETTO_VERSION=not-a-revision\n${SHA_KEYS['darwin/arm64']}=${BINARY_SHA}\n`],
    ['malformed current SHA', `PERFETTO_VERSION=${GIT_A}\n${SHA_KEYS['darwin/arm64']}=not-a-sha\n`],
    ['duplicate SHA', `${pinText(SHA_KEYS['darwin/arm64'])}${SHA_KEYS['darwin/arm64']}=${BINARY_SHA}\n`],
    ['duplicate version', `${pinText(SHA_KEYS['darwin/arm64'])}PERFETTO_VERSION=${GIT_A}\n`],
    ['missing current SHA', `PERFETTO_VERSION=${GIT_A}\n`],
    ['unknown key', `${pinText(SHA_KEYS['darwin/arm64'])}SECRET_PATH=/private/tmp\n`],
  ])('never bundles a pin file with %s', async (_name, contents) => {
    const root = await makeTempRoot();
    const binaryPath = path.join(root, 'trace_processor_shell');
    await writeFile(binaryPath, 'prebuilt binary');
    const pinPath = await writePin(root, contents);

    await expect(resolveLocalBinary(binaryPath, localDependencies({
      canonicalSlotResolver: () => ({prebuiltPath: binaryPath}),
      pinCandidates: [pinPath],
    }))).resolves.toMatchObject({source: 'custom', binarySha256: BINARY_SHA});
  });

  it('never bundles conflicting candidate pins', async () => {
    const root = await makeTempRoot();
    const binaryPath = path.join(root, 'trace_processor_shell');
    await writeFile(binaryPath, 'prebuilt binary');
    const first = await writePin(root, pinText(SHA_KEYS['darwin/arm64']), 'source-pin.env');
    const second = await writePin(
      root,
      pinText(SHA_KEYS['darwin/arm64'], BINARY_SHA, GIT_B),
      'dist-pin.env',
    );

    await expect(resolveLocalBinary(binaryPath, localDependencies({
      canonicalSlotResolver: () => ({prebuiltPath: binaryPath}),
      pinCandidates: [first, second],
    }))).resolves.toMatchObject({source: 'custom', binarySha256: BINARY_SHA});
  });

  it('rejects binary symlinks and path swaps without exposing or caching bytes', async () => {
    const root = await makeTempRoot();
    const binaryPath = path.join(root, 'trace_processor_shell');
    const targetPath = path.join(root, 'target-trace_processor_shell');
    await writeFile(targetPath, 'prebuilt binary');
    await symlink(targetPath, binaryPath);
    const pinPath = await writePin(root);

    const linked = await resolveLocalBinary(binaryPath, localDependencies({
      canonicalSlotResolver: () => ({prebuiltPath: binaryPath}),
      pinCandidates: [pinPath],
    }));
    expect(linked).toMatchObject({source: 'unknown'});
    expect(JSON.stringify(linked)).not.toContain(root);

    await rm(binaryPath);
    await writeFile(binaryPath, 'prebuilt binary');
    const realOpen = fs.promises.open.bind(fs.promises);
    jest.spyOn(fs.promises, 'open').mockImplementation(async (filePath, flags, mode) => {
      if (path.resolve(String(filePath)) === binaryPath) {
        const replacement = path.join(root, `replacement-${Date.now()}`);
        await writeFile(replacement, `replacement-${Date.now()}`);
        await rename(replacement, binaryPath);
      }
      return realOpen(filePath, flags, mode);
    });
    clearCapabilityRuntimeIdentityCaches();
    const swapped = await resolveLocalBinary(binaryPath, localDependencies({
      canonicalSlotResolver: () => ({prebuiltPath: binaryPath}),
      pinCandidates: [pinPath],
    }));
    expect(swapped).toMatchObject({source: 'unknown'});
    expect(JSON.stringify(swapped)).not.toContain(root);
  });

  it('rejects a binary cache-hit path replaced by a symlink', async () => {
    const root = await makeTempRoot();
    const binaryPath = path.join(root, 'trace_processor_shell');
    const targetPath = path.join(root, 'replacement-trace_processor_shell');
    await writeFile(binaryPath, 'prebuilt binary');
    await writeFile(targetPath, 'other bytes');
    const pinPath = await writePin(root);
    const dependencies = localDependencies({pinCandidates: [pinPath]});
    await resolveLocalBinary(binaryPath, dependencies);
    await rm(binaryPath);
    await symlink(targetPath, binaryPath);

    await expect(resolveLocalBinary(binaryPath, dependencies)).resolves.toEqual({
      source: 'unknown',
      unavailableReason: 'trace_processor_binary_unavailable',
    });
  });

  it('never exposes binary, pin, or stdlib paths in any output', async () => {
    const root = await makeTempRoot();
    const binaryPath = path.join(root, 'private-trace-processor');
    const pinPath = path.join(root, 'private-pin.env');
    const stdlibAssetPath = path.join(root, 'private-stdlib.json');
    await writeFile(binaryPath, 'prebuilt binary');
    await writeFile(pinPath, 'malformed private pin');
    await writeFile(stdlibAssetPath, '{malformed private json');

    const result = await resolveLocalBinary(binaryPath, localDependencies({
      canonicalSlotResolver: () => ({prebuiltPath: binaryPath}),
      pinCandidates: [pinPath],
      stdlibAssetPath,
    }));
    const output = JSON.stringify(result);
    expect(output).not.toContain(root);
    expect(output).not.toContain(binaryPath);
    expect(output).not.toContain(pinPath);
    expect(output).not.toContain(stdlibAssetPath);
  });
});
