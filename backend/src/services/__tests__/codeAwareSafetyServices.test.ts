// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {afterEach, beforeEach, describe, expect, it} from '@jest/globals';

import {makeSparkProvenance, type RagChunk, type RagRetrievalResult} from '../../types/sparkContracts';
import {createDataEnvelope} from '../../types/dataContract';
import {CodebaseRegistry} from '../codebase/codebaseRegistry';
import {CodeLookupLedger} from '../codebase/codeLookupLedger';
import {filterRagLookup} from '../rag/lookupResponseFilter';
import {SessionToolResultRegistry, projectedSidecarMissing} from '../rag/sessionToolResultRegistry';
import {
  projectRagResultForSseAndLog,
  projectToolResultForExternalSurface,
} from '../rag/toolResultProjectionFilter';
import * as toolResultProjection from '../rag/toolResultProjectionFilter';
import {
  clearAllCodeAwareOutputGuards,
  createCodeAwareStreamingTextProjection,
  registerCodeAwareCanary,
  registerPrivateAnalysisQueryForEcho,
  sanitizeCodeAwareText,
} from '../security/codeAwareOutputRegistry';
import {projectCodeAwareStreamingUpdate} from '../security/codeAwareStreamingUpdateProjection';
import {LLMEchoOutputStream, type CodeRef} from '../security/llmEchoOutputFilter';
import {ExternalKnowledgeSourceRegistry} from '../externalKnowledgeSourceRegistry';

let tmpDir: string;
const CODEBASE_SCOPE = {
  tenantId: 'tenant-test',
  workspaceId: 'workspace-test',
  userId: 'tester',
};

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
  return {
    registry,
    codebaseId: ref.codebaseId,
    sourceGeneration: `codebase_${ref.indexGeneration}`,
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
    });
  });
});

describe('filterRagLookup', () => {
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

describe('code-aware output registry bounds', () => {
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

  it('suppresses live answer tokens and replaces reasoning with localized progress', () => {
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

    expect(answer.content).toEqual({suppressed: true});
    expect(JSON.stringify(answer)).not.toContain('PRIVATE_TOKEN_CANARY');
    expect(thought.type).toBe('progress');
    expect(thought.content).toEqual(expect.objectContaining({
      phase: 'thought',
      privateModelTextSuppressed: true,
    }));
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

    expect(projected.type).toBe('progress');
    expect(projected.content).toEqual(expect.objectContaining({
      privateModelTextSuppressed: true,
      sourceEventType: type,
    }));
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
    expect(projected.type).toBe('progress');
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

    expect(projected.type).toBe('data');
    expect(JSON.stringify(projected)).not.toContain(canary);
    expect(projected.content).not.toHaveProperty('sql');
    expect(projected.content.meta).not.toHaveProperty('queryReview');
    expect(projected.content.meta).not.toHaveProperty('intent');
    expect(projected.content.data.rows[0][0]).toBe(42);
    expect(projected.content.data).not.toHaveProperty('executableSql');
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
      expect(projected.content.privateModelTextSuppressed).toBe(true);
    }
  });

  it('preserves only a privacy-safe degraded diagnostic code for private E2E gates', () => {
    const projected = projectCodeAwareStreamingUpdate(
      'session-stream',
      {
        type: 'degraded',
        content: {
          fallback: 'verification_failed',
          message: 'PRIVATE_DEGRADED_MESSAGE_CANARY',
        },
        timestamp,
      },
      true,
      'en',
    );

    expect(projected.type).toBe('progress');
    expect(projected.content).toMatchObject({
      sourceEventType: 'degraded',
      degradedFallback: 'verification_failed',
      privateModelTextSuppressed: true,
    });
    expect(JSON.stringify(projected)).not.toContain('PRIVATE_DEGRADED_MESSAGE_CANARY');

    const unsafe = projectCodeAwareStreamingUpdate(
      'session-stream',
      {
        type: 'degraded',
        content: {fallback: 'PRIVATE_UNSAFE_FALLBACK_CANARY'},
        timestamp,
      },
      true,
      'en',
    );
    expect(unsafe.content).not.toHaveProperty('degradedFallback');
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
    expect(conclusion.content.conclusion).not.toContain('CONCLUSION_PRIVATE_CANARY');
    expect(conclusion.content).not.toHaveProperty('rawAnswer');
    expect(conclusion.content).not.toHaveProperty('findings');
    expect(conclusion.content.confidence).toBe(0.8);
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
