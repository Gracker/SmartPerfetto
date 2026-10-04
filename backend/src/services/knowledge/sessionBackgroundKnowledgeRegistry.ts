// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

/**
 * Background references a session recorded while the built-in Android
 * Internals Pack existed. Nothing records new ones: a resumed session's
 * references are registered on restore and written back unchanged by the next
 * persist, so its reports and snapshots keep that provenance.
 */

import type {BackgroundKnowledgeReference} from '../../types/sparkContracts';

const MAX_TRACKED_SESSIONS = 512;
const MAX_REFERENCES_PER_SESSION = 256;
const referencesBySession = new Map<string, Map<string, BackgroundKnowledgeReference>>();

function touchSession(
  sessionId: string,
  references: Map<string, BackgroundKnowledgeReference>,
): void {
  referencesBySession.delete(sessionId);
  referencesBySession.set(sessionId, references);
  while (referencesBySession.size > MAX_TRACKED_SESSIONS) {
    const oldestSessionId = referencesBySession.keys().next().value;
    if (typeof oldestSessionId !== 'string') break;
    referencesBySession.delete(oldestSessionId);
  }
}

export function registerSessionBackgroundKnowledgeReferences(
  sessionId: string | undefined,
  references: readonly BackgroundKnowledgeReference[],
): void {
  if (!sessionId || references.length === 0) return;
  let sessionReferences = referencesBySession.get(sessionId);
  if (!sessionReferences) {
    sessionReferences = new Map();
  }
  for (const reference of references) {
    const key = `${reference.packFingerprint}:${reference.chunkId}:${reference.chunkHash}`;
    sessionReferences.delete(key);
    sessionReferences.set(key, {...reference});
    while (sessionReferences.size > MAX_REFERENCES_PER_SESSION) {
      const oldestReferenceKey = sessionReferences.keys().next().value;
      if (typeof oldestReferenceKey !== 'string') break;
      sessionReferences.delete(oldestReferenceKey);
    }
  }
  touchSession(sessionId, sessionReferences);
}

export function getSessionBackgroundKnowledgeReferences(
  sessionId: string,
): BackgroundKnowledgeReference[] {
  return Array.from(referencesBySession.get(sessionId)?.values() ?? [])
    .sort((left, right) =>
      left.packVersion.localeCompare(right.packVersion) ||
      left.articleId.localeCompare(right.articleId) ||
      left.sectionId.localeCompare(right.sectionId) ||
      left.chunkId.localeCompare(right.chunkId));
}
