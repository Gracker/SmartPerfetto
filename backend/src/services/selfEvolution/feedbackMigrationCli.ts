// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {migrateAllLegacyPatternStatuses} from '../../agentv3/analysisPatternMemory';
import {openCaseCandidateOutbox} from '../caseEvolution/caseCandidateOutbox';
import {resolveKnowledgeScope} from '../scopedKnowledgeStore';
import {FeedbackEventStore} from './feedbackEventStore';
import {FeedbackProjectionService} from './feedbackProjectionService';

interface FeedbackMigrationCliOptions {
  rebuild: boolean;
  tenantId?: string;
  workspaceId?: string;
}

function requireOptionValue(
  argv: readonly string[],
  index: number,
  option: string,
): string {
  const value = argv[index + 1];
  if (!value || value.startsWith('--')) {
    throw new Error(`${option} requires a value`);
  }
  return value;
}

export function parseFeedbackMigrationCliArgs(
  argv: readonly string[],
): FeedbackMigrationCliOptions {
  const options: FeedbackMigrationCliOptions = {rebuild: false};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--rebuild') {
      options.rebuild = true;
    } else if (arg === '--tenant') {
      options.tenantId = requireOptionValue(argv, index, arg);
      index += 1;
    } else if (arg === '--workspace') {
      options.workspaceId = requireOptionValue(argv, index, arg);
      index += 1;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return options;
}

export async function runFeedbackMigration(
  options: FeedbackMigrationCliOptions,
): Promise<{
  patternStatusesMigrated: number;
  legacyCandidateFeedbackImported: number;
  projectionTargetsApplied: number;
  rebuilt: boolean;
}> {
  const patternMigration = await migrateAllLegacyPatternStatuses();
  const scope = resolveKnowledgeScope({
    tenantId: options.tenantId,
    workspaceId: options.workspaceId,
  });
  const store = new FeedbackEventStore({
    scope: {
      tenantId: scope.tenantId,
      workspaceId: scope.workspaceId,
    },
  });
  try {
    const outbox = openCaseCandidateOutbox();
    let legacyCandidateFeedbackImported = 0;
    try {
      legacyCandidateFeedbackImported =
        await store.importAcceptedLegacyCandidateFeedback(
          outbox.listAcceptedLegacyFeedback(scope),
        );
    } finally {
      outbox.close();
    }
    if (options.rebuild) store.rebuild();
    else store.catchUp();
    const dirtyBefore = store.listDirtyTargets().length;
    await new FeedbackProjectionService({
      store,
      knowledgeScope: scope,
    }).projectDirtyTargets();
    return {
      patternStatusesMigrated: patternMigration.migrated,
      legacyCandidateFeedbackImported,
      projectionTargetsApplied: dirtyBefore,
      rebuilt: options.rebuild,
    };
  } finally {
    store.close();
  }
}

if (require.main === module) {
  runFeedbackMigration(parseFeedbackMigrationCliArgs(process.argv.slice(2)))
    .then(result => {
      console.log(JSON.stringify(result, null, 2));
    })
    .catch(error => {
      console.error((error as Error).message);
      process.exitCode = 1;
    });
}
