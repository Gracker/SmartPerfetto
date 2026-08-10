// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import path from 'path';

import {backendDataPath} from '../../runtimePaths';

export const PROVIDER_DATA_DIR_ENV = 'PROVIDER_DATA_DIR_OVERRIDE';

export function providerDataPath(...segments: string[]): string {
  const configured = process.env[PROVIDER_DATA_DIR_ENV];
  const root = configured || backendDataPath();
  return path.join(root, ...segments);
}
