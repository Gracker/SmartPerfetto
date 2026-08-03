// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)

const fs = require('node:fs');
const path = require('node:path');

const cache = new Map();
const OPTIONAL_TRACE_PACKET_EXTENSIONS = [
  {
    fieldNumber: 76,
    path: 'protos/third_party/android/frameworks/native/tracing/frameworks_native_trace_packet.proto',
  },
];

function loadTraceType(repoRoot) {
  const normalizedRoot = path.resolve(repoRoot);
  if (cache.has(normalizedRoot)) return cache.get(normalizedRoot);

  const protobuf = require('protobufjs');
  const perfettoRoot = path.join(normalizedRoot, 'perfetto');
  const root = new protobuf.Root();
  root.resolvePath = (origin, target) => {
    if (target.startsWith('protos/')) return path.join(perfettoRoot, target);
    return protobuf.util.path.resolve(origin, target);
  };
  root.loadSync([
    path.join(perfettoRoot, 'protos/perfetto/trace/trace.proto'),
    path.join(perfettoRoot, 'protos/third_party/android/art/heap_graph.proto'),
    path.join(perfettoRoot, 'protos/perfetto/trace/gpu/gpu_interned_data.proto'),
  ]);
  const tracePacketType = root.lookupType('perfetto.protos.TracePacket');
  for (const extension of OPTIONAL_TRACE_PACKET_EXTENSIONS) {
    if (tracePacketType.fieldsArray.some((field) => field.id === extension.fieldNumber)) continue;
    const extensionPath = path.join(perfettoRoot, extension.path);
    if (fs.existsSync(extensionPath)) root.loadSync(extensionPath);
  }
  root.resolveAll();
  const traceType = root.lookupType('perfetto.protos.Trace');
  cache.set(normalizedRoot, traceType);
  return traceType;
}

function resolveTracePacketFieldName(repoRoot, fieldNumber) {
  if (!Number.isInteger(fieldNumber) || fieldNumber <= 0) {
    throw new Error(`TracePacket field number must be a positive integer: ${fieldNumber}`);
  }
  const traceType = loadTraceType(repoRoot);
  const tracePacketType = traceType.root.lookupType('perfetto.protos.TracePacket');
  const matches = tracePacketType.fieldsArray.filter((field) => field.id === fieldNumber);
  if (matches.length !== 1) {
    throw new Error(
      `Perfetto TracePacket field ${fieldNumber} resolved to ${matches.length} schema fields; ` +
      'load the required core or extension proto before encoding',
    );
  }
  return matches[0].name;
}

function encodeTrace(repoRoot, packets) {
  const traceType = loadTraceType(repoRoot);
  const message = traceType.fromObject({packet: packets});
  const validationError = traceType.verify(message);
  if (validationError) throw new Error(`Invalid Perfetto Trace protobuf: ${validationError}`);
  return Buffer.from(traceType.encode(message).finish());
}

function collectPacketSequenceIds(repoRoot, traceBuffer) {
  const traceType = loadTraceType(repoRoot);
  const trace = traceType.decode(traceBuffer);
  return new Set(
    trace.packet
      .map((packet) => packet.trustedPacketSequenceId)
      .filter((value) => Number.isInteger(value) && value > 0),
  );
}

module.exports = {
  collectPacketSequenceIds,
  encodeTrace,
  loadTraceType,
  resolveTracePacketFieldName,
};
