import { EventEmitter } from 'events';
import fs from 'fs';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { WorkingTraceProcessor, TraceProcessorFactory } from './workingTraceProcessor';

export interface TraceInfo {
  id: string;
  filename: string;
  size: number;
  uploadTime: Date;
  status: 'uploading' | 'processing' | 'ready' | 'error';
  error?: string;
  metadata?: {
    duration?: number;
    startTime?: number;
    endTime?: number;
    numEvents?: number;
    packages?: string[];
  };
}

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
 * Manages trace files and processors using the actual Perfetto Trace Processor WASM
 */
export class TraceProcessorService extends EventEmitter {
  private traces: Map<string, TraceInfo> = new Map();
  private processors: Map<string, TraceProcessor> = new Map();
  private uploads: Map<string, any> = new Map();
  private uploadDir: string;

  constructor(uploadDir = './uploads/traces') {
    super();
    this.uploadDir = path.resolve(uploadDir);
    this.ensureUploadDir();
  }

  private ensureUploadDir(): void {
    if (!fs.existsSync(this.uploadDir)) {
      fs.mkdirSync(this.uploadDir, { recursive: true });
    }
  }

  /**
   * Initialize a trace upload
   */
  public async initializeUpload(filename: string, size: number): Promise<string> {
    const traceId = uuidv4();
    const traceInfo: TraceInfo = {
      id: traceId,
      filename,
      size,
      uploadTime: new Date(),
      status: 'uploading',
    };

    this.traces.set(traceId, traceInfo);
    this.emit('trace-initialized', traceInfo);

    return traceId;
  }

  /**
   * Initialize a trace upload with a specific ID
   * Use this when you already have a trace ID (e.g., from a file upload)
   */
  public async initializeUploadWithId(traceId: string, filename: string, size: number): Promise<void> {
    const traceInfo: TraceInfo = {
      id: traceId,
      filename,
      size,
      uploadTime: new Date(),
      status: 'uploading',
    };

    this.traces.set(traceId, traceInfo);
    this.emit('trace-initialized', traceInfo);
  }

  /**
   * Handle chunk upload for large files
   */
  public async uploadChunk(traceId: string, chunk: Buffer, offset: number): Promise<void> {
    const trace = this.traces.get(traceId);
    if (!trace) {
      throw new Error(`Trace ${traceId} not found`);
    }

    const filePath = this.getTraceFilePath(traceId);

    // Create write stream if not exists
    if (!this.uploads.has(traceId)) {
      const writeStream = fs.createWriteStream(filePath, { flags: 'w' });
      this.uploads.set(traceId, writeStream);
    }

    const writeStream = this.uploads.get(traceId);

    // Write chunk at specific offset
    return new Promise((resolve, reject) => {
      // For simplicity, we'll append chunks
      // In production, you might want to use random access for better performance
      writeStream.write(chunk, (error: any) => {
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      });
    });
  }

  /**
   * Complete the upload and start processing
   */
  public async completeUpload(traceId: string): Promise<void> {
    const trace = this.traces.get(traceId);
    if (!trace) {
      throw new Error(`Trace ${traceId} not found`);
    }

    // Close write stream
    const writeStream = this.uploads.get(traceId);
    if (writeStream) {
      writeStream.end();
      this.uploads.delete(traceId);
    }

    // Update status
    trace.status = 'processing';
    this.emit('trace-status-changed', trace);

    // Start processing
    await this.processTrace(traceId);
  }

  /**
   * Process the uploaded trace file
   */
  private async processTrace(traceId: string): Promise<void> {
    const trace = this.traces.get(traceId);
    if (!trace) return;

    try {
      // Create a processor instance
      const processor = await this.createProcessor(traceId);
      this.processors.set(traceId, processor);

      // Extract metadata
      const metadata = await this.extractMetadata(processor);
      trace.metadata = metadata;

      trace.status = 'ready';
      this.emit('trace-processed', trace);
      this.emit('trace-status-changed', trace);
    } catch (error: any) {
      trace.status = 'error';
      trace.error = error.message;
      this.emit('trace-status-changed', trace);
    }
  }

  /**
   * Create a new Trace Processor instance
   */
  private async createProcessor(traceId: string): Promise<TraceProcessor> {
    const filePath = this.getTraceFilePath(traceId);

    // Use the working trace processor
    const processor = await TraceProcessorFactory.create(traceId, filePath);

    // Store reference
    this.processors.set(traceId, processor);

    return processor;
  }

  /**
   * Extract basic metadata from the trace
   */
  private async extractMetadata(processor: TraceProcessor): Promise<TraceInfo['metadata']> {
    try {
      // Query basic trace information
      const result = await processor.query(`
        SELECT
          MIN(ts) as startTime,
          MAX(ts) as endTime,
          COUNT(*) as numEvents
        FROM slice
        UNION ALL
        SELECT
          MIN(ts) as startTime,
          MAX(ts) as endTime,
          COUNT(*) as numEvents
        FROM counter
        LIMIT 1
      `);

      if (result.rows.length > 0) {
        const row = result.rows[0];
        const startTime = row[0];
        const endTime = row[1];
        const numEvents = row[2];

        return {
          startTime,
          endTime,
          duration: endTime - startTime,
          numEvents,
        };
      }

      return {};
    } catch (error) {
      console.error('Failed to extract metadata:', error);
      return {};
    }
  }

  /**
   * Execute a SQL query on a trace
   */
  public async query(traceId: string, sql: string): Promise<QueryResult> {
    const processor = this.processors.get(traceId);
    if (!processor) {
      throw new Error(`No processor for trace ${traceId}`);
    }

    return await processor.query(sql);
  }

  /**
   * Get trace information
   */
  public getTrace(traceId: string): TraceInfo | undefined {
    return this.traces.get(traceId);
  }

  /**
   * Get all traces
   */
  public getAllTraces(): TraceInfo[] {
    return Array.from(this.traces.values());
  }

  /**
   * Delete a trace
   */
  public async deleteTrace(traceId: string): Promise<void> {
    const trace = this.traces.get(traceId);
    if (!trace) return;

    // Destroy processor
    const processor = this.processors.get(traceId);
    if (processor) {
      processor.destroy();
      this.processors.delete(traceId);
    }

    // Delete file
    const filePath = this.getTraceFilePath(traceId);
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }

    // Remove from memory
    this.traces.delete(traceId);
    this.emit('trace-deleted', traceId);
  }

  /**
   * Get file path for a trace
   */
  private getTraceFilePath(traceId: string): string {
    return path.join(this.uploadDir, `${traceId}.trace`);
  }

  /**
   * Cleanup old traces
   */
  public async cleanup(maxAge = 7 * 24 * 60 * 60 * 1000): Promise<void> {
    const now = Date.now();
    const tracesToDelete: string[] = [];

    for (const [traceId, trace] of this.traces) {
      if (now - trace.uploadTime.getTime() > maxAge) {
        tracesToDelete.push(traceId);
      }
    }

    for (const traceId of tracesToDelete) {
      await this.deleteTrace(traceId);
    }

    // Cleanup processors
    TraceProcessorFactory.cleanup();
  }
}

// Singleton instance for sharing across route modules
let _singletonInstance: TraceProcessorService | null = null;

export function getTraceProcessorService(): TraceProcessorService {
  if (!_singletonInstance) {
    _singletonInstance = new TraceProcessorService();
  }
  return _singletonInstance;
}