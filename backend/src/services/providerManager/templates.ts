// backend/src/services/providerManager/templates.ts
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { OfficialProviderTemplate } from './types';

export const officialTemplates: OfficialProviderTemplate[] = [
  {
    type: 'anthropic',
    displayName: 'Anthropic',
    requiredFields: ['connection.claudeApiKey'],
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
    defaultConnection: {
      agentRuntime: 'claude-agent-sdk',
      claudeBaseUrl: 'https://api.deepseek.com/anthropic',
      openaiBaseUrl: 'https://api.deepseek.com/v1',
      openaiProtocol: 'chat_completions',
    },
  },
  {
    type: 'glm',
    displayName: 'GLM / Z.ai',
    requiredFields: ['connection.apiKey'],
    defaultModels: { primary: 'glm-5.1', light: 'glm-4.5-air' },
    availableModels: [
      { id: 'glm-5.1', name: 'GLM 5.1', tier: 'primary' },
      { id: 'glm-4.5-air', name: 'GLM 4.5 Air', tier: 'light' },
    ],
    defaultConnection: {
      agentRuntime: 'claude-agent-sdk',
      claudeBaseUrl: 'https://open.bigmodel.cn/api/anthropic',
      openaiBaseUrl: 'https://open.bigmodel.cn/api/paas/v4',
      openaiProtocol: 'chat_completions',
    },
  },
  {
    type: 'qwen',
    displayName: 'Qwen / Alibaba Cloud Model Studio',
    requiredFields: ['connection.apiKey'],
    defaultModels: { primary: 'qwen3.6-plus', light: 'qwen3.6-flash' },
    availableModels: [
      { id: 'qwen3.6-plus', name: 'Qwen 3.6 Plus', tier: 'primary' },
      { id: 'qwen3.6-flash', name: 'Qwen 3.6 Flash', tier: 'light' },
    ],
    defaultConnection: {
      agentRuntime: 'claude-agent-sdk',
      claudeBaseUrl: 'https://dashscope.aliyuncs.com/apps/anthropic',
      openaiBaseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      openaiProtocol: 'chat_completions',
    },
  },
  {
    type: 'qwen_coding',
    displayName: 'Qwen Coding Plan',
    requiredFields: ['connection.apiKey'],
    defaultModels: { primary: 'qwen3-coder-plus', light: 'qwen3-coder-plus' },
    availableModels: [
      { id: 'qwen3-coder-plus', name: 'Qwen 3 Coder Plus', tier: 'primary' },
      { id: 'qwen3-max-2026-01-23', name: 'Qwen 3 Max', tier: 'primary' },
    ],
    defaultConnection: {
      agentRuntime: 'claude-agent-sdk',
      claudeBaseUrl: 'https://coding-intl.dashscope.aliyuncs.com/apps/anthropic',
      openaiBaseUrl: 'https://coding-intl.dashscope.aliyuncs.com/v1',
      openaiProtocol: 'chat_completions',
    },
  },
  {
    type: 'kimi_code',
    displayName: 'Kimi Code Membership',
    requiredFields: ['connection.apiKey'],
    defaultModels: { primary: 'kimi-for-coding', light: 'kimi-for-coding' },
    availableModels: [
      { id: 'kimi-for-coding', name: 'Kimi for Coding', tier: 'primary' },
    ],
    defaultConnection: {
      agentRuntime: 'claude-agent-sdk',
      claudeBaseUrl: 'https://api.kimi.com/coding/',
      openaiBaseUrl: 'https://api.kimi.com/coding/v1',
      openaiProtocol: 'chat_completions',
    },
  },
  {
    type: 'kimi',
    displayName: 'Kimi / Moonshot Platform',
    requiredFields: ['connection.apiKey'],
    defaultModels: { primary: 'kimi-k2.5', light: 'kimi-k2.5' },
    availableModels: [
      { id: 'kimi-k2.5', name: 'Kimi K2.5', tier: 'primary' },
    ],
    defaultConnection: {
      agentRuntime: 'claude-agent-sdk',
      claudeBaseUrl: 'https://api.moonshot.cn/anthropic',
      openaiBaseUrl: 'https://api.moonshot.cn/v1',
      openaiProtocol: 'chat_completions',
    },
  },
  {
    type: 'doubao',
    displayName: 'Doubao / Volcano Ark Coding Plan',
    requiredFields: ['connection.apiKey'],
    defaultModels: { primary: 'doubao-seed-2.0-code', light: 'doubao-seed-2.0-code' },
    availableModels: [
      { id: 'doubao-seed-2.0-code', name: 'Doubao Seed 2.0 Code', tier: 'primary' },
      { id: 'ark-code-latest', name: 'Ark Code Latest', tier: 'primary' },
    ],
    defaultConnection: {
      agentRuntime: 'claude-agent-sdk',
      claudeBaseUrl: 'https://ark.cn-beijing.volces.com/api/coding',
      openaiBaseUrl: 'https://ark.cn-beijing.volces.com/api/coding/v3',
      openaiProtocol: 'chat_completions',
    },
  },
  {
    type: 'minimax',
    displayName: 'MiniMax',
    requiredFields: ['connection.apiKey'],
    defaultModels: { primary: 'MiniMax-M2.7', light: 'MiniMax-M2.7' },
    availableModels: [
      { id: 'MiniMax-M2.7', name: 'MiniMax M2.7', tier: 'primary' },
      { id: 'MiniMax-M2.7-highspeed', name: 'MiniMax M2.7 Highspeed', tier: 'primary' },
    ],
    defaultConnection: {
      agentRuntime: 'claude-agent-sdk',
      claudeBaseUrl: 'https://api.minimaxi.com/anthropic',
      openaiBaseUrl: 'https://api.minimaxi.com/v1',
      openaiProtocol: 'chat_completions',
    },
  },
  {
    type: 'xiaomi',
    displayName: 'Xiaomi MiMo Token Plan',
    requiredFields: ['connection.apiKey'],
    defaultModels: { primary: 'mimo-v2.5-pro', light: 'mimo-v2.5-pro' },
    availableModels: [
      { id: 'mimo-v2.5-pro', name: 'MiMo v2.5 Pro', tier: 'primary' },
    ],
    defaultConnection: {
      agentRuntime: 'claude-agent-sdk',
      claudeBaseUrl: 'https://token-plan-sgp.xiaomimimo.com/anthropic',
      openaiBaseUrl: 'https://token-plan-sgp.xiaomimimo.com/v1',
      openaiProtocol: 'chat_completions',
    },
  },
  {
    type: 'tencent_token_plan',
    displayName: 'Tencent TokenHub Token Plan',
    requiredFields: ['connection.apiKey'],
    defaultModels: { primary: 'tc-code-latest', light: 'tc-code-latest' },
    availableModels: [
      { id: 'tc-code-latest', name: 'TC Code Latest', tier: 'primary' },
      { id: 'glm-5.1', name: 'GLM 5.1', tier: 'primary' },
      { id: 'kimi-k2.5', name: 'Kimi K2.5', tier: 'primary' },
    ],
    defaultConnection: {
      agentRuntime: 'claude-agent-sdk',
      claudeBaseUrl: 'https://api.lkeap.cloud.tencent.com/plan/anthropic',
      openaiBaseUrl: 'https://api.lkeap.cloud.tencent.com/plan/v3',
      openaiProtocol: 'chat_completions',
    },
  },
  {
    type: 'tencent_coding_plan',
    displayName: 'Tencent TokenHub Coding Plan',
    requiredFields: ['connection.apiKey'],
    defaultModels: { primary: 'tc-code-latest', light: 'tc-code-latest' },
    availableModels: [
      { id: 'tc-code-latest', name: 'TC Code Latest', tier: 'primary' },
      { id: 'hunyuan-2.0-thinking', name: 'Hunyuan 2.0 Think', tier: 'primary' },
    ],
    defaultConnection: {
      agentRuntime: 'claude-agent-sdk',
      claudeBaseUrl: 'https://api.lkeap.cloud.tencent.com/coding/anthropic',
      openaiBaseUrl: 'https://api.lkeap.cloud.tencent.com/coding/v3',
      openaiProtocol: 'chat_completions',
    },
  },
  {
    type: 'hunyuan',
    displayName: 'Tencent Hunyuan',
    requiredFields: ['connection.apiKey'],
    defaultModels: { primary: 'hunyuan-2.0-thinking-20251109', light: 'hunyuan-2.0-instruct-20251111' },
    availableModels: [
      { id: 'hunyuan-2.0-thinking-20251109', name: 'Hunyuan 2.0 Thinking', tier: 'primary' },
      { id: 'hunyuan-2.0-instruct-20251111', name: 'Hunyuan 2.0 Instruct', tier: 'light' },
    ],
    defaultConnection: {
      agentRuntime: 'claude-agent-sdk',
      claudeBaseUrl: 'https://api.hunyuan.cloud.tencent.com/anthropic',
      openaiBaseUrl: 'https://api.hunyuan.cloud.tencent.com/v1',
      openaiProtocol: 'chat_completions',
    },
  },
  {
    type: 'qianfan',
    displayName: 'Baidu Qianfan',
    requiredFields: ['connection.apiKey'],
    defaultModels: { primary: 'deepseek-v3.2', light: 'deepseek-v3.2' },
    availableModels: [
      { id: 'deepseek-v3.2', name: 'DeepSeek V3.2', tier: 'primary' },
      { id: 'qianfan-code-latest', name: 'Qianfan Code Latest', tier: 'primary' },
    ],
    defaultConnection: {
      agentRuntime: 'claude-agent-sdk',
      claudeBaseUrl: 'https://qianfan.baidubce.com/anthropic',
      openaiBaseUrl: 'https://qianfan.baidubce.com/v2',
      openaiProtocol: 'chat_completions',
    },
  },
  {
    type: 'stepfun',
    displayName: 'StepFun Step Plan',
    requiredFields: ['connection.apiKey'],
    defaultModels: { primary: 'step-3.5-flash-2603', light: 'step-3.5-flash' },
    availableModels: [
      { id: 'step-3.5-flash-2603', name: 'Step 3.5 Flash 2603', tier: 'primary' },
      { id: 'step-3.5-flash', name: 'Step 3.5 Flash', tier: 'light' },
    ],
    defaultConnection: {
      agentRuntime: 'claude-agent-sdk',
      claudeBaseUrl: 'https://api.stepfun.com/step_plan',
      openaiBaseUrl: 'https://api.stepfun.com/step_plan/v1',
      openaiProtocol: 'chat_completions',
    },
  },
  {
    type: 'siliconflow',
    displayName: 'SiliconFlow',
    requiredFields: ['connection.apiKey'],
    defaultModels: {
      primary: 'Qwen/Qwen3-235B-A22B-Thinking-2507',
      light: 'Qwen/Qwen3-30B-A3B-Instruct-2507',
    },
    availableModels: [
      { id: 'Qwen/Qwen3-235B-A22B-Thinking-2507', name: 'Qwen3 235B Thinking', tier: 'primary' },
      { id: 'Qwen/Qwen3-30B-A3B-Instruct-2507', name: 'Qwen3 30B Instruct', tier: 'light' },
    ],
    defaultConnection: {
      agentRuntime: 'claude-agent-sdk',
      claudeBaseUrl: 'https://api.siliconflow.com/',
      openaiBaseUrl: 'https://api.siliconflow.com/v1',
      openaiProtocol: 'chat_completions',
    },
  },
  {
    type: 'huawei',
    displayName: 'Huawei Cloud ModelArts MaaS',
    requiredFields: ['connection.apiKey'],
    defaultModels: { primary: 'deepseek-v3.2', light: 'qwen3-32b' },
    availableModels: [
      { id: 'deepseek-v3.2', name: 'DeepSeek V3.2', tier: 'primary' },
      { id: 'qwen3-32b', name: 'Qwen3 32B', tier: 'light' },
    ],
    defaultConnection: {
      agentRuntime: 'claude-agent-sdk',
      claudeBaseUrl: 'https://api.modelarts-maas.com/anthropic',
      openaiBaseUrl: 'https://api.modelarts-maas.com/v1',
      openaiProtocol: 'chat_completions',
    },
  },
  {
    type: 'openai',
    displayName: 'OpenAI',
    requiredFields: ['connection.openaiApiKey'],
    defaultModels: { primary: 'gpt-5.5', light: 'gpt-5.4-mini' },
    availableModels: [
      { id: 'gpt-5.5', name: 'GPT-5.5', tier: 'primary' },
      { id: 'gpt-5.4-mini', name: 'GPT-5.4 Mini', tier: 'light' },
    ],
    defaultConnection: {
      openaiBaseUrl: 'https://api.openai.com/v1',
      agentRuntime: 'openai-agents-sdk',
      openaiProtocol: 'responses',
    },
  },
  {
    type: 'ollama',
    displayName: 'Ollama (Local)',
    requiredFields: ['connection.openaiBaseUrl'],
    defaultModels: { primary: 'qwen3:30b', light: 'qwen3:30b' },
    availableModels: [],
    defaultConnection: {
      openaiBaseUrl: 'http://localhost:11434/v1',
      agentRuntime: 'openai-agents-sdk',
      openaiProtocol: 'chat_completions',
    },
  },
];
