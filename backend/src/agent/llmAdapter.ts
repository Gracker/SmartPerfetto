/**
 * LLM Client Adapter for Agent System
 *
 * Bridges the agent's LLMClient interface with existing AI services (DeepSeek, OpenAI, etc.)
 */

import OpenAI from 'openai';
import { LLMClient } from './agents/baseExpertAgent';
import { parseLlmJson } from '../utils/llmJson';

export interface LLMAdapterConfig {
  provider: 'deepseek' | 'openai';
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  temperature?: number;
  maxTokens?: number;
  timeoutMs?: number;
  maxRetries?: number;
  retryBaseDelayMs?: number;
  maxRetryDelayMs?: number;
}

interface RetryPolicy {
  timeoutMs: number;
  maxRetries: number;
  retryBaseDelayMs: number;
  maxRetryDelayMs: number;
}

const DEFAULT_TIMEOUT_MS = Number.parseInt(process.env.LLM_REQUEST_TIMEOUT_MS || '', 10) || 45000;
const DEFAULT_MAX_RETRIES = Number.parseInt(process.env.LLM_MAX_RETRIES || '', 10) || 2;
const DEFAULT_RETRY_BASE_DELAY_MS = Number.parseInt(process.env.LLM_RETRY_BASE_DELAY_MS || '', 10) || 600;
const DEFAULT_MAX_RETRY_DELAY_MS = Number.parseInt(process.env.LLM_MAX_RETRY_DELAY_MS || '', 10) || 5000;

/**
 * Error thrown when LLM API key is not configured
 */
export class LLMConfigurationError extends Error {
  constructor(provider: string) {
    super(
      `LLM API key not configured for provider '${provider}'. ` +
      `Please set the appropriate environment variable:\n` +
      `  - DeepSeek: DEEPSEEK_API_KEY\n` +
      `  - OpenAI: OPENAI_API_KEY\n` +
      `Or specify the API key in the configuration.`
    );
    this.name = 'LLMConfigurationError';
  }
}

function resolveRetryPolicy(config?: Partial<LLMAdapterConfig>): RetryPolicy {
  const timeoutMs = Number.isFinite(config?.timeoutMs)
    ? Math.max(1000, Math.floor(config!.timeoutMs!))
    : DEFAULT_TIMEOUT_MS;
  const maxRetries = Number.isFinite(config?.maxRetries)
    ? Math.max(0, Math.floor(config!.maxRetries!))
    : DEFAULT_MAX_RETRIES;
  const retryBaseDelayMs = Number.isFinite(config?.retryBaseDelayMs)
    ? Math.max(50, Math.floor(config!.retryBaseDelayMs!))
    : DEFAULT_RETRY_BASE_DELAY_MS;
  const maxRetryDelayMs = Number.isFinite(config?.maxRetryDelayMs)
    ? Math.max(retryBaseDelayMs, Math.floor(config!.maxRetryDelayMs!))
    : DEFAULT_MAX_RETRY_DELAY_MS;

  return {
    timeoutMs,
    maxRetries,
    retryBaseDelayMs,
    maxRetryDelayMs,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function getRetryDelayMs(attempt: number, policy: RetryPolicy): number {
  const exp = Math.max(0, attempt - 1);
  const delay = policy.retryBaseDelayMs * Math.pow(2, exp);
  return Math.min(policy.maxRetryDelayMs, delay);
}

function extractStatusCode(error: any): number | undefined {
  const status = error?.status ?? error?.response?.status;
  return Number.isFinite(status) ? Number(status) : undefined;
}

function isRetryableError(error: any): boolean {
  const status = extractStatusCode(error);
  if (status !== undefined && [408, 409, 429, 500, 502, 503, 504].includes(status)) {
    return true;
  }

  const code = String(error?.code || '');
  if (['ECONNRESET', 'ETIMEDOUT', 'ECONNABORTED', 'ENOTFOUND', 'EPIPE', 'ECONNREFUSED'].includes(code)) {
    return true;
  }

  const name = String(error?.name || '').toLowerCase();
  const message = String(error?.message || '').toLowerCase();
  if (name.includes('timeout') || message.includes('timeout') || message.includes('timed out')) {
    return true;
  }
  if (name.includes('connection') || message.includes('connection') || message.includes('network')) {
    return true;
  }

  return false;
}

function summarizeError(error: any): string {
  const status = extractStatusCode(error);
  const code = error?.code ? ` code=${String(error.code)}` : '';
  const message = error?.message ? String(error.message) : 'Unknown error';
  return `${status ? `status=${status} ` : ''}${message}${code}`.trim();
}

async function withRetries<T>(
  operationLabel: string,
  policy: RetryPolicy,
  operation: () => Promise<T>
): Promise<T> {
  const maxAttempts = policy.maxRetries + 1;
  let attempt = 0;

  while (attempt < maxAttempts) {
    attempt += 1;
    try {
      return await operation();
    } catch (error: any) {
      const retryable = isRetryableError(error);
      if (!retryable || attempt >= maxAttempts) {
        throw error;
      }

      const delayMs = getRetryDelayMs(attempt, policy);
      console.warn(
        `[LLMAdapter] ${operationLabel} failed on attempt ${attempt}/${maxAttempts}: ${summarizeError(error)}; retrying in ${delayMs}ms`
      );
      await sleep(delayMs);
    }
  }

  throw new Error(`[LLMAdapter] ${operationLabel} failed after retries`);
}

/**
 * Creates an LLMClient that uses the DeepSeek API
 */
export function createDeepSeekLLMClient(config?: Partial<LLMAdapterConfig>): LLMClient {
  const apiKey = config?.apiKey || process.env.DEEPSEEK_API_KEY;
  const baseUrl = config?.baseUrl || process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com';
  const model = config?.model || process.env.DEEPSEEK_MODEL || 'deepseek-chat';
  const temperature = config?.temperature ?? 0.3;
  const maxTokens = config?.maxTokens ?? 4000;
  const retryPolicy = resolveRetryPolicy(config);

  if (!apiKey) {
    throw new LLMConfigurationError('deepseek');
  }

  const client = new OpenAI({
    apiKey,
    baseURL: baseUrl,
    timeout: retryPolicy.timeoutMs,
    maxRetries: 0,
  });

  return {
    async complete(prompt: string): Promise<string> {
      try {
        const completion = await withRetries(
          'deepseek.complete',
          retryPolicy,
          async () => client.chat.completions.create({
            model,
            messages: [{ role: 'user', content: prompt }],
            temperature,
            max_tokens: maxTokens,
          })
        );
        return completion.choices[0]?.message?.content || '';
      } catch (error: any) {
        console.error('[LLMAdapter] DeepSeek API error:', summarizeError(error));
        throw new Error(`LLM completion failed: ${error.message}`);
      }
    },

    async completeJSON<T>(prompt: string): Promise<T> {
      const jsonPrompt = `${prompt}\n\nIMPORTANT: Respond ONLY with valid JSON. No markdown, no explanation, just the JSON object.`;

      try {
        const completion = await withRetries(
          'deepseek.completeJSON',
          retryPolicy,
          async () => client.chat.completions.create({
            model,
            messages: [{ role: 'user', content: jsonPrompt }],
            temperature: 0.1,
            max_tokens: maxTokens,
          })
        );

        const content = completion.choices[0]?.message?.content || '{}';
        return parseJSONResponse<T>(content);
      } catch (error: any) {
        console.error('[LLMAdapter] DeepSeek JSON completion error:', summarizeError(error));
        throw new Error(`LLM JSON completion failed: ${error.message}`);
      }
    },
  };
}

/**
 * Creates an LLMClient that uses the OpenAI API
 */
export function createOpenAILLMClient(config?: Partial<LLMAdapterConfig>): LLMClient {
  const apiKey = config?.apiKey || process.env.OPENAI_API_KEY;
  const model = config?.model || process.env.OPENAI_MODEL || 'gpt-4';
  const temperature = config?.temperature ?? 0.3;
  const maxTokens = config?.maxTokens ?? 4000;
  const retryPolicy = resolveRetryPolicy(config);

  if (!apiKey) {
    throw new LLMConfigurationError('openai');
  }

  const client = new OpenAI({
    apiKey,
    timeout: retryPolicy.timeoutMs,
    maxRetries: 0,
  });

  return {
    async complete(prompt: string): Promise<string> {
      try {
        const completion = await withRetries(
          'openai.complete',
          retryPolicy,
          async () => client.chat.completions.create({
            model,
            messages: [{ role: 'user', content: prompt }],
            temperature,
            max_tokens: maxTokens,
          })
        );
        return completion.choices[0]?.message?.content || '';
      } catch (error: any) {
        console.error('[LLMAdapter] OpenAI API error:', summarizeError(error));
        throw new Error(`LLM completion failed: ${error.message}`);
      }
    },

    async completeJSON<T>(prompt: string): Promise<T> {
      const jsonPrompt = `${prompt}\n\nIMPORTANT: Respond ONLY with valid JSON. No markdown, no explanation, just the JSON object.`;

      try {
        const completion = await withRetries(
          'openai.completeJSON',
          retryPolicy,
          async () => client.chat.completions.create({
            model,
            messages: [{ role: 'user', content: jsonPrompt }],
            temperature: 0.1,
            max_tokens: maxTokens,
            response_format: { type: 'json_object' },
          })
        );

        const content = completion.choices[0]?.message?.content || '{}';
        return JSON.parse(content) as T;
      } catch (error: any) {
        console.error('[LLMAdapter] OpenAI JSON completion error:', summarizeError(error));
        throw new Error(`LLM JSON completion failed: ${error.message}`);
      }
    },
  };
}

/**
 * Creates the appropriate LLMClient based on configuration or environment
 */
export function createLLMClient(config?: LLMAdapterConfig): LLMClient {
  const provider = config?.provider || (process.env.AI_SERVICE as LLMAdapterConfig['provider']) || 'deepseek';

  switch (provider) {
    case 'deepseek':
      return createDeepSeekLLMClient(config);
    case 'openai':
      return createOpenAILLMClient(config);
    default:
      throw new LLMConfigurationError(provider);
  }
}

function parseJSONResponse<T>(content: string): T {
  return parseLlmJson<T>(content);
}

export default createLLMClient;
