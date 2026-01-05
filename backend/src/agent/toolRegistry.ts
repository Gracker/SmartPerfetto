import { Tool, ToolDefinition, ToolRegistry } from './types';

class ToolRegistryImpl implements ToolRegistry {
  private tools: Map<string, Tool> = new Map();

  register(tool: Tool): void {
    if (this.tools.has(tool.definition.name)) {
      console.warn(`[ToolRegistry] Overwriting existing tool: ${tool.definition.name}`);
    }
    this.tools.set(tool.definition.name, tool);
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  list(): ToolDefinition[] {
    return Array.from(this.tools.values()).map(t => t.definition);
  }

  listByCategory(category: string): ToolDefinition[] {
    return this.list().filter(t => t.category === category);
  }

  getToolDescriptionsForLLM(): string {
    const tools = this.list();
    return tools.map(t => {
      const params = t.parameters.map(p => 
        `  - ${p.name} (${p.type}${p.required ? ', required' : ''}): ${p.description}`
      ).join('\n');
      return `## ${t.name}\n${t.description}\n\nCategory: ${t.category}\n\nParameters:\n${params}\n\nReturns: ${t.returns.description}`;
    }).join('\n\n---\n\n');
  }
}

let instance: ToolRegistry | null = null;

export function getToolRegistry(): ToolRegistry {
  if (!instance) {
    instance = new ToolRegistryImpl();
  }
  return instance;
}

export function resetToolRegistry(): void {
  instance = null;
}
