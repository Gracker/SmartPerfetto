// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from 'node:assert/strict';
import http from 'node:http';
import {once} from 'node:events';
import {runPiTurn, type ChatTool} from '../piSession';

async function main(): Promise<void> {
  const viewerMarker = 'fixture-viewer-track-marker';
  const focus = JSON.stringify({kind: 'area', startNs: '17', endNs: '23',
    trackHints: [{kind: 'track', label: viewerMarker}]});
  const previousViewerMarker = 'fixture-previous-viewer-track-marker';
  let requests = 0;
  let gates = 0;
  let deltas = '';
  const server = http.createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    const request = JSON.parse(body);
    assert.equal(request.messages[0].role, 'system');
    const userMessages = request.messages.filter((message: {role: string}) => message.role === 'user');
    if (requests < 3) {
      assert.deepEqual(request.tools.map((tool: {function: {name: string}}) => tool.function.name), ['read_perfetto_resource']);
      assert.match(request.messages[0].content, /Available standard Skill: perfetto-performance-analysis/);
      assert.match(request.messages[0].content, /A local trace is attached/);
      assert.ok(!request.messages[0].content.includes(viewerMarker));
      assert.ok(!request.messages[0].content.includes(previousViewerMarker));
      assert.ok(userMessages[0].content.includes(previousViewerMarker));
      const currentUser = userMessages.at(-1).content;
      assert.ok(currentUser.some((part: {type: string; text?: string}) =>
        part.type === 'text' && part.text?.includes(focus)));
      assert.ok(!JSON.stringify(currentUser).includes(previousViewerMarker));
    } else {
      assert.equal(request.tools?.length ?? 0, 0);
      assert.match(request.messages[0].content, /The standard Skill bundle is unavailable/);
      assert.match(request.messages[0].content, /No local trace is attached/);
      assert.ok(!body.includes(viewerMarker) && !body.includes(previousViewerMarker));
    }
    assert.ok(!body.includes(process.cwd()) && !body.includes('synthetic-api-key'));
    res.writeHead(200, {'Content-Type': 'text/event-stream'});
    const send = (delta: object, finish_reason: string | null) => res.write('data: ' + JSON.stringify({
      id: 'chat-fixture', object: 'chat.completion.chunk', model: 'fixture', created: 1,
      choices: [{index: 0, delta, finish_reason}],
    }) + '\n\n');
    if (++requests === 2 || requests === 4) {
      if (requests === 2) assert.equal(request.messages.at(-1).content, 'resource-fixture');
      send({role: 'assistant', content: 'final answer'}, null);
      send({}, 'stop');
    } else {
      send({role: 'assistant', tool_calls: [{index: 0, id: 'fixture-call', type: 'function',
        function: {name: 'read_perfetto_resource', arguments: '{}'}}]}, null);
      send({}, 'tool_calls');
    }
    res.end('data: [DONE]\n\n');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const parameters = {type: 'object', properties: {}} as ChatTool['parameters'];
  try {
    const turn = {
      profile: {endpoint: new URL(`http://127.0.0.1:${address.port}/v1`), model: 'fixture', apiKey: 'synthetic-api-key'},
      history: [{user: previousViewerMarker, answer: 'Previous answer.'}],
      skill: {name: 'perfetto-performance-analysis', description: 'Fixture.'},
      traceAttached: true,
      text: `Analyze.\n\nViewer focus (application-supplied JSON data):\n${focus}`,
      signal: new AbortController().signal,
      tools: [{name: 'read_perfetto_resource', label: 'Read resource', description: 'Read resource', parameters,
        execute: async () => ({content: [{type: 'text' as const, text: 'resource-fixture'}], details: {}})}],
      onDelta: (delta: string) => { deltas += delta; },
    };
    assert.equal(await runPiTurn({...turn, canDispatch: async () => { gates++; }}), 'final answer');
    assert.equal(requests, 2);
    assert.equal(gates, 2);
    assert.equal(deltas, 'final answer');

    const cancelled = new AbortController();
    let secondGates = 0;
    await assert.rejects(runPiTurn({...turn, signal: cancelled.signal, canDispatch: async () => {
      if (++secondGates === 2) cancelled.abort('revoked');
    }}));
    assert.equal(requests, 3);
    assert.equal(secondGates, 2);
    assert.equal(await runPiTurn({...turn, traceAttached: false, skill: undefined, tools: [], history: [],
      text: 'Hello.', canDispatch: async () => { gates++; }}), 'final answer');
    assert.equal(requests, 4);
    console.log('transport-ok');
  } finally {
    server.closeAllConnections();
    server.close();
  }
}

void main().catch(err => {
  console.error(err);
  process.exitCode = 1;
});
