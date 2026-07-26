// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import fs from 'fs';
import path from 'path';
import {atomicWriteFileSync} from '../utils/atomicFileWriter';
import {
  ApplicationUpdateService,
} from '../services/applicationUpdate/applicationUpdateService';
import {resolveApplicationBuildIdentity} from '../services/applicationUpdate/buildIdentity';
import type {ApplicationUpdateStatus} from '../services/applicationUpdate/types';
import {bootstrap, type BootstrapOptions} from './bootstrap';

const NOTICE_INTERVAL_MS = 24 * 60 * 60 * 1_000;

interface NoticeReceipt {
  schemaVersion: 1;
  latestVersion: string;
  shownAt: string;
}

export interface CliUpdateNotice {
  flush(): void;
}

export interface CliUpdateNoticeOptions {
  argv?: string[];
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
  stdoutIsTTY?: boolean;
  stderrIsTTY?: boolean;
  service?: Pick<ApplicationUpdateService, 'getStatus'>;
  bootstrapOptions?: BootstrapOptions;
  write?: (message: string) => void;
}

function isCi(env: NodeJS.ProcessEnv): boolean {
  return Boolean(
    env.CI ||
    env.CONTINUOUS_INTEGRATION ||
    env.GITHUB_ACTIONS ||
    env.BUILDKITE ||
    env.TF_BUILD,
  );
}

function argvAllowsNotice(argv: string[]): boolean {
  const args = argv.slice(2);
  if (
    args.includes('--help') ||
    args.includes('-h') ||
    args.includes('--version') ||
    args.includes('-V') ||
    args[0] === 'update' ||
    args.includes('--json')
  ) {
    return false;
  }
  const formatIndex = args.indexOf('--format');
  return formatIndex < 0 || args[formatIndex + 1] === 'text';
}

function readReceipt(file: string): NoticeReceipt | undefined {
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<NoticeReceipt>;
    if (
      value.schemaVersion === 1 &&
      typeof value.latestVersion === 'string' &&
      typeof value.shownAt === 'string' &&
      Number.isFinite(Date.parse(value.shownAt))
    ) {
      return {
        schemaVersion: 1,
        latestVersion: value.latestVersion,
        shownAt: new Date(value.shownAt).toISOString(),
      };
    }
  } catch {
    // A missing or invalid receipt should never affect the command.
  }
  return undefined;
}

function shouldShow(
  status: ApplicationUpdateStatus,
  receipt: NoticeReceipt | undefined,
  now: Date,
): boolean {
  const latest = status.latest?.version;
  if (status.state !== 'update_available' || !latest) return false;
  if (!receipt || receipt.latestVersion !== latest) return true;
  return now.getTime() - Date.parse(receipt.shownAt) >= NOTICE_INTERVAL_MS;
}

export function beginCliUpdateNotice(
  options: CliUpdateNoticeOptions = {},
): CliUpdateNotice {
  const env = options.env ?? process.env;
  const argv = options.argv ?? process.argv;
  const stdoutIsTTY = options.stdoutIsTTY ?? Boolean(process.stdout.isTTY);
  const stderrIsTTY = options.stderrIsTTY ?? Boolean(process.stderr.isTTY);
  if (
    !stdoutIsTTY ||
    !stderrIsTTY ||
    isCi(env) ||
    !argvAllowsNotice(argv)
  ) {
    return {flush() {}};
  }

  let home: string;
  try {
    home = bootstrap(options.bootstrapOptions).paths.home;
  } catch {
    return {flush() {}};
  }
  const identity = resolveApplicationBuildIdentity(env, {
    distribution: 'npm',
    channel: 'stable',
    signingMode: 'npm-registry',
  });
  const service = options.service ?? new ApplicationUpdateService({env});
  service.getStatus(identity);
  const write = options.write ?? (message => process.stderr.write(message));
  const receiptFile = path.join(home, 'application-update', 'cli-notice.json');

  return {
    flush() {
      try {
        const status = service.getStatus(identity);
        const now = options.now?.() ?? new Date();
        if (!shouldShow(status, readReceipt(receiptFile), now)) return;
        const command =
          status.action?.kind === 'npm'
            ? status.action.command
            : 'smp update check';
        write(
          `\nUpdate available / 发现新版本: ${status.current.version} → ${status.latest?.version}\n` +
          `Upgrade / 升级: ${command}\n`,
        );
        fs.mkdirSync(path.dirname(receiptFile), {recursive: true});
        atomicWriteFileSync(
          receiptFile,
          `${JSON.stringify({
            schemaVersion: 1,
            latestVersion: status.latest?.version,
            shownAt: now.toISOString(),
          }, null, 2)}\n`,
        );
      } catch {
        // Update reminders are advisory and must never change command behavior.
      }
    },
  };
}
