import type { ConclusionSceneId } from './sceneTypes';

const SCENE_ASPECT_ALIAS_TABLE: Record<ConclusionSceneId, string[]> = {
  jank: ['jank', 'scroll', 'scrolling', 'frame', 'fps', 'stutter', 'lag', 'render'],
  startup: ['startup', 'launch', 'coldstart', 'warmstart', 'hotstart', 'ttid', 'ttfd'],
  navigation: ['navigation', 'transition', 'activity_switch', 'route', 'jump', 'screen_switch'],
  click_response: ['click', 'tap', 'interaction', 'input', 'latency', 'touch'],
  anr: ['anr', 'freeze', 'hang', 'deadlock', 'watchdog', 'notresponding'],
  memory: ['memory', 'gc', 'heap', 'oom', 'lmk', 'rss', 'pss', 'dmabuf'],
  cpu: ['cpu', 'sched', 'schedule', 'frequency', 'utilization', 'load', 'runnable'],
  binder: ['binder', 'ipc', 'transaction', 'lock_contention', 'lock'],
  io: ['io', 'disk', 'filesystem', 'storage', 'file', 'page_fault', 'blockio'],
  network: ['network', 'http', 'socket', 'rpc', 'dns', 'tls'],
  gpu: ['gpu', 'renderthread', 'surfaceflinger', 'hwc', 'composition', 'fence'],
  system: ['system', 'thermal', 'power', 'irq', 'kernel'],
  generic: [],
};

export function normalizeText(value: unknown): string {
  return String(value ?? '').trim().toLowerCase();
}

function normalizeSignalToken(value: string): string {
  return normalizeText(value).replace(/[，、]/g, ' ').replace(/\s+/g, ' ');
}

function splitSignalTokens(value: string): string[] {
  const normalized = normalizeSignalToken(value);
  if (!normalized) return [];
  return normalized
    .split(/[\s,\/|:_-]+/g)
    .map(part => part.trim())
    .filter(part => part.length > 0);
}

export function canonicalizeAspectSignal(signal: string): ConclusionSceneId | null {
  const normalized = normalizeSignalToken(signal).replace(/\s+/g, '');
  if (!normalized) return null;

  const aliases = Object.entries(SCENE_ASPECT_ALIAS_TABLE);
  for (const [sceneId, sceneAliases] of aliases) {
    if (sceneId === normalized) return sceneId;
    if (sceneAliases.some(alias => alias === normalized)) {
      return sceneId;
    }
  }

  return null;
}

export function buildAspectSignalSet(aspects: string[]): Set<string> {
  const signals = new Set<string>();

  for (const aspect of aspects || []) {
    const normalizedAspect = normalizeSignalToken(aspect);
    if (!normalizedAspect) continue;

    signals.add(normalizedAspect);
    const canonicalFromAspect = canonicalizeAspectSignal(normalizedAspect);
    if (canonicalFromAspect) signals.add(canonicalFromAspect);

    const tokens = splitSignalTokens(normalizedAspect);
    for (const token of tokens) {
      signals.add(token);
      const canonical = canonicalizeAspectSignal(token);
      if (canonical) signals.add(canonical);
    }
  }

  return signals;
}

export function signalMatchesHint(signal: string, hint: string): boolean {
  const normalizedSignal = normalizeSignalToken(signal);
  const normalizedHint = normalizeSignalToken(hint);
  if (!normalizedSignal || !normalizedHint) return false;
  return (
    normalizedSignal === normalizedHint ||
    normalizedSignal.includes(normalizedHint) ||
    normalizedHint.includes(normalizedSignal)
  );
}

