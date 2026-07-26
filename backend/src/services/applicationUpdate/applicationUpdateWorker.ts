// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {resolveApplicationBuildIdentity} from './buildIdentity';
import {
  getApplicationUpdateService,
  type ApplicationUpdateService,
} from './applicationUpdateService';
import type {ApplicationBuildIdentity} from './types';

const DEFAULT_INTERVAL_MS = 24 * 60 * 60 * 1_000;
const DEFAULT_RETRY_MS = 15 * 60 * 1_000;
const MINIMUM_INTERVAL_MS = 60_000;

export interface ApplicationUpdateWorkerHandle {
  started: boolean;
  stop(): void;
}

export interface ApplicationUpdateWorkerOptions {
  env?: NodeJS.ProcessEnv;
  identity?: ApplicationBuildIdentity;
  service?: Pick<ApplicationUpdateService, 'checkNow'>;
}

function configuredInterval(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
): number {
  const parsed = Number(env[name]);
  return Number.isFinite(parsed) && parsed >= MINIMUM_INTERVAL_MS
    ? Math.trunc(parsed)
    : fallback;
}

export function startApplicationUpdateWorker(
  options: ApplicationUpdateWorkerOptions = {},
): ApplicationUpdateWorkerHandle {
  const env = options.env ?? process.env;
  if (env.NODE_ENV === 'test') {
    return {started: false, stop() {}};
  }
  const disabled = env.SMARTPERFETTO_UPDATE_CHECK?.trim().toLowerCase();
  if (
    disabled === 'off' ||
    disabled === '0' ||
    disabled === 'false' ||
    disabled === 'disabled'
  ) {
    return {started: false, stop() {}};
  }

  const service = options.service ?? getApplicationUpdateService();
  const identity = options.identity ?? resolveApplicationBuildIdentity(env);
  const normalDelay = configuredInterval(
    env,
    'SMARTPERFETTO_UPDATE_CHECK_INTERVAL_MS',
    DEFAULT_INTERVAL_MS,
  );
  const retryDelay = configuredInterval(
    env,
    'SMARTPERFETTO_UPDATE_CHECK_RETRY_MS',
    DEFAULT_RETRY_MS,
  );
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;

  const schedule = (delay: number): void => {
    if (stopped) return;
    timer = setTimeout(check, delay);
    timer.unref?.();
  };
  const check = (): void => {
    if (stopped) return;
    void service.checkNow(identity).then(
      status => {
        schedule(
          status.state === 'error' || status.stale
            ? retryDelay
            : normalDelay,
        );
      },
      error => {
        console.warn(
          '[ApplicationUpdate] Background check failed:',
          error instanceof Error ? error.message : error,
        );
        schedule(retryDelay);
      },
    );
  };

  schedule(0);
  return {
    started: true,
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}
