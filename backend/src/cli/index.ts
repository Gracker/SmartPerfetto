#!/usr/bin/env node
/**
 * SmartPerfetto CLI
 *
 * Command-line tools for managing and testing skills.
 */

import { Command } from 'commander';
import { validateCommand } from './commands/validate';
import { testCommand } from './commands/test';
import { listCommand } from './commands/list';
import { smokeCommand } from './commands/smoke';

const program = new Command();

program
  .name('smart-perfetto')
  .description('SmartPerfetto CLI tools for skill management')
  .version('1.0.0');

program.addCommand(validateCommand);
program.addCommand(testCommand);
program.addCommand(listCommand);
program.addCommand(smokeCommand);

program.parse();
