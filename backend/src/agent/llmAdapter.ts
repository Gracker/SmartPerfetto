/**
 * LLM Client Adapter for Agent System
 *
 * Bridges the agent's LLMClient interface with existing AI services (DeepSeek, OpenAI, etc.)
 */

import OpenAI from 'openai';
import { LLMClient } from './agents/baseExpertAgent';

export interface LLMAdapterConfig {
  provider: 'deepseek' | 'openai';
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  temperature?: number;
  maxTokens?: number;
}

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

/**
 * Creates an LLMClient that uses the DeepSeek API
 */
export function createDeepSeekLLMClient(config?: Partial<LLMAdapterConfig>): LLMClient {
  const apiKey = config?.apiKey || process.env.DEEPSEEK_API_KEY;
  const baseUrl = config?.baseUrl || process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com';
  const model = config?.model || process.env.DEEPSEEK_MODEL || 'deepseek-chat';
  const temperature = config?.temperature ?? 0.3;
  const maxTokens = config?.maxTokens ?? 4000;

  if (!apiKey) {
    throw new LLMConfigurationError('deepseek');
  }

  const client = new OpenAI({
    apiKey,
    baseURL: baseUrl,
  });

  return {
    async complete(prompt: string): Promise<string> {
      try {
        const completion = await client.chat.completions.create({
          model,
          messages: [{ role: 'user', content: prompt }],
          temperature,
          max_tokens: maxTokens,
        });
        return completion.choices[0]?.message?.content || '';
      } catch (error: any) {
        console.error('[LLMAdapter] DeepSeek API error:', error.message);
        throw new Error(`LLM completion failed: ${error.message}`);
      }
    },

    async completeJSON<T>(prompt: string): Promise<T> {
      const jsonPrompt = `${prompt}\n\nIMPORTANT: Respond ONLY with valid JSON. No markdown, no explanation, just the JSON object.`;
      
      try {
        const completion = await client.chat.completions.create({
          model,
          messages: [{ role: 'user', content: jsonPrompt }],
          temperature: 0.1,
          max_tokens: maxTokens,
        });

        const content = completion.choices[0]?.message?.content || '{}';
        return parseJSONResponse<T>(content);
      } catch (error: any) {
        console.error('[LLMAdapter] DeepSeek JSON completion error:', error.message);
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

  if (!apiKey) {
    throw new LLMConfigurationError('openai');
  }

  const client = new OpenAI({ apiKey });

  return {
    async complete(prompt: string): Promise<string> {
      try {
        const completion = await client.chat.completions.create({
          model,
          messages: [{ role: 'user', content: prompt }],
          temperature,
          max_tokens: maxTokens,
        });
        return completion.choices[0]?.message?.content || '';
      } catch (error: any) {
        console.error('[LLMAdapter] OpenAI API error:', error.message);
        throw new Error(`LLM completion failed: ${error.message}`);
      }
    },

    async completeJSON<T>(prompt: string): Promise<T> {
      const jsonPrompt = `${prompt}\n\nIMPORTANT: Respond ONLY with valid JSON. No markdown, no explanation, just the JSON object.`;
      
      try {
        const completion = await client.chat.completions.create({
          model,
          messages: [{ role: 'user', content: jsonPrompt }],
          temperature: 0.1,
          max_tokens: maxTokens,
          response_format: { type: 'json_object' },
        });

        const content = completion.choices[0]?.message?.content || '{}';
        return JSON.parse(content) as T;
      } catch (error: any) {
        console.error('[LLMAdapter] OpenAI JSON completion error:', error.message);
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

function stripMarkdownCodeBlock(content: string): string {
  if (!content.startsWith('```')) return content;
  const match = content.match(/```(?:json)?\s*([\s\S]*?)```/);
  return match ? match[1].trim() : content;
}

function extractJSONFromText(content: string): string {
  if (content.startsWith('{') || content.startsWith('[')) return content;
  const match = content.match(/(\{[\s\S]*\}|\[[\s\S]*\])/);
  return match ? match[1] : content;
}

function parseJSONResponse<T>(content: string): T {
  let cleanContent = content.trim();
  cleanContent = stripMarkdownCodeBlock(cleanContent);
  cleanContent = extractJSONFromText(cleanContent);

  try {
    return JSON.parse(cleanContent) as T;
  } catch (error) {
    console.error('[LLMAdapter] Failed to parse JSON:', cleanContent.substring(0, 200));
    throw new Error(`Invalid JSON response: ${(error as Error).message}`);
  }
}

export default createLLMClient;
