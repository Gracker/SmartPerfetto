module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/src', '<rootDir>/tests'],
  testMatch: [
    '**/__tests__/**/*.ts',
    '**/?(*.)+(spec|test|eval).ts'
  ],
  // Exclude CLI command files that happen to contain "test" in their name
  testPathIgnorePatterns: [
    '/node_modules/',
    '/src/cli/commands/',
  ],
  transform: {
    '^.+\.ts$': 'ts-jest',
  },
  moduleNameMapper: {
    '^@anthropic-ai/claude-agent-sdk$': '<rootDir>/src/agentv3/__mocks__/claude-agent-sdk.ts',
  },
  collectCoverageFrom: [
    'src/**/*.ts',
    '!src/**/*.d.ts',
    '!src/index.ts',
  ],
  coverageDirectory: 'coverage',
  verbose: true,
  // Skill eval tests need longer timeout due to trace loading
  testTimeout: 60000,
  // Run skill-eval tests in band to avoid port conflicts
  maxWorkers: 1,
};
