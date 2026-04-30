// backend/src/services/providerManager/templates.ts
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { OfficialProviderTemplate } from './types';

export const officialTemplates: OfficialProviderTemplate[] = [
  {
    type: 'anthropic',
    displayName: 'Anthropic',
    requiredFields: ['connection.apiKey'],
    defaultModels: { primary: 'claude-sonnet-4-6', light: 'claude-haiku-4-5' },
    availableModels: [
      { id: 'claude-opus-4-6', name: 'Claude Opus 4.6', tier: 'primary' },
      { id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6', tier: 'primary' },
      { id: 'claude-haiku-4-5', name: 'Claude Haiku 4.5', tier: 'light' },
    ],
  },
  {
    type: 'bedrock',
    displayName: 'AWS Bedrock',
    requiredFields: [],
    defaultModels: { primary: 'claude-sonnet-4-6', light: 'claude-haiku-4-5' },
    availableModels: [
      { id: 'claude-opus-4-6', name: 'Claude Opus 4.6', tier: 'primary' },
      { id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6', tier: 'primary' },
      { id: 'claude-haiku-4-5', name: 'Claude Haiku 4.5', tier: 'light' },
    ],
    defaultConnection: { awsRegion: 'us-east-1' },
  },
  {
    type: 'vertex',
    displayName: 'Google Vertex AI',
    requiredFields: ['connection.gcpProjectId', 'connection.gcpRegion'],
    defaultModels: { primary: 'claude-sonnet-4-6', light: 'claude-haiku-4-5' },
    availableModels: [
      { id: 'claude-opus-4-6', name: 'Claude Opus 4.6', tier: 'primary' },
      { id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6', tier: 'primary' },
      { id: 'claude-haiku-4-5', name: 'Claude Haiku 4.5', tier: 'light' },
    ],
    defaultConnection: { gcpRegion: 'us-central1' },
  },
  {
    type: 'deepseek',
    displayName: 'DeepSeek',
    requiredFields: ['connection.apiKey'],
    defaultModels: { primary: 'deepseek-v4-pro', light: 'deepseek-v4-flash' },
    availableModels: [
      { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro', tier: 'primary' },
      { id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash', tier: 'light' },
      { id: 'deepseek-reasoner', name: 'DeepSeek Reasoner', tier: 'primary' },
    ],
    defaultConnection: { baseUrl: 'https://api.deepseek.com' },
  },
  {
    type: 'openai',
    displayName: 'OpenAI',
    requiredFields: ['connection.apiKey'],
    defaultModels: { primary: 'gpt-5.5', light: 'gpt-5.4-mini' },
    availableModels: [
      { id: 'gpt-5.5', name: 'GPT-5.5', tier: 'primary' },
      { id: 'gpt-5.4-mini', name: 'GPT-5.4 Mini', tier: 'light' },
    ],
    defaultConnection: { baseUrl: 'https://api.openai.com/v1' },
  },
  {
    type: 'ollama',
    displayName: 'Ollama (Local)',
    requiredFields: ['connection.baseUrl'],
    defaultModels: { primary: 'qwen3:30b', light: 'qwen3:30b' },
    availableModels: [],
    defaultConnection: { baseUrl: 'http://localhost:11434/v1' },
  },
];
