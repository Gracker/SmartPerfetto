// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

/**
 * Every step of a Skill (or of a step), in order: each node with an id, then
 * its nested `steps` and inline conditional branches, at any depth. It reads
 * parsed YAML as well as typed definitions, so a malformed list is skipped.
 */
export function allStepsOf(node: any): any[] {
  if (!node || typeof node !== 'object') return [];
  const branches = [...(Array.isArray(node.conditions) ? node.conditions : []).map((c: any) => c?.then), node.else]
    .filter(branch => branch && typeof branch === 'object');
  return [...(node.id ? [node] : []),
    ...[...(Array.isArray(node.steps) ? node.steps : []), ...branches].flatMap(allStepsOf)];
}
