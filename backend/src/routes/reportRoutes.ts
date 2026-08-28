// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

/**
 * Report Routes
 *
 * API endpoints for generating and serving HTML analysis reports.
 * Reports are persisted to disk (`logs/reports/`) and cached in memory.
 */

import express from 'express';
import crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import type Database from 'better-sqlite3';
import { attachRequestContext, requireRequestContext, type RequestContext } from '../middleware/auth';
import { openEnterpriseDb } from '../services/enterpriseDb';
import { recordEnterpriseAuditEventForContext } from '../services/enterpriseAuditService';
import {
  enterpriseDbReadAuthorityEnabled,
  enterpriseDbWritesEnabled,
  legacyFilesystemWritesEnabled,
} from '../services/enterpriseMigration';
import {
  REPORT_CAUSAL_MAP_CSS,
  REPORT_CAUSAL_MAP_MARKER,
  REPORT_CAUSAL_MAP_SCRIPT,
  REPORT_CAUSAL_MAP_STYLE_MARKER,
  REPORT_MERMAID_ASSET_ROUTE,
} from '../services/reportCausalMapAssets';
import { REPORT_LAYOUT_FIX_CSS, REPORT_LAYOUT_FIX_MARKER } from '../services/reportLayoutAssets';
import { localize, parseOutputLanguage } from '../agentv3/outputLanguage';
import { backendLogPath } from '../runtimePaths';
import {WeightedLruMap} from '../services/weightedLruMap';
import {
  readTraceMetadataForContext,
  resolveEnterpriseDataRoot,
} from '../services/traceMetadataStore';
import { resolveEnterpriseRetentionExpiresAt } from '../services/enterpriseQuotaPolicyService';
import {
  sendResourceNotFound,
  type ResourceOwnerFields,
} from '../services/resourceOwnership';
import {
  canDeleteReportResource,
  canReadReportResource,
  sendForbidden,
  sharesWorkspaceWithContext,
} from '../services/rbac';

const router = express.Router();

const REPORTS_DIR = backendLogPath('reports');
export const REPORT_DOCUMENT_CSP = [
  "sandbox allow-scripts",
  "default-src 'none'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'unsafe-inline'",
  'img-src data:',
  'font-src data:',
  "connect-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ');

function isRegularFileInside(root: string, candidate: string): string | undefined {
  try {
    const realRoot = fs.realpathSync.native(root);
    const realCandidate = fs.realpathSync.native(candidate);
    const relative = path.relative(realRoot, realCandidate);
    if (
      relative === '..' ||
      relative.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relative) ||
      !fs.statSync(realCandidate).isFile()
    ) {
      return undefined;
    }
    return realCandidate;
  } catch {
    return undefined;
  }
}

export function resolveReportMermaidAssetPath(
  packageRoot = process.env.SMARTPERFETTO_PACKAGE_ROOT || process.cwd(),
): string | undefined {
  const resolvedPackageRoot = path.resolve(packageRoot);
  const packageRoots = Array.from(new Set([
    resolvedPackageRoot,
    path.basename(resolvedPackageRoot) === 'backend'
      ? path.dirname(resolvedPackageRoot)
      : resolvedPackageRoot,
    path.resolve(__dirname, '../../..'),
  ]));
  const roots = packageRoots.flatMap(root => [
    path.join(root, 'frontend'),
    path.join(root, 'perfetto', 'out', 'ui', 'ui'),
    root,
  ]);
  for (const root of roots) {
    const direct = isRegularFileInside(root, path.join(root, 'assets', 'mermaid.min.js'));
    if (direct) return direct;
    let versions: fs.Dirent[];
    try {
      versions = fs.readdirSync(root, {withFileTypes: true})
        .filter(entry => entry.isDirectory() && /^v[0-9]/.test(entry.name))
        .sort((left, right) => right.name.localeCompare(left.name));
    } catch {
      continue;
    }
    for (const version of versions) {
      const candidate = isRegularFileInside(
        root,
        path.join(root, version.name, 'assets', 'mermaid.min.js'),
      );
      if (candidate) return candidate;
    }
  }
  return undefined;
}

function setReportDocumentSecurityHeaders(res: express.Response): void {
  res.setHeader('Content-Security-Policy', REPORT_DOCUMENT_CSP);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
}

// Ensure reports directory exists
if (!fs.existsSync(REPORTS_DIR)) {
  fs.mkdirSync(REPORTS_DIR, { recursive: true });
}

router.use(attachRequestContext);

// In-memory cache backed by disk persistence
type PersistedReport = ResourceOwnerFields & {
  html: string;
  generatedAt: number;
  sessionId: string;
  runId?: string;
  traceId?: string;
  visibility?: string;
  expiresAt?: number | null;
};

const REPORT_CACHE_MAX_ENTRIES = 64;
const REPORT_CACHE_MAX_BYTES = 32 * 1024 * 1024;
const REPORT_FILENAME_STEM_MAX_LENGTH = 116;
const UNSAFE_REPORT_FILENAME_CHAR_RE = /[<>:"/\\|?*\u0000-\u001f\u007f]/gu;

export const reportStore = new WeightedLruMap<string, PersistedReport>(
  REPORT_CACHE_MAX_ENTRIES,
  REPORT_CACHE_MAX_BYTES,
  report => Buffer.byteLength(report.html, 'utf8'),
);

interface ReportArtifactRow {
  id: string;
  tenant_id: string;
  workspace_id: string;
  session_id: string;
  run_id: string;
  local_path: string;
  content_hash: string | null;
  visibility: string;
  created_by: string | null;
  created_at: number;
  expires_at: number | null;
}

function recordReportAudit(
  context: RequestContext,
  action: 'report.read' | 'report.exported' | 'report.deleted',
  reportId: string,
  report: PersistedReport,
): void {
  recordEnterpriseAuditEventForContext(context, {
    action,
    resourceType: 'report',
    resourceId: reportId,
    metadata: {
      sessionId: report.sessionId,
      runId: report.runId,
      traceId: report.traceId,
      visibility: report.visibility,
    },
  });
}

const SAFE_REPORT_ID_RE = /^[a-zA-Z0-9._:-]+$/;

function isSafeReportSegment(value: string): boolean {
  return SAFE_REPORT_ID_RE.test(value) && value !== '.' && value !== '..';
}

function enterpriseReportStoreEnabled(): boolean {
  return enterpriseDbReadAuthorityEnabled();
}

function enterpriseReportDbWritesEnabled(): boolean {
  return enterpriseDbWritesEnabled();
}

function legacyReportWritesEnabled(): boolean {
  return legacyFilesystemWritesEnabled();
}

function assertSafeReportSegment(value: string, label: string): string {
  if (!isSafeReportSegment(value)) {
    throw new Error(`Unsafe ${label}: ${value}`);
  }
  return value;
}

function reportContentHash(html: string): string {
  return crypto.createHash('sha256').update(html).digest('hex');
}

function withEnterpriseReportDb<T>(fn: (db: Database.Database) => T): T {
  const db = openEnterpriseDb();
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

function enterpriseReportDir(reportId: string, entry: PersistedReport): string {
  if (!entry.tenantId || !entry.workspaceId) {
    throw new Error('Enterprise report persistence requires tenantId and workspaceId');
  }
  return path.join(
    resolveEnterpriseDataRoot(),
    assertSafeReportSegment(entry.tenantId, 'tenant id'),
    assertSafeReportSegment(entry.workspaceId, 'workspace id'),
    'reports',
    assertSafeReportSegment(reportId, 'report id'),
  );
}

function fallbackTraceId(entry: PersistedReport): string {
  return entry.traceId || `trace-${entry.sessionId}-report`;
}

function fallbackRunId(entry: PersistedReport): string {
  return entry.runId || `run-${entry.sessionId}-report`;
}

function isReportExpired(entry: PersistedReport, now = Date.now()): boolean {
  return typeof entry.expiresAt === 'number' && entry.expiresAt <= now;
}

function ensureEnterpriseReportGraph(
  db: Database.Database,
  reportId: string,
  entry: PersistedReport,
): { traceId: string; runId: string } {
  if (!entry.tenantId || !entry.workspaceId) {
    throw new Error('Enterprise report persistence requires tenantId and workspaceId');
  }
  const tenantId = assertSafeReportSegment(entry.tenantId, 'tenant id');
  const workspaceId = assertSafeReportSegment(entry.workspaceId, 'workspace id');
  const userId = entry.userId ? assertSafeReportSegment(entry.userId, 'user id') : null;
  const traceId = fallbackTraceId(entry);
  const runId = fallbackRunId(entry);
  const now = Date.now();

  db.prepare(`
    INSERT OR IGNORE INTO organizations (id, name, status, plan, created_at, updated_at)
    VALUES (?, ?, 'active', 'enterprise', ?, ?)
  `).run(tenantId, tenantId, now, now);
  db.prepare(`
    INSERT OR IGNORE INTO workspaces (id, tenant_id, name, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(workspaceId, tenantId, workspaceId, now, now);
  if (userId) {
    db.prepare(`
      INSERT INTO users (id, tenant_id, email, display_name, idp_subject, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        email = excluded.email,
        display_name = excluded.display_name,
        updated_at = excluded.updated_at
    `).run(
      userId,
      tenantId,
      `${userId}@report.local`,
      userId,
      `report:${userId}`,
      now,
      now,
    );
  }
  db.prepare(`
    INSERT OR IGNORE INTO trace_assets
      (id, tenant_id, workspace_id, owner_user_id, local_path, size_bytes, status, metadata_json, created_at)
    VALUES
      (?, ?, ?, ?, ?, 0, 'metadata_only', ?, ?)
  `).run(
    traceId,
    tenantId,
    workspaceId,
    userId,
    `metadata-only:${traceId}`,
    JSON.stringify({ source: 'report_artifact', reportId }),
    entry.generatedAt || now,
  );
  db.prepare(`
    INSERT OR IGNORE INTO analysis_sessions
      (id, tenant_id, workspace_id, trace_id, created_by, title, visibility, status, created_at, updated_at)
    VALUES
      (?, ?, ?, ?, ?, ?, ?, 'completed', ?, ?)
  `).run(
    entry.sessionId,
    tenantId,
    workspaceId,
    traceId,
    userId,
    `Report ${reportId}`,
    entry.visibility || 'private',
    entry.generatedAt || now,
    now,
  );
  db.prepare(`
    INSERT OR IGNORE INTO analysis_runs
      (id, tenant_id, workspace_id, session_id, mode, status, question, started_at, completed_at)
    VALUES
      (?, ?, ?, ?, 'report', 'completed', '', ?, ?)
  `).run(
    runId,
    tenantId,
    workspaceId,
    entry.sessionId,
    entry.generatedAt || now,
    entry.generatedAt || now,
  );

  return { traceId, runId };
}

function persistEnterpriseReport(reportId: string, entry: PersistedReport): void {
  const reportDir = enterpriseReportDir(reportId, entry);
  const htmlPath = path.join(reportDir, 'report.html');
  const metadataPath = path.join(reportDir, 'report.json');
  fs.mkdirSync(reportDir, { recursive: true });
  fs.writeFileSync(htmlPath, entry.html, 'utf-8');

  withEnterpriseReportDb((db) => {
    const { runId } = ensureEnterpriseReportGraph(db, reportId, entry);
    const createdAt = entry.generatedAt || Date.now();
    const visibility = entry.visibility || 'private';
    const contentHash = reportContentHash(entry.html);
    const expiresAt = resolveEnterpriseRetentionExpiresAt(
      db,
      {
        tenantId: entry.tenantId!,
        workspaceId: entry.workspaceId!,
        ...(entry.userId ? { userId: entry.userId } : {}),
      },
      'report',
      createdAt,
    );
    entry.expiresAt = expiresAt;
    db.prepare(`
      INSERT INTO report_artifacts
        (id, tenant_id, workspace_id, session_id, run_id, local_path, content_hash, visibility, created_by, created_at, expires_at)
      VALUES
        (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        tenant_id = excluded.tenant_id,
        workspace_id = excluded.workspace_id,
        session_id = excluded.session_id,
        run_id = excluded.run_id,
        local_path = excluded.local_path,
        content_hash = excluded.content_hash,
        visibility = excluded.visibility,
        created_by = excluded.created_by,
        expires_at = excluded.expires_at
    `).run(
      reportId,
      entry.tenantId,
      entry.workspaceId,
      entry.sessionId,
      runId,
      htmlPath,
      contentHash,
      visibility,
      entry.userId ?? null,
      createdAt,
      expiresAt,
    );

    fs.writeFileSync(metadataPath, JSON.stringify({
      reportId,
      generatedAt: createdAt,
      sessionId: entry.sessionId,
      runId,
      traceId: fallbackTraceId(entry),
      tenantId: entry.tenantId,
      workspaceId: entry.workspaceId,
      userId: entry.userId,
      visibility,
      contentHash,
      expiresAt,
    }, null, 2));
  });
}

function persistLegacyReport(reportId: string, entry: PersistedReport): void {
  const filePath = path.join(REPORTS_DIR, `${reportId}.html`);
  fs.writeFileSync(filePath, entry.html, 'utf-8');
  const metaPath = path.join(REPORTS_DIR, `${reportId}.meta.json`);
  fs.writeFileSync(metaPath, JSON.stringify({
    generatedAt: entry.generatedAt,
    sessionId: entry.sessionId,
    runId: entry.runId,
    traceId: entry.traceId,
    tenantId: entry.tenantId,
    workspaceId: entry.workspaceId,
    userId: entry.userId,
    visibility: entry.visibility,
    expiresAt: entry.expiresAt,
  }));
}

function loadEnterpriseReport(reportId: string): PersistedReport | null {
  if (!isSafeReportSegment(reportId)) return null;
  try {
    return withEnterpriseReportDb((db) => {
      const row = db.prepare<unknown[], ReportArtifactRow>(`
        SELECT *
        FROM report_artifacts
        WHERE id = ?
          AND (expires_at IS NULL OR expires_at > ?)
      `).get(reportId, Date.now());
      if (!row || !fs.existsSync(row.local_path)) return null;
      const html = fs.readFileSync(row.local_path, 'utf-8');
      const entry: PersistedReport = {
        html: upgradeLegacyReportHtml(html),
        generatedAt: row.created_at,
        sessionId: row.session_id,
        runId: row.run_id,
        tenantId: row.tenant_id,
        workspaceId: row.workspace_id,
        ...(row.created_by ? { userId: row.created_by } : {}),
        visibility: row.visibility,
        expiresAt: row.expires_at,
      };
      reportStore.set(reportId, entry);
      return entry;
    });
  } catch {
    return null;
  }
}

const LEGACY_MERMAID_UPGRADE_CSS = REPORT_CAUSAL_MAP_CSS;

const LEGACY_MERMAID_UPGRADE_SCRIPT = REPORT_CAUSAL_MAP_SCRIPT;

function injectReportStyle(html: string, css: string): string {
  if (html.includes('</style>')) {
    return html.replace('</style>', `${css}\n</style>`);
  }
  if (html.includes('</head>')) {
    return html.replace('</head>', `<style>\n${css}\n</style>\n</head>`);
  }
  return html;
}

function shouldInjectLegacyReportLayoutFix(html: string): boolean {
  if (html.includes(REPORT_LAYOUT_FIX_MARKER)) return false;
  return (
    /class=["'][^"']*\bmetrics-grid\b/.test(html) &&
    /class=["'][^"']*\bmetric-label\b/.test(html) &&
    /class=["'][^"']*\bmetric-value\b/.test(html)
  );
}

function upgradePreviouslyGatedCausalMapScript(html: string): string {
  const gateStart = "if (typeof mermaid !== 'undefined') {";
  const causalMapMarker = '\n  function decodeMermaidSource';
  const fallbackStart = '  if (mermaidTargets.length > 0) {\n    mermaid.initialize({';
  const gateStartIndex = html.indexOf(`${gateStart}${causalMapMarker}`);
  if (gateStartIndex === -1) return html;

  const scriptEndIndex = html.indexOf('</script>', gateStartIndex);
  if (scriptEndIndex === -1) return html;

  const gateEndIndex = html.lastIndexOf('\n}', scriptEndIndex);
  if (gateEndIndex === -1) return html;

  const gatedBody = html.slice(gateStartIndex + gateStart.length, gateEndIndex);
  if (!gatedBody.includes(fallbackStart)) return html;

  const upgradedBody = gatedBody.replace(
    fallbackStart,
    `  if (mermaidTargets.length > 0) {
    if (typeof mermaid === 'undefined') {
      console.error('[SmartPerfetto] Mermaid library is unavailable; showing the original diagram source.');
      return;
    }

    mermaid.initialize({`,
  );
  const upgradedScript = `(function() {${upgradedBody}\n})();`;
  return `${html.slice(0, gateStartIndex)}${upgradedScript}${html.slice(gateEndIndex + 2)}`;
}

export function upgradeLegacyReportHtml(html: string): string {
  if (!html) return html;

  let upgraded = upgradePreviouslyGatedCausalMapScript(html);

  if (shouldInjectLegacyReportLayoutFix(upgraded)) {
    upgraded = injectReportStyle(upgraded, REPORT_LAYOUT_FIX_CSS);
  }

  const hasMermaid = upgraded.includes('<pre class="mermaid">');
  if (hasMermaid) {
    upgraded = upgraded.replace(
      /<script\s+src=["']https:\/\/cdn\.jsdelivr\.net\/npm\/mermaid@[^"']+["']\s*><\/script>/gi,
      `<script src="${REPORT_MERMAID_ASSET_ROUTE}"></script>`,
    );
    if (!upgraded.includes(REPORT_CAUSAL_MAP_STYLE_MARKER)) {
      upgraded = injectReportStyle(upgraded, LEGACY_MERMAID_UPGRADE_CSS);
    }
    upgraded = upgraded.replace(
      /<pre class="mermaid">([\s\S]*?)<\/pre>/g,
      (match, source, offset, full) => {
        const prefix = String(full).slice(Math.max(0, Number(offset) - 64), Number(offset));
        return prefix.endsWith('<div class="mermaid-wrapper">')
          ? match
          : `<div class="mermaid-wrapper"><pre class="mermaid">${source}</pre></div>`;
      },
    );
    if (!upgraded.includes(REPORT_CAUSAL_MAP_MARKER)) {
      let replaced = false;
      upgraded = upgraded.replace(/<script>([\s\S]*?)<\/script>/g, (scriptTag, body) => {
        if (
          replaced ||
          !/parseMermaidFlowSource|document\.querySelectorAll\(['"]pre\.mermaid['"]\)|mermaid\.run\(\{\s*querySelector:\s*['"]pre\.mermaid['"]/.test(body)
        ) {
          return scriptTag;
        }
        replaced = true;
        return `<script>\n${LEGACY_MERMAID_UPGRADE_SCRIPT}\n</script>`;
      });
      if (!replaced) {
        upgraded = upgraded.replace(
          '</body>',
          `<script>\n${LEGACY_MERMAID_UPGRADE_SCRIPT}\n</script>\n</body>`,
        );
      }
    }
    if (!upgraded.includes(`src="${REPORT_MERMAID_ASSET_ROUTE}"`)) {
      const assetTag = `<script src="${REPORT_MERMAID_ASSET_ROUTE}"></script>`;
      const causalScriptIndex = upgraded.indexOf(`<script>\n${LEGACY_MERMAID_UPGRADE_SCRIPT}`);
      upgraded = causalScriptIndex >= 0
        ? `${upgraded.slice(0, causalScriptIndex)}${assetTag}\n${upgraded.slice(causalScriptIndex)}`
        : upgraded.replace('</body>', `${assetTag}\n</body>`);
    }
  }

  return upgraded;
}

router.get('/assets/mermaid.min.js', (_req, res) => {
  const assetPath = resolveReportMermaidAssetPath();
  if (!assetPath) {
    return res.status(404).type('text/plain').send('Mermaid report asset is unavailable');
  }
  res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'private, max-age=3600');
  // The repository's isolated worktrees live below a `.worktrees` segment.
  // `sendFile` rejects such an already-validated absolute path unless dotfile
  // traversal is explicitly allowed, even though the target itself is not a
  // dotfile and `resolveReportMermaidAssetPath` has already fail-closed it.
  return res.sendFile(assetPath, {dotfiles: 'allow'});
});

/** Save a report to disk. Called externally when reports are generated. */
export function persistReport(reportId: string, entry: PersistedReport): void {
  const safeReportId = assertSafeReportSegment(reportId, 'report id');
  reportStore.set(safeReportId, entry);
  try {
    if (legacyReportWritesEnabled()) {
      persistLegacyReport(safeReportId, entry);
    }
    if (enterpriseReportDbWritesEnabled()) {
      persistEnterpriseReport(safeReportId, entry);
    }
  } catch (err) {
    console.warn('[ReportRoutes] Failed to persist report to disk:', (err as Error).message);
  }
}

/** Load a report from disk if not in memory cache. */
function loadReportFromDisk(reportId: string): PersistedReport | null {
  if (enterpriseReportStoreEnabled()) {
    return loadEnterpriseReport(reportId);
  }
  return loadLegacyReportFromDisk(reportId);
}

function loadLegacyReportFromDisk(reportId: string): PersistedReport | null {
  if (!isSafeReportSegment(reportId)) return null;
  try {
    const filePath = path.join(REPORTS_DIR, `${reportId}.html`);
    if (!fs.existsSync(filePath)) return null;

    const html = fs.readFileSync(filePath, 'utf-8');
    const metaPath = path.join(REPORTS_DIR, `${reportId}.meta.json`);
    let generatedAt = Date.now();
    let sessionId = '';
    let runId: string | undefined;
    let traceId: string | undefined;
    let visibility: string | undefined;
    let expiresAt: number | undefined;
    let owner: ResourceOwnerFields = {};
    if (fs.existsSync(metaPath)) {
      const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
      generatedAt = meta.generatedAt || generatedAt;
      sessionId = meta.sessionId || '';
      runId = meta.runId;
      traceId = meta.traceId;
      visibility = meta.visibility;
      expiresAt = typeof meta.expiresAt === 'number' ? meta.expiresAt : undefined;
      owner = {
        tenantId: meta.tenantId,
        workspaceId: meta.workspaceId,
        userId: meta.userId,
        ownerUserId: meta.ownerUserId,
      };
      if (typeof expiresAt === 'number' && expiresAt <= Date.now()) {
        return null;
      }
    }

    const entry = {
      html: upgradeLegacyReportHtml(html),
      generatedAt,
      sessionId,
      ...(runId ? { runId } : {}),
      ...(traceId ? { traceId } : {}),
      ...(visibility ? { visibility } : {}),
      ...(typeof expiresAt === 'number' ? { expiresAt } : {}),
      ...owner,
    };
    // Cache in memory for subsequent access
    reportStore.set(reportId, entry);
    return entry;
  } catch {
    return null;
  }
}

function deleteLegacyReport(reportId: string): boolean {
  if (!isSafeReportSegment(reportId)) return false;
  try {
    const htmlPath = path.join(REPORTS_DIR, `${reportId}.html`);
    const metaPath = path.join(REPORTS_DIR, `${reportId}.meta.json`);
    const existed = fs.existsSync(htmlPath) || fs.existsSync(metaPath);
    if (fs.existsSync(htmlPath)) fs.unlinkSync(htmlPath);
    if (fs.existsSync(metaPath)) fs.unlinkSync(metaPath);
    return existed;
  } catch {
    return false;
  }
}

function deleteEnterpriseReport(reportId: string): boolean {
  if (!isSafeReportSegment(reportId)) return false;
  try {
    return withEnterpriseReportDb((db) => {
      const row = db.prepare<unknown[], ReportArtifactRow>(
        'SELECT * FROM report_artifacts WHERE id = ?',
      ).get(reportId);
      if (!row) return false;
      db.prepare('DELETE FROM report_artifacts WHERE id = ?').run(reportId);
      try {
        const reportDir = path.dirname(row.local_path);
        const metadataPath = path.join(reportDir, 'report.json');
        if (fs.existsSync(row.local_path)) fs.unlinkSync(row.local_path);
        if (fs.existsSync(metadataPath)) fs.unlinkSync(metadataPath);
        fs.rmSync(reportDir, { recursive: true, force: true });
      } catch { /* non-fatal */ }
      return true;
    });
  } catch {
    return false;
  }
}

function deletePersistedReport(reportId: string): boolean {
  let deleted = false;
  if (enterpriseReportDbWritesEnabled()) {
    deleted = deleteEnterpriseReport(reportId) || deleted;
  }
  if (legacyReportWritesEnabled()) {
    deleted = deleteLegacyReport(reportId) || deleted;
  }
  return deleted;
}

function getReportForContext(reportId: string, req: express.Request): PersistedReport | null {
  if (!isSafeReportSegment(reportId)) return null;
  const context = requireRequestContext(req);
  const report = reportStore.get(reportId) || loadReportFromDisk(reportId);
  if (report && isReportExpired(report)) {
    reportStore.delete(reportId);
    return null;
  }
  if (!report || !canReadReportResource(report, context)) {
    return null;
  }
  return report;
}

function resolveReportTraceIdForExport(
  reportId: string,
  report: PersistedReport,
  context: RequestContext,
): string | undefined {
  if (report.traceId) return report.traceId;
  if (!enterpriseReportStoreEnabled()) return undefined;

  try {
    return withEnterpriseReportDb((db) => {
      const row = db.prepare<{
        reportId: string;
        tenantId: string;
        workspaceId: string;
        sessionId: string;
      }, {trace_id: string}>(`
        SELECT sessions.trace_id
        FROM report_artifacts AS reports
        INNER JOIN analysis_sessions AS sessions
          ON sessions.id = reports.session_id
          AND sessions.tenant_id = reports.tenant_id
          AND sessions.workspace_id = reports.workspace_id
        WHERE reports.id = @reportId
          AND reports.tenant_id = @tenantId
          AND reports.workspace_id = @workspaceId
          AND reports.session_id = @sessionId
        LIMIT 1
      `).get({
        reportId,
        tenantId: context.tenantId,
        workspaceId: context.workspaceId,
        sessionId: report.sessionId,
      });
      return row?.trace_id;
    });
  } catch {
    return undefined;
  }
}

async function reportTraceNameForExport(
  reportId: string,
  report: PersistedReport,
  context: RequestContext,
): Promise<string> {
  const traceId = resolveReportTraceIdForExport(reportId, report, context);
  if (!traceId) return reportId;

  try {
    return (await readTraceMetadataForContext(traceId, context))?.filename || traceId;
  } catch {
    return traceId;
  }
}

function sanitizeReportFilenameLabel(value: string, fallback: string): string {
  const basename = path.posix.basename(value.replace(/\\/gu, '/'));
  const sanitized = basename
    .normalize('NFKC')
    .replace(UNSAFE_REPORT_FILENAME_CHAR_RE, '_')
    .replace(/\s+/gu, ' ')
    .replace(/_+/gu, '_')
    .replace(/^\.+/u, '')
    .replace(/[ .]+$/u, '')
    .trim();
  return sanitized || fallback;
}

function reportAnalysisTimestamp(generatedAt: number): string {
  const date = new Date(generatedAt);
  if (!Number.isFinite(date.getTime())) return 'unknown-time';
  return date.toISOString().replace(/\.\d{3}Z$/u, 'Z').replace(/:/gu, '-');
}

function truncateReportFilenameLabel(value: string, maxLength: number): string {
  let result = '';
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint !== undefined && codePoint >= 0xd800 && codePoint <= 0xdfff) {
      continue;
    }
    if (result.length + character.length > maxLength) break;
    result += character;
  }
  return result;
}

function reportExportFilename(
  traceName: string,
  reportId: string,
  generatedAt: number,
): string {
  const fallback = sanitizeReportFilenameLabel(reportId, 'report');
  const traceLabel = sanitizeReportFilenameLabel(traceName, fallback);
  const suffix = `-${reportAnalysisTimestamp(generatedAt)}-SmartPerfetto`;
  const prefixLimit = Math.max(1, REPORT_FILENAME_STEM_MAX_LENGTH - suffix.length);
  const prefix = truncateReportFilenameLabel(traceLabel, prefixLimit)
    .replace(/[ .]+$/u, '') || fallback;
  return `${prefix}${suffix}.html`;
}

// Clean up old reports every 30 minutes (both memory and disk)
const reportCleanupInterval = setInterval(() => {
  const now = Date.now();
  const maxAge = 24 * 60 * 60 * 1000; // 24 hours

  // Clean memory cache
  for (const [reportId, report] of reportStore.entries()) {
    if (now - report.generatedAt > maxAge) {
      reportStore.delete(reportId);
    }
  }

  if (legacyReportWritesEnabled()) {
    try {
      const files = fs.readdirSync(REPORTS_DIR);
      for (const file of files) {
        if (!file.endsWith('.meta.json')) continue;
        const metaPath = path.join(REPORTS_DIR, file);
        try {
          const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
          if (meta.generatedAt && now - meta.generatedAt > maxAge) {
            const reportId = file.replace('.meta.json', '');
            fs.unlinkSync(metaPath);
            const htmlPath = path.join(REPORTS_DIR, `${reportId}.html`);
            if (fs.existsSync(htmlPath)) fs.unlinkSync(htmlPath);
          }
        } catch { /* skip individual file errors */ }
      }
    } catch { /* non-fatal */ }
  }
}, 30 * 60 * 1000);
reportCleanupInterval.unref?.();

/**
 * GET /api/reports/:reportId/export
 *
 * Download the persisted HTML report artifact. The frontend/report page uses this
 * endpoint together with the File System Access API so the user can choose the
 * local destination and filename.
 */
router.get('/:reportId/export', async (req, res) => {
  try {
    const { reportId } = req.params;
    const context = requireRequestContext(req);

    const report = getReportForContext(reportId, req);
    if (!report) {
      return res.status(404).json({
        success: false,
        error: 'Report not found',
      });
    }

    const traceName = await reportTraceNameForExport(reportId, report, context);
    const filename = reportExportFilename(traceName, reportId, report.generatedAt);
    res.attachment(filename);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    setReportDocumentSecurityHeaders(res);
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    recordReportAudit(context, 'report.exported', reportId, report);
    res.send(upgradeLegacyReportHtml(report.html));
  } catch (error: any) {
    console.error('[ReportRoutes] Export report error:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to export report',
    });
  }
});

/**
 * GET /api/reports/:reportId
 *
 * Get HTML report by ID (memory cache → disk fallback)
 */
router.get('/:reportId', (req, res) => {
  try {
    const { reportId } = req.params;
    const context = requireRequestContext(req);

    // Try memory cache first, then disk
    let report = getReportForContext(reportId, req);
    if (!report) {
      const outputLanguage = parseOutputLanguage(process.env.SMARTPERFETTO_OUTPUT_LANGUAGE);
      return res.status(404).send(`
        <!DOCTYPE html>
        <html lang="${outputLanguage === 'en' ? 'en' : 'zh-CN'}">
        <head>
          <meta charset="UTF-8">
          <title>${localize(outputLanguage, '报告未找到', 'Report Not Found')}</title>
          <style>
            body { font-family: sans-serif; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; background: #f5f7fa; }
            .error { text-align: center; padding: 40px; background: white; border-radius: 8px; box-shadow: 0 2px 12px rgba(0,0,0,0.1); }
            h1 { color: #ef4444; margin-bottom: 10px; }
            p { color: #666; }
          </style>
        </head>
        <body>
          <div class="error">
            <h1>${localize(outputLanguage, '报告未找到', 'Report Not Found')}</h1>
            <p>${localize(outputLanguage, '该报告可能已过期或不存在。请重新生成分析报告。', 'This report may have expired or may not exist. Generate the analysis report again.')}</p>
          </div>
        </body>
        </html>
      `);
    }

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    setReportDocumentSecurityHeaders(res);
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    recordReportAudit(context, 'report.read', reportId, report);
    res.send(upgradeLegacyReportHtml(report.html));
  } catch (error: any) {
    console.error('[ReportRoutes] Get report error:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to get report',
    });
  }
});

// Note: Report generation is handled by agent-driven analysis routes.

/**
 * DELETE /api/reports/:reportId
 *
 * Delete a report from memory and disk
 */
router.delete('/:reportId', (req, res) => {
  try {
    const { reportId } = req.params;
    if (!isSafeReportSegment(reportId)) {
      return sendResourceNotFound(res, 'Report not found');
    }

    const context = requireRequestContext(req);
    const report = reportStore.get(reportId) || loadReportFromDisk(reportId);
    if (!report || !sharesWorkspaceWithContext(report, context)) {
      return sendResourceNotFound(res, 'Report not found');
    }
    if (!canDeleteReportResource(report, context)) {
      return sendForbidden(res, 'Deleting this report requires report delete permission');
    }

    const deletedFromCache = reportStore.delete(reportId);
    const deletedFromPersistence = deletePersistedReport(reportId);
    const deleted = deletedFromCache || deletedFromPersistence;
    if (deleted) {
      recordReportAudit(context, 'report.deleted', reportId, report);
    }

    res.json({
      success: deleted,
      error: deleted ? undefined : 'Report not found',
    });
  } catch (error: any) {
    console.error('[ReportRoutes] Delete report error:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to delete report',
    });
  }
});

export default router;
