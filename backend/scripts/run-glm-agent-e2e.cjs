#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

const {createProviderE2eHarness} = require('./agent-e2e-harness.cjs');
const harness = createProviderE2eHarness('glm');
module.exports = harness;
if (require.main === module) harness.main();
