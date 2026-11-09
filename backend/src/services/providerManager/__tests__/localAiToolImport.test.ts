// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {afterEach, beforeEach, describe, expect, it, jest} from '@jest/globals';

import {LocalAiToolImporter, parseClaudeSettings, parseCodexConfig} from '../localAiToolImport';
import {ProviderService} from '../providerService';
import type {ProviderScope} from '../types';

const SCOPE: ProviderScope = {tenantId: 't', workspaceId: 'w', userId: 'u'};
const KEY = 'synthetic-gateway-key-0123456789';

let home: string;
let service: ProviderService;
let confirm: jest.Mock<(message: string) => Promise<boolean>>;
let now: number;
let reads: string[];

function importer(env: NodeJS.ProcessEnv = {}): LocalAiToolImporter<ProviderScope> {
  return new LocalAiToolImporter<ProviderScope>({
    env,
    homeDirectory: home,
    now: () => now,
    readFile: async filePath => {
      reads.push(filePath);
      return fs.readFileSync(filePath, 'utf8');
    },
    confirm,
    listProviders: scope => service.list(scope),
    createProvider: (input, scope) => service.create(input, scope),
  });
}

function writeClaude(settings: unknown): void {
  fs.mkdirSync(path.join(home, '.claude'), {recursive: true});
  fs.writeFileSync(path.join(home, '.claude/settings.json'), JSON.stringify(settings));
}

function writeCodex(text: string): void {
  fs.mkdirSync(path.join(home, '.codex'), {recursive: true});
  fs.writeFileSync(path.join(home, '.codex/config.toml'), text);
}

const gateway = (extra: Record<string, string> = {}) => ({env: {
  ANTHROPIC_BASE_URL: 'https://gateway.example.com/anthropic/',
  ANTHROPIC_AUTH_TOKEN: KEY,
  ANTHROPIC_MODEL: 'glm-5',
  ...extra,
}});

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'local-ai-import-'));
  service = new ProviderService(path.join(home, 'providers.json'));
  confirm = jest.fn<(message: string) => Promise<boolean>>().mockResolvedValue(true);
  now = 1_000;
  reads = [];
});

afterEach(() => {
  fs.rmSync(home, {recursive: true, force: true});
});

describe('reading Claude Code settings', () => {
  it('keeps a bearer token apart from an API key', () => {
    expect(parseClaudeSettings(JSON.stringify(gateway()))).toMatchObject({authToken: KEY, status: 'ready', primaryModel: 'glm-5'});
    expect(parseClaudeSettings(JSON.stringify({env: {ANTHROPIC_API_KEY: KEY, ANTHROPIC_MODEL: 'm'}})))
      .toMatchObject({apiKey: KEY, endpoint: undefined, status: 'ready'});
  });

  it('does not treat a model alias as a model id', () => {
    expect(parseClaudeSettings(JSON.stringify({env: {ANTHROPIC_API_KEY: KEY, ANTHROPIC_MODEL: 'opus[1m]'}, model: 'sonnet'})))
      .toMatchObject({status: 'needs_model', primaryModel: undefined});
  });

  it('offers nothing for a plain subscription login', () => {
    expect(parseClaudeSettings(JSON.stringify({model: 'opus'}))).toBeUndefined();
  });

  it('names what it will not do', () => {
    expect(parseClaudeSettings(JSON.stringify({apiKeyHelper: '/bin/key'}))).toMatchObject({status: 'needs_key', reason: 'api_key_helper'});
    expect(parseClaudeSettings(JSON.stringify({env: {CLAUDE_CODE_USE_BEDROCK: '1', ANTHROPIC_API_KEY: KEY}})))
      .toMatchObject({status: 'unsupported', reason: 'cloud_provider'});
  });

  it('recognizes the CC Switch proxy placeholder without treating it as a key', () => {
    const parsed = parseClaudeSettings(JSON.stringify({env: {
      ANTHROPIC_BASE_URL: 'http://127.0.0.1:15721', ANTHROPIC_AUTH_TOKEN: 'PROXY_MANAGED', ANTHROPIC_MODEL: 'm',
    }}));
    expect(parsed).toMatchObject({status: 'proxy_managed'});
    expect(parsed?.authToken).toBeUndefined();
  });

  it.each([
    'http://gateway.example.com',
    'https://user:pass@gateway.example.com',
    'https://gateway.example.com?key=x',
    'ftp://gateway.example.com',
  ])('refuses to send a key to %s', endpoint => {
    expect(parseClaudeSettings(JSON.stringify(gateway({ANTHROPIC_BASE_URL: endpoint}))))
      .toMatchObject({status: 'unsupported', reason: 'invalid_endpoint'});
  });
});

describe('reading Codex configuration', () => {
  const custom = (fields: string) => `model = "gpt-x"\nmodel_provider = "gw"\n[model_providers.gw]\nbase_url = "https://gw.example.com/v1"\n${fields}\n`;

  it('reads the bearer token and the wire protocol', () => {
    expect(parseCodexConfig(custom(`experimental_bearer_token = "${KEY}"\nwire_api = "chat"`)))
      .toMatchObject({apiKey: KEY, protocol: 'chat_completions', status: 'ready'});
    expect(parseCodexConfig(custom(`experimental_bearer_token = "${KEY}"`))).toMatchObject({protocol: 'responses'});
  });

  it('never resolves env_key', () => {
    const parsed = parseCodexConfig(custom('env_key = "SMARTPERFETTO_SECRET_STORE_MASTER_KEY"'));
    expect(parsed).toMatchObject({status: 'needs_key', reason: 'env_key'});
    expect(parsed?.apiKey).toBeUndefined();
  });

  it('offers nothing for the official login', () => {
    expect(parseCodexConfig('model = "gpt-x"\n')).toBeUndefined();
  });
});

describe('LocalAiToolImporter', () => {
  it('opens only the two allowlisted files and honors their overrides', async () => {
    const custom = path.join(home, 'custom-claude');
    fs.mkdirSync(custom);
    fs.writeFileSync(path.join(custom, 'settings.json'), JSON.stringify(gateway()));
    await importer({CLAUDE_CONFIG_DIR: custom}).scan(SCOPE);
    expect(reads).toEqual([path.join(custom, 'settings.json'), path.join(home, '.codex/config.toml')]);
  });

  it('never exposes a key in the scan result', async () => {
    writeClaude(gateway());
    const scan = await importer().scan(SCOPE);
    expect(JSON.stringify(scan)).not.toContain(KEY);
    expect(scan.candidates[0]).toMatchObject({tool: 'claude_code', endpoint: 'https://gateway.example.com/anthropic', hasKey: true});
  });

  it('reports a malformed file without quoting it', async () => {
    fs.mkdirSync(path.join(home, '.claude'), {recursive: true});
    fs.writeFileSync(path.join(home, '.claude/settings.json'), `{"env": ${KEY}`);
    const scan = await importer().scan(SCOPE);
    expect(scan.sources[0].status).toBe('unreadable');
    expect(JSON.stringify(scan)).not.toContain(KEY);
  });

  it('confirms natively, then stores the token as a bearer token, inactive', async () => {
    writeClaude(gateway());
    const subject = importer();
    const {candidates} = await subject.scan(SCOPE);
    const result = await subject.importCandidate(candidates[0].candidateId, undefined, SCOPE);
    expect(confirm.mock.calls[0][0]).toContain('https://gateway.example.com/anthropic');
    expect(confirm.mock.calls[0][0]).not.toContain(KEY);
    expect(result.imported).toBe(true);
    if (!result.imported) return;
    const stored = service.getRawProvider(result.provider.id);
    expect(stored?.connection).toMatchObject({claudeAuthToken: KEY, claudeBaseUrl: 'https://gateway.example.com/anthropic', apiSurface: 'claude'});
    expect(stored?.connection.claudeApiKey).toBeUndefined();
    expect(result.provider.isActive).toBe(false);
  });

  it('imports an official Anthropic key without inventing an endpoint', async () => {
    writeClaude({env: {ANTHROPIC_API_KEY: KEY, ANTHROPIC_MODEL: 'claude-x'}});
    const subject = importer();
    const {candidates} = await subject.scan(SCOPE);
    const result = await subject.importCandidate(candidates[0].candidateId, undefined, SCOPE);
    expect(result.imported && result.provider.type).toBe('anthropic');
  });

  it('imports a Codex gateway with its protocol', async () => {
    writeCodex(`model = "gpt-x"\nmodel_provider = "gw"\n[model_providers.gw]\nbase_url = "https://gw.example.com/v1"\nexperimental_bearer_token = "${KEY}"\nwire_api = "chat"\n`);
    const subject = importer();
    const {candidates} = await subject.scan(SCOPE);
    const result = await subject.importCandidate(candidates[0].candidateId, undefined, SCOPE);
    expect(result.imported && service.getRawProvider(result.provider.id)?.connection)
      .toMatchObject({openaiBaseUrl: 'https://gw.example.com/v1', openaiApiKey: KEY, openaiProtocol: 'chat_completions'});
  });

  it('requires a model id where the file only has an alias', async () => {
    writeClaude(gateway({ANTHROPIC_MODEL: 'opus'}));
    const subject = importer();
    const {candidates} = await subject.scan(SCOPE);
    await expect(subject.importCandidate(candidates[0].candidateId, undefined, SCOPE))
      .rejects.toMatchObject({code: 'LOCAL_AI_MODEL_REQUIRED'});
    const result = await subject.importCandidate(candidates[0].candidateId, {primary: 'glm-5'}, SCOPE);
    expect(result.imported && result.provider.models).toEqual({primary: 'glm-5', light: 'glm-5'});
  });

  it('stores nothing when the native dialog is declined, and the scan stays usable', async () => {
    confirm.mockResolvedValueOnce(false);
    writeClaude(gateway());
    const subject = importer();
    const {candidates} = await subject.scan(SCOPE);
    expect(await subject.importCandidate(candidates[0].candidateId, undefined, SCOPE)).toEqual({imported: false, cancelled: true});
    expect(service.list(SCOPE)).toHaveLength(0);
    expect((await subject.importCandidate(candidates[0].candidateId, undefined, SCOPE)).imported).toBe(true);
  });

  it('refuses when the imported fields changed after the scan, but ignores unrelated edits', async () => {
    writeClaude(gateway());
    const subject = importer();
    let {candidates} = await subject.scan(SCOPE);
    writeClaude({...gateway(), permissions: {allow: ['x']}});
    expect((await subject.importCandidate(candidates[0].candidateId, undefined, SCOPE)).imported).toBe(true);
    ({candidates} = await subject.scan(SCOPE));
    writeClaude(gateway({ANTHROPIC_BASE_URL: 'https://attacker.example.com'}));
    await expect(subject.importCandidate(candidates[0].candidateId, undefined, SCOPE))
      .rejects.toMatchObject({code: 'LOCAL_AI_CANDIDATE_CHANGED'});
    expect(confirm).toHaveBeenCalledTimes(1);
  });

  it('binds a candidate to its scope, one use and a time limit', async () => {
    writeClaude(gateway());
    const subject = importer();
    const {candidates} = await subject.scan(SCOPE);
    const id = candidates[0].candidateId;
    await expect(subject.importCandidate(id, undefined, {...SCOPE, userId: 'other'}))
      .rejects.toMatchObject({code: 'LOCAL_AI_CANDIDATE_NOT_FOUND'});
    await subject.importCandidate(id, undefined, SCOPE);
    await expect(subject.importCandidate(id, undefined, SCOPE)).rejects.toMatchObject({code: 'LOCAL_AI_CANDIDATE_NOT_FOUND'});
    const again = await subject.scan(SCOPE);
    now += 6 * 60 * 1000;
    await expect(subject.importCandidate(again.candidates[0].candidateId, undefined, SCOPE))
      .rejects.toMatchObject({code: 'LOCAL_AI_CANDIDATE_NOT_FOUND'});
  });

  it('flags an existing provider without hiding the candidate', async () => {
    writeClaude(gateway());
    const subject = importer();
    const first = await subject.scan(SCOPE);
    await subject.importCandidate(first.candidates[0].candidateId, undefined, SCOPE);
    expect((await subject.scan(SCOPE)).candidates[0].existingProviderId).toBeDefined();
  });

  it('saves the provider store readable only by this user', async () => {
    writeClaude(gateway());
    const subject = importer();
    const {candidates} = await subject.scan(SCOPE);
    await subject.importCandidate(candidates[0].candidateId, undefined, SCOPE);
    if (process.platform !== 'win32') {
      expect(fs.statSync(path.join(home, 'providers.json')).mode & 0o777).toBe(0o600);
    }
  });
});
