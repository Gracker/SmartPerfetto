// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import { getToolRegistry } from '../toolRegistry';
import { sqlExecutorTool } from './sqlExecutor';
import { dataStatsTool } from './dataStats';
import { skillInvokerTool } from './skillInvoker';

export function registerCoreTools(): void {
  const registry = getToolRegistry();

  registry.register(sqlExecutorTool);
  registry.register(dataStatsTool);
  registry.register(skillInvokerTool);

  console.log(`[Agent] Registered ${registry.list().length} core tools`);
}

export { sqlExecutorTool } from './sqlExecutor';
export { dataStatsTool } from './dataStats';
export { skillInvokerTool, getAvailableSkillIds, getSkillIdForSceneType } from './skillInvoker';