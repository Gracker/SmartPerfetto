// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)

const fs = require('node:fs');
const path = require('node:path');

const cache = new Map();
const OPTIONAL_TRACE_PACKET_EXTENSIONS = [
  {
    fieldNumber: 112,
    path: 'protos/third_party/android/frameworks/native/tracing/winscope/frameworks_native_winscope.proto',
  },
  {
    fieldNumber: 76,
    path: 'protos/third_party/android/frameworks/native/tracing/frameworks_native_trace_packet.proto',
  },
];

const FRAMEWORKS_BASE_TRACING = 'protos/third_party/android/frameworks/base/proto/tracing';
// Perfetto declares StatsdAtom.atom as an empty `Atom` so it does not import
// the statsd schema; trace processor decodes atoms with its bundled
// descriptor. Only these atoms are grafted onto `Atom`, at the field numbers
// that descriptor assigns, so an overlay can never carry an atom the pinned
// trace processor would decode differently.
const STATSD_ATOM_DESCRIPTOR = 'src/trace_processor/importers/proto/atoms.descriptor';
const STATSD_ATOMS = Object.freeze(['appStandbyBucketChanged', 'appFreezeChanged']);

function graftStatsdAtoms(protobuf, root, perfettoRoot) {
  const {FileDescriptorSet} = require('protobufjs/ext/descriptor');
  const atomsRoot = protobuf.Root.fromDescriptor(
    FileDescriptorSet.decode(fs.readFileSync(path.join(perfettoRoot, STATSD_ATOM_DESCRIPTOR))),
  );
  const sourceAtom = atomsRoot.lookupType('android.os.statsd.Atom');
  const targetAtom = root.lookupType('perfetto.protos.Atom');
  const namespace = root.define('android.os.statsd');
  for (const name of STATSD_ATOMS) {
    const field = sourceAtom.fields[name];
    if (!field) throw new Error(`statsd atom descriptor has no Atom.${name}`);
    const type = field.resolve().resolvedType;
    namespace.add(protobuf.Type.fromJSON(type.name, type.toJSON()));
    targetAtom.add(new protobuf.Field(name, field.id, `.android.os.statsd.${type.name}`));
  }
}

function loadTraceType(repoRoot) {
  const normalizedRoot = path.resolve(repoRoot);
  if (cache.has(normalizedRoot)) return cache.get(normalizedRoot);

  const protobuf = require('protobufjs');
  const perfettoRoot = path.join(normalizedRoot, 'perfetto');
  const root = new protobuf.Root();
  root.resolvePath = (origin, target) => {
    if (target === 'google/protobuf/descriptor.proto') {
      return require.resolve('protobufjs/google/protobuf/descriptor.proto');
    }
    if (target.startsWith('protos/')) return path.join(perfettoRoot, target);
    return protobuf.util.path.resolve(origin, target);
  };
  root.loadSync([
    path.join(perfettoRoot, 'protos/perfetto/trace/trace.proto'),
    path.join(perfettoRoot, 'protos/third_party/android/art/heap_graph.proto'),
    path.join(perfettoRoot, 'protos/perfetto/trace/gpu/gpu_interned_data.proto'),
    path.join(perfettoRoot, `${FRAMEWORKS_BASE_TRACING}/frameworks_base_trace_packet.proto`),
    path.join(perfettoRoot, `${FRAMEWORKS_BASE_TRACING}/frameworks_base_track_event.proto`),
  ]);
  graftStatsdAtoms(protobuf, root, perfettoRoot);
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
  return resolveMessageFieldName(repoRoot, 'perfetto.protos.TracePacket', fieldNumber);
}

function resolveMessageFieldName(repoRoot, messageType, fieldNumber) {
  if (!Number.isInteger(fieldNumber) || fieldNumber <= 0) {
    throw new Error(`TracePacket field number must be a positive integer: ${fieldNumber}`);
  }
  const traceType = loadTraceType(repoRoot);
  const tracePacketType = traceType.root.lookupType(messageType);
  const matches = tracePacketType.fieldsArray.filter((field) => field.id === fieldNumber);
  if (matches.length !== 1) {
    throw new Error(
      `Perfetto ${messageType} field ${fieldNumber} resolved to ${matches.length} schema fields; ` +
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
  STATSD_ATOMS,
  collectPacketSequenceIds,
  encodeTrace,
  loadTraceType,
  resolveTracePacketFieldName,
  resolveMessageFieldName,
};
