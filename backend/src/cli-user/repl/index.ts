// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

/**
 * REPL main loop.
 *
 * Design notes:
 *   - Single long-lived CliAnalyzeService + renderer across turns — the
 *     trace processor shell only starts once.
 *   - Readline is paused during a turn so prompt-echo and event-stream
 *     output don't interleave. We don't need `rl.pause()`'s full contract
 *     (kernel-level buffering) — a boolean guard that drops newline
 *     events is enough.
 *   - Idle Ctrl+C is a two-press exit: first press warns, second (within
 *     1.5s) calls process.exit. While a turn runs, Ctrl+C goes to that turn
 *     (turnInterrupt.ts): after a printed answer the first press ends only
 *     its review and the turn is saved; otherwise it aborts the turn (not
 *     saved) and returns to the prompt; a further press exits with 130.
 *   - Trailing `\` on a line is a continuation marker, so users can paste
 *     multi-line questions without a special /multi mode.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';
import type { CliPaths, SessionPaths } from '../io/paths';
import { sessionPaths } from '../io/paths';
import type { Renderer } from './renderer';
import { CliAnalyzeService } from '../services/cliAnalyzeService';
import { startSession, continueSession } from '../services/turnRunner';
import { loadSession } from '../io/sessionStore';
import { openPath } from '../io/openFile';
import { parseSlashCommand, SLASH_HELP } from './slashCommands';
import type { CliSessionConfig } from '../types';
import { DEFAULT_ANALYSIS_QUERY } from '../constants';
import { assertAnalysisRuntimeReady } from '../services/runtimeGuard';
import { ForwardingInterruptSource, isTurnInterrupted } from '../services/turnInterrupt';

/** Ctrl+C double-press window. Matches common CLI tools (bash, python, Claude Code). */
const CTRL_C_DOUBLE_PRESS_MS = 1500;

export interface ReplContext {
  paths: CliPaths;
  service: CliAnalyzeService;
  renderer: Renderer;
  /** Receives Ctrl+C while a turn runs; created by runRepl. */
  interruptSource?: ForwardingInterruptSource;
}

/**
 * Start the REPL. Resolves when the user exits (via /exit or double Ctrl+C).
 * Caller is responsible for calling `service.shutdown()` afterwards.
 */
export async function runRepl(replCtx: ReplContext, initialResumeId?: string): Promise<void> {
  const ctx: ReplContext = {...replCtx, interruptSource: replCtx.interruptSource ?? new ForwardingInterruptSource()};
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: true,
    // Prevent readline's own "press Ctrl+C to quit" behavior — we own that.
    historySize: 200,
  });

  let currentSession: { sessionId: string; sp: SessionPaths; config: CliSessionConfig } | null = null;
  // turnInProgress is a plain boolean rather than a state machine because Node's
  // event loop guarantees the read-set sequence below is atomic in practice:
  // the rl.on('line') handler sets `turnInProgress = true` synchronously
  // *before* its first await, so any subsequent `line` event queued by readline
  // observes true and exits via the early-return guard. Reviewers have flagged
  // this twice as a possible race — it isn't, given single-threaded JS.
  let turnInProgress = false;
  let lastCtrlC = 0;
  let continuationBuffer = '';

  // If the user passed --resume <id> on the command line, pre-load it so the
  // first prompt already knows about the session.
  if (initialResumeId) {
    const loaded = tryLoadSession(ctx.paths, initialResumeId);
    if (loaded) {
      currentSession = loaded;
      console.log(`(resumed session ${initialResumeId})`);
    } else {
      console.error(`(warn: --resume ${initialResumeId} — no such session)`);
    }
  }

  printBanner(currentSession);

  // Ctrl+C handling. We don't use rl's default 'SIGINT' handler because
  // it exits on first press; we want the two-press convention.
  rl.on('SIGINT', () => {
    // A running turn owns Ctrl+C: review-only stop, full abort, then exit 130.
    if (turnInProgress && ctx.interruptSource?.interrupt()) return;
    const now = Date.now();
    if (now - lastCtrlC < CTRL_C_DOUBLE_PRESS_MS) {
      console.log('\nexiting.');
      rl.close();
      process.exit(130); // 128 + SIGINT
    }
    lastCtrlC = now;
    // Drop any pending continuation in both branches — leaving buffered lines
    // around across a Ctrl+C would splice them onto whatever the user types next,
    // which is always surprising.
    continuationBuffer = '';
    if (turnInProgress) {
      console.log('\n(turn in progress — Ctrl+C again within 1.5s to force-exit)');
    } else {
      console.log('\n(press Ctrl+C again within 1.5s to exit, or /exit)');
      (rl as any).line = '';
      (rl as any).cursor = 0;
      rl.prompt();
    }
  });

  // Main input loop. Readline is push-driven; we wrap the whole thing in a
  // Promise that only resolves when rl closes.
  await new Promise<void>((resolve) => {
    rl.on('close', () => resolve());

    rl.on('line', async (raw) => {
      // Trailing-backslash continuation. Must come before the slash parser —
      // otherwise a multiline /ask body gets truncated at the first newline.
      // A bare `\` on an otherwise empty line is treated as "cancel continuation"
      // so a stuck user can escape without Ctrl+C.
      if (raw.endsWith('\\')) {
        if (raw.trim() === '\\') {
          continuationBuffer = '';
          rl.setPrompt(promptString(currentSession));
          rl.prompt();
          return;
        }
        continuationBuffer += `${raw.slice(0, -1)}\n`;
        rl.setPrompt('... ');
        rl.prompt();
        return;
      }
      const full = continuationBuffer + raw;
      continuationBuffer = '';

      // Guard against re-entrant turn dispatch. Shouldn't happen while rl
      // is fully synchronous, but cheap insurance.
      if (turnInProgress) {
        console.log('(turn in progress — please wait)');
        return;
      }

      const cmd = parseSlashCommand(full);
      try {
        switch (cmd.kind) {
          case 'noop':
            break;
          case 'help':
            console.log(SLASH_HELP);
            break;
          case 'clear':
            // ANSI: clear screen + scrollback + home cursor.
            process.stdout.write('\x1b[2J\x1b[3J\x1b[H');
            break;
          case 'exit':
            rl.close();
            return;
          case 'unknown':
            console.log(`Unknown command: /${cmd.command}. Type /help for the list.`);
            break;
          case 'usage':
            console.log(`Usage: ${cmd.hint}`);
            break;
          case 'focus':
            printFocus(currentSession);
            break;
          case 'report':
            handleReport(currentSession, cmd.open);
            break;
          case 'load':
            turnInProgress = true;
            currentSession = await handleLoad(ctx, cmd.path);
            turnInProgress = false;
            break;
          case 'ask':
            if (!currentSession) {
              console.log('(no session — /load <trace> or /resume <id> first)');
              break;
            }
            turnInProgress = true;
            currentSession = await handleAsk(ctx, currentSession, cmd.query);
            turnInProgress = false;
            break;
          case 'resume':
            turnInProgress = true;
            currentSession = await handleResume(ctx, cmd.sessionId);
            turnInProgress = false;
            break;
        }
      } catch (err) {
        turnInProgress = false;
        if (isTurnInterrupted(err)) console.log(`\n(${(err as Error).message})`);
        else ctx.renderer.printError((err as Error).message);
      }

      rl.setPrompt(promptString(currentSession));
      rl.prompt();
    });

    rl.setPrompt(promptString(currentSession));
    rl.prompt();
  });
}

/** What the user sees before each line of input. Short, honest about session state. */
function promptString(cs: { sessionId: string } | null): string {
  if (!cs) return 'smartperfetto › ';
  // Show the short form — full id is available via /focus.
  return `smartperfetto [${cs.sessionId.slice(-6)}] › `;
}

function printBanner(cs: { sessionId: string } | null): void {
  console.log('SmartPerfetto REPL — type /help for commands, /exit (or Ctrl+C twice) to quit.');
  if (!cs) console.log('No session loaded yet. Use /load <trace-path> to begin.');
}

function printFocus(cs: { sessionId: string; config: CliSessionConfig; sp: SessionPaths } | null): void {
  if (!cs) {
    console.log('(no session)');
    return;
  }
  console.log(`session   ${cs.sessionId}`);
  console.log(`trace     ${cs.config.tracePath}`);
  console.log(`turns     ${cs.config.turnCount}`);
  console.log(`updated   ${new Date(cs.config.lastTurnAt).toISOString()}`);
  console.log(`folder    ${cs.sp.dir}`);
}

function handleReport(
  cs: { sp: SessionPaths } | null,
  open: boolean,
): void {
  if (!cs) {
    console.log('(no session)');
    return;
  }
  if (!fs.existsSync(cs.sp.report)) {
    console.log('(no report.html yet — ask a question first)');
    return;
  }
  console.log(cs.sp.report);
  if (open) {
    const r = openPath(cs.sp.report);
    if (!r.ok) console.error(`(open failed: ${r.reason})`);
  }
}

type LoadedSession = { sessionId: string; sp: SessionPaths; config: CliSessionConfig };

function tryLoadSession(paths: CliPaths, sessionId: string): LoadedSession | null {
  const sp = sessionPaths(paths, sessionId);
  const { config } = loadSession(paths, sessionId);
  if (!config) return null;
  return { sessionId, sp, config };
}

async function handleLoad(ctx: ReplContext, tracePath: string): Promise<LoadedSession> {
  // /load kicks off the first turn with the generic catch-all query; the user
  // can follow up with a targeted /ask for real drilling.
  assertAnalysisRuntimeReady({ aiFeature: 'agent_analyze' });
  const expanded = expandPath(tracePath);
  const r = await startSession(ctx, { tracePath: expanded, query: DEFAULT_ANALYSIS_QUERY });
  return refreshSession(ctx, r.sessionId);
}

async function handleAsk(
  ctx: ReplContext,
  cs: LoadedSession,
  query: string,
): Promise<LoadedSession> {
  assertAnalysisRuntimeReady({
    providerId: cs.config.providerId,
    runtimeOverride: cs.config.agentRuntimeKind,
    aiFeature: 'agent_resume',
  });
  await continueSession(ctx, { sessionId: cs.sessionId, query });
  return refreshSession(ctx, cs.sessionId);
}

async function handleResume(ctx: ReplContext, sessionId: string): Promise<LoadedSession | null> {
  const loaded = tryLoadSession(ctx.paths, sessionId);
  if (!loaded) {
    console.error(`no session found at ${sessionPaths(ctx.paths, sessionId).dir}`);
    return null;
  }
  console.log(`(switched to session ${sessionId}, turn ${loaded.config.turnCount})`);
  return loaded;
}

function refreshSession(ctx: ReplContext, sessionId: string): LoadedSession {
  // Re-read config from disk — turnCount/lastTurnAt/sdkSessionId just changed.
  const reloaded = tryLoadSession(ctx.paths, sessionId);
  if (!reloaded) {
    throw new Error(`internal: session ${sessionId} missing after turn commit`);
  }
  return reloaded;
}

/** Expand leading `~` and resolve to absolute. Paths with spaces survive. */
function expandPath(p: string): string {
  if (p.startsWith('~/')) {
    return path.join(process.env.HOME || '', p.slice(2));
  }
  return path.resolve(p);
}
