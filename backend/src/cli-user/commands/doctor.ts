// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import { bootstrap } from '../bootstrap';
import type { OutputFormat } from '../repl/renderer';
import { collectDoctorReport, type DoctorReport } from '../services/runtimeGuard';
import { withConsoleLogToStderr } from '../io/stdio';

export interface DoctorCommandArgs {
  envFile?: string;
  sessionDir?: string;
  format?: OutputFormat;
}

export async function runDoctorCommand(args: DoctorCommandArgs): Promise<number> {
  const { paths } = bootstrap({ envFile: args.envFile, sessionDir: args.sessionDir, requireLlm: false });
  const format = args.format ?? 'text';
  const report = await withConsoleLogToStderr(true, async () => collectDoctorReport(paths.home));

  if (format === 'json' || format === 'ndjson') {
    console.log(JSON.stringify(report, null, format === 'json' ? 2 : 0));
    return report.ok ? 0 : 1;
  }

  printTextReport(report);
  return report.ok ? 0 : 1;
}

function printTextReport(report: DoctorReport): void {
  console.log('SmartPerfetto CLI Doctor');
  console.log(`generated  ${report.generatedAt}`);
  console.log(`home       ${report.cliHome}`);
  console.log(`runtime    ${report.runtime.kind} (${report.runtime.source})`);
  console.log(`ai         ${report.aiPolicy.aiEnabled ? 'enabled' : 'disabled'} (${report.aiPolicy.source})`);
  if (report.aiPolicy.disabledReason) {
    console.log(`           ${report.aiPolicy.disabledReason}`);
  }
  if (report.runtime.providerName) {
    console.log(`provider   ${report.runtime.providerName} (${report.runtime.providerType}, ${report.runtime.providerId})`);
  }
  console.log('');

  for (const check of report.checks) {
    const mark = check.status === 'ok' ? 'OK' : check.status === 'warn' ? 'WARN' : 'ERROR';
    console.log(`${mark.padEnd(5)} ${check.name}: ${check.message}`);
    if (check.details?.path) console.log(`      path: ${check.details.path}`);
  }
  console.log('');
  console.log(`capture   adb=${report.captureTools.adb.source}:${report.captureTools.adb.path}`);
  console.log(`          devices=${report.captureTools.devices.readyCount}/${report.captureTools.devices.count}`);
  console.log(`          tracebox=${report.captureTools.tracebox.source}:${report.captureTools.tracebox.path}`);
}
