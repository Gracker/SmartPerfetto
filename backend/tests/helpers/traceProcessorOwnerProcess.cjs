// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

// A process that owns one real trace processor, for
// traceProcessorOwnerExit.real.test.ts. Run with `node --import tsx` so the
// production TypeScript factory is the code under test.
//
//   argv: <tracePath>
//
// Prints one `OWNER_READY {json}` line with its own pid and the processor's
// pid, then stays alive until it is signalled, a line `exit` on stdin makes it
// call process.exit as `jest --forceExit` does, or stdin closes. Run outside a test
// environment so the factory relays the processor's stderr (its connection
// log) on stdout.
'use strict';

const {TraceProcessorFactory} = require('../../src/services/workingTraceProcessor');

async function main() {
  const processor = await TraceProcessorFactory.create(`owner-exit-${process.pid}`, process.argv[2]);
  process.stdout.write(`OWNER_READY ${JSON.stringify({
    ownerPid: process.pid,
    processorPid: processor.getRuntimeStats().pid,
  })}\n`);
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', text => {
    if (text.split('\n').includes('exit')) process.exit(0);
  });
  // The test holds stdin; if it dies (even by SIGKILL) this owner exits too,
  // and its processor reaps itself, instead of both holding a port forever.
  process.stdin.on('end', () => process.exit(0));
}

main().catch(error => {
  process.stderr.write(`OWNER_FAILED ${error && error.stack ? error.stack : error}\n`);
  process.exit(2);
});
