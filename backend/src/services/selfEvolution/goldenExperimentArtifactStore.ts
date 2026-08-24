// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {randomUUID} from 'crypto';
import fs from 'fs';
import path from 'path';

import {canonicalJsonString} from './canonicalJson';
import type {GoldenExperimentManifestV1} from './goldenExperimentContracts';
import type {
  GoldenExperimentArtifactWriter,
  GoldenExperimentCellResultV1,
  GoldenExperimentSummaryV1,
} from './goldenExperimentRunner';
import type {EvaluationUsageReceiptV1} from './evaluationTelemetry';

const EXPERIMENT_ID = /^gx-[0-9a-f]{32}$/;
const CELL_ID = /^[0-9a-f]{64}$/;

function contained(root: string, target: string): string {
  const resolved = path.resolve(target);
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
    throw new Error('golden_experiment_artifact_path_escape');
  }
  return resolved;
}

function ensureDirectory(root: string, target: string): string {
  const directory = contained(root, target);
  fs.mkdirSync(directory, {recursive: true, mode: 0o700});
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error('golden_experiment_artifact_directory_invalid');
  }
  const relative = path.relative(root, directory);
  const expectedRealPath = path.resolve(fs.realpathSync(root), relative);
  if (fs.realpathSync(directory) !== expectedRealPath) {
    throw new Error('golden_experiment_artifact_directory_invalid');
  }
  return directory;
}

function atomicWrite(filePath: string, content: string): void {
  const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, content, {encoding: 'utf8', mode: 0o600});
    fs.renameSync(temporary, filePath);
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}

function json(value: unknown): string {
  return `${canonicalJsonString(value)}\n`;
}

function summaryMarkdown(summary: GoldenExperimentSummaryV1): string {
  const lines = [
    '# Golden experiment summary',
    '',
    `- Cells: ${summary.cells.total}`,
    `- Completed: ${summary.cells.completed}`,
    `- Failed: ${summary.cells.failed}`,
    `- Inconclusive: ${summary.cells.inconclusive}`,
    `- Unavailable: ${summary.cells.unavailable}`,
    `- Improved: ${summary.comparison.improved}`,
    `- Regressed: ${summary.comparison.regressed}`,
    `- Unchanged: ${summary.comparison.unchanged}`,
    `- Not evaluable: ${summary.comparison.notEvaluable}`,
    '',
  ];
  return lines.join('\n');
}

export class GoldenExperimentArtifactStore
implements GoldenExperimentArtifactWriter {
  private readonly root: string;

  constructor(options: {root: string}) {
    if (!options.root?.trim()) {
      throw new Error('golden_experiment_artifact_root_invalid');
    }
    this.root = path.resolve(options.root);
    ensureDirectory(this.root, this.root);
  }

  writeManifest(manifest: GoldenExperimentManifestV1): void {
    if (!EXPERIMENT_ID.test(manifest.experimentId)) {
      throw new Error('golden_experiment_id_invalid');
    }
    const directory = ensureDirectory(
      this.root,
      path.join(this.root, manifest.experimentId),
    );
    atomicWrite(path.join(directory, 'manifest.json'), json(manifest));
  }

  writeCell(input: {
    experimentId: string;
    result: GoldenExperimentCellResultV1;
    usageReceipt?: EvaluationUsageReceiptV1;
  }): void {
    if (
      !EXPERIMENT_ID.test(input.experimentId)
      || !CELL_ID.test(input.result.cellId)
    ) {
      throw new Error('golden_experiment_artifact_identity_invalid');
    }
    if (
      input.result.reason
      && !/^[a-z][a-z0-9_:-]{0,159}$/.test(input.result.reason)
    ) {
      throw new Error('golden_experiment_artifact_reason_invalid');
    }
    const directory = ensureDirectory(this.root, path.join(
      this.root,
      input.experimentId,
      'cells',
      input.result.cellId,
    ));
    atomicWrite(path.join(directory, 'score.json'), json({
      schemaVersion: 1,
      cellId: input.result.cellId,
      status: input.result.status,
      ...(input.result.reason ? {reason: input.result.reason} : {}),
      ...(input.result.goldenScore
        ? {goldenScore: input.result.goldenScore}
        : {}),
      ...(input.result.semanticScore
        ? {semanticScore: input.result.semanticScore}
        : {}),
      contentHash: input.result.contentHash,
    }));
    if (input.result.observationReceipt) {
      atomicWrite(
        path.join(directory, 'observation-receipt.json'),
        json(input.result.observationReceipt),
      );
    }
    if (input.usageReceipt) {
      atomicWrite(
        path.join(directory, 'usage-receipt.json'),
        json(input.usageReceipt),
      );
    }
    if (input.result.runtimeReceipt) {
      atomicWrite(
        path.join(directory, 'runtime-receipt.json'),
        json(input.result.runtimeReceipt),
      );
    }
  }

  writeSummary(input: {
    experimentId: string;
    summary: GoldenExperimentSummaryV1;
  }): void {
    if (!EXPERIMENT_ID.test(input.experimentId)) {
      throw new Error('golden_experiment_id_invalid');
    }
    const directory = ensureDirectory(
      this.root,
      path.join(this.root, input.experimentId),
    );
    atomicWrite(path.join(directory, 'summary.json'), json(input.summary));
    atomicWrite(
      path.join(directory, 'summary.md'),
      summaryMarkdown(input.summary),
    );
  }
}
