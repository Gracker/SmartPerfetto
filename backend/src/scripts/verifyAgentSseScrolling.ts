import 'dotenv/config';
import cors from 'cors';
import express from 'express';
import fs from 'fs';
import path from 'path';
import agentRoutes from '../routes/agentRoutes';
import skillRoutes from '../routes/skillRoutes';
import traceProcessorRoutes from '../routes/traceProcessorRoutes';
import { getTraceProcessorService } from '../services/traceProcessorService';

interface VerifyOptions {
  tracePath: string;
  query: string;
  timeoutMs: number;
  maxRounds: number;
  confidenceThreshold: number;
  outputPath?: string;
  keepSession: boolean;
  keepTrace: boolean;
}

interface SseSummary {
  totalEvents: number;
  terminalEvent?: string;
  stageNames: string[];
  stageTransitionCount: number;
  directSkillProgressCount: number;
  directSkillCompletedCount: number;
  directSkillFindingCount: number;
  errorEvents: string[];
}

const DEFAULT_TRACE = '../test-traces/app_aosp_scrolling_heavy_jank.pftrace';
const DEFAULT_QUERY = '分析滑动性能';

function printUsage(): void {
  console.log('Usage: npx tsx src/scripts/verifyAgentSseScrolling.ts [options]');
  console.log('');
  console.log('Options:');
  console.log('  --trace <path>                    Trace path (default: ../test-traces/app_aosp_scrolling_heavy_jank.pftrace)');
  console.log('  --query <text>                    Analyze query (default: 分析滑动性能)');
  console.log('  --timeout-ms <number>             SSE timeout in ms (default: 300000)');
  console.log('  --max-rounds <number>             Analysis max rounds (default: 3)');
  console.log('  --confidence-threshold <number>   Analysis confidence threshold (default: 0.5)');
  console.log('  --output <path>                   JSON report output path');
  console.log('  --keep-session                    Do not delete session after verification');
  console.log('  --keep-trace                      Do not delete loaded trace after verification');
  console.log('  --help                            Show this help');
}

function parseArgs(argv: string[]): VerifyOptions {
  const options: VerifyOptions = {
    tracePath: path.resolve(process.cwd(), DEFAULT_TRACE),
    query: DEFAULT_QUERY,
    timeoutMs: 300_000,
    maxRounds: 3,
    confidenceThreshold: 0.5,
    keepSession: false,
    keepTrace: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];

    if (arg === '--help') {
      printUsage();
      process.exit(0);
    }

    if (arg === '--keep-session') {
      options.keepSession = true;
      continue;
    }

    if (arg === '--keep-trace') {
      options.keepTrace = true;
      continue;
    }

    if (arg === '--trace') {
      if (!next) {
        throw new Error('--trace requires a value');
      }
      options.tracePath = path.resolve(process.cwd(), next);
      i += 1;
      continue;
    }

    if (arg === '--query') {
      if (!next) {
        throw new Error('--query requires a value');
      }
      options.query = next;
      i += 1;
      continue;
    }

    if (arg === '--timeout-ms') {
      if (!next) {
        throw new Error('--timeout-ms requires a value');
      }
      const parsed = Number.parseInt(next, 10);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        throw new Error(`Invalid --timeout-ms value: ${next}`);
      }
      options.timeoutMs = parsed;
      i += 1;
      continue;
    }

    if (arg === '--max-rounds') {
      if (!next) {
        throw new Error('--max-rounds requires a value');
      }
      const parsed = Number.parseInt(next, 10);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        throw new Error(`Invalid --max-rounds value: ${next}`);
      }
      options.maxRounds = parsed;
      i += 1;
      continue;
    }

    if (arg === '--confidence-threshold') {
      if (!next) {
        throw new Error('--confidence-threshold requires a value');
      }
      const parsed = Number.parseFloat(next);
      if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
        throw new Error(`Invalid --confidence-threshold value: ${next}`);
      }
      options.confidenceThreshold = parsed;
      i += 1;
      continue;
    }

    if (arg === '--output') {
      if (!next) {
        throw new Error('--output requires a value');
      }
      options.outputPath = path.resolve(process.cwd(), next);
      i += 1;
      continue;
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  return options;
}

function createVerificationApp(): express.Express {
  const app = express();

  app.use(cors());
  app.use(express.json({ limit: '50mb' }));
  app.use(express.urlencoded({ extended: true, limit: '50mb' }));

  app.get('/health', (_req, res) => {
    res.json({ status: 'OK', timestamp: new Date().toISOString() });
  });

  app.use('/api/agent/v1', agentRoutes);
  app.use('/api/trace-processor', traceProcessorRoutes);
  app.use('/api/skills', skillRoutes);

  app.use((_req, res) => {
    res.status(404).json({ error: 'Route not found' });
  });

  app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(500).json({ error: err.message || 'Internal server error' });
  });

  return app;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === 'object') {
    return value as Record<string, unknown>;
  }
  return null;
}

async function collectSseSummary(baseUrl: string, sessionId: string, timeoutMs: number): Promise<SseSummary> {
  const summary: SseSummary = {
    totalEvents: 0,
    stageNames: [],
    stageTransitionCount: 0,
    directSkillProgressCount: 0,
    directSkillCompletedCount: 0,
    directSkillFindingCount: 0,
    errorEvents: [],
  };

  const stageNameSet = new Set<string>();

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(`${baseUrl}/api/agent/v1/${sessionId}/stream`, {
      headers: { Accept: 'text/event-stream' },
      signal: controller.signal,
    });

    if (!response.ok || !response.body) {
      throw new Error(`SSE stream failed: HTTP ${response.status}`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let shouldStop = false;

    while (!shouldStop) {
      const chunk = await reader.read();
      if (chunk.done) {
        break;
      }

      buffer += decoder.decode(chunk.value, { stream: true });
      let separatorIndex = buffer.indexOf('\n\n');

      while (separatorIndex !== -1) {
        const block = buffer.slice(0, separatorIndex).trim();
        buffer = buffer.slice(separatorIndex + 2);

        if (block !== '' && !block.startsWith(':')) {
          let event = 'message';
          const dataLines: string[] = [];

          for (const line of block.split('\n')) {
            if (line.startsWith('event:')) {
              event = line.slice(6).trim();
            } else if (line.startsWith('data:')) {
              dataLines.push(line.slice(5).trimStart());
            }
          }

          const dataText = dataLines.join('\n');
          let parsed: unknown = dataText;
          if (dataText !== '') {
            try {
              parsed = JSON.parse(dataText);
            } catch {
              parsed = dataText;
            }
          }

          summary.totalEvents += 1;
          summary.terminalEvent = event;

          const parsedRecord = asRecord(parsed);
          const payload = asRecord(parsedRecord?.data);

          if (event === 'stage_transition') {
            const stageName = typeof payload?.stageName === 'string' ? payload.stageName : undefined;
            if (stageName) {
              stageNameSet.add(stageName);
              summary.stageTransitionCount += 1;
            }
          }

          if (event === 'progress') {
            const message = typeof payload?.message === 'string' ? payload.message : '';
            if (message.includes('DirectSkill[jank_frame_detail]')) {
              summary.directSkillProgressCount += 1;
            }
            if (message.includes('DirectSkillExecutor: completed')) {
              summary.directSkillCompletedCount += 1;
            }
          }

          if (event === 'finding') {
            const findingsContainer = asRecord(parsedRecord?.data);
            const findingsRaw = findingsContainer?.findings;
            if (Array.isArray(findingsRaw)) {
              for (const finding of findingsRaw) {
                const findingRecord = asRecord(finding);
                const source = typeof findingRecord?.source === 'string' ? findingRecord.source : '';
                if (source.includes('direct_skill:jank_frame_detail')) {
                  summary.directSkillFindingCount += 1;
                }
              }
            }
          }

          if (event === 'error') {
            if (typeof payload?.message === 'string') {
              summary.errorEvents.push(payload.message);
            } else {
              summary.errorEvents.push(typeof parsed === 'string' ? parsed : 'Unknown SSE error event');
            }
          }

          if (event === 'analysis_completed' || event === 'end') {
            shouldStop = true;
            break;
          }
        }

        separatorIndex = buffer.indexOf('\n\n');
      }
    }

    await reader.cancel();
  } finally {
    clearTimeout(timeout);
  }

  summary.stageNames = Array.from(stageNameSet);
  return summary;
}

function findSessionLogFile(sessionId: string): string | null {
  const logDir = path.resolve(process.cwd(), 'logs/sessions');
  if (!fs.existsSync(logDir)) {
    return null;
  }
  const prefix = `session_${sessionId}_`;
  const files = fs
    .readdirSync(logDir)
    .filter((name) => name.startsWith(prefix) && name.endsWith('.jsonl'))
    .sort();

  if (files.length === 0) {
    return null;
  }

  return path.join(logDir, files[files.length - 1]);
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (!fs.existsSync(options.tracePath)) {
    throw new Error(`Trace file not found: ${options.tracePath}`);
  }

  const hasAnyLlmKey = [
    process.env.GLM_API_KEY,
    process.env.DEEPSEEK_API_KEY,
    process.env.OPENAI_API_KEY,
    process.env.ANTHROPIC_API_KEY,
  ].some((value) => typeof value === 'string' && value.trim() !== '');

  if (!hasAnyLlmKey) {
    throw new Error('No LLM API key found (GLM_API_KEY / DEEPSEEK_API_KEY / OPENAI_API_KEY / ANTHROPIC_API_KEY)');
  }

  const app = createVerificationApp();
  const server = app.listen(0);

  const address = server.address();
  if (!address || typeof address === 'string') {
    server.close();
    throw new Error('Failed to bind local verification server');
  }
  const baseUrl = `http://127.0.0.1:${address.port}`;

  const traceProcessorService = getTraceProcessorService();
  let traceId = '';
  let sessionId = '';

  try {
    traceId = await traceProcessorService.loadTraceFromFilePath(options.tracePath);

    const startResponse = await fetch(`${baseUrl}/api/agent/v1/analyze`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        traceId,
        query: options.query,
        options: {
          maxRounds: options.maxRounds,
          confidenceThreshold: options.confidenceThreshold,
        },
      }),
    });

    const startJson = (await startResponse.json()) as Record<string, unknown>;
    if (!startResponse.ok || typeof startJson.sessionId !== 'string') {
      throw new Error(`Analyze request failed: ${JSON.stringify(startJson)}`);
    }
    sessionId = startJson.sessionId;

    const sse = await collectSseSummary(baseUrl, sessionId, options.timeoutMs);

    const stageSet = new Set(sse.stageNames);
    const checks = {
      hasOverviewStage: stageSet.has('overview'),
      hasSessionOverviewStage: stageSet.has('session_overview'),
      hasFrameAnalysisStage: stageSet.has('frame_analysis'),
      hasDirectSkillProgress: sse.directSkillProgressCount > 0,
      hasDirectSkillCompleted: sse.directSkillCompletedCount > 0,
      hasDirectSkillFindings: sse.directSkillFindingCount > 0,
      hasAnalysisCompletedEvent: sse.terminalEvent === 'analysis_completed' || sse.terminalEvent === 'end',
      hasNoSseErrors: sse.errorEvents.length === 0,
    };

    const passed = Object.values(checks).every(Boolean);
    const sessionLogFile = findSessionLogFile(sessionId);

    const output = {
      timestamp: new Date().toISOString(),
      tracePath: options.tracePath,
      query: options.query,
      traceId,
      sessionId,
      checks,
      passed,
      summary: sse,
      sessionLogFile,
    };

    const defaultOutputPath = path.resolve(
      process.cwd(),
      `test-output/verify-agent-sse-scrolling-${Date.now()}.json`
    );
    const outputPath = options.outputPath ?? defaultOutputPath;
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, `${JSON.stringify(output, null, 2)}\n`);

    console.log(JSON.stringify(output, null, 2));
    console.log(`Report written to: ${outputPath}`);

    if (!passed) {
      process.exitCode = 1;
    }
  } finally {
    if (sessionId !== '' && !options.keepSession) {
      try {
        await fetch(`${baseUrl}/api/agent/v1/${sessionId}`, { method: 'DELETE' });
      } catch {
      }
    }

    if (traceId !== '' && !options.keepTrace) {
      try {
        await traceProcessorService.deleteTrace(traceId);
      } catch {
      }
    }

    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
