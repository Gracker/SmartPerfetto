// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)

/** Input syntax only. References remain model declarations, never evidence. */
export const CONCLUSION_AUTHORING_VERSION = 'conclusion_authoring@1';
export const CONCLUSION_AUTHORING_VERSION_V2 = 'conclusion_authoring@2';
export type ConclusionAuthoringVersion = typeof CONCLUSION_AUTHORING_VERSION | typeof CONCLUSION_AUTHORING_VERSION_V2;
export const CONCLUSION_AUTHORING_LIMITS = Object.freeze({utf8Bytes: 1_048_576, nodes: 10_000, depth: 24});
export const CONCLUSION_AUTHORING_ENV = 'SMARTPERFETTO_CONCLUSION_AUTHORING';

/** Resolve internal configuration before a run; never read model/client fields or ambient state here. */
export function resolveConclusionDeclarationSyntax(value: string | undefined): 'canonical_v1' | 'authoring_v1' | 'authoring_v2' {
  if (value === undefined || value === 'canonical_v1') return 'canonical_v1';
  if (value === 'authoring_v1') return 'authoring_v1';
  if (value === 'authoring_v2') return 'authoring_v2';
  throw new Error('invalid_configuration:conclusion_authoring');
}

type Path = readonly (string | number)[];
type SlotKind = 'claim_references' | 'subject_refs' | 'object_refs' |
  'relation_subject' | 'relation_object' | 'relation_proof';
interface ReferenceSlot {
  kind: SlotKind;
  /** One-based claim/proposal position, not a model-authored identifier. */
  ordinal: number;
  referenceOrdinal?: number;
}
export interface AuthoringReferenceUse extends ReferenceSlot {dictionaryIndex: number}
export interface AuthoringReferenceDiagnostic extends ReferenceSlot {
  code: 'invalid_reference_alias' | 'reference_index_out_of_range';
}
export type AuthoringRootFailure = 'invalid_envelope' | 'unsupported_version' | 'syntax_mismatch' | 'non_json_value' |
  'expanded_bytes_exceeded' | 'expanded_nodes_exceeded' | 'expanded_depth_exceeded';
export interface AuthoringMaterial {utf8Bytes: number; nodes: number; depth: number}
export type ConclusionAuthoringResult = {
  status: 'expanded';
  authoringVersion: ConclusionAuthoringVersion;
  /** Private original input, including invalid aliases. Never publish this field. */
  rawPayload: unknown;
  expandedPayload: Record<string, unknown>;
  material: AuthoringMaterial;
  referenceUses: AuthoringReferenceUse[];
  diagnostics: AuthoringReferenceDiagnostic[];
  /** Shape validation is deliberately left to the canonical reference validator. */
  unusedDictionaryEntries: {validation: 'not_checked'; count: number};
} | {
  status: 'invalid';
  rawPayload: unknown;
  code: AuthoringRootFailure;
  bindingEligibility: 'ineligible';
  canonicalRootRepairEligible: false;
};

const own = (value: object, key: PropertyKey) => Object.prototype.hasOwnProperty.call(value, key);
function jsonObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
function data(value: object, key: PropertyKey): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (!descriptor || !own(descriptor, 'value')) throw new InvalidJsonValue();
  return descriptor.value;
}
class InvalidJsonValue extends Error {}

/** @2 only: absent collections mean no submitted entries, never verified absence. */
const OPTIONAL_AUTHORING_V2_COLLECTIONS = ['conclusions', 'clusters', 'evidenceChain', 'uncertainties', 'nextSteps'] as const;

function compileValue(value: unknown, path: Path, version: ConclusionAuthoringVersion): unknown {
  if (version !== CONCLUSION_AUTHORING_VERSION_V2 || path.length !== 2 || typeof path[1] !== 'number' ||
      (path[0] !== 'uncertainties' && path[0] !== 'nextSteps') || !jsonObject(value)) return value;
  const keys = Reflect.ownKeys(value);
  if (keys.length !== 1 || keys[0] !== 'text') return value;
  const descriptor = Object.getOwnPropertyDescriptor(value, 'text')!;
  if (!own(descriptor, 'value')) throw new InvalidJsonValue();
  return descriptor.enumerable && typeof descriptor.value === 'string' ? descriptor.value : value;
}

function objectKeys(value: Record<string, unknown>, path: Path, version: ConclusionAuthoringVersion): string[] {
  const keys = Object.keys(value);
  if (version === CONCLUSION_AUTHORING_VERSION_V2 && path.length === 0) {
    keys.push(...OPTIONAL_AUTHORING_V2_COLLECTIONS.filter(key => !own(value, key)));
  }
  return keys;
}

function childValue(value: object, key: string | number, path: Path, version: ConclusionAuthoringVersion): unknown {
  if (version === CONCLUSION_AUTHORING_VERSION_V2 && path.length === 0 && !own(value, key) &&
      OPTIONAL_AUTHORING_V2_COLLECTIONS.some(field => field === key)) return [];
  return data(value, key);
}

/** Exact schema positions only; arbitrary objects called references are not aliases. */
function referenceSlot(path: Path): ReferenceSlot | undefined {
  const ordinal = typeof path[1] === 'number' ? path[1] + 1 : undefined;
  if (ordinal === undefined) return undefined;
  if (path[0] === 'claims') {
    if (path.length === 4 && path[2] === 'references' && typeof path[3] === 'number') {
      return {kind: 'claim_references', ordinal, referenceOrdinal: path[3] + 1};
    }
    if (path.length === 6 && path[2] === 'semantics' && path[3] === 'scope' && typeof path[5] === 'number') {
      if (path[4] === 'subjectRefs') return {kind: 'subject_refs', ordinal, referenceOrdinal: path[5] + 1};
      if (path[4] === 'objectRefs') return {kind: 'object_refs', ordinal, referenceOrdinal: path[5] + 1};
    }
  }
  if (path[0] === 'relationProposals' && path.length === 3) {
    if (path[2] === 'subject') return {kind: 'relation_subject', ordinal};
    if (path[2] === 'object') return {kind: 'relation_object', ordinal};
    if (path[2] === 'proof') return {kind: 'relation_proof', ordinal};
  }
  return undefined;
}

/** Compact JSON string size, stopping at remaining + 1 without materializing an escaped string. */
function stringBytes(value: string, remaining: number): number {
  let bytes = 2;
  for (let index = 0; index < value.length && bytes <= remaining; index++) {
    const code = value.charCodeAt(index);
    if (code === 34 || code === 92) bytes += 2;
    else if (code < 32) bytes += [8, 9, 10, 12, 13].includes(code) ? 2 : 6;
    else if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {bytes += 4; index++;} else bytes += 6;
    } else if (code >= 0xdc00 && code <= 0xdfff) bytes += 6;
    else bytes += code < 128 ? 1 : code < 2048 ? 2 : 3;
  }
  return Math.min(bytes, remaining + 1);
}

interface Preflight {
  material: AuthoringMaterial;
  referenceUses: AuthoringReferenceUse[];
  diagnostics: AuthoringReferenceDiagnostic[];
  used: Set<number>;
}

/** One-level substitution only: an entry containing another alias stays invalid canonical input. */
function resolveReference(value: unknown, path: Path, dictionary: readonly unknown[], observed?: Preflight): unknown {
  const slot = referenceSlot(path);
  if (!slot || !jsonObject(value) || !own(value, '$ref')) return value;
  const index = data(value, '$ref');
  if (Object.keys(value).length !== 1 || typeof index !== 'number' || !Number.isSafeInteger(index) || index < 0) {
    observed?.diagnostics.push({...slot, code: 'invalid_reference_alias'});
    return value;
  }
  if (index >= dictionary.length) {
    observed?.diagnostics.push({...slot, code: 'reference_index_out_of_range'});
    return value;
  }
  observed?.used.add(index);
  observed?.referenceUses.push({...slot, dictionaryIndex: index});
  return data(dictionary, index);
}

function preflight(contract: Record<string, unknown>, dictionary: readonly unknown[],
  version: ConclusionAuthoringVersion): Preflight | AuthoringRootFailure {
  const observed: Preflight = {material: {utf8Bytes: 0, nodes: 0, depth: 0}, referenceUses: [], diagnostics: [], used: new Set()};
  type Task = {value: unknown; path: Path; depth: number} | {leave: object};
  const stack: Task[] = [{value: contract, path: [], depth: 1}];
  const ancestors = new Set<object>();
  const addBytes = (bytes: number) => {
    observed.material.utf8Bytes = Math.min(CONCLUSION_AUTHORING_LIMITS.utf8Bytes + 1, observed.material.utf8Bytes + bytes);
  };
  const addString = (value: string) => addBytes(stringBytes(value, CONCLUSION_AUTHORING_LIMITS.utf8Bytes - observed.material.utf8Bytes));
  while (stack.length) {
    const task = stack.pop()!;
    if ('leave' in task) {ancestors.delete(task.leave); continue;}
    const {path, depth} = task;
    if (depth > CONCLUSION_AUTHORING_LIMITS.depth) return 'expanded_depth_exceeded';
    if (++observed.material.nodes > CONCLUSION_AUTHORING_LIMITS.nodes) return 'expanded_nodes_exceeded';
    observed.material.depth = Math.max(observed.material.depth, depth);
    const value = compileValue(resolveReference(task.value, path, dictionary, observed), path, version);
    if (value === null) addBytes(4);
    else if (typeof value === 'string') addString(value);
    else if (typeof value === 'boolean') addBytes(value ? 4 : 5);
    // JSON.parse can produce Infinity for a large exponent. Keep it for canonical rejection;
    // its compact JSON representation is null, not a repaired numeric assertion.
    else if (typeof value === 'number') addBytes(JSON.stringify(value).length);
    else if (Array.isArray(value) || jsonObject(value)) {
      if (ancestors.has(value)) return 'non_json_value';
      ancestors.add(value);
      stack.push({leave: value});
      const keys: Array<string | number> = Array.isArray(value)
        ? Array.from({length: Math.min(value.length, CONCLUSION_AUTHORING_LIMITS.nodes + 1)}, (_, index) => index)
        : objectKeys(value, path, version);
      if (keys.length + observed.material.nodes > CONCLUSION_AUTHORING_LIMITS.nodes) return 'expanded_nodes_exceeded';
      addBytes(2 + Math.max(0, keys.length - 1));
      for (let index = keys.length - 1; index >= 0; index--) {
        const key = keys[index];
        if (typeof key === 'string') {addString(key); addBytes(1);}
        if (observed.material.utf8Bytes > CONCLUSION_AUTHORING_LIMITS.utf8Bytes) return 'expanded_bytes_exceeded';
        stack.push({value: childValue(value, key, path, version), path: [...path, key], depth: depth + 1});
      }
    } else return 'non_json_value';
    if (observed.material.utf8Bytes > CONCLUSION_AUTHORING_LIMITS.utf8Bytes) return 'expanded_bytes_exceeded';
  }
  return observed;
}

/** Called only after preflight bounded the expanded tree to depth 24 and 10,000 nodes. */
function expand(value: unknown, path: Path, dictionary: readonly unknown[], version: ConclusionAuthoringVersion): unknown {
  const resolved = compileValue(resolveReference(value, path, dictionary), path, version);
  if (Array.isArray(resolved)) return resolved.map((item, index) => expand(item, [...path, index], dictionary, version));
  if (jsonObject(resolved)) return Object.fromEntries(objectKeys(resolved, path, version).map(key =>
    [key, expand(childValue(resolved, key, path, version), [...path, key], dictionary, version)]));
  return resolved;
}

/**
 * Decode an already parsed, explicit authoring payload. Does not find frames, parse prose,
 * validate canonical meaning, access captures or produce a verified/binding-eligible result.
 * Original input is retained privately; no input object is mutated.
 */
export function decodeConclusionAuthoring(rawPayload: unknown, expectedVersion?: ConclusionAuthoringVersion): ConclusionAuthoringResult {
  const invalid = (code: AuthoringRootFailure): ConclusionAuthoringResult => ({status: 'invalid', rawPayload, code,
    bindingEligibility: 'ineligible', canonicalRootRepairEligible: false});
  try {
    if (!jsonObject(rawPayload)) return invalid('invalid_envelope');
    const version = own(rawPayload, 'authoringVersion') ? data(rawPayload, 'authoringVersion') : undefined;
    if (version !== CONCLUSION_AUTHORING_VERSION && version !== CONCLUSION_AUTHORING_VERSION_V2) {
      return invalid('unsupported_version');
    }
    if (expectedVersion !== undefined && version !== expectedVersion) return invalid('syntax_mismatch');
    if (Object.keys(rawPayload).length !== 3 || !own(rawPayload, 'referenceDictionary') || !own(rawPayload, 'contract')) {
      return invalid('invalid_envelope');
    }
    const dictionary = data(rawPayload, 'referenceDictionary');
    const contract = data(rawPayload, 'contract');
    if (!Array.isArray(dictionary) || !jsonObject(contract)) return invalid('invalid_envelope');
    const checked = preflight(contract, dictionary, version);
    if (typeof checked === 'string') return invalid(checked);
    return {status: 'expanded', authoringVersion: version, rawPayload,
      expandedPayload: expand(contract, [], dictionary, version) as Record<string, unknown>,
      material: checked.material, referenceUses: checked.referenceUses, diagnostics: checked.diagnostics,
      unusedDictionaryEntries: {validation: 'not_checked', count: dictionary.length - checked.used.size}};
  } catch {
    return invalid('non_json_value');
  }
}
