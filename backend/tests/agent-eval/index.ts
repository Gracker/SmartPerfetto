/**
 * Agent Evaluation Framework
 *
 * A comprehensive framework for evaluating AI agent responses:
 * - Code-based grading: Deterministic checks on structure, timing, confidence
 * - Model-based grading: LLM-powered evaluation of answer quality
 * - Scenario-based testing: YAML-defined test cases with expectations
 *
 * Usage:
 * ```typescript
 * import { EvaluationRunner, loadAllScenarios } from './agent-eval';
 *
 * const runner = new EvaluationRunner({
 *   backendUrl: 'http://localhost:3000',
 *   verbose: true,
 *   useModelGrader: true,
 * });
 *
 * const summary = await runner.runAll({ categories: ['scrolling'] });
 * console.log(`Passed: ${summary.passedScenarios}/${summary.totalScenarios}`);
 * ```
 */

// Types
export * from './types';

// Graders
export { CodeGrader, createCodeGrader } from './codeGrader';
export { ModelGrader, createModelGrader, ModelGraderOptions } from './modelGrader';
export { ProcessGrader, createProcessGrader } from './processGrader';

// Scenario Loading
export {
  loadScenarios,
  loadAllScenarios,
  loadScenarioFile,
  getDefaultScenariosDir,
  LoadOptions,
} from './scenarioLoader';

// Runner
export {
  EvaluationRunner,
  createEvaluationRunner,
  runEvaluation,
  RunnerOptions,
} from './evaluationRunner';
