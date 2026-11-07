// backend/src/services/providerManager/templates.ts
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { ProviderTemplate } from './types';

// Curated text/tool-calling options, scoped to each template's endpoint and plan.
// Refresh from the provider's own catalog; never infer gateway IDs from a direct API.
// Defaults and saved profiles are independent of this list. Source references live
// beside each provider's additions and in docs/getting-started/configuration*.md.
export const officialTemplates: ProviderTemplate[] = [
  {
    type: 'anthropic',
    displayName: 'Anthropic',
    requiredFields: ['connection.claudeApiKey'],
    defaultModels: { primary: 'claude-sonnet-5', light: 'claude-haiku-4-5' },
    availableModels: [
      // https://platform.claude.com/docs/en/models/fable-5-1/overview
      // https://platform.claude.com/docs/en/models/opus-5/overview
      { id: 'claude-fable-5-1', name: 'Claude Fable 5.1', tier: 'primary' },
      { id: 'claude-opus-5', name: 'Claude Opus 5', tier: 'primary' },
      { id: 'claude-fable-5', name: 'Claude Fable 5', tier: 'primary' },
      { id: 'claude-opus-4-8', name: 'Claude Opus 4.8', tier: 'primary' },
      { id: 'claude-sonnet-5', name: 'Claude Sonnet 5', tier: 'primary' },
      { id: 'claude-haiku-4-5', name: 'Claude Haiku 4.5', tier: 'light' },
    ],
  },
  {
    type: 'bedrock',
    displayName: 'AWS Bedrock',
    requiredFields: [],
    // Bedrock requires Bedrock-native inference IDs. Anthropic-style short IDs
    // like 'claude-sonnet-5' are rejected with 400 invalid model identifier.
    defaultModels: {
      primary: 'us.anthropic.claude-sonnet-5',
      light: 'us.anthropic.claude-haiku-4-5-20251001-v1:0',
    },
    availableModels: [
      // https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-anthropic-claude-fable-5-1.html
      // https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-anthropic-claude-opus-5.html
      { id: 'us.anthropic.claude-fable-5-1', name: 'Claude Fable 5.1 (US geo)', tier: 'primary' },
      { id: 'global.anthropic.claude-fable-5-1', name: 'Claude Fable 5.1 (global)', tier: 'primary' },
      { id: 'us.anthropic.claude-opus-5', name: 'Claude Opus 5 (US geo)', tier: 'primary' },
      { id: 'global.anthropic.claude-opus-5', name: 'Claude Opus 5 (global)', tier: 'primary' },
      { id: 'us.anthropic.claude-sonnet-5', name: 'Claude Sonnet 5 (US geo)', tier: 'primary' },
      { id: 'global.anthropic.claude-sonnet-5', name: 'Claude Sonnet 5 (global)', tier: 'primary' },
      { id: 'us.anthropic.claude-opus-4-5-20251101-v1:0', name: 'Claude Opus 4.5 (cross-region)', tier: 'primary' },
      { id: 'us.anthropic.claude-sonnet-4-5-20250929-v1:0', name: 'Claude Sonnet 4.5 (cross-region)', tier: 'primary' },
      { id: 'us.anthropic.claude-haiku-4-5-20251001-v1:0', name: 'Claude Haiku 4.5 (cross-region)', tier: 'light' },
    ],
    defaultConnection: { awsRegion: 'us-east-1' },
  },
  {
    type: 'vertex',
    displayName: 'Google Vertex AI',
    requiredFields: ['connection.gcpProjectId', 'connection.gcpRegion'],
    defaultModels: { primary: 'claude-sonnet-5', light: 'claude-haiku-4-5' },
    availableModels: [
      // https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/partner-models/claude/fable-5-1
      // https://platform.claude.com/docs/en/models/opus-5/overview
      { id: 'claude-fable-5-1', name: 'Claude Fable 5.1', tier: 'primary' },
      { id: 'claude-opus-5', name: 'Claude Opus 5', tier: 'primary' },
      { id: 'claude-fable-5', name: 'Claude Fable 5', tier: 'primary' },
      { id: 'claude-opus-4-8', name: 'Claude Opus 4.8', tier: 'primary' },
      { id: 'claude-sonnet-5', name: 'Claude Sonnet 5', tier: 'primary' },
      { id: 'claude-haiku-4-5', name: 'Claude Haiku 4.5', tier: 'light' },
    ],
    defaultConnection: { gcpRegion: 'us-central1' },
  },
  {
    type: 'deepseek',
    displayName: 'DeepSeek',
    requiredFields: ['connection.apiKey'],
    defaultModels: { primary: 'deepseek-v4-pro', light: 'deepseek-flash' },
    availableModels: [
      // https://api-docs.deepseek.com/api/list-models/
      // https://api-docs.deepseek.com/updates/#date-2026-09-10
      { id: 'deepseek-flash', name: 'DeepSeek V4.1 Flash', tier: 'light' },
      { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro', tier: 'primary' },
    ],
    defaultConnection: {
      // Pi resolves this model from its builtin catalog on the OpenAI-compatible endpoint.
      agentRuntime: 'pi-agent-core',
      claudeBaseUrl: 'https://api.deepseek.com/anthropic',
      openaiBaseUrl: 'https://api.deepseek.com/v1',
      openaiProtocol: 'chat_completions',
    },
  },
  {
    type: 'glm',
    displayName: 'GLM / Z.ai',
    requiredFields: ['connection.apiKey'],
    defaultModels: { primary: 'glm-5.3-flash', light: 'glm-5.3-flash' },
    availableModels: [
      // https://docs.z.ai/guides/llm/glm-5.3
      // https://docs.z.ai/guides/vlm/glm-5.3-flash
      { id: 'glm-5.3', name: 'GLM 5.3', tier: 'primary' },
      { id: 'glm-5.3-flash', name: 'GLM 5.3 Flash', tier: 'light' },
      { id: 'glm-5.2', name: 'GLM 5.2', tier: 'primary' },
      { id: 'glm-5-turbo', name: 'GLM 5 Turbo', tier: 'primary' },
      { id: 'glm-4.7', name: 'GLM 4.7', tier: 'primary' },
      { id: 'glm-4.7-flashx', name: 'GLM 4.7 FlashX', tier: 'light' },
      { id: 'glm-4.7-flash', name: 'GLM 4.7 Flash', tier: 'light' },
    ],
    defaultConnection: {
      // Pi resolves this model from its builtin catalog on the OpenAI-compatible endpoint.
      agentRuntime: 'pi-agent-core',
      claudeBaseUrl: 'https://open.bigmodel.cn/api/anthropic',
      openaiBaseUrl: 'https://open.bigmodel.cn/api/paas/v4',
      openaiProtocol: 'chat_completions',
    },
  },
  {
    type: 'qwen',
    displayName: 'Qwen / Alibaba Cloud Model Studio',
    requiredFields: ['connection.apiKey'],
    defaultModels: { primary: 'qwen3.8-flash', light: 'qwen3.8-flash' },
    availableModels: [
      // https://www.alibabacloud.com/help/en/model-studio/qwen3-8-max
      // https://www.alibabacloud.com/help/en/model-studio/qwen3-8-flash
      // https://help.aliyun.com/en/model-studio/qwen3-8-27b
      // https://help.aliyun.com/en/model-studio/qwen3-8-2-4t-a95b
      { id: 'qwen3.8-max', name: 'Qwen 3.8 Max', tier: 'primary' },
      { id: 'qwen3.8-max-0902', name: 'Qwen 3.8 Max 0902', tier: 'primary' },
      { id: 'qwen3.8-max-2026-09-02', name: 'Qwen 3.8 Max 2026-09-02 (0902 alias)', tier: 'primary' },
      { id: 'qwen3.8-flash', name: 'Qwen 3.8 Flash', tier: 'light' },
      { id: 'qwen3.8-27b', name: 'Qwen 3.8 27B', tier: 'light' },
      { id: 'qwen3.8-2.4t-a95b', name: 'Qwen 3.8 2.4T A95B', tier: 'primary' },
      { id: 'qwen3.7-max', name: 'Qwen 3.7 Max', tier: 'primary' },
      { id: 'qwen3.7-plus', name: 'Qwen 3.7 Plus', tier: 'primary' },
      { id: 'qwen3.7', name: 'Qwen 3.7', tier: 'primary' },
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
      // International Coding Plan has its own allowlist, not the general Qwen catalog.
      // https://www.alibabacloud.com/help/en/model-studio/coding-plan
      { id: 'qwen3-coder-next', name: 'Qwen 3 Coder Next', tier: 'primary' },
      { id: 'qwen3.6-plus', name: 'Qwen 3.6 Plus', tier: 'primary' },
      { id: 'qwen3.5-plus', name: 'Qwen 3.5 Plus', tier: 'primary' },
      { id: 'qwen3-max-2026-01-23', name: 'Qwen 3 Max 2026-01-23', tier: 'primary' },
      { id: 'kimi-k2.5', name: 'Kimi K2.5 (Coding Plan)', tier: 'primary' },
      { id: 'glm-5', name: 'GLM 5 (Coding Plan)', tier: 'primary' },
      { id: 'glm-4.7', name: 'GLM 4.7 (Coding Plan)', tier: 'primary' },
      { id: 'MiniMax-M2.5', name: 'MiniMax M2.5 (Coding Plan)', tier: 'primary' },
      { id: 'qwen3-coder-plus', name: 'Qwen 3 Coder Plus', tier: 'primary' },
      { id: 'qwen3.7-max', name: 'Qwen 3.7 Max', tier: 'primary' },
      { id: 'qwen3.7-plus', name: 'Qwen 3.7 Plus', tier: 'primary' },
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
      // https://www.kimi.com/code/docs/en/kimi-code/models.html
      { id: 'k3', name: 'Kimi K3 (Moderato+)', tier: 'primary' },
      { id: 'k3-256k', name: 'Kimi K3 256K (Moderato+)', tier: 'primary' },
      { id: 'kimi-for-coding-highspeed', name: 'Kimi for Coding HighSpeed (Allegretto+)', tier: 'light' },
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
    defaultModels: { primary: 'kimi-k2.7-code-highspeed', light: 'kimi-k2.7-code-highspeed' },
    availableModels: [
      // https://platform.kimi.ai/docs/models
      { id: 'kimi-k3', name: 'Kimi K3', tier: 'primary' },
      { id: 'kimi-k2.7-code', name: 'Kimi K2.7 Code', tier: 'primary' },
      { id: 'kimi-k2.7-code-highspeed', name: 'Kimi K2.7 Code HighSpeed', tier: 'light' },
      { id: 'kimi-k2.6', name: 'Kimi K2.6', tier: 'primary' },
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
    defaultModels: { primary: 'ark-code-latest', light: 'ark-code-latest' },
    availableModels: [
      // https://www.volcengine.com/docs/82379/1928261 (Coding Plan model names)
      { id: 'doubao-seed-evolving', name: 'Doubao Seed Evolving', tier: 'primary' },
      { id: 'doubao-seed-2.1-turbo', name: 'Doubao Seed 2.1 Turbo', tier: 'primary' },
      { id: 'doubao-seed-2.0-lite', name: 'Doubao Seed 2.0 Lite', tier: 'light' },
      { id: 'minimax-m3', name: 'MiniMax M3 (Ark)', tier: 'primary' },
      { id: 'glm-5.3', name: 'GLM 5.3 (Ark)', tier: 'primary' },
      { id: 'glm-latest', name: 'GLM Latest (Ark)', tier: 'primary' },
      { id: 'glm-5.3-flash', name: 'GLM 5.3 Flash (Ark)', tier: 'light' },
      { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro (Ark)', tier: 'primary' },
      { id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash (Ark)', tier: 'light' },
      { id: 'kimi-k2.7-code', name: 'Kimi K2.7 Code (Ark)', tier: 'primary' },
      { id: 'kimi-k3', name: 'Kimi K3 (Ark)', tier: 'primary' },
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
    defaultModels: { primary: 'MiniMax-M3', light: 'MiniMax-M3' },
    availableModels: [
      { id: 'MiniMax-M3', name: 'MiniMax M3', tier: 'primary' },
      { id: 'MiniMax-M2.7', name: 'MiniMax M2.7', tier: 'primary' },
      { id: 'MiniMax-M2.7-highspeed', name: 'MiniMax M2.7 Highspeed', tier: 'light' },
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
    defaultModels: { primary: 'mimo-v2.5-pro', light: 'mimo-v2.5' },
    availableModels: [
      { id: 'mimo-v2.5-pro-ultraspeed', name: 'MiMo v2.5 Pro UltraSpeed', tier: 'primary' },
      { id: 'mimo-v2.5-pro', name: 'MiMo v2.5 Pro', tier: 'primary' },
      { id: 'mimo-v2.5', name: 'MiMo v2.5', tier: 'light' },
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
      // https://cloud.tencent.cn/document/product/1823/133811
      { id: 'glm-5.3', name: 'GLM 5.3', tier: 'primary' },
      { id: 'glm-5.3-flash', name: 'GLM 5.3 Flash', tier: 'light' },
      { id: 'kimi-k3', name: 'Kimi K3', tier: 'primary' },
      { id: 'minimax-m3', name: 'MiniMax M3', tier: 'primary' },
      { id: 'hy4-preview', name: 'Hunyuan Hy4 Preview', tier: 'primary' },
      { id: 'glm-5.2', name: 'GLM 5.2', tier: 'primary' },
      { id: 'glm-5.1', name: 'GLM 5.1', tier: 'primary' },
      { id: 'glm-5', name: 'GLM 5', tier: 'primary' },
      { id: 'kimi-k2.7-code', name: 'Kimi K2.7 Code', tier: 'primary' },
      { id: 'minimax-m2.7', name: 'MiniMax M2.7', tier: 'primary' },
      { id: 'deepseek/deepseek-v4-pro', name: 'DeepSeek V4 Pro (TokenHub)', tier: 'primary' },
      { id: 'deepseek/deepseek-v4-flash', name: 'DeepSeek V4 Flash (TokenHub)', tier: 'light' },
      { id: 'deepseek/deepseek-v4-pro-0813', name: 'DeepSeek V4 Pro 0813 (TokenHub)', tier: 'primary' },
      { id: 'deepseek/deepseek-v4-flash-0731', name: 'DeepSeek V4 Flash 0731 (TokenHub)', tier: 'light' },
      { id: 'tc-code-latest', name: 'TC Code Latest', tier: 'primary' },
      { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro', tier: 'primary' },
      { id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash', tier: 'light' },
      { id: 'glm-5-turbo', name: 'GLM 5 Turbo', tier: 'primary' },
      { id: 'kimi-k2.7-code-highspeed', name: 'Kimi K2.7 Code HighSpeed', tier: 'light' },
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
      // https://cloud.tencent.com/document/product/1823/130092
      { id: 'glm-5', name: 'GLM 5 (Coding Plan)', tier: 'primary' },
      { id: 'tc-code-latest', name: 'TC Code Latest', tier: 'primary' },
      { id: 'hy3-preview', name: 'Hunyuan Hy3 Preview', tier: 'primary' },
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
    defaultModels: { primary: 'deepseek-v4-flash', light: 'deepseek-v4-flash' },
    availableModels: [
      // https://cloud.baidu.com/doc/qianfan/s/rmh4stp0j
      { id: 'ernie-5.1', name: 'ERNIE 5.1', tier: 'primary' },
      { id: 'ernie-5.0', name: 'ERNIE 5.0', tier: 'primary' },
      { id: 'glm-5.3', name: 'GLM 5.3', tier: 'primary' },
      { id: 'glm-5.3-flash', name: 'GLM 5.3 Flash', tier: 'light' },
      { id: 'glm-5.2', name: 'GLM 5.2', tier: 'primary' },
      { id: 'glm-5.1', name: 'GLM 5.1', tier: 'primary' },
      { id: 'glm-5', name: 'GLM 5', tier: 'primary' },
      { id: 'kimi-k2.6', name: 'Kimi K2.6', tier: 'primary' },
      { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro', tier: 'primary' },
      { id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash', tier: 'light' },
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
    defaultModels: { primary: 'step-3.7-flash', light: 'step-3.5-flash' },
    availableModels: [
      { id: 'step-3.7-flash', name: 'Step 3.7 Flash', tier: 'primary' },
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
      primary: 'Qwen/Qwen3-235B-A22B-Instruct-2507',
      light: 'Qwen/Qwen3-30B-A3B-Instruct-2507',
    },
    availableModels: [
      // Exact serving IDs from https://www.siliconflow.com/models (individual model cards).
      { id: 'zai-org/GLM-5.3', name: 'GLM 5.3', tier: 'primary' },
      { id: 'zai-org/GLM-5.3-Flash', name: 'GLM 5.3 Flash', tier: 'light' },
      { id: 'Qwen/Qwen3.8-2.4T-A95B', name: 'Qwen 3.8 2.4T A95B', tier: 'primary' },
      { id: 'moonshotai/Kimi-K3', name: 'Kimi K3', tier: 'primary' },
      { id: 'tencent/Hy3', name: 'Hunyuan Hy3', tier: 'primary' },
      { id: 'deepseek-ai/DeepSeek-V4-Pro-0813', name: 'DeepSeek V4 Pro 0813', tier: 'primary' },
      { id: 'deepseek-ai/DeepSeek-V4-Flash-0731', name: 'DeepSeek V4 Flash 0731', tier: 'light' },
      { id: 'deepseek-ai/DeepSeek-V4-Flash-Vision-Exp', name: 'DeepSeek V4 Flash Vision (Experimental)', tier: 'light' },
      // https://docs.siliconflow.com/en/api-reference/chat-completions/chat-completions
      { id: 'deepseek-ai/DeepSeek-V4-Pro', name: 'DeepSeek V4 Pro', tier: 'primary' },
      { id: 'deepseek-ai/DeepSeek-V4-Flash', name: 'DeepSeek V4 Flash', tier: 'light' },
      { id: 'zai-org/GLM-5.1', name: 'GLM 5.1', tier: 'primary' },
      { id: 'moonshotai/Kimi-K2.6', name: 'Kimi K2.6', tier: 'primary' },
      { id: 'Qwen/Qwen3.6-27B', name: 'Qwen 3.6 27B', tier: 'light' },
      { id: 'Qwen/Qwen3.6-35B-A3B', name: 'Qwen 3.6 35B A3B', tier: 'light' },
      { id: 'MiniMaxAI/MiniMax-M2.5', name: 'MiniMax M2.5', tier: 'primary' },
      { id: 'Qwen/Qwen3-235B-A22B-Instruct-2507', name: 'Qwen3 235B Instruct', tier: 'primary' },
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
    defaultModels: { primary: 'deepseek-v4-pro', light: 'deepseek-v4-flash' },
    availableModels: [
      // https://support.huaweicloud.com/model-call-maas/model-call-022.html
      { id: 'openpangu-2.0-pro', name: 'OpenPangu 2.0 Pro', tier: 'primary' },
      { id: 'openpangu-2.0-flash', name: 'OpenPangu 2.0 Flash', tier: 'light' },
      { id: 'glm-5.1', name: 'GLM 5.1', tier: 'primary' },
      { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro', tier: 'primary' },
      { id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash', tier: 'light' },
      { id: 'deepseek-v3.2', name: 'DeepSeek V3.2', tier: 'primary' },
      { id: 'glm-5.2', name: 'GLM 5.2', tier: 'primary' },
      { id: 'kimi-k2.6', name: 'Kimi K2.6', tier: 'primary' },
      { id: 'qwen3-32b', name: 'Qwen3 32B', tier: 'light' },
    ],
    defaultConnection: {
      agentRuntime: 'claude-agent-sdk',
      claudeBaseUrl: 'https://api.modelarts-maas.com/anthropic',
      // https://support.huaweicloud.com/model-call-maas/model-call-021.html
      openaiBaseUrl: 'https://api.modelarts-maas.com/openai/v1',
      openaiProtocol: 'chat_completions',
    },
  },
  {
    type: 'openai',
    displayName: 'OpenAI',
    requiredFields: ['connection.openaiApiKey'],
    defaultModels: { primary: 'gpt-5.6-terra', light: 'gpt-5.6-luna' },
    availableModels: [
      // https://developers.openai.com/api/docs/models
      { id: 'gpt-6-astra', name: 'GPT-6 Astra', tier: 'primary' },
      { id: 'gpt-5.6-sol', name: 'GPT-5.6 Sol', tier: 'primary' },
      { id: 'gpt-5.6-terra', name: 'GPT-5.6 Terra', tier: 'primary' },
      { id: 'gpt-5.6-luna', name: 'GPT-5.6 Luna', tier: 'light' },
      { id: 'gpt-5.5', name: 'GPT-5.5', tier: 'primary' },
      { id: 'gpt-5.4', name: 'GPT-5.4', tier: 'primary' },
      { id: 'gpt-5.4-mini', name: 'GPT-5.4 Mini', tier: 'light' },
      { id: 'gpt-5.4-nano', name: 'GPT-5.4 Nano', tier: 'light' },
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
  {
    type: 'custom',
    displayName: 'Custom Provider',
    requiredFields: [],
    defaultModels: { primary: '', light: '' },
    availableModels: [],
    defaultConnection: {
      agentRuntime: 'claude-agent-sdk',
    },
  },
];
