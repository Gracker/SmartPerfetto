// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {constants as fsConstants} from 'fs';
import * as fsPromises from 'fs/promises';
import * as path from 'path';

function normalizeIdentity(value: string): string {
  const resolved = path.resolve(value);
  return process.platform === 'win32'
    ? resolved.toLocaleLowerCase('en-US')
    : resolved;
}

function sameFileIdentity(
  before: Awaited<ReturnType<typeof fsPromises.lstat>>,
  opened: Awaited<ReturnType<Awaited<ReturnType<typeof fsPromises.open>>['stat']>>,
  platform: NodeJS.Platform,
): boolean {
  const inodeMatches = platform === 'win32'
    ? before.ino !== 0 && opened.ino !== 0 && before.ino === opened.ino
    : before.ino === 0 || opened.ino === 0 || before.ino === opened.ino;
  return before.isFile() &&
    opened.isFile() &&
    before.dev === opened.dev &&
    inodeMatches &&
    before.size === opened.size &&
    before.mtimeMs === opened.mtimeMs;
}

interface BoundedMetadataFileInput {
  filePath: string;
  maxBytes: number;
  expectedRealpath?: string;
  deadline?: number;
  platform?: NodeJS.Platform;
}

export class SourceMetadataDeadlineExceededError extends Error {
  constructor() {
    super('source_metadata_time_budget');
    this.name = 'SourceMetadataDeadlineExceededError';
  }
}

async function readBoundedMetadataFileOperation(input: BoundedMetadataFileInput): Promise<string> {
  const platform = input.platform ?? process.platform;
  const assertWithinDeadline = (): void => {
    if (input.deadline !== undefined && Date.now() >= input.deadline) {
      throw new SourceMetadataDeadlineExceededError();
    }
  };
  assertWithinDeadline();
  const expectedRealpath = input.expectedRealpath ?? await fsPromises.realpath(input.filePath);
  const before = await fsPromises.lstat(input.filePath);
  if (!before.isFile() || before.isSymbolicLink()) {
    throw new Error('source_metadata_not_regular_file');
  }
  if (before.size > input.maxBytes) throw new Error('source_metadata_too_large');
  if (normalizeIdentity(await fsPromises.realpath(input.filePath)) !== normalizeIdentity(expectedRealpath)) {
    throw new Error('source_metadata_identity_changed');
  }
  assertWithinDeadline();
  const openFlags = platform === 'win32'
    ? fsConstants.O_RDONLY
    : fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK;
  const handle = await fsPromises.open(
    input.filePath,
    openFlags,
  );
  try {
    assertWithinDeadline();
    const opened = await handle.stat();
    if (!sameFileIdentity(before, opened, platform) || opened.size > input.maxBytes) {
      throw new Error('source_metadata_identity_changed');
    }
    const buffer = Buffer.alloc(input.maxBytes + 1);
    let bytesRead = 0;
    while (bytesRead < buffer.length) {
      assertWithinDeadline();
      const read = await handle.read(buffer, bytesRead, buffer.length - bytesRead, bytesRead);
      if (read.bytesRead === 0) break;
      bytesRead += read.bytesRead;
    }
    if (bytesRead > input.maxBytes) throw new Error('source_metadata_too_large');
    const after = await handle.stat();
    if (!sameFileIdentity(before, after, platform) || after.size !== opened.size) {
      throw new Error('source_metadata_identity_changed');
    }
    if (normalizeIdentity(await fsPromises.realpath(input.filePath)) !== normalizeIdentity(expectedRealpath)) {
      throw new Error('source_metadata_identity_changed');
    }
    assertWithinDeadline();
    return buffer.subarray(0, bytesRead).toString('utf8');
  } finally {
    await handle.close();
  }
}

export async function readBoundedMetadataFile(input: BoundedMetadataFileInput): Promise<string> {
  const operation = readBoundedMetadataFileOperation(input);
  if (input.deadline === undefined) return operation;

  const remainingMs = Math.max(0, input.deadline - Date.now());
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new SourceMetadataDeadlineExceededError()), remainingMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
    void operation.catch(() => undefined);
  }
}
