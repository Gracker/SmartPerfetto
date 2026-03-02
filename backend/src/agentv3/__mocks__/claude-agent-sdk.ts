/**
 * Mock for @anthropic-ai/claude-agent-sdk
 *
 * The real SDK is ESM-only (.mjs) and cannot be imported in Jest's CommonJS context.
 * This mock provides the minimum surface needed for compilation and testing.
 */

/** Mock query function — returns an empty async generator. */
export async function* query(_options: any): AsyncGenerator<any, void> {
  // No-op in tests
}

/** Mock tool() builder — returns the tool definition as-is. */
export function tool(
  name: string,
  description: string,
  schema: Record<string, any>,
  handler: (...args: any[]) => any,
): any {
  return { name, description, schema, handler };
}

/** Mock createSdkMcpServer — returns a config object. */
export function createSdkMcpServer(config: {
  name: string;
  version: string;
  tools: any[];
}): any {
  return {
    type: 'sdk' as const,
    name: config.name,
    instance: { name: config.name, version: config.version, tools: config.tools },
  };
}
