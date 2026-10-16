// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

/**
 * Env-first CLI entry. Must stay the first import of `bin.ts`.
 *
 * Many modules of the CLI graph read `process.env` at module scope (config
 * objects, the logger level, metrics directories). CommonJS evaluates imports
 * in source order, so preparing the environment here — before `bin.ts` pulls
 * in anything else — is what lets `--env-file`, `<CLI home>/env` and
 * `backend/.env` reach those reads. The Web server does the same with
 * `configureRuntimeEnvironment()` at the top of `src/index.ts`.
 *
 * Keep this module's own import graph to `./bootstrap` (fs/path/dotenv and
 * `./io/paths`); anything heavier would evaluate before the env is loaded.
 */

import { prepareCliEnvironment, readCliEnvironmentArgs } from './bootstrap';

prepareCliEnvironment(readCliEnvironmentArgs(process.argv.slice(2)));
