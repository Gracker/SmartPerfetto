// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {Command} from 'commander';
import path from 'path';

import {ingestCaseKnowledge} from '../../services/caseIngester';
import {validateCaseKnowledgeFiles} from '../../services/caseSchemaValidator';
import {caseCurationGrantForMarkdownIngest} from '../../services/security/caseCuration';

const colors = {
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  gray: (s: string) => `\x1b[90m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
};

const CASES_DIR = path.join(__dirname, '../../../knowledge/cases');

export const ingestCommand = new Command('ingest')
  .description('Ingest rebuildable SmartPerfetto knowledge assets')
  .option('--cases', 'Ingest curated Markdown case knowledge files')
  .option('--cases-dir <path>', 'Case knowledge directory (defaults to backend/knowledge/cases)')
  .option('--dry-run', 'Validate cases without writing runtime stores')
  .action((options: {cases?: boolean; casesDir?: string; dryRun?: boolean}) => {
    if (!options.cases) {
      console.log(colors.red('Nothing to ingest. Use --cases for case knowledge ingest.'));
      process.exit(1);
    }

    const casesDir = path.resolve(options.casesDir ?? CASES_DIR);
    console.log(colors.bold('\nSmartPerfetto Case Knowledge Ingester\n'));
    console.log(`Cases: ${colors.gray(casesDir)}`);

    if (options.dryRun) {
      const validation = validateCaseKnowledgeFiles(casesDir);
      if (!validation.ok) {
        for (const issue of validation.issues) {
          console.log(`${colors.red('FAIL')} ${issue.filePath}`);
          console.log(`  ${colors.red('ERROR:')} ${issue.message}`);
        }
        process.exit(1);
      }
      console.log(
        `${colors.green('PASS')} ${validation.cases.length} case file(s) validated`,
      );
      process.exit(0);
    }

    try {
      // Whoever runs this command is the operator whose authority attests the imported cases.
      const result = ingestCaseKnowledge({casesDir, grant: caseCurationGrantForMarkdownIngest()});
      console.log(`${colors.green('DONE')} Ingested ${result.caseCount} case file(s)`);
      console.log(`  CaseLibrary: ${colors.gray(result.caseLibraryPath)}`);
      console.log(`  CaseGraph:   ${colors.gray(result.caseGraphPath)}`);
      console.log(`  RagStore:    ${colors.gray(result.ragStorePath)}`);
      console.log(`  Edges:       ${result.edgeCount}`);
      console.log(`  Chunks:      ${result.chunkCount}`);
      for (const warning of result.warnings) {
        console.log(`  ${colors.yellow('WARNING:')} ${warning}`);
      }
      process.exit(0);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.log(colors.red('Case knowledge ingest failed'));
      console.log(message);
      process.exit(1);
    }
  });
