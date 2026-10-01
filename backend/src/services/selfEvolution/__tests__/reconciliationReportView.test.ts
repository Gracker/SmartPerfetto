// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {describe, expect, it} from '@jest/globals';
import yaml from 'js-yaml';

import type {
  SelfEvolutionPersistenceCapability,
  UpgradeReconciliationIssueV1,
} from '../../../types/selfEvolution';
import {createUpgradeReconciliationReportV1} from '../evolutionOverlayContract';
import {EvolutionOverlayRegistry} from '../evolutionOverlayRegistry';
import {projectReconciliationReportForAdmin} from '../reconciliationReportView';

const scope = {tenantId: 'tenant', workspaceId: 'workspace'};

// Unquoted canaries: V8 and js-yaml quote the text around an unexpected
// token, while a canary inside a JSON string yields a content-free
// "Unterminated string" message and would prove nothing.
function parserMessage(parse: () => unknown): string {
  try {
    parse();
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error('expected a parse failure');
}

const jsonParserMessage = parserMessage(() =>
  JSON.parse('{"steps":[SECRET-OVERLAY-CANARY x]}'));
const yamlParserMessage = parserMessage(() =>
  yaml.load('meta:\n  vendor: [SECRET-YAML-CANARY\nbad: : x'));

function issue(
  input: Pick<UpgradeReconciliationIssueV1, 'reasonCode' | 'message'>
    & Partial<UpgradeReconciliationIssueV1>,
): UpgradeReconciliationIssueV1 {
  return {
    schemaVersion: 1,
    issueId: `issue:${input.reasonCode}:${input.message.length}`,
    source: input.reasonCode.startsWith('vendor_') ? 'vendor_override' : 'overlay',
    kind: 'validation_error',
    ...input,
  };
}

function report(issues: UpgradeReconciliationIssueV1[]) {
  return createUpgradeReconciliationReportV1({
    reportId: 'report_test',
    scope,
    previousBuildIdentity: null,
    currentBuildIdentity: {
      distribution: 'portable',
      channel: 'stable',
      version: '1.3.0',
      commit: 'b'.repeat(40),
      target: {os: 'darwin', arch: 'arm64', id: 'darwin-arm64'},
      signingMode: 'macos-developer-id-notarized',
    },
    candidateGeneration: '1'.repeat(64),
    publishedGeneration: '1'.repeat(64),
    byBaseRelation: {
      unchanged: [], changed: [], absorbed: [], missing: [], incompatible: [],
    },
    byValidationState: {pending: [], passed: [], failed: [], error: []},
    byActivationState: {
      active: [], inactive: [], quarantined: [], obsolete: [], disabled: [],
    },
    issues,
    createdAt: 20,
  });
}

function persistence(): SelfEvolutionPersistenceCapability {
  return {
    persistence: 'available',
    configured: true,
    writable: true,
    outsidePackage: true,
    externalMount: false,
    dataRoot: '/tmp/test',
    packageRoot: '/tmp/package',
    checkedAt: 1,
  };
}

describe('projectReconciliationReportForAdmin', () => {
  it('replaces parser text in a stored report and leaves storage and its hash intact', () => {
    expect(jsonParserMessage).toContain('SECRET');
    expect(yamlParserMessage).toContain('SECRET');
    const stored = report([
      issue({
        kind: 'validation_error',
        overlayId: 'overlay_test',
        baseId: 'startup_analysis',
        reasonCode: 'overlay_artifact_invalid',
        message: jsonParserMessage,
      }),
      issue({
        kind: 'parse_failure',
        sourcePath: 'vendors/acme/startup.override.yaml',
        reasonCode: 'vendor_override_parse_failure',
        message: yamlParserMessage,
      }),
      issue({
        kind: 'orphan',
        baseId: 'startup_analysis',
        reasonCode: 'vendor_override_base_missing',
        message: 'Vendor override base skill is missing: startup_analysis',
      }),
      issue({
        kind: 'validation_failure',
        reasonCode: 'overlay_conflict',
        message: 'Skill step "SECRET-STEP" conflicts',
      }),
    ]);
    const registry = new EvolutionOverlayRegistry({
      databasePath: ':memory:',
      persistence: persistence(),
    });
    try {
      registry.saveReport(stored);
      const verified = registry.latestReport(scope)!;

      const view = projectReconciliationReportForAdmin(verified)!;

      expect(view.issues.map(entry => entry.message)).toEqual([
        'Overlay artifact could not be loaded',
        'Vendor override could not be parsed',
        'Vendor override base skill is missing',
        'Overlay candidate generation failed validation',
      ]);
      expect(view.issues.map(({message: _message, ...rest}) => rest)).toEqual(
        stored.issues.map(({message: _message, ...rest}) => rest),
      );
      expect(JSON.stringify(view)).not.toContain('SECRET');
      expect(view.contentHash).toBe(stored.contentHash);
      // The stored report is untouched: it still verifies and keeps its text.
      expect(registry.latestReport(scope)).toEqual(stored);
      expect(verified.issues[0].message).toBe(jsonParserMessage);
    } finally {
      registry.close();
    }
  });

  it('keeps error codes, so a report written today reads unchanged', () => {
    const current = report([
      issue({
        reasonCode: 'overlay_artifact_invalid',
        message: 'evolution_overlay_artifact_not_found',
      }),
      issue({
        reasonCode: 'overlay_artifact_invalid',
        message: 'evolution_overlay_artifact_hash_invalid',
      }),
    ]);

    expect(projectReconciliationReportForAdmin(current)).toBe(current);
    expect(projectReconciliationReportForAdmin(null)).toBeNull();
  });

  it('gives an unrecognized reason code a generic fixed text', () => {
    const view = projectReconciliationReportForAdmin(report([
      issue({reasonCode: 'future_reason', message: 'Free text "SECRET"'}),
      issue({reasonCode: 'constructor', message: 'Free text "SECRET"'}),
    ]))!;

    expect(view.issues.map(entry => entry.message))
      .toEqual(['Reconciliation issue', 'Reconciliation issue']);
  });
});
