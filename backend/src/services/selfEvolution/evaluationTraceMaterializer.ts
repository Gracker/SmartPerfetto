// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {createHash, randomUUID} from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';

import type {
  EvalCaseV1,
  RunManifestScope,
} from '../../types/selfEvolution';
import type {
  EvalCaseStore,
  OpenedManagedTraceCorpus,
} from './evalCaseStore';

const COPY_BUFFER_BYTES = 1024 * 1024;

export class EvaluationReplayUnavailableError extends Error {
  readonly code: string;

  constructor(code: string, details?: string) {
    super(details ? `${code}:${details}` : code);
    this.name = 'EvaluationReplayUnavailableError';
    this.code = code;
  }
}

export interface EvaluationCatalogAliasResolver {
  open(input: {
    scope: RunManifestScope;
    alias: string;
    expectedContentHash: string;
  }): OpenedManagedTraceCorpus | undefined;
}

export interface MaterializedEvaluationTrace {
  role: 'current' | 'reference';
  traceId: string;
  leaseId: string;
  filePath: string;
  contentHash: string;
  sizeBytes: number;
}

export interface MaterializedEvaluationTraceSet {
  directory: string;
  traces: MaterializedEvaluationTrace[];
  cleanup(): void;
}

function destinationFlags(): number {
  return fs.constants.O_WRONLY
    | fs.constants.O_CREAT
    | fs.constants.O_EXCL
    | (fs.constants.O_NOFOLLOW ?? 0);
}

function openSource(input: {
  evalCaseStore: EvalCaseStore;
  aliasResolver?: EvaluationCatalogAliasResolver;
  scope: RunManifestScope;
  trace: EvalCaseV1['traces'][number];
}): OpenedManagedTraceCorpus | undefined {
  if (input.trace.corpusId) {
    return input.evalCaseStore.openTrace(
      input.scope,
      input.trace.corpusId,
    );
  }
  if (input.trace.catalogAlias) {
    return input.aliasResolver?.open({
      scope: input.scope,
      alias: input.trace.catalogAlias,
      expectedContentHash: input.trace.contentHash,
    });
  }
  return undefined;
}

function copyVerifiedDescriptor(input: {
  descriptor: number;
  targetPath: string;
  expectedContentHash: string;
  expectedSizeBytes: number;
}): void {
  const target = fs.openSync(input.targetPath, destinationFlags(), 0o600);
  const hash = createHash('sha256');
  const buffer = Buffer.allocUnsafe(COPY_BUFFER_BYTES);
  let sourcePosition = 0;
  try {
    for (;;) {
      const bytesRead = fs.readSync(
        input.descriptor,
        buffer,
        0,
        buffer.length,
        sourcePosition,
      );
      if (bytesRead === 0) break;
      const chunk = buffer.subarray(0, bytesRead);
      hash.update(chunk);
      let written = 0;
      while (written < bytesRead) {
        written += fs.writeSync(
          target,
          chunk,
          written,
          bytesRead - written,
        );
      }
      sourcePosition += bytesRead;
    }
    fs.fsyncSync(target);
  } finally {
    fs.closeSync(target);
  }
  if (
    sourcePosition !== input.expectedSizeBytes
    || hash.digest('hex') !== input.expectedContentHash
  ) {
    throw new EvaluationReplayUnavailableError(
      'trace_missing',
      'verified_trace_copy_mismatch',
    );
  }
}

export function materializeEvaluationTraces(input: {
  evalCaseStore: EvalCaseStore;
  aliasResolver?: EvaluationCatalogAliasResolver;
  evalCase: EvalCaseV1;
}): MaterializedEvaluationTraceSet {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'smartperfetto-eval-trace-'),
  );
  fs.chmodSync(directory, 0o700);
  const traces: MaterializedEvaluationTrace[] = [];
  try {
    for (const trace of input.evalCase.traces) {
      const opened = openSource({
        evalCaseStore: input.evalCaseStore,
        aliasResolver: input.aliasResolver,
        scope: input.evalCase.scope,
        trace,
      });
      if (!opened) {
        throw new EvaluationReplayUnavailableError(
          'trace_missing',
          trace.corpusId ?? trace.catalogAlias ?? trace.role,
        );
      }
      try {
        if (opened.record.contentHash !== trace.contentHash) {
          throw new EvaluationReplayUnavailableError(
            'trace_missing',
            'trace_content_hash_mismatch',
          );
        }
        const filePath = path.join(directory, `${trace.role}.pftrace`);
        copyVerifiedDescriptor({
          descriptor: opened.fileDescriptor,
          targetPath: filePath,
          expectedContentHash: trace.contentHash,
          expectedSizeBytes: opened.record.sizeBytes,
        });
        traces.push({
          role: trace.role,
          traceId: `eval-${trace.role}-${randomUUID()}`,
          leaseId: `eval-lease-${randomUUID()}`,
          filePath,
          contentHash: trace.contentHash,
          sizeBytes: opened.record.sizeBytes,
        });
      } finally {
        opened.close();
      }
    }
    return {
      directory,
      traces,
      cleanup: () => {
        fs.rmSync(directory, {recursive: true, force: true});
      },
    };
  } catch (error) {
    fs.rmSync(directory, {recursive: true, force: true});
    throw error;
  }
}
