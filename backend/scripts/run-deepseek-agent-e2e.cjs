#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)

// Keep helper imports compatible; legacy CLI never spends against another provider.
module.exports = require('./run-glm-agent-e2e.cjs');
if (require.main === module) {
  console.error('DeepSeek E2E is disabled. Use scripts/run-glm-agent-e2e.cjs or npm run verify:e2e:glm-flagship:strict with GLM_API_KEY.');
  process.exitCode = 1;
}
