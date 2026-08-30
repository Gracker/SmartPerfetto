#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

'use strict';

const net = require('net');
const readline = require('readline');

const RPC_ERROR_CODES = {
  PARSE_ERROR: -32700,
  INTERNAL_ERROR: -32603,
};

const port = Number.parseInt(process.env.SMARTPERFETTO_OPENCODE_BRIDGE_PORT || '', 10);
const token = process.env.SMARTPERFETTO_OPENCODE_BRIDGE_TOKEN || '';
const DEFAULT_REQUEST_TIMEOUT_MS = 5_000;
const MIN_REQUEST_TIMEOUT_MS = 100;
const MAX_REQUEST_TIMEOUT_MS = 300_000;

function resolveRequestTimeoutMs(value) {
  if (typeof value !== 'string' || !/^(?:0|[1-9]\d*)$/.test(value)) {
    return DEFAULT_REQUEST_TIMEOUT_MS;
  }
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) &&
    parsed >= MIN_REQUEST_TIMEOUT_MS &&
    parsed <= MAX_REQUEST_TIMEOUT_MS
    ? parsed
    : DEFAULT_REQUEST_TIMEOUT_MS;
}

const requestTimeoutMs = resolveRequestTimeoutMs(
  process.env.SMARTPERFETTO_OPENCODE_BRIDGE_TIMEOUT_MS,
);

function rpcError(id, code, message) {
  return {jsonrpc: '2.0', id, error: {code, message}};
}

function forwardToParent(request) {
  if (!Number.isFinite(port) || port <= 0 || !token) {
    return Promise.resolve(rpcError(
      request.id ?? null,
      RPC_ERROR_CODES.INTERNAL_ERROR,
      'OpenCode SmartPerfetto MCP bridge is not configured',
    ));
  }

  return new Promise((resolve) => {
    const socket = net.createConnection({host: '127.0.0.1', port});
    let buffer = '';
    let settled = false;
    const finish = (response) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(response);
    };

    socket.setEncoding('utf-8');
    socket.setTimeout(requestTimeoutMs, () => {
      finish(rpcError(
        request.id ?? null,
        RPC_ERROR_CODES.INTERNAL_ERROR,
        'OpenCode SmartPerfetto MCP bridge request timed out',
      ));
    });
    socket.on('connect', () => {
      socket.write(`${JSON.stringify({token, request})}\n`);
    });
    socket.on('data', (chunk) => {
      buffer += chunk;
      const newline = buffer.indexOf('\n');
      if (newline < 0) return;
      try {
        finish(JSON.parse(buffer.slice(0, newline)));
      } catch {
        finish(rpcError(
          request.id ?? null,
          RPC_ERROR_CODES.PARSE_ERROR,
          'OpenCode SmartPerfetto MCP bridge returned invalid JSON',
        ));
      }
    });
    socket.on('error', (error) => {
      finish(rpcError(
        request.id ?? null,
        RPC_ERROR_CODES.INTERNAL_ERROR,
        `OpenCode SmartPerfetto MCP bridge connection failed: ${error.message}`,
      ));
    });
    socket.on('end', () => {
      if (!settled) {
        finish(rpcError(
          request.id ?? null,
          RPC_ERROR_CODES.INTERNAL_ERROR,
          'OpenCode SmartPerfetto MCP bridge closed without a response',
        ));
      }
    });
  });
}

async function main() {
  const lines = readline.createInterface({input: process.stdin, crlfDelay: Infinity});
  for await (const line of lines) {
    if (!line.trim()) continue;
    let request;
    try {
      request = JSON.parse(line);
    } catch {
      process.stdout.write(`${JSON.stringify(rpcError(
        null,
        RPC_ERROR_CODES.PARSE_ERROR,
        'Invalid JSON',
      ))}\n`);
      continue;
    }
    if (request.id === undefined) continue;
    const response = await forwardToParent(request);
    process.stdout.write(`${JSON.stringify(response)}\n`);
  }
}

void main().catch((error) => {
  process.stdout.write(`${JSON.stringify(rpcError(
    null,
    RPC_ERROR_CODES.INTERNAL_ERROR,
    error instanceof Error ? error.message : String(error),
  ))}\n`);
});
