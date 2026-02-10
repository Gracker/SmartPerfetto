/**
 * Intent Understanding Module (Multi-turn Enhanced)
 *
 * Parses user queries into structured Intent objects via LLM.
 * Now supports multi-turn dialogue by:
 * - Injecting conversation history context
 * - Detecting follow-up query types (drill_down, clarify, extend, compare)
 * - Extracting referenced entities from user query
 * - Providing extractedParams for skill invocation
 *
 * Falls back to a sensible default if LLM parsing fails.
 */

import { Intent, ReferencedEntity } from '../types';
import { ModelRouter } from './modelRouter';
import { ProgressEmitter } from './orchestratorTypes';
import { EnhancedSessionContext } from '../context/enhancedSessionContext';
import { isPlainObject, isStringArray, LlmJsonSchema, parseLlmJson } from '../../utils/llmJson';

const INTENT_JSON_SCHEMA: LlmJsonSchema<Intent> = {
  name: 'intent_json@1.0.0',
  validate: (value: unknown): value is Intent => {
    if (!isPlainObject(value)) return false;
    if (typeof value.primaryGoal !== 'string') return false;
    if (!isStringArray(value.aspects)) return false;
    if (!['diagnosis', 'comparison', 'timeline', 'summary'].includes(String(value.expectedOutputType))) {
      return false;
    }
    if (!['simple', 'moderate', 'complex'].includes(String(value.complexity))) return false;

    const followUpType = (value as any).followUpType;
    if (followUpType !== undefined && followUpType !== null) {
      if (!['initial', 'drill_down', 'clarify', 'extend', 'compare'].includes(String(followUpType))) {
        return false;
      }
    }

    const extractedParams = (value as any).extractedParams;
    if (extractedParams !== undefined && extractedParams !== null && !isPlainObject(extractedParams)) {
      return false;
    }

    const referencedEntities = (value as any).referencedEntities;
    if (referencedEntities !== undefined && referencedEntities !== null && !Array.isArray(referencedEntities)) {
      return false;
    }

    return true;
  },
};

/**
 * Understand user intent from a natural language query.
 * Uses LLM to extract primaryGoal, aspects, output type, complexity,
 * and for follow-up queries: followUpType, referencedEntities, extractedParams.
 *
 * @param query - User's natural language query
 * @param sessionContext - Optional session context for multi-turn support
 * @param modelRouter - Model router for LLM calls
 * @param emitter - Progress emitter for logging
 */
export async function understandIntent(
  query: string,
  sessionContext: EnhancedSessionContext | null,
  modelRouter: ModelRouter,
  emitter: ProgressEmitter
): Promise<Intent> {
  // Generate history context if we have prior turns
  const historyContext = sessionContext?.generatePromptContext(800) || '';
  const isFollowUp = sessionContext && sessionContext.getAllTurns().length > 0;

  // Get referenceable entities for LLM reference
  const referenceableEntities = sessionContext
    ? sessionContext.extractReferenceableEntities()
    : [];

  const prompt = buildMultiTurnIntentPrompt(
    query,
    historyContext,
    isFollowUp,
    referenceableEntities
  );

  try {
    const response = await modelRouter.callWithFallback(prompt, 'intent_understanding', {
      sessionId: sessionContext?.getSessionId(),
      traceId: sessionContext?.getTraceId(),
      jsonMode: true,
      promptId: 'agent.intentUnderstanding',
      promptVersion: '1.0.0',
      contractVersion: 'intent_json@1.0.0',
    });
    const parsed = parseLlmJson<Intent>(response.response, INTENT_JSON_SCHEMA);

    // Validate and normalize followUpType
    if (parsed.followUpType && !isValidFollowUpType(parsed.followUpType)) {
      parsed.followUpType = isFollowUp ? 'drill_down' : 'initial';
    }

    // Ensure extractedParams is an object
    if (parsed.extractedParams && typeof parsed.extractedParams !== 'object') {
      parsed.extractedParams = {};
    }

    // Deterministic normalization and ID extraction safeguard:
    // - normalize "1,435,508" style IDs
    // - backfill missing referencedEntities/extractedParams from query text
    // - backfill implicit references like "这一帧/该帧" from the last turn
    // - force drill_down when a specific frame/session ID is explicitly given in follow-up
    normalizeIntentEntityIds(parsed);
    const deterministicRefs = extractDeterministicEntityRefs(query);
    mergeDeterministicRefsIntoIntent(parsed, deterministicRefs);
    const implicitCarry = applyImplicitEntityCarryOver(parsed, query, isFollowUp, sessionContext);
    if (implicitCarry) {
      emitter.log(`Intent carry-over: resolved implicit ${implicitCarry.entityType} -> ${implicitCarry.entityId}`);
    }
    if ((isFollowUp || deterministicRefs.frameIds.length > 0 || deterministicRefs.sessionIds.length > 0 || deterministicRefs.startupIds.length > 0) &&
        hasSpecificEntityRef(parsed) &&
        parsed.followUpType !== 'compare' &&
        parsed.followUpType !== 'clarify') {
      parsed.followUpType = 'drill_down';
    }

    emitter.log(`Intent understood: ${parsed.primaryGoal} (followUp: ${parsed.followUpType || 'initial'})`);

    return parsed;
  } catch (error) {
    emitter.log(`Failed to parse intent: ${error}`);
    emitter.emitUpdate('degraded', { module: 'intentUnderstanding', fallback: 'rule-based default' });
  }

  // Fallback: simple heuristic-based intent
  return buildFallbackIntent(query, isFollowUp);
}

/**
 * Build the multi-turn aware intent prompt for LLM.
 */
function buildMultiTurnIntentPrompt(
  query: string,
  historyContext: string,
  isFollowUp: boolean | null,
  referenceableEntities: ReferencedEntity[]
): string {
  const followUpInstructions = isFollowUp
    ? `这是多轮对话的后续问题，请特别注意识别用户是否在引用之前发现的实体（如帧ID、会话ID等）。`
    : '';

  const entitiesSection = referenceableEntities.length > 0
    ? `## 可引用的实体（来自之前的分析）
${referenceableEntities.slice(0, 20).map(e => `- ${e.type}: ${e.id}`).join('\n')}
`
    : '';

  return `分析以下用户查询，提取分析意图。${followUpInstructions}

${historyContext ? `${historyContext}\n` : ''}
${entitiesSection}
用户查询: "${query}"

请以 JSON 格式返回：
{
  "primaryGoal": "用户的主要目标",
  "aspects": ["需要分析的方面"],
  "expectedOutputType": "diagnosis | comparison | timeline | summary",
  "complexity": "simple | moderate | complex",
  "followUpType": "${isFollowUp ? 'drill_down | clarify | extend | compare' : 'initial'}",
  "referencedEntities": [
    // 用户查询中引用的实体（如果有），例如:
    // { "type": "frame", "id": 456 }
    // { "type": "session", "id": 2 }
  ],
  "extractedParams": {
    // 可传递给 Skill 的参数（如果有），例如:
    // { "frame_id": 456, "session_id": 2 }
  }
}

## Follow-up 类型说明
- initial: 首次分析查询，没有历史上下文
- drill_down: 深入分析某个具体发现（如 "详细分析帧456"、"看一下 session 2"）
- clarify: 澄清或解释之前的发现（如 "什么是四象限分析"、"解释一下这个问题"）
- extend: 扩展分析范围（如 "还有哪些帧有类似问题"、"看看其他会话"）
- compare: 比较不同发现（如 "帧456和帧789有什么区别"）

## 实体提取规则
- 帧引用: "帧123"、"frame 123"、"第123帧"、"帧号123"、"frame_id=123" → { "type": "frame", "id": 123 }
- 会话引用: "会话2"、"session 2"、"第2个滑动会话"、"scroll session 2" → { "type": "session", "id": 2 }
- 启动引用: "启动12"、"startup 12"、"launch #12"、"启动事件12" → { "type": "startup", "id": 12 }
- 进程引用: "com.example.app"、"包名xxx" → { "type": "process", "id": "com.example.app" }
- 时间范围（支持多种格式）:
  - "从1.2秒到1.5秒" → { "type": "time_range", "value": { "start": "1.2s", "end": "1.5s" } }
  - "1.2s~1.5s"、"1.2-1.5秒" → 同上
  - "1200ms到1500ms"、"1200~1500ms" → { "type": "time_range", "value": { "start": "1200ms", "end": "1500ms" } }
  - "时间戳 123456789" → { "type": "timestamp", "value": "123456789" }
- 时间点引用: "1.2秒处"、"在1500ms"、"时间点xxx" → { "type": "timestamp", "value": "1.2s" }

## extractedParams 规则
- 将 referencedEntities 中的 id 转换为 skill 可用的参数
- frame 实体 → frame_id 参数
- session 实体 → session_id 参数
- startup 实体 → startup_id 参数
- process 实体 → process_name 参数`;
}

/**
 * Patterns for detecting drill-down intent from user query.
 * Covers common expressions in both Chinese and English.
 */
const DRILL_DOWN_PATTERNS = [
  // Explicit analysis requests
  /详细分析/, /看一下/, /分析[一下]?帧/, /分析[一下]?frame/,
  /查看/, /检查/, /深入/, /具体看/,
  // Entity references
  /frame(?:_id)?\s*[:=：#]?\s*[0-9][0-9,，_\s]*/i,
  /帧(?:号)?\s*[:=：#]?\s*[0-9][0-9,，_\s]*/,
  /[0-9][0-9,，_\s]*\s*这?一?帧/,
  /session\s*[:=：#]?\s*[0-9][0-9,，_\s]*/i,
  /会话\s*[:=：#]?\s*[0-9][0-9,，_\s]*/,
  /滑动会话\s*[:=：#]?\s*[0-9][0-9,，_\s]*/,
  /startup\s*[:=：#]?\s*[0-9][0-9,，_\s]*/i,
  /launch\s*[:=：#]?\s*[0-9][0-9,，_\s]*/i,
  /启动(?:事件)?\s*[:=：#]?\s*[0-9][0-9,，_\s]*/,
  // Time range references
  /从.*到.*秒/, /\d+\.?\d*\s*[秒s].*[到~\-].*\d+\.?\d*\s*[秒s]/i,
  /\d+\s*ms.*[到~\-].*\d+\s*ms/i,
  // "What happened" pattern
  /发生了什么/, /怎么了/, /为什么/,
];

function parseLooseInteger(input: any): number | null {
  if (input === null || input === undefined) return null;
  if (typeof input === 'number' && Number.isFinite(input)) {
    return Math.trunc(input);
  }
  const s = String(input).trim();
  if (!s) return null;
  // Support IDs like "1,435,508", "1 435 508", "1_435_508", "1，435，508".
  const normalized = s.replace(/[,\s，_]/g, '');
  if (!/^\d+$/.test(normalized)) return null;
  const n = Number(normalized);
  return Number.isFinite(n) ? n : null;
}

interface DeterministicEntityRefs {
  frameIds: number[];
  sessionIds: number[];
  startupIds: number[];
}

function extractDeterministicEntityRefs(query: string): DeterministicEntityRefs {
  const frameIds = new Set<number>();
  const sessionIds = new Set<number>();
  const startupIds = new Set<number>();

  const framePatterns = [
    /(?:frame(?:_id)?|frame\s*id|帧(?:号)?)\s*[:=：#]?\s*([0-9][0-9,，_\s]*)/gi,
    /第\s*([0-9][0-9,，_\s]*)\s*帧/gi,
    /([0-9][0-9,，_\s]*)\s*(?:这一帧|这帧|该帧|这个帧)/gi,
  ];

  const sessionPatterns = [
    /(?:session|会话|滑动会话)\s*[:=：#]?\s*([0-9][0-9,，_\s]*)/gi,
    /第\s*([0-9][0-9,，_\s]*)\s*(?:个)?\s*(?:会话|session)/gi,
  ];

  const startupPatterns = [
    /(?:startup|launch|启动(?:事件)?)\s*[:=：#]?\s*([0-9][0-9,，_\s]*)/gi,
    /第\s*([0-9][0-9,，_\s]*)\s*(?:个)?\s*(?:启动|startup|launch)/gi,
  ];

  for (const pattern of framePatterns) {
    for (const m of query.matchAll(pattern)) {
      const n = parseLooseInteger(m[1]);
      if (n !== null) frameIds.add(n);
    }
  }
  for (const pattern of sessionPatterns) {
    for (const m of query.matchAll(pattern)) {
      const n = parseLooseInteger(m[1]);
      if (n !== null) sessionIds.add(n);
    }
  }
  for (const pattern of startupPatterns) {
    for (const m of query.matchAll(pattern)) {
      const n = parseLooseInteger(m[1]);
      if (n !== null) startupIds.add(n);
    }
  }

  return {
    frameIds: Array.from(frameIds),
    sessionIds: Array.from(sessionIds),
    startupIds: Array.from(startupIds),
  };
}

function normalizeIntentEntityIds(intent: Intent): void {
  if (intent.extractedParams && typeof intent.extractedParams === 'object') {
    const frameId = parseLooseInteger((intent.extractedParams as any).frame_id ?? (intent.extractedParams as any).frameId);
    if (frameId !== null) {
      (intent.extractedParams as any).frame_id = frameId;
      delete (intent.extractedParams as any).frameId;
    }
    const sessionId = parseLooseInteger((intent.extractedParams as any).session_id ?? (intent.extractedParams as any).sessionId);
    if (sessionId !== null) {
      (intent.extractedParams as any).session_id = sessionId;
      delete (intent.extractedParams as any).sessionId;
    }
    const startupId = parseLooseInteger((intent.extractedParams as any).startup_id ?? (intent.extractedParams as any).startupId);
    if (startupId !== null) {
      (intent.extractedParams as any).startup_id = startupId;
      delete (intent.extractedParams as any).startupId;
    }
  }

  if (!Array.isArray(intent.referencedEntities)) return;
  intent.referencedEntities = intent.referencedEntities.map((entity) => {
    if (entity.type !== 'frame' && entity.type !== 'session' && entity.type !== 'startup') return entity;
    const id = entity.value !== undefined ? entity.value : entity.id;
    const normalized = parseLooseInteger(id);
    if (normalized === null) return entity;
    return { ...entity, id: normalized };
  });
}

function mergeDeterministicRefsIntoIntent(intent: Intent, refs: DeterministicEntityRefs): void {
  const extracted = intent.extractedParams || {};
  const referenced = Array.isArray(intent.referencedEntities) ? [...intent.referencedEntities] : [];

  if (refs.frameIds.length > 0) {
    if (parseLooseInteger((extracted as any).frame_id) === null) {
      (extracted as any).frame_id = refs.frameIds[0];
    }
    const hasFrameRef = referenced.some(e => e.type === 'frame');
    if (!hasFrameRef) referenced.push({ type: 'frame', id: refs.frameIds[0] });
  }

  if (refs.sessionIds.length > 0) {
    if (parseLooseInteger((extracted as any).session_id) === null) {
      (extracted as any).session_id = refs.sessionIds[0];
    }
    const hasSessionRef = referenced.some(e => e.type === 'session');
    if (!hasSessionRef) referenced.push({ type: 'session', id: refs.sessionIds[0] });
  }

  if (refs.startupIds.length > 0) {
    if (parseLooseInteger((extracted as any).startup_id) === null) {
      (extracted as any).startup_id = refs.startupIds[0];
    }
    const hasStartupRef = referenced.some(e => e.type === 'startup');
    if (!hasStartupRef) referenced.push({ type: 'startup', id: refs.startupIds[0] });
  }

  if (Object.keys(extracted).length > 0) intent.extractedParams = extracted;
  if (referenced.length > 0) intent.referencedEntities = referenced;
}

function hasSpecificEntityRef(intent: Intent): boolean {
  if (intent.extractedParams) {
    if (parseLooseInteger((intent.extractedParams as any).frame_id) !== null) return true;
    if (parseLooseInteger((intent.extractedParams as any).session_id) !== null) return true;
    if (parseLooseInteger((intent.extractedParams as any).startup_id) !== null) return true;
  }
  return !!intent.referencedEntities?.some(
    e => (e.type === 'frame' || e.type === 'session' || e.type === 'startup') && parseLooseInteger(e.id ?? e.value) !== null
  );
}

type ImplicitEntityType = 'frame' | 'session' | 'startup';

function inferImplicitEntityType(query: string): ImplicitEntityType | null {
  const q = String(query || '');
  if (/(这一帧|这帧|该帧|这个帧|\bthis frame\b|\bthat frame\b)/i.test(q)) {
    return 'frame';
  }
  if (/(这个会话|该会话|这次会话|这一会话|\bthis session\b|\bthat session\b)/i.test(q)) {
    return 'session';
  }
  if (/(这个启动|该启动|这次启动|这一启动|\bthis startup\b|\bthat startup\b|\bthis launch\b|\bthat launch\b)/i.test(q)) {
    return 'startup';
  }
  return null;
}

function applyImplicitEntityCarryOver(
  intent: Intent,
  query: string,
  isFollowUp: boolean | null,
  sessionContext: EnhancedSessionContext | null
): { entityType: ImplicitEntityType; entityId: number } | null {
  if (!isFollowUp || !sessionContext) return null;
  if (hasSpecificEntityRef(intent)) return null;

  const entityType = inferImplicitEntityType(query);
  if (!entityType) return null;

  const turns = sessionContext.getAllTurns();
  if (!Array.isArray(turns) || turns.length === 0) return null;

  for (let i = turns.length - 1; i >= 0; i -= 1) {
    const entityId = extractEntityIdFromTurn(turns[i], entityType);
    if (entityId === null) continue;

    const extracted = (intent.extractedParams && typeof intent.extractedParams === 'object')
      ? { ...intent.extractedParams }
      : {};

    if (entityType === 'frame') {
      (extracted as any).frame_id = entityId;
    } else if (entityType === 'session') {
      (extracted as any).session_id = entityId;
    } else {
      (extracted as any).startup_id = entityId;
    }
    intent.extractedParams = extracted;

    const refs = Array.isArray(intent.referencedEntities) ? [...intent.referencedEntities] : [];
    if (!refs.some(ref => ref.type === entityType)) {
      refs.push({ type: entityType, id: entityId });
    }
    intent.referencedEntities = refs;

    return { entityType, entityId };
  }

  return null;
}

function extractEntityIdFromTurn(turn: any, entityType: ImplicitEntityType): number | null {
  const intent = turn?.intent;
  if (intent && typeof intent === 'object') {
    const extracted = (intent as any).extractedParams;
    if (extracted && typeof extracted === 'object') {
      const id = entityType === 'frame'
        ? parseLooseInteger((extracted as any).frame_id ?? (extracted as any).frameId)
        : entityType === 'session'
          ? parseLooseInteger((extracted as any).session_id ?? (extracted as any).sessionId)
          : parseLooseInteger((extracted as any).startup_id ?? (extracted as any).startupId);
      if (id !== null) return id;
    }

    const refs = Array.isArray((intent as any).referencedEntities)
      ? (intent as any).referencedEntities as Array<Record<string, any>>
      : [];
    for (let i = refs.length - 1; i >= 0; i -= 1) {
      const ref = refs[i];
      if (!ref || ref.type !== entityType) continue;
      const raw = ref.value !== undefined ? ref.value : ref.id;
      const id = parseLooseInteger(raw);
      if (id !== null) return id;
    }
  }

  const findings = Array.isArray(turn?.findings) ? turn.findings : [];
  for (let i = findings.length - 1; i >= 0; i -= 1) {
    const details = findings[i]?.details;
    if (!details || typeof details !== 'object') continue;
    const id = entityType === 'frame'
      ? parseLooseInteger((details as any).frame_id ?? (details as any).frameId)
      : entityType === 'session'
        ? parseLooseInteger((details as any).session_id ?? (details as any).sessionId)
        : parseLooseInteger((details as any).startup_id ?? (details as any).startupId);
    if (id !== null) return id;
  }

  return null;
}

function buildFallbackIntent(query: string, isFollowUp: boolean | null): Intent {
  const refs = extractDeterministicEntityRefs(query);
  const hasEntityRef = refs.frameIds.length > 0 || refs.sessionIds.length > 0 || refs.startupIds.length > 0;
  const isDrillDown = hasEntityRef || DRILL_DOWN_PATTERNS.some(p => p.test(query));

  const extractedParams: Record<string, any> = {};
  const referencedEntities: ReferencedEntity[] = [];

  if (refs.frameIds.length > 0) {
    const id = refs.frameIds[0];
    extractedParams.frame_id = id;
    referencedEntities.push({ type: 'frame', id });
  }
  if (refs.sessionIds.length > 0) {
    const id = refs.sessionIds[0];
    extractedParams.session_id = id;
    referencedEntities.push({ type: 'session', id });
  }
  if (refs.startupIds.length > 0) {
    const id = refs.startupIds[0];
    extractedParams.startup_id = id;
    referencedEntities.push({ type: 'startup', id });
  }

  return {
    primaryGoal: query,
    aspects: ['general'],
    expectedOutputType: 'diagnosis',
    complexity: 'moderate',
    followUpType: isDrillDown ? 'drill_down' : (isFollowUp ? 'extend' : 'initial'),
    referencedEntities: referencedEntities.length > 0 ? referencedEntities : undefined,
    extractedParams: Object.keys(extractedParams).length > 0 ? extractedParams : undefined,
  };
}

/**
 * Validate follow-up type value
 */
function isValidFollowUpType(type: string): boolean {
  return ['initial', 'drill_down', 'clarify', 'extend', 'compare'].includes(type);
}
