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
  type CapabilityRuntimeIdentityDependencies,
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
    'PERFETTO_LUCI_URL_BASE=https://example.invalid/perfetto',
    `${key}=${binarySha}`,
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
