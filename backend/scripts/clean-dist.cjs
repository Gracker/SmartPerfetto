#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

const fs = require('fs');
const path = require('path');

const backendRoot = path.resolve(__dirname, '..');
fs.rmSync(path.join(backendRoot, 'dist'), { recursive: true, force: true });
