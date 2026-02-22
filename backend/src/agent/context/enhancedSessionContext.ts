/**
 * Enhanced Session Context - Phase 5 Multi-turn Dialogue Support
 *
 * Manages conversation history across multiple turns, enabling:
 * - Finding reference tracking between turns
 * - Context-aware response generation
 * - Intelligent context summarization for LLM
 */

import { v4 as uuidv4 } from 'uuid';
import crypto from 'crypto';
import {
  ConversationTurn,
  Finding,
  Intent,
  SubAgentResult,
  ContextSummary,
  FindingReference,
  ReferencedEntity,
} from '../types';
import type { AgentResponse } from '../types/agentProtocol';
import {
  EntityStore,
  createEntityStore,
  EntityStoreSnapshot,
} from './entityStore';
import {
  TraceAgentState,
  TraceAgentExperiment,
  createInitialTraceAgentState,
  migrateTraceAgentState,
  summarizeTraceAgentState,
} from '../state/traceAgentState';

// =============================================================================
// Semantic Working Memory (v2.0)
// =============================================================================

interface WorkingMemoryEntry {
  turnIndex: number;
  timestamp: number;
  query: string;
  confidence?: number;
  conclusions: string[];
  nextSteps: string[];
}

/**
 * Enhanced session context for multi-turn dialogue
 * Tracks conversation history and enables cross-turn finding references
 */
export class EnhancedSessionContext {
  private sessionId: string;
  private traceId: string;
  private turns: ConversationTurn[] = [];
  private findings: Map<string, Finding> = new Map();
  private findingTurnMap: Map<string, string> = new Map(); // findingId -> turnId
  private references: FindingReference[] = [];
  private topicsDiscussed: Set<string> = new Set();
  private openQuestions: string[] = [];
  private entityStore: EntityStore;
  private workingMemory: WorkingMemoryEntry[] = [];
  private traceAgentState: TraceAgentState | null = null;

  constructor(sessionId: string, traceId: string) {
    this.sessionId = sessionId;
    this.traceId = traceId;
    this.entityStore = createEntityStore();
  }

  // ==========================================================================
  // TraceAgentState (v1) - Goal-driven Agent scaffold
  // ==========================================================================

  /**
   * Get the current TraceAgentState (if any).
   */
  getTraceAgentState(): TraceAgentState | null {
    return this.traceAgentState;
  }

  /**
   * Get or create TraceAgentState for this (sessionId, traceId).
   * This is the durable single-source-of-truth used by the goal-driven agent loop.
   */
  getOrCreateTraceAgentState(userGoalSeed: string = ''): TraceAgentState {
    if (this.traceAgentState) return this.traceAgentState;
    this.traceAgentState = createInitialTraceAgentState({
      sessionId: this.sessionId,
      traceId: this.traceId,
      userGoal: userGoalSeed,
    });
    return this.traceAgentState;
  }

  /**
   * Replace TraceAgentState (e.g., restored from persistence).
   */
  setTraceAgentState(state: any): void {
    this.traceAgentState = migrateTraceAgentState(state, {
      sessionId: this.sessionId,
      traceId: this.traceId,
    });
  }

  /**
   * Refresh TraceAgentState.coverage deterministically from current caches.
   *
   * Coverage is used to:
   * - Avoid repeating experiments (planner sees what's already covered)
   * - Explain "why next" decisions (explicit scope rationale)
   *
   * Data sources (v1):
   * - EntityStore analyzed IDs → entities.frames/sessions
   * - Evidence provenance timeRange/agentId → timeRanges/domains
   */
  refreshTraceAgentCoverage(): void {
    if (!this.traceAgentState) return;
    const state = this.traceAgentState;

    const analyzedFrames = this.entityStore.getAnalyzedFrameIds().map(String);
    const analyzedSessions = this.entityStore.getAnalyzedSessionIds().map(String);

    const domains: string[] = [];
    const domainSeen = new Set<string>();

    const timeRanges: Array<{ start: string; end: string }> = [];
    const timeRangeSeen = new Set<string>();

    const packages: string[] = [];
    const packageSeen = new Set<string>();

    for (const ev of state.evidence) {
      const agentId = (ev as any)?.source?.agentId;
      if (typeof agentId === 'string' && agentId.trim()) {
        const domain = inferDomainFromAgentId(agentId);
        if (domain && !domainSeen.has(domain)) {
          domainSeen.add(domain);
          domains.push(domain);
        }
      }

      const pkg = (ev as any)?.source?.packageName;
      if (typeof pkg === 'string' && pkg.trim()) {
        const p = pkg.trim();
        if (!packageSeen.has(p)) {
          packageSeen.add(p);
          packages.push(p);
        }
      }

      const tr = (ev as any)?.source?.timeRange;
      if (tr && typeof tr === 'object') {
        const start = String((tr as any).start ?? '').trim();
        const end = String((tr as any).end ?? '').trim();
        if (start && end) {
          const k = `${start}..${end}`;
          if (!timeRangeSeen.has(k)) {
            timeRangeSeen.add(k);
            timeRanges.push({ start, end });
          }
        }
      }
    }

    // Bound growth: entities can be large; keep only recent tail (Set preserves insertion order).
    const boundedFrames = analyzedFrames.slice(-120);
    const boundedSessions = analyzedSessions.slice(-60);
    const boundedTimeRanges = timeRanges.slice(-20);
    const boundedDomains = domains.slice(-20);
    const boundedPackages = packages.slice(-20);

    const nextCoverage = {
      entities: { frames: boundedFrames, sessions: boundedSessions },
      timeRanges: boundedTimeRanges,
      domains: boundedDomains,
      packages: boundedPackages,
    };

    const prev = state.coverage;
    const changed =
      JSON.stringify(prev?.entities?.frames || []) !== JSON.stringify(nextCoverage.entities.frames) ||
      JSON.stringify(prev?.entities?.sessions || []) !== JSON.stringify(nextCoverage.entities.sessions) ||
      JSON.stringify(prev?.timeRanges || []) !== JSON.stringify(nextCoverage.timeRanges) ||
      JSON.stringify(prev?.domains || []) !== JSON.stringify(nextCoverage.domains) ||
      JSON.stringify((prev as any)?.packages || []) !== JSON.stringify(nextCoverage.packages);

    if (changed) {
      state.coverage = nextCoverage;
      state.updatedAt = Date.now();
    }
  }

  /**
   * Update goal fields from intent understanding (best-effort).
   */
  updateTraceAgentGoalFromIntent(primaryGoal?: string): void {
    if (!primaryGoal) return;
    const state = this.getOrCreateTraceAgentState(primaryGoal);
    state.goal.normalizedGoal = primaryGoal;
    state.updatedAt = Date.now();
  }

  /**
   * Append a turn log entry (minimal audit trail in v1).
   */
  recordTraceAgentTurn(params: {
    turnId: string;
    turnIndex: number;
    query: string;
    followUpType?: string;
    intentPrimaryGoal?: string;
    conclusion?: string;
    confidence?: number;
  }): void {
    const state = this.getOrCreateTraceAgentState(params.intentPrimaryGoal || params.query);
    const summary = params.conclusion
      ? extractBulletsFromMarkdownSection(params.conclusion, /^##\s*结论/)[0]
      : undefined;

    state.turnLog.push({
      id: params.turnId,
      turnIndex: params.turnIndex,
      timestamp: Date.now(),
      query: params.query,
      followUpType: params.followUpType,
      intentPrimaryGoal: params.intentPrimaryGoal,
      conclusionSummary: summary,
      confidence: params.confidence,
    });

    // Bound growth (v1): keep last 30 turns.
    if (state.turnLog.length > 30) {
      state.turnLog = state.turnLog.slice(-30);
    }

    state.updatedAt = Date.now();
  }

  /**
   * Ingest tool outputs as durable evidence digests (v1).
   * This lets later stages build "evidence chains" with provenance instead of free-text.
   *
   * Note: we intentionally store only compact digests here to keep state small.
   */
  ingestEvidenceFromResponses(
    responses: AgentResponse[],
    hint?: { stageName?: string; round?: number }
  ): string[] {
    if (!Array.isArray(responses) || responses.length === 0) return [];

    const state = this.getOrCreateTraceAgentState('');
    const existingIds = new Set(state.evidence.map(e => e.id));
    const producedEvidenceIds: string[] = [];
    const now = Date.now();

    // Soft cap to avoid unbounded growth in early milestones.
    const MAX_TOOL_RESULTS_PER_CALL = 40;
    let processedToolResults = 0;
    let addedEvidenceCount = 0;

    const ensureEvidenceIdOnFinding = (finding: any, refs: Array<{ evidenceId: string; kind: string; title: string }>) => {
      if (!finding || refs.length === 0) return;
      const existing = Array.isArray(finding.evidence) ? finding.evidence : (finding.evidence ? [finding.evidence] : []);
      const existingIds = new Set(
        existing
          .map((e: any) => (e && typeof e === 'object' ? (e.evidenceId || e.evidence_id) : undefined))
          .filter((v: any) => typeof v === 'string' && v.trim().length > 0)
      );

      const merged = [...existing];
      for (const ref of refs) {
        if (!existingIds.has(ref.evidenceId)) {
          merged.push(ref);
          existingIds.add(ref.evidenceId);
        }
      }

      // Keep evidence list small for prompt efficiency.
      finding.evidence = merged.slice(0, 10);
    };

    const hasEvidenceId = (finding: any): boolean => {
      if (!finding) return false;
      const existing = Array.isArray(finding.evidence) ? finding.evidence : (finding.evidence ? [finding.evidence] : []);
      return existing.some((e: any) => {
        if (!e) return false;
        if (typeof e === 'string') return /^ev_[0-9a-f]{12}$/.test(e.trim());
        if (typeof e === 'object') {
          const id = (e as any).evidenceId || (e as any).evidence_id;
          return typeof id === 'string' && /^ev_[0-9a-f]{12}$/.test(id.trim());
        }
        return false;
      });
    };

    for (const response of responses) {
      if (processedToolResults >= MAX_TOOL_RESULTS_PER_CALL) break;
      const toolResults = Array.isArray(response.toolResults) ? response.toolResults : [];
      if (toolResults.length === 0) continue;

      const perResponseEvidenceRefs: Array<{ evidenceId: string; kind: string; title: string }> = [];

      for (const tr of toolResults) {
        if (processedToolResults >= MAX_TOOL_RESULTS_PER_CALL) break;
        processedToolResults++;

        const metaRaw = (tr as any)?.metadata;
        const meta: Record<string, any> =
          metaRaw && typeof metaRaw === 'object' && !Array.isArray(metaRaw) ? metaRaw : {};
        // Ensure metadata is always an object so we can attach evidenceId deterministically.
        (tr as any).metadata = meta;

        const toolName = typeof meta.toolName === 'string'
          ? meta.toolName
          : typeof meta.skillId === 'string'
            ? meta.skillId
            : 'unknown_tool';

        const kind: 'sql' | 'skill' | 'derived' = inferEvidenceKind(tr, meta);
        const title = `[${response.agentId}] ${toolName}`;
        const digest = buildToolResultDigest(tr, { stageName: hint?.stageName, round: hint?.round });

        const key = `${state.traceId}|${kind}|${title}|${digest}`;
        const id = `ev_${crypto.createHash('sha1').update(key).digest('hex').slice(0, 12)}`;
        meta.evidenceId = id;

        perResponseEvidenceRefs.push({ evidenceId: id, kind, title });
        producedEvidenceIds.push(id);

        // Prefer tight binding: attach this evidenceId to findings produced by this tool result.
        // (response.findings is usually a concatenation of toolResult.findings, so this propagates.)
        if (Array.isArray((tr as any).findings) && (tr as any).findings.length > 0) {
          for (const finding of (tr as any).findings) {
            ensureEvidenceIdOnFinding(finding, [{ evidenceId: id, kind, title }]);
          }
        }

        if (!existingIds.has(id)) {
          state.evidence.push({
            id,
            kind,
            title,
            digest,
            traceId: state.traceId,
            createdAt: now,
            source: {
              agentId: response.agentId,
              toolName,
              skillId: typeof meta.skillId === 'string' ? meta.skillId : undefined,
              executionMode: meta.executionMode,
              ...(meta.scopeLabel && { scopeLabel: meta.scopeLabel }),
              ...(meta.group && { group: meta.group }),
              ...(meta.timeRange && { timeRange: meta.timeRange }),
              ...(meta.packageName && { packageName: meta.packageName }),
              ...(hint?.stageName && { stageName: hint.stageName }),
              ...(typeof hint?.round === 'number' && { round: hint.round }),
            },
          });

          existingIds.add(id);
          addedEvidenceCount++;
        }
      }

      // Best-effort: attach evidence references to findings in this response,
      // so downstream synthesis/conclusion can build auditable evidence chains.
      if (perResponseEvidenceRefs.length > 0 && Array.isArray((response as any).findings)) {
        // Dedupe refs per response while preserving order.
        const seen = new Set<string>();
        const refs = perResponseEvidenceRefs.filter(r => {
          if (!r?.evidenceId) return false;
          if (seen.has(r.evidenceId)) return false;
          seen.add(r.evidenceId);
          return true;
        }).slice(0, 6);

        for (const finding of (response as any).findings) {
          // Only attach broad refs when the finding has no evidence binding.
          if (!hasEvidenceId(finding)) {
            ensureEvidenceIdOnFinding(finding, refs);
          }
        }
      }
    }

    // Bound total evidence (digest-only, but still keep it under control).
    const MAX_TOTAL_EVIDENCE = 500;
    if (state.evidence.length > MAX_TOTAL_EVIDENCE) {
      state.evidence = state.evidence.slice(-MAX_TOTAL_EVIDENCE);
    }

    if (addedEvidenceCount > 0) {
      state.updatedAt = now;
    }

    // Return all evidence IDs produced/observed in this call (deduped, in order).
    const seen = new Set<string>();
    return producedEvidenceIds.filter(id => {
      if (!id) return false;
      if (seen.has(id)) return false;
      seen.add(id);
      return true;
    });
  }

  /**
   * Add a single compact evidence digest (derived from multiple tool outputs, summaries, etc.).
   */
  addEvidenceDigest(params: {
    kind: 'sql' | 'skill' | 'derived';
    title: string;
    digest: string;
    source?: Record<string, any>;
  }): string {
    const state = this.getOrCreateTraceAgentState('');
    const key = `${state.traceId}|${params.kind}|${params.title}|${params.digest}`;
    const id = `ev_${crypto.createHash('sha1').update(key).digest('hex').slice(0, 12)}`;

    const existing = state.evidence.find(e => e.id === id);
    if (existing) return existing.id;

    state.evidence.push({
      id,
      kind: params.kind,
      title: params.title,
      digest: params.digest,
      traceId: state.traceId,
      createdAt: Date.now(),
      source: params.source,
    });

    const MAX_TOTAL_EVIDENCE = 500;
    if (state.evidence.length > MAX_TOTAL_EVIDENCE) {
      state.evidence = state.evidence.slice(-MAX_TOTAL_EVIDENCE);
    }

    state.updatedAt = Date.now();
    return id;
  }

  /**
   * Start an "experiment" (goal-driven agent loop primitive).
   * Experiments are the unit of work we budget (maxExperimentsPerTurn).
   */
  startTraceAgentExperiment(params: {
    type: TraceAgentExperiment['type'];
    objective: string;
  }): string {
    const state = this.getOrCreateTraceAgentState(params.objective || '');
    const now = Date.now();
    const id = `exp_${uuidv4()}`;

    state.experiments.push({
      id,
      type: params.type,
      objective: params.objective,
      status: 'running',
      createdAt: now,
      updatedAt: now,
      producedEvidenceIds: [],
    });

    // Bound growth (v1): keep last 80 experiments per trace.
    if (state.experiments.length > 80) {
      state.experiments = state.experiments.slice(-80);
    }

    state.updatedAt = now;
    return id;
  }

  /**
   * Complete an experiment and attach produced evidence IDs.
   */
  completeTraceAgentExperiment(params: {
    id: string;
    status: TraceAgentExperiment['status'];
    producedEvidenceIds?: string[];
    error?: string;
  }): void {
    const state = this.getOrCreateTraceAgentState('');
    const exp = state.experiments.find(e => e.id === params.id);
    if (!exp) return;

    const now = Date.now();
    exp.status = params.status;
    exp.updatedAt = now;
    if (typeof params.error === 'string' && params.error.trim()) {
      exp.error = params.error.trim();
    }

    if (Array.isArray(params.producedEvidenceIds) && params.producedEvidenceIds.length > 0) {
      const merged = new Set([...(exp.producedEvidenceIds || []), ...params.producedEvidenceIds]);
      exp.producedEvidenceIds = Array.from(merged);
    }

    state.updatedAt = now;
  }

  /**
   * Record a contradiction (data conflict) detected during synthesis.
   */
  recordTraceAgentContradiction(params: {
    description: string;
    severity?: 'minor' | 'major' | 'critical';
    evidenceIds?: string[];
    hypothesisIds?: string[];
  }): string | null {
    const description = String(params.description || '').trim();
    if (!description) return null;

    const state = this.getOrCreateTraceAgentState('');
    const key = `${state.traceId}|${description}`;
    const id = `cx_${crypto.createHash('sha1').update(key).digest('hex').slice(0, 12)}`;

    const existing = state.contradictions.find(c => c.id === id);
    if (existing) return existing.id;

    state.contradictions.push({
      id,
      description,
      severity: params.severity || 'major',
      createdAt: Date.now(),
      evidenceIds: Array.isArray(params.evidenceIds) ? params.evidenceIds.map(String) : [],
      hypothesisIds: Array.isArray(params.hypothesisIds) ? params.hypothesisIds.map(String) : [],
      resolutionExperimentIds: [],
    });

    // Bound growth (v1): keep last 40 contradictions.
    if (state.contradictions.length > 40) {
      state.contradictions = state.contradictions.slice(-40);
    }

    state.updatedAt = Date.now();
    return id;
  }

  /**
   * Get the entity store for frame/session caching.
   * Used by follow-up resolution and drill-down executor.
   */
  getEntityStore(): EntityStore {
    return this.entityStore;
  }

  /**
   * Add a new conversation turn
   */
  addTurn(
    query: string,
    intent: Intent,
    result?: SubAgentResult,
    turnFindings?: Finding[]
  ): ConversationTurn {
    const turnId = uuidv4();
    const turnIndex = this.turns.length;
    const findings = turnFindings || [];

    // Register findings
    for (const finding of findings) {
      this.findings.set(finding.id, finding);
      this.findingTurnMap.set(finding.id, turnId);
    }

    // Extract topics from intent
    if (intent.primaryGoal) {
      this.topicsDiscussed.add(intent.primaryGoal);
    }
    if (intent.aspects) {
      for (const aspect of intent.aspects) {
        this.topicsDiscussed.add(aspect);
      }
    }

    const turn: ConversationTurn = {
      id: turnId,
      timestamp: Date.now(),
      query,
      intent,
      result,
      findings,
      turnIndex,
      completed: !!result
    };

    this.turns.push(turn);
    return turn;
  }

  /**
   * Mark a turn as completed
   */
  completeTurn(turnId: string, result: SubAgentResult, newFindings?: Finding[]): void {
    const turn = this.turns.find(t => t.id === turnId);
    if (turn) {
      turn.result = result;
      turn.completed = true;

      if (newFindings) {
        for (const finding of newFindings) {
          this.findings.set(finding.id, finding);
          this.findingTurnMap.set(finding.id, turnId);
          turn.findings.push(finding);
        }
      }
    }
  }

  /**
   * Get a specific finding by ID
   */
  getFinding(id: string): Finding | undefined {
    return this.findings.get(id);
  }

  /**
   * Get all findings from a specific turn
   */
  getFindingsFromTurn(turnId: string): Finding[] {
    const turn = this.turns.find(t => t.id === turnId);
    return turn?.findings || [];
  }

  /**
   * Get the turn where a finding was discovered
   */
  getTurnForFinding(findingId: string): ConversationTurn | undefined {
    const turnId = this.findingTurnMap.get(findingId);
    if (!turnId) return undefined;
    return this.turns.find(t => t.id === turnId);
  }

  /**
   * Add a reference between findings
   */
  addFindingReference(
    fromFindingId: string,
    toFindingId: string,
    refType: FindingReference['refType']
  ): void {
    const fromTurnId = this.findingTurnMap.get(fromFindingId);
    if (fromTurnId) {
      this.references.push({
        findingId: toFindingId,
        turnId: fromTurnId,
        refType
      });
    }
  }

  /**
   * Query context by keywords - returns relevant turns
   */
  queryContext(keywords: string[]): ConversationTurn[] {
    if (!keywords || keywords.length === 0) {
      return [...this.turns];
    }

    const lowerKeywords = keywords.map(k => k.toLowerCase());

    return this.turns.filter(turn => {
      // Check query
      const queryMatch = lowerKeywords.some(kw =>
        turn.query.toLowerCase().includes(kw)
      );

      // Check intent
      const intentMatch = lowerKeywords.some(kw =>
        turn.intent.primaryGoal.toLowerCase().includes(kw) ||
        turn.intent.aspects.some(a => a.toLowerCase().includes(kw))
      );

      // Check findings
      const findingMatch = turn.findings.some(f =>
        lowerKeywords.some(kw =>
          f.title.toLowerCase().includes(kw) ||
          f.description.toLowerCase().includes(kw)
        )
      );

      return queryMatch || intentMatch || findingMatch;
    });
  }

  /**
   * Add an open question
   */
  addOpenQuestion(question: string): void {
    if (!this.openQuestions.includes(question)) {
      this.openQuestions.push(question);
    }
  }

  /**
   * Resolve/remove an open question
   */
  resolveQuestion(question: string): void {
    const index = this.openQuestions.indexOf(question);
    if (index > -1) {
      this.openQuestions.splice(index, 1);
    }
  }

  /**
   * Generate a context summary for LLM consumption
   * This creates a compact representation for context-aware prompts
   */
  generateContextSummary(): ContextSummary {
    // Build conversation summary
    const conversationParts: string[] = [];
    for (const turn of this.turns) {
      const findingsSummary = turn.findings.length > 0
        ? `发现 ${turn.findings.length} 个问题`
        : '无重要发现';
      conversationParts.push(
        `[Turn ${turn.turnIndex + 1}] 用户问: "${turn.query.substring(0, 50)}..." → ${findingsSummary}`
      );
    }

    // Extract key findings (high severity)
    const keyFindings = Array.from(this.findings.values())
      .filter(f => ['critical', 'high', 'warning'].includes(f.severity))
      .map(f => {
        const turnId = this.findingTurnMap.get(f.id);
        const turn = this.turns.find(t => t.id === turnId);
        return {
          id: f.id,
          title: f.title,
          severity: f.severity,
          turnIndex: turn?.turnIndex ?? -1
        };
      })
      .slice(0, 10); // Limit to top 10

    return {
      turnCount: this.turns.length,
      conversationSummary: conversationParts.join('\n'),
      keyFindings,
      topicsDiscussed: Array.from(this.topicsDiscussed),
      openQuestions: [...this.openQuestions]
    };
  }

  /**
   * Generate a prompt-friendly context string
   * Used for injecting context into LLM prompts
   *
   * Enhanced to include referenceable entity identifiers (frame_id, session_id)
   * so LLM can understand what entities are available for drill-down.
   */
  generatePromptContext(maxTokens: number = 500): string {
    const summary = this.generateContextSummary();

    const parts: string[] = [];

    // Goal-driven agent scaffold: surface stable goal & preferences.
    if (this.traceAgentState) {
      const s = summarizeTraceAgentState(this.traceAgentState);
      if (s.goal) {
        parts.push('## 目标与偏好');
        parts.push(`- 目标: ${s.goal}`);
        parts.push(`- 每轮最多实验: ${s.maxExperimentsPerTurn}`);
        parts.push('');
      }

      // Coverage helps "what we've already covered" and "what's missing" reasoning.
      const cv = this.traceAgentState.coverage;
      if (cv) {
        const domains = Array.isArray(cv.domains) ? cv.domains : [];
        const frameCount = Array.isArray(cv.entities?.frames) ? cv.entities.frames.length : 0;
        const sessionCount = Array.isArray(cv.entities?.sessions) ? cv.entities.sessions.length : 0;
        const trCount = Array.isArray(cv.timeRanges) ? cv.timeRanges.length : 0;
        const packages = Array.isArray((cv as any).packages) ? (cv as any).packages : [];

        const domainStr = domains.length > 0 ? domains.slice(-8).join(', ') : '无';
        const pkgStr = packages.length > 0 ? packages.slice(-6).join(', ') : '无';
        const tailRanges = Array.isArray(cv.timeRanges)
          ? cv.timeRanges.slice(-2).map(r => `${String(r.start).slice(0, 12)}..${String(r.end).slice(0, 12)}`)
          : [];

        parts.push('## 覆盖度（已分析范围）');
        parts.push(`- domains: ${domainStr}`);
        parts.push(`- entities: frames=${frameCount}, sessions=${sessionCount}`);
        parts.push(`- packages: ${pkgStr}`);
        parts.push(`- timeRanges: ${trCount}${tailRanges.length > 0 ? ` (tail: ${tailRanges.join(' | ')})` : ''}`);
        parts.push('');
      }

      // Recent experiments + evidence digests help the LLM avoid repeating work.
      const expTail = this.traceAgentState.experiments.slice(-3);
      if (expTail.length > 0) {
        parts.push('## 最近实验（执行记录）');
        for (const e of expTail) {
          const evCount = Array.isArray(e.producedEvidenceIds) ? e.producedEvidenceIds.length : 0;
          parts.push(`- [${e.status}] ${e.objective}${evCount ? ` (evidence ${evCount})` : ''}`);
        }
        parts.push('');
      }

      const evTail = this.traceAgentState.evidence.slice(-8);
      if (evTail.length > 0) {
        parts.push('## 证据摘要（可引用）');
        for (const ev of evTail) {
          const digest = typeof ev.digest === 'string' ? ev.digest.slice(0, 140) : '';
          parts.push(`- (${ev.id}) ${ev.title}: ${digest}`);
        }
        parts.push('');
      }

      const cxTail = this.traceAgentState.contradictions.slice(-3);
      if (cxTail.length > 0) {
        parts.push('## 已检测到的矛盾（待解释/待消解）');
        for (const c of cxTail) {
          parts.push(`- [${c.severity}] ${c.description}`);
        }
        parts.push('');
      }
    }

    // Semantic working memory: stable, cross-turn digest to reduce mechanical "last N turns" loss.
    const workingMemoryContext = this.generateWorkingMemoryContext(6);
    if (workingMemoryContext) {
      parts.push('## 语义记忆（跨轮次摘要）');
      parts.push(workingMemoryContext);
      parts.push('');
    }

    // Add turn count
    parts.push(`## 对话历史 (${summary.turnCount} 轮)`);

    // More detailed turn summaries with referenceable identifiers
    for (const turn of this.turns.slice(-3)) {
      // Extract identifiers from findings that can be referenced in follow-up
      const identifiers = turn.findings
        .filter(f => f.details?.frame_id || f.details?.session_id)
        .slice(0, 5)
        .map(f => {
          const ids: string[] = [];
          if (f.details?.frame_id) ids.push(`frame_id=${f.details.frame_id}`);
          if (f.details?.session_id) ids.push(`session_id=${f.details.session_id}`);
          return ids.join(', ');
        })
        .filter(Boolean);

      const truncatedQuery = turn.query.length > 40
        ? turn.query.substring(0, 40) + '...'
        : turn.query;

      parts.push(`\n### Turn ${turn.turnIndex + 1}: "${truncatedQuery}"`);

      // Show severity-prioritized findings
      for (const finding of turn.findings.slice(0, 5)) {
        parts.push(`  - [${finding.severity}] ${finding.title}`);
      }

      // Show referenceable identifiers for drill-down
      if (identifiers.length > 0) {
        parts.push(`  可引用实体: ${identifiers.join('; ')}`);
      }
    }

    // Add key findings with identifiers
    if (summary.keyFindings.length > 0) {
      parts.push('\n## 关键发现');
      for (const finding of summary.keyFindings.slice(0, 5)) {
        parts.push(`- [${finding.severity}] ${finding.title}`);
      }
    }

    // Add topics
    if (summary.topicsDiscussed.length > 0) {
      parts.push(`\n## 讨论主题: ${summary.topicsDiscussed.slice(0, 5).join(', ')}`);
    }

    // Add open questions
    if (summary.openQuestions.length > 0) {
      parts.push('\n## 待回答问题');
      for (const q of summary.openQuestions.slice(0, 3)) {
        parts.push(`- ${q}`);
      }
    }

    const result = parts.join('\n');

    // Rough token estimation (4 chars ≈ 1 token for Chinese)
    const estimatedTokens = Math.ceil(result.length / 4);
    if (estimatedTokens > maxTokens) {
      // Truncate if too long
      const ratio = maxTokens / estimatedTokens;
      return result.substring(0, Math.floor(result.length * ratio)) + '...';
    }

    return result;
  }

  // ==========================================================================
  // Semantic Working Memory (v2.0)
  // ==========================================================================

  /**
   * Update semantic working memory using the final assistant conclusion.
   * This is deterministic (no extra LLM calls) and designed for prompt injection.
   */
  updateWorkingMemoryFromConclusion(params: {
    turnIndex: number;
    query: string;
    conclusion: string;
    confidence?: number;
  }): void {
    const conclusions = sanitizeWorkingMemoryBullets(
      extractBulletsFromMarkdownSection(params.conclusion, /^##\s*结论/),
      6
    );
    const nextSteps = sanitizeWorkingMemoryBullets(
      extractBulletsFromMarkdownSection(params.conclusion, /^##\s*下一步/),
      4
    );
    const fallbackConclusions = sanitizeWorkingMemoryBullets(this.fallbackKeyFindingTitles(3), 3);

    const entry: WorkingMemoryEntry = {
      turnIndex: params.turnIndex,
      timestamp: Date.now(),
      query: params.query,
      confidence: params.confidence,
      conclusions: conclusions.length > 0 ? conclusions : fallbackConclusions,
      nextSteps,
    };

    this.workingMemory.push(entry);

    // Bounded memory: keep last 12 entries (older turns already covered by summaries/findings).
    if (this.workingMemory.length > 12) {
      this.workingMemory = this.workingMemory.slice(-12);
    }
  }

  /**
   * Build a short, prompt-friendly semantic memory context.
   */
  private generateWorkingMemoryContext(maxEntries: number): string {
    if (this.workingMemory.length === 0) return '';

    const entries = this.workingMemory.slice(-maxEntries);
    const lines: string[] = [];

    for (const e of entries) {
      const q = e.query.length > 60 ? e.query.slice(0, 60) + '…' : e.query;
      const c = e.conclusions.slice(0, 3).map(s => `- ${s}`);
      const n = e.nextSteps.slice(0, 2).map(s => `- ${s}`);
      const conf = typeof e.confidence === 'number' ? ` (confidence ${(e.confidence * 100).toFixed(0)}%)` : '';

      lines.push(`### Turn ${e.turnIndex + 1}${conf}: "${q}"`);
      if (c.length > 0) {
        lines.push('结论:');
        lines.push(...c);
      }
      if (n.length > 0) {
        lines.push('下一步:');
        lines.push(...n);
      }
    }

    return lines.join('\n');
  }

  private fallbackKeyFindingTitles(limit: number): string[] {
    const all = this.getAllFindings();
    const sorted = [...all].sort((a, b) => (b.confidence || 0) - (a.confidence || 0));
    return sorted.slice(0, limit).map(f => f.title);
  }

  /**
   * Extract referenceable entities from all findings
   *
   * Returns entities (frames, sessions, etc.) that can be referenced
   * in follow-up queries. Used by LLM to understand what drill-down
   * targets are available.
   *
   * Priority: EntityStore (richer + stable) -> findings scan (fallback)
   */
  extractReferenceableEntities(): ReferencedEntity[] {
    const entities: ReferencedEntity[] = [];
    const seen = new Set<string>();

    // 1. First, extract from EntityStore (preferred source - richer data)
    for (const frame of this.entityStore.getAllFrames()) {
      const key = `frame:${frame.frame_id}`;
      if (!seen.has(key)) {
        seen.add(key);
        entities.push({
          type: 'frame',
          id: frame.frame_id,
          value: {
            start_ts: frame.start_ts,
            end_ts: frame.end_ts,
            process_name: frame.process_name,
            session_id: frame.session_id,
            jank_type: frame.jank_type,
            dur_ms: frame.dur_ms,
            main_start_ts: frame.main_start_ts,
            main_end_ts: frame.main_end_ts,
            render_start_ts: frame.render_start_ts,
            render_end_ts: frame.render_end_ts,
            pid: frame.pid,
            layer_name: frame.layer_name,
            vsync_missed: frame.vsync_missed,
          },
          // EntityStore doesn't track turn, use -1 to indicate store source
          fromTurn: -1,
        });
      }
    }

    for (const session of this.entityStore.getAllSessions()) {
      const key = `session:${session.session_id}`;
      if (!seen.has(key)) {
        seen.add(key);
        entities.push({
          type: 'session',
          id: session.session_id,
          value: {
            start_ts: session.start_ts,
            end_ts: session.end_ts,
            process_name: session.process_name,
            frame_count: session.frame_count,
            jank_count: session.jank_count,
            max_vsync_missed: session.max_vsync_missed,
            jank_types: session.jank_types,
          },
          fromTurn: -1,
        });
      }
    }

    // 2. Then, scan findings for any entities not in store (fallback)
    for (const turn of this.turns) {
      for (const finding of turn.findings) {
        // Extract frame_id entities
        if (finding.details?.frame_id !== undefined) {
          const key = `frame:${finding.details.frame_id}`;
          if (!seen.has(key)) {
            seen.add(key);
            entities.push({
              type: 'frame',
              id: finding.details.frame_id,
              value: {
                start_ts: finding.details.start_ts,
                end_ts: finding.details.end_ts,
                process_name: finding.details.process_name,
                ...finding.details,
              },
              fromTurn: turn.turnIndex,
            });
          }
        }

        // Extract session_id entities
        if (finding.details?.session_id !== undefined) {
          const key = `session:${finding.details.session_id}`;
          if (!seen.has(key)) {
            seen.add(key);
            entities.push({
              type: 'session',
              id: finding.details.session_id,
              value: {
                start_ts: finding.details.start_ts,
                end_ts: finding.details.end_ts,
                process_name: finding.details.process_name,
                ...finding.details,
              },
              fromTurn: turn.turnIndex,
            });
          }
        }

        // Extract process entities from various fields
        const processName = finding.details?.process_name || finding.details?.package;
        if (processName && typeof processName === 'string') {
          const key = `process:${processName}`;
          if (!seen.has(key)) {
            seen.add(key);
            entities.push({
              type: 'process',
              id: processName,
              fromTurn: turn.turnIndex,
            });
          }
        }
      }
    }

    return entities;
  }

  /**
   * Get all turns
   */
  getAllTurns(): ConversationTurn[] {
    return [...this.turns];
  }

  /**
   * Get the last N turns
   */
  getRecentTurns(n: number): ConversationTurn[] {
    return this.turns.slice(-n);
  }

  /**
   * Get all findings
   */
  getAllFindings(): Finding[] {
    return Array.from(this.findings.values());
  }

  /**
   * Get session ID
   */
  getSessionId(): string {
    return this.sessionId;
  }

  /**
   * Get trace ID
   */
  getTraceId(): string {
    return this.traceId;
  }

  /**
   * Serialize context for persistence
   */
  serialize(): string {
    return JSON.stringify({
      sessionId: this.sessionId,
      traceId: this.traceId,
      turns: this.turns,
      findings: Array.from(this.findings.entries()),
      findingTurnMap: Array.from(this.findingTurnMap.entries()),
      references: this.references,
      topicsDiscussed: Array.from(this.topicsDiscussed),
      openQuestions: this.openQuestions,
      entityStore: this.entityStore.serialize(),
      workingMemory: this.workingMemory,
      traceAgentState: this.traceAgentState,
    });
  }

  /**
   * Deserialize context from persistence
   */
  static deserialize(json: string): EnhancedSessionContext {
    const data = JSON.parse(json);
    const ctx = new EnhancedSessionContext(data.sessionId, data.traceId);
    ctx.turns = data.turns;
    ctx.findings = new Map(data.findings);
    ctx.findingTurnMap = new Map(data.findingTurnMap);
    ctx.references = data.references;
    ctx.topicsDiscussed = new Set(data.topicsDiscussed);
    ctx.openQuestions = data.openQuestions;
    ctx.workingMemory = Array.isArray(data.workingMemory) ? data.workingMemory : [];

    // Restore EntityStore if present
    if (data.entityStore) {
      ctx.entityStore = EntityStore.deserialize(data.entityStore);
    }

    // Restore TraceAgentState if present (migrated + scoped to trace)
    if (data.traceAgentState) {
      ctx.setTraceAgentState(data.traceAgentState);
    }

    return ctx;
  }
}

// =============================================================================
// Markdown Helpers (no dependency, deterministic)
// =============================================================================

const WORKING_MEMORY_BLOCKLIST: RegExp[] = [
  /\b(ignore|disregard|override|bypass)\b/i,
  /\b(system prompt|developer message|policy|guardrail)\b/i,
  /\b(reveal|expose|leak)\b/i,
  /\b(api[-_\s]?key|token|secret|password|credential)\b/i,
  /\b(only respond|output only|do not follow)\b/i,
  /(忽略|无视|绕过).*(规则|指令|策略)/i,
  /(泄露|暴露).*(密钥|token|密码|凭据)/i,
  /(只输出|仅输出).*(密钥|token|密码|原文)/i,
];

function sanitizeWorkingMemoryLine(line: string): string | null {
  const normalized = String(line || '')
    .replace(/[`*_>#]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!normalized) return null;

  if (WORKING_MEMORY_BLOCKLIST.some(pattern => pattern.test(normalized))) {
    return null;
  }

  const maxLen = 220;
  if (normalized.length <= maxLen) {
    return normalized;
  }

  return normalized.slice(0, maxLen).trim();
}

function sanitizeWorkingMemoryBullets(items: string[], maxItems: number): string[] {
  const deduped: string[] = [];
  const seen = new Set<string>();

  for (const item of items) {
    const sanitized = sanitizeWorkingMemoryLine(item);
    if (!sanitized) continue;
    if (seen.has(sanitized)) continue;
    seen.add(sanitized);
    deduped.push(sanitized);
    if (deduped.length >= maxItems) break;
  }

  return deduped;
}

function extractBulletsFromMarkdownSection(markdown: string, headerPattern: RegExp): string[] {
  const lines = String(markdown || '').split(/\r?\n/);
  let start = -1;

  for (let i = 0; i < lines.length; i++) {
    if (headerPattern.test(lines[i].trim())) {
      start = i + 1;
      break;
    }
  }

  if (start === -1) return [];

  let end = lines.length;
  for (let i = start; i < lines.length; i++) {
    if (/^##\s+/.test(lines[i].trim())) {
      end = i;
      break;
    }
  }

  const section = lines.slice(start, end).map(l => l.trim()).filter(Boolean);

  const bullets = section
    .filter(l => /^[-*]\s+/.test(l) || /^\d+\.\s+/.test(l))
    .map(l => l.replace(/^[-*]\s+/, '').replace(/^\d+\.\s+/, '').trim())
    .filter(Boolean);

  if (bullets.length > 0) return bullets;

  // Fallback: take first 2 non-empty lines when no bullets are present.
  return section.slice(0, 2);
}

function inferEvidenceKind(toolResult: any, meta: Record<string, any>): 'sql' | 'skill' | 'derived' {
  if (meta && typeof meta === 'object') {
    if (meta.type === 'dynamic_sql_upgrade') return 'sql';
    if (typeof meta.sql === 'string' && meta.sql.trim()) return 'sql';
    if (typeof meta.skillId === 'string' && meta.skillId.trim()) return 'skill';
    if (meta.kind === 'sql' || meta.kind === 'skill') return meta.kind;
  }

  // Heuristic: layeredResult/dataEnvelopes typically come from skills.
  if (toolResult?.layeredResult) return 'skill';
  if (Array.isArray(toolResult?.dataEnvelopes) && toolResult.dataEnvelopes.length > 0) return 'skill';

  return 'derived';
}

function buildToolResultDigest(
  toolResult: any,
  hint?: { stageName?: string; round?: number }
): string {
  const success = !!toolResult?.success;
  const error = typeof toolResult?.error === 'string' ? toolResult.error : '';
  const execMs = typeof toolResult?.executionTimeMs === 'number' ? toolResult.executionTimeMs : undefined;
  const meta = (toolResult as any)?.metadata && typeof (toolResult as any).metadata === 'object'
    ? (toolResult as any).metadata
    : {};

  const envs = Array.isArray(toolResult?.dataEnvelopes) ? toolResult.dataEnvelopes : [];
  const envTitles = envs
    .map((e: any) => e?.display?.title)
    .filter((t: any) => typeof t === 'string' && t.trim())
    .slice(0, 3);

  const envRowCounts = envs
    .map((e: any) => {
      const data = e?.data;
      const rows = data?.rows;
      return Array.isArray(rows) ? rows.length : 0;
    })
    .filter((n: any) => typeof n === 'number')
    .slice(0, 3);

  const data = toolResult?.data;
  const rowCount =
    Array.isArray(data?.rows) ? data.rows.length
    : (Array.isArray(data) ? data.length : undefined);

  const parts: string[] = [];
  // NOTE: stage/round are stored in evidence.source (not digest) to keep digest stable for dedupe.
  if (meta.scopeLabel && typeof meta.scopeLabel === 'string') {
    parts.push(`scope=${truncateText(meta.scopeLabel, 48)}`);
  }
  if (meta.packageName && typeof meta.packageName === 'string') {
    parts.push(`pkg=${truncateText(meta.packageName, 40)}`);
  }
  if (meta.timeRange && typeof meta.timeRange === 'object') {
    const start = (meta.timeRange as any).start;
    const end = (meta.timeRange as any).end;
    if (start !== undefined && end !== undefined) {
      parts.push(`t=${truncateText(`${String(start)}..${String(end)}`, 40)}`);
    }
  }
  parts.push(`success=${success ? '1' : '0'}`);
  // Keep execution time out of digest for dedupe stability; it is still available in toolResult.
  if (typeof rowCount === 'number') parts.push(`rows=${rowCount}`);
  if (envs.length > 0) parts.push(`envelopes=${envs.length}`);
  if (envTitles.length > 0) parts.push(`tables=${envTitles.join('|')}`);
  if (envRowCounts.length > 0) parts.push(`tableRows=${envRowCounts.join('|')}`);
  const findings = Array.isArray(toolResult?.findings) ? toolResult.findings : [];
  const findingsSummary = summarizeFindingsForDigest(findings);
  if (findingsSummary) parts.push(findingsSummary);

  const kpiSnippet = extractKpiSnippetFromEnvelopes(envs);
  if (kpiSnippet) parts.push(`kpi=${kpiSnippet}`);

  const sampleSnippet = extractSampleFromToolData(toolResult?.data);
  if (sampleSnippet) parts.push(`sample=${sampleSnippet}`);
  if (!success && error) parts.push(`error=${error.slice(0, 120)}`);

  return truncateText(parts.join(' '), 260);
}

function truncateText(value: string, maxLen: number): string {
  const s = String(value || '');
  if (s.length <= maxLen) return s;
  return s.slice(0, maxLen - 3) + '...';
}

function summarizeFindingsForDigest(findings: any[]): string | null {
  if (!Array.isArray(findings) || findings.length === 0) return null;

  const counts: Record<string, number> = {};
  for (const f of findings) {
    const sev = typeof f?.severity === 'string' ? f.severity : 'unknown';
    counts[sev] = (counts[sev] || 0) + 1;
  }

  const total = findings.length;
  const critical = (counts.critical || 0) + (counts.high || 0);
  const warning = counts.warning || 0;
  const info = counts.info || 0;

  const parts: string[] = [];
  if (critical > 0) parts.push(`crit=${critical}`);
  if (warning > 0) parts.push(`warn=${warning}`);
  if (info > 0) parts.push(`info=${info}`);

  return parts.length > 0
    ? `findings=${total}(${parts.join(',')})`
    : `findings=${total}`;
}

function inferDomainFromAgentId(agentId: string): string {
  const id = String(agentId || '').trim().toLowerCase();
  if (!id) return '';
  if (id.endsWith('_agent')) return id.slice(0, -'_agent'.length);
  return id;
}

function extractKpiSnippetFromEnvelopes(envs: any[]): string | null {
  if (!Array.isArray(envs) || envs.length === 0) return null;

  const scored = envs
    .map((env, idx) => ({ env, idx, score: scoreEnvelopeForKpi(env) }))
    .filter(e => e.score !== null) as Array<{ env: any; idx: number; score: number }>;

  if (scored.length === 0) return null;

  scored.sort((a, b) => a.score - b.score);

  const snippets: string[] = [];
  for (const item of scored.slice(0, 2)) {
    const snip = buildEnvelopeKpiSnippet(item.env);
    if (snip) snippets.push(snip);
  }

  if (snippets.length === 0) return null;
  return truncateText(snippets.join(' | '), 180);
}

function scoreEnvelopeForKpi(env: any): number | null {
  const display = env?.display || {};
  const level = display?.level;
  const layer = display?.layer;
  const format = display?.format;

  // Ignore debug/noise
  if (level === 'debug' || level === 'none') return null;

  // Prefer summary/key + overview
  let score = 100;
  if (level === 'key') score -= 50;
  else if (level === 'summary') score -= 35;
  else if (level === 'detail') score -= 10;

  if (layer === 'overview') score -= 20;
  if (format === 'summary' || format === 'metric') score -= 15;

  if (typeof display?.priority === 'number') {
    score += Math.max(0, Math.min(50, display.priority));
  }

  const payload = env?.data || {};
  const hasAnyData =
    (payload.summary && typeof payload.summary === 'object') ||
    (typeof payload.text === 'string' && payload.text.trim()) ||
    (Array.isArray(payload.rows) && payload.rows.length > 0);

  if (!hasAnyData) return null;
  return score;
}

function buildEnvelopeKpiSnippet(env: any): string | null {
  const display = env?.display || {};
  const title = typeof display?.title === 'string' && display.title.trim()
    ? truncateText(display.title.trim(), 18)
    : 'result';

  const payload = env?.data || {};

  // 1) Summary payload with metrics
  if (payload.summary && typeof payload.summary === 'object') {
    const metrics = Array.isArray(payload.summary.metrics) ? payload.summary.metrics : [];
    const metricParts = metrics
      .slice(0, 4)
      .map((m: any) => {
        const label = typeof m?.label === 'string' ? m.label : '';
        const value = m?.value;
        const unit = typeof m?.unit === 'string' ? m.unit : '';
        if (!label) return null;
        return `${truncateText(label, 10)}=${formatScalarForDigest(value)}${unit}`;
      })
      .filter(Boolean) as string[];

    const content = typeof payload.summary.content === 'string'
      ? payload.summary.content.trim()
      : '';

    const bits = [...metricParts];
    if (bits.length === 0 && content) {
      bits.push(truncateText(content.split('\n')[0], 50));
    }

    if (bits.length === 0) return null;
    return `${title}:${truncateText(bits.join(', '), 120)}`;
  }

  // 2) Text payload
  if (typeof payload.text === 'string' && payload.text.trim()) {
    const firstLine = payload.text.trim().split('\n')[0];
    return `${title}:${truncateText(firstLine, 80)}`;
  }

  // 3) Table payload: pick the first row as KPI row
  const columns: string[] = Array.isArray(payload.columns)
    ? payload.columns.filter((c: any) => typeof c === 'string')
    : [];
  const rows: any[][] = Array.isArray(payload.rows)
    ? payload.rows.filter((r: any) => Array.isArray(r))
    : [];

  if (columns.length === 0 || rows.length === 0) return null;
  const row = rows[0];

  const defs = Array.isArray(display?.columns) ? display.columns : [];
  const defByName = new Map<string, any>();
  for (const d of defs) {
    if (d && typeof d.name === 'string') defByName.set(d.name, d);
  }

  const candidates = columns.map((name, idx) => ({
    name,
    idx,
    def: defByName.get(name),
    value: row[idx],
    weight: scoreColumnForKpi(name, defByName.get(name)),
  }))
    .filter(c => c.value !== undefined && c.value !== null && c.value !== '')
    .sort((a, b) => a.weight - b.weight)
    .slice(0, 4);

  if (candidates.length === 0) return null;

  const kv = candidates.map(c => {
    const label = typeof c.def?.label === 'string' && c.def.label.trim()
      ? c.def.label.trim()
      : c.name;
    const formatted = formatScalarForDigest(c.value, c.def);
    return `${truncateText(label, 10)}=${formatted}`;
  });

  return `${title}:${truncateText(kv.join(', '), 120)}`;
}

function scoreColumnForKpi(name: string, def?: any): number {
  const n = String(name || '').toLowerCase();
  const type = typeof def?.type === 'string' ? def.type : '';
  let score = 50;

  if (type === 'percentage' || n.includes('rate') || n.includes('pct')) score -= 20;
  if (n.includes('fps') || n.includes('jank')) score -= 15;
  if (type === 'duration' || n.includes('dur') || n.includes('latency') || n.endsWith('_ms')) score -= 10;
  if (n.includes('total') || n.includes('count') || n.endsWith('_frames')) score -= 5;

  // De-prioritize IDs/tokens in KPI summary
  if (n.endsWith('_id') || n === 'id' || n.includes('token')) score += 15;

  return score;
}

function formatScalarForDigest(value: any, def?: any): string {
  if (value === null || value === undefined) return 'null';

  const type = typeof def?.type === 'string' ? def.type : '';

  if (typeof value === 'bigint') return value.toString();

  if (type === 'percentage') {
    const n = typeof value === 'number'
      ? value
      : (typeof value === 'string' ? Number(value) : NaN);
    if (Number.isFinite(n)) {
      const pct = n <= 1 ? n * 100 : n;
      return `${Math.round(pct * 10) / 10}%`;
    }
  }

  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return String(value);
    if (Math.abs(value) >= 1000) return String(Math.round(value));
    const rounded = Math.round(value * 100) / 100;
    return String(rounded);
  }

  if (typeof value === 'string') return truncateText(value, 48);

  try {
    return truncateText(JSON.stringify(value), 60);
  } catch {
    return truncateText(String(value), 60);
  }
}

function extractSampleFromToolData(data: any): string | null {
  if (!data) return null;

  // Common dynamic SQL shape: Array<{...}>
  if (Array.isArray(data) && data.length > 0 && data.every(r => r && typeof r === 'object' && !Array.isArray(r))) {
    const row = data[0] as Record<string, any>;
    const entries = Object.entries(row)
      .filter(([_, v]) => v !== undefined && v !== null && v !== '')
      .sort(([a], [b]) => scoreSampleKey(a) - scoreSampleKey(b))
      .slice(0, 3)
      .map(([k, v]) => `${truncateText(k, 10)}=${formatScalarForDigest(v)}`);

    if (entries.length === 0) return null;
    return truncateText(entries.join(', '), 120);
  }

  // Object with a few scalar fields
  if (data && typeof data === 'object' && !Array.isArray(data)) {
    const entries = Object.entries(data as Record<string, any>)
      .filter(([_, v]) => v !== undefined && v !== null && v !== '')
      .filter(([_, v]) => typeof v === 'string' || typeof v === 'number' || typeof v === 'bigint' || typeof v === 'boolean')
      .sort(([a], [b]) => scoreSampleKey(a) - scoreSampleKey(b))
      .slice(0, 3)
      .map(([k, v]) => `${truncateText(k, 10)}=${formatScalarForDigest(v)}`);

    if (entries.length === 0) return null;
    return truncateText(entries.join(', '), 120);
  }

  return null;
}

function scoreSampleKey(key: string): number {
  const k = String(key || '').toLowerCase();
  let score = 50;
  if (k.includes('rate') || k.includes('pct') || k.includes('fps') || k.includes('jank')) score -= 20;
  if (k.includes('dur') || k.includes('latency') || k.endsWith('_ms') || k.endsWith('_ns')) score -= 10;
  if (k.includes('count') || k.includes('total')) score -= 5;
  if (k.endsWith('_id') || k === 'id' || k.includes('token')) score += 15;
  return score;
}

/**
 * Session context manager - manages multiple sessions with LRU eviction
 *
 * Key improvements:
 * - Uses sessionId+traceId as compound key to prevent context cross-contamination
 * - LRU eviction policy to prevent memory leaks
 * - Automatic cleanup of stale sessions
 */
export class SessionContextManager {
  private sessions: Map<string, EnhancedSessionContext> = new Map();
  private accessOrder: string[] = []; // LRU tracking
  private maxSessions: number;
  private maxAgeMs: number;

  constructor(options: { maxSessions?: number; maxAgeMs?: number } = {}) {
    this.maxSessions = options.maxSessions || 100;
    this.maxAgeMs = options.maxAgeMs || 30 * 60 * 1000; // 30 minutes default
  }

  /**
   * Build composite key from sessionId and traceId
   */
  private buildKey(sessionId: string, traceId: string): string {
    return `${sessionId}::${traceId}`;
  }

  /**
   * Get or create a session context
   * If traceId changes for the same sessionId, creates a new context
   */
  getOrCreate(sessionId: string, traceId: string): EnhancedSessionContext {
    const key = this.buildKey(sessionId, traceId);

    let ctx = this.sessions.get(key);
    if (!ctx) {
      // Check if there's an old context for this sessionId with different traceId
      // and remove it (trace switched)
      this.cleanupOldTracesForSession(sessionId);

      ctx = new EnhancedSessionContext(sessionId, traceId);
      this.sessions.set(key, ctx);

      // Evict oldest sessions if over limit
      this.evictIfNeeded();
    }

    // Update access order for LRU
    this.touchKey(key);

    return ctx;
  }

  /**
   * Inject/replace a session context (used for persistence restore).
   *
   * This enables cross-restart restoration by installing a deserialized
   * EnhancedSessionContext directly into the manager, preserving internal
   * state (turn IDs, references, openQuestions, etc.).
   */
  set(sessionId: string, traceId: string, ctx: EnhancedSessionContext): void {
    // Ensure we don't keep stale contexts for the same sessionId (trace switched)
    this.cleanupOldTracesForSession(sessionId);

    const key = this.buildKey(sessionId, traceId);
    this.sessions.set(key, ctx);
    this.touchKey(key);
    this.evictIfNeeded();
  }

  /**
   * Get a session context by sessionId and traceId
   */
  get(sessionId: string, traceId?: string): EnhancedSessionContext | undefined {
    if (traceId) {
      const key = this.buildKey(sessionId, traceId);
      const ctx = this.sessions.get(key);
      if (ctx) {
        this.touchKey(key);
      }
      return ctx;
    }

    // If no traceId provided, find first matching sessionId (legacy support)
    for (const [key, ctx] of this.sessions.entries()) {
      if (key.startsWith(sessionId + '::')) {
        this.touchKey(key);
        return ctx;
      }
    }
    return undefined;
  }

  /**
   * Remove a session context
   */
  remove(sessionId: string, traceId?: string): void {
    if (traceId) {
      const key = this.buildKey(sessionId, traceId);
      this.sessions.delete(key);
      this.removeFromAccessOrder(key);
    } else {
      // Remove all contexts for this sessionId
      for (const key of Array.from(this.sessions.keys())) {
        if (key.startsWith(sessionId + '::')) {
          this.sessions.delete(key);
          this.removeFromAccessOrder(key);
        }
      }
    }
  }

  /**
   * List all session IDs (returns unique sessionIds)
   */
  listSessions(): string[] {
    const sessionIds = new Set<string>();
    for (const key of this.sessions.keys()) {
      const sessionId = key.split('::')[0];
      sessionIds.add(sessionId);
    }
    return Array.from(sessionIds);
  }

  /**
   * Get stats about the session manager
   */
  getStats(): { sessionCount: number; contextCount: number; oldestAccessMs: number } {
    let oldestAccessMs = 0;
    for (const ctx of this.sessions.values()) {
      const lastTurn = ctx.getAllTurns().slice(-1)[0];
      if (lastTurn?.timestamp) {
        const age = Date.now() - lastTurn.timestamp;
        if (age > oldestAccessMs) {
          oldestAccessMs = age;
        }
      }
    }

    return {
      sessionCount: this.listSessions().length,
      contextCount: this.sessions.size,
      oldestAccessMs,
    };
  }

  /**
   * Cleanup stale sessions based on maxAgeMs
   *
   * Note: Sessions with no turns are considered "fresh" and are not evicted,
   * since they were just created and haven't had a chance to record activity.
   */
  cleanupStale(): number {
    const now = Date.now();
    let removed = 0;

    for (const [key, ctx] of Array.from(this.sessions.entries())) {
      const turns = ctx.getAllTurns();

      // Don't evict sessions that have no turns yet - they're brand new
      if (turns.length === 0) {
        continue;
      }

      const lastTurn = turns[turns.length - 1];
      const lastAccess = lastTurn?.timestamp || 0;

      if (now - lastAccess > this.maxAgeMs) {
        this.sessions.delete(key);
        this.removeFromAccessOrder(key);
        removed++;
      }
    }

    return removed;
  }

  // ==========================================================================
  // Private helpers
  // ==========================================================================

  private cleanupOldTracesForSession(sessionId: string): void {
    for (const key of Array.from(this.sessions.keys())) {
      if (key.startsWith(sessionId + '::')) {
        this.sessions.delete(key);
        this.removeFromAccessOrder(key);
      }
    }
  }

  private touchKey(key: string): void {
    this.removeFromAccessOrder(key);
    this.accessOrder.push(key);
  }

  private removeFromAccessOrder(key: string): void {
    const idx = this.accessOrder.indexOf(key);
    if (idx !== -1) {
      this.accessOrder.splice(idx, 1);
    }
  }

  private evictIfNeeded(): void {
    // First, cleanup stale sessions
    this.cleanupStale();

    // Then evict LRU if still over limit
    while (this.sessions.size > this.maxSessions && this.accessOrder.length > 0) {
      const oldestKey = this.accessOrder.shift();
      if (oldestKey) {
        this.sessions.delete(oldestKey);
      }
    }
  }
}

// Singleton instance with reasonable defaults
export const sessionContextManager = new SessionContextManager({
  maxSessions: 100,
  maxAgeMs: 30 * 60 * 1000, // 30 minutes
});
