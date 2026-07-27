// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import fs from 'fs';

const DEFAULT_POLL_INTERVAL_MS = 100;

export interface RuntimeShutdownControlOptions {
  shutdownFile?: string;
  pollIntervalMs?: number;
}

export function installRuntimeShutdownControl(
  onShutdown: (reason: string) => void,
  options: RuntimeShutdownControlOptions = {},
): () => void {
  const shutdownFile = (
    options.shutdownFile ??
    process.env.SMARTPERFETTO_SHUTDOWN_FILE ??
    ''
  ).trim();
  if (!shutdownFile) return () => undefined;

  let stopped = false;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
  };
  const timer = setInterval(() => {
    try {
      const stat = fs.lstatSync(shutdownFile);
      if (!stat.isFile() || stat.isSymbolicLink()) return;
      stop();
      onShutdown('launcher-control-file');
    } catch (error: any) {
      if (error?.code !== 'ENOENT') {
        console.warn(
          `[ShutdownControl] Cannot inspect ${shutdownFile}:`,
          error?.message || error,
        );
      }
    }
  }, options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS);
  timer.unref();
  return stop;
}
