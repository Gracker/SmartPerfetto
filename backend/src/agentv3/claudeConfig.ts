export interface ClaudeAgentConfig {
  model: string;
  maxTurns: number;
  maxBudgetUsd?: number;
  cwd: string;
  effort: 'low' | 'medium' | 'high' | 'max';
}

const DEFAULT_MODEL = 'claude-sonnet-4-6';
const DEFAULT_MAX_TURNS = 15;
const DEFAULT_EFFORT = 'high';

export function loadClaudeConfig(overrides?: Partial<ClaudeAgentConfig>): ClaudeAgentConfig {
  return {
    model: overrides?.model ?? process.env.CLAUDE_MODEL ?? DEFAULT_MODEL,
    maxTurns: overrides?.maxTurns
      ?? (process.env.CLAUDE_MAX_TURNS ? parseInt(process.env.CLAUDE_MAX_TURNS, 10) : DEFAULT_MAX_TURNS),
    maxBudgetUsd: overrides?.maxBudgetUsd
      ?? (process.env.CLAUDE_MAX_BUDGET_USD ? parseFloat(process.env.CLAUDE_MAX_BUDGET_USD) : undefined),
    cwd: overrides?.cwd ?? process.env.CLAUDE_CWD ?? process.cwd(),
    effort: (overrides?.effort ?? process.env.CLAUDE_EFFORT ?? DEFAULT_EFFORT) as ClaudeAgentConfig['effort'],
  };
}

export function isClaudeCodeEnabled(): boolean {
  return process.env.AI_SERVICE === 'claude-code';
}
