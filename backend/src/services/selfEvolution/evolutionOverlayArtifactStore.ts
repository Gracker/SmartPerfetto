// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import * as fs from 'fs';
import * as path from 'path';

import {userDataPath} from '../../runtimePaths';
import type {
  EvolutionOverlayArtifactV1,
  SelfEvolutionPersistenceCapability,
} from '../../types/selfEvolution';
import {atomicWriteFileSync} from '../../utils/atomicFileWriter';
import {canonicalJsonString} from './canonicalJson';
import {parseEvolutionOverlayArtifactV1} from './evolutionOverlayContract';

export interface EvolutionOverlayArtifactStoreOptions {
  rootDirectory?: string;
  persistence: SelfEvolutionPersistenceCapability;
}

export interface StoredEvolutionOverlayArtifactV1 {
  artifact: EvolutionOverlayArtifactV1;
  filePath: string;
  created: boolean;
}

export class EvolutionOverlayArtifactStore {
  private readonly rootDirectory: string;

  constructor(private readonly options: EvolutionOverlayArtifactStoreOptions) {
    this.rootDirectory = path.resolve(
      options.rootDirectory
        ?? userDataPath('self_improve', 'overlays', 'objects'),
    );
  }

  put(value: EvolutionOverlayArtifactV1): StoredEvolutionOverlayArtifactV1 {
    this.assertWritable();
    const artifact = parseEvolutionOverlayArtifactV1(value);
    const filePath = this.pathForContentHash(artifact.contentHash);
    const content = `${canonicalJsonString(artifact)}\n`;

    this.ensureSafeDirectory(this.rootDirectory);
    this.ensureSafeDirectory(path.dirname(filePath));
    if (fs.existsSync(filePath)) {
      this.assertRegularFile(filePath);
      if (fs.readFileSync(filePath, 'utf8') !== content) {
        throw new Error('evolution_overlay_artifact_immutable_collision');
      }
      return {artifact: this.load(artifact.contentHash), filePath, created: false};
    }

    atomicWriteFileSync(filePath, content);
    fs.chmodSync(filePath, 0o600);
    return {artifact: this.load(artifact.contentHash), filePath, created: true};
  }

  load(contentHash: string): EvolutionOverlayArtifactV1 {
    const filePath = this.pathForContentHash(contentHash);
    if (!fs.existsSync(filePath)) {
      throw new Error('evolution_overlay_artifact_not_found');
    }
    this.assertRegularFile(filePath);
    return parseEvolutionOverlayArtifactV1(
      JSON.parse(fs.readFileSync(filePath, 'utf8')),
    );
  }

  has(contentHash: string): boolean {
    const filePath = this.pathForContentHash(contentHash);
    if (!fs.existsSync(filePath)) return false;
    this.assertRegularFile(filePath);
    return true;
  }

  pathForContentHash(contentHash: string): string {
    if (!/^[0-9a-f]{64}$/.test(contentHash)) {
      throw new Error('evolution_overlay_artifact_hash_invalid');
    }
    return path.join(
      this.rootDirectory,
      contentHash.slice(0, 2),
      `${contentHash}.json`,
    );
  }

  private assertWritable(): void {
    if (this.options.persistence.persistence !== 'available') {
      throw new Error('self_evolution_persistence_unavailable');
    }
  }

  private ensureSafeDirectory(directory: string): void {
    const missing: string[] = [];
    let cursor = directory;
    while (!fs.existsSync(cursor)) {
      missing.push(cursor);
      const parent = path.dirname(cursor);
      if (parent === cursor) {
        throw new Error('evolution_overlay_artifact_root_unavailable');
      }
      cursor = parent;
    }
    if (!fs.statSync(cursor).isDirectory() || fs.lstatSync(cursor).isSymbolicLink()) {
      throw new Error('evolution_overlay_artifact_symlink_not_allowed');
    }
    for (const entry of missing.reverse()) {
      fs.mkdirSync(entry, {mode: 0o700});
      if (fs.lstatSync(entry).isSymbolicLink()) {
        throw new Error('evolution_overlay_artifact_symlink_not_allowed');
      }
    }
  }

  private assertRegularFile(filePath: string): void {
    const rootWithSeparator = `${this.rootDirectory}${path.sep}`;
    if (!path.resolve(filePath).startsWith(rootWithSeparator)) {
      throw new Error('evolution_overlay_artifact_path_escape');
    }
    const relative = path.relative(this.rootDirectory, filePath);
    let cursor = this.rootDirectory;
    for (const segment of relative.split(path.sep)) {
      cursor = path.join(cursor, segment);
      const stats = fs.lstatSync(cursor);
      if (stats.isSymbolicLink()) {
        throw new Error('evolution_overlay_artifact_symlink_not_allowed');
      }
    }
    if (!fs.statSync(filePath).isFile()) {
      throw new Error('evolution_overlay_artifact_not_regular_file');
    }
  }
}
