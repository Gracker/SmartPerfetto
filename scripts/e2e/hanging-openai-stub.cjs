// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

'use strict';

const fs = require('fs');
const http = require('http');

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function appendLog(logPath, entry) {
  const timestamp = new Date().toISOString();
  fs.appendFileSync(logPath, `${JSON.stringify({timestamp, ...entry})}\n`);
}

async function readJsonRequest(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 64 * 1024 * 1024) throw new Error('Provider request body exceeds 64 MiB');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function classifyRequest(body) {
  // The native intent transport streams too, but deliberately has no tools.
  // Analysis always carries the tool array, including when it is empty.
  return body?.tools === undefined ? 'classification' : 'analysis';
}

function validateRequest(request, body, apiKey, kind) {
  const errors = [];
  const model = typeof body?.model === 'string' ? body.model : undefined;
  const stream = body?.stream === true;
  const toolsValid = Array.isArray(body?.tools);
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    errors.push('body must be an object');
  }
  if (!model) errors.push('model must be a non-empty string');
  if (kind === 'analysis') {
    if (!stream) errors.push('analysis must stream');
    if (body?.stream_options?.include_usage !== true) {
      errors.push('stream_options.include_usage must be true');
    }
    if (body?.parallel_tool_calls !== false) errors.push('parallel_tool_calls must be false');
    if (!toolsValid) errors.push('tools must be an array');
  } else {
    if (body?.temperature !== 0) errors.push('classification temperature must be zero');
    if (toolsValid) errors.push('classification must not send tools');
  }
  if (!Array.isArray(body?.messages)) errors.push('messages must be an array');
  if (request.headers.authorization !== `Bearer ${apiKey}`) {
    errors.push('authorization must use the local E2E bearer token');
  }
  return {errors, model, stream, toolCount: toolsValid ? body.tools.length : 0};
}

async function startHangingOpenAIStub(logPath, apiKey) {
  const sockets = new Set();
  const requests = [];
  let opened = 0;
  let closed = 0;
  let active = 0;

  const snapshot = () => ({
    opened,
    closed,
    active,
    requests: requests.map((request) => ({...request})),
  });

  const server = http.createServer(async (request, response) => {
    const requestUrl = new URL(request.url || '/', 'http://127.0.0.1');
    if (request.method === 'GET' && requestUrl.pathname === '/__state') {
      response.writeHead(200, {'Content-Type': 'application/json', 'Cache-Control': 'no-store'});
      response.end(JSON.stringify(snapshot()));
      return;
    }
    if (request.method !== 'POST' || requestUrl.pathname !== '/v1/chat/completions') {
      response.writeHead(404, {'Content-Type': 'application/json'});
      response.end(JSON.stringify({error: 'Not found'}));
      return;
    }

    const id = `provider-${opened + 1}`;
    let body;
    try {
      body = await readJsonRequest(request);
    } catch (error) {
      appendLog(logPath, {id, event: 'invalid_json', error: error.message});
      response.writeHead(400, {'Content-Type': 'application/json'});
      response.end(JSON.stringify({error: 'Invalid JSON request'}));
      return;
    }

    const kind = classifyRequest(body);
    const validation = validateRequest(request, body, apiKey, kind);
    const record = {
      id,
      kind,
      path: requestUrl.pathname,
      ...(validation.model ? {model: validation.model} : {}),
      stream: validation.stream,
      toolCount: validation.toolCount,
      openedAt: new Date().toISOString(),
      closedAt: null,
      validationErrors: validation.errors,
    };
    requests.push(record);
    opened += 1;
    appendLog(logPath, {
      id,
      event: validation.errors.length === 0 ? 'opened' : 'rejected',
      model: validation.model,
      stream: validation.stream,
      toolCount: validation.toolCount,
      validationErrors: validation.errors,
    });

    if (validation.errors.length > 0) {
      record.closedAt = new Date().toISOString();
      closed += 1;
      response.writeHead(400, {'Content-Type': 'application/json'});
      response.end(JSON.stringify({error: 'Unexpected OpenAI-compatible request shape'}));
      return;
    }

    if (kind === 'classification') {
      const decision = JSON.stringify({
        schemaVersion: 1,
        taskKind: 'comparison',
        sceneId: 'startup',
        scope: 'scene_wide',
        recommendedComplexity: 'full',
        deliverable: 'report',
        evidenceAccess: 'read_new',
        reason: 'E2E exercises the full dual-trace workflow',
      });
      record.closedAt = new Date().toISOString();
      closed += 1;
      if (validation.stream) {
        response.writeHead(200, {'Content-Type': 'text/event-stream'});
        const chunk = (delta, finish_reason) => `data: ${JSON.stringify({
          id, model: validation.model,
          choices: [{index: 0, delta, finish_reason}],
        })}\n\n`;
        response.end(chunk({role: 'assistant', content: decision}, null)
          + chunk({}, 'stop') + 'data: [DONE]\n\n');
      } else {
        response.writeHead(200, {'Content-Type': 'application/json'});
        response.end(JSON.stringify({choices: [{
          message: {role: 'assistant', content: decision}, finish_reason: 'stop',
        }]}));
      }
      appendLog(logPath, {id, event: 'classification_completed'});
      return;
    }

    active += 1;
    response.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    response.flushHeaders();
    let closeRecorded = false;
    response.on('close', () => {
      if (closeRecorded) return;
      closeRecorded = true;
      record.closedAt = new Date().toISOString();
      active = Math.max(0, active - 1);
      closed += 1;
      appendLog(logPath, {
        id,
        event: 'closed',
        writableEnded: response.writableEnded,
        destroyed: response.destroyed,
      });
    });
  });

  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  const port = await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('Unable to bind the local OpenAI stub'));
        return;
      }
      resolve(address.port);
    });
  });
  appendLog(logPath, {event: 'listening', port});

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    snapshot,
    async close() {
      for (const socket of sockets) socket.destroy();
      await Promise.race([new Promise((resolve) => server.close(resolve)), delay(2_000)]);
      appendLog(logPath, {event: 'stopped', state: snapshot()});
    },
  };
}

module.exports = {startHangingOpenAIStub};
