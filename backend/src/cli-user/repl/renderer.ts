// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

/**
 * Terminal renderer for StreamingUpdate events.
 *
 * PR1 scope: stateless line-by-line logging, no spinner/animation.
 * The spinner + clear-line tricks needed for a polished typewriter
 * effect belong in PR3's REPL — in one-shot mode, stable line-based
 * output is easier to grep and read in CI/scripts.
 *
 * ANSI colors are stripped when stdout is not a TTY or `--no-color`
 * is passed — ensures `smartperfetto analyze ... > log.txt` stays clean.
 */

import type { StreamingUpdate } from '../../agent/types';

export interface RendererOptions {
  verbose: boolean;
  useColor: boolean;
}

/** Minimal ANSI color helper. Stays in-file so we don't pull in chalk. */
function ansi(code: string, on: boolean): (s: string) => string {
  return (s) => (on ? `\x1b[${code}m${s}\x1b[0m` : s);
}

export interface Renderer {
  onEvent(update: StreamingUpdate): void;
  /** Called once after the SDK result arrives — prints the conclusion block. */
  printConclusion(conclusion: string, meta: { confidence?: number; rounds?: number; durationMs?: number }): void;
  /** Called on fatal errors that abort the run. */
  printError(message: string): void;
  /** Called last to summarize report path + any diagnostics. */
  printCompletion(meta: { reportPath: string; sessionDir: string; sessionId: string }): void;
}

export function createRenderer(opts: RendererOptions): Renderer {
  const useColor = opts.useColor && Boolean(process.stdout.isTTY);
  const dim = ansi('2', useColor);
  const cyan = ansi('36', useColor);
  const yellow = ansi('33', useColor);
  const red = ansi('31', useColor);
  const green = ansi('32', useColor);
  const bold = ansi('1', useColor);

  // answer_token events arrive many per second — write without newline to get
  // a typewriter feel. A newline is printed once a non-token event interrupts.
  let answerStreamOpen = false;

  function closeAnswerStream() {
    if (answerStreamOpen) {
      process.stdout.write('\n');
      answerStreamOpen = false;
    }
  }

  function onEvent(update: StreamingUpdate): void {
    const type = update.type;
    const content: any = update.content || {};

    // Tokens stream mid-line; anything else must close the line first.
    if (type !== 'answer_token' && answerStreamOpen) closeAnswerStream();

    switch (type) {
      case 'progress': {
        const phase = content.phase || 'progress';
        const msg = content.message || '';
        console.log(`${dim('›')} ${cyan(`[${phase}]`)} ${msg}`);
        return;
      }
      case 'thought': {
        const text = (content.thought || '').trim();
        if (!text) return;
        // Dim thoughts so answer tokens remain visually prominent. Wrap long
        // thoughts to keep things readable but don't hard-wrap mid-word.
        for (const line of text.split('\n')) {
          console.log(dim(`  ${line}`));
        }
        return;
      }
      case 'agent_task_dispatched': {
        const tool = content.toolName || 'tool';
        const msg = content.message || tool;
        console.log(`${yellow('↳')} ${msg}`);
        return;
      }
      case 'agent_response': {
        if (!opts.verbose) return;
        const taskId = String(content.taskId || '');
        const resStr = typeof content.result === 'string'
          ? content.result
          : JSON.stringify(content.result);
        const preview = resStr.length > 200 ? `${resStr.slice(0, 200)}…` : resStr;
        console.log(dim(`  ← ${taskId.slice(0, 8)}: ${preview}`));
        return;
      }
      case 'sub_agent_started': {
        const name = content.agentName || 'sub-agent';
        const desc = content.description || '';
        console.log(`${yellow('▸')} sub-agent ${bold(name)}${desc ? ` · ${desc}` : ''}`);
        return;
      }
      case 'sub_agent_completed': {
        const name = content.agentName || 'sub-agent';
        const msg = content.message || '';
        console.log(`${green('✓')} ${msg || `sub-agent ${name} completed`}`);
        return;
      }
      case 'answer_token': {
        const token = content.token || '';
        if (!token) return;
        process.stdout.write(token);
        answerStreamOpen = true;
        return;
      }
      case 'conclusion': {
        // The raw conclusion event may arrive before we're ready to print the
        // framed block — printConclusion() handles the formatted version.
        return;
      }
      case 'error': {
        console.error(red(`✗ ${content.message || 'unknown error'}`));
        return;
      }
      default: {
        if (opts.verbose) console.log(dim(`[event:${type}]`), content);
      }
    }
  }

  function printConclusion(
    conclusion: string,
    meta: { confidence?: number; rounds?: number; durationMs?: number }
  ): void {
    closeAnswerStream();
    const bar = '─'.repeat(Math.min(60, (process.stdout.columns || 80) - 4));
    console.log(`\n${cyan(bar)}`);
    console.log(bold('结论'));
    console.log(cyan(bar));
    console.log(conclusion || dim('(空)'));
    console.log(cyan(bar));
    const bits: string[] = [];
    if (meta.confidence !== undefined) bits.push(`confidence ${(meta.confidence * 100).toFixed(0)}%`);
    if (meta.rounds !== undefined) bits.push(`${meta.rounds} rounds`);
    if (meta.durationMs !== undefined) bits.push(`${Math.round(meta.durationMs / 100) / 10}s`);
    if (bits.length) console.log(dim(bits.join(' · ')));
  }

  function printError(message: string): void {
    closeAnswerStream();
    console.error(red(`\n✗ ${message}`));
  }

  function printCompletion(meta: { reportPath: string; sessionDir: string; sessionId: string }): void {
    closeAnswerStream();
    console.log(`\n${green('✓')} session ${bold(meta.sessionId)}`);
    console.log(`  ${dim('dir:')}    ${meta.sessionDir}`);
    console.log(`  ${dim('report:')} ${meta.reportPath}`);
    console.log(dim(`\n  open ${meta.reportPath}  ·  smp resume ${meta.sessionId}`));
  }

  return { onEvent, printConclusion, printError, printCompletion };
}
