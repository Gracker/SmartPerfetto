// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

/**
 * HTML Report Generator
 *
 * Generates detailed HTML reports for analysis results
 * Reports include:
 * - Full thinking process
 * - All SQL queries and results
 * - Detailed tables with expanded lists
 * - Diagnostic information
 * - Executable SQL for reproduction
 */

import markdownit from 'markdown-it';
import {
  AnalysisSession,
  CollectedResult,
  QueryResult,
  AnalysisCompletedEvent,
} from '../types/analysis';
import { OrchestratorResult, MasterOrchestratorResult, Finding, Diagnostic, ExpertResult, StageResult } from '../agent/types';
import {
  DataEnvelope,
  ColumnDefinition,
  buildColumnDefinitions,
  inferColumnDefinition,
} from '../types/dataContract';

export interface ReportData {
  sessionId: string;
  traceId: string;
  question: string;
  answer: string;
  /** Trace start timestamp in ns (string to preserve precision) */
  traceStartNs?: string;
  metrics: {
    totalDuration: number;
    iterationsCount: number;
    sqlQueriesCount: number;
  };
  collectedResults: CollectedResult[];
  skillEngineResult?: {
    skillId: string;
    skillName: string;
    sections: Record<string, any>;
    diagnostics: Array<{
      id: string;
      severity: string;
      message: string;
      suggestions?: string[];
    }>;
  };
  timestamp: number;
}

export interface AgentReportData {
  traceId: string;
  query: string;
  result: OrchestratorResult;
  timestamp: number;
}

export interface MasterAgentReportData {
  traceId: string;
  query: string;
  result: MasterOrchestratorResult;
  timestamp: number;
}

export interface AgentDrivenReportData {
  traceId: string;
  query: string;
  /** Trace start timestamp in ns (string to preserve precision) */
  traceStartNs?: string;
  result: {
    sessionId: string;
    success: boolean;
    findings: Finding[];
    hypotheses: Array<{
      id: string;
      description: string;
      confidence: number;
      status: string;
      supportingEvidence: any[];
      contradictingEvidence: any[];
    }>;
    conclusion: string;
    confidence: number;
    rounds: number;
    totalDurationMs: number;
    partial?: boolean;
    terminationReason?: string;
    terminationMessage?: string;
  };
  hypotheses: Array<{
    id: string;
    description: string;
    confidence: number;
    status: string;
    supportingEvidence: any[];
    contradictingEvidence: any[];
  }>;
  dialogue: Array<{
    agentId: string;
    type: 'task' | 'response' | 'question';
    content: any;
    timestamp: number;
  }>;
  conversationTimeline?: Array<{
    eventId: string;
    ordinal: number;
    phase: 'progress' | 'thinking' | 'tool' | 'result' | 'error';
    role: 'agent' | 'system';
    text: string;
    timestamp: number;
    sourceEventType?: string;
  }>;
  dataEnvelopes?: DataEnvelope[];
  agentResponses?: Array<{
    taskId: string;
    agentId: string;
    response: any;
    timestamp: number;
  }>;
  timestamp: number;
  /** P1-11: User conversation turn count (distinct from SDK internal rounds). */
  conversationTurns?: number;
  /** P0-R1: Cross-turn query history for multi-turn reports */
  queryHistory?: Array<{ turn: number; query: string; timestamp: number }>;
  /** P0-R2: Cross-turn conclusion history for multi-turn reports */
  conclusionHistory?: Array<{ turn: number; conclusion: string; confidence: number; timestamp: number }>;
  /** P1-R3: Analysis notes from Claude's write_analysis_note MCP tool */
  analysisNotes?: Array<{ section?: string; type?: string; content: string; priority?: string; timestamp?: number }>;
  /** P1-R3: Current analysis plan from submit_plan MCP tool */
  analysisPlan?: { phases: Array<{ name: string; goal?: string; status: string; summary?: string }> ; successCriteria: string } | null;
  /** P1-R3: Uncertainty flags from flag_uncertainty MCP tool */
  uncertaintyFlags?: Array<{ topic: string; assumption: string; question: string }>;
}

export class HTMLReportGenerator {
  // Monotonic counter to ensure DOM ids are unique within a generated report.
  // Using Date.now() is not reliable because multiple sections can be rendered within the same millisecond.
  private domIdSeq = 0;

  // Shared markdown-it instance for report rendering.
  // Uses html:false for XSS safety, breaks:true for \n → <br>, with mermaid fence handler.
  private static reportMd: ReturnType<typeof markdownit> | null = null;
  private getReportMd(): ReturnType<typeof markdownit> {
    if (HTMLReportGenerator.reportMd) return HTMLReportGenerator.reportMd;
    const md = markdownit({ html: false, linkify: true, breaks: true });
    const defaultFence = md.renderer.rules.fence ||
      ((tokens: any[], idx: number, options: any, _env: any, self: any) => self.renderToken(tokens, idx, options));
    md.renderer.rules.fence = (tokens: any[], idx: number, options: any, env: any, self: any) => {
      const token = tokens[idx];
      const info = String(token.info || '').trim().split(/\s+/)[0].toLowerCase();
      if (info === 'mermaid') {
        const code = String(token.content || '').trim();
        if (!code) return '<div class="mermaid-error">Mermaid 源码为空</div>';
        return `<pre class="mermaid">${md.utils.escapeHtml(code)}</pre>`;
      }
      return defaultFence(tokens, idx, options, env, self);
    };
    HTMLReportGenerator.reportMd = md;
    return md;
  }

  /**
   * 【P2 Fix】可配置的元数据列名
   * 这些列的值在同一表格中通常是恒定的，会被提取到表头显示
   */
  private static readonly METADATA_COLUMN_PATTERNS: readonly string[] = [
    'process_name', 'Process Name',
    'layer_name', 'Layer Name',
    'package_name', 'Package Name',
    'app_name', 'App Name',
    'trace_id', 'Trace ID',
    'session_id', 'Session ID',
  ];

  /**
   * 【P2 Fix】检查列名是否为元数据列
   */
  private isMetadataColumn(colName: string): boolean {
    return HTMLReportGenerator.METADATA_COLUMN_PATTERNS.includes(colName);
  }

  /**
   * 标识符列（如 frame_id/session_id）不应做千分位格式化，
   * 否则用户复制后会变成 "1,435,508" 这类不可直接用于 drill-down 的值。
   */
  private isIdentifierKey(key?: string): boolean {
    if (!key) return false;
    const k = String(key).trim().toLowerCase();
    if (!k) return false;

    if (
      k === 'id' ||
      k === 'frame_id' ||
      k === 'session_id' ||
      k === 'pid' ||
      k === 'tid' ||
      k === 'utid' ||
      k === 'upid' ||
      k === 'vsync_id' ||
      k === 'binder_txn_id' ||
      k === 'transaction_id'
    ) {
      return true;
    }

    return k.endsWith('_id');
  }

  private normalizeIdentifierDisplay(value: any): string {
    if (value === null || value === undefined) return '-';
    if (typeof value === 'bigint') return value.toString();
    if (typeof value === 'number' && Number.isFinite(value)) return String(Math.trunc(value));
    const raw = String(value).trim();
    const compact = raw.replace(/[,\s，_]/g, '');
    if (/^\d+$/.test(compact)) return compact;
    return raw;
  }

  private sanitizeDomIdPart(value: string): string {
    return (value || 'section').replace(/[^a-zA-Z0-9_-]/g, '-');
  }

  private nextDomId(prefix: string): string {
    this.domIdSeq += 1;
    return `${this.sanitizeDomIdPart(prefix)}_${this.domIdSeq}`;
  }

  private parseNs(value: any): bigint | null {
    try {
      if (typeof value === 'bigint') return value;
      if (typeof value === 'number') {
        if (!Number.isFinite(value)) return null;
        return BigInt(Math.trunc(value));
      }
      if (typeof value === 'string') {
        if (!value.trim()) return null;
        const normalized = value.replace(/,/g, '').trim();
        if (!/^-?\d+$/.test(normalized)) return null;
        return BigInt(normalized);
      }
      return null;
    } catch {
      return null;
    }
  }

  private formatRelativeSeconds(ns: bigint): string {
    const sign = ns < 0n ? '-' : '';
    const absNs = ns < 0n ? -ns : ns;
    const seconds = Number(absNs) / 1e9;
    return `${sign}${seconds.toFixed(3)}s`;
  }

  private stringifyValueForDisplay(value: any, maxLen: number = 200): string {
    if (value === null || value === undefined) return 'NULL';
    if (typeof value === 'string') return value;
    if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
      return String(value);
    }
    try {
      const json = JSON.stringify(value);
      if (typeof json === 'string' && json.length > 0) {
        return json.length > maxLen ? `${json.substring(0, maxLen)}...` : json;
      }
    } catch {
      // Fall through to String(value) for non-serializable objects.
    }
    const raw = String(value);
    return raw.length > maxLen ? `${raw.substring(0, maxLen)}...` : raw;
  }

  /**
   * Generate HTML report from analysis data
   */
  generateHTML(data: ReportData): string {
    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>SmartPerfetto 分析报告 - ${new Date(data.timestamp).toLocaleString('zh-CN')}</title>
  <style>
    :root {
      --primary-color: #2563eb;
      --primary-bg: #eff6ff;
      --success-color: #10b981;
      --success-bg: #ecfdf5;
      --warning-color: #f59e0b;
      --warning-bg: #fffbeb;
      --danger-color: #ef4444;
      --danger-bg: #fef2f2;
      --text-main: #1f2937;
      --text-secondary: #4b5563;
      --text-light: #6b7280;
      --border-color: #e5e7eb;
      --bg-body: #f3f4f6;
      --bg-card: #ffffff;
      --font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
    }

    * { margin: 0; padding: 0; box-sizing: border-box; }

    body {
      font-family: var(--font-family);
      line-height: 1.5;
      color: var(--text-main);
      background: var(--bg-body);
      padding: 24px;
      font-size: 14px;
    }

    .container {
      max-width: 1400px;
      margin: 0 auto;
      background: transparent; /* Container itself is transparent now, sections will be cards */
    }

    /* Card Style for Sections */
    .report-card {
      background: var(--bg-card);
      border-radius: 12px;
      box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1), 0 2px 4px -1px rgba(0, 0, 0, 0.06);
      margin-bottom: 24px;
      overflow: hidden;
      border: 1px solid rgba(0,0,0,0.05);
    }

    .header {
      background: var(--bg-card);
      padding: 20px 24px;
      border-bottom: 1px solid var(--border-color);
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 0; /* Header is part of the first card usually, or standalone */
    }

    .header h1 {
      font-size: 20px;
      font-weight: 700;
      color: var(--text-main);
      display: flex;
      align-items: center;
      gap: 12px;
    }

    .header .meta {
      font-size: 13px;
      color: var(--text-secondary);
      display: flex;
      gap: 20px;
      align-items: center;
    }

    .badge {
      display: inline-block;
      padding: 4px 10px;
      border-radius: 9999px;
      font-size: 12px;
      font-weight: 600;
      background: var(--primary-bg);
      color: var(--primary-color);
    }

    .section {
      padding: 24px;
      border-bottom: 1px solid var(--border-color);
    }

    .section:last-child {
      border-bottom: none;
    }

    .section-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 16px;
    }

    .section-title {
      font-size: 15px;
      font-weight: 700;
      color: #111827;
      display: flex;
      align-items: center;
      gap: 10px;
      border-left: 4px solid var(--primary-color);
      padding-left: 12px;
      margin-bottom: 12px; /* Reduced from default/inline usually */
    }

    /* Metric Cards */
    .metrics-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); /* Squeezed min-width */
      gap: 12px; /* Reduced gap */
    }

    .metric-card {
      background: #fafafa;
      padding: 12px; /* Reduced from 16px */
      border-radius: 8px;
      border: 1px solid var(--border-color);
      display: flex;
      flex-direction: column;
      transition: transform 0.1s ease-in-out;
    }
    
    .metric-card:hover {
        transform: translateY(-2px);
        box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.05);
        border-color: #d1d5db;
        background: #fff;
    }

    .metric-card .label {
      font-size: 11px; /* Reduced from 12px */
      color: var(--text-secondary);
      margin-bottom: 2px; /* Reduced from 6px */
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.05em;
    }

    .metric-card .value {
      font-size: 20px; /* Reduced from 24px */
      font-weight: 700;
      color: var(--text-main);
      letter-spacing: -0.025em;
      line-height: 1.2;
    }

    /* Chat/Answer Box */
    .chat-box {
      background: #f8fafc;
      border-radius: 8px;
      padding: 16px 20px;
      font-size: 14px;
      line-height: 1.5;
      border: 1px solid var(--border-color);
    }

    .chat-message.user {
      font-weight: 700;
      color: #1e3a8a;
      margin-bottom: 8px;
      padding-bottom: 8px;
      border-bottom: 1px solid #e2e8f0;
    }

    .chat-message.system {
      color: #374151;
      line-height: 1.5;
    }

    /* Markdown typography for .chat-box (matches .answer-box rules) */
    .chat-box p { margin: 2px 0; line-height: 1.5; }
    .chat-box ul, .chat-box ol { margin: 2px 0; padding-left: 20px; }
    .chat-box li { margin: 1px 0; line-height: 1.5; }
    .chat-box li > ul, .chat-box li > ol { margin: 0; }
    .chat-box blockquote {
      margin: 6px 0; padding: 8px 14px; background: #eef6ff;
      border-left: 4px solid #3b82f6; color: #1e40af; border-radius: 0 4px 4px 0;
    }
    .chat-box blockquote p { margin: 1px 0; }
    .chat-box code { background: rgba(0,0,0,0.06); padding: 1px 5px; border-radius: 3px; font-size: 13px; }
    .chat-box pre {
      background: #1e1e2e; color: #cdd6f4; padding: 12px; border-radius: 8px;
      overflow-x: auto; font-size: 13px; line-height: 1.4; margin: 6px 0;
    }
    .chat-box pre code { background: none; padding: 0; color: inherit; font-size: inherit; }
    .chat-box hr { border: none; border-top: 1px solid #e5e7eb; margin: 8px 0; }
    .chat-box h2 { margin: 12px 0 4px; font-size: 15px; color: #111827; }
    .chat-box h3 { margin: 10px 0 3px; font-size: 14px; color: #1f2937; }
    .chat-box h4 { margin: 8px 0 2px; font-size: 13.5px; color: #374151; }
    .chat-box h5 { margin: 6px 0 2px; font-size: 13px; color: #374151; font-weight: 600; }
    .chat-box table { width: 100%; border-collapse: collapse; margin: 6px 0; font-size: 13px; }
    .chat-box th { padding: 6px 10px; border: 1px solid #e2e8f0; text-align: left; font-weight: 600; color: #374151; background: #f8fafc; }
    .chat-box td { padding: 5px 10px; border: 1px solid #e2e8f0; }

    /* Tables */
    .table-container {
      overflow-x: auto;
      border: 1px solid var(--border-color);
      border-radius: 8px;
      box-shadow: 0 1px 2px 0 rgba(0, 0, 0, 0.05);
    }

    table {
      width: 100%;
      border-collapse: collapse;
      font-size: 13px;
    }

    th {
      background: #f9fafb;
      text-align: left;
      padding: 10px 16px;
      font-weight: 600;
      color: #4b5563;
      border-bottom: 1px solid var(--border-color);
      white-space: nowrap;
    }

    td {
      padding: 10px 16px;
      border-bottom: 1px solid var(--border-color);
      color: #374151;
    }
    
    tr:nth-child(even) {
        background-color: #f9fafb;
    }

    tr:hover td {
      background-color: var(--primary-bg);
    }

    /* Deep Analysis / Properties Grid */
    .deep-analysis-card {
        background: white;
        border: 1px solid var(--border-color);
        border-radius: 8px;
        overflow: hidden;
        margin-bottom: 16px;
        box-shadow: 0 1px 2px 0 rgba(0, 0, 0, 0.05);
    }
    
    .deep-analysis-header {
        background: #f8fafc;
        padding: 12px 16px;
        display: flex;
        justify-content: space-between;
        align-items: center;
        border-bottom: 1px solid var(--border-color);
        cursor: pointer;
    }
    
    .deep-analysis-header:hover {
        background: #f1f5f9;
    }

    .properties-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
      gap: 16px;
      padding: 16px;
    }

    .property-item {
      display: flex;
      flex-direction: column;
      border-bottom: 1px solid #f3f4f6;
      padding-bottom: 8px;
    }
    
    .property-item:last-child {
        border-bottom: none;
    }

    .property-label {
      color: var(--text-light);
      font-size: 12px;
      margin-bottom: 4px;
      font-weight: 500;
    }

    .property-value {
      color: var(--text-main);
      font-weight: 600;
      font-size: 14px;
      word-break: break-all;
    }

    /* Expandable Details */
    details {
      background: #f8fafc;
      border-radius: 6px;
      padding: 4px;
    }

    details summary {
      padding: 8px;
      cursor: pointer;
      color: var(--primary-color);
      font-size: 13px;
      font-weight: 500;
    }

    details summary:hover {
      background: #eff6ff;
      border-radius: 4px;
    }

    .details-content {
      padding: 12px;
      background: white;
      border-radius: 4px;
      border: 1px solid var(--border-color);
      margin-top: 4px;
    }

    /* SQL Code Block */
    .code-block {
      background: #1f2937;
      color: #e5e7eb;
      padding: 16px;
      border-radius: 8px;
      font-family: 'Menlo', 'Monaco', 'Courier New', monospace;
      font-size: 13px;
      line-height: 1.6;
      overflow-x: auto;
      margin: 12px 0;
      box-shadow: inset 0 2px 4px 0 rgba(0, 0, 0, 0.06);
    }

    .copy-btn {
      background: var(--primary-color);
      color: white;
      border: none;
      padding: 4px 10px;
      border-radius: 4px;
      cursor: pointer;
      font-size: 12px;
      font-weight: 500;
      transition: background 0.2s;
    }

    .copy-btn:hover {
      background: #1d4ed8;
    }

    /* Diagnostics */
    .diagnostic {
      padding: 12px 16px;
      border-radius: 6px;
      margin-bottom: 12px;
      border-left: 4px solid;
    }

    .diagnostic.critical {
      background: var(--danger-bg);
      border-color: var(--danger-color);
    }

    .diagnostic.warning {
      background: var(--warning-bg);
      border-color: var(--warning-color);
    }

    .diagnostic.info {
      background: var(--primary-bg);
      border-color: var(--primary-color);
    }

    .diagnostic .severity {
      font-size: 12px;
      font-weight: 700;
      text-transform: uppercase;
      margin-bottom: 4px;
    }

    .diagnostic.critical .severity { color: var(--danger-color); }
    .diagnostic.warning .severity { color: var(--warning-color); }
    .diagnostic.info .severity { color: var(--primary-color); }

    .suggestions {
      margin-top: 8px;
      padding-left: 20px;
      font-size: 13px;
    }

    .suggestions li {
      margin-bottom: 4px;
      color: var(--text-secondary);
    }

    /* Scrollbar Styling for Table Container */
    .table-container::-webkit-scrollbar {
      height: 8px;
    }
    .table-container::-webkit-scrollbar-track {
      background: #f1f1f1;
      border-radius: 4px;
    }
    .table-container::-webkit-scrollbar-thumb {
      background: #c1c1c1;
      border-radius: 4px;
    }
    .table-container::-webkit-scrollbar-thumb:hover {
      background: #a1a1a1;
    }

    /* Print Styles */
    @media print {
      body {
        background: white;
        padding: 0;
      }
      .container {
        box-shadow: none;
      }
      .report-card {
        box-shadow: none;
        border: 1px solid #ccc;
      }
    }
  </style>
</head>
<body>
  <div class="container">
    <!-- Header -->
    <div class="report-card">
        <div class="header">
        <h1>📊 SmartPerfetto 性能分析报告</h1>
        <div class="meta">
            <span>📅 生成时间: ${new Date(data.timestamp).toLocaleString('zh-CN')}</span>
            <span>🆔 会话ID: ${data.sessionId}</span>
            <span>📁 Trace ID: ${data.traceId}</span>
        </div>
        </div>
        
        <!-- Metrics (merged into header card for dashboard look) -->
        <div class="section" style="border-top: 1px solid var(--border-color);">
        <h2 class="section-title">分析概览</h2>
        <div class="metrics-grid">
            <div class="metric-card">
            <div class="label">总耗时</div>
            <div class="value" style="color: var(--primary-color);">${(data.metrics.totalDuration / 1000).toFixed(3)}s</div>
            </div>
            <div class="metric-card">
            <div class="label">分析轮次</div>
            <div class="value">${data.metrics.iterationsCount}</div>
            </div>
            <div class="metric-card">
            <div class="label">SQL 查询数</div>
            <div class="value">${data.metrics.sqlQueriesCount}</div>
            </div>
        </div>
        </div>
    </div>

    <!-- Question & Answer -->
    <div class="report-card">
      <div class="section">
        <h2 class="section-title">分析结论</h2>
        <div style="margin-bottom: 20px;">
           <div style="font-size: 13px; color: var(--text-light); margin-bottom: 4px;">用户问题</div>
           <div style="font-weight: 500; font-size: 15px; color: var(--text-main); margin-bottom: 16px;">${this.escapeHtml(data.question)}</div>
           
           <div class="chat-box">
             ${this.formatAnswer(data.answer)}
           </div>
        </div>
      </div>
    </div>

    ${data.skillEngineResult ? this.generateSkillEngineSection(data.skillEngineResult) : ''}

    <!-- SQL Queries and Results -->
    <div class="report-card">
        <div class="section">
        <h2 class="section-title" style="margin-bottom: 20px;">查询详情</h2>
        ${data.collectedResults.length > 0
        ? data.collectedResults.map((result, index) =>
          this.generateQueryResultSection(result, index + 1)
        ).join('')
        : '<div class="empty-state" style="text-align: center; padding: 40px; color: var(--text-light);">📭 无查询结果</div>'
      }
        </div>
    </div>

    <!-- Timeline -->
    <div class="report-card">
        <div class="section">
        <h2 class="section-title" style="margin-bottom: 20px;">执行时间线</h2>
        <div class="timeline" style="position: relative; padding-left: 24px;">
            ${data.collectedResults.map((result, index) => `
            <div class="timeline-item" style="position: relative; padding-bottom: 24px; border-left: 2px solid #e5e7eb; padding-left: 24px;">
                <div style="position: absolute; left: -7px; top: 0; width: 12px; height: 12px; border-radius: 50%; background: var(--primary-color); border: 2px solid white;"></div>
                <div style="font-size: 12px; color: var(--text-light); margin-bottom: 4px;">步骤 ${index + 1} · ${new Date(result.timestamp).toLocaleTimeString('zh-CN')}</div>
                <div style="background: #f8fafc; padding: 12px; border-radius: 6px; border: 1px solid var(--border-color);">
                <div style="margin-bottom: 4px;"><strong>Query:</strong> <code style="font-size: 12px; color: var(--text-secondary);">${result.sql.substring(0, 100)}${result.sql.length > 100 ? '...' : ''}</code></div>
                <div style="font-size: 12px; color: var(--text-light);">Result: ${result.result.rowCount} rows · ${result.result.durationMs}ms</div>
                </div>
            </div>
            `).join('')}
        </div>
        </div>
    </div>

    <!-- Footer -->
    <div class="footer" style="text-align: center; padding: 24px; color: var(--text-light);">
      <p>由 SmartPerfetto AI 分析引擎生成</p>
      <p style="margin-top: 4px; font-size: 12px;">Powered by Perfetto + DeepSeek</p>
    </div>
  </div>

  <script>
    // Toggle query result section (默认展开)
    function toggleQueryResult(header) {
      const queryResult = header.parentElement;
      queryResult.classList.toggle('collapsed');
    }

    // Toggle SQL block (默认折叠)
    function toggleSqlBlock(event, sqlBlock) {
      event.stopPropagation();
      sqlBlock.classList.toggle('collapsed');
    }

    // Copy SQL functionality
    function copySql(btn) {
      const sql = btn.getAttribute('data-sql');
      navigator.clipboard.writeText(sql).then(() => {
        const originalText = btn.textContent;
        btn.textContent = '已复制!';
        setTimeout(() => {
          btn.textContent = originalText;
        }, 2000);
      });
    }

    // Toggle table rows (show/hide more)
    function toggleTableRows(btn, hiddenCount) {
      const tableContainer = btn.parentElement;
      const table = tableContainer.querySelector('table');
      const hiddenRows = table.querySelectorAll('.hidden-row');

      if (hiddenRows.length > 0) {
        const isHidden = hiddenRows[0].style.display === 'none';

        hiddenRows.forEach(row => {
          row.style.display = isHidden ? '' : 'none';
        });

        const span = btn.querySelector('span');
        if (isHidden) {
          span.innerHTML = '▲ 收起更多';
        } else {
          span.innerHTML = '▼ 显示更多 ' + hiddenCount + ' 条记录';
        }
      }
    }

    // Toggle expandable row details (for iterator results)
    function toggleExpandableRow(arg) {
      // Support both toggleExpandableRow(rowId: string) and toggleExpandableRow(buttonEl: HTMLElement)
      let detailsRow = null;
      let btn = null;

      if (typeof arg === 'string') {
        const rowId = arg;
        detailsRow = document.getElementById(rowId + '_details');
        // Find the owning row (avoid accidental matches if other elements reuse the same data attribute)
        const expandableRow = document.querySelector('.expandable-row[data-row-id=\"' + rowId + '\"]');
        btn = expandableRow ? expandableRow.querySelector('.expand-btn') : null;
      } else if (arg && arg.closest) {
        btn = arg;
        const tr = btn.closest('tr');
        detailsRow = tr ? tr.nextElementSibling : null;
      }

      if (detailsRow) {
        const isHidden = detailsRow.style.display === 'none';
        detailsRow.style.display = isHidden ? 'table-row' : 'none';

        if (btn) {
          btn.innerHTML = isHidden
            ? '<span class="expand-icon">▲</span> 收起'
            : '<span class="expand-icon">▼</span> 展开';
        }
      }
    }

    // Expand/collapse all rows in a section
    function toggleAllExpandableRows(sectionId, expand) {
      const section = document.getElementById(sectionId);
      if (!section) return;

      const detailRows = section.querySelectorAll('.detail-row');
      const buttons = section.querySelectorAll('.expand-btn');

      detailRows.forEach(row => {
        row.style.display = expand ? 'table-row' : 'none';
      });

      buttons.forEach(btn => {
        btn.innerHTML = expand
          ? '<span class="expand-icon">▲</span> 收起'
          : '<span class="expand-icon">▼</span> 展开';
      });
    }

    // Legacy copy button handler for backward compatibility
    document.querySelectorAll('.copy-btn').forEach(btn => {
      btn.addEventListener('click', function() {
        const sql = this.getAttribute('data-sql');
        if (sql) {
          navigator.clipboard.writeText(sql).then(() => {
            const originalText = this.textContent;
            this.textContent = '已复制!';
            setTimeout(() => {
              this.textContent = originalText;
            }, 2000);
          });
        }
      });
    });

    // 检测表格是否可滚动，添加滚动提示
    function initTableScroll() {
      document.querySelectorAll('.table-container').forEach(container => {
        const table = container.querySelector('table');
        if (!table) return;

        // 检查是否需要滚动
        function checkScrollable() {
          if (container.scrollWidth > container.clientWidth) {
            container.classList.add('scrollable');
          } else {
            container.classList.remove('scrollable');
          }
        }

        // 检查是否滚动到最右边
        function checkScrollPosition() {
          const scrollRight = container.scrollWidth - container.clientWidth - container.scrollLeft;
          if (scrollRight <= 5) {
            container.classList.add('scrolled-right');
          } else {
            container.classList.remove('scrolled-right');
          }
        }

        // 初始化
        checkScrollable();
        checkScrollPosition();

        // 监听滚动事件
        container.addEventListener('scroll', checkScrollPosition);

        // 监听窗口大小变化
        window.addEventListener('resize', () => {
          checkScrollable();
          checkScrollPosition();
        });
      });
    }

    // 页面加载完成后初始化
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', initTableScroll);
    } else {
      initTableScroll();
    }

    // Deep 层滑动区间折叠功能
    function toggleDeepSession(sessionId) {
      const content = document.getElementById(sessionId + '_content');
      const header = content.previousElementSibling;
      const icon = header.querySelector('.session-toggle-icon');
      if (content.style.display === 'none') {
        content.style.display = 'block';
        icon.textContent = '▼';
      } else {
        content.style.display = 'none';
        icon.textContent = '▶';
      }
    }

    // Deep 层单帧折叠功能
    function toggleDeepFrame(frameId) {
      const content = document.getElementById(frameId + '_content');
      const header = content.previousElementSibling;
      const icon = header.querySelector('.frame-toggle-icon');
      const hint = header.querySelector('span[style*="color: #94a3b8"]');
      if (content.style.display === 'none') {
        content.style.display = 'block';
        icon.textContent = '▼';
        if (hint) hint.textContent = '点击收起';
      } else {
        content.style.display = 'none';
        icon.textContent = '▶';
        if (hint) hint.textContent = '点击展开详情';
      }
    }

    // Deep 层展开/折叠某个session下所有帧
    function toggleAllFramesInDeepSession(sessionId) {
      const sessionContent = document.getElementById(sessionId + '_content');
      if (!sessionContent) return;
      const frameContents = sessionContent.querySelectorAll('.deep-frame-content');
      const allCollapsed = Array.from(frameContents).every(f => f.style.display === 'none');

      frameContents.forEach(content => {
        const header = content.previousElementSibling;
        const icon = header.querySelector('.frame-toggle-icon');
        const hint = header.querySelector('span[style*="color: #94a3b8"]');
        if (allCollapsed) {
          content.style.display = 'block';
          if (icon) icon.textContent = '▼';
          if (hint) hint.textContent = '点击收起';
        } else {
          content.style.display = 'none';
          if (icon) icon.textContent = '▶';
          if (hint) hint.textContent = '点击展开详情';
        }
      });
    }
  </script>
</body>
</html>`;
  }

  /**
   * Generate skill engine specific section
   */
  private generateSkillEngineSection(skillResult: any): string {
    let html = `
    <!-- Skill Engine Results -->
    <div class="section">
      <h2 class="section-title">Skill Engine 分析结果</h2>
      <div class="metrics-grid">
        <div class="metric-card">
          <div class="label">分析类型</div>
          <div class="value">${skillResult.skillName}</div>
        </div>
        <div class="metric-card">
          <div class="label">执行耗时</div>
          <div class="value">${skillResult.executionTimeMs}ms</div>
        </div>
        ${skillResult.diagnostics?.length ? `
        <div class="metric-card">
          <div class="label">诊断问题</div>
          <div class="value">${skillResult.diagnostics.length}</div>
        </div>
        ` : ''}
      </div>
    `;

    // 优先处理分层结果
    if (skillResult.layeredResult) {
      html += this.generateLayeredResultSection(skillResult.layeredResult);
    }

    // Diagnostics
    if (skillResult.diagnostics && skillResult.diagnostics.length > 0) {
      html += `
      <h3 style="margin: 20px 0 15px; font-size: 16px;">诊断结果</h3>
      ${skillResult.diagnostics.map((diag: any) => `
        <div class="diagnostic ${diag.severity}">
          <div class="severity">${this.getSeverityLabel(diag.severity)}</div>
          <div>${this.escapeHtml(diag.message)}</div>
          ${diag.suggestions ? `
            <ul class="suggestions">
              ${diag.suggestions.map((s: string) => `<li>${this.escapeHtml(s)}</li>`).join('')}
            </ul>
          ` : ''}
        </div>
      `).join('')}
      `;
    }

    // Sections (仅在没有 layeredResult 时渲染)
    if (!skillResult.layeredResult && skillResult.sections) {
      html += `<h3 style="margin: 30px 0 15px; font-size: 16px;">详细分析数据</h3>`;

      for (const [sectionId, sectionData] of Object.entries(skillResult.sections)) {
        const data = sectionData as any;

        // Handle for_each results (array) - 这是旧格式，保留兼容性
        if (Array.isArray(data)) {
          const allRows: any[] = [];
          let columns: string[] = [];

          for (const itemResult of data) {
            if (itemResult?.data && Array.isArray(itemResult.data)) {
              if (columns.length === 0 && itemResult.data.length > 0) {
                columns = Object.keys(itemResult.data[0]);
              }
              allRows.push(...itemResult.data);
            }
          }

          if (allRows.length > 0) {
            html += `
              <div class="skill-section">
                <div class="section-header">
                  <h3>${sectionId}</h3>
                  <span class="count">${allRows.length} 条记录</span>
                </div>
                ${this.generateTable(columns, allRows)}
              </div>
            `;
          }
        }
        // Handle new format with expandableData (iterator results)
        else if (data?.expandableData && Array.isArray(data.expandableData)) {
          html += this.generateExpandableSection(sectionId, data);
        }
        // Handle regular step results
        else if (data?.data && Array.isArray(data.data) && data.data.length > 0) {
          const columns = data.columns || Object.keys(data.data[0]);
          html += `
            <div class="skill-section">
              <div class="section-header">
                <h3>${data.title || sectionId}</h3>
                <span class="count">${data.data.length} 条记录</span>
              </div>
              ${data.sql ? `
                <div class="sql-block collapsed" onclick="toggleSqlBlock(event, this)">
                  <div class="sql-header">
                    <span class="toggle-icon">▼</span>
                    <span class="title">SQL 查询</span>
                    <button class="copy-btn" data-sql="${this.escapeHtml(data.sql)}" onclick="event.stopPropagation(); copySql(this)">复制 SQL</button>
                  </div>
                  <div class="sql-content">
                    <pre>${this.escapeHtml(data.sql)}</pre>
                  </div>
                </div>
              ` : ''}
              ${this.generateTable(columns, data.data)}
            </div>
          `;
        }
        // Handle text format
        else if (data?.format === 'text' && data?.data?.[0]?.text) {
          html += `
            <div class="skill-section">
              <div class="section-header">
                <h3>${data.title || sectionId}</h3>
              </div>
              <div class="answer-box">
                ${this.formatAnswer(data.data[0].text)}
              </div>
            </div>
          `;
        }
      }
    }

    html += `</div>`;
    return html;
  }

  /**
   * Generate expandable section for iterator results
   * 生成可展开的迭代器结果区块，包含主表格和每行的详细数据
   */
  private generateExpandableSection(sectionId: string, data: any): string {
    const title = data.title || sectionId;
    const expandableData = data.expandableData as Array<{
      item: Record<string, any>;
      result: {
        success: boolean;
        sections?: Record<string, any>;
        error?: string;
      };
    }>;

    // 生成唯一的 section ID 用于 JavaScript 操作
    // 注意：不能使用 Date.now()，同一毫秒内渲染多个同 stepId 的表会导致 id 冲突，
    // 从而使“展开”按钮总是命中第一个表格，表现为“点了没反应”。
    const sectionUniqueId = this.nextDomId(`expandable_${sectionId}`);

    let html = `
      <div class="report-card expandable-section" id="${sectionUniqueId}">
        <div class="header" style="background: #f8fafc; padding: 16px; border-bottom: 1px solid var(--border-color);">
           <h3 style="margin: 0; font-size: 16px; font-weight: 600; color: var(--text-main); display: flex; align-items: center;">
             ${title}
             <span class="badge" style="margin-left: 12px; font-weight: normal; font-size: 12px; background: #e0e7ff; color: #4338ca;">${expandableData.length} 条记录</span>
           </h3>
        </div>
    `;

    // 显示汇总报告（如果存在）
    if (data.summary) {
      html += `
        <div class="summary-box" style="margin-bottom: 20px; padding: 15px; background: #f0f9ff; border-radius: 8px; border-left: 4px solid #3b82f6;">
          <strong>${this.escapeHtml(data.summary.title || '汇总')}</strong><br>
          ${this.formatAnswer(data.summary.content || '')}
        </div>
      `;
    }

    // 生成主表格（使用 data.columns 和 data.data）
    if (data.columns && data.data && data.data.length > 0) {
      // Filter out absolute timestamp columns when relative timestamp columns exist
      const absoluteTimestampCols = new Set<string>();
      const filteredColumns = data.columns.filter((col: string) => {
        if (col.endsWith('_ts') && col !== 'perfetto_start' && col !== 'perfetto_end') {
          const relCol = col + '_rel';
          if (data.columns.includes(relCol)) {
            absoluteTimestampCols.add(col);
            return false;  // Skip absolute timestamp column
          }
        }
        return true;
      });

      // Detect constant columns (like process_name, layer_name)
      const constantColumns: Record<string, any> = {};
      const variableColumns: string[] = [];

      for (const col of filteredColumns) {
        const firstValue = data.data[0][col];
        const isConstant = data.data.every((row: any) => row[col] === firstValue);

        if (isConstant && firstValue !== undefined && firstValue !== null) {
          constantColumns[col] = firstValue;
        } else {
          variableColumns.push(col);
        }
      }

      // Build the constant column info for the table header
      // 【P2 Fix】使用可配置的元数据列名代替硬编码
      const constantColumnLabels = Object.entries(constantColumns)
        .filter(([col]) => this.isMetadataColumn(col))
        .map(([col, value]) => `<span style="color: #666; font-size: 12px; margin-left: 8px;">${this.escapeHtml(col)}: <strong>${this.escapeHtml(this.stringifyValueForDisplay(value, 160))}</strong></span>`)
        .join('');

      // 主表格 + 展开行（colspan 横跨所有列）
      const totalColumns = variableColumns.length + 1; // +1 for 详情列
      html += `
        <div class="table-container expandable-table">
          ${constantColumnLabels ? `
            <div class="table-header-info" style="padding: 8px 12px; background: #f8f9fa; border-bottom: 1px solid #eaeaea; font-size: 13px;">
              ${constantColumnLabels}
            </div>
          ` : ''}
          <table>
            <thead>
              <tr>
                ${variableColumns.map((col: string) => `<th>${this.escapeHtml(col)}</th>`).join('')}
                <th style="width: 80px;">详情</th>
              </tr>
            </thead>
            <tbody>
      `;

      data.data.forEach((row: any, idx: number) => {
        const expandableItem = expandableData[idx];
        const hasExpandable = !!expandableItem;
        const hasDetails = expandableItem?.result?.sections &&
          Object.keys(expandableItem.result.sections || {}).length > 0;
        const rowId = `${sectionUniqueId}_row_${idx}`;

        // 主数据行
        html += `
              <tr class="expandable-row" data-row-id="${rowId}">
                ${variableColumns.map((col: string) => {
          const value = Array.isArray(row) ? row[data.columns.indexOf(col)] : row[col];
          return `<td>${this.formatCellValue(value, col)}</td>`;
        }).join('')}
                <td>
                  ${hasExpandable ? `
                    <button class="expand-btn" onclick="toggleExpandableRow('${rowId}')" style="background: none; border: none; cursor: pointer; color: #4338ca; font-size: 12px; font-weight: 600; padding: 4px 8px;">
                      <span class="expand-icon">▼</span> ${hasDetails ? '展开' : '详情'}
                    </button>
                  ` : '<span style="color: #999;">-</span>'}
                </td>
              </tr>
        `;

        // 展开详情行（默认隐藏，横跨所有列）
        if (hasExpandable) {
          html += `
              <tr id="${rowId}_details" class="details-row" style="display: none;">
                <td colspan="${totalColumns}" style="padding: 0; background: #fafbfc;">
                  ${this.generateDetailContent(expandableItem)}
                </td>
              </tr>
          `;
        }
      });

      html += `
            </tbody>
          </table>
        </div>
      `;
    }

    html += `</div>`;
    return html;
  }

  /**
   * Generate detail content for a single expandable row
   * 生成单行展开后的详细内容
   */
  private generateDetailContent(itemData: {
    item: Record<string, any>;
    result: {
      success: boolean;
      sections?: Record<string, any>;
      error?: string;
    };
  }): string {
    const { item, result } = itemData;
    const uniqueId = this.domIdSeq++;

    let html = `<div class="detail-content" style="padding: 15px; border-left: 4px solid #667eea;">`;

    // 不再显示原始 JSON 数据，与前端保持一致

    if (!result.success) {
      html += `
        <div class="diagnostic critical">
          <div class="severity">❌ 分析失败</div>
          <div>${this.escapeHtml(result.error || '未知错误')}</div>
        </div>
      `;
    } else if (result.sections) {
      const sectionsEntries = Object.entries(result.sections);
      const emptySections: string[] = [];

      // 遍历所有 sections 生成表格
      for (const [subSectionId, subSectionData] of sectionsEntries) {
        const subData = subSectionData as any;
        const subTitle = subData.title || subSectionId;

        if (subData.data && Array.isArray(subData.data) && subData.data.length > 0) {
          const columns = subData.columns || Object.keys(subData.data[0]);
          const dataCount = subData.data.length;
          const collapsedId = `detail-section-${uniqueId}-${subSectionId.replace(/[^a-zA-Z0-9]/g, '-')}`;

          // 诊断要点使用更紧凑的表格格式
          if (subSectionId === 'frame_diagnosis' || subTitle.includes('诊断') || subTitle.includes('diagnosis')) {
            html += this.generateDiagnosisTable(subData.data, subTitle, collapsedId);
          } else {
            // 其他 section: 默认展开显示数据表格
            html += `
              <div style="margin-bottom: 16px;">
                <h4 style="font-size: 14px; font-weight: 600; color: #2c3e50; margin: 0 0 8px 0;">
                  ${this.escapeHtml(subTitle)}
                  <span style="font-weight: normal; color: #666; font-size: 12px; margin-left: 8px;">(${dataCount} 条)</span>
                </h4>
                ${this.generateTable(columns, subData.data.slice(0, 20))}
                ${dataCount > 20 ? `<div style="text-align: center; padding: 8px; color: #666; font-size: 12px;">... 还有 ${dataCount - 20} 条</div>` : ''}
              </div>
            `;
          }
        } else if (subData.diagnostics && Array.isArray(subData.diagnostics) && subData.diagnostics.length > 0) {
          // 显示诊断结果（以表格形式）
          const collapsedId = `detail-diag-${uniqueId}-${subSectionId.replace(/[^a-zA-Z0-9]/g, '-')}`;
          html += this.generateDiagnosticsAsTable(subData.diagnostics, subTitle, collapsedId);
        } else {
          // 空 section，记录名称
          emptySections.push(subTitle);
        }
      }

      // 所有 section 都为空时显示简洁提示
      if (sectionsEntries.length > 0 && emptySections.length === sectionsEntries.length) {
        html += `<div style="padding: 12px; color: #666; font-size: 13px;">无详细数据 (${emptySections.join(', ')})</div>`;
      }
    }

    html += `</div>`;
    return html;
  }

  /**
   * 生成诊断要点表格（与前端一致的格式）
   */
  private generateDiagnosisTable(data: any[], title: string, collapsedId: string): string {
    // 构建诊断表格数据
    const diagRows: Array<{severity: string; title: string; description: string; source?: string}> = [];

    for (const item of data) {
      if (item.diagnosis || item.message) {
        diagRows.push({
          severity: item.severity || 'info',
          title: item.diagnosis || item.message || '',
          description: Array.isArray(item.suggestions) ? item.suggestions.join('; ') : (item.suggestions || ''),
          source: item.source || '',
        });
      }
    }

    if (diagRows.length === 0) {
      return '';
    }

    return `
      <div style="margin-bottom: 16px;">
        <h4 style="font-size: 14px; font-weight: 600; margin-bottom: 12px; color: #2c3e50;">
          ${this.escapeHtml(title)}
        </h4>
        <table style="width: 100%; border-collapse: collapse; font-size: 13px;">
          <thead>
            <tr style="background: #f8fafc; border-bottom: 2px solid #e2e8f0;">
              <th style="padding: 10px 12px; text-align: left; font-weight: 600; color: #64748b; width: 80px;">severity</th>
              <th style="padding: 10px 12px; text-align: left; font-weight: 600; color: #64748b;">title</th>
              <th style="padding: 10px 12px; text-align: left; font-weight: 600; color: #64748b;">description</th>
              <th style="padding: 10px 12px; text-align: left; font-weight: 600; color: #64748b; width: 150px;">source</th>
            </tr>
          </thead>
          <tbody>
            ${diagRows.map(row => `
              <tr style="border-bottom: 1px solid #e2e8f0;">
                <td style="padding: 10px 12px; color: ${row.severity === 'critical' ? '#dc2626' : row.severity === 'warning' ? '#d97706' : '#059669'}; font-weight: 500;">
                  ${this.escapeHtml(row.severity)}
                </td>
                <td style="padding: 10px 12px; color: #334155; max-width: 400px; overflow: hidden; text-overflow: ellipsis;">
                  ${this.escapeHtml(row.title)}
                </td>
                <td style="padding: 10px 12px; color: #64748b; max-width: 300px; overflow: hidden; text-overflow: ellipsis;">
                  ${this.escapeHtml(row.description)}
                </td>
                <td style="padding: 10px 12px; color: #94a3b8; font-size: 12px;">
                  ${this.escapeHtml(row.source)}
                </td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    `;
  }

  /**
   * 将诊断数组渲染为表格（与前端一致）
   */
  private generateDiagnosticsAsTable(diagnostics: any[], title: string, collapsedId: string): string {
    const diagRows: Array<{severity: string; title: string; description: string; source?: string}> = [];

    for (const diag of diagnostics) {
      diagRows.push({
        severity: diag.severity || 'info',
        title: diag.diagnosis || diag.message || '',
        description: Array.isArray(diag.suggestions) ? diag.suggestions.join('; ') : (diag.suggestions || ''),
        source: diag.source || '',
      });
    }

    if (diagRows.length === 0) {
      return '';
    }

    return `
      <div style="margin-bottom: 16px;">
        <h4 style="font-size: 14px; font-weight: 600; margin-bottom: 12px; color: #2c3e50;">
          ${this.escapeHtml(title)}
        </h4>
        <table style="width: 100%; border-collapse: collapse; font-size: 13px;">
          <thead>
            <tr style="background: #f8fafc; border-bottom: 2px solid #e2e8f0;">
              <th style="padding: 10px 12px; text-align: left; font-weight: 600; color: #64748b; width: 80px;">severity</th>
              <th style="padding: 10px 12px; text-align: left; font-weight: 600; color: #64748b;">title</th>
              <th style="padding: 10px 12px; text-align: left; font-weight: 600; color: #64748b;">description</th>
              <th style="padding: 10px 12px; text-align: left; font-weight: 600; color: #64748b; width: 150px;">source</th>
            </tr>
          </thead>
          <tbody>
            ${diagRows.map(row => `
              <tr style="border-bottom: 1px solid #e2e8f0;">
                <td style="padding: 10px 12px; color: ${row.severity === 'critical' ? '#dc2626' : row.severity === 'warning' ? '#d97706' : '#059669'}; font-weight: 500;">
                  ${this.escapeHtml(row.severity)}
                </td>
                <td style="padding: 10px 12px; color: #334155;">
                  ${this.escapeHtml(row.title)}
                </td>
                <td style="padding: 10px 12px; color: #64748b;">
                  ${this.escapeHtml(row.description)}
                </td>
                <td style="padding: 10px 12px; color: #94a3b8; font-size: 12px;">
                  ${this.escapeHtml(row.source)}
                </td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    `;
  }

  /**
   * Generate query result section with collapsible support
   */
  private generateQueryResultSection(result: CollectedResult, stepNumber: number): string {
    // 如果 insight 是 section title，将其作为主标题显示
    const displayTitle = result.insight && result.insight !== result.sql
      ? result.insight
      : `查询 #${stepNumber}`;

    return `
      <div class="report-card">
        <div class="header" onclick="toggleQueryResult(this)" style="cursor: pointer; padding: 16px 24px; border-bottom: 1px solid var(--border-color); background: #f8fafc;">
          <h3 style="font-size: 15px; font-weight: 600; color: var(--text-main); display: flex; align-items: center; margin: 0;">
            <span class="toggle-icon" style="margin-right: 8px; font-size: 12px; color: var(--text-secondary);">▼</span>
            ${this.escapeHtml(displayTitle)}
          </h3>
          <span class="meta" style="font-size: 12px; color: var(--text-secondary);">${result.result.rowCount} 行 · ${result.result.durationMs}ms</span>
        </div>

        <div class="query-body" style="padding: 16px;">
          <!-- SQL Block -->
          <div class="code-block" style="margin-bottom: 16px;">
            <div style="display: flex; justify-content: space-between; margin-bottom: 8px;">
               <span style="font-size: 12px; color: #9ca3af;">SQL Query</span>
               <button class="copy-btn" data-sql="${this.escapeHtml(result.sql)}" onclick="copySql(this)">Copy</button>
            </div>
            <pre style="margin: 0;">${this.escapeHtml(result.sql)}</pre>
          </div>

          ${result.result.error ? `
            <div style="padding: 12px; background: #fef2f2; border-left: 4px solid #ef4444; border-radius: 4px; margin-bottom: 12px;">
              <div style="color: #ef4444; font-weight: 600; margin-bottom: 4px;">ERROR</div>
              <div style="font-family: monospace;">${this.escapeHtml(result.result.error)}</div>
            </div>
          ` : result.result.rowCount > 0 ? `
            ${this.generateTable(result.result.columns, this.rowsToObjects(result.result.columns, result.result.rows))}
          ` : `
            <div style="padding: 20px; text-align: center; color: var(--text-secondary); background: var(--bg-body); border-radius: 6px;">
              查询返回空结果
            </div>
          `}

          ${result.insight ? `
            <div style="margin-top: 16px; padding: 12px; background: var(--primary-bg); border-radius: 6px; border-left: 4px solid var(--primary-color);">
              <strong style="color: var(--primary-color); display: block; margin-bottom: 4px;">AI 分析:</strong>
              ${this.formatAnswer(result.insight)}
            </div>
          ` : ''}
        </div>
      </div>
    `;
  }

  /**
   * Generate HTML table from data (with collapsible rows for large tables)
   */
  private generateTable(columns: string[], rows: any[]): string {
    if (!rows || rows.length === 0) {
      return '<div class="empty-state">无数据</div>';
    }

    const totalRows = rows.length;
    const defaultVisibleRows = 10;
    const hasMore = totalRows > defaultVisibleRows;

    // Filter out absolute timestamp columns when relative timestamp columns exist
    // This makes the report more readable by showing relative times instead of raw nanoseconds
    const absoluteTimestampCols = new Set<string>();
    const relativeTimestampCols = new Set<string>();

    for (const col of columns) {
      if (col.endsWith('_ts') && col !== 'perfetto_start' && col !== 'perfetto_end') {
        const relCol = col + '_rel';
        if (columns.includes(relCol)) {
          absoluteTimestampCols.add(col);
          relativeTimestampCols.add(relCol);
        }
      }
    }

    // Filter out absolute timestamp columns that have relative counterparts
    const filteredColumns = columns.filter(col => !absoluteTimestampCols.has(col));

    // Detect columns with constant values (like process_name, layer_name)
    // These should be moved to the table header instead of repeating in every row
    // BUT: Only do this for tables with multiple rows - single row tables should show all columns
    const constantColumns: Record<string, any> = {};
    const variableColumns: string[] = [];

    // For single-row tables, show all columns (no point in hiding "constant" columns)
    if (rows.length === 1) {
      variableColumns.push(...filteredColumns);
    } else {
      for (const col of filteredColumns) {
        const firstValue = rows[0][col];
        const isConstant = rows.every(row => row[col] === firstValue);

        if (isConstant && firstValue !== undefined && firstValue !== null) {
          constantColumns[col] = firstValue;
        } else {
          variableColumns.push(col);
        }
      }
    }

    // Always render all rows, but hide extra rows via CSS class
    const visibleRows = rows.slice(0, defaultVisibleRows);
    const hiddenRows = hasMore ? rows.slice(defaultVisibleRows) : [];

    // Build the constant column info for the table header
    // 【P2 Fix】使用可配置的元数据列名代替硬编码
    const constantColumnLabels = Object.entries(constantColumns)
      .filter(([col]) => this.isMetadataColumn(col))
      .map(([col, value]) => `<span style="color: #666; font-size: 12px; margin-left: 8px;">${this.escapeHtml(col)}: <strong>${this.escapeHtml(this.stringifyValueForDisplay(value, 160))}</strong></span>`)
      .join('');

    return `
      <div class="table-container ${totalRows > defaultVisibleRows ? 'scrollable' : ''}">
        <table>
        <thead>
        <tr>
        <th># </th>
              ${variableColumns.map(col => `<th>${this.escapeHtml(col)}</th>`).join('')}
    </tr>
      </thead>
      <tbody>
            ${visibleRows.map((row, idx) => `
              <tr>
                <td style="color: #666; font-weight: 500;">${idx + 1}</td>
                ${variableColumns.map(col => `<td class="${this.getCellClass(row[col])}">${this.formatCellValue(row[col], col)}</td>`).join('')}
              </tr>
            `).join('')
      }
            ${hiddenRows.map((row, idx) => `
              <tr class="hidden-row" style="display: none;">
                <td style="color: #666; font-weight: 500;">${defaultVisibleRows + idx + 1}</td>
                ${variableColumns.map(col => `<td class="${this.getCellClass(row[col])}">${this.formatCellValue(row[col], col)}</td>`).join('')}
              </tr>
            `).join('')
      }
    </tbody>
      </table>
        ${hasMore ? `
          <div class="table-rows-more" onclick="toggleTableRows(this, ${totalRows - defaultVisibleRows})">
            <span>▼ 显示更多 ${totalRows - defaultVisibleRows} 条记录</span>
          </div>
        ` : ''
      }
    </div>
      `;
  }

  /**
   * Generate HTML table from DataEnvelope (v2.0 schema-driven rendering)
   *
   * This method uses the column definitions from the envelope's display config
   * to render the table with proper formatting and styling.
   */
  private generateTableFromEnvelope(envelope: DataEnvelope, traceStartNs: bigint | null): string {
    const { data, display } = envelope;

    // Ensure we have table data
    if (!data.columns || !data.rows || data.rows.length === 0) {
      return '<div class="empty-state">无数据</div>';
    }

    // 【FIX】Check for expandableData and use expandable rendering if present
    // This enables click-to-expand rows in Agent-Driven HTML reports (like frontend does)
    if (data.expandableData && data.expandableData.length > 0) {
      return this.generateExpandableTableFromEnvelope(envelope, traceStartNs);
    }

    // Build column definitions (use explicit ones from display, or infer from column names)
    const columnDefs = display.columns || buildColumnDefinitions(data.columns);

    const totalRows = data.rows.length;
    const defaultVisibleRows = 10;
    const hasMore = totalRows > defaultVisibleRows;

    // Identify metadata columns (to show in header, not in table)
    const metadataFields = new Set(display.metadataFields || []);
    const metadataValues: Record<string, any> = {};
    const displayColumnDefs: ColumnDefinition[] = [];

    for (let i = 0; i < columnDefs.length; i++) {
      const colDef = columnDefs[i];
      const colName = colDef.name;

      if (metadataFields.has(colName)) {
        // Extract metadata value from first row
        if (data.rows.length > 0) {
          metadataValues[colName] = data.rows[0][i];
        }
      } else if (!colDef.hidden) {
        displayColumnDefs.push(colDef);
      }
    }

    // Build the constant column info for the table header
    const metadataLabels = Object.entries(metadataValues)
      .map(([col, value]) => {
        const label = columnDefs.find(d => d.name === col)?.label || col;
        return `<span style="color: #666; font-size: 12px; margin-left: 8px;">${this.escapeHtml(label)}: <strong>${this.escapeHtml(this.stringifyValueForDisplay(value, 160))}</strong></span>`;
      })
      .join('');

    // Map column names to their indices in the original data
    const columnIndices = new Map<string, number>();
    data.columns.forEach((col, idx) => columnIndices.set(col, idx));

    const visibleRows = data.rows.slice(0, defaultVisibleRows);
    const hiddenRows = hasMore ? data.rows.slice(defaultVisibleRows) : [];

    return `
      <div class="table-container ${totalRows > defaultVisibleRows ? 'scrollable' : ''}">
        ${metadataLabels ? `<div class="table-metadata">${metadataLabels}</div>` : ''}
        <table>
          <thead>
            <tr>
              <th>#</th>
              ${displayColumnDefs.map(colDef => {
                const label = colDef.label || colDef.name;
                const tooltip = colDef.tooltip ? ` title="${this.escapeHtml(colDef.tooltip)}"` : '';
                return `<th${tooltip}>${this.escapeHtml(label)}</th>`;
              }).join('')}
            </tr>
          </thead>
          <tbody>
            ${visibleRows.map((row, idx) => `
              <tr>
                <td style="color: #666; font-weight: 500;">${idx + 1}</td>
                ${displayColumnDefs.map(colDef => {
                  const colIdx = columnIndices.get(colDef.name);
                  const value = colIdx !== undefined ? row[colIdx] : undefined;
                  return `<td class="${this.getCellClassFromDefinition(value, colDef)}">${this.formatCellValueFromDefinition(value, colDef, traceStartNs)}</td>`;
                }).join('')}
              </tr>
            `).join('')}
            ${hiddenRows.map((row, idx) => `
              <tr class="hidden-row" style="display: none;">
                <td style="color: #666; font-weight: 500;">${defaultVisibleRows + idx + 1}</td>
                ${displayColumnDefs.map(colDef => {
                  const colIdx = columnIndices.get(colDef.name);
                  const value = colIdx !== undefined ? row[colIdx] : undefined;
                  return `<td class="${this.getCellClassFromDefinition(value, colDef)}">${this.formatCellValueFromDefinition(value, colDef, traceStartNs)}</td>`;
                }).join('')}
              </tr>
            `).join('')}
          </tbody>
        </table>
        ${hasMore ? `
          <div class="table-rows-more" onclick="toggleTableRows(this, ${totalRows - defaultVisibleRows})">
            <span>▼ 显示更多 ${totalRows - defaultVisibleRows} 条记录</span>
          </div>
        ` : ''}
      </div>
    `;
  }

  /**
   * Generate expandable table from DataEnvelope.expandableData while respecting display columns/metadata.
   * This matches frontend behavior: show only visible columns, expand rows to show deep sections.
   */
  private generateExpandableTableFromEnvelope(envelope: DataEnvelope, traceStartNs: bigint | null): string {
    const { data, display } = envelope;
    const title = display.title || envelope.meta?.stepId || envelope.meta?.source || '数据表';

    if (!data.columns || !data.rows || !data.expandableData) {
      return '<div class="empty-state">无数据</div>';
    }

    const columns = data.columns;
    const rows = data.rows;
    const expandableData = data.expandableData as any[];

    const columnDefs = display.columns || buildColumnDefinitions(columns);
    const metadataFields = new Set(display.metadataFields || []);

    // Extract metadata values from the first row for configured metadataFields
    const metadataValues: Record<string, any> = {};
    if (rows.length > 0) {
      for (let i = 0; i < columnDefs.length; i++) {
        const colDef = columnDefs[i];
        if (metadataFields.has(colDef.name)) {
          metadataValues[colDef.name] = rows[0][i];
        }
      }
    }

    const metadataLabels = Object.entries(metadataValues)
      .map(([col, value]) => {
        const label = columnDefs.find(d => d.name === col)?.label || col;
        return `<span style="color: #666; font-size: 12px; margin-left: 8px;">${this.escapeHtml(label)}: <strong>${this.escapeHtml(this.stringifyValueForDisplay(value, 160))}</strong></span>`;
      })
      .join('');

    // Visible columns: exclude metadata + hidden
    const visibleColumnDefs = columnDefs.filter(cd => !metadataFields.has(cd.name) && !cd.hidden);

    const columnIndices = new Map<string, number>();
    columns.forEach((c, idx) => columnIndices.set(c, idx));

    // Convert each row to an object for detail "item" fallback
    const rowObjects = rows.map((row: any[]) => {
      const obj: Record<string, any> = {};
      columns.forEach((c, i) => { obj[c] = row[i]; });
      return obj;
    });

    // Unique section id (used only for future bulk operations / safety)
    const sectionUniqueId = this.nextDomId(`expandable_${envelope.meta?.stepId || 'table'}`);

    return `
      <div class="report-card expandable-section" id="${sectionUniqueId}">
        <div class="header" style="background: #f8fafc; padding: 16px; border-bottom: 1px solid var(--border-color);">
          <h3 style="margin: 0; font-size: 16px; font-weight: 600; color: var(--text-main); display: flex; align-items: center;">
            ${this.escapeHtml(title)}
            <span class="badge" style="margin-left: 12px; font-weight: normal; font-size: 12px; background: #e0e7ff; color: #4338ca;">${rows.length} 条记录</span>
          </h3>
        </div>

        <div class="table-container expandable-table">
          ${metadataLabels ? `<div class="table-metadata">${metadataLabels}</div>` : ''}
          <table>
            <thead>
              <tr>
                ${visibleColumnDefs.map((colDef) => {
                  const label = colDef.label || colDef.name;
                  const tooltip = colDef.tooltip ? ` title="${this.escapeHtml(colDef.tooltip)}"` : '';
                  return `<th${tooltip}>${this.escapeHtml(label)}</th>`;
                }).join('')}
                <th style="width: 80px;">详情</th>
              </tr>
            </thead>
            <tbody>
              ${rows.map((row: any[], idx: number) => {
                const exp = expandableData[idx];
                const hasDetails = !!(exp && exp.result && exp.result.sections && Object.keys(exp.result.sections).length > 0);
                const itemData = exp && exp.item ? exp.item : rowObjects[idx];
                const detailData = exp ? { ...exp, item: itemData } : { item: itemData, result: { success: false, error: '无详情数据' } };
                const rowId = `envelope_row_${this.domIdSeq++}`;
                const totalColumns = visibleColumnDefs.length + 1; // +1 for 详情列

                // 主数据行
                const mainRow = `
                  <tr class="expandable-row" data-row-id="${rowId}">
                    ${visibleColumnDefs.map((colDef) => {
                      const colIdx = columnIndices.get(colDef.name);
                      const value = colIdx !== undefined ? row[colIdx] : undefined;
                      return `<td class="${this.getCellClassFromDefinition(value, colDef)}">${this.formatCellValueFromDefinition(value, colDef, traceStartNs)}</td>`;
                    }).join('')}
                    <td>
                      <button class="expand-btn" onclick="toggleExpandableRow('${rowId}')" style="background: none; border: none; cursor: pointer; color: #4338ca; font-size: 12px; font-weight: 600; padding: 4px 8px;">
                        <span class="expand-icon">▼</span> ${hasDetails ? '展开' : '详情'}
                      </button>
                    </td>
                  </tr>
                `;

                // 展开详情行（默认隐藏，横跨所有列）
                const detailsRow = `
                  <tr id="${rowId}_details" class="details-row" style="display: none;">
                    <td colspan="${totalColumns}" style="padding: 0; background: #fafbfc;">
                      ${this.generateDetailContent(detailData)}
                    </td>
                  </tr>
                `;

                return mainRow + detailsRow;
              }).join('')}
            </tbody>
          </table>
        </div>
      </div>
    `;
  }

  /**
   * Get CSS class for a cell based on column definition
   */
  private getCellClassFromDefinition(value: any, colDef: ColumnDefinition): string {
    const classes: string[] = [];

    // Type-based classes
    if (colDef.type === 'number' || colDef.type === 'duration' || colDef.type === 'bytes') {
      classes.push('numeric');
    }
    if (colDef.type === 'timestamp') {
      classes.push('timestamp');
    }
    if (colDef.type === 'percentage') {
      classes.push('percentage');
    }

    // Format-based classes
    if (colDef.format === 'code') {
      classes.push('code');
    }

    // Value-based styling
    if (colDef.type === 'number' && typeof value === 'number' && value < 0) {
      classes.push('negative');
    }

    return classes.join(' ');
  }

  /**
   * Format a cell value based on column definition
   */
  private formatCellValueFromDefinition(value: any, colDef: ColumnDefinition, traceStartNs: bigint | null): string {
    if (value === null || value === undefined) {
      return '<span style="color: #999;">-</span>';
    }

    if (this.isIdentifierKey(colDef.name)) {
      return this.escapeHtml(this.normalizeIdentifierDisplay(value));
    }

    const format = colDef.format || 'default';

    switch (format) {
      case 'timestamp_relative': {
        const ts = this.parseNs(value);
        if (ts !== null) {
          const rel = traceStartNs ? ts - traceStartNs : ts;
          const displayValue = this.formatRelativeSeconds(rel);
          return `<span title="${this.escapeHtml(ts.toString())}">${this.escapeHtml(displayValue)}</span>`;
        }
        break;
      }

      case 'timestamp_absolute': {
        const ts = this.parseNs(value);
        if (ts !== null) {
          return this.escapeHtml(ts.toString());
        }
        break;
      }

      case 'compact':
        if (typeof value === 'number') {
          return this.formatCompactNumber(value);
        }
        break;

      case 'percentage':
        if (typeof value === 'number') {
          const pct = value > 1 ? value : value * 100;
          return `${pct.toFixed(1)}%`;
        }
        break;

      case 'duration_ms':
        if (typeof value === 'number') {
          const unit = colDef.unit || 'ns';
          const ns = value * (unit === 'ns' ? 1 : unit === 'us' ? 1e3 : unit === 'ms' ? 1e6 : 1e9);
          return `${(ns / 1e6).toFixed(2)} ms`;
        }
        break;

      case 'duration_us':
        if (typeof value === 'number') {
          // Keep legacy format key for compatibility, but display in ms.
          const unit = colDef.unit || 'us';
          const ns = value * (unit === 'ns' ? 1 : unit === 'us' ? 1e3 : unit === 'ms' ? 1e6 : 1e9);
          return `${(ns / 1e6).toFixed(2)} ms`;
        }
        break;

      case 'bytes_human':
        if (typeof value === 'number') {
          return this.formatBytes(value);
        }
        break;

      case 'code':
        return `<code>${this.escapeHtml(String(value))}</code>`;

      case 'truncate':
        if (typeof value === 'string' && value.length > 50) {
          return `<span title="${this.escapeHtml(value)}">${this.escapeHtml(value.substring(0, 47))}...</span>`;
        }
        break;
    }

    // Type-based defaults when no explicit format is provided.
    // This keeps HTML report output consistent with the frontend rendering.
    if (format === 'default') {
      if (colDef.type === 'timestamp') {
        const ts = this.parseNs(value);
        if (ts !== null) {
          const rel = traceStartNs ? ts - traceStartNs : ts;
          const displayValue = this.formatRelativeSeconds(rel);
          return `<span title="${this.escapeHtml(ts.toString())}">${this.escapeHtml(displayValue)}</span>`;
        }
      }

      if (colDef.type === 'duration') {
        const dur = this.parseNs(value);
        if (dur !== null) {
          const sign = dur < 0n ? '-' : '';
          const absNs = dur < 0n ? -dur : dur;
          const ms = Number(absNs) / 1e6;
          return `${sign}${ms.toFixed(2)} ms`;
        }
      }
    }

    // Default formatting based on type
    if (typeof value === 'number') {
      return value.toLocaleString('zh-CN');
    }
    if (typeof value === 'boolean') {
      return value ? '<span style="color: #10b981;">✓</span>' : '<span style="color: #ef4444;">✗</span>';
    }

    const str = typeof value === 'object'
      ? this.stringifyValueForDisplay(value, 200)
      : String(value);
    if (str.length > 200) {
      return `<span title="${this.escapeHtml(str)}">${this.escapeHtml(str.substring(0, 200))}...</span>`;
    }
    return this.escapeHtml(str);
  }

  /**
   * Format a number in compact notation
   */
  private formatCompactNumber(value: number): string {
    if (Math.abs(value) >= 1e9) {
      return (value / 1e9).toFixed(1) + 'B';
    }
    if (Math.abs(value) >= 1e6) {
      return (value / 1e6).toFixed(1) + 'M';
    }
    if (Math.abs(value) >= 1e3) {
      return (value / 1e3).toFixed(1) + 'K';
    }
    return value.toFixed(0);
  }

  /**
   * Format bytes in human-readable form
   */
  private formatBytes(bytes: number): string {
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let unitIndex = 0;
    let size = bytes;

    while (size >= 1024 && unitIndex < units.length - 1) {
      size /= 1024;
      unitIndex++;
    }

    return size.toFixed(unitIndex === 0 ? 0 : 1) + ' ' + units[unitIndex];
  }

  /**
   * Format answer with markdown-like syntax
   * Now delegates to markdownToHtml for full support including tables
   */
  private formatAnswer(answer: string): string {
    return this.markdownToHtml(answer);
  }

  /**
   * Format cell value for display
   */
  private formatCellValue(value: any, key?: string): string {
    if (value === null || value === undefined) {
      return '<span style="color: #999;">NULL</span>';
    }
    if (this.isIdentifierKey(key)) {
      return this.escapeHtml(this.normalizeIdentifierDisplay(value));
    }
    if (typeof value === 'number') {
      return value.toLocaleString('zh-CN');
    }
    if (typeof value === 'boolean') {
      return value ? '<span style="color: #10b981;">✓</span>' : '<span style="color: #ef4444;">✗</span>';
    }
    const str = typeof value === 'object'
      ? this.stringifyValueForDisplay(value, 200)
      : String(value);
    if (str.length > 200) {
      return `<span title="${this.escapeHtml(str)}">${this.escapeHtml(str.substring(0, 200))}...</span>`;
    }
    return this.escapeHtml(str);
  }

  private getCellClass(value: any): string {
    if (typeof value === 'number') {
      return 'col-number';
    }
    if (typeof value === 'string' && value.length > 20) {
      return 'col-text';
    }
    return '';
  }

  private getSeverityLabel(severity: string): string {
    const labels: Record<string, string> = {
      'critical': '🔴 严重问题',
      'warning': '🟡 警告',
      'info': '🔵 信息',
      'error': '❌ 错误',
    };
    return labels[severity] || severity;
  }

  /**
   * Convert result rows to object array
   */
  private rowsToObjects(columns: string[], rows: any[][]): Record<string, any>[] {
    return rows.map(row => {
      const obj: Record<string, any> = {};
      columns.forEach((col, idx) => {
        obj[col] = row[idx];
      });
      return obj;
    });
  }

  /**
   * Generate layered result section (overview/list/session/deep)
   * 生成分层结果区块
   */
  private generateLayeredResultSection(layeredResult: any): string {
    let html = '';

    const { layers, metadata } = layeredResult;

    // 添加元数据信息
    if (metadata) {
      html += `
        <div style="margin: 20px 0; padding: 15px; background: #f8f9fa; border-radius: 8px; font-size: 14px; color: #666;">
          <strong>Skill:</strong> ${this.escapeHtml(metadata.skillName || 'Unknown')}
          ${metadata.version ? `<span style="margin-left: 15px;"><strong>版本:</strong> ${metadata.version}</span>` : ''}
          ${metadata.executedAt ? `<span style="margin-left: 15px;"><strong>执行时间:</strong> ${new Date(metadata.executedAt).toLocaleString('zh-CN')}</span>` : ''}
        </div>
      `;
    }

    // overview - 概览层
    if (layers.overview && Object.keys(layers.overview).length > 0) {
      html += `<h3 style="margin: 30px 0 15px; font-size: 18px; color: #2c3e50;">📊 概览层 (Overview)</h3>`;
      html += this.generateLayerContent(layers.overview, 'overview');
    }

    // list - 列表层
    if (layers.list && Object.keys(layers.list).length > 0) {
      html += `<h3 style="margin: 30px 0 15px; font-size: 18px; color: #2c3e50;">📋 列表层 (List)</h3>`;
      html += this.generateLayerContent(layers.list, 'list');
    }

    // session - 会话详情层
    if (layers.session && Object.keys(layers.session).length > 0) {
      html += `<h3 style="margin: 30px 0 15px; font-size: 18px; color: #2c3e50;">🔍 会话详情层 (Session)</h3>`;
      html += this.generateLayerContent(layers.session, 'session');
    }

    // deep - 深度分析层
    if (layers.deep && Object.keys(layers.deep).length > 0) {
      html += `<h3 style="margin: 30px 0 15px; font-size: 18px; color: #2c3e50;">🎯 深度分析层 (Deep)</h3>`;
      html += this.generateLayerContent(layers.deep, 'deep');
    }

    return html;
  }

  /**
   * Generate content for a specific layer
   */
  private generateLayerContent(layerData: any, layerType: string): string {
    let html = '';

    // overview 和 list 是平铺结构：Record<string, StepResult>
    if (layerType === 'overview' || layerType === 'list') {
      for (const [stepId, stepResult] of Object.entries(layerData)) {
        const result = stepResult as any;
        html += this.renderStepResult(stepId, result);
      }
    }
    // session 是嵌套结构：Record<string, Record<string, StepResult>>
    else if (layerType === 'session') {
      for (const [sessionId, sessionSteps] of Object.entries(layerData)) {
        html += `
          <div style="margin-bottom: 20px;">
            <h4 style="font-size: 15px; font-weight: 600; margin-bottom: 10px; color: #34495e;">
              📁 ${this.escapeHtml(sessionId)}
            </h4>
        `;
        for (const [stepId, stepResult] of Object.entries(sessionSteps as Record<string, any>)) {
          const result = stepResult as any;
          html += this.renderStepResult(stepId, result);
        }
        html += `</div>`;
      }
    }
    // deep 是嵌套结构：Record<string, Record<string, StepResult>>
    else if (layerType === 'deep') {
      // 显示会话和帧信息
      let sessionIndex = 0;
      for (const [sessionId, frames] of Object.entries(layerData)) {
        sessionIndex++;
        const frameEntries = Object.entries(frames as Record<string, any>);
        const frameCount = frameEntries.length;
        const sessionNum = sessionId.replace('session_', '');

        html += `
          <div class="deep-session-container" style="margin-bottom: 24px; border: 1px solid #e2e8f0; border-radius: 8px; overflow: hidden;">
            <div class="deep-session-header" style="padding: 12px 16px; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; cursor: pointer; display: flex; justify-content: space-between; align-items: center;" onclick="toggleDeepSession('${sessionId}')">
              <div>
                <span class="session-toggle-icon" style="margin-right: 8px;">▼</span>
                <strong>滑动区间 ${sessionNum}</strong>
                <span style="margin-left: 12px; opacity: 0.9;">${frameCount} 个掉帧</span>
              </div>
              <button onclick="event.stopPropagation(); toggleAllFramesInDeepSession('${sessionId}')" style="padding: 4px 12px; background: rgba(255,255,255,0.2); color: white; border: 1px solid rgba(255,255,255,0.3); border-radius: 4px; cursor: pointer; font-size: 12px;">
                全部展开
              </button>
            </div>
            <div class="deep-session-content" id="${sessionId}_content" style="padding: 12px;">
        `;

        frameEntries.forEach(([frameId, stepResult], idx) => {
          const result = stepResult as any;
          const frameTitle = result.display?.title || frameId;
          const uniqueFrameId = `${sessionId}_${frameId}`;

          html += `
              <div class="deep-frame-item" style="margin-bottom: 8px; border: 1px solid #e2e8f0; border-radius: 6px; overflow: hidden;">
                <div class="deep-frame-header" style="padding: 10px 12px; background: #f8fafc; cursor: pointer; display: flex; justify-content: space-between; align-items: center;" onclick="toggleDeepFrame('${uniqueFrameId}')">
                  <div>
                    <span class="frame-toggle-icon" style="margin-right: 8px; color: #64748b;">▶</span>
                    <span style="font-weight: 500; color: #334155;">${this.escapeHtml(frameTitle)}</span>
                  </div>
                  <span style="font-size: 12px; color: #94a3b8;">点击展开详情</span>
                </div>
                <div class="deep-frame-content" id="${uniqueFrameId}_content" style="display: none; padding: 12px; background: white;">
                  ${this.renderDeepFrameAnalysis(result.data)}
                </div>
              </div>
          `;
        });

        html += `
            </div>
          </div>
        `;
      }
    }

    return html;
  }

  /**
   * Render a single step result from layered output
   */
  private renderStepResult(stepId: string, stepResult: any): string {
    if (!stepResult || !stepResult.data) {
      console.log(`[renderStepResult] ${stepId}: No data available`);
      return '';
    }

    console.log(`[renderStepResult] ${stepId}: data type=${typeof stepResult.data}, isArray=${Array.isArray(stepResult.data)}, length=${stepResult.data?.length || 'N/A'}`);

    // 先判断数据格式，确定是否有可渲染的内容
    let contentHtml = '';
    let hasRenderableContent = false;

    // 显示错误信息（如果有）
    if (stepResult.error) {
      console.log(`[renderStepResult] ${stepId}: Step failed with error:`, stepResult.error);
      contentHtml += `
        <div style="padding: 12px; background: #fef2f2; border-left: 4px solid #ef4444; border-radius: 4px; margin-bottom: 10px;">
          <div style="font-weight: 600; color: #dc2626; margin-bottom: 4px;">错误信息:</div>
          <div style="font-family: monospace; font-size: 13px; color: #991b1b; white-space: pre-wrap;">${this.escapeHtml(String(stepResult.error))}</div>
        </div>
      `;
      hasRenderableContent = true;
    }

    // 处理 displayResults 格式（来自 deep 层 iterator 结果）
    if (Array.isArray(stepResult.data) && stepResult.data.length > 0) {
      const firstItem = stepResult.data[0];

      console.log(`[renderStepResult] ${stepId}: First item:`, JSON.stringify({
        keys: Object.keys(firstItem || {}),
        hasStepId: !!firstItem?.stepId,
        hasTitle: !!firstItem?.title,
        sample: firstItem
      }, null, 2));

      // 如果是 displayResults 格式，渲染为子区块
      if (firstItem.stepId || firstItem.title) {
        console.log(`[renderStepResult] ${stepId}: Using displayResult format (has stepId or title)`);
        for (const displayResult of stepResult.data) {
          contentHtml += this.renderDisplayResult(displayResult);
        }
        hasRenderableContent = true;
      }
      // 如果是普通数据数组，渲染为表格
      else {
        const columns = Object.keys(firstItem);
        console.log(`[renderStepResult] ${stepId}: Using table format, columns:`, columns);
        contentHtml += this.generateTable(columns, stepResult.data);
        hasRenderableContent = true;
      }
    }
    // 处理空数组（失败的 SQL 查询或无结果）
    else if (Array.isArray(stepResult.data)) {
      console.log(`[renderStepResult] ${stepId}: Empty array, showing 'No data' message`);
      const message = stepResult.error ? '查询失败' : '无数据';
      contentHtml += `<div class="empty-state" style="padding: 20px; background: #f8f9fa; border-radius: 8px; color: #666;">${message}</div>`;
      hasRenderableContent = true;
    }
    // 处理文本格式
    else if (stepResult.data?.text) {
      console.log(`[renderStepResult] ${stepId}: Using text format`);
      contentHtml += `
        <div class="answer-box">
          ${this.formatAnswer(stepResult.data.text)}
        </div>
      `;
      hasRenderableContent = true;
    }
    // 处理 deep 层帧分析格式 (transformed data with diagnosis_summary and full_analysis)
    else if (stepResult.data?.diagnosis_summary !== undefined || stepResult.data?.full_analysis) {
      console.log(`[renderStepResult] ${stepId}: Using deep frame analysis format`);
      contentHtml += this.renderDeepFrameAnalysis(stepResult.data);
      hasRenderableContent = true;
    }
    else {
      console.log(`[renderStepResult] ${stepId}: Unknown format, skipping empty section. data:`, typeof stepResult.data, stepResult.data);
      // 不渲染空容器
    }

    // 只有在有可渲染内容时才创建容器
    if (!hasRenderableContent) {
      return '';
    }

    return `
      <div class="report-card">
        <div class="div-section" style="padding: 16px; border-bottom: 1px solid var(--border-color);">
          <div class="section-title" style="font-size: 15px;">
            ${this.escapeHtml(stepResult.display?.title || stepId)}
            ${Array.isArray(stepResult.data) ? `<span style="font-weight: normal; color: var(--text-secondary); font-size: 12px; margin-left: 8px;">(${stepResult.data.length} 条记录)</span>` : ''}
            ${stepResult.success === false ? `<span class="badge" style="background: var(--danger-bg); color: var(--danger-color); margin-left: 8px;">失败</span>` : ''}
          </div>
        </div>
        <div style="padding: 16px;">
          ${contentHtml}
        </div>
      </div>
    `;
  }

  /**
   * Render a single displayResult from layered output
   */
  private renderDisplayResult(displayResult: any): string {
    console.log(`[renderDisplayResult] displayResult:`, JSON.stringify({
      hasStepId: !!displayResult.stepId,
      hasTitle: !!displayResult.title,
      hasData: !!displayResult.data,
      dataType: typeof displayResult.data,
      dataIsArray: Array.isArray(displayResult.data),
      dataHasRows: !!displayResult.data?.rows,
      dataHasText: !!displayResult.data?.text,
      dataKeys: displayResult.data ? Object.keys(displayResult.data) : [],
    }, null, 2));

    // 先判断是否有可渲染的内容
    let contentHtml = '';

    if (displayResult.data) {
      // 如果有 rows，渲染为表格
      if (displayResult.data.rows && Array.isArray(displayResult.data.rows)) {
        const columns = displayResult.data.columns || [];
        const tableData = this.rowsToObjects(columns, displayResult.data.rows);
        contentHtml = this.generateTable(columns, tableData);
      }
      // 如果有 text，渲染为文本
      else if (displayResult.data.text) {
        contentHtml = `<div style="font-size: 13px; line-height: 1.6;">${this.formatAnswer(displayResult.data.text)}</div>`;
      }
      else {
        console.log(`[renderDisplayResult] No matching format for data, skipping:`, typeof displayResult.data, displayResult.data);
      }
    }
    else {
      console.log(`[renderDisplayResult] No data in displayResult, skipping`);
    }

    // 如果没有可渲染的内容，返回空字符串
    if (!contentHtml) {
      return '';
    }

    return `
      <div style="margin: 12px 0; background: #f8fafc; border-radius: 6px; border: 1px solid var(--border-color);">
        <div style="padding: 10px 16px; border-bottom: 1px solid var(--border-color); background: #f1f5f9; border-radius: 6px 6px 0 0;">
          <h5 style="margin: 0; font-size: 14px; font-weight: 600; color: #334155;">
            ${this.escapeHtml(displayResult.title || displayResult.stepId || '详情')}
          </h5>
        </div>
        <div style="padding: 12px;">
          ${contentHtml}
        </div>
      </div>
    `;
  }

  private renderDeepFrameAnalysis(data: { diagnosis_summary?: string; full_analysis?: any }): string {
    if (!data) return '';
    const diagnosis = data.diagnosis_summary || '暂无诊断';
    const analysis = data.full_analysis || {};
    const quadrants = analysis.quadrants || {};
    const binderCalls = analysis.binder_calls || [];
    const cpuFreq = analysis.cpu_frequency || {};
    const mainSlices = analysis.main_thread_slices || [];
    const renderSlices = analysis.render_thread_slices || [];
    const freqTimeline = analysis.cpu_freq_timeline || [];
    const lockContentions = analysis.lock_contentions || [];

    let html = '';

    html += `
      <div style="padding: 12px; background: #fef3c7; border-left: 4px solid #f59e0b; border-radius: 4px; margin-bottom: 12px;">
        <div style="font-weight: 600; color: #92400e; margin-bottom: 4px;">诊断结论</div>
        <div style="color: #78350f;">${this.escapeHtml(diagnosis)}</div>
      </div>
    `;

    if (quadrants.main_thread || quadrants.render_thread) {
      html += `<div style="margin-bottom: 16px;">`;

      if (quadrants.main_thread) {
        const mt = quadrants.main_thread;
        const runningPct = ((mt.q1 || 0) + (mt.q2 || 0)).toFixed(1);
        const waitingPct = ((mt.q3 || 0) + (mt.q4 || 0)).toFixed(1);
        html += `
          <div style="margin-bottom: 12px;">
            <div style="font-weight: 600; font-size: 14px; margin-bottom: 8px; color: #2c3e50;">
              主线程状态分布 
              <span style="font-weight: 400; font-size: 12px; color: #64748b;">(运行 ${runningPct}% | 等待 ${waitingPct}%)</span>
            </div>
            <div style="display: grid; grid-template-columns: repeat(2, 1fr); gap: 8px;">
              <div style="border: 1px solid #e2e8f0; border-radius: 8px; overflow: hidden;">
                <div style="padding: 6px 10px; background: #f1f5f9; font-size: 12px; font-weight: 600; color: #475569; text-align: center; border-bottom: 1px solid #e2e8f0;">Running (运行中)</div>
                <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 1px; background: #e2e8f0;">
                  <div style="padding: 12px 8px; background: #dcfce7; text-align: center;">
                    <div style="font-size: 20px; font-weight: 700; color: #166534;">${mt.q1?.toFixed(1) || 0}%</div>
                    <div style="font-size: 11px; color: #166534;">大核</div>
                  </div>
                  <div style="padding: 12px 8px; background: #dbeafe; text-align: center;">
                    <div style="font-size: 20px; font-weight: 700; color: #1e40af;">${mt.q2?.toFixed(1) || 0}%</div>
                    <div style="font-size: 11px; color: #1e40af;">小核</div>
                  </div>
                </div>
              </div>
              <div style="border: 1px solid #e2e8f0; border-radius: 8px; overflow: hidden;">
                <div style="padding: 6px 10px; background: #f1f5f9; font-size: 12px; font-weight: 600; color: #475569; text-align: center; border-bottom: 1px solid #e2e8f0;">Waiting (等待中)</div>
                <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 1px; background: #e2e8f0;">
                  <div style="padding: 12px 8px; background: #fef9c3; text-align: center;">
                    <div style="font-size: 20px; font-weight: 700; color: #854d0e;">${mt.q3?.toFixed(1) || 0}%</div>
                    <div style="font-size: 11px; color: #854d0e;">Runnable</div>
                  </div>
                  <div style="padding: 12px 8px; background: #f3e8ff; text-align: center;">
                    <div style="font-size: 20px; font-weight: 700; color: #6b21a8;">${mt.q4?.toFixed(1) || 0}%</div>
                    <div style="font-size: 11px; color: #6b21a8;">Sleeping</div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        `;
      }

      if (quadrants.render_thread) {
        const rt = quadrants.render_thread;
        const runningPct = ((rt.q1 || 0) + (rt.q2 || 0)).toFixed(1);
        const waitingPct = ((rt.q3 || 0) + (rt.q4 || 0)).toFixed(1);
        html += `
          <div style="margin-bottom: 12px;">
            <div style="font-weight: 600; font-size: 14px; margin-bottom: 8px; color: #2c3e50;">
              RenderThread 状态分布
              <span style="font-weight: 400; font-size: 12px; color: #64748b;">(运行 ${runningPct}% | 等待 ${waitingPct}%)</span>
            </div>
            <div style="display: grid; grid-template-columns: repeat(2, 1fr); gap: 8px;">
              <div style="border: 1px solid #e2e8f0; border-radius: 8px; overflow: hidden;">
                <div style="padding: 6px 10px; background: #f1f5f9; font-size: 12px; font-weight: 600; color: #475569; text-align: center; border-bottom: 1px solid #e2e8f0;">Running (运行中)</div>
                <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 1px; background: #e2e8f0;">
                  <div style="padding: 12px 8px; background: #dcfce7; text-align: center;">
                    <div style="font-size: 20px; font-weight: 700; color: #166534;">${rt.q1?.toFixed(1) || 0}%</div>
                    <div style="font-size: 11px; color: #166534;">大核</div>
                  </div>
                  <div style="padding: 12px 8px; background: #dbeafe; text-align: center;">
                    <div style="font-size: 20px; font-weight: 700; color: #1e40af;">${rt.q2?.toFixed(1) || 0}%</div>
                    <div style="font-size: 11px; color: #1e40af;">小核</div>
                  </div>
                </div>
              </div>
              <div style="border: 1px solid #e2e8f0; border-radius: 8px; overflow: hidden;">
                <div style="padding: 6px 10px; background: #f1f5f9; font-size: 12px; font-weight: 600; color: #475569; text-align: center; border-bottom: 1px solid #e2e8f0;">Waiting (等待中)</div>
                <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 1px; background: #e2e8f0;">
                  <div style="padding: 12px 8px; background: #fef9c3; text-align: center;">
                    <div style="font-size: 20px; font-weight: 700; color: #854d0e;">${rt.q3?.toFixed(1) || 0}%</div>
                    <div style="font-size: 11px; color: #854d0e;">Runnable</div>
                  </div>
                  <div style="padding: 12px 8px; background: #f3e8ff; text-align: center;">
                    <div style="font-size: 20px; font-weight: 700; color: #6b21a8;">${rt.q4?.toFixed(1) || 0}%</div>
                    <div style="font-size: 11px; color: #6b21a8;">Sleeping</div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        `;
      }

      html += `</div>`;
    }

    if (binderCalls.length > 0) {
      html += `
        <div style="margin-bottom: 12px;">
          <div style="font-weight: 600; font-size: 14px; margin-bottom: 8px; color: #2c3e50;">Binder 调用</div>
          <table style="width: 100%; border-collapse: collapse; font-size: 13px;">
            <thead style="background: #f1f5f9;">
              <tr>
                <th style="padding: 8px; text-align: left; border-bottom: 1px solid #e2e8f0;">目标进程</th>
                <th style="padding: 8px; text-align: right; border-bottom: 1px solid #e2e8f0;">调用次数</th>
                <th style="padding: 8px; text-align: right; border-bottom: 1px solid #e2e8f0;">总耗时</th>
                <th style="padding: 8px; text-align: right; border-bottom: 1px solid #e2e8f0;">最大耗时</th>
              </tr>
            </thead>
            <tbody>
              ${binderCalls.map((b: any) => `
                <tr>
                  <td style="padding: 8px; border-bottom: 1px solid #e2e8f0;">${this.escapeHtml(b.server_process || '')}</td>
                  <td style="padding: 8px; text-align: right; border-bottom: 1px solid #e2e8f0;">${b.call_count || 0}</td>
                  <td style="padding: 8px; text-align: right; border-bottom: 1px solid #e2e8f0;">${(b.total_ms || 0).toFixed(2)} ms</td>
                  <td style="padding: 8px; text-align: right; border-bottom: 1px solid #e2e8f0;">${(b.max_ms || 0).toFixed(2)} ms</td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
      `;
    }

    if (cpuFreq.big_avg_mhz || cpuFreq.little_avg_mhz) {
      html += `
        <div style="margin-bottom: 12px;">
          <div style="font-weight: 600; font-size: 14px; margin-bottom: 8px; color: #2c3e50;">CPU 频率</div>
          <div style="display: grid; grid-template-columns: repeat(2, 1fr); gap: 8px;">
            <div style="padding: 10px; background: #fee2e2; border-radius: 6px; text-align: center;">
              <div style="font-size: 18px; font-weight: 700; color: #991b1b;">${cpuFreq.big_avg_mhz || 0} MHz</div>
              <div style="font-size: 12px; color: #991b1b;">大核平均频率</div>
            </div>
            <div style="padding: 10px; background: #e0e7ff; border-radius: 6px; text-align: center;">
              <div style="font-size: 18px; font-weight: 700; color: #3730a3;">${cpuFreq.little_avg_mhz || 0} MHz</div>
              <div style="font-size: 12px; color: #3730a3;">小核平均频率</div>
            </div>
          </div>
        </div>
      `;
    }

    if (mainSlices.length > 0) {
      html += `
        <div style="margin-bottom: 12px;">
          <div style="font-weight: 600; font-size: 14px; margin-bottom: 8px; color: #2c3e50;">主线程耗时操作</div>
          <table style="width: 100%; border-collapse: collapse; font-size: 13px;">
            <thead style="background: #f1f5f9;">
              <tr>
                <th style="padding: 8px; text-align: left; border-bottom: 1px solid #e2e8f0;">操作名称</th>
                <th style="padding: 8px; text-align: right; border-bottom: 1px solid #e2e8f0;">总耗时</th>
                <th style="padding: 8px; text-align: right; border-bottom: 1px solid #e2e8f0;">次数</th>
              </tr>
            </thead>
            <tbody>
              ${mainSlices.slice(0, 5).map((s: any) => `
                <tr>
                  <td style="padding: 8px; border-bottom: 1px solid #e2e8f0;">${this.escapeHtml(s.name || '')}</td>
                  <td style="padding: 8px; text-align: right; border-bottom: 1px solid #e2e8f0;">${(s.total_ms || 0).toFixed(2)} ms</td>
                  <td style="padding: 8px; text-align: right; border-bottom: 1px solid #e2e8f0;">${s.count || 1}</td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
      `;
    }

    if (renderSlices.length > 0) {
      html += `
        <div style="margin-bottom: 12px;">
          <div style="font-weight: 600; font-size: 14px; margin-bottom: 8px; color: #2c3e50;">RenderThread 耗时操作</div>
          <table style="width: 100%; border-collapse: collapse; font-size: 13px;">
            <thead style="background: #f1f5f9;">
              <tr>
                <th style="padding: 8px; text-align: left; border-bottom: 1px solid #e2e8f0;">操作名称</th>
                <th style="padding: 8px; text-align: right; border-bottom: 1px solid #e2e8f0;">总耗时</th>
                <th style="padding: 8px; text-align: right; border-bottom: 1px solid #e2e8f0;">次数</th>
                <th style="padding: 8px; text-align: right; border-bottom: 1px solid #e2e8f0;">最大耗时</th>
              </tr>
            </thead>
            <tbody>
              ${renderSlices.slice(0, 5).map((s: any) => `
                <tr>
                  <td style="padding: 8px; border-bottom: 1px solid #e2e8f0;">${this.escapeHtml(s.name || '')}</td>
                  <td style="padding: 8px; text-align: right; border-bottom: 1px solid #e2e8f0;">${(s.total_ms || 0).toFixed(2)} ms</td>
                  <td style="padding: 8px; text-align: right; border-bottom: 1px solid #e2e8f0;">${s.count || 1}</td>
                  <td style="padding: 8px; text-align: right; border-bottom: 1px solid #e2e8f0;">${(s.max_ms || 0).toFixed(2)} ms</td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
      `;
    }

    if (freqTimeline.length > 0) {
      html += `
        <div style="margin-bottom: 12px;">
          <div style="font-weight: 600; font-size: 14px; margin-bottom: 8px; color: #2c3e50;">
            CPU 频率变化
            <span style="font-weight: 400; font-size: 12px; color: #64748b;">(${freqTimeline.length} 次变化)</span>
          </div>
          <div style="font-size: 12px; line-height: 1.6; background: #f8fafc; padding: 10px; border-radius: 6px; max-height: 150px; overflow-y: auto;">
            ${freqTimeline.slice(0, 20).map((f: any) => {
        const changeIcon = f.change_direction === 'up' ? '↑' : (f.change_direction === 'down' ? '↓' : '→');
        const changeColor = f.change_direction === 'up' ? '#16a34a' : (f.change_direction === 'down' ? '#dc2626' : '#64748b');
        const coreColor = f.core_type === 'big' ? '#991b1b' : '#3730a3';
        return `
                <div style="margin-bottom: 4px;">
                  <span style="color: #64748b;">+${(f.relative_ms || 0).toFixed(1)}ms</span>
                  <span style="margin-left: 8px; color: ${coreColor}; font-weight: 500;">C${f.cpu}</span>
                  <span style="color: ${changeColor}; margin-left: 4px;">${changeIcon}</span>
                  <span style="margin-left: 4px;">${f.prev_freq_mhz || f.freq_mhz}→${f.freq_mhz} MHz</span>
                </div>
              `;
      }).join('')}
            ${freqTimeline.length > 20 ? `<div style="color: #64748b; font-style: italic;">... 还有 ${freqTimeline.length - 20} 次变化</div>` : ''}
          </div>
        </div>
      `;
    }

    if (lockContentions.length > 0) {
      html += `
        <div style="margin-bottom: 12px;">
          <div style="font-weight: 600; font-size: 14px; margin-bottom: 8px; color: #2c3e50;">锁竞争</div>
          <table style="width: 100%; border-collapse: collapse; font-size: 13px;">
            <thead style="background: #f1f5f9;">
              <tr>
                <th style="padding: 8px; text-align: left; border-bottom: 1px solid #e2e8f0;">阻塞方法</th>
                <th style="padding: 8px; text-align: left; border-bottom: 1px solid #e2e8f0;">持锁线程</th>
                <th style="padding: 8px; text-align: right; border-bottom: 1px solid #e2e8f0;">等待时间</th>
                <th style="padding: 8px; text-align: center; border-bottom: 1px solid #e2e8f0;">主线程</th>
              </tr>
            </thead>
            <tbody>
              ${lockContentions.slice(0, 5).map((l: any) => `
                <tr>
                  <td style="padding: 8px; border-bottom: 1px solid #e2e8f0; font-family: monospace; font-size: 11px;">${this.escapeHtml(l.blocking_method || '')}</td>
                  <td style="padding: 8px; border-bottom: 1px solid #e2e8f0;">${this.escapeHtml(l.blocking_thread_name || '')}</td>
                  <td style="padding: 8px; text-align: right; border-bottom: 1px solid #e2e8f0;">${(l.wait_ms || 0).toFixed(2)} ms</td>
                  <td style="padding: 8px; text-align: center; border-bottom: 1px solid #e2e8f0;">${l.main_blocked ? '⚠️' : ''}</td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
      `;
    }

    return html;
  }

  /**
   * HTML 转义
   * 【P2 Fix】添加 null/undefined 类型检查，避免 TypeError
   */
  private escapeHtml(text: string | null | undefined): string {
    // 处理 null/undefined
    if (text === null || text === undefined) {
      return '';
    }

    // 确保是字符串类型
    const str = String(text);

    const map: Record<string, string> = {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#039;',
    };
    return str.replace(/[&<>"']/g, m => map[m]);
  }

  /**
   * Convert Markdown to HTML using markdown-it.
   * Handles nested lists, tables, blockquotes, fenced code blocks (incl. mermaid),
   * and all standard markdown features with proper XSS safety (html:false).
   */
  private markdownToHtml(text: string): string {
    if (!text) return '';
    return this.getReportMd().render(text).trim();
  }

  /**
   * Convert Markdown tables to HTML tables
   */
  private convertMarkdownTables(text: string): string {
    // Match Markdown table pattern
    // Header row | col1 | col2 | col3 |
    // Separator  |------|------|------|
    // Data rows  | val1 | val2 | val3 |
    const tableRegex = /(\|[^\n]+\|\n)(\|[-:\s|]+\|\n)((?:\|[^\n]+\|\n?)+)/g;

    return text.replace(tableRegex, (match, headerRow, separatorRow, bodyRows) => {
      // Parse header
      const headers = this.parseTableRow(headerRow);

      // Parse body rows
      const rows = bodyRows.trim().split('\n').map((row: string) => this.parseTableRow(row));

      // Generate HTML table
      return `
<table style="width: 100%; border-collapse: collapse; margin: 12px 0; font-size: 13px;">
  <thead>
    <tr style="background: #f8fafc;">
      ${headers.map((h: string) => `<th style="padding: 10px 12px; border: 1px solid #e2e8f0; text-align: left; font-weight: 600; color: #374151;">${this.escapeHtml(h)}</th>`).join('')}
    </tr>
  </thead>
  <tbody>
    ${rows.map((row: string[]) => `
    <tr>
      ${row.map((cell: string) => `<td style="padding: 8px 12px; border: 1px solid #e2e8f0;">${this.escapeHtml(cell)}</td>`).join('')}
    </tr>`).join('')}
  </tbody>
</table>
`;
    });
  }

  /**
   * Parse a single table row into cells
   */
  private parseTableRow(row: string): string[] {
    // Remove leading/trailing pipes and split by pipe
    return row.trim()
      .replace(/^\|/, '')
      .replace(/\|$/, '')
      .split('|')
      .map(cell => cell.trim());
  }

  generateAgentHTML(data: AgentReportData): string {
    const { traceId, query, result, timestamp } = data;
    const { intent, plan, expertResults, synthesizedAnswer, confidence, executionTimeMs, trace } = result;

    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>SmartPerfetto Agent 分析报告 - ${new Date(timestamp).toLocaleString('zh-CN')}</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
      line-height: 1.5; color: #333; background: #f5f7fa; padding: 15px;
    }
    .container {
      max-width: 1200px; margin: 0 auto; background: white;
      border-radius: 12px; box-shadow: 0 2px 12px rgba(0,0,0,0.1); overflow: hidden;
    }
    .header {
      background: linear-gradient(135deg, #10b981 0%, #059669 100%);
      color: white; padding: 20px;
    }
    .header h1 { font-size: 28px; margin-bottom: 10px; }
    .header .meta { opacity: 0.9; font-size: 14px; }
    .header .meta span { margin-right: 20px; }
    .badge {
      display: inline-block; padding: 4px 12px; border-radius: 12px;
      font-size: 12px; font-weight: 600;
    }
    .badge-agent { background: rgba(255,255,255,0.2); }
    .section { padding: 20px; border-bottom: 1px solid #eaeaea; }
    .section:last-child { border-bottom: none; }
    .section-title {
      font-size: 20px; font-weight: 600; margin-bottom: 20px; color: #2c3e50;
      display: flex; align-items: center;
    }
    .section-title::before {
      content: ''; width: 4px; height: 20px; background: #10b981;
      margin-right: 12px; border-radius: 2px;
    }
    .metrics { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 20px; }
    .metric-card { background: #f8f9fa; padding: 15px; border-radius: 8px; text-align: center; }
    .metric-card .value { font-size: 28px; font-weight: 700; color: #10b981; }
    .metric-card .label { font-size: 14px; color: #666; margin-top: 5px; }
    .intent-box {
      background: #f0fdf4; padding: 15px; border-radius: 8px; border-left: 4px solid #10b981;
    }
    .intent-box .goal { font-size: 18px; font-weight: 600; color: #166534; margin-bottom: 8px; }
    .intent-box .aspects { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 8px; }
    .aspect-tag {
      background: #dcfce7; color: #166534; padding: 4px 10px;
      border-radius: 4px; font-size: 13px;
    }
    .answer-box {
      background: #f0f9ff; padding: 20px; border-radius: 8px;
      border-left: 4px solid #3b82f6; line-height: 1.5; font-size: 14px;
    }
    .plan-task {
      padding: 12px 15px; margin-bottom: 10px; background: #fafafa;
      border-radius: 8px; border-left: 4px solid #6366f1;
    }
    .plan-task .task-header { display: flex; justify-content: space-between; align-items: center; }
    .plan-task .expert { font-weight: 600; color: #4f46e5; }
    .plan-task .objective { color: #666; margin-top: 5px; }
    .finding {
      padding: 12px 15px; margin-bottom: 10px; border-radius: 8px; border-left: 4px solid;
    }
    .finding.critical { background: #fef2f2; border-color: #ef4444; }
    .finding.warning { background: #fffbeb; border-color: #f59e0b; }
    .finding.info { background: #eff6ff; border-color: #3b82f6; }
    .finding .title { font-weight: 600; margin-bottom: 5px; }
    .finding.critical .title { color: #dc2626; }
    .finding.warning .title { color: #d97706; }
    .finding.info .title { color: #2563eb; }
    .diagnostic {
      padding: 10px 15px; margin-bottom: 8px; background: #f8f9fa;
      border-radius: 6px; display: flex; align-items: flex-start; gap: 10px;
    }
    .diagnostic .status { font-size: 16px; }
    .diagnostic .message { flex: 1; }
    .suggestions { margin-top: 8px; padding-left: 20px; }
    .suggestions li { margin-bottom: 4px; color: #666; }
    .expert-section {
      margin-bottom: 20px; border: 1px solid #e5e7eb;
      border-radius: 8px; overflow: hidden;
    }
    .expert-header {
      padding: 12px 16px; background: #f3f4f6;
      display: flex; justify-content: space-between; align-items: center;
    }
    .expert-header .name { font-weight: 600; color: #374151; }
    .expert-header .confidence {
      background: #dcfce7; color: #166534; padding: 2px 8px;
      border-radius: 4px; font-size: 12px;
    }
    .expert-body { padding: 16px; }
    .trace-section { background: #1e1e1e; color: #d4d4d4; padding: 15px; border-radius: 8px; }
    .trace-section pre { white-space: pre-wrap; font-size: 12px; }
    .collapsible { cursor: pointer; user-select: none; }
    .collapsible-content { display: none; }
    .collapsible-content.show { display: block; }
    .toggle-icon { margin-right: 8px; transition: transform 0.2s; }
    .footer {
      text-align: center; padding: 20px; color: #666;
      font-size: 14px; background: #f8f9fa;
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>🤖 SmartPerfetto Agent 分析报告</h1>
      <div class="meta">
        <span class="badge badge-agent">Agent Mode</span>
        <span>📅 ${new Date(timestamp).toLocaleString('zh-CN')}</span>
        <span>📁 Trace ID: ${traceId}</span>
        <span>⏱️ ${(executionTimeMs / 1000).toFixed(2)}s</span>
      </div>
    </div>

    <div class="section">
      <h2 class="section-title">分析概览</h2>
      <div class="metrics">
        <div class="metric-card">
          <div class="value">${(confidence * 100).toFixed(0)}%</div>
          <div class="label">置信度</div>
        </div>
        <div class="metric-card">
          <div class="value">${expertResults.length}</div>
          <div class="label">专家参与</div>
        </div>
        <div class="metric-card">
          <div class="value">${trace.totalLLMCalls}</div>
          <div class="label">LLM 调用</div>
        </div>
        <div class="metric-card">
          <div class="value">${(executionTimeMs / 1000).toFixed(1)}s</div>
          <div class="label">总耗时</div>
        </div>
      </div>
    </div>

    <div class="section">
      <h2 class="section-title">用户查询与意图</h2>
      <div class="intent-box">
        <div class="goal">🎯 ${this.escapeHtml(intent.primaryGoal)}</div>
        <div style="margin-top: 8px; color: #666;">
          <strong>原始查询：</strong>${this.escapeHtml(query)}
        </div>
        <div class="aspects">
          ${intent.aspects.map(a => `<span class="aspect-tag">${this.escapeHtml(a)}</span>`).join('')}
        </div>
        <div style="margin-top: 10px; font-size: 13px; color: #666;">
          <span>输出类型: <strong>${intent.expectedOutputType}</strong></span>
          <span style="margin-left: 15px;">复杂度: <strong>${intent.complexity}</strong></span>
        </div>
      </div>
    </div>

    <div class="section">
      <h2 class="section-title">分析计划</h2>
      ${plan.tasks.map((task, idx) => `
        <div class="plan-task">
          <div class="task-header">
            <span class="expert">📋 Task ${idx + 1}: ${this.escapeHtml(task.expertAgent)}</span>
            <span style="color: #666; font-size: 13px;">优先级: ${task.priority}</span>
          </div>
          <div class="objective">${this.escapeHtml(task.objective)}</div>
        </div>
      `).join('')}
      <div style="margin-top: 10px; font-size: 13px; color: #666;">
        预估时长: ${plan.estimatedDuration}ms | 可并行: ${plan.parallelizable ? '是' : '否'}
      </div>
    </div>

    <div class="section">
      <h2 class="section-title">分析结论</h2>
      <div class="answer-box">
        ${this.formatAnswer(synthesizedAnswer)}
      </div>
    </div>

    <div class="section">
      <h2 class="section-title">专家分析结果</h2>
      ${expertResults.map(expert => this.renderExpertResult(expert)).join('')}
    </div>

    <div class="section">
      <h2 class="section-title collapsible" onclick="toggleSection('trace-details')">
        <span class="toggle-icon">▶</span> 执行追踪 (调试信息)
      </h2>
      <div id="trace-details" class="collapsible-content">
        <div class="trace-section">
          <pre>${this.escapeHtml(JSON.stringify(trace, null, 2))}</pre>
        </div>
      </div>
    </div>

    <div class="footer">
      <p>由 SmartPerfetto Agent 架构生成</p>
      <p style="margin-top: 5px; font-size: 12px;">Powered by Expert Agents + LLM Orchestration</p>
    </div>
  </div>

  <script>
    function toggleSection(id) {
      const content = document.getElementById(id);
      const icon = content.previousElementSibling.querySelector('.toggle-icon');
      if (content.classList.contains('show')) {
        content.classList.remove('show');
        icon.textContent = '▶';
      } else {
        content.classList.add('show');
        icon.textContent = '▼';
      }
    }
  </script>
</body>
</html>`;
  }

  private renderExpertResult(expert: ExpertResult): string {
    return `
      <div class="expert-section">
        <div class="expert-header">
          <span class="name">🔬 ${this.escapeHtml(expert.agentName)}</span>
          <span class="confidence">${(expert.confidence * 100).toFixed(0)}% 置信度</span>
        </div>
        <div class="expert-body">
          ${expert.findings.length > 0 ? `
            <h4 style="margin-bottom: 10px; color: #374151;">发现 (${expert.findings.length})</h4>
            ${expert.findings.map((f: Finding) => this.renderFinding(f)).join('')}
          ` : ''}
          
          ${expert.diagnostics.length > 0 ? `
            <h4 style="margin: 15px 0 10px; color: #374151;">诊断 (${expert.diagnostics.length})</h4>
            ${expert.diagnostics.map((d: Diagnostic) => this.renderDiagnostic(d)).join('')}
          ` : ''}
          
          ${expert.suggestions.length > 0 ? `
            <h4 style="margin: 15px 0 10px; color: #374151;">建议</h4>
            <ul style="padding-left: 20px;">
              ${expert.suggestions.map((s: string) => `<li style="margin-bottom: 5px;">${this.escapeHtml(s)}</li>`).join('')}
            </ul>
          ` : ''}
          
          <div style="margin-top: 10px; font-size: 12px; color: #9ca3af;">
            耗时: ${expert.executionTimeMs}ms
          </div>
        </div>
      </div>
    `;
  }

  private renderFinding(finding: Finding): string {
    return `
      <div class="finding ${finding.severity}">
        <div class="title">${this.escapeHtml(finding.title)}</div>
        <div class="finding-description">${this.markdownToHtml(finding.description)}</div>
        ${(finding.evidence?.length || 0) > 0 ? `
          <div style="margin-top: 8px; font-size: 12px; color: #666;">
            证据: ${finding.evidence!.length} 项
          </div>
        ` : ''}
      </div>
    `;
  }

  private renderDiagnostic(diagnostic: Diagnostic): string {
    return `
      <div class="diagnostic">
        <span class="status">${diagnostic.matched ? '✅' : '❌'}</span>
        <div class="message">
          <div>${this.escapeHtml(diagnostic.message)}</div>
          ${diagnostic.suggestions.length > 0 ? `
            <ul class="suggestions">
              ${diagnostic.suggestions.map(s => `<li>${this.escapeHtml(s)}</li>`).join('')}
            </ul>
          ` : ''}
        </div>
      </div>
    `;
  }

  /**
   * Generate HTML report from MasterOrchestratorResult (new architecture)
   */
  generateMasterAgentHTML(data: MasterAgentReportData): string {
    const { traceId, query, result, timestamp } = data;
    const { intent, plan, stageResults, synthesizedAnswer, confidence, totalDuration, evaluation, modelUsage } = result;

    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>SmartPerfetto Agent 分析报告 - ${new Date(timestamp).toLocaleString('zh-CN')}</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
      line-height: 1.5; color: #333; background: #f5f7fa; padding: 15px;
    }
    .container {
      max-width: 1200px; margin: 0 auto; background: white;
      border-radius: 12px; box-shadow: 0 2px 12px rgba(0,0,0,0.1); overflow: hidden;
    }
    .header {
      background: linear-gradient(135deg, #10b981 0%, #059669 100%);
      color: white; padding: 20px;
    }
    .header h1 { font-size: 28px; margin-bottom: 10px; }
    .header .meta { opacity: 0.9; font-size: 14px; }
    .header .meta span { margin-right: 20px; }
    .badge {
      display: inline-block; padding: 4px 12px; border-radius: 12px;
      font-size: 12px; font-weight: 600;
    }
    .badge-agent { background: rgba(255,255,255,0.2); }
    .section { padding: 20px; border-bottom: 1px solid #eaeaea; }
    .section:last-child { border-bottom: none; }
    .section-title {
      font-size: 20px; font-weight: 600; margin-bottom: 20px; color: #2c3e50;
      display: flex; align-items: center;
    }
    .section-title::before {
      content: ''; width: 4px; height: 20px; background: #10b981;
      margin-right: 12px; border-radius: 2px;
    }
    .metrics { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 20px; }
    .metric-card { background: #f8f9fa; padding: 15px; border-radius: 8px; text-align: center; }
    .metric-card .value { font-size: 28px; font-weight: 700; color: #10b981; }
    .metric-card .label { font-size: 14px; color: #666; margin-top: 5px; }
    .intent-box {
      background: #f0fdf4; padding: 15px; border-radius: 8px; border-left: 4px solid #10b981;
    }
    .intent-box .goal { font-size: 18px; font-weight: 600; color: #166534; margin-bottom: 8px; }
    .answer-box {
      background: #f8f9fa; padding: 20px; border-radius: 8px;
      font-size: 14px; line-height: 1.5;
    }
    .stage-section { margin-bottom: 20px; }
    .stage-header {
      display: flex; justify-content: space-between; align-items: center;
      padding: 10px 15px; background: #f3f4f6; border-radius: 8px 8px 0 0;
      font-weight: 600;
    }
    .stage-body { padding: 15px; border: 1px solid #e5e7eb; border-top: none; border-radius: 0 0 8px 8px; }
    .finding { margin-bottom: 10px; padding: 10px; border-radius: 6px; border-left: 3px solid; }
    .finding.critical { background: #fef2f2; border-color: #dc2626; }
    .finding.high { background: #fff7ed; border-color: #ea580c; }
    .finding.medium { background: #fefce8; border-color: #ca8a04; }
    .finding.low { background: #f0fdf4; border-color: #16a34a; }
    .finding.info { background: #eff6ff; border-color: #2563eb; }
    .finding .title { font-weight: 600; margin-bottom: 5px; }
    .evaluation-box { display: grid; grid-template-columns: repeat(3, 1fr); gap: 15px; }
    .eval-item { background: #f8f9fa; padding: 15px; border-radius: 8px; text-align: center; }
    .eval-item .score { font-size: 32px; font-weight: 700; }
    .eval-item .label { font-size: 13px; color: #666; }
    .footer { padding: 20px; text-align: center; color: #999; font-size: 13px; background: #f8f9fa; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>🤖 SmartPerfetto Agent 分析报告</h1>
      <div class="meta">
        <span>📁 Trace ID: ${this.escapeHtml(traceId)}</span>
        <span>⏱️ ${new Date(timestamp).toLocaleString('zh-CN')}</span>
        <span class="badge badge-agent">Master Orchestrator</span>
      </div>
    </div>

    <div class="section">
      <h2 class="section-title">执行概览</h2>
      <div class="metrics">
        <div class="metric-card">
          <div class="value">${(totalDuration / 1000).toFixed(1)}s</div>
          <div class="label">总耗时</div>
        </div>
        <div class="metric-card">
          <div class="value">${(confidence * 100).toFixed(0)}%</div>
          <div class="label">置信度</div>
        </div>
        <div class="metric-card">
          <div class="value">${stageResults?.length || 0}</div>
          <div class="label">执行阶段</div>
        </div>
        <div class="metric-card">
          <div class="value">${evaluation?.passed ? '✅' : '❌'}</div>
          <div class="label">评估通过</div>
        </div>
      </div>
    </div>

    <div class="section">
      <h2 class="section-title">用户问题</h2>
      <div class="intent-box">
        <div class="goal">${this.escapeHtml(query)}</div>
        ${intent?.primaryGoal ? `<div style="margin-top: 8px; color: #166534;">${this.escapeHtml(intent.primaryGoal)}</div>` : ''}
      </div>
    </div>

    ${this.renderMethodologySection(intent, plan)}

    ${stageResults && stageResults.length > 0 ? this.renderReasoningTimeline(stageResults) : ''}

    <div class="section">
      <h2 class="section-title">分析结论</h2>
      <div class="answer-box">
        ${this.formatAnswer(synthesizedAnswer)}
      </div>
    </div>

    ${stageResults && stageResults.length > 0 ? `
    <div class="section">
      <h2 class="section-title">分析阶段详情</h2>
      ${stageResults.map((stage: any, idx: number) => this.renderStageResult(stage, idx)).join('')}
    </div>
    ` : ''}

    ${evaluation ? `
    <div class="section">
      <h2 class="section-title">质量评估</h2>
      <div class="evaluation-box">
        <div class="eval-item">
          <div class="score" style="color: ${evaluation.qualityScore >= 0.7 ? '#10b981' : '#ef4444'}">
            ${(evaluation.qualityScore * 100).toFixed(0)}%
          </div>
          <div class="label">质量分数</div>
        </div>
        <div class="eval-item">
          <div class="score" style="color: ${evaluation.completenessScore >= 0.8 ? '#10b981' : '#ef4444'}">
            ${(evaluation.completenessScore * 100).toFixed(0)}%
          </div>
          <div class="label">完整度</div>
        </div>
        <div class="eval-item">
          <div class="score">${evaluation.passed ? '✅' : '❌'}</div>
          <div class="label">评估结果</div>
        </div>
      </div>
      ${evaluation.feedback ? `
      <div style="margin-top: 15px; padding: 15px; background: #fef3c7; border-radius: 8px;">
        <strong>评估反馈:</strong>
        ${evaluation.feedback.improvementSuggestions?.length > 0 ? `
          <ul style="margin: 8px 0 0 16px;">
            ${evaluation.feedback.improvementSuggestions.map((s: string) => `<li>${this.escapeHtml(s)}</li>`).join('')}
          </ul>
        ` : ''}
      </div>
      ` : ''}
    </div>
    ` : ''}

    ${modelUsage ? `
    <div class="section">
      <h2 class="section-title">模型使用统计</h2>
      <div class="metrics">
        <div class="metric-card">
          <div class="value">${modelUsage.totalInputTokens.toLocaleString()}</div>
          <div class="label">输入 Tokens</div>
        </div>
        <div class="metric-card">
          <div class="value">${modelUsage.totalOutputTokens.toLocaleString()}</div>
          <div class="label">输出 Tokens</div>
        </div>
        <div class="metric-card">
          <div class="value">$${modelUsage.totalCost.toFixed(4)}</div>
          <div class="label">总成本</div>
        </div>
      </div>
    </div>
    ` : ''}

    <div class="footer">
      <p>由 SmartPerfetto Master Orchestrator 生成</p>
      <p style="margin-top: 5px; font-size: 12px;">Powered by Pipeline + Evaluator Architecture</p>
    </div>
  </div>
</body>
</html>`;
  }

  /**
   * Render methodology section for beginners to understand the analysis approach
   */
  private renderMethodologySection(intent: any, plan: any): string {
    if (!intent && !plan) {
      return '';
    }

    const aspects = intent?.aspects || [];
    const complexity = plan?.complexity || intent?.complexity || 'medium';
    const complexityLabel = complexity === 'simple' ? '简单' :
      complexity === 'medium' ? '中等' :
        complexity === 'complex' ? '复杂' : '复杂';
    const complexityColor = complexity === 'simple' ? '#10b981' :
      complexity === 'medium' ? '#f59e0b' : '#ef4444';

    return `
    <div class="section">
      <h2 class="section-title">📖 分析方法论</h2>
      <div style="display: grid; gap: 16px;">
        <div style="background: #f0fdf4; padding: 16px; border-radius: 8px; border-left: 4px solid #10b981;">
          <div style="font-weight: 600; color: #166534; margin-bottom: 8px;">🎯 分析目标</div>
          <div style="color: #166534;">${this.escapeHtml(intent?.primaryGoal || '性能分析')}</div>
          ${aspects.length > 0 ? `
            <ul style="margin-top: 8px; padding-left: 20px; color: #166534;">
              ${aspects.map((a: string) => `<li>${this.escapeHtml(a)}</li>`).join('')}
            </ul>
          ` : ''}
        </div>

        <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 16px;">
          <div style="background: #f8fafc; padding: 16px; border-radius: 8px; text-align: center;">
            <div style="font-size: 24px; font-weight: 700; color: ${complexityColor};">${complexityLabel}</div>
            <div style="font-size: 13px; color: #64748b; margin-top: 4px;">分析复杂度</div>
          </div>
          ${plan?.stages ? `
          <div style="background: #f8fafc; padding: 16px; border-radius: 8px; text-align: center;">
            <div style="font-size: 24px; font-weight: 700; color: #3b82f6;">${plan.stages.length}</div>
            <div style="font-size: 13px; color: #64748b; margin-top: 4px;">分析阶段</div>
          </div>
          ` : ''}
          ${intent?.suggestedSkills?.length > 0 ? `
          <div style="background: #f8fafc; padding: 16px; border-radius: 8px; text-align: center;">
            <div style="font-size: 24px; font-weight: 700; color: #8b5cf6;">${intent.suggestedSkills.length}</div>
            <div style="font-size: 13px; color: #64748b; margin-top: 4px;">分析技能</div>
          </div>
          ` : ''}
        </div>

        ${intent?.suggestedSkills?.length > 0 ? `
        <div style="background: #faf5ff; padding: 16px; border-radius: 8px;">
          <div style="font-weight: 600; color: #7c3aed; margin-bottom: 8px;">🛠️ 使用的分析技能</div>
          <div style="display: flex; flex-wrap: wrap; gap: 8px;">
            ${intent.suggestedSkills.map((skill: string) => `
              <span style="background: #ede9fe; color: #6d28d9; padding: 4px 12px; border-radius: 16px; font-size: 13px;">
                ${this.escapeHtml(skill)}
              </span>
            `).join('')}
          </div>
          <div style="margin-top: 12px; font-size: 12px; color: #8b5cf6; font-style: italic;">
            💡 这些技能是 AI 根据您的问题自动选择的，每个技能专门分析特定类型的性能数据
          </div>
        </div>
        ` : ''}
      </div>
    </div>
    `;
  }

  /**
   * Render AI reasoning timeline for beginners to understand the analysis flow
   */
  private renderReasoningTimeline(stageResults: StageResult[]): string {
    if (!stageResults || stageResults.length === 0) {
      return '';
    }

    // Calculate total duration
    const firstStart = Math.min(...stageResults.map(s => s.startTime));
    const lastEnd = Math.max(...stageResults.map(s => s.endTime));
    const totalDuration = lastEnd - firstStart;

    return `
    <div class="section">
      <h2 class="section-title">🧠 AI 推理过程</h2>
      <div style="padding: 8px 16px; background: #f0f9ff; border-radius: 8px; margin-bottom: 16px; font-size: 13px; color: #0369a1;">
        💡 <strong>学习要点:</strong> 以下时间线展示了 AI 是如何一步步分析您的问题的。每个阶段都有特定的目的，帮助您理解分析过程。
      </div>

      <div style="position: relative; padding-left: 32px;">
        <!-- Timeline line -->
        <div style="position: absolute; left: 12px; top: 0; bottom: 0; width: 2px; background: linear-gradient(180deg, #10b981 0%, #3b82f6 100%);"></div>

        ${stageResults.map((stage, idx) => {
      const duration = stage.endTime - stage.startTime;
      const findingsCount = stage.findings?.length || 0;
      const stageIcon = stage.stageId.includes('planner') ? '📋' :
        stage.stageId.includes('worker') ? '⚙️' :
          stage.stageId.includes('evaluator') ? '✅' :
            stage.stageId.includes('synthesis') ? '📝' : '🔍';
      const stageExplanation = stage.stageId.includes('planner') ? '制定分析计划' :
        stage.stageId.includes('worker') ? '执行数据分析' :
          stage.stageId.includes('evaluator') ? '评估结果质量' :
            stage.stageId.includes('synthesis') ? '综合生成报告' : '分析处理';

      return `
          <div style="position: relative; margin-bottom: 20px;">
            <!-- Timeline dot -->
            <div style="position: absolute; left: -26px; top: 4px; width: 16px; height: 16px; border-radius: 50%; background: ${stage.success ? '#10b981' : '#ef4444'}; border: 3px solid white; box-shadow: 0 1px 3px rgba(0,0,0,0.2);"></div>

            <div style="background: ${stage.success ? '#f0fdf4' : '#fef2f2'}; border-radius: 8px; padding: 16px; border-left: 3px solid ${stage.success ? '#10b981' : '#ef4444'};">
              <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px;">
                <div style="font-weight: 600; color: #1f2937;">
                  ${stageIcon} 步骤 ${idx + 1}: ${this.escapeHtml(stage.stageId)}
                </div>
                <div style="font-size: 12px; color: #6b7280;">
                  ${stage.success ? '✅' : '❌'} ${duration.toFixed(0)}ms
                </div>
              </div>

              <div style="font-size: 13px; color: #4b5563; margin-bottom: 8px;">
                ${stageExplanation}
              </div>

              ${findingsCount > 0 ? `
              <div style="font-size: 12px; color: #059669; background: #ecfdf5; padding: 8px 12px; border-radius: 4px; margin-top: 8px;">
                📊 发现 ${findingsCount} 条问题
              </div>
              ` : ''}

              ${stage.error ? `
              <div style="font-size: 12px; color: #dc2626; background: #fef2f2; padding: 8px 12px; border-radius: 4px; margin-top: 8px;">
                ⚠️ ${this.escapeHtml(stage.error)}
              </div>
              ` : ''}
            </div>
          </div>
          `;
    }).join('')}
      </div>

      <div style="margin-top: 16px; padding: 12px 16px; background: #f8fafc; border-radius: 8px; font-size: 12px; color: #64748b; text-align: center;">
        总耗时 ${(totalDuration / 1000).toFixed(1)} 秒 | 共 ${stageResults.length} 个分析阶段 | ${stageResults.filter(s => s.success).length}/${stageResults.length} 阶段成功
      </div>
    </div>
    `;
  }

  private renderStageResult(stage: StageResult, idx: number): string {
    const findings = stage.findings || [];
    const data = stage.data || {};

    // Extract layered data
    const overviewData = data.overview || {};
    const listData = data.list || {};
    const deepData = data.deep || {};
    const hasLayeredData = Object.keys(overviewData).length > 0 ||
      Object.keys(listData).length > 0 ||
      Object.keys(deepData).length > 0;

    return `
      <div class="stage-section">
        <div class="stage-header">
          <span>📋 阶段 ${idx + 1}: ${this.escapeHtml(stage.stageId)}</span>
          <span style="color: ${stage.success ? '#10b981' : '#ef4444'};">
            ${stage.success ? '✅ 成功' : '❌ 失败'}
          </span>
        </div>
        <div class="stage-body">
          ${hasLayeredData ? this.renderLayeredData(overviewData, listData, deepData, stage.stageId) : ''}

          ${findings.length > 0 ? `
            <div style="margin-top: 16px; margin-bottom: 10px; font-weight: 600; color: #374151;">
              🔍 发现 (${findings.length})
            </div>
            ${findings.map((f: Finding) => this.renderFinding(f)).join('')}
          ` : (!hasLayeredData ? '<div style="color: #666;">无发现</div>' : '')}

          <div style="margin-top: 10px; font-size: 12px; color: #999;">
            耗时: ${((stage.endTime - stage.startTime) || 0).toFixed(0)}ms
          </div>
        </div>
      </div>
    `;
  }

  /**
   * Render layered data (overview, list, deep)
   */
  private renderLayeredData(overview: any, list: any, deep: any, stageId: string): string {
    let html = '';

    // Overview Data - Render as metric cards
    if (Object.keys(overview).length > 0) {
      html += this.renderOverviewData(overview);
    }

    // List Data - Render as collapsible tables
    if (Object.keys(list).length > 0) {
      html += this.renderListData(list, stageId);
    }

    // Deep Analysis Data - Render as detailed sections
    if (Object.keys(deep).length > 0) {
      html += this.renderDeepAnalysisData(deep, stageId);
    }

    return html;
  }

  /**
   * Render overview data as metric cards or tables
   * Supports both:
   * 1. Simple key-value format: { key: value }
   * 2. StepResult format: { stepId: { stepId, data: [...], display } }
   */
  private renderOverviewData(overview: any): string {
    let html = '';
    const metrics: Array<{ label: string; value: string; color: string }> = [];

    for (const [key, value] of Object.entries(overview)) {
      if (value === null || value === undefined) continue;

      // Check if this is a StepResult format (from AnalysisWorker)
      if (typeof value === 'object' && !Array.isArray(value) && 'data' in value) {
        const stepResult = value as any;
        const displayTitle = stepResult.display?.title || this.formatMetricLabel(key);

        // 【兼容性修复】处理两种数据格式
        let items: any[] = [];
        const dataField = stepResult.data;
        if (Array.isArray(dataField)) {
          // Legacy 格式
          items = dataField;
        } else if (dataField && typeof dataField === 'object' && 'columns' in dataField && 'rows' in dataField) {
          // DataPayload 格式 - 将 rows 转换为对象数组
          const columns: string[] = dataField.columns || [];
          const rows: any[][] = dataField.rows || [];
          items = rows.map((row: any[]) => {
            const obj: Record<string, any> = {};
            columns.forEach((col, i) => { obj[col] = row[i]; });
            return obj;
          });
        }

        if (items.length > 0) {
          // Render StepResult as a table
          const tableId = `overview-table-${key}`.replace(/[^a-zA-Z0-9-]/g, '-');
          html += `
            <div style="margin-bottom: 16px; border: 1px solid #e5e7eb; border-radius: 8px; overflow: hidden;">
              <div style="background: #ecfdf5; padding: 10px 16px; font-weight: 600; color: #065f46;">
                📊 ${this.escapeHtml(displayTitle)}
              </div>
              <div id="${tableId}" style="max-height: 300px; overflow: auto;">
                ${this.renderDataTable(items.slice(0, 10), items.length > 10 ? items.slice(10) : [])}
              </div>
            </div>
          `;
        }
        continue;
      }

      // Simple value format
      const label = this.formatMetricLabel(key);
      let displayValue: string;
      let color = '#10b981';

      if (typeof value === 'number') {
        // Format numbers nicely
        if (key.toLowerCase().includes('rate') || key.toLowerCase().includes('percent')) {
          displayValue = `${(value * 100).toFixed(1)}%`;
          color = value > 0.1 ? '#ef4444' : value > 0.05 ? '#f59e0b' : '#10b981';
        } else if (key.toLowerCase().includes('duration') || key.toLowerCase().includes('time') || key.toLowerCase().includes('ms')) {
          displayValue = `${value.toFixed(2)}ms`;
        } else {
          displayValue = value.toLocaleString();
        }
      } else if (typeof value === 'boolean') {
        displayValue = value ? '✅' : '❌';
        color = value ? '#10b981' : '#ef4444';
      } else {
        displayValue = String(value);
      }

      metrics.push({ label, value: displayValue, color });
    }

    // Render simple metrics as cards
    if (metrics.length > 0) {
      html += `
      <div style="margin-bottom: 20px;">
        <div style="font-weight: 600; color: var(--text-main); margin-bottom: 12px; display: flex; align-items: center;">
          📊 概览指标
          <span style="margin-left: 8px; font-size: 11px; color: var(--text-light); font-weight: normal;">
            (${metrics.length} 项)
          </span>
        </div>
        <div class="metrics-grid">
          ${metrics.map(m => `
            <div class="metric-card">
              <div class="label">${m.label}</div>
              <div class="value" style="color: ${m.color};">${m.value}</div>
            </div>
          `).join('')}
        </div>
      </div>
      `;
    }

    return html;
  }

  /**
   * Render list data as collapsible tables
   * Supports both:
   * 1. Direct array format: { key: [...] }
   * 2. StepResult format: { stepId: { stepId, data: [...], display } }
   */
  private renderListData(list: any, stageId: string): string {
    // 先收集所有表格内容
    const tableContents: string[] = [];

    for (const [key, value] of Object.entries(list)) {
      if (value === null || value === undefined) continue;

      let items: any[] = [];
      let displayName = this.formatMetricLabel(key);
      let expandableData: any[] | undefined;

      // Check if this is a StepResult format (from AnalysisWorker)
      if (typeof value === 'object' && !Array.isArray(value) && 'data' in value) {
        const stepResult = value as any;
        displayName = stepResult.display?.title || displayName;

        // 【兼容性修复】处理两种数据格式：
        // 1. Legacy 格式: stepResult.data 是数组 [{col1: val1}, ...]
        // 2. DataPayload 格式: stepResult.data 是对象 { columns, rows, expandableData, summary }
        const dataField = stepResult.data;
        if (Array.isArray(dataField)) {
          // Legacy 格式
          items = dataField;
        } else if (dataField && typeof dataField === 'object' && 'columns' in dataField && 'rows' in dataField) {
          // DataPayload 格式 - 将 rows (数组的数组) 转换为对象数组
          const columns: string[] = dataField.columns || [];
          const rows: any[][] = dataField.rows || [];
          items = rows.map((row: any[]) => {
            const obj: Record<string, any> = {};
            columns.forEach((col, i) => { obj[col] = row[i]; });
            return obj;
          });
          // 保留 expandableData 用于可展开行
          expandableData = dataField.expandableData;
        }
      } else if (Array.isArray(value)) {
        items = value;
      } else {
        continue;
      }

      if (items.length === 0) continue;

      // 【兼容性修复】如果有 expandableData，使用可展开行渲染
      // 【BUG FIX】必须同时传递 columns 和 data，否则 generateExpandableSection 无法渲染主表格
      if (expandableData && expandableData.length > 0) {
        const stepResult = value as any;
        const dataField = stepResult.data;
        tableContents.push(this.generateExpandableSection(key, {
          title: displayName,
          expandableData,
          columns: dataField.columns,  // 传递列定义
          data: items,                  // 传递行数据（已转换为对象数组）
        }));
        continue;
      }

      const tableId = `table-${stageId}-${key}`.replace(/[^a-zA-Z0-9-]/g, '-');
      const previewCount = Math.min(5, items.length);

      tableContents.push(`
        <div style="margin-bottom: 16px; border: 1px solid #e5e7eb; border-radius: 8px; overflow: hidden;">
          <div style="background: #f3f4f6; padding: 10px 16px; font-weight: 600; display: flex; justify-content: space-between; align-items: center;">
            <span>${this.escapeHtml(displayName)} (${items.length} 条)</span>
            ${items.length > previewCount ? `
              <button onclick="document.getElementById('${tableId}').classList.toggle('expanded'); this.textContent = this.textContent.includes('展开') ? '收起' : '展开全部 (${items.length})';"
                      style="background: #10b981; color: white; border: none; padding: 4px 12px; border-radius: 4px; cursor: pointer; font-size: 12px;">
                展开全部 (${items.length})
              </button>
            ` : ''}
          </div>
          <div id="${tableId}" style="max-height: 300px; overflow: auto;">
            <style>#${tableId}.expanded { max-height: none !important; }</style>
            ${this.renderDataTable(items.slice(0, previewCount), items.length > previewCount ? items.slice(previewCount) : [])}
          </div>
        </div>
      `);
    }

    // 只有在有内容时才渲染容器
    if (tableContents.length === 0) {
      return '';
    }

    return `
      <div style="margin-bottom: 24px;">
        <div style="font-weight: 600; color: var(--text-main); margin-bottom: 12px; display: flex; align-items: center; font-size: 16px;">
          📋 数据列表
        </div>
        <div class="report-card" style="padding: 0;">
          ${tableContents.join('')}
        </div>
      </div>
    `;
  }

  /**
   * Render a data table with optional hidden rows
   */
  private renderDataTable(visibleItems: any[], hiddenItems: any[]): string {
    if (visibleItems.length === 0) return '<div style="padding: 16px; color: #9ca3af;">无数据</div>';

    // Get all columns from all items
    const allItems = [...visibleItems, ...hiddenItems];
    const columns = new Set<string>();
    allItems.forEach(item => {
      if (typeof item === 'object' && item !== null) {
        Object.keys(item).forEach(k => columns.add(k));
      }
    });
    const columnList = Array.from(columns).slice(0, 10); // Limit to 10 columns

    if (columnList.length === 0) {
      // Simple list rendering for non-object items
      return `
        <div class="table-container">
          <table>
            <tbody>
              ${allItems.map((item, idx) => `
                <tr style="${idx >= visibleItems.length ? 'display: none;' : ''}" class="${hiddenItems.length > 0 && idx >= visibleItems.length ? 'hidden-row' : ''}">
                  <td>${this.escapeHtml(String(item))}</td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
      `;
    }

    return `
      <div class="table-container">
        <table>
          <thead>
            <tr>
              ${columnList.map(col => `<th>${this.formatMetricLabel(col)}</th>`).join('')}
            </tr>
          </thead>
          <tbody>
            ${visibleItems.map((item, idx) => this.renderTableRow(item, columnList, idx, false)).join('')}
            ${hiddenItems.map((item, idx) => this.renderTableRow(item, columnList, visibleItems.length + idx, true)).join('')}
          </tbody>
        </table>
      </div>
    `;
  }

  /**
   * Render a single table row
   */
  private renderTableRow(item: any, columns: string[], idx: number, hidden: boolean): string {
    return `
      <tr style="${hidden ? 'display: none;' : ''}" class="${hidden ? 'hidden-row' : ''}">
        ${columns.map(col => {
      const value = item[col];
      const formatted = this.formatLayeredCellValue(value, col);
      return `<td title="${this.escapeHtml(String(value ?? ''))}">${formatted}</td>`;
    }).join('')}
      </tr>

    `;
  }

  /**
   * Format a cell value for display in layered data tables (with key-based formatting)
   */
  private formatLayeredCellValue(value: any, key: string): string {
    if (value === null || value === undefined) return '<span style="color: #9ca3af;">-</span>';
    if (this.isIdentifierKey(key)) {
      return this.escapeHtml(this.normalizeIdentifierDisplay(value));
    }

    if (typeof value === 'number') {
      const lowerKey = key.toLowerCase();
      if (lowerKey.includes('ns') || lowerKey.includes('_ns')) {
        return `${(value / 1_000_000).toFixed(2)}ms`;
      }
      if (lowerKey.includes('duration') || lowerKey.includes('time') || lowerKey.includes('ms')) {
        return `${value.toFixed(2)}ms`;
      }
      if (lowerKey.includes('rate') || lowerKey.includes('percent')) {
        // If value is already a percentage (e.g., 6.07), don't multiply
        if (value > 1) {
          return `${value.toFixed(2)}%`;
        }
        return `${(value * 100).toFixed(1)}%`;
      }
      return value.toLocaleString();
    }

    if (typeof value === 'boolean') {
      return value ? '<span style="color: #10b981;">✓</span>' : '<span style="color: #ef4444;">✗</span>';
    }

    if (Array.isArray(value)) {
      return `[${value.length} items]`;
    }

    if (typeof value === 'object') {
      return '{...}';
    }

    return this.escapeHtml(String(value).substring(0, 100));
  }

  /**
   * Render a nested object as a formatted HTML string
   * Used for displaying complex nested structures in a readable format
   */
  private renderNestedObject(obj: any): string {
    if (obj === null || obj === undefined) {
      return '<span style="color: #9ca3af;">-</span>';
    }

    if (typeof obj !== 'object') {
      return this.escapeHtml(String(obj));
    }

    if (Array.isArray(obj)) {
      if (obj.length === 0) {
        return '<span style="color: #9ca3af;">[]</span>';
      }
      // Render array items
      return `
        <div style="padding-left: 12px; border-left: 2px solid #e2e8f0;">
          ${obj.slice(0, 5).map((item, idx) => `
            <div style="margin-bottom: 4px;">
              <span style="color: #6b7280; font-size: 11px;">[${idx}]</span>
              ${typeof item === 'object' ? this.renderNestedObject(item) : this.escapeHtml(String(item))}
            </div>
          `).join('')}
          ${obj.length > 5 ? `<div style="color: #9ca3af; font-size: 12px;">... 还有 ${obj.length - 5} 项</div>` : ''}
        </div>
      `;
    }

    // Render object key-value pairs
    const entries = Object.entries(obj);
    if (entries.length === 0) {
      return '<span style="color: #9ca3af;">{}</span>';
    }

    return `
      <div style="padding-left: 12px; border-left: 2px solid #e2e8f0;">
        ${entries.slice(0, 10).map(([key, value]) => `
          <div style="margin-bottom: 4px;">
            <span style="color: #7c3aed; font-weight: 500; font-size: 12px;">${this.formatMetricLabel(key)}:</span>
            <span style="color: #4b5563; margin-left: 4px;">
              ${typeof value === 'object' ? this.renderNestedObject(value) : this.escapeHtml(String(value))}
            </span>
          </div>
        `).join('')}
        ${entries.length > 10 ? `<div style="color: #9ca3af; font-size: 12px;">... 还有 ${entries.length - 10} 项</div>` : ''}
      </div>
    `;
  }

  /**
   * Render deep analysis data
   */
  private renderDeepAnalysisData(deep: any, stageId: string): string {
    // 先收集所有内容
    const sectionContents: string[] = [];

    for (const [key, value] of Object.entries(deep)) {
      if (!value) continue;

      const displayName = this.formatMetricLabel(key);
      const sectionId = `deep-${stageId}-${key}`.replace(/[^a-zA-Z0-9-]/g, '-');

      if (Array.isArray(value) && value.length > 0) {
        // Render as expandable cards for frame details
        sectionContents.push(`
          <div style="margin-bottom: 16px;">
            <div style="font-weight: 500; color: #4b5563; margin-bottom: 8px;">${displayName} (${value.length} 条)</div>
            <div id="${sectionId}" style="display: grid; gap: 12px;">
              ${(value as any[]).slice(0, 3).map((item, idx) => this.renderDeepAnalysisCard(item, idx)).join('')}
              ${value.length > 3 ? `
                <div style="text-align: center;">
                  <button onclick="document.querySelectorAll('#${sectionId} .hidden-card').forEach(el => el.style.display = 'block'); this.style.display = 'none';"
                          style="background: #f3f4f6; color: #374151; border: 1px solid #d1d5db; padding: 8px 20px; border-radius: 6px; cursor: pointer; font-size: 13px;">
                    显示更多 (${value.length - 3} 条)
                  </button>
                </div>
                ${(value as any[]).slice(3).map((item, idx) => this.renderDeepAnalysisCard(item, idx + 3, true)).join('')}
              ` : ''}
            </div>
          </div>
        `);
      } else if (typeof value === 'object') {
        // Check if this is a nested session -> frame structure (deep analysis)
        // Data structure from normalizeDeepData: { sessionId: { frameId: { stepId, item, data: { diagnosis_summary, full_analysis }, display } } }
        const valueEntries = Object.entries(value);
        const isNestedFrameStructure = valueEntries.length > 0 &&
          valueEntries.every(([k, v]) =>
            typeof v === 'object' && v !== null &&
            (k.startsWith('frame_') || k.includes('frame') || /^\d+$/.test(k) ||
              // Check at both levels: v.diagnosis_summary (old format) or v.data.diagnosis_summary (new format)
              (v as any).diagnosis_summary !== undefined ||
              (v as any).full_analysis !== undefined ||
              ((v as any).data?.diagnosis_summary !== undefined) ||
              ((v as any).data?.full_analysis !== undefined))
          );

        if (isNestedFrameStructure) {
          // Render as expandable frame sections (like generateLayerContent does for 'deep' type)
          const sessionId = `deep-${stageId}-${key}`.replace(/[^a-zA-Z0-9-]/g, '-');
          let frameHtml = `
            <div style="margin-bottom: 16px; border: 1px solid #e2e8f0; border-radius: 8px; overflow: hidden;">
              <div style="padding: 12px 16px; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; cursor: pointer; display: flex; justify-content: space-between; align-items: center;" onclick="this.nextElementSibling.style.display = this.nextElementSibling.style.display === 'none' ? 'block' : 'none'; this.querySelector('.toggle-icon').textContent = this.nextElementSibling.style.display === 'none' ? '▶' : '▼';">
                <div>
                  <span class="toggle-icon" style="margin-right: 8px;">▼</span>
                  <strong>${displayName}</strong>
                  <span style="margin-left: 12px; opacity: 0.9;">${valueEntries.length} 个帧</span>
                </div>
              </div>
              <div style="padding: 12px;">
          `;

          valueEntries.forEach(([frameId, frameData], idx) => {
            const fData = frameData as any;
            const frameTitle = fData.display?.title || frameId;
            const uniqueFrameId = `${sessionId}_${frameId}`.replace(/[^a-zA-Z0-9-_]/g, '-');

            frameHtml += `
              <div style="margin-bottom: 8px; border: 1px solid #e2e8f0; border-radius: 6px; overflow: hidden;">
                <div style="padding: 10px 12px; background: #f8fafc; cursor: pointer; display: flex; justify-content: space-between; align-items: center;" onclick="const content = this.nextElementSibling; content.style.display = content.style.display === 'none' ? 'block' : 'none'; this.querySelector('.frame-toggle-icon').textContent = content.style.display === 'none' ? '▶' : '▼'; this.querySelector('.frame-hint').textContent = content.style.display === 'none' ? '点击展开详情' : '点击收起';">
                  <div>
                    <span class="frame-toggle-icon" style="margin-right: 8px; color: #64748b;">▶</span>
                    <span style="font-weight: 500; color: #334155;">${this.escapeHtml(String(frameTitle))}</span>
                  </div>
                  <span class="frame-hint" style="font-size: 12px; color: #94a3b8;">点击展开详情</span>
                </div>
                <div style="display: none; padding: 12px; background: white;">
                  ${this.renderDeepFrameAnalysis(fData.data || fData)}
                </div>
              </div>
            `;
          });

          frameHtml += `
              </div>
            </div>
          `;
          sectionContents.push(frameHtml);
        } else {
          // Render as simple key-value pairs
          sectionContents.push(`
            <div style="margin-bottom: 16px; background: #faf5ff; border-radius: 8px; padding: 16px; border-left: 3px solid #8b5cf6;">
              <div style="font-weight: 500; color: #6d28d9; margin-bottom: 8px;">${displayName}</div>
              <div style="font-size: 13px;">
                ${Object.entries(value).map(([k, v]) => `
                  <div style="display: flex; gap: 8px; margin-bottom: 4px;">
                    <span style="color: #7c3aed; font-weight: 500;">${this.formatMetricLabel(k)}:</span>
                    <span style="color: #4b5563;">${typeof v === 'object' ? this.renderNestedObject(v) : this.formatLayeredCellValue(v, k)}</span>
                  </div>
                `).join('')}
              </div>
            </div>
          `);
        }
      }
    }

    // 只有在有内容时才渲染容器
    if (sectionContents.length === 0) {
      return '';
    }

    return `
      <div style="margin-bottom: 20px;">
        <div style="font-weight: 600; color: #374151; margin-bottom: 12px; display: flex; align-items: center;">
          🔬 深度分析
        </div>
        ${sectionContents.join('')}
      </div>
    `;
  }

  /**
   * Render a deep analysis card (for frame details, etc.)
   */
  private renderDeepAnalysisCard(item: any, idx: number, hidden: boolean = false): string {
    if (typeof item !== 'object' || item === null) {
      return `<div style="${hidden ? 'display: none;' : ''}" class="${hidden ? 'hidden-card' : ''}">${this.escapeHtml(String(item))}</div>`;
    }

    // Extract key fields for the card header
    const title = item.title || item.name || item.id || item.frame_id || `项目 ${idx + 1}`;
    const severity = item.severity || item.jank_type || item.type;
    const severityColor = severity === 'critical' ? '#ef4444' :
      severity === 'high' || severity === 'severe' ? '#f97316' :
        severity === 'medium' ? '#f59e0b' :
          severity === 'low' ? '#10b981' : '#6b7280';

    return `
      <div style="${hidden ? 'display: none;' : ''}" class="deep-analysis-card ${hidden ? 'hidden-card' : ''}">
        <div class="deep-analysis-header">
          <span style="font-weight: 600; color: var(--text-main); font-size: 14px;">${this.escapeHtml(String(title))}</span>
          ${severity ? `<span style="background: ${severityColor}20; color: ${severityColor}; padding: 2px 10px; border-radius: 9999px; font-size: 12px; font-weight: 600;">${this.escapeHtml(String(severity))}</span>` : ''}
        </div>
        <div class="properties-grid">
            ${Object.entries(item).filter(([k]) => !['title', 'name', 'id', 'severity', 'jank_type', 'type'].includes(k)).map(([k, v]) => {
      if (typeof v === 'object' && v !== null) {
        // Handle nested objects
        return `
                  <div style="grid-column: 1 / -1; margin-top: 8px;">
                    <details>
                      <summary>${this.formatMetricLabel(k)}</summary>
                      <div class="details-content">
                        ${Array.isArray(v) ? v.map(i => `<div style="margin-bottom: 6px; padding-bottom: 6px; border-bottom: 1px solid #f3f4f6;">${this.escapeHtml(String(i))}</div>`).join('') :
            Object.entries(v).map(([nk, nv]) => `
                            <div class="property-item">
                              <span class="property-label">${this.formatMetricLabel(nk)}</span>
                              <span class="property-value">${typeof nv === 'object' ? JSON.stringify(nv) : this.escapeHtml(String(nv))}</span>
                            </div>
                          `).join('')
          }
                      </div>
                    </details>
                  </div>
                `;
      }
      return `
                <div class="property-item">
                  <span class="property-label">${this.formatMetricLabel(k)}</span>
                  <span class="property-value">${this.formatLayeredCellValue(v, k)}</span>
                </div>
              `;
    }).join('')}
        </div>
      </div>
    `;
  }

  /**
   * Format a metric key as a human-readable label
   */
  private formatMetricLabel(key: string): string {
    // Convert snake_case or camelCase to readable label
    return key
      .replace(/_/g, ' ')
      .replace(/([a-z])([A-Z])/g, '$1 $2')
      .replace(/^./, str => str.toUpperCase())
      .replace(/\b(id|ms|fps|ui|gpu|cpu|sql)\b/gi, match => match.toUpperCase())
      .trim();
  }

  /**
   * Generate HTML report from agent runtime result (Phase 2-4 architecture)
   */
  generateAgentDrivenHTML(data: AgentDrivenReportData): string {
    const { traceId, query, result, hypotheses, dialogue, conversationTimeline, timestamp, queryHistory, conclusionHistory } = data;
    const dataEnvelopes = this.prepareAgentDrivenEnvelopes(data.dataEnvelopes || []);
    const agentResponses = data.agentResponses || [];
    const traceStartNs = data.traceStartNs ? this.parseNs(data.traceStartNs) : null;
    const normalizedConversationTimeline = this.normalizeConversationTimeline(
      conversationTimeline || [],
      dialogue || []
    );

    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>SmartPerfetto Agent-Driven 分析报告 - ${new Date(timestamp).toLocaleString('zh-CN')}</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
      line-height: 1.5; color: #333; background: #f5f7fa; padding: 15px;
    }
    .container {
      max-width: 1200px; margin: 0 auto; background: white;
      border-radius: 12px; box-shadow: 0 2px 12px rgba(0,0,0,0.1); overflow: hidden;
    }
	    .header {
	      background: linear-gradient(135deg, #8b5cf6 0%, #6d28d9 100%);
	      color: white; padding: 20px;
	    }
	    .header h1 { font-size: 28px; margin-bottom: 10px; }
	    .header .meta { opacity: 0.9; font-size: 14px; }
	    .header .meta span { margin-right: 20px; }
	    .report-actions {
	      display: flex; flex-wrap: wrap; gap: 8px; margin-top: 16px;
	    }
	    .report-action-btn {
	      border: 1px solid rgba(255,255,255,0.45); background: rgba(255,255,255,0.18);
	      color: white; border-radius: 8px; padding: 8px 12px; cursor: pointer;
	      font-size: 13px; font-weight: 600;
	    }
	    .report-action-btn:hover { background: rgba(255,255,255,0.28); }
	    .report-save-status {
	      align-self: center; min-height: 18px; font-size: 12px; opacity: 0.9;
	    }
	    .badge {
	      display: inline-block; padding: 4px 12px; border-radius: 12px;
	      font-size: 12px; font-weight: 600;
	    }
    .badge-agent { background: rgba(255,255,255,0.2); }
    .section { padding: 20px; border-bottom: 1px solid #eaeaea; }
    .section:last-child { border-bottom: none; }
    .section-title {
      font-size: 20px; font-weight: 600; margin-bottom: 20px; color: #2c3e50;
      display: flex; align-items: center;
    }
    .section-title::before {
      content: ''; width: 4px; height: 20px; background: #8b5cf6;
      margin-right: 12px; border-radius: 2px;
    }
    .metrics { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 20px; }
    .metric-card { background: #f8f9fa; padding: 15px; border-radius: 8px; text-align: center; }
    .metric-card .value { font-size: 28px; font-weight: 700; color: #8b5cf6; }
    .metric-card .label { font-size: 14px; color: #666; margin-top: 5px; }
    .hypothesis-card {
      background: #faf5ff; padding: 15px; border-radius: 8px; margin-bottom: 12px;
      border-left: 4px solid #8b5cf6;
    }
    .hypothesis-card.confirmed { border-color: #10b981; background: #f0fdf4; }
    .hypothesis-card.rejected { border-color: #ef4444; background: #fef2f2; }
    .hypothesis-title { font-weight: 600; color: #6d28d9; margin-bottom: 8px; }
    .hypothesis-meta { display: flex; gap: 15px; font-size: 13px; color: #666; }
    .confidence-bar {
      height: 8px; background: #e5e7eb; border-radius: 4px; margin-top: 8px; overflow: hidden;
    }
    .confidence-fill { height: 100%; background: #8b5cf6; border-radius: 4px; }
    .dialogue-item {
      display: flex; gap: 12px; padding: 12px; margin-bottom: 8px;
      background: #f8f9fa; border-radius: 8px;
    }
    .dialogue-item.task { background: #eff6ff; border-left: 3px solid #3b82f6; }
    .dialogue-item.response { background: #f0fdf4; border-left: 3px solid #10b981; }
    .dialogue-agent { font-weight: 600; color: #6d28d9; min-width: 120px; }
    .dialogue-content { flex: 1; font-size: 13px; }
    .dialogue-findings { margin-top: 8px; padding: 8px; background: rgba(0,0,0,0.03); border-radius: 4px; }
    .dialogue-findings .finding-tag {
      display: inline-block; padding: 2px 8px; margin: 2px; border-radius: 4px;
      font-size: 11px; font-weight: 500;
    }
    .finding { margin-bottom: 12px; padding: 15px; border-radius: 8px; border-left: 4px solid; }
    .finding.critical { background: #fef2f2; border-color: #dc2626; }
    .finding.warning { background: #fff7ed; border-color: #ea580c; }
    .finding.info { background: #eff6ff; border-color: #2563eb; }
    .finding.high { background: #fef2f2; border-color: #dc2626; }
    .finding.medium { background: #fff7ed; border-color: #ea580c; }
    .finding.low { background: #f0fdf4; border-color: #10b981; }
    .finding .title { font-weight: 600; margin-bottom: 5px; }
    .finding .description { font-size: 13px; color: #555; margin-bottom: 8px; line-height: 1.6; }
    .finding .evidence-list { margin-top: 8px; }
    .finding .evidence-item { font-size: 12px; color: #555; padding: 4px 0; padding-left: 16px; position: relative; }
    .finding .evidence-item::before { content: '•'; position: absolute; left: 4px; color: #8b5cf6; }
    .finding .recommendations { margin-top: 10px; padding: 10px; background: rgba(139,92,246,0.05); border-radius: 6px; }
    .finding .recommendations .rec-item {
      font-size: 12px; color: #4c1d95; padding: 3px 0; padding-left: 20px; position: relative;
    }
    .finding .recommendations .rec-item::before { content: '💡'; position: absolute; left: 0; font-size: 11px; }
    .finding .details-grid { margin-top: 8px; display: grid; grid-template-columns: auto 1fr; gap: 4px 12px; font-size: 12px; }
    .finding .details-grid .detail-key { color: #666; font-weight: 500; }
    .finding .details-grid .detail-value { color: #333; font-family: monospace; font-size: 11px; }
    .envelope-card {
      margin-bottom: 16px; border: 1px solid #e5e7eb; border-radius: 8px; overflow: hidden;
    }
    .envelope-header {
      display: flex; justify-content: space-between; align-items: center;
      padding: 12px 16px; background: #f9fafb; border-bottom: 1px solid #e5e7eb;
    }
    .envelope-title { font-weight: 600; font-size: 14px; color: #374151; }
    .envelope-meta { font-size: 11px; color: #9ca3af; }
    .envelope-body { padding: 0; }
    .evidence-section { margin-top: 10px; padding: 10px; background: #f8f9fa; border-radius: 6px; }
    .evidence-item { font-size: 12px; color: #666; margin-bottom: 4px; }
    .evidence-support { color: #10b981; }
    .evidence-contradict { color: #ef4444; }
    .answer-box {
      background: #f8f9fa; padding: 20px; border-radius: 8px;
      font-size: 14px; line-height: 1.5;
    }
    .timeline-list {
      display: flex; flex-direction: column; gap: 10px;
      max-height: 420px; overflow-y: auto; padding-right: 4px;
    }
    .timeline-toolbar {
      display: flex; align-items: center; justify-content: space-between;
      gap: 12px; margin-bottom: 10px;
    }
    .timeline-filters {
      display: flex; flex-wrap: wrap; gap: 6px;
    }
    .timeline-filter-btn, .timeline-collapse-btn {
      border: 1px solid #d1d5db; background: white; color: #374151;
      border-radius: 999px; padding: 4px 10px; font-size: 12px; cursor: pointer;
    }
    .timeline-filter-btn.active {
      background: #eef2ff; color: #4338ca; border-color: #c7d2fe; font-weight: 600;
    }
    .timeline-item {
      display: grid; grid-template-columns: 64px 180px 1fr;
      gap: 12px; align-items: center; padding: 10px 12px;
      border-radius: 8px; border: 1px solid #e5e7eb; background: #f8fafc;
    }
    .timeline-item.timeline-hidden { display: none; }
    .timeline-step {
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
      font-size: 12px; color: #475569;
    }
    .timeline-meta {
      display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
    }
    .timeline-phase {
      display: inline-block; padding: 2px 8px; border-radius: 999px;
      font-size: 11px; font-weight: 600; color: #334155; background: #e2e8f0;
    }
    .timeline-role {
      font-size: 12px; color: #475569;
    }
    .timeline-item.phase-progress .timeline-phase { background: #dbeafe; color: #1d4ed8; }
    .timeline-item.phase-thinking .timeline-phase { background: #ede9fe; color: #6d28d9; }
    .timeline-item.phase-tool .timeline-phase { background: #cffafe; color: #0e7490; }
    .timeline-item.phase-result .timeline-phase { background: #dcfce7; color: #166534; }
    .timeline-item.phase-error .timeline-phase { background: #fee2e2; color: #b91c1c; }
    .timeline-text {
      font-size: 13px; color: #1f2937; line-height: 1.5;
    }
    .table-container { overflow-x: auto; }
    .table-container table {
      width: 100%; border-collapse: collapse; font-size: 12px;
    }
    .table-container th {
      padding: 8px 10px; background: #f1f5f9; border-bottom: 2px solid #e2e8f0;
      text-align: left; font-weight: 600; color: #475569; white-space: nowrap;
    }
    .table-container td {
      padding: 6px 10px; border-bottom: 1px solid #f1f5f9; color: #334155;
    }
    .table-container tr:hover td { background: #f8fafc; }
    .table-metadata { padding: 8px 10px; font-size: 12px; color: #666; }
    .table-rows-more {
      padding: 8px; text-align: center; cursor: pointer;
      color: #8b5cf6; font-size: 12px; font-weight: 500;
      border-top: 1px solid #f1f5f9;
    }
    .table-rows-more:hover { background: #faf5ff; }
    .cell-duration { font-family: monospace; color: #7c3aed; }
    .cell-timestamp { font-family: monospace; color: #2563eb; }
    .cell-number { font-family: monospace; text-align: right; }
    .cell-percentage { font-family: monospace; color: #059669; }
    .cell-bytes { font-family: monospace; color: #d97706; }
    .cell-warning { color: #ea580c; font-weight: 500; }
    .cell-critical { color: #dc2626; font-weight: 600; }
    .empty-state { padding: 20px; text-align: center; color: #9ca3af; font-size: 13px; }
    .footer { padding: 20px; text-align: center; color: #999; font-size: 13px; background: #f8f9fa; }
    /* Markdown rendered content (markdown-it output) — compact typography */
    pre.mermaid { background: #f8f9fa; padding: 16px; border-radius: 8px; text-align: center; margin: 10px 0; }
    .answer-box p, .finding-description p { margin: 2px 0; line-height: 1.5; }
    .answer-box ul, .answer-box ol,
    .finding-description ul, .finding-description ol { margin: 2px 0; padding-left: 20px; }
    .answer-box li, .finding-description li { margin: 1px 0; line-height: 1.5; }
    .answer-box li > ul, .answer-box li > ol,
    .finding-description li > ul, .finding-description li > ol { margin: 0; }
    .answer-box blockquote, .finding-description blockquote {
      margin: 6px 0; padding: 8px 14px; background: #eef6ff;
      border-left: 4px solid #3b82f6; color: #1e40af; border-radius: 0 4px 4px 0;
    }
    .answer-box blockquote p, .finding-description blockquote p { margin: 1px 0; }
    .answer-box code, .finding-description code {
      background: rgba(0,0,0,0.06); padding: 1px 5px; border-radius: 3px; font-size: 13px;
    }
    .answer-box pre, .finding-description pre {
      background: #1e1e2e; color: #cdd6f4; padding: 12px; border-radius: 8px;
      overflow-x: auto; font-size: 13px; line-height: 1.4; margin: 6px 0;
    }
    .answer-box pre code, .finding-description pre code {
      background: none; padding: 0; color: inherit; font-size: inherit;
    }
    .answer-box hr, .finding-description hr {
      border: none; border-top: 1px solid #e5e7eb; margin: 8px 0;
    }
    .answer-box h2, .finding-description h2 { margin: 12px 0 4px; font-size: 15px; color: #111827; }
    .answer-box h3, .finding-description h3 { margin: 10px 0 3px; font-size: 14px; color: #1f2937; }
    .answer-box h4, .finding-description h4 { margin: 8px 0 2px; font-size: 13.5px; color: #374151; }
    .answer-box h5, .finding-description h5 { margin: 6px 0 2px; font-size: 13px; color: #374151; font-weight: 600; }
    .answer-box table, .finding-description table {
      width: 100%; border-collapse: collapse; margin: 6px 0; font-size: 13px;
    }
    .answer-box th, .finding-description th {
      padding: 6px 10px; border: 1px solid #e2e8f0; text-align: left;
      font-weight: 600; color: #374151; background: #f8fafc;
    }
    .answer-box td, .finding-description td {
      padding: 5px 10px; border: 1px solid #e2e8f0;
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>🤖 SmartPerfetto Agent-Driven 分析报告</h1>
	      <div class="meta">
	        <span>📁 Trace ID: ${this.escapeHtml(traceId)}</span>
	        <span>⏱️ ${new Date(timestamp).toLocaleString('zh-CN')}</span>
	        <span class="badge badge-agent">Agent-Driven Architecture</span>
	      </div>
	      <div class="report-actions">
	        <button class="report-action-btn" type="button" onclick="saveSmartPerfettoReport()">💾 保存网页文件</button>
	        <span class="report-save-status" id="report-save-status"></span>
	      </div>
	    </div>

    <div class="section">
      <h2 class="section-title">执行概览</h2>
      <div class="metrics">
        <div class="metric-card">
          <div class="value">${(result.totalDurationMs / 1000).toFixed(1)}s</div>
          <div class="label">总耗时</div>
        </div>
        <div class="metric-card">
          <div class="value">${(result.confidence * 100).toFixed(0)}%</div>
          <div class="label">置信度</div>
        </div>
        <div class="metric-card">
          <div class="value">${data.conversationTurns ?? result.rounds}</div>
          <div class="label">对话轮次</div>
        </div>
        <div class="metric-card">
          <div class="value">${result.findings.length}</div>
          <div class="label">发现问题</div>
        </div>
        <div class="metric-card">
          <div class="value">${hypotheses.length}</div>
          <div class="label">假设数</div>
        </div>
        <div class="metric-card">
          <div class="value">${dataEnvelopes.length}</div>
          <div class="label">数据表</div>
        </div>
      </div>
    </div>

    <div class="section">
      <h2 class="section-title">用户问题</h2>
      ${(queryHistory && queryHistory.length > 1)
        ? queryHistory.map(qh => `
      <div class="hypothesis-card" style="margin-bottom: 8px;">
        <div style="font-size: 12px; color: #6b7280; margin-bottom: 4px;">第 ${qh.turn} 轮</div>
        <div class="hypothesis-title" style="color: #166534;">${this.escapeHtml(qh.query)}</div>
      </div>`).join('')
        : `
      <div class="hypothesis-card">
        <div class="hypothesis-title" style="color: #166534;">${this.escapeHtml(query)}</div>
      </div>`}
    </div>

    ${this.renderHypothesesSection(hypotheses)}

    ${this.renderAnalysisPlanSection(data.analysisPlan)}

    ${this.renderAnalysisNotesSection(data.analysisNotes)}

    ${this.renderUncertaintyFlagsSection(data.uncertaintyFlags)}

    ${this.renderConversationTimelineSection(normalizedConversationTimeline)}

    ${this.renderDataEnvelopesSection(dataEnvelopes, traceStartNs)}

    ${this.renderFindingsSection(result.findings, dataEnvelopes)}

    <div class="section">
      <h2 class="section-title">分析结论</h2>
      ${(conclusionHistory && conclusionHistory.length > 1)
        ? conclusionHistory.map(ch => `
      <div style="margin-bottom: 16px;">
        <div style="font-size: 13px; font-weight: 600; color: #374151; margin-bottom: 6px; padding: 4px 8px; background: #f3f4f6; border-radius: 4px; display: inline-block;">第 ${ch.turn} 轮 · 置信度 ${(ch.confidence * 100).toFixed(0)}%</div>
        <div class="answer-box">
          ${this.formatAnswer(ch.conclusion)}
        </div>
      </div>`).join('')
        : `
      <div class="answer-box">
        ${this.formatAnswer(result.conclusion)}
      </div>`}
    </div>

    <div class="footer">
      <p>由 SmartPerfetto Agent-Driven Orchestrator 生成</p>
      <p style="margin-top: 5px; font-size: 12px;">Powered by Claude Agent SDK + MCP Tools</p>
    </div>
	  </div>
	  <script>
	    async function saveSmartPerfettoReport() {
	      var statusEl = document.getElementById('report-save-status');
	      function setStatus(text) {
	        if (statusEl) statusEl.textContent = text || '';
	      }
	      var url = new URL(window.location.href);
	      var reportId = decodeURIComponent(url.pathname.split('/').filter(Boolean).pop() || 'smartperfetto-report');
	      var suggestedName = 'smartperfetto-' + reportId + '.html';
	      var exportUrl = url.pathname.replace(/\\/$/, '') + '/export';

	      try {
	        setStatus('正在准备保存...');
	        var response = await fetch(exportUrl, {cache: 'no-store'});
	        if (!response.ok) {
	          throw new Error('导出失败: HTTP ' + response.status);
	        }
	        var blob = await response.blob();
	        if (window.showSaveFilePicker) {
	          var handle = await window.showSaveFilePicker({
	            suggestedName: suggestedName,
	            types: [{
	              description: 'HTML 网页报告',
	              accept: {'text/html': ['.html', '.htm']},
	            }],
	          });
	          var writable = await handle.createWritable();
	          await writable.write(blob);
	          await writable.close();
	        } else {
	          var objectUrl = URL.createObjectURL(blob);
	          var a = document.createElement('a');
	          a.href = objectUrl;
	          a.download = suggestedName;
	          document.body.appendChild(a);
	          a.click();
	          document.body.removeChild(a);
	          URL.revokeObjectURL(objectUrl);
	        }
	        setStatus('已保存 ' + suggestedName);
	        setTimeout(function() { setStatus(''); }, 3500);
	      } catch (err) {
	        if (err && err.name === 'AbortError') {
	          setStatus('已取消保存');
	          setTimeout(function() { setStatus(''); }, 2000);
	          return;
	        }
	        console.error('[SmartPerfetto] 保存报告失败:', err);
	        setStatus((err && err.message) ? err.message : '保存失败');
	      }
	    }

	    function toggleTableRows(btn, hiddenCount) {
      var tableContainer = btn.parentElement;
      var table = tableContainer.querySelector('table');
      var hiddenRows = table.querySelectorAll('.hidden-row');
      if (hiddenRows.length > 0) {
        var isHidden = hiddenRows[0].style.display === 'none';
        hiddenRows.forEach(function(row) {
          row.style.display = isHidden ? '' : 'none';
        });
        var span = btn.querySelector('span');
        if (isHidden) {
          span.innerHTML = '▲ 收起更多';
        } else {
          span.innerHTML = '▼ 显示更多 ' + hiddenCount + ' 条记录';
        }
      }
    }

    // Toggle expandable row details (for iterator results with L4 deep data)
    function toggleExpandableRow(arg) {
      // Support both toggleExpandableRow(rowId: string) and toggleExpandableRow(buttonEl: HTMLElement)
      var detailsRow = null;
      var btn = null;

      if (typeof arg === 'string') {
        var rowId = arg;
        detailsRow = document.getElementById(rowId + '_details');
        var expandableRow = document.querySelector('.expandable-row[data-row-id=\"' + rowId + '\"]');
        btn = expandableRow ? expandableRow.querySelector('.expand-btn') : null;
      } else if (arg && arg.closest) {
        btn = arg;
        var tr = btn.closest('tr');
        detailsRow = tr ? tr.nextElementSibling : null;
      }

      if (detailsRow) {
        var isHidden = detailsRow.style.display === 'none';
        detailsRow.style.display = isHidden ? 'table-row' : 'none';

        if (btn) {
          btn.innerHTML = isHidden
            ? '<span class="expand-icon">▲</span> 收起'
            : '<span class="expand-icon">▼</span> 展开';
        }
      }
    }

    // Expand/collapse all rows in a section
    function toggleAllExpandableRows(sectionId, expand) {
      var section = document.getElementById(sectionId);
      if (!section) return;

      var detailRows = section.querySelectorAll('.detail-row');
      var buttons = section.querySelectorAll('.expand-btn');

      detailRows.forEach(function(row) {
        row.style.display = expand ? 'table-row' : 'none';
      });

      buttons.forEach(function(btn) {
        btn.innerHTML = expand
          ? '<span class="expand-icon">▲</span> 收起'
          : '<span class="expand-icon">▼</span> 展开';
      });
    }

    function filterConversationTimeline(sectionId, phase, triggerBtn) {
      var section = document.getElementById(sectionId);
      if (!section) return;

      var items = section.querySelectorAll('.timeline-item');
      var filterButtons = section.querySelectorAll('.timeline-filter-btn');

      filterButtons.forEach(function(btn) {
        btn.classList.remove('active');
      });
      if (triggerBtn && triggerBtn.classList) {
        triggerBtn.classList.add('active');
      }

      items.forEach(function(item) {
        var itemPhase = item.getAttribute('data-phase') || 'progress';
        var matchesPhase = phase === 'all' || itemPhase === phase;
        var isCollapsed = item.classList.contains('timeline-collapsed') && !item.classList.contains('timeline-expanded');
        if (matchesPhase && !isCollapsed) {
          item.classList.remove('timeline-hidden');
        } else {
          item.classList.add('timeline-hidden');
        }
      });
    }

    function toggleConversationTimelineCollapse(sectionId, btn) {
      var section = document.getElementById(sectionId);
      if (!section) return;

      var collapsedItems = section.querySelectorAll('.timeline-item.timeline-collapsed');
      if (collapsedItems.length === 0) return;

      var expanding = btn.getAttribute('data-expanded') !== 'true';
      collapsedItems.forEach(function(item) {
        if (expanding) {
          item.classList.add('timeline-expanded');
        } else {
          item.classList.remove('timeline-expanded');
        }
      });

      btn.setAttribute('data-expanded', expanding ? 'true' : 'false');
      btn.textContent = expanding ? '收起' : '展开全部';

      var activeFilterBtn = section.querySelector('.timeline-filter-btn.active');
      var phase = activeFilterBtn ? (activeFilterBtn.getAttribute('data-phase') || 'all') : 'all';
      filterConversationTimeline(sectionId, phase, activeFilterBtn);
    }
  </script>
  <script src="https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.min.js"></script>
  <script>
    if (typeof mermaid !== 'undefined') {
      // Sanitize HTML tags in mermaid code before rendering.
      // LLMs often generate <br/> for line breaks in node labels,
      // which breaks securityLevel:'strict'. Replace with newlines.
      document.querySelectorAll('pre.mermaid').forEach(function(el) {
        el.textContent = (el.textContent || '').replace(/<br\s*\/?>/gi, '\n');
      });
      mermaid.initialize({ startOnLoad: false, theme: 'default', securityLevel: 'strict' });
      mermaid.run({ querySelector: 'pre.mermaid' });
    }
  </script>
</body>
</html>`;
  }

  private prepareAgentDrivenEnvelopes(envelopes: DataEnvelope[]): DataEnvelope[] {
    if (!Array.isArray(envelopes) || envelopes.length === 0) return [];

    const hasScrollingJankFrames = envelopes.some((env) => {
      const stepId = String(env?.meta?.stepId || '');
      return stepId === 'get_app_jank_frames' || stepId === 'app_jank_frames' || stepId === 'batch_frame_root_cause';
    });

    const filtered = envelopes.filter((env) => {
      if (!env || env.data === undefined || env.data === null) return false;

      const skillId = String(env.meta?.skillId || '');
      const stepId = String(env.meta?.stepId || '');

      // Prefer scrolling_analysis as primary jank source in report.
      // Consumer-side views are still available in raw SSE stream if needed.
      if (
        hasScrollingJankFrames &&
        skillId === 'consumer_jank_detection' &&
        (stepId === 'consumer_jank_frames' || stepId === 'consumer_jank_summary' || stepId === 'jank_severity_distribution')
      ) {
        return false;
      }

      return true;
    });

    const seen = new Set<string>();
    const deduped: DataEnvelope[] = [];
    for (const env of filtered) {
      const key = this.buildAgentEnvelopeDedupeKey(env);
      if (seen.has(key)) continue;
      seen.add(key);
      deduped.push(env);
    }
    return deduped;
  }

  private buildAgentEnvelopeDedupeKey(env: DataEnvelope): string {
    const skillId = String(env.meta?.skillId || 'unknown');
    const stepId = String(env.meta?.stepId || 'unknown');
    const source = String(env.meta?.source || '').split('#')[0];
    const data = env.data as any;

    if (data && typeof data === 'object' && Array.isArray(data.rows)) {
      const rows = data.rows as any[];
      const sample = rows.length > 6
        ? [...rows.slice(0, 3), ...rows.slice(-3)]
        : rows;
      return `${skillId}:${stepId}:${rows.length}:${JSON.stringify(sample)}`;
    }

    const compactData = (() => {
      try {
        return JSON.stringify(data);
      } catch {
        return String(data);
      }
    })();

    return `${skillId}:${stepId}:${source}:${compactData.slice(0, 512)}`;
  }

  /**
   * Render the DataEnvelopes section with all collected SQL result tables
   */
  private renderDataEnvelopesSection(envelopes: DataEnvelope[], traceStartNs: bigint | null): string {
    if (!envelopes || envelopes.length === 0) return '';

    return `
    <div class="section">
      <h2 class="section-title">📊 数据详情</h2>
      ${envelopes.map((envelope, index) => this.renderSingleEnvelope(envelope, index, traceStartNs)).join('')}
    </div>
    `;
  }

  /**
   * Render a single DataEnvelope as a card with table
   */
  private renderSingleEnvelope(envelope: DataEnvelope, index: number, traceStartNs: bigint | null): string {
    if (!envelope || !envelope.data) return '';

    const title = envelope.display?.title || `数据表 ${index + 1}`;
    const source = envelope.meta?.source || '';
    const skillId = envelope.meta?.skillId || '';
    const stepId = envelope.meta?.stepId || '';

    const metaParts: string[] = [];
    if (skillId) metaParts.push(this.escapeHtml(skillId));
    if (stepId) metaParts.push(this.escapeHtml(stepId));
    if (source && source !== skillId) metaParts.push(this.escapeHtml(source));

    const tableHtml = this.generateTableFromEnvelope(envelope, traceStartNs);

    return `
      <div class="envelope-card">
        <div class="envelope-header">
          <div class="envelope-title">${this.escapeHtml(title)}</div>
          <div class="envelope-meta">${metaParts.join(' / ')}</div>
        </div>
        <div class="envelope-body">
          ${tableHtml}
        </div>
      </div>
    `;
  }

  /**
   * Render a finding with evidence, details, and recommendations
   */
  private renderEnhancedFinding(finding: Finding): string {
    const severityClass = finding.severity || 'info';

    // 【优化】格式化 details 字段，避免显示原始 JSON
    let detailsHtml = '';
    if (finding.details && Object.keys(finding.details).length > 0) {
      // 过滤掉大对象（如 summary、sample），只显示简单的标量值
      const simpleEntries = Object.entries(finding.details)
        .filter(([key, value]) => {
          // 跳过大对象和数组
          if (typeof value === 'object' && value !== null) return false;
          // 跳过已经在 title 中显示的字段
          if (key === 'jankCount' || key === 'jankRate') return false;
          return true;
        })
        .slice(0, 6);

      if (simpleEntries.length > 0) {
        detailsHtml = `
          <div class="details-grid" style="display: flex; gap: 16px; flex-wrap: wrap; margin-top: 8px;">
            ${simpleEntries.map(([key, value]) => `
              <span style="color: #666; font-size: 12px;">
                <span style="color: #888;">${this.formatMetricLabel(key)}:</span>
                <strong style="color: #333;">${this.formatDetailValue(value, key)}</strong>
              </span>
            `).join('')}
          </div>
        `;
      }
    }

    let evidenceHtml = '';
    if (finding.evidence && finding.evidence.length > 0) {
      evidenceHtml = `
        <div class="evidence-list" style="margin-top: 8px; padding-left: 12px; border-left: 2px solid #e5e7eb;">
          ${finding.evidence.slice(0, 5).map((e: any) => `
            <div style="font-size: 12px; color: #555; margin: 4px 0;">• ${this.escapeHtml(typeof e === 'string' ? e : (e.description || e.message || ''))}</div>
          `).join('')}
        </div>
      `;
    }

    // 精简版 Finding 卡片 - 紧凑布局
    return `
      <div class="finding ${severityClass}" style="padding: 12px 16px; margin-bottom: 8px; border-radius: 6px; border-left: 3px solid ${this.getSeverityColor(severityClass)}; background: ${this.getSeverityBg(severityClass)};">
        <div style="font-weight: 600; color: #1f2937; margin-bottom: 4px;">${this.escapeHtml(finding.title)}</div>
        ${finding.description ? `<div style="font-size: 13px; color: #4b5563;">${this.escapeHtml(finding.description)}</div>` : ''}
        ${detailsHtml}
        ${evidenceHtml}
      </div>
    `;
  }

  /**
   * 格式化 detail 值为更友好的显示
   */
  private formatDetailValue(value: any, key?: string): string {
    if (value === null || value === undefined) return '-';
    if (this.isIdentifierKey(key)) {
      return this.escapeHtml(this.normalizeIdentifierDisplay(value));
    }
    if (typeof value === 'number') {
      // 百分比
      if (value > 0 && value < 1) return `${(value * 100).toFixed(1)}%`;
      // 大数字加千分位
      if (Number.isInteger(value)) return value.toLocaleString();
      return value.toFixed(2);
    }
    return this.escapeHtml(String(value));
  }

  /**
   * 获取 severity 对应的边框颜色
   */
  private getSeverityColor(severity: string): string {
    switch (severity) {
      case 'critical': return '#dc2626';
      case 'warning': return '#f59e0b';
      case 'info': return '#3b82f6';
      default: return '#6b7280';
    }
  }

  /**
   * 获取 severity 对应的背景色
   */
  private getSeverityBg(severity: string): string {
    switch (severity) {
      case 'critical': return '#fef2f2';
      case 'warning': return '#fffbeb';
      case 'info': return '#eff6ff';
      default: return '#f9fafb';
    }
  }

  /**
   * P1-R3: Render analysis plan section from agentv3 submit_plan data
   */
  private renderAnalysisPlanSection(plan?: AgentDrivenReportData['analysisPlan']): string {
    if (!plan || !plan.phases || plan.phases.length === 0) return '';
    return `
    <div class="section" style="background: #fafafa; border-radius: 8px; padding: 16px; margin-bottom: 20px;">
      <h2 class="section-title" style="font-size: 16px; margin-bottom: 12px; display: flex; align-items: center; gap: 8px;">
        <span style="color: #2563eb;">📋</span> 分析计划
      </h2>
      <div style="display: flex; flex-direction: column; gap: 6px;">
        ${plan.phases.map(p => {
          const icon = p.status === 'completed' ? '✓' : p.status === 'skipped' ? '⊘' : p.status === 'in_progress' ? '◐' : '○';
          const color = p.status === 'completed' ? '#059669' : p.status === 'skipped' ? '#9ca3af' : p.status === 'in_progress' ? '#f59e0b' : '#2563eb';
          return `<div style="display: flex; align-items: baseline; gap: 8px; padding: 6px 12px; background: white; border-radius: 6px; border: 1px solid #e5e7eb;">
            <span style="color: ${color}; font-weight: 600;">${icon}</span>
            <span style="font-weight: 500;">${this.escapeHtml(p.name)}</span>
            ${p.summary ? `<span style="color: #6b7280; font-size: 13px;"> — ${this.escapeHtml(p.summary)}</span>` : ''}
          </div>`;
        }).join('')}
      </div>
      <div style="margin-top: 8px; font-size: 13px; color: #6b7280;">成功标准: ${this.escapeHtml(plan.successCriteria)}</div>
    </div>`;
  }

  /**
   * P1-R3: Render analysis notes from agentv3 write_analysis_note data
   */
  private renderAnalysisNotesSection(notes?: AgentDrivenReportData['analysisNotes']): string {
    if (!notes || notes.length === 0) return '';
    return `
    <div class="section" style="background: #fafafa; border-radius: 8px; padding: 16px; margin-bottom: 20px;">
      <h2 class="section-title" style="font-size: 16px; margin-bottom: 12px; display: flex; align-items: center; gap: 8px;">
        <span style="color: #d97706;">📝</span> 分析笔记
        <span style="font-size: 12px; color: #666; font-weight: normal;">(${notes.length})</span>
      </h2>
      <div style="display: flex; flex-direction: column; gap: 6px;">
        ${notes.map(n => `
          <div style="padding: 8px 12px; background: white; border-radius: 6px; border: 1px solid #e5e7eb;">
            <span style="font-size: 11px; color: #9ca3af; text-transform: uppercase; letter-spacing: 0.5px;">${this.escapeHtml(n.section || n.type || 'note')}${n.priority ? ` · ${n.priority}` : ''}</span>
            <div style="margin-top: 4px; font-size: 14px;">${this.markdownToHtml(n.content)}</div>
          </div>`).join('')}
      </div>
    </div>`;
  }

  /**
   * P1-R3: Render uncertainty flags from agentv3 flag_uncertainty data
   */
  private renderUncertaintyFlagsSection(flags?: AgentDrivenReportData['uncertaintyFlags']): string {
    if (!flags || flags.length === 0) return '';
    return `
    <div class="section" style="background: #fffbeb; border-radius: 8px; padding: 16px; margin-bottom: 20px;">
      <h2 class="section-title" style="font-size: 16px; margin-bottom: 12px; display: flex; align-items: center; gap: 8px;">
        <span style="color: #f59e0b;">⚠</span> 不确定性标记
        <span style="font-size: 12px; color: #666; font-weight: normal;">(${flags.length})</span>
      </h2>
      <div style="display: flex; flex-direction: column; gap: 6px;">
        ${flags.map(f => `
          <div style="padding: 8px 12px; background: white; border-radius: 6px; border: 1px solid #fcd34d;">
            <div style="font-weight: 500;">${this.escapeHtml(f.topic)}</div>
            <div style="font-size: 13px; color: #6b7280; margin-top: 2px;">假设: ${this.escapeHtml(f.assumption)}</div>
            <div style="font-size: 13px; color: #92400e; margin-top: 2px;">待确认: ${this.escapeHtml(f.question)}</div>
          </div>`).join('')}
      </div>
    </div>`;
  }

  /**
   * 渲染假设与验证部分 - 精简版
   * 只在假设驱动模式下显示，且只显示已确认或高置信度的假设
   */
  private renderHypothesesSection(hypotheses: Array<{
    description: string;
    status: string;
    confidence: number;
    supportingEvidence: any[];
    contradictingEvidence: any[];
  }>): string {
    if (!hypotheses || hypotheses.length === 0) return '';

    // 过滤掉低价值假设（只保留 confirmed 或 confidence >= 0.6 的）
    const meaningfulHypotheses = hypotheses.filter(h =>
      h.status === 'confirmed' || h.confidence >= 0.6
    );

    if (meaningfulHypotheses.length === 0) return '';

    return `
    <div class="section" style="background: #fafafa; border-radius: 8px; padding: 16px; margin-bottom: 20px;">
      <h2 class="section-title" style="font-size: 16px; margin-bottom: 12px; display: flex; align-items: center; gap: 8px;">
        <span style="color: #6366f1;">💡</span> 分析假设
        <span style="font-size: 12px; color: #666; font-weight: normal;">(${meaningfulHypotheses.length})</span>
      </h2>
      <div style="display: flex; flex-direction: column; gap: 8px;">
        ${meaningfulHypotheses.map((h) => `
          <div style="display: flex; align-items: center; gap: 12px; padding: 8px 12px; background: white; border-radius: 6px; border: 1px solid #e5e7eb;">
            <span style="font-size: 14px; color: ${h.status === 'confirmed' ? '#059669' : '#6366f1'};">
              ${h.status === 'confirmed' ? '✓' : '?'}
            </span>
            <span style="flex: 1; font-size: 13px; color: #374151;">${this.escapeHtml(h.description)}</span>
            <span style="font-size: 12px; color: #666; min-width: 50px; text-align: right;">
              ${(h.confidence * 100).toFixed(0)}%
            </span>
            <div style="width: 60px; height: 4px; background: #e5e7eb; border-radius: 2px; overflow: hidden;">
              <div style="width: ${h.confidence * 100}%; height: 100%; background: ${h.status === 'confirmed' ? '#059669' : '#6366f1'};"></div>
            </div>
          </div>
        `).join('')}
      </div>
    </div>
    `;
  }

  private normalizeConversationTimeline(
    timeline: Array<{
      eventId?: string;
      ordinal?: number;
      phase?: string;
      role?: string;
      text?: string;
      timestamp?: number;
      sourceEventType?: string;
    }>,
    dialogue: Array<{ agentId: string; type: 'task' | 'response' | 'question'; content: any; timestamp: number }>
  ): Array<{
    eventId: string;
    ordinal: number;
    phase: 'progress' | 'thinking' | 'tool' | 'result' | 'error';
    role: 'agent' | 'system';
    text: string;
    timestamp: number;
    sourceEventType?: string;
  }> {
    const normalized: Array<{
      eventId: string;
      ordinal: number;
      phase: 'progress' | 'thinking' | 'tool' | 'result' | 'error';
      role: 'agent' | 'system';
      text: string;
      timestamp: number;
      sourceEventType?: string;
    }> = [];

    if (Array.isArray(timeline) && timeline.length > 0) {
      for (const item of timeline) {
        const text = String(item?.text || '').replace(/\s+/g, ' ').trim().slice(0, 240);
        const ordinal = Number(item?.ordinal);
        if (!text || !Number.isFinite(ordinal) || ordinal <= 0) continue;
        const phaseRaw = String(item?.phase || '').toLowerCase();
        const phase = (
          phaseRaw === 'thinking' ||
          phaseRaw === 'tool' ||
          phaseRaw === 'result' ||
          phaseRaw === 'error'
        ) ? phaseRaw : 'progress';
        const role = String(item?.role || '').toLowerCase() === 'system' ? 'system' : 'agent';
        const eventId = String(item?.eventId || `conversation-${ordinal}`).trim();
        normalized.push({
          eventId,
          ordinal,
          phase,
          role,
          text,
          timestamp: Number.isFinite(Number(item?.timestamp)) ? Number(item?.timestamp) : 0,
          sourceEventType: item?.sourceEventType ? String(item.sourceEventType) : undefined,
        });
      }
    } else if (Array.isArray(dialogue) && dialogue.length > 0) {
      for (let i = 0; i < dialogue.length; i++) {
        const item = dialogue[i];
        const content = item?.content || {};
        const text = String(
          content.message ||
          content.summary ||
          content.taskTitle ||
          content.phase ||
          ''
        ).replace(/\s+/g, ' ').trim().slice(0, 240);
        if (!text) continue;
        const phase = item.type === 'task' ? 'tool' : item.type === 'response' ? 'result' : 'thinking';
        normalized.push({
          eventId: `dialogue-${i + 1}`,
          ordinal: i + 1,
          phase,
          role: 'agent',
          text,
          timestamp: Number(item.timestamp) || 0,
          sourceEventType: 'agent_dialogue',
        });
      }
    }

    const byOrdinal = new Map<number, typeof normalized[number]>();
    for (const item of normalized) {
      if (!byOrdinal.has(item.ordinal)) {
        byOrdinal.set(item.ordinal, item);
      }
    }
    return [...byOrdinal.values()].sort((a, b) => a.ordinal - b.ordinal);
  }

  private getConversationPhaseLabel(phase: 'progress' | 'thinking' | 'tool' | 'result' | 'error'): string {
    switch (phase) {
      case 'thinking':
        return '思考';
      case 'tool':
        return '工具';
      case 'result':
        return '结果';
      case 'error':
        return '错误';
      case 'progress':
      default:
        return '进度';
    }
  }

  private renderConversationTimelineSection(
    timeline: Array<{
      eventId: string;
      ordinal: number;
      phase: 'progress' | 'thinking' | 'tool' | 'result' | 'error';
      role: 'agent' | 'system';
      text: string;
      timestamp: number;
      sourceEventType?: string;
    }>
  ): string {
    if (!Array.isArray(timeline) || timeline.length === 0) return '';

    const sectionId = 'conversation_timeline_section';
    const defaultVisibleCount = 12;
    const shouldCollapse = timeline.length > defaultVisibleCount;

    return `
    <div class="section" id="${sectionId}">
      <h2 class="section-title">🧵 对话时间线</h2>
      <div class="timeline-toolbar">
        <div class="timeline-filters">
          <button class="timeline-filter-btn active" type="button" data-phase="all" onclick="filterConversationTimeline('${sectionId}', 'all', this)">全部</button>
          <button class="timeline-filter-btn" type="button" data-phase="progress" onclick="filterConversationTimeline('${sectionId}', 'progress', this)">进度</button>
          <button class="timeline-filter-btn" type="button" data-phase="thinking" onclick="filterConversationTimeline('${sectionId}', 'thinking', this)">思考</button>
          <button class="timeline-filter-btn" type="button" data-phase="tool" onclick="filterConversationTimeline('${sectionId}', 'tool', this)">工具</button>
          <button class="timeline-filter-btn" type="button" data-phase="result" onclick="filterConversationTimeline('${sectionId}', 'result', this)">结果</button>
          <button class="timeline-filter-btn" type="button" data-phase="error" onclick="filterConversationTimeline('${sectionId}', 'error', this)">错误</button>
        </div>
        ${shouldCollapse ? `<button class="timeline-collapse-btn" type="button" onclick="toggleConversationTimelineCollapse('${sectionId}', this)">展开全部</button>` : ''}
      </div>
      <div class="timeline-list">
        ${timeline.map((item, idx) => `
          <div class="timeline-item phase-${item.phase}${shouldCollapse && idx >= defaultVisibleCount ? ' timeline-hidden timeline-collapsed' : ''}" data-phase="${this.escapeHtml(item.phase)}" data-collapsed="${shouldCollapse && idx >= defaultVisibleCount ? 'true' : 'false'}">
            <div class="timeline-step">#${item.ordinal}</div>
            <div class="timeline-meta">
              <span class="timeline-phase">${this.escapeHtml(this.getConversationPhaseLabel(item.phase))}</span>
              <span class="timeline-role">${this.escapeHtml(item.role === 'system' ? '系统' : '助手')}</span>
            </div>
            <div class="timeline-text">${this.escapeHtml(item.text)}</div>
          </div>
        `).join('')}
      </div>
    </div>
    `;
  }

  /**
   * 渲染发现的问题部分 - 已禁用
   * 数据已在 DataEnvelopes 中详细展示，此部分冗余
   */
  private renderFindingsSection(_findings: Finding[], _dataEnvelopes: DataEnvelope[]): string {
    // 直接返回空字符串，不再显示此部分
    return '';
  }

  /**
   * Render enhanced dialogue item with meaningful content extraction from agent responses
   */
  private renderEnhancedDialogue(
    d: { agentId: string; type: string; content: any; timestamp: number },
    agentResponses: Array<{ taskId: string; agentId: string; response: any; timestamp: number }>
  ): string {
    const typeLabel = d.type === 'task' ? '任务派发' : d.type === 'response' ? '任务完成' : '问询';

    // Extract meaningful content from the dialogue
    let contentHtml = '';

    if (d.type === 'task') {
      // For task dispatch, show the objective/message
      const message = d.content?.message || d.content?.objective || d.content?.description || '';
      const agentId = d.content?.agentId || '';
      contentHtml = `<strong>${typeLabel}${agentId ? ` → ${this.escapeHtml(agentId)}` : ''}:</strong> ${this.escapeHtml(message || d.content?.phase || '')}`;
    } else if (d.type === 'response') {
      // For responses, extract findings/confidence from the matching agentResponse
      const matchingResponse = agentResponses.find(
        r => r.agentId === d.agentId && Math.abs(r.timestamp - d.timestamp) < 5000
      );

      const response = matchingResponse?.response || d.content?.response || d.content;
      const findings = response?.findings || response?.result?.findings || [];
      const confidence = response?.confidence || response?.result?.confidence;

      contentHtml = `<strong>${typeLabel}:</strong>`;

      if (findings.length > 0) {
        contentHtml += ` ${findings.length} 条发现`;
        contentHtml += `<div class="dialogue-findings">`;
        contentHtml += findings.slice(0, 5).map((f: any) => {
          const severity = f.severity || 'info';
          const colors: Record<string, string> = {
            critical: '#fef2f2; color: #dc2626',
            high: '#fef2f2; color: #dc2626',
            warning: '#fff7ed; color: #ea580c',
            medium: '#fff7ed; color: #ea580c',
            info: '#eff6ff; color: #2563eb',
            low: '#f0fdf4; color: #059669',
          };
          const color = colors[severity] || colors.info;
          return `<span class="finding-tag" style="background: ${color}">[${severity}] ${this.escapeHtml((f.title || '').substring(0, 60))}</span>`;
        }).join('');
        if (findings.length > 5) {
          contentHtml += `<span class="finding-tag" style="background: #f3f4f6; color: #6b7280">+${findings.length - 5} more</span>`;
        }
        contentHtml += `</div>`;
      } else {
        // Fallback to showing the phase/message
        const message = d.content?.message || d.content?.phase || '';
        if (message) {
          contentHtml += ` ${this.escapeHtml(String(message).substring(0, 200))}`;
        }
      }

      if (confidence !== undefined) {
        contentHtml += `<div style="margin-top: 4px; font-size: 11px; color: #888;">置信度: ${(Number(confidence) * 100).toFixed(0)}%</div>`;
      }
    } else {
      contentHtml = `<strong>${typeLabel}:</strong> ${this.escapeHtml(String(d.content?.message || d.content?.phase || JSON.stringify(d.content)).substring(0, 200))}`;
    }

    return `
      <div class="dialogue-item ${d.type}">
        <div class="dialogue-agent">[${this.escapeHtml(d.agentId)}]</div>
        <div class="dialogue-content">${contentHtml}</div>
      </div>
    `;
  }

  generateFromSession(session: AnalysisSession, answer: string): string {
    const data: ReportData = {
      sessionId: session.id,
      traceId: session.traceId,
      question: session.question,
      answer,
      metrics: {
        totalDuration: Date.now() - session.createdAt.getTime(),
        iterationsCount: session.currentIteration,
        sqlQueriesCount: session.collectedResults.length,
      },
      collectedResults: session.collectedResults,
      skillEngineResult: session.skillEngineResult,
      timestamp: Date.now(),
    };
    return this.generateHTML(data);
  }
}

// Singleton instance
let instance: HTMLReportGenerator | null = null;

export function getHTMLReportGenerator(): HTMLReportGenerator {
  if (!instance) {
    instance = new HTMLReportGenerator();
  }
  return instance;
}

export default HTMLReportGenerator;
