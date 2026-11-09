// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {createHmac, randomBytes} from 'crypto';
import * as os from 'os';
import * as path from 'path';

import {parse as parseToml} from 'smol-toml';

import {isLoopbackRequestHostname} from '../../security/requestOriginPolicy';
import {readBoundedMetadataFile} from '../codebase/boundedMetadataFile';
import {PublicRequestError} from '../../utils/publicRequestError';
import type {OpenAIProtocol, ProviderConfig, ProviderCreateInput} from './types';

/**
 * One-time import of a third-party gateway the user already configured in
 * Claude Code or Codex. CC Switch writes its active provider to the same two
 * files, so it needs no reader of its own.
 *
 * The boundary is deliberately narrow: a user click starts it, only the named
 * fields of those two files are read, a key never leaves the backend, and a
 * native dialog confirms the endpoint before the key is stored. Login tokens
 * (Keychain, `.credentials.json`, `auth.json`) and CC Switch's own database are
 * never opened: they are account sessions, not gateway configuration.
 */

const MAX_CONFIG_BYTES = 1024 * 1024;
const CANDIDATE_TTL_MS = 5 * 60 * 1000;
const MAX_MODEL_LENGTH = 200;
const PROXY_PLACEHOLDER_KEY = 'PROXY_MANAGED';
const CLAUDE_MODEL_ALIAS = /^(?:opus|sonnet|haiku|fable|default|best|opusplan)(?:\[[^\]]*\])?$/i;
const USABLE_MODEL = /^[^\s\u0000-\u001f\u007f]+$/;

type LocalAiTool = 'claude_code' | 'codex';
type LocalAiToolSourceStatus = 'found' | 'not_found' | 'unreadable';
type LocalAiCandidateStatus = 'ready' | 'needs_model' | 'needs_key' | 'proxy_managed' | 'unsupported';
type LocalAiCandidateProtocol = 'anthropic' | OpenAIProtocol;

interface LocalAiToolSource {
  tool: LocalAiTool;
  path: string;
  status: LocalAiToolSourceStatus;
}

interface LocalAiImportCandidate {
  candidateId: string;
  tool: LocalAiTool;
  endpoint?: string;
  protocol?: LocalAiCandidateProtocol;
  primaryModel?: string;
  lightModel?: string;
  hasKey: boolean;
  status: LocalAiCandidateStatus;
  reason?: 'api_key_helper' | 'env_key' | 'invalid_endpoint' | 'cloud_provider';
  existingProviderId?: string;
}

interface LocalAiImportScan {
  sources: LocalAiToolSource[];
  candidates: LocalAiImportCandidate[];
}

type LocalAiImportScope = Readonly<{tenantId?: string; workspaceId?: string; userId?: string}>;

type ParsedCandidate = Omit<LocalAiImportCandidate, 'candidateId' | 'hasKey' | 'existingProviderId'> & {
  apiKey?: string;
  authToken?: string;
};

interface IssuedCandidate {
  scopeKey: string;
  tool: LocalAiTool;
  fingerprint: string;
  expiresAt: number;
  importing: boolean;
}

export class LocalAiImportError extends PublicRequestError {}

interface LocalAiImportDependencies<Scope extends LocalAiImportScope> {
  env?: NodeJS.ProcessEnv;
  homeDirectory?: string;
  now?: () => number;
  idGenerator?: () => string;
  readFile?: (filePath: string) => Promise<string>;
  confirm(message: string): Promise<boolean>;
  listProviders(scope: Scope): ProviderConfig[];
  createProvider(input: ProviderCreateInput, scope: Scope): ProviderConfig;
}

function nonEmpty(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** `scheme://host[:port][/path]` of an endpoint a key may be sent to, or undefined when it may not. */
function normalizedEndpoint(value: string): string | undefined {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  if (url.username || url.password || url.search || url.hash) return undefined;
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLoopbackRequestHostname(url.hostname))) return undefined;
  return `${url.protocol}//${url.host}${url.pathname.replace(/\/+$/, '')}`;
}

function usableModel(value: unknown): string | undefined {
  const model = nonEmpty(value);
  return model && model.length <= MAX_MODEL_LENGTH && USABLE_MODEL.test(model) ? model : undefined;
}

function claudeModel(value: unknown): string | undefined {
  const model = usableModel(value);
  return model && !CLAUDE_MODEL_ALIAS.test(model) ? model : undefined;
}

function candidateFromEndpoint(
  base: Pick<ParsedCandidate, 'tool' | 'protocol' | 'primaryModel' | 'lightModel' | 'apiKey' | 'authToken'>,
  rawEndpoint: string | undefined,
): ParsedCandidate {
  const endpoint = rawEndpoint ? normalizedEndpoint(rawEndpoint) : undefined;
  if (rawEndpoint && !endpoint) {
    return {tool: base.tool, protocol: base.protocol, status: 'unsupported', reason: 'invalid_endpoint'};
  }
  const secret = base.authToken ?? base.apiKey;
  if (secret === PROXY_PLACEHOLDER_KEY && endpoint && isLoopbackRequestHostname(new URL(endpoint).hostname)) {
    return {tool: base.tool, endpoint, protocol: base.protocol, primaryModel: base.primaryModel,
      lightModel: base.lightModel, status: 'proxy_managed'};
  }
  return {...base, endpoint, status: base.primaryModel ? 'ready' : 'needs_model'};
}

export function parseClaudeSettings(text: string): ParsedCandidate | undefined {
  const settings: unknown = JSON.parse(text);
  if (!isRecord(settings)) return undefined;
  const env = isRecord(settings.env) ? settings.env : {};
  const rawEndpoint = nonEmpty(env.ANTHROPIC_BASE_URL);
  const authToken = nonEmpty(env.ANTHROPIC_AUTH_TOKEN);
  const apiKey = nonEmpty(env.ANTHROPIC_API_KEY);
  if (env.CLAUDE_CODE_USE_BEDROCK || env.CLAUDE_CODE_USE_VERTEX) {
    return {tool: 'claude_code', protocol: 'anthropic', status: 'unsupported', reason: 'cloud_provider'};
  }
  if (!authToken && !apiKey) {
    if (!rawEndpoint && !nonEmpty(settings.apiKeyHelper)) return undefined;
    return {tool: 'claude_code', endpoint: rawEndpoint ? normalizedEndpoint(rawEndpoint) : undefined, protocol: 'anthropic',
      status: 'needs_key', ...(nonEmpty(settings.apiKeyHelper) ? {reason: 'api_key_helper' as const} : {})};
  }
  const primaryModel = claudeModel(env.ANTHROPIC_MODEL) ?? claudeModel(settings.model) ??
    claudeModel(env.ANTHROPIC_DEFAULT_SONNET_MODEL) ?? claudeModel(env.ANTHROPIC_DEFAULT_OPUS_MODEL);
  const lightModel = claudeModel(env.ANTHROPIC_DEFAULT_HAIKU_MODEL) ?? claudeModel(env.ANTHROPIC_SMALL_FAST_MODEL) ?? primaryModel;
  return candidateFromEndpoint({tool: 'claude_code', protocol: 'anthropic', primaryModel, lightModel, apiKey, authToken}, rawEndpoint);
}

export function parseCodexConfig(text: string): ParsedCandidate | undefined {
  const config: unknown = parseToml(text);
  if (!isRecord(config)) return undefined;
  const providerId = nonEmpty(config.model_provider);
  const providers = isRecord(config.model_providers) ? config.model_providers : {};
  const provider = providerId && isRecord(providers[providerId]) ? providers[providerId] as Record<string, unknown> : undefined;
  if (!provider) return undefined;
  const rawEndpoint = nonEmpty(provider.base_url);
  if (!rawEndpoint) return undefined;
  const protocol: OpenAIProtocol = provider.wire_api === 'chat' ? 'chat_completions' : 'responses';
  const apiKey = nonEmpty(provider.experimental_bearer_token);
  if (!apiKey) {
    // `env_key` names a variable of the Codex shell. Resolving it here would let a
    // config file point this backend's own secrets at an endpoint of its choosing.
    return {tool: 'codex', endpoint: normalizedEndpoint(rawEndpoint), protocol, status: 'needs_key',
      ...(nonEmpty(provider.env_key) ? {reason: 'env_key' as const} : {})};
  }
  const primaryModel = usableModel(config.model);
  return candidateFromEndpoint({tool: 'codex', protocol, primaryModel, lightModel: primaryModel, apiKey}, rawEndpoint);
}

function connectionFor(candidate: ParsedCandidate): ProviderCreateInput['connection'] {
  if (candidate.tool === 'claude_code') {
    return {
      apiSurface: 'claude',
      ...(candidate.endpoint ? {claudeBaseUrl: candidate.endpoint} : {}),
      ...(candidate.authToken ? {claudeAuthToken: candidate.authToken} : {claudeApiKey: candidate.apiKey}),
    };
  }
  return {
    apiSurface: 'openai',
    openaiBaseUrl: candidate.endpoint,
    openaiApiKey: candidate.apiKey,
    openaiProtocol: candidate.protocol as OpenAIProtocol,
  };
}

function storedEndpoint(provider: ProviderConfig): string | undefined {
  const value = provider.connection.claudeBaseUrl ?? provider.connection.openaiBaseUrl ?? provider.connection.baseUrl;
  return value ? normalizedEndpoint(value) ?? value : undefined;
}

export class LocalAiToolImporter<Scope extends LocalAiImportScope> {
  private readonly env: NodeJS.ProcessEnv;
  private readonly homeDirectory: string;
  private readonly now: () => number;
  private readonly idGenerator: () => string;
  private readonly readFile: (filePath: string) => Promise<string>;
  private readonly fingerprintKey = randomBytes(32);
  private readonly issued = new Map<string, IssuedCandidate>();

  constructor(private readonly deps: LocalAiImportDependencies<Scope>) {
    this.env = deps.env ?? process.env;
    this.homeDirectory = deps.homeDirectory ?? os.homedir();
    this.now = deps.now ?? Date.now;
    this.idGenerator = deps.idGenerator ?? (() => randomBytes(24).toString('base64url'));
    this.readFile = deps.readFile ?? (filePath => readBoundedMetadataFile({filePath, maxBytes: MAX_CONFIG_BYTES}));
  }

  /** The exact files a scan would open, shown to the user before it runs. */
  sourcePaths(): Array<{tool: LocalAiTool; path: string}> {
    const claudeHome = nonEmpty(this.env.CLAUDE_CONFIG_DIR) ?? path.join(this.homeDirectory, '.claude');
    const codexHome = nonEmpty(this.env.CODEX_HOME) ?? path.join(this.homeDirectory, '.codex');
    return [
      {tool: 'claude_code', path: path.join(claudeHome, 'settings.json')},
      {tool: 'codex', path: path.join(codexHome, 'config.toml')},
    ];
  }

  async scan(scope: Scope): Promise<LocalAiImportScan> {
    const scopeKey = this.scopeKey(scope);
    this.dropExpired();
    for (const [id, entry] of this.issued) {
      if (entry.scopeKey === scopeKey && !entry.importing) this.issued.delete(id);
    }
    const existing = this.deps.listProviders(scope);
    const sources: LocalAiToolSource[] = [];
    const candidates: LocalAiImportCandidate[] = [];
    for (const source of this.sourcePaths()) {
      const read = await this.readSource(source.tool, source.path);
      sources.push({...source, status: read.status});
      if (!read.candidate) continue;
      const candidate = read.candidate;
      const candidateId = this.idGenerator();
      this.issued.set(candidateId, {
        scopeKey, tool: source.tool, fingerprint: this.fingerprint(candidate),
        expiresAt: this.now() + CANDIDATE_TTL_MS, importing: false,
      });
      const duplicate = existing.find(provider =>
        storedEndpoint(provider) === candidate.endpoint && provider.models.primary === candidate.primaryModel);
      candidates.push({
        candidateId,
        tool: candidate.tool,
        endpoint: candidate.endpoint,
        primaryModel: candidate.primaryModel,
        hasKey: Boolean(candidate.apiKey ?? candidate.authToken),
        status: candidate.status,
        reason: candidate.reason,
        existingProviderId: duplicate?.id,
      });
    }
    return {sources, candidates};
  }

  /** Re-reads the file, so a key is only ever held for the duration of this call. */
  async importCandidate(
    candidateId: unknown,
    models: {primary?: unknown; light?: unknown} | undefined,
    scope: Scope,
  ): Promise<{imported: true; provider: ProviderConfig} | {imported: false; cancelled: true}> {
    this.dropExpired();
    const entry = typeof candidateId === 'string' ? this.issued.get(candidateId) : undefined;
    if (!entry || entry.scopeKey !== this.scopeKey(scope)) {
      throw new LocalAiImportError('LOCAL_AI_CANDIDATE_NOT_FOUND', 'This scan result has expired; scan again', 404);
    }
    if (entry.importing) throw new LocalAiImportError('LOCAL_AI_IMPORT_BUSY', 'This import is already in progress', 409);
    entry.importing = true;
    try {
      const source = this.sourcePaths().find(item => item.tool === entry.tool)!;
      const candidate = (await this.readSource(source.tool, source.path)).candidate;
      if (!candidate || this.fingerprint(candidate) !== entry.fingerprint) {
        throw new LocalAiImportError('LOCAL_AI_CANDIDATE_CHANGED', 'The configuration changed after the scan; scan again', 409);
      }
      if (candidate.status !== 'ready' && candidate.status !== 'needs_model') {
        throw new LocalAiImportError('LOCAL_AI_CANDIDATE_UNUSABLE', 'This configuration cannot be imported', 400);
      }
      const primary = usableModel(models?.primary) ?? candidate.primaryModel;
      if (!primary) throw new LocalAiImportError('LOCAL_AI_MODEL_REQUIRED', 'A model id is required', 400);
      const light = usableModel(models?.light) ?? candidate.lightModel ?? primary;
      const toolName = candidate.tool === 'claude_code' ? 'Claude Code' : 'Codex';
      const endpoint = candidate.endpoint ?? 'https://api.anthropic.com';
      const approved = await this.deps.confirm([
        `Import the AI provider configured in ${toolName}?`,
        `Endpoint: ${endpoint}`,
        `Model: ${primary}`,
        'The key will be saved in SmartPerfetto\'s local providers.json, in plain text and readable only by this user.',
      ].join('\n'));
      if (!approved) return {imported: false, cancelled: true};
      const official = candidate.tool === 'claude_code' && !candidate.endpoint;
      const provider = this.deps.createProvider({
        name: `${toolName} · ${new URL(endpoint).host}`,
        category: official ? 'official' : 'custom',
        type: official ? 'anthropic' : 'custom',
        models: {primary, light},
        connection: connectionFor(candidate),
      }, scope);
      this.issued.delete(candidateId as string);
      return {imported: true, provider};
    } finally {
      entry.importing = false;
    }
  }

  private async readSource(tool: LocalAiTool, filePath: string): Promise<{status: LocalAiToolSourceStatus; candidate?: ParsedCandidate}> {
    let text: string;
    try {
      text = await this.readFile(filePath);
    } catch (error) {
      return {status: (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'not_found' : 'unreadable'};
    }
    try {
      return {status: 'found', candidate: tool === 'claude_code' ? parseClaudeSettings(text) : parseCodexConfig(text)};
    } catch {
      // A parser's message can quote the file, which may hold a key.
      return {status: 'unreadable'};
    }
  }

  private fingerprint(candidate: ParsedCandidate): string {
    return createHmac('sha256', this.fingerprintKey).update(JSON.stringify([
      candidate.tool, candidate.endpoint, candidate.protocol, candidate.primaryModel, candidate.lightModel,
      candidate.apiKey, candidate.authToken, candidate.status,
    ])).digest('hex');
  }

  private scopeKey(scope: Scope): string {
    return [scope.tenantId ?? '', scope.workspaceId ?? '', scope.userId ?? ''].join('\0');
  }

  private dropExpired(): void {
    const now = this.now();
    for (const [id, entry] of this.issued) {
      if (entry.expiresAt <= now && !entry.importing) this.issued.delete(id);
    }
  }
}
