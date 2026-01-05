import { getToolRegistry } from '../toolRegistry';
import { sqlExecutorTool } from './sqlExecutor';
import { frameAnalyzerTool } from './frameAnalyzer';
import { dataStatsTool } from './dataStats';

export function registerCoreTools(): void {
  const registry = getToolRegistry();
  
  registry.register(sqlExecutorTool);
  registry.register(frameAnalyzerTool);
  registry.register(dataStatsTool);
  
  console.log(`[Agent] Registered ${registry.list().length} core tools`);
}

export { sqlExecutorTool } from './sqlExecutor';
export { frameAnalyzerTool } from './frameAnalyzer';
export { dataStatsTool } from './dataStats';
