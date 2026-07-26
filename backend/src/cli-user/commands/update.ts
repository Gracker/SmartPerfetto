// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {bootstrap} from '../bootstrap';
import {
  ApplicationUpdateService,
} from '../../services/applicationUpdate/applicationUpdateService';
import {resolveApplicationBuildIdentity} from '../../services/applicationUpdate/buildIdentity';
import type {ApplicationUpdateStatus} from '../../services/applicationUpdate/types';
import type {TextJsonFormat} from '../repl/renderer';

export interface UpdateCheckCommandArgs {
  envFile?: string;
  sessionDir?: string;
  format?: TextJsonFormat;
  service?: Pick<ApplicationUpdateService, 'checkNow'>;
}

export async function runUpdateCheckCommand(
  args: UpdateCheckCommandArgs,
): Promise<number> {
  bootstrap({envFile: args.envFile, sessionDir: args.sessionDir});
  const identity = resolveApplicationBuildIdentity(process.env, {
    distribution: 'npm',
    channel: 'stable',
    signingMode: 'npm-registry',
  });
  const service = args.service ?? new ApplicationUpdateService();
  const status = await service.checkNow(identity, {force: true});

  if (args.format === 'json') {
    console.log(JSON.stringify(status, null, 2));
  } else {
    printUpdateStatus(status);
  }
  return status.state === 'error' ? 1 : 0;
}

export function printUpdateStatus(status: ApplicationUpdateStatus): void {
  console.log(`SmartPerfetto ${status.current.version} (${status.current.channel})`);
  switch (status.state) {
    case 'update_available':
      console.log(`Update available / 发现新版本: ${status.latest?.version ?? 'unknown'}`);
      if (status.action?.kind === 'npm') {
        console.log(`Upgrade / 升级: ${status.action.command}`);
      }
      if (status.latest?.releaseUrl) {
        console.log(`Release: ${status.latest.releaseUrl}`);
      }
      break;
    case 'up_to_date':
      console.log('Up to date / 已是最新版本');
      break;
    case 'ahead':
      console.log('Current build is newer than the stable release / 当前构建领先于稳定版');
      break;
    case 'disabled':
      console.log('Update checks are disabled / 更新检查已禁用');
      break;
    case 'unsupported_channel':
      console.log('This update channel is not supported for the current distribution');
      break;
    case 'checking':
    case 'unknown':
      console.log('Update status is not available yet / 更新状态暂不可用');
      break;
    case 'error':
      console.error(
        `Update check failed / 更新检查失败: ${status.lastError?.message ?? 'unknown error'}`,
      );
      break;
  }
  if (status.stale) {
    console.log('Showing last-known-good metadata / 当前显示上次成功检查结果');
  }
}
