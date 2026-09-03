// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

/**
 * Test Command
 *
 * Tests skill execution against a trace file.
 */

import { Command } from 'commander';
import path from 'path';

// ANSI color codes
const colors = {
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  blue: (s: string) => `\x1b[34m${s}\x1b[0m`,
  gray: (s: string) => `\x1b[90m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
  cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
};

/**
 * Test command
 */
export const testCommand = new Command('test')
  .description('Test skill execution against a trace file')
  .argument('<skillId>', 'Skill ID to test')
  .requiredOption('-t, --trace <path>', 'Path to trace file (.perfetto-trace)')
  .option('-p, --package <name>', 'Package name filter')
  .option('-v, --verbose', 'Show detailed output')
  .action(async (skillId: string, options: { trace: string; package?: string; verbose?: boolean }) => {
    console.log(colors.bold('\nSmartPerfetto Skill Tester\n'));

    const tracePath = path.resolve(options.trace);

    console.log(`Skill:   ${colors.cyan(skillId)}`);
    console.log(`Trace:   ${colors.gray(tracePath)}`);
    if (options.package) {
      console.log(`Package: ${colors.gray(options.package)}`);
    }
    console.log('');

    try {
      // Dynamic imports to avoid loading heavy dependencies at CLI startup
      const { skillRegistry, ensureSkillRegistryInitialized } = await import('../../services/skillEngine/skillLoader');
      const { createSkillExecutor } = await import('../../services/skillEngine/skillExecutor');
      const { getTraceProcessorService } = await import('../../services/traceProcessorService');

      // Initialize
      console.log(colors.gray('Initializing skill registry...'));
      await ensureSkillRegistryInitialized();

      // Check if skill exists
      const skill = skillRegistry.getSkill(skillId);
      if (!skill) {
        console.log(colors.red(`\nSkill not found: ${skillId}`));
        console.log(colors.gray('\nAvailable skills:'));
        const allSkills = skillRegistry.getAllSkills();
        for (const s of allSkills) {
          console.log(`  - ${s.name}`);
        }
        process.exit(1);
      }

      console.log(colors.gray('Loading trace file...'));

      // Create trace processor and load trace
      const traceProcessor = getTraceProcessorService();

      // Load the trace file directly from path
      const traceId = await traceProcessor.loadTraceFromFilePath(tracePath);

      console.log(colors.gray(`Trace loaded with ID: ${traceId}`));

      // Execute skill
      console.log(colors.bold('Executing skill...\n'));
      const startTime = Date.now();

      const executor = createSkillExecutor(traceProcessor);
      executor.setFragmentRegistry(skillRegistry.getFragmentCache());
      executor.registerSkills(skillRegistry.getAllSkills());
      const result = await executor.execute(skillId, traceId, { package: options.package });

      const executionTime = Date.now() - startTime;

      // Display results
      console.log(colors.bold('Results:\n'));

      if (result.success) {
        console.log(`Status: ${colors.green('SUCCESS')}`);
      } else {
        console.log(`Status: ${colors.red('FAILED')}`);
      }

      console.log(`Time:   ${executionTime}ms`);
      console.log('');

      // Display results
      if (result.displayResults && result.displayResults.length > 0) {
        if (options.verbose) {
          console.log(colors.bold('Display Results:'));
          for (const display of result.displayResults) {
            console.log(`\n  ${colors.cyan(display.stepId)}:`);
            console.log(`    Title: ${display.title || 'N/A'}`);
            console.log(`    Format: ${display.format}`);
            console.log(`    Level: ${display.level}`);

            if (display.data.rows && display.data.rows.length > 0) {
              console.log(`    Rows: ${display.data.rows.length}`);
              console.log('    Sample:');
              const sample = display.data.rows.slice(0, 3);
              for (const row of sample) {
                console.log(`      ${JSON.stringify(row).substring(0, 100)}...`);
              }
            } else if (display.data.text) {
              console.log(`    Text: ${display.data.text.substring(0, 100)}...`);
            }
          }
          console.log('');
        } else {
          console.log(colors.bold('Display Results:'));
          for (const display of result.displayResults) {
            const rowCount = display.data.rows?.length || 0;
            console.log(`  ${display.stepId}: ${rowCount > 0 ? `${rowCount} rows` : display.format}`);
          }
          console.log('');
        }
      }

      // Display diagnostics
      if (result.diagnostics && result.diagnostics.length > 0) {
        console.log(colors.bold('Diagnostics:'));
        for (const diag of result.diagnostics) {
          const severityColor =
            diag.severity === 'critical' ? colors.red :
            diag.severity === 'warning' ? colors.yellow :
            colors.blue;
          console.log(`  ${severityColor(`[${diag.severity.toUpperCase()}]`)} ${diag.diagnosis}`);
          if (diag.suggestions && diag.suggestions.length > 0) {
            for (const suggestion of diag.suggestions) {
              console.log(`    - ${suggestion}`);
            }
          }
        }
        console.log('');
      }

      // Display summary
      console.log(colors.bold('Summary:'));
      console.log(colors.gray(result.aiSummary || 'No summary available'));

      // Cleanup
      await traceProcessor.deleteTrace(traceId);

      process.exit(result.success ? 0 : 1);
    } catch (error: any) {
      console.log(colors.red(`\nError: ${error.message}`));
      if (options.verbose) {
        console.log(colors.gray(error.stack));
      }
      process.exit(1);
    }
  });
