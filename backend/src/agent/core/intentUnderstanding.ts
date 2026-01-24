/**
 * Intent Understanding Module
 *
 * Parses user queries into structured Intent objects via LLM.
 * Falls back to a sensible default if LLM parsing fails.
 */

import { Intent } from '../types';
import { ModelRouter } from './modelRouter';
import { ProgressEmitter } from './orchestratorTypes';

/**
 * Understand user intent from a natural language query.
 * Uses LLM to extract primaryGoal, aspects, output type, and complexity.
 */
export async function understandIntent(
  query: string,
  modelRouter: ModelRouter,
  emitter: ProgressEmitter
): Promise<Intent> {
  const prompt = `分析以下用户查询，提取分析意图：

用户查询: "${query}"

请以 JSON 格式返回：
{
  "primaryGoal": "用户的主要目标",
  "aspects": ["需要分析的方面"],
  "expectedOutputType": "diagnosis | comparison | timeline | summary",
  "complexity": "simple | moderate | complex"
}`;

  try {
    const response = await modelRouter.callWithFallback(prompt, 'intent_understanding');
    const jsonMatch = response.response.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      return JSON.parse(jsonMatch[0]) as Intent;
    }
  } catch (error) {
    emitter.log(`Failed to parse intent: ${error}`);
    emitter.emitUpdate('degraded', { module: 'intentUnderstanding', fallback: 'rule-based default' });
  }

  return {
    primaryGoal: query,
    aspects: ['general'],
    expectedOutputType: 'diagnosis',
    complexity: 'moderate',
  };
}
