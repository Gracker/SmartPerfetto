// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)

const fs = require('node:fs');
const path = require('node:path');
const {spawnSync} = require('node:child_process');
const {randomUUID} = require('node:crypto');

const {
  STATSD_ATOMS,
  collectPacketSequenceIds,
  encodeTrace,
  resolveTracePacketFieldName,
  resolveMessageFieldName,
  loadTraceType,
} = require('./perfetto-proto.cjs');
const {sha256Buffer} = require('./hash.cjs');
// Proto field names in JS form, as protobufjs names the loaded fields.
const {camelCase} = require('protobufjs').util;

const FIRST_SYNTHETIC_PID = 700000;
// uid of a process actor that does not declare one.
const DEFAULT_APP_UID = 10999;
const PROCESS_STATE_ENUM = 'com.android.internal.ProcessStateEnum';
const HEAP_GRAPH_EXTENSION = '.com.android.art.tracing.ArtHeapGraphTracePacket.heapGraph';
const HEAP_GRAPH_LIMITS = Object.freeze({types: 5000, objects: 10000, roots: 1000, references: 50000});
const GPU_COMPUTE_KERNELS_EXTENSION = '.perfetto.protos.GpuInternedData.computeKernels';
const GPU_COMPUTE_ARG_NAMES_EXTENSION = '.perfetto.protos.GpuInternedData.computeArgNames';
const GPU_COMPUTE_MAX_ARGS = 64;
const FRAME_TIMELINE_TRACE_PACKET_FIELD_NUMBER = 76;
const PROCESS_STATE_SNAPSHOT_EXTENSION = '.com.android.internal.FrameworksBaseTracePacket.androidProcessState';
const PROCESS_STATE_CHANGED_EXTENSION = '.com.android.internal.FrameworksBaseTrackEvent.processStateChangedEvent';
// BatteryStats history events that trace processor turns into
// android_battery_stats_event_slices; `longwake` backs android_app_wakelocks.
const BATTERY_STATS_EVENTS = new Set(['longwake']);
// Name tokens that resolve to an allocated synthetic pid or tid, for framework
// slices that embed one in their name (`Freeze <process>:<pid>`,
// `monitor contention with owner <thread> (<tid>) ...`).
const ACTOR_ID_TOKEN = /\{(pid|tid):([^}]*)\}/g;
const SUPPORTED_SIGNAL_TYPES = new Set([
  'atrace-slice', 'atrace-counter', 'atrace-async-slice', 'atrace-async-track-slice',
  'sched-running', 'sched-switch', 'sched-waking', 'process-stats', 'battery-counters', 'power-rail',
  'gpu-work-period', 'gpu-compute-kernel', 'gpu-frequency', 'gpu-power-state',
  'cpu-frequency', 'cpu-frequency-limits', 'cpu-idle', 'thermal-temperature', 'cdev-update',
  'irq-span', 'frame-timeline', 'lmk-kill',
  'managed-heap-graph', 'anr-event', 'perf-sample', 'android-log',
  'atrace-track-instant', 'android-input-motion', 'android-input-dispatch',
  'statsd-atom', 'battery-stats-span', 'android-process-state-snapshot', 'android-process-state-change',
]);
// Signals that name a CPU twice: once as the ftrace stream (`cpu`) and once as
// the payload identity (`cpu_id`). Both must be isolated together so an overlay
// never rewrites a real CPU's counters in the base trace.
const CPU_ID_SIGNAL_TYPES = new Set(['cpu-frequency', 'cpu-frequency-limits', 'cpu-idle']);
const ANDROID_LOG_IDS = new Map([
  ['MAIN', 'LID_MAIN'],
  ['RADIO', 'LID_RADIO'],
  ['EVENTS', 'LID_EVENTS'],
  ['SYSTEM', 'LID_SYSTEM'],
  ['CRASH', 'LID_CRASH'],
]);
const ANDROID_LOG_PRIORITIES = new Map([
  ['VERBOSE', 'PRIO_VERBOSE'],
  ['DEBUG', 'PRIO_DEBUG'],
  ['INFO', 'PRIO_INFO'],
  ['WARN', 'PRIO_WARN'],
  ['ERROR', 'PRIO_ERROR'],
  ['FATAL', 'PRIO_FATAL'],
]);
const HEAP_ROOT_TYPES = new Set([
  'ROOT_UNKNOWN',
  'ROOT_JNI_GLOBAL',
  'ROOT_JNI_LOCAL',
  'ROOT_JAVA_FRAME',
  'ROOT_NATIVE_STACK',
  'ROOT_STICKY_CLASS',
  'ROOT_THREAD_BLOCK',
  'ROOT_MONITOR_USED',
  'ROOT_THREAD_OBJECT',
  'ROOT_INTERNED_STRING',
  'ROOT_FINALIZING',
  'ROOT_DEBUGGER',
  'ROOT_REFERENCE_CLEANUP',
  'ROOT_VM_INTERNAL',
  'ROOT_JNI_MONITOR',
]);
const END_STATES = new Map([
  ['R', '0'],
  ['S', '1'],
  ['D', '2'],
]);

function decimalString(value, field) {
  if (typeof value !== 'string' || !/^[0-9]+$/.test(value)) {
    throw new Error(`${field} must be an unsigned decimal string`);
  }
  return value;
}

function signedDecimalString(value, field) {
  if (typeof value !== 'string' || !/^-?[0-9]+$/.test(value)) {
    throw new Error(`${field} must be a signed decimal string`);
  }
  return value;
}

function finiteNumber(value, field) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`${field} must be a finite number`);
  }
  return value;
}

function nonNegativeInteger(value, field) {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${field} must be a non-negative integer`);
  }
  return value;
}

function positiveSafeInteger(value, field) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${field} must be a positive safe integer`);
  }
  return value;
}

function nonNegativeSafeInteger(value, field) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${field} must be a non-negative safe integer`);
  }
  return value;
}

function nonNegativeInt64String(value, field) {
  const validated = decimalString(value, field);
  if (BigInt(validated) > 9223372036854775807n) {
    throw new Error(`${field} must fit in a signed 64-bit integer`);
  }
  return validated;
}

function positiveUint64String(value, field) {
  const validated = decimalString(value, field);
  const numeric = BigInt(validated);
  if (numeric === 0n || numeric > 18446744073709551615n) {
    throw new Error(`${field} must be a positive unsigned 64-bit integer`);
  }
  return validated;
}

function positiveUint32(value, field) {
  if (!Number.isSafeInteger(value) || value <= 0 || value > 4294967295) {
    throw new Error(`${field} must be a positive unsigned 32-bit integer`);
  }
  return value;
}

function nonEmptyString(value, field) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${field} must be a non-empty string`);
  }
  return value;
}

function allocatePid(usedPids) {
  let candidate = FIRST_SYNTHETIC_PID;
  while (usedPids.has(candidate)) candidate += 1;
  usedPids.add(candidate);
  return candidate;
}

function validateScenario(scenario) {
  if (!scenario || scenario.schema_version !== 1) {
    throw new Error('scenario.schema_version must be 1');
  }
  const clockDuration = BigInt(decimalString(
    scenario.clock?.duration_ns,
    'scenario.clock.duration_ns',
  ));
  if (!Array.isArray(scenario.actors?.processes) || !Array.isArray(scenario.actors?.threads)) {
    throw new Error('scenario.actors.processes and threads must be arrays');
  }
  if (!Array.isArray(scenario.signals)) throw new Error('scenario.signals must be an array');
  for (const [index, signal] of scenario.signals.entries()) {
    nonEmptyString(signal.type, `scenario.signals[${index}].type`);
    if (!SUPPORTED_SIGNAL_TYPES.has(signal.type)) {
      throw new Error(`scenario.signals[${index}].type is unsupported: ${signal.type}`);
    }
    const at = BigInt(decimalString(signal.at_ns, `scenario.signals[${index}].at_ns`));
    if (at > clockDuration) {
      throw new Error(`scenario.signals[${index}].at_ns exceeds scenario.clock.duration_ns`);
    }
    if (signal.duration_ns !== undefined) {
      const duration = BigInt(decimalString(
        signal.duration_ns,
        `scenario.signals[${index}].duration_ns`,
      ));
      if (at + duration > clockDuration) {
        throw new Error(`scenario.signals[${index}] ends after scenario.clock.duration_ns`);
      }
    }
    if (signal.type === 'perf-sample') {
      const sampleCount = positiveSafeInteger(
        signal.sample_count,
        `scenario.signals[${index}].sample_count`,
      );
      if (sampleCount > 1000) {
        throw new Error(`scenario.signals[${index}].sample_count must not exceed 1000`);
      }
      const interval = BigInt(positiveUint64String(
        signal.sample_interval_ns,
        `scenario.signals[${index}].sample_interval_ns`,
      ));
      if (at + interval * BigInt(sampleCount - 1) > clockDuration) {
        throw new Error(`scenario.signals[${index}] perf samples end after scenario.clock.duration_ns`);
      }
    }
  }
}

function buildIdentities(scenario, usedPids) {
  const processes = {};
  const threads = {};
  const processDefinitions = new Map();
  const threadDefinitions = new Map();

  for (const actor of scenario.actors.processes) {
    const id = nonEmptyString(actor.id, 'process.id');
    if (processDefinitions.has(id)) throw new Error(`duplicate process actor: ${id}`);
    const pid = allocatePid(usedPids);
    processes[id] = pid;
    processDefinitions.set(id, {...actor, pid, uid: actor.uid ?? DEFAULT_APP_UID});
  }
  for (const actor of scenario.actors.threads) {
    const id = nonEmptyString(actor.id, 'thread.id');
    if (threadDefinitions.has(id)) throw new Error(`duplicate thread actor: ${id}`);
    const process = processDefinitions.get(actor.process);
    if (!process) throw new Error(`thread ${id} references unknown process ${actor.process}`);
    const existingMain = [...threadDefinitions.values()].some(
      (thread) => thread.tgid === process.pid && thread.tid === process.pid,
    );
    if (actor.is_main && existingMain) throw new Error(`process ${actor.process} has multiple main threads`);
    const tid = actor.is_main ? process.pid : allocatePid(usedPids);
    threads[id] = tid;
    threadDefinitions.set(id, {...actor, tid, tgid: process.pid});
  }
  return {processes, threads, processDefinitions, threadDefinitions};
}

function absoluteTimestamp(anchor, relative, field) {
  return (BigInt(anchor) + BigInt(decimalString(relative, field))).toString();
}

function actorForSignal(signal, identities) {
  const process = identities.processDefinitions.get(signal.process);
  const thread = identities.threadDefinitions.get(signal.thread);
  if (!thread) throw new Error(`signal references unknown thread ${signal.thread}`);
  const resolvedProcess = process ?? [...identities.processDefinitions.values()].find((item) => item.pid === thread.tgid);
  if (!resolvedProcess) throw new Error(`signal references unknown process ${signal.process}`);
  if (thread.tgid !== resolvedProcess.pid) {
    throw new Error(`thread ${signal.thread} does not belong to process ${signal.process}`);
  }
  return {process: resolvedProcess, thread};
}

function validateManagedHeapGraph(signal, process) {
  if (!Array.isArray(signal.types) || signal.types.length === 0 || signal.types.length > HEAP_GRAPH_LIMITS.types) {
    throw new Error(`managed-heap-graph types must contain 1-${HEAP_GRAPH_LIMITS.types} entries`);
  }
  if (!Array.isArray(signal.objects) || signal.objects.length === 0 || signal.objects.length > HEAP_GRAPH_LIMITS.objects) {
    throw new Error(`managed-heap-graph objects must contain 1-${HEAP_GRAPH_LIMITS.objects} entries`);
  }
  if (!Array.isArray(signal.roots) || signal.roots.length === 0 || signal.roots.length > HEAP_GRAPH_LIMITS.roots) {
    throw new Error(`managed-heap-graph roots must contain 1-${HEAP_GRAPH_LIMITS.roots} entries`);
  }

  const typeIds = new Set();
  const typeNames = new Map();
  const types = signal.types.map((type, index) => {
    const id = positiveSafeInteger(type.id, `managed-heap-graph types[${index}].id`);
    if (typeIds.has(id)) throw new Error(`managed-heap-graph duplicate type id: ${id}`);
    typeIds.add(id);
    const className = nonEmptyString(type.class_name, `managed-heap-graph types[${index}].class_name`);
    typeNames.set(id, className);
    return {
      id,
      className,
      objectSize: nonNegativeSafeInteger(type.object_size, `managed-heap-graph types[${index}].object_size`),
    };
  });

  const objectIds = new Set();
  for (const [index, object] of signal.objects.entries()) {
    const id = positiveSafeInteger(object.id, `managed-heap-graph objects[${index}].id`);
    if (objectIds.has(id)) throw new Error(`managed-heap-graph duplicate object id: ${id}`);
    objectIds.add(id);
  }
  let referenceCount = 0;
  const fieldNames = [];
  const objects = signal.objects.map((object, index) => {
    const typeId = positiveSafeInteger(object.type_id, `managed-heap-graph objects[${index}].type_id`);
    if (!typeIds.has(typeId)) {
      throw new Error(`managed-heap-graph object ${object.id} references unknown type ${typeId}`);
    }
    if (!Array.isArray(object.reference_object_ids)) {
      throw new Error(`managed-heap-graph objects[${index}].reference_object_ids must be an array`);
    }
    referenceCount += object.reference_object_ids.length;
    if (referenceCount > HEAP_GRAPH_LIMITS.references) {
      throw new Error(`managed-heap-graph references exceed ${HEAP_GRAPH_LIMITS.references}`);
    }
    const referenceFieldId = [];
    const referenceObjectId = object.reference_object_ids.map((referenceId, referenceIndex) => {
      const id = positiveSafeInteger(
        referenceId,
        `managed-heap-graph objects[${index}].reference_object_ids[${referenceIndex}]`,
      );
      if (!objectIds.has(id)) {
        throw new Error(`managed-heap-graph object ${object.id} references unknown object ${id}`);
      }
      const fieldId = fieldNames.length + 1;
      referenceFieldId.push(fieldId);
      fieldNames.push({
        iid: fieldId,
        str: Buffer.from(`${typeNames.get(typeId)}.syntheticRef${referenceIndex + 1}`),
      });
      return id;
    });
    return {
      id: object.id,
      typeId,
      selfSize: nonNegativeSafeInteger(object.self_size, `managed-heap-graph objects[${index}].self_size`),
      referenceFieldId,
      referenceObjectId,
    };
  });

  const roots = signal.roots.map((root, index) => {
    if (!HEAP_ROOT_TYPES.has(root.root_type)) {
      throw new Error(`managed-heap-graph roots[${index}].root_type is invalid`);
    }
    if (!Array.isArray(root.object_ids) || root.object_ids.length === 0) {
      throw new Error(`managed-heap-graph roots[${index}].object_ids must be a non-empty array`);
    }
    referenceCount += root.object_ids.length;
    if (referenceCount > HEAP_GRAPH_LIMITS.references) {
      throw new Error(`managed-heap-graph references exceed ${HEAP_GRAPH_LIMITS.references}`);
    }
    const objectIdsForRoot = root.object_ids.map((objectId, objectIndex) => {
      const id = positiveSafeInteger(
        objectId,
        `managed-heap-graph roots[${index}].object_ids[${objectIndex}]`,
      );
      if (!objectIds.has(id)) throw new Error(`managed-heap-graph root references unknown object ${id}`);
      return id;
    });
    return {rootType: root.root_type, objectIds: objectIdsForRoot};
  });

  return {
    pid: process.pid,
    heapBytesAllocated: nonNegativeInt64String(
      signal.heap_bytes_allocated,
      'managed-heap-graph heap_bytes_allocated',
    ),
    types,
    objects,
    roots,
    fieldNames,
    continued: false,
    index: 0,
  };
}

function validateGpuComputeKernel(signal, process, signalIndex) {
  const gpuId = nonNegativeInteger(signal.gpu_id, 'gpu-compute-kernel gpu_id');
  if (gpuId > 2147483647) throw new Error('gpu-compute-kernel gpu_id must fit in a signed 32-bit integer');
  const context = positiveUint64String(signal.context, 'gpu-compute-kernel context');
  const duration = positiveUint64String(signal.duration_ns, 'gpu-compute-kernel duration_ns');
  const kernel = nonEmptyString(signal.kernel, 'gpu-compute-kernel kernel');
  const demangledKernel = nonEmptyString(
    signal.demangled_kernel,
    'gpu-compute-kernel demangled_kernel',
  );
  const arch = nonEmptyString(signal.arch, 'gpu-compute-kernel arch');

  function dimensions(value, field) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error(`${field} must be an object`);
    }
    return {
      x: positiveUint32(value.x, `${field}.x`),
      y: positiveUint32(value.y, `${field}.y`),
      z: positiveUint32(value.z, `${field}.z`),
    };
  }

  if (!signal.args || typeof signal.args !== 'object' || Array.isArray(signal.args)) {
    throw new Error('gpu-compute-kernel args must be an object');
  }
  const sortedArgs = Object.entries(signal.args).sort(([left], [right]) =>
    left < right ? -1 : left > right ? 1 : 0);
  if (sortedArgs.length > GPU_COMPUTE_MAX_ARGS) {
    throw new Error(`gpu-compute-kernel args exceed ${GPU_COMPUTE_MAX_ARGS}`);
  }

  const iidBase = (signalIndex + 1) * 1000;
  const computeArgNames = [];
  const args = sortedArgs.map(([name, value], index) => {
    const validatedName = nonEmptyString(name, `gpu-compute-kernel args[${index}].name`);
    const validatedValue = nonNegativeSafeInteger(value, `gpu-compute-kernel args.${validatedName}`);
    const nameIid = iidBase + 100 + index;
    computeArgNames.push({iid: nameIid, name: validatedName});
    return {nameIid, uintValue: validatedValue};
  });

  return {
    gpuId,
    context,
    duration,
    queueIid: iidBase + 1,
    stageIid: iidBase + 2,
    kernelIid: iidBase + 3,
    eventId: iidBase + 4,
    graphicsContext: {iid: context, pid: process.pid, api: 'OPEN_CL'},
    queueSpecification: {
      iid: iidBase + 1,
      name: 'Synthetic Compute Queue',
      description: 'Deterministic SmartPerfetto compute queue',
      category: 'OTHER',
    },
    stageSpecification: {
      iid: iidBase + 2,
      name: 'Compute',
      description: 'Vendor-neutral compute stage',
      category: 'COMPUTE',
    },
    computeKernel: {
      iid: iidBase + 3,
      name: kernel,
      demangledName: demangledKernel,
      arch,
    },
    computeArgNames,
    launch: {
      gridSize: dimensions(signal.grid, 'gpu-compute-kernel grid'),
      workgroupSize: dimensions(signal.workgroup, 'gpu-compute-kernel workgroup'),
      args,
    },
  };
}

function int32(value, field) {
  if (!Number.isInteger(value) || value < -2147483648 || value > 2147483647) {
    throw new Error(`${field} must be a signed 32-bit integer`);
  }
  return value;
}

function uint32(value, field) {
  if (!Number.isInteger(value) || value < 0 || value > 4294967295) {
    throw new Error(`${field} must be an unsigned 32-bit integer`);
  }
  return value;
}

function int64String(value, field) {
  const validated = signedDecimalString(value, field);
  const numeric = BigInt(validated);
  if (numeric < -9223372036854775808n || numeric > 9223372036854775807n) {
    throw new Error(`${field} must fit in a signed 64-bit integer`);
  }
  return validated;
}

function atraceComponent(value, field) {
  const text = nonEmptyString(value, field);
  if (/[|\r\n\0]/.test(text)) throw new Error(`${field} contains an atrace delimiter`);
  return text;
}

function androidInputPacket(repoRoot, timestamp, event) {
  const packetType = loadTraceType(repoRoot).root.lookupType('perfetto.protos.TracePacket');
  const legacy = packetType.fieldsArray.find(field =>
    field.id === 106 && /AndroidInputEvent$/.test(field.type));
  if (legacy) return {timestamp, timestampClockId: 6, [legacy.name]: event};
  // Current official schema: TracePacket.112 -> WinscopeExtensions.5.
  // Resolve both extensions from the loaded schema; a missing field is fatal.
  const umbrella = resolveTracePacketFieldName(repoRoot, 112);
  const inputField = resolveMessageFieldName(repoRoot, 'com.android.internal.WinscopeExtensions', 5);
  return {timestamp, timestampClockId: 6, [umbrella]: {[inputField]: event}};
}

function isolatedInputEventIds(scenario, usedIds) {
  const used = new Set(usedIds ?? []);
  const mapping = {};
  for (const signal of scenario.signals) {
    if (!['android-input-motion', 'android-input-dispatch'].includes(signal.type)) continue;
    const requested = uint32(signal.event_id, `${signal.type} event_id`);
    if (Object.hasOwn(mapping, requested)) continue;
    let candidate = requested;
    while (used.has(candidate)) candidate = (candidate + 1) >>> 0;
    used.add(candidate);
    mapping[requested] = candidate;
  }
  return mapping;
}

function printEvent(timestamp, tid, buf) {
  return {timestamp, pid: tid, print: {buf}};
}

function schedPriority(value, field) {
  if (!Number.isInteger(value) || value < -1 || value > 139) {
    throw new Error(`${field} must be a kernel sched priority from -1 through 139`);
  }
  return value;
}

function schedActor(id, identities, field) {
  if (id === null) return {tid: 0, name: 'swapper'};
  const thread = identities.threadDefinitions.get(id);
  if (!thread) throw new Error(`${field} references unknown thread ${id}`);
  return thread;
}

function schedSwitchEvent(timestamp, prev, next, prevState, prevPrio = 120, nextPrio = 120) {
  return {
    timestamp,
    pid: 0,
    schedSwitch: {
      prevComm: prev.name,
      prevPid: prev.tid,
      prevPrio,
      prevState,
      nextComm: next.name,
      nextPid: next.tid,
      nextPrio,
    },
  };
}

function expandActorIdTokens(name, identities, field) {
  return name.replace(ACTOR_ID_TOKEN, (_, kind, id) => {
    if (kind === 'pid') return String(processActor(identities, id, field).pid);
    const thread = identities.threadDefinitions.get(id);
    if (!thread) throw new Error(`${field} references unknown thread ${id}`);
    return String(thread.tid);
  });
}

function protoEnumNumber(enumType, value, field) {
  if (typeof value !== 'string' || !Object.hasOwn(enumType.values, value)) {
    throw new Error(`${field} must be a ${enumType.name} value name`);
  }
  return enumType.values[value];
}

function processStateEnum(repoRoot) {
  return loadTraceType(repoRoot).root.lookupEnum(PROCESS_STATE_ENUM);
}

function processActor(identities, id, field) {
  const process = identities.processDefinitions.get(id);
  if (!process) throw new Error(`${field} references unknown process ${id}`);
  return process;
}

// One statsd atom as trace processor receives it from the android.statsd data
// source. Field names are the atom's snake_case proto names; enum fields take
// value names. `process` fills pid/process_name from an actor.
function statsdAtomPacket(repoRoot, signal, identities, timestamp) {
  const atomField = camelCase(nonEmptyString(signal.atom, 'statsd-atom atom'));
  if (!STATSD_ATOMS.includes(atomField)) {
    throw new Error(`statsd-atom atom is unsupported: ${signal.atom}`);
  }
  const type = loadTraceType(repoRoot).root.lookupType('perfetto.protos.Atom').fields[atomField].resolve().resolvedType;
  if (!signal.fields || typeof signal.fields !== 'object' || Array.isArray(signal.fields)) {
    throw new Error('statsd-atom fields must be an object');
  }
  const payload = {};
  for (const [key, value] of Object.entries(signal.fields)) {
    const field = type.fields[camelCase(key)]?.resolve();
    if (!field) throw new Error(`statsd-atom ${signal.atom} has no field ${key}`);
    if (field.resolvedType?.values) {
      protoEnumNumber(field.resolvedType, value, `statsd-atom ${key}`);
      payload[field.name] = value;
    } else if (field.type === 'string') {
      payload[field.name] = nonEmptyString(value, `statsd-atom ${key}`);
    } else {
      if (!Number.isSafeInteger(value)) throw new Error(`statsd-atom ${key} must be an integer`);
      payload[field.name] = value;
    }
  }
  if (signal.process !== undefined) {
    const process = processActor(identities, signal.process, 'statsd-atom process');
    if (!type.fields.pid || !type.fields.processName) {
      throw new Error(`statsd-atom ${signal.atom} has no process fields`);
    }
    payload.pid = process.pid;
    payload.processName = process.name;
  }
  return {timestamp, statsdAtom: {atom: [{[atomField]: payload}], timestampNanos: [timestamp]}};
}

function encodeScenarioOverlay(repoRoot, scenario, options) {
  validateScenario(scenario);
  const frameTimelineFieldName = scenario.signals.some((signal) => signal.type === 'frame-timeline')
    ? resolveTracePacketFieldName(repoRoot, FRAME_TIMELINE_TRACE_PACKET_FIELD_NUMBER)
    : null;
  const anchorNs = decimalString(options?.anchorNs, 'options.anchorNs');
  const realtimeAnchorNs = decimalString(
    options?.realtimeAnchorNs ?? anchorNs,
    'options.realtimeAnchorNs',
  );
  if (!Number.isInteger(options?.sequenceId) || options.sequenceId <= 0) {
    throw new Error('options.sequenceId must be a positive integer');
  }
  const usedPids = new Set(options.usedPids ?? []);
  const identities = buildIdentities(scenario, usedPids);
  const ftraceByCpu = new Map();
  const dataPackets = [];
  const inputEventIds = isolatedInputEventIds(scenario, options.usedInputEventIds);
  const processStateTracks = new Set();

  function eventsForCpu(cpu) {
    if (!Number.isInteger(cpu) || cpu < 0) throw new Error(`invalid cpu: ${cpu}`);
    if (!ftraceByCpu.has(cpu)) ftraceByCpu.set(cpu, []);
    return ftraceByCpu.get(cpu);
  }

  for (const [index, signal] of scenario.signals.entries()) {
    const timestamp = absoluteTimestamp(anchorNs, signal.at_ns, `scenario.signals[${index}].at_ns`);
    if (signal.type === 'atrace-slice') {
      const {process, thread} = actorForSignal(signal, identities);
      const end = absoluteTimestamp(timestamp, signal.duration_ns, `scenario.signals[${index}].duration_ns`);
      const events = eventsForCpu(signal.cpu ?? 0);
      const name = expandActorIdTokens(nonEmptyString(signal.name, 'signal.name'), identities, 'atrace-slice name');
      events.push(printEvent(timestamp, thread.tid, `B|${process.pid}|${name}`));
      events.push(printEvent(end, thread.tid, `E|${process.pid}`));
    } else if (signal.type === 'atrace-track-instant') {
      const {process, thread} = actorForSignal(signal, identities);
      const track = atraceComponent(signal.track_name, 'atrace-track-instant track_name');
      const name = atraceComponent(signal.name, 'atrace-track-instant name');
      eventsForCpu(signal.cpu ?? 0).push(printEvent(timestamp, thread.tid,
        `N|${process.pid}|${track}|${name}`));
    } else if (signal.type === 'android-input-motion') {
      const event = {
        eventId: inputEventIds[signal.event_id],
        eventTimeNanos: timestamp,
        source: uint32(signal.source, 'android-input-motion source'),
        action: int32(signal.action, 'android-input-motion action'),
        deviceId: int32(signal.device_id, 'android-input-motion device_id'),
        displayId: int32(signal.display_id, 'android-input-motion display_id'),
      };
      dataPackets.push(androidInputPacket(repoRoot, timestamp, {dispatcherMotionEvent: event}));
    } else if (signal.type === 'android-input-dispatch') {
      const event = {
        eventId: inputEventIds[signal.event_id],
        vsyncId: int64String(signal.vsync_id, 'android-input-dispatch vsync_id'),
        windowId: int32(signal.window_id, 'android-input-dispatch window_id'),
      };
      dataPackets.push(androidInputPacket(repoRoot, timestamp, {dispatcherWindowDispatchEvent: event}));
    } else if (signal.type === 'atrace-counter') {
      const {process, thread} = actorForSignal(signal, identities);
      if (typeof signal.value !== 'number' || !Number.isFinite(signal.value)) {
        throw new Error('atrace-counter value must be a finite number');
      }
      eventsForCpu(signal.cpu ?? 0).push(
        printEvent(timestamp, thread.tid, `C|${process.pid}|${nonEmptyString(signal.name, 'signal.name')}|${signal.value}`),
      );
    } else if (signal.type === 'atrace-async-slice') {
      const {process, thread} = actorForSignal(signal, identities);
      const cookie = nonNegativeInteger(signal.cookie, 'atrace-async-slice cookie');
      const name = nonEmptyString(signal.name, 'signal.name');
      const end = absoluteTimestamp(timestamp, signal.duration_ns, `scenario.signals[${index}].duration_ns`);
      const events = eventsForCpu(signal.cpu ?? 0);
      events.push(printEvent(timestamp, thread.tid, `S|${process.pid}|${name}|${cookie}`));
      events.push(printEvent(end, thread.tid, `F|${process.pid}|${name}|${cookie}`));
    } else if (signal.type === 'atrace-async-track-slice') {
      const {process, thread} = actorForSignal(signal, identities);
      const cookie = nonNegativeInteger(signal.cookie, 'atrace-async-track-slice cookie');
      const trackName = nonEmptyString(signal.track_name, 'signal.track_name');
      const name = nonEmptyString(signal.name, 'signal.name');
      const end = absoluteTimestamp(timestamp, signal.duration_ns, `scenario.signals[${index}].duration_ns`);
      const events = eventsForCpu(signal.cpu ?? 0);
      events.push(printEvent(timestamp, thread.tid, `G|${process.pid}|${trackName}|${name}|${cookie}`));
      events.push(printEvent(end, thread.tid, `H|${process.pid}|${trackName}|${name}|${cookie}`));
    } else if (signal.type === 'sched-running') {
      const thread = identities.threadDefinitions.get(signal.thread);
      if (!thread) throw new Error(`signal references unknown thread ${signal.thread}`);
      const endState = END_STATES.get(signal.end_state);
      if (endState === undefined) throw new Error(`unsupported sched end_state: ${signal.end_state}`);
      const end = absoluteTimestamp(timestamp, signal.duration_ns, `scenario.signals[${index}].duration_ns`);
      const idle = {tid: 0, name: 'swapper'};
      const task = {tid: thread.tid, name: thread.name};
      const events = eventsForCpu(signal.cpu);
      events.push(schedSwitchEvent(timestamp, idle, task, '0'));
      events.push(schedSwitchEvent(end, task, idle, endState));
    } else if (signal.type === 'sched-switch') {
      const prev = schedActor(signal.prev_thread, identities, 'sched-switch prev_thread');
      const next = schedActor(signal.next_thread, identities, 'sched-switch next_thread');
      if (prev.tid === next.tid) throw new Error('sched-switch must change the running thread');
      eventsForCpu(signal.cpu).push(schedSwitchEvent(
        timestamp, prev, next,
        nonNegativeInt64String(signal.prev_state_raw, 'sched-switch prev_state_raw'),
        schedPriority(signal.prev_priority, 'sched-switch prev_priority'),
        schedPriority(signal.next_priority, 'sched-switch next_priority'),
      ));
    } else if (signal.type === 'sched-waking') {
      const thread = schedActor(signal.thread, identities, 'sched-waking thread');
      const waker = schedActor(signal.waker_thread, identities, 'sched-waking waker_thread');
      if (thread.tid === 0) throw new Error('sched-waking cannot wake the idle thread');
      eventsForCpu(signal.cpu).push({
        timestamp,
        pid: waker.tid,
        schedWaking: {
          comm: thread.name,
          pid: thread.tid,
          prio: schedPriority(signal.sched_priority, 'sched-waking sched_priority'),
          success: 1,
          targetCpu: nonNegativeInteger(signal.target_cpu, 'sched-waking target_cpu'),
        },
      });
    } else if (signal.type === 'process-stats') {
      const process = identities.processDefinitions.get(signal.process);
      if (!process) throw new Error(`signal references unknown process ${signal.process}`);
      const stats = {pid: process.pid};
      for (const [field, protoField] of [
        ['vm_rss_kb', 'vmRssKb'],
        ['rss_anon_kb', 'rssAnonKb'],
        ['rss_file_kb', 'rssFileKb'],
        ['rss_shmem_kb', 'rssShmemKb'],
        ['vm_swap_kb', 'vmSwapKb'],
        ['vm_hwm_kb', 'vmHwmKb'],
      ]) {
        if (signal[field] !== undefined) stats[protoField] = nonNegativeInteger(signal[field], `process-stats ${field}`);
      }
      if (signal.oom_score_adj !== undefined) {
        if (!Number.isInteger(signal.oom_score_adj)) throw new Error('process-stats oom_score_adj must be an integer');
        stats.oomScoreAdj = signal.oom_score_adj;
      }
      dataPackets.push({timestamp, processStats: {processes: [stats], collectionEndTimestamp: timestamp}});
    } else if (signal.type === 'statsd-atom') {
      dataPackets.push(statsdAtomPacket(repoRoot, signal, identities, timestamp));
    } else if (signal.type === 'battery-stats-span') {
      const {process, thread} = actorForSignal(signal, identities);
      const event = nonEmptyString(signal.event, 'battery-stats-span event');
      if (!BATTERY_STATS_EVENTS.has(event)) throw new Error(`battery-stats-span event is unsupported: ${event}`);
      const owner = processActor(identities, signal.owner_process, 'battery-stats-span owner_process');
      const tag = atraceComponent(signal.tag, 'battery-stats-span tag');
      if (tag.includes('"')) throw new Error('battery-stats-span tag must not contain a quote');
      const end = absoluteTimestamp(timestamp, signal.duration_ns, `scenario.signals[${index}].duration_ns`);
      const history = `${event}=${owner.uid}:"${tag}"`;
      const events = eventsForCpu(signal.cpu ?? 0);
      events.push(printEvent(timestamp, thread.tid, `N|${process.pid}|battery_stats.${event}|+${history}`));
      events.push(printEvent(end, thread.tid, `N|${process.pid}|battery_stats.${event}|-${history}`));
    } else if (signal.type === 'android-process-state-snapshot') {
      if (!Array.isArray(signal.records) || signal.records.length === 0) {
        throw new Error('android-process-state-snapshot records must be a non-empty array');
      }
      const record = signal.records.map((item, recordIndex) => {
        const field = `android-process-state-snapshot records[${recordIndex}]`;
        const process = processActor(identities, item.process, `${field}.process`);
        return {
          pid: process.pid,
          uid: process.uid,
          procState: protoEnumNumber(processStateEnum(repoRoot), item.proc_state,
            `${field}.proc_state`),
          ...(item.oom_score !== undefined ? {oomScore: int32(item.oom_score, `${field}.oom_score`)} : {}),
          processName: process.name,
        };
      });
      dataPackets.push({timestamp, [PROCESS_STATE_SNAPSHOT_EXTENSION]: {record}});
    } else if (signal.type === 'android-process-state-change') {
      const {thread} = actorForSignal(signal, identities);
      const target = processActor(identities, signal.target_process, 'android-process-state-change target_process');
      const trackUuid = ((BigInt(options.sequenceId) << 32n) | BigInt(thread.tid)).toString();
      if (!processStateTracks.has(trackUuid)) {
        processStateTracks.add(trackUuid);
        dataPackets.push({
          timestamp,
          trackDescriptor: {uuid: trackUuid, thread: {pid: thread.tgid, tid: thread.tid, threadName: thread.name}},
        });
      }
      const state = (value, field) => protoEnumNumber(processStateEnum(repoRoot), value,
        `android-process-state-change ${field}`);
      dataPackets.push({
        timestamp,
        trackEvent: {
          type: 'TYPE_INSTANT',
          trackUuid,
          name: 'proc_state_change',
          [PROCESS_STATE_CHANGED_EXTENSION]: {
            uid: target.uid,
            pid: target.pid,
            prevProcState: state(signal.prev_proc_state, 'prev_proc_state'),
            curProcState: state(signal.cur_proc_state, 'cur_proc_state'),
            ...(signal.prev_oom_score !== undefined
              ? {prevOomScore: int32(signal.prev_oom_score, 'android-process-state-change prev_oom_score')} : {}),
            ...(signal.cur_oom_score !== undefined
              ? {curOomScore: int32(signal.cur_oom_score, 'android-process-state-change cur_oom_score')} : {}),
            ...(signal.reason !== undefined ? {reason: protoEnumNumber(
              loadTraceType(repoRoot).root.lookupEnum('com.android.internal.OomChangeReasonEnum'), signal.reason, 'android-process-state-change reason')} : {}),
            seqId: String(nonNegativeInteger(signal.seq_id ?? index, 'android-process-state-change seq_id')),
          },
        },
      });
    } else if (signal.type === 'managed-heap-graph') {
      const process = identities.processDefinitions.get(signal.process);
      if (!process) throw new Error(`signal references unknown process ${signal.process}`);
      dataPackets.push({
        timestamp,
        [HEAP_GRAPH_EXTENSION]: validateManagedHeapGraph(signal, process),
      });
    } else if (signal.type === 'anr-event') {
      const {process: sourceProcess, thread} = actorForSignal(signal, identities);
      const targetProcess = identities.processDefinitions.get(signal.target_process);
      if (!targetProcess) throw new Error(`anr-event references unknown target process ${signal.target_process}`);
      const errorId = nonEmptyString(signal.error_id, 'anr-event error_id');
      const subject = nonEmptyString(signal.subject, 'anr-event subject');
      const events = eventsForCpu(signal.cpu ?? 0);
      events.push(printEvent(
        timestamp,
        thread.tid,
        `C|${sourceProcess.pid}|ErrorId:${targetProcess.name} ${targetProcess.pid}#${errorId}|1`,
      ));
      events.push(printEvent(
        timestamp,
        thread.tid,
        `C|${sourceProcess.pid}|Subject(for ErrorId ${errorId}):${subject}|1`,
      ));
    } else if (signal.type === 'perf-sample') {
      const {process, thread} = actorForSignal(signal, identities);
      const iidBase = (index + 1) * 1000;
      const pathIid = iidBase + 1;
      const functionIid = iidBase + 2;
      const mappingIid = iidBase + 3;
      const frameIid = iidBase + 4;
      const callstackIid = iidBase + 5;
      dataPackets.push({
        timestamp,
        internedData: {
          mappingPaths: [{iid: pathIid, str: Buffer.from(nonEmptyString(signal.module_name, 'perf-sample module_name'))}],
          functionNames: [{iid: functionIid, str: Buffer.from(nonEmptyString(signal.function_name, 'perf-sample function_name'))}],
          mappings: [{
            iid: mappingIid,
            startOffset: 0,
            start: 4096,
            end: 8192,
            loadBias: 0,
            pathStringIds: [pathIid],
          }],
          frames: [{iid: frameIid, functionNameId: functionIid, mappingId: mappingIid, relPc: 16}],
          callstacks: [{iid: callstackIid, frameIds: [frameIid]}],
        },
      });
      const sampleCount = positiveSafeInteger(signal.sample_count, 'perf-sample sample_count');
      const interval = BigInt(positiveUint64String(signal.sample_interval_ns, 'perf-sample sample_interval_ns'));
      for (let sampleIndex = 0; sampleIndex < sampleCount; sampleIndex += 1) {
        dataPackets.push({
          timestamp: (BigInt(timestamp) + interval * BigInt(sampleIndex)).toString(),
          perfSample: {
            cpu: nonNegativeInteger(signal.cpu ?? 0, 'perf-sample cpu'),
            pid: process.pid,
            tid: thread.tid,
            cpuMode: 'MODE_USER',
            timebaseCount: sampleIndex + 1,
            callstackIid,
          },
        });
      }
    } else if (signal.type === 'android-log') {
      const {process, thread} = actorForSignal(signal, identities);
      const logId = ANDROID_LOG_IDS.get(signal.log_id);
      const priority = ANDROID_LOG_PRIORITIES.get(signal.priority);
      if (!logId) throw new Error(`unsupported android-log log_id: ${signal.log_id}`);
      if (!priority) throw new Error(`unsupported android-log priority: ${signal.priority}`);
      const logTimestamp = absoluteTimestamp(
        realtimeAnchorNs,
        signal.at_ns,
        `scenario.signals[${index}].at_ns`,
      );
      dataPackets.push({
        timestamp,
        androidLog: {
          events: [{
            logId,
            pid: process.pid,
            tid: thread.tid,
            uid: process.uid,
            timestamp: logTimestamp,
            tag: nonEmptyString(signal.tag, 'android-log tag'),
            prio: priority,
            message: nonEmptyString(signal.message, 'android-log message'),
          }],
        },
      });
    } else if (signal.type === 'battery-counters') {
      const battery = {};
      if (signal.capacity_percent !== undefined) battery.capacityPercent = finiteNumber(signal.capacity_percent, 'battery capacity_percent');
      for (const [field, protoField] of [
        ['charge_counter_uah', 'chargeCounterUah'],
        ['current_ua', 'currentUa'],
        ['current_avg_ua', 'currentAvgUa'],
        ['energy_counter_uwh', 'energyCounterUwh'],
        ['voltage_uv', 'voltageUv'],
      ]) {
        if (signal[field] !== undefined) battery[protoField] = signedDecimalString(signal[field], `battery ${field}`);
      }
      dataPackets.push({timestamp, battery});
    } else if (signal.type === 'power-rail') {
      const duration = decimalString(signal.duration_ns, `scenario.signals[${index}].duration_ns`);
      const end = absoluteTimestamp(timestamp, duration, `scenario.signals[${index}].duration_ns`);
      const railIndex = index + 1;
      dataPackets.push({
        timestamp,
        powerRails: {
          sessionUuid: String(options.sequenceId),
          railDescriptor: [{
            index: railIndex,
            railName: nonEmptyString(signal.name, 'power-rail name'),
            subsysName: nonEmptyString(signal.subsystem, 'power-rail subsystem'),
            samplingRate: 1000,
          }],
          energyData: [
            {index: railIndex, timestampMs: (BigInt(timestamp) / 1000000n).toString(), energy: decimalString(signal.start_energy_uws, 'power-rail start_energy_uws')},
            {index: railIndex, timestampMs: (BigInt(end) / 1000000n).toString(), energy: decimalString(signal.end_energy_uws, 'power-rail end_energy_uws')},
          ],
        },
      });
    } else if (signal.type === 'gpu-work-period') {
      const end = absoluteTimestamp(timestamp, signal.duration_ns, `scenario.signals[${index}].duration_ns`);
      eventsForCpu(signal.cpu ?? 0).push({
        timestamp,
        pid: 0,
        gpuWorkPeriod: {
          gpuId: nonNegativeInteger(signal.gpu_id, 'gpu-work-period gpu_id'),
          uid: nonNegativeInteger(signal.uid, 'gpu-work-period uid'),
          startTimeNs: timestamp,
          endTimeNs: end,
          totalActiveDurationNs: decimalString(signal.active_duration_ns, 'gpu-work-period active_duration_ns'),
        },
      });
    } else if (signal.type === 'gpu-compute-kernel') {
      const process = identities.processDefinitions.get(signal.process);
      if (!process) throw new Error(`signal references unknown process ${signal.process}`);
      const compute = validateGpuComputeKernel(signal, process, index);
      dataPackets.push({
        timestamp,
        internedData: {
          graphicsContexts: [compute.graphicsContext],
          gpuSpecifications: [compute.queueSpecification, compute.stageSpecification],
          [GPU_COMPUTE_KERNELS_EXTENSION]: [compute.computeKernel],
          [GPU_COMPUTE_ARG_NAMES_EXTENSION]: compute.computeArgNames,
        },
      });
      dataPackets.push({
        timestamp,
        gpuRenderStageEvent: {
          eventId: compute.eventId,
          duration: compute.duration,
          hwQueueIid: compute.queueIid,
          stageIid: compute.stageIid,
          gpuId: compute.gpuId,
          context: compute.context,
          kernelIid: compute.kernelIid,
          launch: compute.launch,
        },
      });
    } else if (signal.type === 'gpu-frequency') {
      eventsForCpu(signal.cpu ?? 0).push({
        timestamp,
        pid: 0,
        gpuFrequency: {
          gpuId: nonNegativeInteger(signal.gpu_id, 'gpu-frequency gpu_id'),
          state: nonNegativeInteger(signal.value, 'gpu-frequency value'),
        },
      });
    } else if (signal.type === 'cpu-frequency') {
      eventsForCpu(signal.cpu ?? signal.cpu_id).push({
        timestamp,
        pid: 0,
        cpuFrequency: {
          cpuId: nonNegativeInteger(signal.cpu_id, 'cpu-frequency cpu_id'),
          state: nonNegativeInteger(signal.value, 'cpu-frequency value'),
        },
      });
    } else if (signal.type === 'cpu-frequency-limits') {
      // Policy-level DVFS clamp. trace_processor keys the resulting
      // cpu_max_frequency_limit / cpu_min_frequency_limit tracks by cpu_id,
      // which is the policy leader CPU rather than every CPU in the policy.
      const minFreq = uint32(signal.min_freq_khz, 'cpu-frequency-limits min_freq_khz');
      const maxFreq = uint32(signal.max_freq_khz, 'cpu-frequency-limits max_freq_khz');
      if (minFreq > maxFreq) {
        throw new Error('cpu-frequency-limits min_freq_khz must not exceed max_freq_khz');
      }
      eventsForCpu(signal.cpu ?? signal.cpu_id).push({
        timestamp,
        pid: 0,
        cpuFrequencyLimits: {
          cpuId: nonNegativeInteger(signal.cpu_id, 'cpu-frequency-limits cpu_id'),
          minFreq,
          maxFreq,
        },
      });
    } else if (signal.type === 'thermal-temperature') {
      eventsForCpu(signal.cpu ?? 0).push({
        timestamp,
        pid: 0,
        thermalTemperature: {
          id: int32(signal.id ?? 0, 'thermal-temperature id'),
          temp: int32(signal.temp_mc, 'thermal-temperature temp_mc'),
          tempPrev: int32(signal.temp_prev_mc ?? signal.temp_mc, 'thermal-temperature temp_prev_mc'),
          thermalZone: nonEmptyString(signal.thermal_zone, 'thermal-temperature thermal_zone'),
        },
      });
    } else if (signal.type === 'cdev-update') {
      eventsForCpu(signal.cpu ?? 0).push({
        timestamp,
        pid: 0,
        cdevUpdate: {
          target: nonNegativeSafeInteger(signal.target, 'cdev-update target'),
          type: nonEmptyString(signal.cdev_type, 'cdev-update cdev_type'),
        },
      });
    } else if (signal.type === 'irq-span') {
      const end = absoluteTimestamp(timestamp, signal.duration_ns, `scenario.signals[${index}].duration_ns`);
      const irq = nonNegativeInteger(signal.irq, 'irq-span irq');
      const events = eventsForCpu(signal.cpu ?? 0);
      events.push({timestamp, pid: 0, irqHandlerEntry: {irq, name: nonEmptyString(signal.name, 'irq-span name')}});
      events.push({timestamp: end, pid: 0, irqHandlerExit: {irq, ret: 1}});
    } else if (signal.type === 'frame-timeline') {
      const process = identities.processDefinitions.get(signal.process);
      if (!process) throw new Error(`signal references unknown process ${signal.process}`);
      const end = absoluteTimestamp(timestamp, signal.duration_ns, `scenario.signals[${index}].duration_ns`);
      const cookie = nonNegativeInteger(signal.cookie, 'frame-timeline cookie');
      dataPackets.push({
        timestamp,
        [frameTimelineFieldName]: {
          actualSurfaceFrameStart: {
            cookie,
            token: nonNegativeInteger(signal.token, 'frame-timeline token'),
            displayFrameToken: nonNegativeInteger(signal.display_frame_token, 'frame-timeline display_frame_token'),
            pid: process.pid,
            layerName: nonEmptyString(signal.layer_name, 'frame-timeline layer_name'),
            presentType: signal.jank_type ? 2 : 1,
            onTimeFinish: !signal.jank_type,
            gpuComposition: false,
            jankType: nonNegativeInteger(signal.jank_type ?? 1, 'frame-timeline jank_type'),
            predictionType: 1,
            jankSeverityType: signal.jank_type ? 3 : 1,
          },
        },
      });
      dataPackets.push({timestamp: end, [frameTimelineFieldName]: {frameEnd: {cookie}}});
    } else if (signal.type === 'gpu-power-state') {
      eventsForCpu(signal.cpu ?? 0).push({
        timestamp,
        pid: 0,
        maliGpuPowerState: {
          changeNs: timestamp,
          fromState: nonNegativeInteger(signal.old_state, 'gpu-power-state old_state'),
          toState: nonNegativeInteger(signal.new_state, 'gpu-power-state new_state'),
        },
      });
    } else if (signal.type === 'cpu-idle') {
      eventsForCpu(signal.cpu ?? signal.cpu_id).push({
        timestamp,
        pid: 0,
        cpuIdle: {
          cpuId: nonNegativeInteger(signal.cpu_id, 'cpu-idle cpu_id'),
          state: nonNegativeInteger(signal.state, 'cpu-idle state'),
        },
      });
    } else if (signal.type === 'lmk-kill') {
      const {process, thread} = actorForSignal(signal, identities);
      const end = absoluteTimestamp(timestamp, signal.duration_ns, `scenario.signals[${index}].duration_ns`);
      const killReason = nonNegativeInteger(signal.kill_reason, 'lmk-kill kill_reason');
      if (!Number.isInteger(signal.oom_score_adj)) throw new Error('lmk-kill oom_score_adj must be an integer');
      const events = eventsForCpu(signal.cpu ?? 0);
      events.push(printEvent(timestamp, thread.tid, `B|${process.pid}|lmk,${process.pid},${killReason},${signal.oom_score_adj}`));
      events.push(printEvent(end, thread.tid, `E|${process.pid}`));
    } else {
      throw new Error(`unsupported signal type: ${signal.type}`);
    }
  }

  const processTree = {
    processes: [...identities.processDefinitions.values()].map((actor) => ({
      pid: actor.pid,
      ppid: 1,
      cmdline: [actor.name],
      uid: actor.uid,
    })),
    threads: [...identities.threadDefinitions.values()].map((actor) => ({
      tid: actor.tid,
      tgid: actor.tgid,
      name: actor.name,
    })),
    collectionEndTimestamp: anchorNs,
  };
  const packets = [
    {
      trustedPacketSequenceId: options.sequenceId,
      clockSnapshot: {
        clocks: [
          {clockId: 1, timestamp: realtimeAnchorNs},
          {clockId: 5, timestamp: anchorNs},
          {clockId: 6, timestamp: anchorNs},
          {clockId: 11, timestamp: anchorNs},
        ],
        primaryTraceClock: 6,
      },
    },
    {
      timestamp: anchorNs,
      trustedPacketSequenceId: options.sequenceId,
      incrementalStateCleared: true,
      processTree,
    },
    ...dataPackets.map((packet) => ({
      ...packet,
      trustedPacketSequenceId: options.sequenceId,
    })),
    ...[...ftraceByCpu.entries()]
      .sort(([left], [right]) => left - right)
      .map(([cpu, event]) => ({
        timestamp: anchorNs,
        trustedPacketSequenceId: options.sequenceId,
        ftraceEvents: {cpu, event},
      })),
  ];
  const buffer = encodeTrace(repoRoot, packets);
  return {
    buffer,
    identities: {processes: identities.processes, threads: identities.threads},
    provenance: {
      anchor_ns: anchorNs,
      realtime_anchor_ns: realtimeAnchorNs,
      sequence_id: options.sequenceId,
      ...(Object.keys(inputEventIds).length > 0 ? {input_event_ids: inputEventIds} : {}),
      overlay_sha256: sha256Buffer(buffer),
    },
  };
}

function materializeTrace(base, overlay, outputPath) {
  if (!Buffer.isBuffer(base) || !Buffer.isBuffer(overlay)) {
    throw new Error('base and overlay must be Buffers');
  }
  const output = Buffer.concat([base, overlay]);
  fs.mkdirSync(path.dirname(outputPath), {recursive: true});
  const tempPath = path.join(
    path.dirname(outputPath),
    `.${path.basename(outputPath)}.${process.pid}.${randomUUID()}.tmp`,
  );
  try {
    fs.writeFileSync(tempPath, output);
    fs.renameSync(tempPath, outputPath);
  } finally {
    fs.rmSync(tempPath, {force: true});
  }
  return {
    base_bytes: base.length,
    overlay_bytes: overlay.length,
    output_bytes: output.length,
    base_sha256: sha256Buffer(base),
    overlay_sha256: sha256Buffer(overlay),
    output_sha256: sha256Buffer(output),
  };
}

function resolveTraceProcessor(repoRoot) {
  const key = `${process.platform}-${process.arch}`;
  const relative = {
    'darwin-arm64': 'backend/prebuilts/trace_processor/darwin-arm64/trace_processor_shell',
    'linux-x64': 'backend/prebuilts/trace_processor/linux-x64/trace_processor_shell',
    'win32-x64': 'backend/prebuilts/trace_processor/win32-x64/trace_processor_shell.exe',
  }[key];
  if (!relative) throw new Error(`No checked-in trace processor for ${key}`);
  const executable = path.join(repoRoot, relative);
  if (!fs.existsSync(executable)) throw new Error(`Missing trace processor: ${executable}`);
  return executable;
}

function parseProbeCsv(output) {
  const lines = output.trim().split(/\r?\n/).filter(Boolean);
  if (lines.length < 2) throw new Error(`Trace probe returned no rows: ${output}`);
  const unquote = (value) => value.replace(/^"|"$/g, '').replace(/""/g, '"');
  return lines.slice(1).map((line) => line.split(',').map(unquote));
}

function probeTrace(repoRoot, tracePath) {
  if (!fs.existsSync(tracePath)) throw new Error(`Missing trace: ${tracePath}`);
  const sql = `
    SELECT 'bounds' AS kind, printf('%d', trace_start()) AS value_1,
           printf('%d', trace_end()) AS value_2
    UNION ALL
    SELECT 'pid', CAST(pid AS TEXT), '' FROM process WHERE pid IS NOT NULL
    UNION ALL
    SELECT 'cpu', CAST(cpu AS TEXT), '' FROM (SELECT DISTINCT cpu FROM sched)
    UNION ALL
    SELECT 'realtime_offset', printf('%d', COALESCE((
      SELECT clock_value - ts
      FROM clock_snapshot
      WHERE clock_id = 1
      ORDER BY snapshot_id
      LIMIT 1
    ), 0)), ''
    ORDER BY kind, value_1
  `;
  const result = spawnSync(resolveTraceProcessor(repoRoot), ['-Q', sql, tracePath], {
    cwd: repoRoot,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`trace_processor_shell probe failed (${result.status}): ${result.stderr}`);
  }
  const rows = parseProbeCsv(result.stdout);
  const bounds = rows.find(([kind]) => kind === 'bounds');
  if (!bounds) throw new Error('Trace probe did not return bounds');
  decimalString(bounds[1], 'trace start');
  decimalString(bounds[2], 'trace end');
  return {
    start_ns: bounds[1],
    end_ns: bounds[2],
    realtime_offset_ns: rows.find(([kind]) => kind === 'realtime_offset')?.[1] ?? '0',
    used_pids: new Set(
      rows
        .filter(([kind]) => kind === 'pid')
        .map(([, pid]) => Number.parseInt(pid, 10))
        .filter(Number.isInteger),
    ),
    used_cpus: new Set(
      rows
        .filter(([kind]) => kind === 'cpu')
        .map(([, cpu]) => Number.parseInt(cpu, 10))
        .filter(Number.isInteger),
    ),
  };
}

function chooseAnchor(bounds, clock) {
  const start = BigInt(bounds.start_ns);
  const end = BigInt(bounds.end_ns);
  const duration = BigInt(decimalString(clock.duration_ns, 'scenario.clock.duration_ns'));
  const margin = 1000000n;
  const first = start + margin;
  const last = end - margin - duration;
  if (last < first) {
    throw new Error(`Scenario duration ${duration}ns does not fit trace bounds ${start}-${end}`);
  }
  if (clock.anchor === 'trace-start') return first.toString();
  if (clock.anchor === 'trace-middle') return (first + (last - first) / 2n).toString();
  if (clock.anchor === 'trace-end') return last.toString();
  throw new Error(`Unsupported scenario clock anchor: ${clock.anchor}`);
}

function allocateSequenceId(caseId, usedSequenceIds) {
  const hash = sha256Buffer(Buffer.from(caseId));
  let candidate = (0x70000000 | (Number.parseInt(hash.slice(0, 8), 16) & 0x0fffffff)) >>> 0;
  while (usedSequenceIds.has(candidate) || candidate === 0) candidate = (candidate + 1) >>> 0;
  return candidate;
}

function isolateScenarioCpus(scenario, usedCpus) {
  const requested = [...new Set(
    scenario.signals
      .flatMap((signal) => [
        signal.cpu,
        ...(CPU_ID_SIGNAL_TYPES.has(signal.type) ? [signal.cpu_id] : []),
        ...(signal.type === 'sched-waking' ? [signal.target_cpu] : []),
      ])
      .filter((cpu) => Number.isInteger(cpu))
      .map((cpu) => nonNegativeInteger(cpu, 'scenario CPU identity')),
  )].sort((left, right) => left - right);
  let nextCpu = usedCpus.size > 0 ? Math.max(...usedCpus) + 1 : 0;
  const cpuMap = {};
  for (const cpu of requested) {
    while (usedCpus.has(nextCpu)) nextCpu += 1;
    cpuMap[cpu] = nextCpu;
    usedCpus.add(nextCpu);
    nextCpu += 1;
  }
  return {
    cpuMap,
    scenario: {
      ...scenario,
      signals: scenario.signals.map((signal) => ({
        ...signal,
        ...(Number.isInteger(signal.cpu) ? {cpu: cpuMap[signal.cpu]} : {}),
        ...(CPU_ID_SIGNAL_TYPES.has(signal.type) ? {cpu_id: cpuMap[signal.cpu_id]} : {}),
        ...(signal.type === 'sched-waking' ? {target_cpu: cpuMap[signal.target_cpu]} : {}),
      })),
    },
  };
}

function probeInputEventIds(repoRoot, tracePath) {
  const sql = `INCLUDE PERFETTO MODULE android.input;
    SELECT CAST(event_id AS TEXT) AS event_id FROM android_motion_events
    UNION SELECT CAST(event_id AS TEXT) FROM android_key_events
    UNION SELECT CAST(event_id AS TEXT) FROM android_input_event_dispatch
    UNION SELECT input_event_id FROM android_input_events WHERE input_event_id IS NOT NULL`;
  const result = spawnSync(resolveTraceProcessor(repoRoot), ['-Q', sql, tracePath], {
    cwd: repoRoot, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`input identity probe failed: ${result.stderr}`);
  return new Set(parseProbeCsv(result.stdout).map(([id]) => Number(id)).filter(Number.isInteger));
}

function buildConstructedTrace(repoRoot, options) {
  const base = fs.readFileSync(options.basePath);
  const scenario = JSON.parse(fs.readFileSync(options.scenarioPath, 'utf8'));
  validateScenario(scenario);
  const probe = probeTrace(repoRoot, options.basePath);
  const anchorNs = chooseAnchor(probe, scenario.clock);
  const usedSequenceIds = collectPacketSequenceIds(repoRoot, base);
  const sequenceId = allocateSequenceId(options.caseId, usedSequenceIds);
  const isolated = isolateScenarioCpus(scenario, new Set(probe.used_cpus));
  const overlay = encodeScenarioOverlay(repoRoot, isolated.scenario, {
    anchorNs,
    realtimeAnchorNs: (BigInt(anchorNs) + BigInt(probe.realtime_offset_ns)).toString(),
    usedPids: probe.used_pids,
    usedInputEventIds: scenario.signals.some(signal => signal.type.startsWith('android-input-'))
      ? probeInputEventIds(repoRoot, options.basePath) : [],
    sequenceId,
  });
  fs.mkdirSync(path.dirname(options.overlayPath), {recursive: true});
  fs.writeFileSync(options.overlayPath, overlay.buffer);
  const materialization = materializeTrace(base, overlay.buffer, options.outputPath);
  const outputProbe = probeTrace(repoRoot, options.outputPath);
  return {
    overlay,
    output_probe: {
      start_ns: outputProbe.start_ns,
      end_ns: outputProbe.end_ns,
      used_pid_count: outputProbe.used_pids.size,
    },
    provenance: {
      case_id: options.caseId,
      anchor_ns: anchorNs,
      sequence_id: sequenceId,
      cpu_map: isolated.cpuMap,
      ...(overlay.provenance.input_event_ids ? {input_event_ids: overlay.provenance.input_event_ids} : {}),
      base_sha256: materialization.base_sha256,
      overlay_sha256: materialization.overlay_sha256,
      output_sha256: materialization.output_sha256,
      base_bytes: materialization.base_bytes,
      overlay_bytes: materialization.overlay_bytes,
      output_bytes: materialization.output_bytes,
    },
  };
}

module.exports = {
  SUPPORTED_SIGNAL_TYPES,
  buildConstructedTrace,
  encodeScenarioOverlay,
  materializeTrace,
  probeTrace,
  resolveTraceProcessor,
};
