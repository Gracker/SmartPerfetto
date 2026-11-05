// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)

import {createHmac, randomBytes} from 'node:crypto';

/** Accepted capture registrations, not retained/used evidence or coverage. */
export interface RuntimeCaptureActivitySnapshot {
  observation: 'observed' | 'partial';
  tables: number;
  /** Sum of captured row slots, including unavailable tables; not usable evidence. */
  rowSlots: number;
  unavailableTables: number;
  currentRunTables: number;
  reusedTables: number;
  unknownOriginTables: number;
  /** Omitted registration events; not a count of distinct tables. */
  dropped: number;
}

export interface RuntimeCaptureActivityInput {
  /** Sum of captured row slots, including unavailable tables; not usable evidence. */
  rowSlots: number;
  unavailable: boolean;
  origin: 'current_run' | 'reused' | 'unknown';
}

/** Observed invocation activity, never evidence coverage or a stall verdict. */
export interface RuntimeActivitySnapshot {
  schemaVersion: 1;
  observation: 'observed' | 'partial' | 'unavailable';
  attempted: number;
  /** Scheduler dispatched the guarded pipeline; guards may still refuse the handler. */
  dispatched: number;
  returned: number;
  threw: number;
  cancelled: number;
  succeeded: number;
  failed: number;
  refused: number;
  unknownOutcome: number;
  inFlight: number;
  /** Exact repeated name/argument tuples; absent when comparison is incomplete. */
  repeatedExactCalls?: number;
  dropped: number;
  lastStartedMs?: number;
  lastCompletedMs?: number;
  /** Tool success and newly allocated capture ids do not establish novelty. */
  evidenceNovelty: 'not_assessed';
  /** Absent means this run has not observed a capture registration. */
  captureActivity?: RuntimeCaptureActivitySnapshot;
}

export interface RuntimeActivitySpan {
  dispatched(): void;
  end(outcome: 'returned' | 'threw' | 'cancelled', facts?: {success?: boolean; refused?: boolean}): void;
}

const MAX_CALLS = 512;
const MAX_ARGUMENT_BYTES = 65_536;
const MAX_NODES = 4096;
const MAX_DEPTH = 16;
const NOOP_SPAN: RuntimeActivitySpan = {dispatched() {}, end() {}};

/** Reject unsupported/oversized inputs, never compare a truncated prefix. */
function canonicalArguments(value: unknown): string | undefined {
  let bytes = 0;
  let nodes = 0;
  const seen = new Set<object>();
  const emit = (text: string): string => {
    bytes += Buffer.byteLength(text, 'utf8');
    if (bytes > MAX_ARGUMENT_BYTES) throw new Error('activity_input_limit');
    return text;
  };
  const visit = (input: unknown, depth: number): string => {
    if (++nodes > MAX_NODES || depth > MAX_DEPTH) throw new Error('activity_input_limit');
    if (input === null || typeof input === 'boolean') return emit(String(input));
    if (typeof input === 'number' && Number.isFinite(input)) return emit(Object.is(input, -0) ? '-0' : String(input));
    if (typeof input === 'string') {
      if (input.length > MAX_ARGUMENT_BYTES || Buffer.byteLength(input, 'utf8') > MAX_ARGUMENT_BYTES) {
        throw new Error('activity_input_limit');
      }
      return emit(JSON.stringify(input));
    }
    if (!input || typeof input !== 'object' || seen.has(input)) throw new Error('activity_input_invalid');
    const prototype = Object.getPrototypeOf(input);
    if (!Array.isArray(input) && prototype !== Object.prototype && prototype !== null) throw new Error('activity_input_invalid');
    seen.add(input);
    try {
      if (Array.isArray(input)) {
        const values: string[] = [];
        emit('[');
        for (let index = 0; index < input.length; index++) {
          const descriptor = Object.getOwnPropertyDescriptor(input, String(index));
          if (!descriptor || !('value' in descriptor)) throw new Error('activity_input_invalid');
          if (index) emit(',');
          values.push(visit(descriptor.value, depth + 1));
        }
        emit(']');
        return `[${values.join(',')}]`;
      }
      if (Object.getOwnPropertySymbols(input).length) throw new Error('activity_input_invalid');
      const keys = Object.keys(input);
      if (keys.length > MAX_NODES) throw new Error('activity_input_limit');
      keys.sort();
      const values: string[] = [];
      emit('{');
      for (const key of keys) {
        const descriptor = Object.getOwnPropertyDescriptor(input, key);
        if (!descriptor || !('value' in descriptor)) throw new Error('activity_input_invalid');
        if (values.length) emit(',');
        const name = emit(JSON.stringify(key));
        emit(':');
        values.push(`${name}:${visit(descriptor.value, depth + 1)}`);
      }
      emit('}');
      return `{${values.join(',')}}`;
    } finally { seen.delete(input); }
  };
  try { return visit(value, 0); } catch { return undefined; }
}

/** Run-local bounded hashes stay in memory; snapshots contain only closed facts. */
export class RuntimeActivityRecorder {
  private readonly key = randomBytes(32);
  private readonly signatures = new Set<string>();
  private repeats = 0;
  private observed = false;
  private partial = false;
  private readonly state = {attempted: 0, dispatched: 0, returned: 0, threw: 0, cancelled: 0,
    succeeded: 0, failed: 0, refused: 0, unknownOutcome: 0, inFlight: 0, dropped: 0};
  private lastStartedMs?: number;
  private lastCompletedMs?: number;
  private readonly captures = new WeakSet<object>();
  private captureActivity?: RuntimeCaptureActivitySnapshot;

  constructor(private readonly active: () => boolean, private readonly now: () => number,
    private readonly changed: () => void) {}

  markPartial(): void {
    this.partial = true;
    this.changed();
  }

  /** Called only after an issued witness was accepted by the evidence store. */
  capture(witness: object, input: RuntimeCaptureActivityInput): void {
    if (!this.active() || this.captures.has(witness)) return;
    const counts = this.captureActivity ??= {observation: 'observed', tables: 0, rowSlots: 0,
      unavailableTables: 0, currentRunTables: 0, reusedTables: 0, unknownOriginTables: 0, dropped: 0};
    if (counts.tables >= MAX_CALLS || !Number.isSafeInteger(input.rowSlots) || input.rowSlots < 0 ||
      !Number.isSafeInteger(counts.rowSlots + input.rowSlots)) {
      counts.observation = 'partial';
      counts.dropped = Math.min(Number.MAX_SAFE_INTEGER, counts.dropped + 1);
    } else {
      this.captures.add(witness);
      counts.tables++;
      counts.rowSlots += input.rowSlots;
      if (input.unavailable) counts.unavailableTables++;
      if (input.origin === 'current_run') counts.currentRunTables++;
      else if (input.origin === 'reused') counts.reusedTables++;
      else counts.unknownOriginTables++;
    }
    this.changed();
  }

  get hasRecordedData(): boolean { return this.observed || this.partial || this.captureActivity !== undefined; }

  start(toolName: string, args: Record<string, unknown>): RuntimeActivitySpan {
    if (!this.active()) return NOOP_SPAN;
    this.observed = true;
    if (this.state.attempted >= MAX_CALLS) {
      this.state.dropped = Math.min(Number.MAX_SAFE_INTEGER, this.state.dropped + 1);
      this.markPartial();
      return NOOP_SPAN;
    }
    const serialized = canonicalArguments([toolName, args]);
    if (serialized === undefined) this.partial = true;
    else {
      const signature = createHmac('sha256', this.key).update(serialized).digest('hex');
      if (this.signatures.has(signature)) this.repeats++;
      else this.signatures.add(signature);
    }
    this.state.attempted++;
    this.state.inFlight++;
    this.lastStartedMs = this.now();
    this.changed();
    let dispatched = false;
    let ended = false;
    return {
      dispatched: () => {
        if (ended || dispatched || !this.active()) return;
        dispatched = true;
        this.state.dispatched++;
        this.changed();
      },
      end: (outcome, facts = {}) => {
        if (ended || !this.active()) return;
        ended = true;
        this.state.inFlight--;
        this.state[outcome]++;
        if (outcome === 'returned') {
          if (facts.refused) this.state.refused++;
          else if (facts.success === true) this.state.succeeded++;
          else if (facts.success === false) this.state.failed++;
          else this.state.unknownOutcome++;
        }
        this.lastCompletedMs = this.now();
        this.changed();
      },
    };
  }

  snapshot(): RuntimeActivitySnapshot {
    return Object.freeze({schemaVersion: 1, observation: this.partial ? 'partial' : this.observed ? 'observed' : 'unavailable',
      ...this.state, ...(this.observed && !this.partial ? {repeatedExactCalls: this.repeats} : {}),
      ...(this.lastStartedMs === undefined ? {} : {lastStartedMs: this.lastStartedMs}),
      ...(this.lastCompletedMs === undefined ? {} : {lastCompletedMs: this.lastCompletedMs}), evidenceNovelty: 'not_assessed',
      ...(this.captureActivity ? {captureActivity: Object.freeze({...this.captureActivity})} : {})});
  }
}

/** Validate diagnostic receipts without accepting payload text or granting admission. */
export function parseRuntimeActivitySnapshot(value: unknown): RuntimeActivitySnapshot {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('runtime_activity_invalid');
  const raw = value as Record<string, unknown>;
  const counts = ['attempted', 'dispatched', 'returned', 'threw', 'cancelled', 'succeeded', 'failed',
    'refused', 'unknownOutcome', 'inFlight', 'dropped'] as const;
  const allowed = new Set<string>(['schemaVersion', 'observation', ...counts, 'repeatedExactCalls',
    'lastStartedMs', 'lastCompletedMs', 'evidenceNovelty', 'captureActivity']);
  const nonnegative = (number: unknown) => Number.isSafeInteger(number) && (number as number) >= 0;
  if (Object.keys(raw).some(key => !allowed.has(key)) || raw.schemaVersion !== 1 ||
    !['observed', 'partial', 'unavailable'].includes(String(raw.observation)) || raw.evidenceNovelty !== 'not_assessed' ||
    counts.some(key => !nonnegative(raw[key])) ||
    ['lastStartedMs', 'lastCompletedMs'].some(key => raw[key] !== undefined &&
      (typeof raw[key] !== 'number' || !Number.isFinite(raw[key]) || (raw[key] as number) < 0)) ||
    (raw.observation === 'observed' ? !nonnegative(raw.repeatedExactCalls) : raw.repeatedExactCalls !== undefined)) {
    throw new Error('runtime_activity_invalid');
  }
  const snapshot = raw as unknown as RuntimeActivitySnapshot;
  if (snapshot.dispatched > snapshot.attempted || snapshot.returned + snapshot.threw + snapshot.cancelled + snapshot.inFlight !== snapshot.attempted ||
    snapshot.succeeded + snapshot.failed + snapshot.refused + snapshot.unknownOutcome !== snapshot.returned ||
    (snapshot.repeatedExactCalls !== undefined && snapshot.repeatedExactCalls > Math.max(0, snapshot.attempted - 1)) ||
    (snapshot.observation === 'unavailable' && counts.some(key => snapshot[key] !== 0))) {
    throw new Error('runtime_activity_invalid');
  }
  return Object.freeze({...snapshot, ...(raw.captureActivity === undefined ? {}
    : {captureActivity: parseCaptureActivity(raw.captureActivity)})});
}

function parseCaptureActivity(value: unknown): RuntimeCaptureActivitySnapshot {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('runtime_capture_activity_invalid');
  const raw = value as Record<string, unknown>;
  const counts = ['tables', 'rowSlots', 'unavailableTables', 'currentRunTables', 'reusedTables', 'unknownOriginTables', 'dropped'];
  if (Object.keys(raw).some(key => key !== 'observation' && !counts.includes(key)) ||
    (raw.observation !== 'observed' && raw.observation !== 'partial') ||
    counts.some(key => !Number.isSafeInteger(raw[key]) || (raw[key] as number) < 0)) {
    throw new Error('runtime_capture_activity_invalid');
  }
  const parsed = raw as unknown as RuntimeCaptureActivitySnapshot;
  if (parsed.unavailableTables > parsed.tables ||
    parsed.currentRunTables + parsed.reusedTables + parsed.unknownOriginTables !== parsed.tables ||
    (parsed.observation === 'observed' && parsed.dropped > 0)) throw new Error('runtime_capture_activity_invalid');
  return Object.freeze({...parsed});
}
