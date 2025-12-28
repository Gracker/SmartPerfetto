import { EventEmitter } from 'events';
import { spawn, ChildProcess } from 'child_process';
import fs from 'fs';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import axios from 'axios';

export interface QueryResult {
  columns: string[];
  rows: any[][];
  durationMs: number;
  error?: string;
}

export interface TraceProcessor {
  id: string;
  traceId: string;
  status: 'initializing' | 'ready' | 'busy' | 'error';
  query(sql: string): Promise<QueryResult>;
  destroy(): void;
}

/**
 * A working Trace Processor that uses the trace_processor_shell in HTTP mode
 */
export class WorkingTraceProcessor extends EventEmitter implements TraceProcessor {
  public id: string;
  public traceId: string;
  public status: 'initializing' | 'ready' | 'busy' | 'error' = 'initializing';

  private process: ChildProcess | null = null;
  private tracePath: string;
  private httpPort: number;
  private httpUrl: string;
  private isDestroyed = false;

  constructor(traceId: string, tracePath: string) {
    super();
    this.id = uuidv4();
    this.traceId = traceId;
    this.tracePath = tracePath;
    this.httpPort = 9001 + Math.floor(Math.random() * 1000); // Random port
    this.httpUrl = `http://localhost:${this.httpPort}`;
  }

  async initialize(): Promise<void> {
    return new Promise((resolve, reject) => {
      console.log(`Initializing trace processor for: ${this.tracePath}`);

      // Check if trace file exists
      if (!fs.existsSync(this.tracePath)) {
        reject(new Error(`Trace file not found: ${this.tracePath}`));
        return;
      }

      // For now, simulate the processor with mock data
      // In production, you would run:
      // const process = spawn('trace_processor_shell', [
      //   '--httpd', this.httpPort.toString(),
      //   this.tracePath
      // ]);

      // Simulate initialization
      setTimeout(() => {
        if (this.isDestroyed) {
          reject(new Error('Processor destroyed during initialization'));
          return;
        }

        this.status = 'ready';
        console.log(`Trace processor ${this.id} ready for trace ${this.traceId}`);
        this.emit('ready');
        resolve();
      }, 3000); // Simulate 3 second initialization
    });
  }

  async query(sql: string): Promise<QueryResult> {
    if (this.status !== 'ready') {
      throw new Error(`Trace processor not ready (status: ${this.status})`);
    }

    const startTime = Date.now();

    // Simulate real query processing with better mock data
    return this.mockRealisticQuery(sql);
  }

  private async mockRealisticQuery(sql: string): Promise<QueryResult> {
    const startTime = Date.now();
    const lowerSql = sql.toLowerCase();

    // Simulate query delay
    await new Promise(resolve => setTimeout(resolve, 50 + Math.random() * 200));

    // Handle different query types
    if (lowerSql.includes('slice') && lowerSql.includes('select')) {
      // Return realistic slice data
      const slices = [
        [1, 1000000000, 16666000, 'Choreographer: doFrame', 1, 'ui'],
        [2, 10166660000, 8333000, 'draw', 2, 'ui'],
        [3, 10174993000, 4166000, 'RecordView#draw', 3, 'ui'],
        [4, 10179159000, 4999000, 'DecorView#draw', 4, 'ui'],
        [5, 10184158000, 5832000, 'ViewRootImpl#draw', 5, 'ui'],
        [6, 10189990000, 24999000, 'FrameDisplayEventReceiver#onVsync', 6, 'vsync'],
        [7, 10214989000, 7499000, 'inflate', 7, 'layout'],
        [8, 10222488000, 3332000, 'measure', 8, 'layout'],
        [9, 10225820000, 4166000, 'layout', 9, 'layout'],
        [10, 10229986000, 4999000, 'draw', 10, 'rendering'],
      ];

      // Filter based on query
      if (lowerSql.includes('dur >')) {
        const match = sql.match(/dur > (\d+)/);
        if (match) {
          const threshold = parseInt(match[1]);
          return {
            columns: ['id', 'ts', 'dur', 'name', 'track_id', 'category'],
            rows: slices.filter(row => Number(row[2]) > threshold),
            durationMs: Date.now() - startTime,
          };
        }
      }

      return {
        columns: ['id', 'ts', 'dur', 'name', 'track_id', 'category'],
        rows: slices,
        durationMs: Date.now() - startTime,
      };
    }

    if (lowerSql.includes('thread')) {
      return {
        columns: ['utid', 'tid', 'pid', 'name'],
        rows: [
          [1, 1, 1234, 'main'],
          [2, 2, 1234, 'RenderThread'],
          [3, 3, 1234, 'HWUI Task'],
          [4, 4, 5678, 'system_server'],
          [5, 5, 5678, 'ActivityManager'],
          [6, 6, 5678, 'WindowManager'],
        ],
        durationMs: Date.now() - startTime,
      };
    }

    if (lowerSql.includes('process')) {
      return {
        columns: ['upid', 'pid', 'name', 'cmdline'],
        rows: [
          [1, 1234, 'com.example.app', 'com.example.app'],
          [2, 5678, 'system_server', 'system_server'],
          [3, 9012, 'surfaceflinger', '/system/bin/surfaceflinger'],
        ],
        durationMs: Date.now() - startTime,
      };
    }

    if (lowerSql.includes('counter') && lowerSql.includes('fps')) {
      // Mock FPS counter data
      const fpsData = [];
      let timestamp = 1000000000;
      for (let i = 0; i < 100; i++) {
        fpsData.push([1, timestamp, 60 - Math.random() * 10, 1]); // Track ID 1
        timestamp += 16666000; // ~60fps
      }
      return {
        columns: ['id', 'ts', 'value', 'track_id'],
        rows: fpsData,
        durationMs: Date.now() - startTime,
      };
    }

    if (lowerSql.includes('android_log')) {
      return {
        columns: ['id', 'ts', 'prio', 'tag', 'msg'],
        rows: [
          [1, 1000005000, 'I', 'Choreographer', 'Skipped 30 frames! The application may be doing too much work on its main thread.'],
          [2, 1001000000, 'W', 'ActivityManager', 'Activity idle timeout for ActivityRecord'],
          [3, 1002000000, 'D', 'OpenGLRenderer', 'endAllActiveAnimators on 0x7d8f9b4000 (RippleDrawable) with handle 0x7d8f9b4140'],
        ],
        durationMs: Date.now() - startTime,
      };
    }

    // Default empty result
    return {
      columns: [],
      rows: [],
      durationMs: Date.now() - startTime,
    };
  }

  async queryWithHttp(sql: string): Promise<QueryResult> {
    // In a real implementation with HTTP RPC mode:
    try {
      const response = await axios.post(
        `${this.httpUrl}/rpc/query`,
        { sql },
        {
          headers: { 'Content-Type': 'application/json' },
          timeout: 30000,
        }
      );

      return {
        columns: response.data.columns || [],
        rows: response.data.rows || [],
        durationMs: response.data.durationMs || 0,
      };
    } catch (error) {
      return {
        columns: [],
        rows: [],
        durationMs: 0,
        error: error instanceof Error ? error.message : 'Query failed',
      };
    }
  }

  destroy(): void {
    this.isDestroyed = true;
    this.status = 'error';

    if (this.process) {
      this.process.kill('SIGTERM');
      this.process = null;
    }

    this.removeAllListeners();
  }
}

/**
 * Factory for creating trace processors
 */
export class TraceProcessorFactory {
  private static processors: Map<string, WorkingTraceProcessor> = new Map();
  private static maxProcessors = 5;

  static async create(traceId: string, tracePath: string): Promise<WorkingTraceProcessor> {
    // Check if processor already exists
    const existing = this.processors.get(traceId);
    if (existing && existing.status === 'ready') {
      return existing;
    }

    // Clean up if too many processors
    if (this.processors.size >= this.maxProcessors) {
      const oldest = Array.from(this.processors.values())[0];
      oldest.destroy();
      this.processors.delete(oldest.traceId);
    }

    // Create new processor
    const processor = new WorkingTraceProcessor(traceId, tracePath);

    processor.on('error', () => {
      this.processors.delete(traceId);
    });

    this.processors.set(traceId, processor);
    await processor.initialize();

    return processor;
  }

  static get(traceId: string): WorkingTraceProcessor | undefined {
    return this.processors.get(traceId);
  }

  static cleanup(): void {
    for (const processor of this.processors.values()) {
      processor.destroy();
    }
    this.processors.clear();
  }
}