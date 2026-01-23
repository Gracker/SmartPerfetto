/**
 * Smoke Command
 *
 * Runs (many) skills against a trace file and reports any SQL execution errors
 * returned by trace_processor (e.g. syntax error, missing table, unknown module).
 *
 * This is meant to answer: "Will there be other broken SQL in skills?"
 */

import { Command } from 'commander';
import path from 'path';

// ANSI color codes (fallback for chalk ESM issues)
const colors = {
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  blue: (s: string) => `\x1b[34m${s}\x1b[0m`,
  gray: (s: string) => `\x1b[90m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
  cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
};

type QueryError = {
  sql: string;
  error: string;
};

function parsePattern(pattern: string | undefined): ((id: string) => boolean) | undefined {
  if (!pattern) return undefined;
  const trimmed = pattern.trim();
  if (!trimmed) return undefined;

  // /.../ as a regex
  if (trimmed.startsWith('/') && trimmed.endsWith('/') && trimmed.length > 2) {
    const body = trimmed.slice(1, -1);
    const re = new RegExp(body);
    return (id: string) => re.test(id);
  }

  // substring match (case-insensitive)
  const lower = trimmed.toLowerCase();
  return (id: string) => id.toLowerCase().includes(lower);
}

function formatSqlSnippet(sql: string, maxLen = 160): string {
  const oneLine = sql.replace(/\s+/g, ' ').trim();
  if (oneLine.length <= maxLen) return oneLine;
  return `${oneLine.slice(0, maxLen)}...`;
}

export const smokeCommand = new Command('smoke')
  .description('Run multiple skills on a trace and report SQL query errors')
  .requiredOption('-t, --trace <path>', 'Path to trace file (.pftrace/.perfetto-trace)')
  .option('-p, --package <name>', 'Package name filter (passed as skill param "package")')
  .option('--pattern <pattern>', 'Only run skills whose id matches substring or /regex/')
  .option('--include-modules', 'Include module expert skills (skills with "module" metadata)', false)
  .option('--limit <n>', 'Only run first N skills after filtering (0 = no limit)', '0')
  .option('--max-skill-errors <n>', 'Stop after N skills have SQL errors (0 = no limit)', '0')
  .option('--per-skill-samples <n>', 'Max error samples to print per skill', '3')
  .option('--show-sql', 'Print SQL snippet for each error sample', false)
  .option('-v, --verbose', 'Verbose output', false)
  .action(async (options: {
    trace: string;
    package?: string;
    pattern?: string;
    includeModules?: boolean;
    limit?: string;
    maxSkillErrors?: string;
    perSkillSamples?: string;
    showSql?: boolean;
    verbose?: boolean;
  }) => {
    console.log(colors.bold('\nSmartPerfetto Skill SQL Smoke Test\n'));

    const tracePath = path.resolve(options.trace);
    const filter = parsePattern(options.pattern);

    const limit = Number(options.limit || 0);
    const maxSkillErrors = Number(options.maxSkillErrors || 0);
    const perSkillSamples = Math.max(1, Number(options.perSkillSamples || 3));

    try {
      // Dynamic imports to avoid loading heavy dependencies at CLI startup
      const { skillRegistry, ensureSkillRegistryInitialized } = await import('../../services/skillEngine/skillLoader');
      const { createSkillExecutor } = await import('../../services/skillEngine/skillExecutor');
      const { getTraceProcessorService } = await import('../../services/traceProcessorService');

      console.log(colors.gray('Initializing skill registry...'));
      await ensureSkillRegistryInitialized();

      let skills = skillRegistry.getAllSkills().slice().sort((a, b) => a.name.localeCompare(b.name));
      if (!options.includeModules) {
        skills = skills.filter(s => !s.module);
      }
      if (filter) {
        skills = skills.filter(s => filter(s.name));
      }
      if (limit > 0) {
        skills = skills.slice(0, limit);
      }

      if (skills.length === 0) {
        console.log(colors.yellow('No skills matched. Nothing to run.'));
        process.exit(0);
      }

      console.log(`Trace:  ${colors.gray(tracePath)}`);
      console.log(`Skills: ${colors.cyan(String(skills.length))}${options.includeModules ? '' : colors.gray(' (excluding module experts)')}`);
      if (options.pattern) {
        console.log(`Match:  ${colors.gray(options.pattern)}`);
      }
      console.log('');

      const traceProcessor = getTraceProcessorService();
      console.log(colors.gray('Loading trace file...'));
      const traceId = await traceProcessor.loadTraceFromFilePath(tracePath);
      console.log(colors.gray(`Trace loaded with ID: ${traceId}\n`));

      // Collect all query errors returned by trace_processor.
      // We attribute errors to the currently running skill by slicing the array
      // between "before execute()" and "after execute()".
      const allQueryErrors: QueryError[] = [];
      const baseQuery = traceProcessor.query.bind(traceProcessor);
      const traceProcessorProxy = {
        query: async (tpTraceId: string, sql: string) => {
          const res = await baseQuery(tpTraceId, sql);
          if (res?.error) {
            allQueryErrors.push({ sql, error: res.error });
          }
          return res;
        },
      };

      const executor = createSkillExecutor(traceProcessorProxy);
      executor.registerSkills(skills);

      const baseParams: Record<string, any> = {};
      if (options.package !== undefined) {
        baseParams.package = options.package;
      }

      let ok = 0;
      let skipped = 0;
      let failed = 0;

      const failedSkills: Array<{ id: string; errorCount: number; samples: QueryError[]; execMs: number; skippedReason?: string }> = [];

      for (let i = 0; i < skills.length; i++) {
        const skill = skills[i];
        const idxLabel = colors.gray(`[${i + 1}/${skills.length}]`);

        const startErrIdx = allQueryErrors.length;
        const start = Date.now();

        const result = await executor.execute(skill.name, traceId, baseParams);
        const execMs = Date.now() - start;

        const newErrors = allQueryErrors.slice(startErrIdx);

        // Treat "required_tables" miss as a skip (trace-dependent), not an SQL error.
        const skippedByPrereq = Boolean(result.error && result.error.startsWith('Skipped: Trace is missing required tables'));

        if (newErrors.length > 0) {
          failed++;
          const samples = newErrors.slice(0, perSkillSamples);
          failedSkills.push({ id: skill.name, errorCount: newErrors.length, samples, execMs });
          console.log(`${idxLabel} ${colors.red('FAIL')} ${colors.cyan(skill.name)} ${colors.gray(`(${execMs}ms, ${newErrors.length} query error(s))`)}`);

          for (const e of samples) {
            console.log(`  ${colors.red('ERROR:')} ${e.error}`);
            if (options.showSql || options.verbose) {
              console.log(`  ${colors.gray('SQL:')} ${formatSqlSnippet(e.sql)}`);
            }
          }

          if (maxSkillErrors > 0 && failed >= maxSkillErrors) {
            console.log(colors.yellow(`\nStopping early: reached max-skill-errors=${maxSkillErrors}`));
            break;
          }
        } else if (!result.success && skippedByPrereq) {
          skipped++;
          failedSkills.push({ id: skill.name, errorCount: 0, samples: [], execMs, skippedReason: result.error });
          console.log(`${idxLabel} ${colors.yellow('SKIP')} ${colors.cyan(skill.name)} ${colors.gray(`(${execMs}ms)`)}`);
          if (options.verbose) {
            console.log(`  ${colors.gray(result.error || '')}`);
          }
        } else {
          ok++;
          const status = result.success ? colors.green('OK') : colors.yellow('OK*');
          const extra = !result.success && result.error ? colors.gray(` (${result.error})`) : '';
          console.log(`${idxLabel} ${status} ${colors.cyan(skill.name)} ${colors.gray(`(${execMs}ms)`)}${extra}`);
        }
      }

      console.log(colors.bold('\nSummary:'));
      console.log(`  OK:      ${colors.green(String(ok))}`);
      console.log(`  Skipped: ${skipped > 0 ? colors.yellow(String(skipped)) : '0'}`);
      console.log(`  Failed:  ${failed > 0 ? colors.red(String(failed)) : '0'}`);

      // Cleanup
      await traceProcessor.deleteTrace(traceId);

      process.exit(failed > 0 ? 1 : 0);
    } catch (error: any) {
      console.log(colors.red(`\nError: ${error.message}`));
      if (options.verbose && error.stack) {
        console.log(colors.gray(error.stack));
      }
      process.exit(1);
    }
  });

