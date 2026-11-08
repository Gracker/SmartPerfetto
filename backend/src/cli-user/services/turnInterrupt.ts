// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

/**
 * Per-turn Ctrl-C handling for the CLI.
 *
 * The first Ctrl-C fully aborts the turn through its signal; it is not saved.
 * A further press, or a turn that has not unwound within the grace period
 * after the abort, exits with 130. Once the turn is committed, Ctrl-C no
 * longer belongs to it.
 */

import {localize, parseOutputLanguage, type OutputLanguage} from '../../agentv3/outputLanguage';

export interface InterruptSource {
  /** Registers the turn's handler; the returned function removes it. */
  subscribe(onInterrupt: () => void): () => void;
}

/** One-shot commands: listen to process SIGINT only while a turn runs. */
export function processInterruptSource(): InterruptSource {
  return {
    subscribe(onInterrupt) {
      process.on('SIGINT', onInterrupt);
      return () => { process.off('SIGINT', onInterrupt); };
    },
  };
}

/** REPL: readline owns SIGINT and forwards it here while a turn runs. */
export class ForwardingInterruptSource implements InterruptSource {
  private handler?: () => void;

  subscribe(onInterrupt: () => void): () => void {
    this.handler = onInterrupt;
    return () => { if (this.handler === onInterrupt) this.handler = undefined; };
  }

  /** False when no turn is listening; the caller keeps its own behavior. */
  interrupt(): boolean {
    if (!this.handler) return false;
    this.handler();
    return true;
  }
}

export class TurnInterruptedError extends Error {
  constructor(language: OutputLanguage = parseOutputLanguage(process.env.SMARTPERFETTO_OUTPUT_LANGUAGE)) {
    super(localize(language, '本轮分析已取消，未保存。', 'Turn cancelled; nothing was saved.'));
    this.name = 'TurnInterruptedError';
  }
}

export function isTurnInterrupted(error: unknown): error is TurnInterruptedError {
  return error instanceof TurnInterruptedError;
}

export const CLI_INTERRUPTED_EXIT_CODE = 130;

export interface TurnInterruptOptions {
  source: InterruptSource;
  notify?(message: string): void;
  exit?(code: number): void;
  /** Grace period after a full abort before exiting 130. */
  graceMs?: number;
  language?: OutputLanguage;
}

export class TurnInterruptController {
  private readonly abortController = new AbortController();
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();
  private unsubscribe?: () => void;
  private disposed = false;
  private readonly language: OutputLanguage;
  private readonly notify: (message: string) => void;
  private readonly exit: (code: number) => void;

  constructor(private readonly options: TurnInterruptOptions) {
    this.language = options.language ?? parseOutputLanguage(process.env.SMARTPERFETTO_OUTPUT_LANGUAGE);
    this.notify = options.notify ?? (message => { process.stderr.write(`\n${message}\n`); });
    this.exit = options.exit ?? (code => process.exit(code));
    this.unsubscribe = options.source.subscribe(() => this.handleInterrupt());
  }

  /** Full abort of the turn; the turn is not saved. */
  get signal(): AbortSignal { return this.abortController.signal; }

  get interrupted(): boolean { return this.abortController.signal.aborted; }

  /** The turn is saved: release Ctrl-C and cancel the pending grace timer. */
  markCommitted(): void {
    this.dispose();
  }

  dispose(): void {
    this.disposed = true;
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
  }

  private handleInterrupt(): void {
    if (this.disposed) return;
    // Pressed again after the turn was already aborted.
    if (!this.abortController.signal.aborted) {
      this.notify(localize(this.language,
        '正在停止本轮分析，不会保存。再按 Ctrl-C 立即退出。',
        'Stopping this turn; it will not be saved. Press Ctrl-C again to exit immediately.'));
      this.abortTurn();
      return;
    }
    this.exit(CLI_INTERRUPTED_EXIT_CODE);
  }

  private abortTurn(): void {
    this.abortController.abort(new DOMException('Turn cancelled by user', 'AbortError'));
    // A turn that does not unwind in time is killed; a clean one disposes first.
    this.schedule(this.options.graceMs ?? 2_000, () => this.exit(CLI_INTERRUPTED_EXIT_CODE));
  }

  private schedule(ms: number, callback: () => void): void {
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      if (!this.disposed) callback();
    }, ms);
    timer.unref?.();
    this.timers.add(timer);
  }
}
