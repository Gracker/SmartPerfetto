import { spawn, ChildProcess } from 'child_process';
import path from 'path';
import fs from 'fs/promises';
import { EventEmitter } from 'events';

// Prevent unhandled error events from crashing the process
EventEmitter.defaultMaxListeners = 20;

export interface PerfettoServerStatus {
  running: boolean;
  port?: number;
  pid?: number;
  traceFile?: string;
  uptime?: number;
}

export class PerfettoLocalService extends EventEmitter {
  private process: ChildProcess | null = null;
  private port: number = 9001;
  private traceProcessorPath: string;
  private currentTraceFile: string | null = null;
  private startTime: number | null = null;

  constructor() {
    super();
    // Use the trace_processor_shell from Perfetto-Tools directory
    this.traceProcessorPath = '/Users/chris/Code/SmartPerfetto/Perfetto-Tools/mac-amd64/trace_processor_shell';

    // Handle error events to prevent crashes
    this.on('error', (error) => {
      console.error('PerfettoLocalService error:', error);
    });
  }

  async startServer(traceFile?: string): Promise<PerfettoServerStatus> {
    if (this.process && !this.process.killed) {
      throw new Error('Perfetto server is already running');
    }

    // Find an available port
    this.port = await this.findAvailablePort(9001);

    const args = ['--httpd', `--http-port=${this.port}`];

    if (traceFile) {
      args.push(traceFile);
      this.currentTraceFile = traceFile;
    }

    console.log(`Starting Perfetto trace_processor with args:`, args);
    console.log(`Using trace_processor at: ${this.traceProcessorPath}`);

    return new Promise((resolve, reject) => {
      try {
        this.process = spawn(this.traceProcessorPath, args, {
          stdio: ['pipe', 'pipe', 'pipe']
        });

        this.startTime = Date.now();

        if (!this.process.pid) {
          reject(new Error('Failed to start Perfetto trace_processor'));
          return;
        }

        console.log(`Perfetto trace_processor started with PID: ${this.process.pid}`);

        // Handle output
        this.process.stdout?.on('data', (data) => {
          const output = data.toString();
          console.log(`[Perfetto] ${output.trim()}`);

          // Detect when server is ready
          if (output.includes('HTTP server listening on')) {
            this.emit('started', { port: this.port, pid: this.process?.pid ?? 0 });
            resolve(this.getStatus());
          }
        });

        this.process.stderr?.on('data', (data) => {
          const error = data.toString().trim();

          // Check if it's actually an error or just informational output
          if (error.includes('[ERROR]') || error.includes('FATAL') || error.includes('Failed')) {
            console.error(`[Perfetto Error] ${error}`);
            this.emit('error', error);
          } else {
            // Treat as informational output
            console.log(`[Perfetto] ${error}`);
          }
        });

        this.process.on('exit', (code) => {
          console.log(`Perfetto trace_processor exited with code: ${code}`);
          this.process = null;
          this.currentTraceFile = null;
          this.startTime = null;
          this.emit('stopped', { code });
        });

        this.process.on('error', (error) => {
          console.error('Failed to start Perfetto trace_processor:', error);
          this.process = null;
          // Don't emit 'error' event to avoid unhandled error crash
          // Just reject the promise
          reject(error);
        });

        // Check if the process started successfully after a short delay
        setTimeout(() => {
          if (this.process && !this.process.killed) {
            resolve(this.getStatus());
          } else {
            reject(new Error('Perfetto trace_processor failed to start'));
          }
        }, 5000); // 增加等待时间到5秒

      } catch (error) {
        reject(error);
      }
    });
  }

  async stopServer(): Promise<void> {
    if (!this.process || this.process.killed) {
      return;
    }

    console.log('Stopping Perfetto trace_processor...');

    return new Promise((resolve) => {
      if (this.process) {
        this.process.on('exit', () => {
          resolve();
        });

        this.process.kill('SIGTERM');

        // Force kill after 5 seconds
        setTimeout(() => {
          if (this.process && !this.process.killed) {
            this.process.kill('SIGKILL');
          }
        }, 5000);
      } else {
        resolve();
      }
    });
  }

  async loadTrace(traceFile: string): Promise<PerfettoServerStatus> {
    // Check if file exists
    try {
      await fs.access(traceFile);
    } catch (error) {
      throw new Error(`Trace file not found: ${traceFile}`);
    }

    // Always restart with new trace file
    await this.stopServer();
    return this.startServer(traceFile);
  }

  getStatus(): PerfettoServerStatus {
    const uptime = this.startTime ? Date.now() - this.startTime : 0;
    const isRunning = !!(this.process && !this.process.killed);

    return {
      running: isRunning,
      port: isRunning ? this.port : undefined,
      pid: this.process?.pid,
      traceFile: this.currentTraceFile || undefined,
      uptime
    };
  }

  private async findAvailablePort(startPort: number): Promise<number> {
    const net = await import('net');

    return new Promise((resolve, reject) => {
      const server = net.createServer();

      server.listen(startPort, () => {
        const port = (server.address() as any)?.port;
        server.close(() => {
          resolve(port);
        });
      });

      server.on('error', () => {
        // Port is in use, try next port
        resolve(this.findAvailablePort(startPort + 1));
      });
    });
  }

  get getPort(): number {
    return this.port;
  }

  get getTraceProcessorUrl(): string {
    return `http://localhost:${this.port}`;
  }
}

// Singleton instance
export const perfettoLocalService = new PerfettoLocalService();