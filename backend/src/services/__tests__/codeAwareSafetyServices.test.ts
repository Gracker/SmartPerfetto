// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {runInNewContext} from 'node:vm';

import {afterEach, beforeEach, describe, expect, it} from '@jest/globals';

import {makeSparkProvenance, type RagChunk, type RagRetrievalResult} from '../../types/sparkContracts';
import {createDataEnvelope} from '../../types/dataContract';
import {CodebaseRegistry} from '../codebase/codebaseRegistry';
import {CodeLookupLedger} from '../codebase/codeLookupLedger';
import {SOURCE_USE_DECISION_SCHEMA_VERSION} from '../codebase/sourceUseDecision';
import {filterRagLookup} from '../rag/lookupResponseFilter';
import {SessionToolResultRegistry, projectedSidecarMissing} from '../rag/sessionToolResultRegistry';
import {
  projectRagResultForSseAndLog,
  projectToolResultForExternalSurface,
} from '../rag/toolResultProjectionFilter';
import * as toolResultProjection from '../rag/toolResultProjectionFilter';
import {
  clearAllCodeAwareOutputGuards,
  clearCodeAwareOutputGuards,
  composeCodeAwareTextProjectionReceipts,
  createCodeAwareStreamingTextProjection,
  isIssuedCodeAwareTextProjectionReceipt,
  projectCodeAwareStructuredText,
  projectCodeAwareSemanticInputStructure,
  registerCodeAwareCanary,
  registerOnDemandSourceLookupForEcho,
  registerPrivateAnalysisQueryForEcho,
  revokeCodeAwareOutputGuards,
  sanitizeCodeAwareStructuredText,
  sanitizeCodeAwareStructuredTextWithReceipt,
  sanitizeCodeAwareText,
  sanitizeCodeAwareTextWithReceipt,
  sanitizeOwnerCodeAwareText,
  withOwnerCodeAwareProjection,
  registerCodeAwareLookupForEcho,
} from '../security/codeAwareOutputRegistry';
import {projectCodeAwareStreamingUpdate, projectOwnerCodeAwareStreamingUpdate} from '../security/codeAwareStreamingUpdateProjection';
import {issuePrivateToolResultNarrationReceipt} from '../../agentv3/toolNarration';
import {FINAL_SEMANTIC_INPUT_BYTE_LIMIT} from '../finalSemanticLimits';
import {LLMEchoOutputStream, type CodeRef} from '../security/llmEchoOutputFilter';
import {ExternalKnowledgeSourceRegistry} from '../externalKnowledgeSourceRegistry';
import {parseConclusionContractSidecar, renderConclusionContractSidecar} from '../../agent/core/conclusionContract';
import {projectConclusionProtocol, projectConclusionContractForDisplay} from '../security/conclusionProtocolProjection';

let tmpDir: string;
const CODEBASE_SCOPE = {
  tenantId: 'tenant-test',
  workspaceId: 'workspace-test',
  userId: 'tester',
};

describe('conclusion protocol privacy roles', () => {
  const sessionId = 'protocol-safety';
  const declaration = () => ({schemaVersion: 'conclusion_contract_v1' as const, mode: 'focused_answer' as const,
    conclusions: [], clusters: [], evidenceChain: [], uncertainties: [], nextSteps: [], claims: [{
      id: 'claim', kind: 'identity' as const, text: 'The marker was located.', references: [{
        evidenceRefId: 'data:marker', rowIndex: 0, column: 'name', value: 'synthetic_source_marker_long_name',
      }],
    }]});
  const raw = () => `A useful conclusion.\n${renderConclusionContractSidecar(declaration())}`;

  it.each(['canary', 'private_query'] as const)('does not exempt a %s matching a fixed protocol literal', kind => {
    const marker = 'conclusion_contract_v1';
    if (kind === 'canary') registerCodeAwareCanary(sessionId, marker);
    else registerPrivateAnalysisQueryForEcho(sessionId, marker);
    const projected = projectConclusionProtocol(sessionId, raw());
    expect(projected.text).not.toContain(marker);
    expect(parseConclusionContractSidecar(projected.text).status).toBe('invalid');
  });

  it('keeps revoked and overflowed guards stronger than protocol projection', () => {
    revokeCodeAwareOutputGuards(sessionId);
    expect(projectConclusionProtocol(sessionId, raw()).disposition).toBe('replaced');
    const overflow = 'protocol-overflow';
    for (let index = 0; index < 201; index++) registerCodeAwareCanary(overflow, `private-canary-${index}`);
    expect(projectConclusionProtocol(overflow, raw()).disposition).toBe('replaced');
  });

  it('does not retain arbitrary private fields from an invalid native declaration', () => {
    const marker = 'UNREGISTERED_PRIVATE_ROOT';
    const malformed = '<!-- smartperfetto:conclusion-contract@1\n```json\n' +
      JSON.stringify({...declaration(), verified: true, rootPath: `/private/${marker}`, query: marker}) + '\n```\n-->';
    const projected = projectConclusionProtocol(sessionId, `A safe answer.\n${malformed}`);
    expect(projected.text).not.toContain(marker);
    expect(parseConclusionContractSidecar(projected.text).status).toBe('invalid');
  });

  it('removes private fields and guards all public strings and dynamic selector keys', () => {
    const marker = 'PRIVATE_PROTOCOL_CANARY';
    registerCodeAwareCanary(sessionId, marker);
    const contract = {...declaration(), rootPath: `/private/${marker}`, query: marker,
      metadata: {sceneId: marker, unknown: marker},
      conclusions: [{rank: 1, statement: marker, rawBody: marker}],
      claims: [{...declaration().claims[0], text: marker, references: [{evidenceRefId: 'data:marker',
        rowSelector: {[marker]: marker}, column: marker, value: marker}]}],
    };
    const projected = projectConclusionProtocol(sessionId, `${marker}\n${renderConclusionContractSidecar(contract)}`);
    expect(projected.text).not.toContain(marker);
    expect(projected.text).not.toContain('rootPath');
    expect(projected.text).not.toContain('unknown');
    expect(JSON.stringify(projectConclusionContractForDisplay(sessionId, contract))).not.toContain(marker);
  });

  it('is idempotent for quoted CodeRefs on sidecar, typed JSON and stored declarations', () => {
    registerOnDemandSourceLookupForEcho(sessionId, [{referenceId: 'lookup', codebaseId: 'app',
      filePath: 'src/Probe"Data.kt', lineRange: {start: 1, end: 1},
      text: 'const marker = "synthetic_source_marker_long_name";'}]);
    for (const input of [raw(), JSON.stringify({...declaration(), relationProposals: []}),
      `\`\`\`json\n${JSON.stringify({...declaration(), relationProposals: []})}\n\`\`\``]) {
      const first = projectConclusionProtocol(sessionId, input).text;
      expect(first).not.toContain('synthetic_source_marker_long_name');
      expect(projectConclusionProtocol(sessionId, first).text).toBe(first);
    }
    const projected = projectConclusionContractForDisplay(sessionId, declaration());
    expect(projectConclusionContractForDisplay(sessionId, projected)).toEqual(projected);
  });

  it.each(['captured.cell', 'source.location', 'numeric.cell'])('preserves the registered proof predicate %s through source matching', predicate => {
    registerOnDemandSourceLookupForEcho(sessionId, [{referenceId: 'lookup', codebaseId: 'app', filePath: 'src/Probe.kt',
      text: predicate}]);
    const contract = declaration();
    const withSemantics = {...contract, claims: [{...contract.claims[0], semantics: {
      schemaVersion: 'claim_semantics@1' as const, predicate, polarity: 'affirmed' as const,
      discourse: 'asserted' as const, quantifier: 'one' as const, modality: 'certain' as const,
      scope: {population: 'cited_rows' as const},
    }}]};
    expect(projectConclusionContractForDisplay(sessionId, withSemantics)?.claims?.[0].semantics?.predicate).toBe(predicate);
    registerCodeAwareCanary(sessionId, predicate);
    expect(JSON.stringify(projectConclusionContractForDisplay(sessionId, withSemantics))).not.toContain(predicate);
  });
});

describe('structured projection across execution realms', () => {
  it('preserves ordinary foreign JSON data without inventing a privacy change', () => {
    const value = runInNewContext('({claims: [{id: "claim", value: 49}], empty: null})');
    const projected = projectCodeAwareStructuredText(undefined, value);
    expect(projected.changed).toBe(false);
    expect(projected.value).toEqual({claims: [{id: 'claim', value: 49}], empty: null});
  });

  it('still rejects foreign classes and never invokes their accessors', () => {
    const input = runInNewContext(`(() => {
      let called = 0;
      class Value { get secret() { called++; return 'secret'; } }
      return {value: new Value(), called: () => called};
    })()`);
    const projected = projectCodeAwareStructuredText(undefined, input.value);
    expect(projected.changed).toBe(true);
    expect(projected.value).toBeUndefined();
    expect(input.called()).toBe(0);
  });
});

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'code-aware-safety-test-'));
});

afterEach(() => {
  clearAllCodeAwareOutputGuards();
  fs.rmSync(tmpDir, {recursive: true, force: true});
});

function makeChunk(overrides: Partial<RagChunk> = {}): RagChunk {
  return {
    chunkId: 'chunk-app-1',
    kind: 'app_source',
    uri: 'src/MainActivity.kt',
    snippet: 'class MainActivity { val api_key = "1234567890" }',
    tokenCount: 12,
    indexedAt: 1714600000000,
    filePath: 'src/MainActivity.kt',
    lineRange: {start: 1, end: 2},
    symbol: 'MainActivity',
    language: 'kotlin',
    registryOrigin: 'codebase_registry',
    ...overrides,
  };
}

function makeRawResult(chunk: RagChunk, overrides: Partial<RagRetrievalResult> = {}): RagRetrievalResult {
  return {
    ...makeSparkProvenance({source: 'code-aware-safety-test'}),
    query: 'MainActivity launch',
    results: [{chunkId: chunk.chunkId, score: 0.91, chunk}],
    probed: [chunk.kind],
    retrievedAt: 1714600001000,
    ...overrides,
  };
}

function makeRegistry(sendToProvider: boolean): {
  registry: CodebaseRegistry;
  codebaseId: string;
  sourceGeneration: string;
} {
  const registry = new CodebaseRegistry(path.join(tmpDir, 'registry.json'));
  const root = path.join(tmpDir, 'app');
  fs.mkdirSync(root, {recursive: true});
  const ref = registry.register({
    kind: 'app_source',
    displayName: 'App',
    rootPath: root,
    sendToProvider,
    ...CODEBASE_SCOPE,
  });
  const sourceGeneration = 'codebase_2_test';
  registry.activateIndexGeneration(ref.codebaseId, CODEBASE_SCOPE, ref.indexGeneration, {
    lastIngestStatus: 'ok',
    activeGeneration: sourceGeneration,
    contentFingerprint: 'content-fingerprint',
    chunkCount: 1,
  });
  return {
    registry,
    codebaseId: ref.codebaseId,
    sourceGeneration,
  };
}

describe('CodeLookupLedger', () => {
  it('persists append-only lookup entries and restores caps', async () => {
    const ledgerPath = path.join(tmpDir, 'ledger.jsonl');
    const ledger = new CodeLookupLedger('session-a', 100, 1, ledgerPath);

    ledger.record({
      turn: 1,
      ts: 1714600000000,
      toolName: 'lookup_app_source',
      codebaseId: 'cb_1',
      chunkIds: ['chunk-a'],
      consentApplied: true,
      tokensSpent: 12,
      outcome: 'success',
      legacyPath: false,
    });
    ledger.record({
      turn: 2,
      ts: 1714600001000,
      toolName: 'propose_patch',
      codebaseId: 'cb_1',
      chunkIds: ['chunk-a'],
      consentApplied: true,
      tokensSpent: 0,
      outcome: 'patch_sketch',
      legacyPath: false,
    });
    await ledger.flush();

    const restored = CodeLookupLedger.restore('session-a', 100, 1, ledgerPath);
    expect(restored.hasPriorLookupOf('chunk-a')).toBe(true);
    expect(restored.hasSuccessfulCodeLookup()).toBe(true);
    expect(restored.remainingTokens()).toBe(88);
    expect(restored.remainingPatches()).toBe(0);
    expect(restored.toSnapshotSummary()).toEqual({
      lookupCount: 1,
      patchCount: 1,
      referencedCodebaseIds: ['cb_1'],
      usedCodebaseIds: ['cb_1'],
    });
    expect(fs.readFileSync(ledgerPath, 'utf-8').trim().split('\n')).toHaveLength(2);
  });

  it('keeps audit history but never restores capability across authorization fingerprints', async () => {
    const ledgerPath = path.join(tmpDir, 'partitioned-ledger.jsonl');
    const oldLedger = new CodeLookupLedger('session-partitioned', 100, 1, ledgerPath, 'context-old');
    oldLedger.record({
      turn: 1,
      ts: 1714600000000,
      toolName: 'lookup_app_source',
      codebaseId: 'cb_old',
      chunkIds: ['chunk-old'],
      consentApplied: true,
      tokensSpent: 12,
      outcome: 'success',
      legacyPath: false,
    });
    await oldLedger.flush();

    const restored = CodeLookupLedger.restore(
      'session-partitioned',
      100,
      1,
      ledgerPath,
      'context-new',
    );
    expect(restored.hasPriorLookupOf('chunk-old')).toBe(false);
    expect(restored.hasSuccessfulCodeLookup()).toBe(false);
    expect(restored.remainingTokens()).toBe(100);
    expect(restored.toSnapshotSummary()).toEqual({
      lookupCount: 1,
      patchCount: 0,
      referencedCodebaseIds: ['cb_old'],
      usedCodebaseIds: ['cb_old'],
    });
  });

  it('keeps attempted codebases separate from actually returned references', async () => {
    const ledgerPath = path.join(tmpDir, 'used-ledger.jsonl');
    const ledger = new CodeLookupLedger('session-used', 100, 1, ledgerPath);
    ledger.record({
      turn: 1,
      ts: 1714600000000,
      toolName: 'search_codebase',
      codebaseId: 'cb_attempted',
      chunkIds: [],
      returnedReferenceCount: 0,
      consentApplied: true,
      tokensSpent: 0,
      outcome: 'success',
      legacyPath: false,
    });
    ledger.record({
      turn: 1,
      ts: 1714600000001,
      toolName: 'query_code_graph',
      codebaseId: 'cb_graph',
      chunkIds: [],
      returnedReferenceCount: 2,
      consentApplied: true,
      tokensSpent: 4,
      outcome: 'success',
      legacyPath: false,
    });
    ledger.record({
      turn: 1,
      ts: 1714600000002,
      toolName: 'lookup_app_source',
      codebaseId: 'cb_indexed',
      chunkIds: ['chunk-indexed'],
      consentApplied: true,
      tokensSpent: 4,
      outcome: 'success',
      legacyPath: false,
    });
    await ledger.flush();

    expect(CodeLookupLedger.restore('session-used', 100, 1, ledgerPath).toSnapshotSummary()).toEqual({
      lookupCount: 3,
      patchCount: 0,
      referencedCodebaseIds: ['cb_attempted', 'cb_graph', 'cb_indexed'],
      usedCodebaseIds: ['cb_graph', 'cb_indexed'],
    });
  });

  it('restores old ledger entries without returned reference counts', async () => {
    const ledgerPath = path.join(tmpDir, 'old-ledger.jsonl');
    fs.writeFileSync(ledgerPath, `${JSON.stringify({
      turn: 1,
      ts: 1714600000000,
      toolName: 'search_codebase',
      codebaseId: 'cb_old',
      chunkIds: [],
      consentApplied: true,
      tokensSpent: 0,
      outcome: 'success',
      legacyPath: false,
    })}\n`);

    expect(CodeLookupLedger.restore('session-old', 100, 1, ledgerPath).toSnapshotSummary()).toEqual({
      lookupCount: 1,
      patchCount: 0,
      referencedCodebaseIds: ['cb_old'],
    });
  });

  it('migrates old JSONL entries without restoring source decisions across authorization partitions', () => {
    const ledgerPath = path.join(tmpDir, 'migrated-partition-ledger.jsonl');
    fs.writeFileSync(ledgerPath, [
      JSON.stringify({
        turn: 1,
        ts: 1714600000000,
        toolName: 'search_codebase',
        codebaseId: 'cb_legacy',
        chunkIds: [],
        consentApplied: true,
        tokensSpent: 0,
        outcome: 'success',
        legacyPath: false,
        query: 'PRIVATE_LEGACY_QUERY_CANARY',
      }),
      JSON.stringify({
        turn: 2,
        ts: 1714600000001,
        toolName: 'read_codebase_file',
        codebaseId: 'cb_old_partition',
        chunkIds: [],
        consentApplied: true,
        tokensSpent: 1,
        outcome: 'success',
        legacyPath: false,
        authorizationFingerprint: 'context-old',
        sourceUseDecision: {
          schemaVersion: SOURCE_USE_DECISION_SCHEMA_VERSION,
          codeAwareMode: 'provider_send',
          selectedCodebaseIds: ['cb_old_partition'],
          status: 'located',
          attemptedTools: ['read_codebase_file'],
          queriedCodebaseIds: ['cb_old_partition'],
          usedCodebaseIds: ['cb_old_partition'],
          references: [],
        },
      }),
    ].join('\n') + '\n');

    const restored = CodeLookupLedger.restore(
      'session-migrated-partition',
      100,
      1,
      ledgerPath,
      'context-new',
    );

    expect(restored.getEntries()).toEqual([]);
    expect(restored.toSnapshotSummary()).toEqual({
      lookupCount: 2,
      patchCount: 0,
      referencedCodebaseIds: ['cb_legacy', 'cb_old_partition'],
    });
    expect(JSON.stringify(restored)).not.toContain('PRIVATE_LEGACY_QUERY_CANARY');
  });

  it('persists only bounded source decisions and references in the active partition', async () => {
    const ledgerPath = path.join(tmpDir, 'source-decision-ledger.jsonl');
    const ledger = new CodeLookupLedger(
      'session-source-decision',
      100,
      1,
      ledgerPath,
      'context-current',
    );
    ledger.record({
      turn: 1,
      ts: 1714600000000,
      toolName: 'search_codebase',
      codebaseId: 'cb_current',
      chunkIds: [],
      returnedReferenceCount: 1,
      consentApplied: true,
      tokensSpent: 2,
      outcome: 'success',
      legacyPath: false,
      sourceReferences: [{
        id: 'caller-controlled',
        referenceId: 'source-safe',
        codebaseId: 'cb_current',
        filePath: 'src/Main.kt',
        lineRange: {start: 4, end: 7},
        lookupKind: 'body',
        snippet: 'PRIVATE_REFERENCE_SNIPPET_CANARY',
        rootPath: '/PRIVATE_REFERENCE_ROOT_CANARY',
      }],
      coverageComplete: false,
      incompleteReason: 'backend_degraded',
      sourceUseDecision: {
        schemaVersion: SOURCE_USE_DECISION_SCHEMA_VERSION,
        codeAwareMode: 'provider_send',
        selectedCodebaseIds: ['cb_current'],
        status: 'search_incomplete',
        reasonCode: 'search_incomplete',
        attemptedTools: ['search_codebase'],
        queriedCodebaseIds: ['cb_current'],
        usedCodebaseIds: ['cb_current'],
        coverageComplete: false,
        incompleteReasons: ['backend_degraded'],
        references: [{
          referenceId: 'source-safe',
          codebaseId: 'cb_current',
          filePath: 'src/Main.kt',
          lineRange: {start: 4, end: 7},
          lookupKind: 'body',
        }],
      },
      query: 'PRIVATE_LEDGER_QUERY_CANARY',
      text: 'PRIVATE_LEDGER_TEXT_CANARY',
    } as any);
    await ledger.flush();

    const persisted = fs.readFileSync(ledgerPath, 'utf8');
    const restored = CodeLookupLedger.restore(
      'session-source-decision',
      100,
      1,
      ledgerPath,
      'context-current',
    );

    expect(persisted).not.toContain('PRIVATE_');
    expect(restored.getEntries()[0]).toEqual(expect.objectContaining({
      coverageComplete: false,
      incompleteReason: 'backend_degraded',
      sourceReferences: [expect.objectContaining({
        id: expect.stringMatching(/^source-ref-v1-/),
        codebaseId: 'cb_current',
        filePath: 'src/Main.kt',
      })],
    }));
    expect(restored.toSnapshotSummary()).toEqual(expect.objectContaining({
      lookupCount: 1,
      patchCount: 0,
      referencedCodebaseIds: ['cb_current'],
      usedCodebaseIds: ['cb_current'],
      sourceUseDecision: expect.objectContaining({
        schemaVersion: SOURCE_USE_DECISION_SCHEMA_VERSION,
        status: 'search_incomplete',
        incompleteReasons: ['backend_degraded'],
        references: [expect.objectContaining({filePath: 'src/Main.kt'})],
      }),
    }));
  });
});

describe('filterRagLookup', () => {
  it('admits only authorized redacted source bodies before granting patch context or spending tokens', async () => {
    const {registry, codebaseId, sourceGeneration} = makeRegistry(true);
    const ledger = new CodeLookupLedger('admission', 100, 2, path.join(tmpDir, 'admission.jsonl'));
    const seen: string[] = [];
    const source = makeChunk({codebaseId, sourceGeneration, snippet: 'class PRIVATE_ADMISSION_BODY { val api_key = "1234567890" }'});
    const filtered = await filterRagLookup(makeRawResult(source), {toolName: 'lookup_app_source', turn: 0,
      codebaseRegistry: registry, knowledgeScope: CODEBASE_SCOPE, ledger, sessionId: 'admission',
      admitSourceHit: hit => {seen.push(hit.snippet ?? ''); return false;}});
    await ledger.flush();
    expect(seen).toHaveLength(1);
    expect(seen[0]).not.toContain('1234567890');
    expect(filtered.hits).toEqual([]);
    expect(ledger.hasPriorLookupOf(source.chunkId)).toBe(false);
    expect(ledger.remainingTokens()).toBe(100);
    expect(sanitizeCodeAwareText('admission', 'PRIVATE_ADMISSION_BODY')).toBe('PRIVATE_ADMISSION_BODY');
  });

  it('redacts secrets and records successful user codebase lookups when consent allows provider send', async () => {
    const {registry, codebaseId, sourceGeneration} = makeRegistry(true);
    const ledger = new CodeLookupLedger('session-b', 1000, 1, path.join(tmpDir, 'ledger-b.jsonl'));
    const result = await filterRagLookup(
      makeRawResult(makeChunk({codebaseId, sourceGeneration})),
      {
        toolName: 'lookup_app_source',
        turn: 1,
        codebaseRegistry: registry,
        ledger,
        knowledgeScope: CODEBASE_SCOPE,
      },
    );
    await ledger.flush();

    expect(result.legacyPath).toBe(false);
    expect(result.hits[0]?.snippet).toContain('[REDACTED_SECRET]');
    expect(result.hits[0]?.snippet).not.toContain('1234567890');
    expect(result.hits[0]?.redactedCount).toBe(1);
    expect(ledger.hasSuccessfulCodeLookup()).toBe(true);
  });

  it('registers returned snippets with the output echo guard', async () => {
    const {registry, codebaseId, sourceGeneration} = makeRegistry(true);
    const ledger = new CodeLookupLedger('session-echo', 1000, 1, path.join(tmpDir, 'ledger-echo.jsonl'));
    await filterRagLookup(
      makeRawResult(makeChunk({
        codebaseId,
        sourceGeneration,
        snippet: 'fun guardedLaunchPath() = Unit',
        symbol: 'guardedLaunchPath',
      })),
      {
        toolName: 'lookup_app_source',
        turn: 1,
        codebaseRegistry: registry,
        ledger,
        sessionId: 'session-echo',
        knowledgeScope: CODEBASE_SCOPE,
      },
    );
    await ledger.flush();

    const sanitized = sanitizeCodeAwareText('session-echo', 'Model echoed: fun guardedLaunchPath() = Unit');
    expect(sanitized).not.toContain('fun guardedLaunchPath()');
    expect(sanitized).toContain('Code: guardedLaunchPath');
  });

  it('returns metadata-only hits when provider-send consent is absent', async () => {
    const {registry, codebaseId, sourceGeneration} = makeRegistry(false);
    const ledger = new CodeLookupLedger('session-c', 1000, 1, path.join(tmpDir, 'ledger-c.jsonl'));
    const result = await filterRagLookup(
      makeRawResult(makeChunk({codebaseId, sourceGeneration})),
      {
        toolName: 'lookup_app_source',
        turn: 1,
        codebaseRegistry: registry,
        ledger,
        knowledgeScope: CODEBASE_SCOPE,
      },
    );
    await ledger.flush();

    expect(result.hits[0]?.snippet).toBeUndefined();
    expect(result.hits[0]?.unsupportedReason).toBe('no_send_to_provider_consent');
    expect(ledger.getEntries()[0]?.outcome).toBe('consent_blocked');
  });

  it('drops metadata-only indexed chunks outside the current selection policy', async () => {
    const {codebaseId, sourceGeneration} = makeRegistry(false);
    const registryPath = path.join(tmpDir, 'registry.json');
    const envelope = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
    envelope.codebases[0].pathFilters = ['src'];
    fs.writeFileSync(registryPath, JSON.stringify(envelope));

    const result = await filterRagLookup(
      makeRawResult(makeChunk({
        codebaseId,
        sourceGeneration,
        filePath: 'outside/MainActivity.kt',
      })),
      {
        toolName: 'lookup_app_source',
        turn: 1,
        codebaseRegistry: new CodebaseRegistry(registryPath),
        allowProviderSend: false,
        knowledgeScope: CODEBASE_SCOPE,
      },
    );

    expect(result.hits).toEqual([]);
  });

  it('keeps selected unconsented languages as metadata when provider send is disabled', async () => {
    const {codebaseId, sourceGeneration} = makeRegistry(true);
    const registryPath = path.join(tmpDir, 'registry.json');
    const envelope = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
    envelope.codebases[0].consent.grant.extensions = ['.java', '.kt'];
    fs.writeFileSync(registryPath, JSON.stringify(envelope));

    const result = await filterRagLookup(
      makeRawResult(makeChunk({
        codebaseId,
        sourceGeneration,
        filePath: 'src/new_language.dart',
        snippet: 'void metadataOnlyDart() {}',
      })),
      {
        toolName: 'lookup_app_source',
        turn: 1,
        codebaseRegistry: new CodebaseRegistry(registryPath),
        allowProviderSend: false,
        knowledgeScope: CODEBASE_SCOPE,
      },
    );

    expect(result.hits).toEqual([
      expect.objectContaining({
        unsupportedReason: 'provider_send_disabled_for_session',
        metadata: expect.objectContaining({filePath: 'src/new_language.dart'}),
      }),
    ]);
    expect(result.hits[0]).not.toHaveProperty('snippet');
  });

  it('fails closed when a registry-owned chunk has no relative file path', async () => {
    const {registry, codebaseId, sourceGeneration} = makeRegistry(false);

    const result = await filterRagLookup(
      makeRawResult(makeChunk({codebaseId, sourceGeneration, filePath: undefined})),
      {
        toolName: 'lookup_app_source',
        turn: 1,
        codebaseRegistry: registry,
        allowProviderSend: false,
        knowledgeScope: CODEBASE_SCOPE,
      },
    );

    expect(result.hits).toEqual([
      expect.objectContaining({unsupportedReason: 'invalid_codebase_metadata'}),
    ]);
  });

  it('drops indexed chunks that fall outside the current selection and consent grant', async () => {
    const {codebaseId, sourceGeneration} = makeRegistry(true);
    const registryPath = path.join(tmpDir, 'registry.json');
    const envelope = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
    envelope.codebases[0].pathFilters = ['src'];
    envelope.codebases[0].consent.grant.extensions = ['.java', '.kt'];
    envelope.codebases[0].consent.grant.includePrefixes = ['src'];
    fs.writeFileSync(registryPath, JSON.stringify(envelope));
    const result = await filterRagLookup(
      makeRawResult(makeChunk({
        codebaseId,
        sourceGeneration,
        filePath: 'src/new_language.dart',
        snippet: 'void privateDartSource() {}',
      })),
      {
        toolName: 'lookup_app_source',
        turn: 1,
        codebaseRegistry: new CodebaseRegistry(registryPath),
        knowledgeScope: CODEBASE_SCOPE,
      },
    );

    expect(result.hits).toEqual([]);
  });

  it('keeps legacy knowledge snippets on the legacy path', async () => {
    const ledger = new CodeLookupLedger('session-d', 1000, 1, path.join(tmpDir, 'ledger-d.jsonl'));
    const legacyChunk = makeChunk({
      chunkId: 'legacy-blog',
      kind: 'androidperformance.com',
      uri: 'https://androidperformance.com/article',
      snippet: 'legacy article text with api_key = "1234567890"',
      registryOrigin: 'legacy_plan55',
      codebaseId: undefined,
    });
    const result = await filterRagLookup(
      makeRawResult(legacyChunk),
      {toolName: 'lookup_blog_knowledge', turn: 1, ledger},
    );
    await ledger.flush();

    expect(result.legacyPath).toBe(true);
    expect(result.hits[0]?.snippet).toBe('legacy article text with api_key = "1234567890"');
    expect(ledger.getEntries()[0]).toEqual(expect.objectContaining({
      outcome: 'success',
      legacyPath: true,
      consentApplied: false,
    }));
  });

  it('rechecks private knowledge consent and returns attributed redacted snippets', async () => {
    const registry = new ExternalKnowledgeSourceRegistry(path.join(tmpDir, 'external-sources.json'));
    const root = path.join(tmpDir, 'wiki');
    fs.mkdirSync(root);
    const scope = {tenantId: 'tenant-a', workspaceId: 'workspace-a', userId: 'user-a'};
    const source = registry.register({
      kind: 'android_internals_wiki',
      displayName: 'Android Internals Wiki',
      rootRealpath: root,
      revision: 'a'.repeat(40),
      contentFingerprint: 'b'.repeat(64),
      dirty: false,
      license: 'CC-BY-NC-SA-4.0',
      rightsAcknowledged: true,
      sendToProvider: true,
      consentedBy: 'user-a',
      scope,
    });
    await registry.withIngestLease(source.sourceId, scope, lease =>
      lease.activateGeneration({
        generation: 'generation-a',
        revision: source.revision,
        contentFingerprint: source.contentFingerprint,
        dirty: false,
        indexedArticleCount: 1,
        indexedChunkCount: 1,
      }));
    const chunk = makeChunk({
      chunkId: 'wiki-1',
      kind: 'android_internals_wiki',
      registryOrigin: 'external_knowledge_registry',
      knowledgeSourceId: source.sourceId,
      sourceGeneration: 'generation-a',
      uri: `android-internals-wiki://${source.sourceId}/article`,
      title: 'Handler internals',
      snippet: 'Handler callback with api_key = "1234567890"',
      filePath: 'src/handler.md',
      license: 'CC-BY-NC-SA-4.0',
      attribution: 'Android Internals Wiki by Gracker (CC BY-NC-SA 4.0)',
      sourceStatus: 'finalized',
      sourceConfidence: 'high',
      verifiedAt: 1714600000000,
      commitHash: source.revision,
      contentFingerprint: source.contentFingerprint,
      codebaseId: undefined,
    });

    const result = await filterRagLookup(makeRawResult(chunk), {
      toolName: 'lookup_blog_knowledge',
      turn: 1,
      externalKnowledgeRegistry: registry,
      knowledgeSourceIds: [source.sourceId],
      knowledgeScope: scope,
    } as any);

    expect(result.legacyPath).toBe(false);
    expect(result.hits[0]?.snippet).toContain('[REDACTED_SECRET]');
    expect(result.hits[0]?.metadata).toEqual(expect.objectContaining({
      kind: 'android_internals_wiki',
      knowledgeSourceId: source.sourceId,
      sourceGeneration: 'generation-a',
      sourceStatus: 'finalized',
      sourceConfidence: 'high',
      verifiedAt: 1714600000000,
    }));
    expect(result.hits[0]?.metadata).not.toEqual(expect.objectContaining({
      title: expect.anything(),
      license: expect.anything(),
      attribution: expect.anything(),
    }));
  });
});

describe('registerOnDemandSourceLookupForEcho', () => {
  it('replaces provider-sent on-demand source text with its relative reference', () => {
    const sourceBody = 'const ON_DEMAND_OUTPUT_GUARD_CANARY = true;';

    registerOnDemandSourceLookupForEcho('session-on-demand-output', [
      {
        referenceId: 'source-on-demand-1',
        codebaseId: 'cb-on-demand',
        filePath: 'src/SourceGuard.kt',
        lineRange: {start: 4, end: 4},
        symbol: 'shouldNotBeUsedForOnDemandReplacement',
        text: sourceBody,
      },
      {
        referenceId: 'source-without-text',
        codebaseId: 'cb-on-demand',
        filePath: 'src/SourceGuard.kt',
      },
    ]);

    const projected = sanitizeCodeAwareText(
      'session-on-demand-output',
      `Model echoed: ${sourceBody}`,
    );

    expect(projected).not.toContain('ON_DEMAND_OUTPUT_GUARD_CANARY');
    expect(projected).toContain('[Code: source-on-demand-1 @ src/SourceGuard.kt:4-4]');
  });
});

describe('code-aware output registry bounds', () => {
  it('never executes object getters or array accessor indices', () => {
    let objectGetterReads = 0;
    const objectInput: Record<string, unknown> = {safe: 'ordinary'};
    Object.defineProperty(objectInput, 'incrementing', {
      enumerable: true,
      get: () => {
        objectGetterReads += 1;
        return 'must not be read';
      },
    });
    Object.defineProperty(objectInput, 'throwing', {
      enumerable: true,
      get: () => {
        throw new Error('object getter executed');
      },
    });

    let objectProjected: Record<string, unknown> | undefined;
    expect(() => {
      objectProjected = sanitizeCodeAwareStructuredText('session-object-accessor', objectInput);
    }).not.toThrow();
    expect(objectGetterReads).toBe(0);
    expect(objectProjected).toEqual({safe: 'ordinary'});

    let arrayGetterReads = 0;
    const arrayInput = ['safe'];
    Object.defineProperty(arrayInput, 1, {
      enumerable: true,
      get: () => {
        arrayGetterReads += 1;
        throw new Error('array getter executed');
      },
    });
    let arrayProjected: string[] | undefined;
    expect(() => {
      arrayProjected = sanitizeCodeAwareStructuredText('session-array-accessor', arrayInput);
    }).not.toThrow();
    expect(arrayGetterReads).toBe(0);
    expect(arrayProjected).toHaveLength(2);
    expect(arrayProjected?.[0]).toBe('safe');
    expect(Object.prototype.hasOwnProperty.call(arrayProjected!, 1)).toBe(false);
  });

  it('drops dangerous keys without prototype mutation and preserves safe object prototypes', () => {
    const ordinary: Record<string, unknown> = {safe: 'ordinary', nested: {value: 7}};
    for (const key of ['__proto__', 'prototype', 'constructor']) {
      Object.defineProperty(ordinary, key, {
        value: {pollutedByTask7: key},
        enumerable: true,
        configurable: true,
      });
    }
    const originalObjectPrototype = Object.getPrototypeOf(ordinary);
    const projectedOrdinary = sanitizeCodeAwareStructuredText(
      'session-dangerous-keys',
      ordinary,
    ) as Record<string, unknown>;

    expect(Object.getPrototypeOf(projectedOrdinary)).toBe(originalObjectPrototype);
    expect(projectedOrdinary).toEqual({safe: 'ordinary', nested: {value: 7}});
    expect(Object.prototype.hasOwnProperty.call(projectedOrdinary, '__proto__')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(projectedOrdinary, 'prototype')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(projectedOrdinary, 'constructor')).toBe(false);
    expect((Object.prototype as {pollutedByTask7?: string}).pollutedByTask7).toBeUndefined();
    expect(({} as {pollutedByTask7?: string}).pollutedByTask7).toBeUndefined();

    const nullPrototype = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(nullPrototype, 'safe', {
      value: 'null-prototype ordinary text',
      enumerable: true,
      configurable: true,
      writable: true,
    });
    Object.defineProperty(nullPrototype, '__proto__', {
      value: {pollutedByTask7: 'null-prototype'},
      enumerable: true,
    });
    const projectedNullPrototype = sanitizeCodeAwareStructuredText(
      'session-null-prototype',
      nullPrototype,
    ) as Record<string, unknown>;

    expect(Object.getPrototypeOf(projectedNullPrototype)).toBeNull();
    expect(Reflect.ownKeys(projectedNullPrototype)).toEqual(['safe']);
    expect(projectedNullPrototype.safe).toBe('null-prototype ordinary text');
    expect((Object.prototype as {pollutedByTask7?: string}).pollutedByTask7).toBeUndefined();
  });

  it('keeps ordinary structured values byte-for-shape identical including shared subobjects', () => {
    const shared = {text: 'ordinary source-free text', traceId: 'trace-ordinary'};
    const input = {
      first: shared,
      second: shared,
      values: ['ordinary source-free text', 7, true, null],
    };

    expect(sanitizeCodeAwareStructuredText('session-no-guard', input)).toEqual(input);
  });

  it('bounds structured depth, item count, string size, and cycles without serialization', () => {
    class ModelContainer {
      constructor(readonly text: string) {}
    }
    const cyclic: Record<string, unknown> = {text: 'ordinary'};
    cyclic.self = cyclic;
    const oversized = 'x'.repeat(1024 * 1024 + 1);
    const projected = sanitizeCodeAwareStructuredText('session-structured-bounds', {
      cyclic,
      oversized,
      date: new Date(0),
      bytes: Buffer.from('private bytes'),
      instance: new ModelContainer('private class text'),
      items: Array.from({length: 10_100}, (_, index) => `item-${index}`),
    }) as {
      cyclic: Record<string, unknown>;
      oversized: string;
      items: string[];
    };

    expect(projected.cyclic).toEqual({text: 'ordinary'});
    expect(projected.oversized).toBe('[PRIVATE_OUTPUT_SUPPRESSED]');
    expect(projected.items.length).toBeLessThanOrEqual(10_000);
    expect(projected).not.toHaveProperty('date');
    expect(projected).not.toHaveProperty('bytes');
    expect(projected).not.toHaveProperty('instance');
  });

  it('evicts least-recently-used guards and fails closed for their continuations', () => {
    registerCodeAwareCanary('guard-0', 'PRIVATE_CANARY_0');
    const inFlightProjection = createCodeAwareStreamingTextProjection(
      'guard-0',
      'in-flight-answer',
    );
    for (let index = 1; index <= 256; index++) {
      registerCodeAwareCanary(`guard-${index}`, `PRIVATE_CANARY_${index}`);
    }

    expect(sanitizeCodeAwareText('guard-0', 'unrelated continuation text'))
      .toBe('[PRIVATE_OUTPUT_SUPPRESSED]');
    expect(sanitizeCodeAwareText('guard-256', 'PRIVATE_CANARY_256'))
      .not.toContain('PRIVATE_CANARY_256');
    expect(inFlightProjection.write('PRIVATE_CANARY_0')).toBe('');
    expect(inFlightProjection.flush()).toBe('[PRIVATE_OUTPUT_SUPPRESSED]');
  });
});

describe('tool result projection and session registry', () => {
  it('projects sanitized RAG snippets to hashes for SSE/log payloads', () => {
    const projected = projectRagResultForSseAndLog('lookup_app_source', {
      query: 'MainActivity',
      probed: ['app_source'],
      retrievedAt: 1714600000000,
      legacyPath: false,
      hits: [{
        chunkId: 'chunk-app-1',
        score: 0.9,
        metadata: {kind: 'app_source', codebaseId: 'cb_1'},
        snippet: 'secret source line',
        redactedCount: 0,
      }],
    });

    expect(projected.chunkRefs[0]).toEqual(expect.objectContaining({
      chunkId: 'chunk-app-1',
      codebaseId: 'cb_1',
      kind: 'app_source',
      snippetHash: expect.any(String),
      snippetLength: 18,
    }));
    expect(JSON.stringify(projected)).not.toContain('secret source line');
  });

  it('extracts a private wiki MCP result into a snippet-free shared sidecar', () => {
    const project = (toolResultProjection as any).projectPrivateKnowledgeToolResult;
    const raw = {
      content: [{
        type: 'text',
        text: JSON.stringify({
          success: true,
          result: {
            query: 'Handler',
            probed: ['android_internals_wiki'],
            retrievedAt: 1714600000000,
            legacyPath: false,
            hits: [{
              chunkId: 'wiki-1',
              score: 0.9,
              metadata: {
                kind: 'android_internals_wiki',
                knowledgeSourceId: 'source-a',
                title: 'PRIVATE_WIKI_TITLE_CANARY',
                uri: 'android-internals-wiki://source-a/PRIVATE_WIKI_PATH_CANARY',
                attribution: 'Android Internals Wiki (CC BY-NC-SA 4.0)',
              },
              snippet: 'PRIVATE_WIKI_TOOL_RESULT',
            }],
          },
        }),
      }],
    };

    const sidecar = project('lookup_blog_knowledge', raw);

    expect(sidecar).toEqual(expect.objectContaining({
      toolName: 'lookup_blog_knowledge',
      chunkRefs: [expect.objectContaining({
        chunkId: 'wiki-1',
        kind: 'android_internals_wiki',
        snippetHash: expect.any(String),
        snippetLength: 24,
      })],
    }));
    expect(JSON.stringify(sidecar)).not.toContain('PRIVATE_WIKI_TOOL_RESULT');
    expect(JSON.stringify(sidecar)).not.toContain('PRIVATE_WIKI_TITLE_CANARY');
    expect(JSON.stringify(sidecar)).not.toContain('PRIVATE_WIKI_PATH_CANARY');
    expect(JSON.stringify(sidecar)).not.toContain('sourceStatus');
    expect(JSON.stringify(sidecar)).not.toContain('sourceConfidence');
    expect(sidecar.chunkRefs[0].attribution).toContain('CC BY-NC-SA');
  });

  it.each([
    ['single MCP text output', (text: string) => ({type: 'text', text})],
    ['OpenAI protocol text output', (text: string) => [{type: 'input_text', text}]],
  ])('projects %s without exposing source paths or snippets', (_name, wrap) => {
    const rawText = JSON.stringify({
      success: true,
      result: {
        query: 'StartupHooks',
        probed: ['app_source'],
        retrievedAt: 1714600000000,
        legacyPath: false,
        hits: [{
          chunkId: 'source-1',
          score: 1,
          metadata: {
            kind: 'app_source',
            codebaseId: 'codebase-a',
            filePath: 'app/src/main/java/com/example/StartupHooks.kt',
            lineRange: {start: 10, end: 20},
          },
          snippet: 'PRIVATE_OPENAI_SOURCE_CANARY',
        }],
      },
    });

    const projected = projectToolResultForExternalSurface('lookup_app_source', wrap(rawText));

    expect(projected).toEqual(expect.objectContaining({
      toolName: 'lookup_app_source',
      outcome: 'success',
      chunkRefs: [expect.objectContaining({
        chunkId: 'source-1',
        kind: 'app_source',
        snippetHash: expect.any(String),
      })],
    }));
    expect(JSON.stringify(projected)).not.toContain('StartupHooks.kt');
    expect(JSON.stringify(projected)).not.toContain('PRIVATE_OPENAI_SOURCE_CANARY');
  });

  it('projects public blog retrieval results without copying snippets', () => {
    const projected = projectToolResultForExternalSurface('lookup_blog_knowledge', {
      query: 'Binder latency',
      results: [{
        score: 0.87,
        chunk: {
          chunkId: 'public-blog-1',
          kind: 'androidperformance.com',
          uri: 'https://androidperformance.com/binder',
          title: 'Binder internals',
          snippet: 'PUBLIC_BLOG_SNIPPET_CANARY',
        },
      }],
      probed: ['androidperformance.com'],
      retrievedAt: 1714600000000,
    });

    expect(projected).toEqual(expect.objectContaining({
      toolName: 'lookup_blog_knowledge',
      outcome: 'success',
      chunkRefs: [expect.objectContaining({
        chunkId: 'public-blog-1',
        snippetHash: expect.any(String),
        snippetLength: 26,
      })],
    }));
    expect(JSON.stringify(projected)).not.toContain('PUBLIC_BLOG_SNIPPET_CANARY');
  });

  it.each(['search_codebase', 'read_codebase_file'])(
    'projects %s results without persisting source text or paths',
    toolName => {
      const result = toolName === 'search_codebase'
        ? {
            success: true,
            codebaseId: 'codebase-a',
            matches: [{
              referenceId: 'source-a1b2c3',
              codebaseId: 'codebase-a',
              filePath: 'app/src/main/java/demo/StartupHooks.kt',
              lineRange: {start: 12, end: 12},
              text: 'PRIVATE_ON_DEMAND_SOURCE_CANARY',
            }],
          }
        : {
            success: true,
            codebaseId: 'codebase-a',
            reference: {
              referenceId: 'source-d4e5f6',
              codebaseId: 'codebase-a',
              filePath: 'app/src/main/java/demo/StartupHooks.kt',
              lineRange: {start: 10, end: 20},
              text: 'PRIVATE_ON_DEMAND_SOURCE_CANARY',
            },
          };

      const projected = projectToolResultForExternalSurface(toolName, result);

      expect(projected).toEqual(expect.objectContaining({
        toolName,
        outcome: 'success',
        sourceRefs: [expect.objectContaining({
          referenceId: expect.stringMatching(/^source-/),
          codebaseId: 'codebase-a',
          snippetHash: expect.any(String),
        })],
      }));
      expect(JSON.stringify(projected)).not.toContain('StartupHooks.kt');
      expect(JSON.stringify(projected)).not.toContain('PRIVATE_ON_DEMAND_SOURCE_CANARY');
    },
  );

  it.each(['query_code_graph', 'inspect_code_symbol'])(
    'projects %s graph references without persisting file paths',
    toolName => {
      const projected = projectToolResultForExternalSurface(toolName, {
        success: true,
        codebaseId: 'codebase-a',
        references: [{
          referenceId: 'graph-a1b2c3',
          codebaseId: 'codebase-a',
          filePath: 'app/src/main/java/demo/StartupHooks.kt',
          lineRange: {start: 12, end: 20},
          symbol: 'StartupHooks.installTracing',
          kind: 'function',
        }],
        processes: [{name: '/Users/demo/app/src/main/java/demo/StartupHooks.kt'}],
        graph: {engine: 'gitnexus', freshness: 'stale', verificationRequired: true},
      });

      expect(projected).toEqual(expect.objectContaining({
        toolName,
        outcome: 'success',
        sourceRefs: [expect.objectContaining({
          referenceId: 'graph-a1b2c3',
          codebaseId: 'codebase-a',
          lineRange: {start: 12, end: 20},
          filePathHash: expect.any(String),
          symbolHash: expect.any(String),
          kindHash: expect.any(String),
        })],
      }));
      expect(JSON.stringify(projected)).not.toContain('StartupHooks.kt');
      expect(JSON.stringify(projected)).not.toContain('StartupHooks.installTracing');
      expect(JSON.stringify(projected)).not.toContain('function');
      expect(JSON.stringify(projected)).not.toContain('/Users/demo');
    },
  );

  it('projects graph budget failures without changing the outcome to rejected', () => {
    const projected = projectToolResultForExternalSurface('query_code_graph', {
      success: false,
      unsupportedReason: 'budget_exceeded',
      references: [],
      graph: {engine: 'gitnexus', freshness: 'unknown', verificationRequired: true},
    });

    expect(projected).toEqual(expect.objectContaining({
      toolName: 'query_code_graph',
      outcome: 'budget_exceeded',
      sourceRefs: [],
    }));
  });

  it('keeps runtime tool results namespaced by session/run/runtime/invocation', () => {
    const registry = new SessionToolResultRegistry();
    const target = {sessionId: 's1', runId: 'r1', runtime: 'openai' as const, invocationId: 'tool-1'};
    const alias = {sessionId: 's1', runId: 'r1', runtime: 'claude' as const, invocationId: 'tool-1'};
    const sidecar = projectedSidecarMissing('lookup_app_source');
    registry.put(target, {llmPayload: {content: 'provider payload'}, sidecar});
    registry.alias(alias, target);

    expect(registry.getSidecar(alias)).toEqual(sidecar);
    expect(registry.getLlmPayload(target)).toEqual({content: 'provider payload'});

    registry.clearRun('s1', 'r1');
    expect(registry.getSidecar(target)).toBeUndefined();
    expect(registry.getSidecar(alias)).toBeUndefined();
  });
});

describe('code-aware streaming application boundary', () => {
  const timestamp = 1714600000000;

  it('distinguishes real SQL, source search and source read calls without copying their arguments', () => {
    const calls = ['execute_sql', 'search_codebase', 'read_codebase_file'].map(toolName =>
      projectCodeAwareStreamingUpdate('session-stream', {
        type: 'agent_task_dispatched', timestamp,
        content: {toolName, args: {query: 'PRIVATE_QUERY', file_path: '/PRIVATE_ROOT/Main.kt'},
          message: 'PRIVATE_MODEL_PROSE', privateSafe: true},
      }, true, 'zh-CN'));
    expect(calls.every(call => call?.type === 'tool_call')).toBe(true);
    expect(new Set(calls.map(call => call?.content.message)).size).toBe(3);
    expect(calls[0]?.content.message).toContain('SQL');
    expect(calls[1]?.content.message).toContain('搜索源码');
    expect(calls[2]?.content.message).toContain('读取源码');
    expect(JSON.stringify(calls)).not.toContain('PRIVATE_');
    expect(JSON.stringify(calls)).not.toContain('隐私策略隐藏');
  });

  it('reports source body availability from projected execution results only', () => {
    const raw = {success: true, codebaseId: 'cb-app', reference: {
      referenceId: 'source-visible', codebaseId: 'cb-app', filePath: 'src/Main.kt',
      lineRange: {start: 1, end: 2}, text: 'PRIVATE_SOURCE_BODY',
    }};
    const projectedResult = projectToolResultForExternalSurface('read_codebase_file', raw);
    const update = projectCodeAwareStreamingUpdate('session-stream', {
      type: 'agent_response', timestamp, content: {
        toolName: 'read_codebase_file', result: projectedResult,
        resultNarration: 'PRIVATE_FORGED_NARRATION', isError: false,
      },
    }, true, 'zh-CN');
    expect(update?.content.resultNarration).toContain('已读取授权内容');
    expect(JSON.stringify(update)).not.toContain('PRIVATE_');
    expect(JSON.stringify(update)).not.toContain('Main.kt');
    expect(projectCodeAwareStreamingUpdate('session-stream', {
      type: 'agent_response', timestamp, content: {
        toolName: 'read_codebase_file', result: '{truncated',
        resultNarration: 'PRIVATE_FORGED_NARRATION', privateSafe: true,
      },
    }, true, 'zh-CN')).toBeNull();
  });

  it('retains automatic phase outcomes without private phase titles or IDs', () => {
    const update = projectCodeAwareStreamingUpdate('session-stream', {
      type: 'plan_phase_updated', timestamp,
      content: {origin: 'auto', status: 'completed', phaseId: 'PRIVATE_ID', summary: 'PRIVATE_SUMMARY'},
    }, true, 'zh-CN');
    expect(update?.content.message).toBe('当前分析阶段已完成');
    expect(JSON.stringify(update)).not.toContain('PRIVATE_');
  });

  it('retains only bounded protocol diagnostics without private text or message narration', () => {
    const diagnostic = {
      schemaVersion: 'candidate_protocol_diagnostic@1', stage: 'native', candidateIndex: 1,
      status: 'invalid', sidecarStatus: 'invalid', typedJsonStatus: 'not_checked',
      issueCodes: ['invalid_reference'], issueCount: 1, rawChars: 210, canonicalChars: 80,
      projectionKind: 'protocol_projection',
    };
    const event = {type: 'progress' as const, timestamp, content: {
      phase: 'candidate_protocol', candidateProtocolDiagnostic: diagnostic,
      message: 'PRIVATE_MODEL_BODY', path: '/PRIVATE_ROOT/App.kt',
    }};
    const projected = projectCodeAwareStreamingUpdate('session-stream', event, true, 'zh-CN');
    expect(projected?.content).toEqual({
      phase: 'candidate_protocol', candidateProtocolDiagnostic: diagnostic,
    });
    expect(JSON.stringify(projected)).not.toContain('PRIVATE_');
    expect(projected?.content).not.toHaveProperty('message');
    for (const invalid of [
      {...diagnostic, raw: 'PRIVATE_MODEL_BODY'},
      {...diagnostic, path: '/PRIVATE_ROOT/App.kt'},
      {...diagnostic, issueCodes: ['PRIVATE_MODEL_BODY']},
      {...diagnostic, rawChars: 'PRIVATE_MODEL_BODY'},
      {...diagnostic, candidateIndex: 3},
    ]) {
      expect(projectCodeAwareStreamingUpdate('session-stream', {
        ...event, content: {...event.content, candidateProtocolDiagnostic: invalid},
      }, true, 'zh-CN')).toBeNull();
    }
  });

  it('preserves intact source outcomes after transport truncation only with a locally issued receipt', () => {
    const result = projectToolResultForExternalSurface('search_codebase', {
      success: true, codebaseId: 'cb-app', matches: Array.from({length: 20}, (_,index) => ({
        referenceId: `source-${index}`, codebaseId: 'cb-app', filePath: `src/PRIVATE_FILE_${index}.kt`,
        lineRange: {start: 1, end: 3}, text: 'PRIVATE_SOURCE_BODY',
      })),
    });
    const wire = JSON.stringify(result).slice(0, 2000);
    expect(() => JSON.parse(wire)).toThrow();
    const receipt = issuePrivateToolResultNarrationReceipt({toolName: 'search_codebase', result});
    const event = {type: 'agent_response' as const, timestamp, content: {
      toolName: 'search_codebase', result: wire, privateToolResultReceipt: receipt,
    }};
    const projected = projectCodeAwareStreamingUpdate('session-stream', event, true, 'zh-CN');
    expect(projected?.content.resultNarration).toContain('已读取授权内容');
    expect(JSON.stringify(projected)).not.toContain('PRIVATE_');
    expect(projected?.content).not.toHaveProperty('privateToolResultReceipt');
    expect(projectCodeAwareStreamingUpdate('session-stream', JSON.parse(JSON.stringify(event)), true, 'zh-CN')).toBeNull();
    expect(projectCodeAwareStreamingUpdate('session-stream', {...event, content: {...event.content,
      toolName: 'read_codebase_file'}}, true, 'zh-CN')).toBeNull();
  });

  it('suppresses live answer tokens and omits private reasoning without filler', () => {
    const answer = projectCodeAwareStreamingUpdate(
      'session-stream',
      {type: 'answer_token', content: {token: 'PRIVATE_TOKEN_CANARY'}, timestamp},
      true,
      'en',
    );
    const thought = projectCodeAwareStreamingUpdate(
      'session-stream',
      {type: 'thought', content: {text: 'PRIVATE_REASONING_CANARY'}, timestamp},
      true,
      'zh-CN',
    );

    expect(answer?.content).toEqual({suppressed: true});
    expect(JSON.stringify(answer)).not.toContain('PRIVATE_TOKEN_CANARY');
    expect(thought).toBeNull();
    expect(JSON.stringify(thought)).not.toContain('PRIVATE_REASONING_CANARY');
  });

  it.each([
    'tool_call',
    'finding',
    'conversation_step',
    'hypothesis_generated',
    'agent_task_dispatched',
    'agent_dialogue',
    'agent_response',
    'synthesis_complete',
    'strategy_decision',
    'plan_submitted',
    'scene_story_report_ready',
    'scene_story_failed',
    'focus_updated',
    'skill_layered_result',
  ] as const)('suppresses private model-authored %s payloads before logs, SSE, and replay', (type) => {
    const projected = projectCodeAwareStreamingUpdate(
      'session-stream',
      {
        type,
        content: {
          message: 'PRIVATE_EVENT_CANARY',
          args: {query: 'PRIVATE_TOOL_ARGUMENT_CANARY'},
          hypotheses: [{statement: 'PRIVATE_HYPOTHESIS_CANARY'}],
        },
        timestamp,
      },
      true,
      'en',
    );

    expect(projected).toBeNull();
    expect(JSON.stringify(projected)).not.toContain('PRIVATE_');
  });

  it('fails closed for invalid data envelopes instead of forwarding arbitrary payloads', () => {
    const projected = projectCodeAwareStreamingUpdate(
      'session-stream',
      {
        type: 'data',
        content: {summary: 'PRIVATE_INVALID_DATA_CANARY'},
        timestamp,
      },
      true,
      'en',
    );
    expect(projected).toBeNull();
    expect(JSON.stringify(projected)).not.toContain('PRIVATE_INVALID_DATA_CANARY');
  });

  it('projects SQL literals and model-authored envelope metadata before live delivery', () => {
    const canary = 'PRIVATE_DATA_ENVELOPE_CANARY';
    registerCodeAwareCanary('session-stream', canary);
    const envelope = {
      ...createDataEnvelope({
        columns: ['dur_ms', 'leak'],
        rows: [[42, canary]],
        executableSql: `SELECT '${canary}'`,
      }, {
        type: 'sql_result',
        source: 'execute_sql',
        title: `SQL ${canary}`,
        layer: 'list',
        format: 'table',
        queryReview: {observedExecution: {executableSql: `SELECT '${canary}'`}} as any,
        intent: canary,
      }),
      sql: `SELECT '${canary}'`,
    };

    const projected = projectCodeAwareStreamingUpdate(
      'session-stream',
      {type: 'data', content: envelope, timestamp},
      true,
      'en',
    );

    expect(projected?.type).toBe('data');
    expect(JSON.stringify(projected)).not.toContain(canary);
    expect(projected?.content).not.toHaveProperty('sql');
    expect(projected?.content.meta).not.toHaveProperty('queryReview');
    expect(projected?.content.meta).not.toHaveProperty('intent');
    expect(projected?.content.data.rows[0][0]).toBe(42);
    expect(projected?.content.data).not.toHaveProperty('executableSql');
  });

  it('replaces private error and progress payloads with localized control messages', () => {
    for (const type of ['error', 'progress', 'degraded', 'sql_validation_failed'] as const) {
      const projected = projectCodeAwareStreamingUpdate(
        'session-stream',
        {
          type,
          content: {
            message: 'PRIVATE_ERROR_CANARY',
            stack: 'PRIVATE_STACK_CANARY',
            sql: 'SELECT PRIVATE_SQL_CANARY',
          },
          timestamp,
        },
        true,
        'en',
      );
      expect(JSON.stringify(projected)).not.toContain('PRIVATE_');
      if (type === 'error') expect(projected?.content.privateModelTextSuppressed).toBe(true);
      else expect(projected).toBeNull();
    }
  });

  it('preserves only a privacy-safe degraded diagnostic code for private E2E gates', () => {
    const projected = projectCodeAwareStreamingUpdate(
      'session-stream',
      {
        type: 'degraded',
        content: {
          fallback: 'verification_failed',
          verificationIssueType: 'unresolved_hypothesis',
          message: 'PRIVATE_DEGRADED_MESSAGE_CANARY',
        },
        timestamp,
      },
      true,
      'en',
    );

    expect(projected?.type).toBe('progress');
    expect(projected?.content).toMatchObject({
      sourceEventType: 'degraded',
      degradedFallback: 'verification_failed',
      degradedIssueType: 'unresolved_hypothesis',
      privateModelTextSuppressed: true,
    });
    expect(JSON.stringify(projected)).not.toContain('PRIVATE_DEGRADED_MESSAGE_CANARY');

    const unsafe = projectCodeAwareStreamingUpdate(
      'session-stream',
      {
        type: 'degraded',
        content: {
          fallback: 'PRIVATE_UNSAFE_FALLBACK_CANARY',
          verificationIssueType: 'PRIVATE_UNSAFE_ISSUE_CANARY',
        },
        timestamp,
      },
      true,
      'en',
    );
    expect(unsafe).toBeNull();
  });

  it('keeps ordinary sessions byte-preserving and sanitizes source-aware conclusions', () => {
    const ordinary = {type: 'answer_token' as const, content: {token: 'ordinary'}, timestamp};
    expect(projectCodeAwareStreamingUpdate('ordinary', ordinary, false, 'en')).toBe(ordinary);

    registerCodeAwareCanary('session-stream', 'CONCLUSION_PRIVATE_CANARY');
    const conclusion = projectCodeAwareStreamingUpdate(
      'session-stream',
      {
        type: 'conclusion',
        content: {
          conclusion: 'before CONCLUSION_PRIVATE_CANARY after',
          rawAnswer: 'PRIVATE_RAW_ANSWER_CANARY',
          findings: ['PRIVATE_FINDING_CANARY'],
          confidence: 0.8,
        },
        timestamp,
      },
      true,
      'en',
    );
    expect(conclusion?.content.conclusion).not.toContain('CONCLUSION_PRIVATE_CANARY');
    expect(conclusion?.content).not.toHaveProperty('rawAnswer');
    expect(conclusion?.content).not.toHaveProperty('findings');
    expect(conclusion?.content.confidence).toBe(0.8);
  });

  it('allows only sanitized source supplement text and numeric metrics', () => {
    registerCodeAwareCanary('session-stream', 'SOURCE_SUPPLEMENT_PRIVATE_CANARY');
    const projected = projectCodeAwareStreamingUpdate(
      'session-stream',
      {
        type: 'analysis_source_enrichment_completed',
        content: {
          message: 'before SOURCE_SUPPLEMENT_PRIVATE_CANARY after',
          metrics: {searchCalls: 3, readCalls: 7, durationMs: 9000},
          rawToolPayload: 'PRIVATE_TOOL_PAYLOAD_CANARY',
        },
        timestamp,
      },
      true,
      'en',
    );

    expect(projected?.type).toBe('analysis_source_enrichment_completed');
    expect(projected?.content.message).not.toContain('SOURCE_SUPPLEMENT_PRIVATE_CANARY');
    expect(projected?.content.metrics).toEqual({
      searchCalls: 3,
      readCalls: 7,
      durationMs: 9000,
    });
    expect(projected?.content).not.toHaveProperty('rawToolPayload');
  });

  it('fails closed when one long-lived session exceeds the guard pattern budget', () => {
    for (let index = 0; index <= 200; index++) {
      registerCodeAwareCanary('session-overflow', `canary-${index}`);
    }

    expect(sanitizeCodeAwareText('session-overflow', 'unregistered private model text'))
      .toBe('[PRIVATE_OUTPUT_SUPPRESSED]');
  });

  it('redacts exact, line, and window echoes from pasted private analysis queries', () => {
    const query = [
      'Please analyze this pasted source:',
      'private fun calculateSecretFrameBudget(input: Long): Long {',
      '  return input * 37 + 991',
      '}',
    ].join('\n');
    registerPrivateAnalysisQueryForEcho('session-query-echo', query);

    const projected = sanitizeCodeAwareText(
      'session-query-echo',
      'The implementation uses private fun calculateSecretFrameBudget(input: Long): Long {',
    );
    expect(projected).not.toContain('calculateSecretFrameBudget');
    expect(projected).toContain('[PRIVATE_QUERY_REFERENCE]');
  });

  it('fails closed without unbounded derived patterns for oversized private queries', () => {
    const query = Array.from(
      {length: 6000},
      (_, index) => `privateQuerySegment_${index.toString().padStart(5, '0')}`,
    ).join(' ');
    registerPrivateAnalysisQueryForEcho('session-large-query', query);

    expect(sanitizeCodeAwareText('session-large-query', 'ordinary provider output'))
      .toBe('[PRIVATE_OUTPUT_SUPPRESSED]');
  });
});

describe('internal code-aware text projection receipts', () => {
  it('distinguishes a literal placeholder from an actual replacement branch', () => {
    const literal = sanitizeCodeAwareTextWithReceipt('ordinary-receipt', '[PRIVATE_OUTPUT_SUPPRESSED]');
    expect(literal.disposition).toBe('preserved');
    expect(literal.inputFingerprint).toBe(literal.outputFingerprint);
    expect(Object.isFrozen(literal)).toBe(true);
    expect(isIssuedCodeAwareTextProjectionReceipt(literal)).toBe(true);
    expect(isIssuedCodeAwareTextProjectionReceipt({...literal})).toBe(false);
    registerCodeAwareCanary('ordinary-receipt', 'PRIVATE_CANARY');
    expect(sanitizeCodeAwareTextWithReceipt('ordinary-receipt', 'Before PRIVATE_CANARY after').disposition).toBe('redacted');
  });

  it('records both registration and derived-pattern overflow without inspecting output wording', () => {
    for (let index = 0; index <= 200; index++) registerCodeAwareCanary('receipt-overflow', `canary-${index}`);
    expect(sanitizeCodeAwareTextWithReceipt('receipt-overflow', 'ordinary output').disposition).toBe('replaced');
    registerPrivateAnalysisQueryForEcho('receipt-derived-overflow', 'x'.repeat(512 * 1024 + 1));
    expect(sanitizeCodeAwareTextWithReceipt('receipt-derived-overflow', 'ordinary output').disposition).toBe('replaced');
  });

  it('retains plain empty behavior and records actual revoked and detached streaming replacements', () => {
    registerCodeAwareCanary('receipt-retired', 'PRIVATE_CANARY');
    const detached = createCodeAwareStreamingTextProjection('receipt-retired', 'answer');
    clearCodeAwareOutputGuards('receipt-retired');
    expect(detached.projectCompleteWithReceipt('late output').disposition).toBe('replaced');
    revokeCodeAwareOutputGuards('receipt-revoked');
    const revoked = createCodeAwareStreamingTextProjection('receipt-revoked', 'answer');
    expect(revoked.projectCompleteWithReceipt('').disposition).toBe('replaced');
    expect(revoked.projectComplete('')).toBe('[PRIVATE_OUTPUT_SUPPRESSED]');
    expect(sanitizeCodeAwareTextWithReceipt('receipt-revoked', '')).toMatchObject({text: '', disposition: 'preserved'});
    expect(sanitizeCodeAwareStructuredTextWithReceipt('receipt-revoked', '')).toMatchObject({text: '', disposition: 'preserved'});
  });

  it('applies the existing structured byte limit without imposing it on the plain API', () => {
    const oversized = 'x'.repeat(1024 * 1024 + 1);
    expect(sanitizeCodeAwareTextWithReceipt(undefined, oversized)).toMatchObject({text: oversized, disposition: 'preserved'});
    expect(sanitizeCodeAwareStructuredTextWithReceipt(undefined, oversized).disposition).toBe('replaced');
    expect(sanitizeCodeAwareStructuredTextWithReceipt(undefined, '汉'.repeat(400_000)).disposition).toBe('replaced');
  });

  it('composes only issued contiguous receipts and keeps replacement absorbing', () => {
    revokeCodeAwareOutputGuards('receipt-compose');
    const replaced = createCodeAwareStreamingTextProjection('receipt-compose', 'answer').projectCompleteWithReceipt('private body');
    const preserved = sanitizeCodeAwareTextWithReceipt(undefined, replaced.text);
    const composed = composeCodeAwareTextProjectionReceipts(replaced, preserved);
    expect(composed.disposition).toBe('replaced');
    expect(composed.inputFingerprint).toBe(replaced.inputFingerprint);
    expect(composeCodeAwareTextProjectionReceipts({...replaced}, preserved)).toBe(preserved);
    const unrelated = sanitizeCodeAwareTextWithReceipt(undefined, 'different body');
    expect(composeCodeAwareTextProjectionReceipts(replaced, unrelated)).toBe(unrelated);
  });
});

describe('LLMEchoOutputStream', () => {
  it('replaces exact code echoes with source references and never stores raw snippets in stats', () => {
    const stream = new LLMEchoOutputStream();
    const ref: CodeRef = {
      chunkId: 'chunk-app-1',
      codebaseId: 'cb_1',
      filePath: 'src/MainActivity.kt',
      lineRange: {start: 10, end: 12},
      symbol: 'MainActivity.onCreate',
    };
    stream.registerSnippet('val launchPath = computeLaunchPath()', ref);

    const output = stream.write('The answer is val launchPath = computeLaunchPath()') + stream.flush();
    expect(output).not.toContain('computeLaunchPath()');
    expect(output).toContain('[Code: MainActivity.onCreate @ src/MainActivity.kt:10-12]');
    expect(JSON.stringify(stream.stats())).not.toContain('computeLaunchPath()');
    expect(stream.stats().hits[0]).toEqual(expect.objectContaining({
      patternKind: 'exact',
      codeRef: ref,
    }));
  });

  it('redacts canary echoes across streamed chunks', () => {
    const stream = new LLMEchoOutputStream(16);
    stream.registerCanary('CANARY-DO-NOT-EMIT');

    const output =
      stream.write('prefix CANARY-') +
      stream.write('DO-NOT-EMIT suffix') +
      stream.flush();
    expect(output).not.toContain('CANARY-DO-NOT-EMIT');
    expect(output).toContain('[REDACTED_CODE_ECHO]');
  });

  it('redacts code substrings that cross legacy 80-character window boundaries', () => {
    const stream = new LLMEchoOutputStream();
    const ref: CodeRef = {
      chunkId: 'chunk-boundary',
      codebaseId: 'cb-boundary',
      filePath: 'src/Boundary.kt',
      symbol: 'boundarySecret',
    };
    const snippet = `${'a'.repeat(70)}PRIVATE_BOUNDARY_SECRET_${'b'.repeat(80)}`;
    const crossingEcho = snippet.slice(70, 140);
    stream.registerSnippet(snippet, ref);

    const complete = stream.write(`before ${crossingEcho} after`) + stream.flush();
    expect(complete).not.toContain('PRIVATE_BOUNDARY_SECRET');
    expect(complete).toContain('[Code: boundarySecret @ src/Boundary.kt]');

    const splitStream = new LLMEchoOutputStream(64);
    splitStream.registerSnippet(snippet, ref);
    const split =
      splitStream.write(`before ${crossingEcho.slice(0, 19)}`) +
      splitStream.write(crossingEcho.slice(19)) +
      splitStream.flush();
    expect(split).not.toContain('PRIVATE_BOUNDARY_SECRET');
    expect(split).toContain('[Code: boundarySecret @ src/Boundary.kt]');
  });
});

describe('source echo text units', () => {
  const ref: CodeRef = {chunkId: 'source-one', codebaseId: 'app', filePath: 'StartupHooks.kt', lineRange: {start: 1, end: 24}};
  const label = '[Code: source-one @ StartupHooks.kt:1-24]';
  // Freeze the original echo regression independently of the evolving mechanism fixture.
  const source = `// SPDX-License-Identifier: AGPL-3.0-or-later
package com.smartperfetto.e2e

/** Stable source fixture used to prove request-scoped source retrieval in real-provider E2E. */
object StartupHooks {
  const val SOURCE_CONTEXT_MARKER = "E2E_CONTEXT_MARKER_SOURCE"
  const val TRACE_SOURCE_MARKER = "StartupHooks.initializeOnMainThread#before-first-frame-sync-policy"

  fun initializeOnMainThread() { // SEMANTIC_DELTA_PRIVATE_SOURCE_CANARY_NEVER_EMIT
    // This synthetic synchronous disk read is intentionally described in source
    // so the analyzer must distinguish source context from trace evidence.
    val startupPolicy = "avoid synchronous disk I/O before first frame"
    check(TRACE_SOURCE_MARKER.isNotEmpty())
    check(startupPolicy.isNotEmpty())
  }
}

/** Synthetic caller retained in the bounded fixture so the call-chain assertion is source-backed. */
object Application {
  fun onCreate() {
    StartupHooks.initializeOnMainThread()
  }
}
`;
  function project(text: string, cuts: number[] = [], register?: (stream: LLMEchoOutputStream) => void, bytes = false) {
    const stream = new LLMEchoOutputStream(64);
    if (register) register(stream); else stream.registerSnippet(source, ref);
    const input = bytes ? Buffer.from(text) : text;
    let output = ''; let start = 0;
    for (const end of [...cuts, input.length]) {output += stream.write(input.slice(start, end)); start = end;}
    output += stream.flush();
    return {output, stats: stream.stats()};
  }

  it('replaces historical A2 broken-word source quotes on the strict surface at every split', () => {
    const text = '方法 `fun initializeOnMainThread() { ... }`；策略 “avoid synchronous disk I/O before first frame”。';
    const expected = `方法 ${label}；策略 ${label}。`;
    expect(project(text).output).toBe(expected);
    for (let cut = 0; cut <= text.length; cut++) expect(project(text, [cut]).output).toBe(expected);
    expect(project(text, Array.from({length: text.length}, (_, index) => index)).output).toBe(expected);
  });

  it('expands unquoted qualified identifiers instead of leaving prefix or suffix fragments', () => {
    const text = 'Call StartupHooks.initializeOnMainThread before first frame.';
    const value = project(text).output;
    expect(value).toBe(`Call ${label} before first frame.`);
    expect(value).not.toMatch(/in\[Code|\]ore/);
  });

  it('respects escaped and nested quote/code delimiters', () => {
    const text = 'Outer “text `fun initializeOnMainThread() { ... }` and \\"quoted\\" text” tail.';
    const expected = `Outer ${label} tail.`;
    for (let cut = 0; cut <= text.length; cut++) expect(project(text, [cut]).output).toBe(expected);
    const fenced = 'Before\n```kotlin\nfun initializeOnMainThread() {\n}\n```\nAfter';
    expect(project(fenced).output).toBe(`Before\n${label}\nAfter`);
  });

  it('keeps source origin collisions neutral and hard private policies stronger than a source ref', () => {
    const snippet = 'privateSharedIdentifierCall()';
    const bothSources = (stream: LLMEchoOutputStream) => {
      stream.registerSnippet(snippet, ref);
      stream.registerSnippet(snippet, {...ref, chunkId: 'source-two', filePath: 'Other.kt'});
    };
    expect(project(snippet, [], bothSources).output).toBe('[Code: multiple source references]');
    for (const order of [false, true]) {
      const register = (stream: LLMEchoOutputStream) => {
        if (order) stream.registerPrivateSnippet(snippet, '[PRIVATE_QUERY_REFERENCE]');
        stream.registerSnippet(snippet, ref);
        if (!order) stream.registerPrivateSnippet(snippet, '[PRIVATE_QUERY_REFERENCE]');
      };
      expect(project(snippet, [], register).output).toBe('[PRIVATE_QUERY_REFERENCE]');
      expect(project(snippet, [], stream => {register(stream); stream.registerCanary(snippet);} ).output).toBe('[REDACTED_CODE_ECHO]');
    }
  });

  it('is idempotent only for exact registered CodeRefs and still filters hard secrets inside them', () => {
    const local: CodeRef = {...ref, symbol: 'privateSharedIdentifierCall'};
    const register = (stream: LLMEchoOutputStream) => stream.registerSnippet('privateSharedIdentifierCall()', local);
    const first = project('privateSharedIdentifierCall()', [], register).output;
    expect(project(first, [], register).output).toBe(first);
    expect(project('[Code: privateSharedIdentifierCall() @ unregistered.kt]', [], register).output).not.toContain('privateSharedIdentifierCall()');
    expect(project(first, [], stream => {register(stream); stream.registerCanary('privateSharedIdentifierCall');}).output)
      .not.toContain('privateSharedIdentifierCall');
    const guarded = project('privateSharedIdentifierCall()', [], stream => {register(stream); stream.registerCanary('privateSharedIdentifierCall');});
    expect(JSON.stringify(guarded.stats)).not.toContain('privateSharedIdentifierCall');
  });

  it('decodes all UTF-8 byte splits consistently around a secret and source text', () => {
    const text = '中文😀 before `fun initializeOnMainThread() { ... }` after 🚀';
    const expected = project(text).output;
    for (let cut = 0; cut <= Buffer.byteLength(text); cut++) expect(project(text, [cut], undefined, true).output).toBe(expected);
    expect(project(text, Array.from({length: Buffer.byteLength(text)}, (_, index) => index), undefined, true).output).toBe(expected);
  });

  it('counts string chunks as the complete UTF-8 input even when a surrogate pair spans writes', () => {
    const text = '中文😀 before `fun initializeOnMainThread() { ... }` after 🚀';
    const expected = project(text);
    for (let cut = 0; cut <= text.length; cut++) {
      const split = project(text, [cut]);
      expect(split.output).toBe(expected.output);
      expect(split.stats.bytesProcessed).toBe(Buffer.byteLength(text));
      expect(split.stats.redactedBytes).toBe(expected.stats.redactedBytes);
    }
    const everyCharacter = project(text, Array.from({length: text.length}, (_, index) => index));
    expect(everyCharacter.stats.bytesProcessed).toBe(Buffer.byteLength(text));
    const orphan = new LLMEchoOutputStream();
    orphan.write('\uD83D');
    orphan.flush();
    expect(orphan.stats().bytesProcessed).toBe(3);
    orphan.flush();
    expect(orphan.stats().bytesProcessed).toBe(3);
  });

  it('counts oversized discarded units correctly across string surrogate boundaries', () => {
    const unit = `"${'safe '.repeat(1300)}😀 end"`;
    const text = `Before ${unit} After`;
    const expected = project(text);
    expect(expected.output).toBe('Before [PRIVATE_OUTPUT_SUPPRESSED] After');
    expect(expected.stats.redactedBytes).toBe(Buffer.byteLength(unit));
    const emoji = text.indexOf('😀');
    for (const cut of [6143, 6144, 6145, emoji, emoji + 1, emoji + 2, text.length]) {
      const split = project(text, [cut]);
      expect(split.output).toBe(expected.output);
      expect(split.stats.bytesProcessed).toBe(Buffer.byteLength(text));
      expect(split.stats.redactedBytes).toBe(Buffer.byteLength(unit));
    }
    const everyCharacter = project(text, Array.from({length: text.length}, (_, index) => index));
    expect(everyCharacter.stats.bytesProcessed).toBe(Buffer.byteLength(text));
    expect(everyCharacter.stats.redactedBytes).toBe(Buffer.byteLength(unit));
    const unclosed = `Before "${'safe '.repeat(1300)}\uD83D`;
    expect(project(unclosed).stats.redactedBytes).toBe(Buffer.byteLength(unclosed.slice(7)));
  });

  it('never leaves a split Unicode scalar when a derived source window starts inside an emoji', () => {
    const snippet = `${'a'.repeat(11)}😀${'中文'.repeat(25)}`;
    const text = `prefix ${snippet.slice(11, 41)} suffix`;
    const register = (stream: LLMEchoOutputStream) => stream.registerSnippet(snippet, ref);
    const complete = project(text, [], register).output;
    expect(Buffer.from(complete, 'utf8').toString('utf8')).toBe(complete);
    for (let cut = 0; cut <= Buffer.byteLength(text); cut++) expect(project(text, [cut], register, true).output).toBe(complete);
  });

  it('suppresses only an over-budget or unclosed unit and resumes following text without a whole-answer cap', () => {
    const long = 'safe '.repeat(700);
    for (const quote of ['"', '`', '```']) {
      const text = `Before ${quote}${long}${quote} After\n${'ordinary text. '.repeat(1000)}`;
      const expected = project(text).output;
      expect(expected).toContain('Before [PRIVATE_OUTPUT_SUPPRESSED] After');
      expect(expected).toContain('ordinary text. '.repeat(1000));
      for (const cut of [1, 63, 2047, 2048, 2049, 4095, text.length - 2]) expect(project(text, [cut]).output).toBe(expected);
      expect(project(text, Array.from({length: text.length}, (_, index) => index)).output).toBe(expected);
    }
    expect(project('Before `unfinished code').output).toBe('Before [PRIVATE_OUTPUT_SUPPRESSED]');
    expect(project('Before “unfinished quote').output).toBe('Before [PRIVATE_OUTPUT_SUPPRESSED]');
  });
});


describe('owner source output isolation', () => {
  const sessionId = 'owner-output-regression';
  afterEach(() => clearCodeAwareOutputGuards(sessionId));
  it('retains source and query but keeps credentials, knowledge and canaries private', () => {
    const source = 'fun executeStartup() { synchronizeWindowLayout(); }';
    registerOnDemandSourceLookupForEcho(sessionId, [{referenceId: 'read', codebaseId: 'app', filePath: 'Main.kt', text: source}]);
    registerPrivateAnalysisQueryForEcho(sessionId, 'Why is startup slow in executeStartup?');
    registerCodeAwareCanary(sessionId, 'CANARY_NEVER_DISPLAY');
    registerCodeAwareLookupForEcho(sessionId, {hits: [{chunkId: 'wiki-chunk', snippet: 'INTERNAL_KNOWLEDGE_PRIVATE_TEXT',
      metadata: {knowledgeSourceId: 'wiki'}}]} as any);
    const text = `${source} Why is startup slow in executeStartup? api_key="private-key-value-123" CANARY_NEVER_DISPLAY INTERNAL_KNOWLEDGE_PRIVATE_TEXT`;
    const owner = sanitizeOwnerCodeAwareText(sessionId, text);
    expect(owner).toContain(source);
    expect(owner).toContain('Why is startup slow');
    expect(owner).not.toContain('private-key-value-123');
    expect(owner).not.toContain('CANARY_NEVER_DISPLAY');
    expect(owner).not.toContain('INTERNAL_KNOWLEDGE_PRIVATE_TEXT');
    expect(sanitizeCodeAwareText(sessionId, source)).not.toContain(source);
  });
  it('preserves source after strict registration overflow and redacts split generated credentials', () => {
    for (let index = 0; index < 201; index++) registerOnDemandSourceLookupForEcho(sessionId,
      [{referenceId: `read-${index}`, codebaseId: 'app', filePath: 'Main.kt', text: `fun boundedSource${index}() { renderFrame(); }`}]);
    const projection = createCodeAwareStreamingTextProjection(sessionId, 'owner-stream', 'owner');
    const output = projection.write('fun boundedSource200() { renderFrame(); }\napi_') +
      projection.write('key="generated-secret-value-123"\n') + projection.flush();
    expect(output).toContain('fun boundedSource200()');
    expect(output).not.toContain('generated-secret-value-123');
    expect(sanitizeCodeAwareText(sessionId, 'anything')).toBe('[PRIVATE_OUTPUT_SUPPRESSED]');
  });
  it('keeps company URLs and commit hashes intact and restores strict scope after errors', () => {
    const context = 'https://ai.company.internal/v1 0123456789abcdef0123456789abcdef01234567';
    expect(sanitizeOwnerCodeAwareText(sessionId, context)).toBe(context);
    expect(() => withOwnerCodeAwareProjection(() => {throw new Error('projection failed');})).toThrow('projection failed');
    expect(() => withOwnerCodeAwareProjection(() => Promise.resolve('invalid'))).toThrow('must be synchronous');
    registerPrivateAnalysisQueryForEcho(sessionId, context);
    expect(sanitizeCodeAwareText(sessionId, context)).not.toBe(context);
  });
  it('redacts quoted credential fields across stream chunks without swallowing answer tokens', () => {
    const text = '{"api_key":"private-key-value-123", "token":"private-token-value-456"}';
    expect(sanitizeOwnerCodeAwareText(sessionId, text)).not.toContain('private-key-value-123');
    expect(sanitizeOwnerCodeAwareText(sessionId, text)).not.toContain('private-token-value-456');
    const stream = createCodeAwareStreamingTextProjection(sessionId, 'json-credential', 'owner');
    const output = stream.write(text.slice(0, 11)) + stream.write(text.slice(11)) + stream.flush();
    expect(output).not.toContain('private-key-value-123');
    expect(output).not.toContain('private-token-value-456');
    const update = projectOwnerCodeAwareStreamingUpdate(sessionId, {type: 'answer_token',
      content: {token: 'A useful source analysis answer', api_key: 'private-key-value-123'}, timestamp: 1}, true, 'en');
    expect(update?.content.token).toBe('A useful source analysis answer');
    expect(update?.content.api_key).toBe('[REDACTED_SECRET]');
  });
  it('revokes buffered owner streams and exposes model process without raw tool payloads', () => {
    const projection = createCodeAwareStreamingTextProjection(sessionId, 'revoked-owner', 'owner');
    projection.write('unfinished private answer');
    revokeCodeAwareOutputGuards(sessionId);
    expect(projection.flush()).toBe('[PRIVATE_OUTPUT_SUPPRESSED]');
    clearCodeAwareOutputGuards(sessionId);
    const update = {type: 'thought' as const, content: {thought: 'Checking renderFrame against the trace.', arguments: {raw: 'tool payload'}}, timestamp: 1};
    expect(projectOwnerCodeAwareStreamingUpdate(sessionId, update, true, 'en')?.content)
      .toEqual({thought: 'Checking renderFrame against the trace.'});
    expect(projectCodeAwareStreamingUpdate(sessionId, update, true, 'en')).toBeNull();
  });
});


describe('semantic input structure budget', () => {
  it('preserves byte-bounded JSON beyond the ordinary output node cap without widening output limits', () => {
    const input = {records: Array.from({length: 3000}, (_, n) => ({n, unit: 'ms'}))};
    expect(Buffer.byteLength(JSON.stringify(input))).toBeLessThan(128 * 1024);
    expect(projectCodeAwareStructuredText(undefined, input).changed).toBe(true);
    expect(projectCodeAwareSemanticInputStructure(undefined, input)).toEqual({value: input, changed: false, limited: false});
  });
  it('keeps depth, oversized strings and semantic structure overflow bounded', () => {
    let deep: unknown = 'value';
    for (let i = 0; i < 30; i++) deep = {child: deep};
    for (const input of [deep, 'x'.repeat(1024 * 1024 + 1),
      Array.from({length: FINAL_SEMANTIC_INPUT_BYTE_LIMIT + 1}, () => 0)]) {
      expect(projectCodeAwareSemanticInputStructure(undefined, input)).toMatchObject({changed: true, limited: true});
    }
  });
  it('records owner credential replacement as content change, not capacity loss', () => {
    const input = {api_key: 'secret-value-for-test'};
    const projected = withOwnerCodeAwareProjection(() => projectCodeAwareSemanticInputStructure(undefined, input));
    expect(projected).toEqual({value: {api_key: '[REDACTED_SECRET]'}, changed: true, limited: false});
  });
});
