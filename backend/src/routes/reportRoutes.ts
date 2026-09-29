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
import {
  decodePrivateContextColumn,
  decodePrivateContextJson,
  encodePrivateContextColumn,
  type AnalysisPrivateContextMarker,
} from '../services/security/analysisPrivateContext';
import { insertAnalysisRunIfMissing } from '../services/analysisRunStore';

const router = express.Router();

const reportsDir = () => backendLogPath('reports');
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
  /** Fixed when the report is written; decides who may read it. */
  privateContext: AnalysisPrivateContextMarker;
};

/** What a store records about a report, without its content. */
type ReportRecord = Omit<PersistedReport, 'html'>;

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
  private_context: number | null;
}

function recordReportAudit(
  context: RequestContext,
  action: 'report.read' | 'report.exported' | 'report.deleted',
  reportId: string,
  report: ReportRecord,
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

function legacyReportMetaPath(reportId: string): string {
  return path.join(reportsDir(), `${reportId}.meta.json`);
}

function legacyReportHtmlPath(reportId: string): string {
  return path.join(reportsDir(), `${reportId}.html`);
}

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

function reportContentHash(content: string | Buffer): string {
  return crypto.createHash('sha256').update(content).digest('hex');
}

function withEnterpriseReportDb<T>(fn: (db: Database.Database) => T): T {
  const db = openEnterpriseDb();
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

function enterpriseReportDir(
  reportId: string,
  owner: Pick<ResourceOwnerFields, 'tenantId' | 'workspaceId'>,
): string {
  if (!owner.tenantId || !owner.workspaceId) {
    throw new Error('Enterprise report persistence requires tenantId and workspaceId');
  }
  return path.join(
    resolveEnterpriseDataRoot(),
    assertSafeReportSegment(owner.tenantId, 'tenant id'),
    assertSafeReportSegment(owner.workspaceId, 'workspace id'),
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

function isReportExpired(entry: Pick<ReportRecord, 'expiresAt'>, now = Date.now()): boolean {
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
  insertAnalysisRunIfMissing(db, {
    id: runId,
    tenantId,
    workspaceId,
    sessionId: entry.sessionId,
    mode: 'report',
    status: 'completed',
    question: '',
    startedAt: entry.generatedAt || now,
    completedAt: entry.generatedAt || now,
    privateContext: entry.privateContext,
  });

  return { traceId, runId };
}

/** Reports are write-once: a second write under an id is refused. */
export class ReportIdTakenError extends Error {
  constructor(reportId: string) {
    super(`report_id_taken:${reportId}`);
  }
}

function isPrimaryKeyConflict(error: unknown): boolean {
  return (error as {code?: unknown} | null)?.code === 'SQLITE_CONSTRAINT_PRIMARYKEY';
}

/**
 * Exclusive create: an existing file means the report id is already taken.
 * Returns the file's identity. The exclusive open makes the file this
 * writer's own, so a write that fails partway removes what it left rather
 * than leaving it to hold the id.
 */
function writeNewReportFile(reportId: string, filePath: string, content: string): bigint {
  let fd: number;
  try {
    fd = fs.openSync(filePath, 'wx');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new ReportIdTakenError(reportId);
    throw error;
  }
  let identity: bigint | undefined;
  try {
    try {
      identity = fs.fstatSync(fd, { bigint: true }).ino;
      fs.writeFileSync(fd, content, 'utf-8');
    } finally {
      fs.closeSync(fd);
    }
  } catch (error) {
    releaseQuietly(reportId, () => removeOwnFile(filePath, identity));
    throw error;
  }
  return identity;
}

/**
 * Removes a file only while it is still the one this writer created: a path
 * can be deleted and created again by another writer in the meantime.
 */
function removeOwnFile(filePath: string, identity: bigint | undefined): void {
  if (identity !== undefined && fs.statSync(filePath, { bigint: true, throwIfNoEntry: false })?.ino === identity) {
    fs.rmSync(filePath, { force: true });
  }
}

/**
 * Undo a partial write; a failed undo must not hide the failure that caused
 * it. The warning names the report, so leftovers can be traced and removed.
 */
function releaseQuietly(reportId: string, release: () => unknown): void {
  try {
    release();
  } catch (error) {
    console.warn(`[ReportRoutes] Failed to release a partial write of report ${reportId}:`, (error as Error).message);
  }
}

/**
 * The content a record authorizes. The file's bytes must hash to the record,
 * so a partial write, or an id deleted and re-created under a reader, is never
 * served. Records from before hashes were kept carry none; any value present
 * must match. Null when the file is missing or is not the record's own.
 */
function readContentOfRecord(filePath: string, recordedHash: unknown): string | null {
  let bytes: Buffer;
  try {
    bytes = fs.readFileSync(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  if (recordedHash !== undefined && recordedHash !== null && recordedHash !== reportContentHash(bytes)) {
    return null;
  }
  return bytes.toString('utf-8');
}

function removeDirIfEmpty(dir: string): void {
  try {
    fs.rmdirSync(dir);
  } catch { /* not empty, or already gone */ }
}

/** One write's own directory, then the report's directory once no write is left in it. */
function removeWriteDir(contentDir: string, reportDir: string): void {
  fs.rmSync(contentDir, { recursive: true, force: true });
  removeDirIfEmpty(reportDir);
}

/** Removes the row only while it still publishes the write whose content is at `localPath`. */
function unpublishReportRow(db: Database.Database, reportId: string, localPath: string): void {
  db.prepare('DELETE FROM report_artifacts WHERE id = ? AND local_path = ?').run(reportId, localPath);
}

/**
 * Removes the files an enterprise row points at: the directory of the write
 * that produced them, or only the known files when the row has another
 * layout. A directory is never removed on the strength of a path this module
 * did not lay out. Throws when the content cannot be removed.
 */
function removeEnterpriseReportFiles(row: ReportArtifactRow): void {
  const contentDir = path.dirname(row.local_path);
  let reportDir: string | undefined;
  try {
    reportDir = enterpriseReportDir(row.id, { tenantId: row.tenant_id, workspaceId: row.workspace_id });
  } catch { /* unsafe segments: not a layout this module created */ }
  if (reportDir !== undefined && path.dirname(contentDir) === reportDir) {
    removeWriteDir(contentDir, reportDir);
    return;
  }
  fs.rmSync(row.local_path, { force: true });
  // Reports written before per-write directories kept their files directly in the report directory.
  if (contentDir === reportDir) {
    fs.rmSync(path.join(contentDir, 'report.json'), { force: true });
    removeDirIfEmpty(contentDir);
  }
}

/**
 * Each write keeps its files in a directory of its own, and the row that
 * claims the id is inserted, with the rows it hangs from, only once they are
 * complete: a row is a published report, no two writes of an id share a path,
 * and the row's path identifies the write that owns it. Returns the withdrawal
 * of this write, for a later store's failure.
 */
function persistEnterpriseReport(reportId: string, entry: PersistedReport): () => void {
  const reportDir = enterpriseReportDir(reportId, entry);
  const contentDir = path.join(reportDir, crypto.randomUUID());
  const htmlPath = path.join(contentDir, 'report.html');
  const createdAt = entry.generatedAt || Date.now();
  const visibility = entry.visibility || 'private';
  const contentHash = reportContentHash(entry.html);
  const expiresAt = entry.expiresAt ?? null;

  withEnterpriseReportDb((db) => {
    try {
      fs.mkdirSync(contentDir, { recursive: true });
      fs.writeFileSync(path.join(contentDir, 'report.json'), JSON.stringify({
        reportId,
        generatedAt: createdAt,
        sessionId: entry.sessionId,
        runId: fallbackRunId(entry),
        traceId: fallbackTraceId(entry),
        tenantId: entry.tenantId,
        workspaceId: entry.workspaceId,
        userId: entry.userId,
        visibility,
        contentHash,
        expiresAt,
      }, null, 2));
      fs.writeFileSync(htmlPath, entry.html, 'utf-8');
      db.transaction(() => {
        const { runId } = ensureEnterpriseReportGraph(db, reportId, entry);
        db.prepare(`
          INSERT INTO report_artifacts
            (id, tenant_id, workspace_id, session_id, run_id, local_path, content_hash, visibility, created_by, created_at, expires_at, private_context)
          VALUES
            (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
          encodePrivateContextColumn(entry.privateContext),
        );
      }).immediate();
    } catch (error) {
      releaseQuietly(reportId, () => removeWriteDir(contentDir, reportDir));
      if (isPrimaryKeyConflict(error)) throw new ReportIdTakenError(reportId);
      throw error;
    }
  });
  return () => {
    // The write was reported failed, so it must not become readable in any phase. Either step
    // alone ensures that: without its row, or without its content. Each is attempted even when
    // the other fails.
    releaseQuietly(reportId, () => withEnterpriseReportDb((db) => unpublishReportRow(db, reportId, htmlPath)));
    releaseQuietly(reportId, () => removeWriteDir(contentDir, reportDir));
  };
}

/**
 * The metadata file, which carries the marker and the content hash, claims the
 * id first; the content file is written last. Returns the withdrawal of this
 * write, for a later store's failure.
 */
function persistLegacyReport(reportId: string, entry: PersistedReport): () => void {
  fs.mkdirSync(reportsDir(), { recursive: true });
  const metaPath = legacyReportMetaPath(reportId);
  const htmlPath = legacyReportHtmlPath(reportId);
  const metaIdentity = writeNewReportFile(reportId, metaPath, JSON.stringify({
    generatedAt: entry.generatedAt,
    sessionId: entry.sessionId,
    runId: entry.runId,
    traceId: entry.traceId,
    tenantId: entry.tenantId,
    workspaceId: entry.workspaceId,
    userId: entry.userId,
    visibility: entry.visibility,
    expiresAt: entry.expiresAt,
    privateContext: entry.privateContext,
    contentHash: reportContentHash(entry.html),
  }));
  let htmlIdentity: bigint;
  try {
    htmlIdentity = writeNewReportFile(reportId, htmlPath, entry.html);
  } catch (error) {
    releaseQuietly(reportId, () => removeOwnFile(metaPath, metaIdentity));
    throw error;
  }
  return () => {
    removeOwnFile(htmlPath, htmlIdentity);
    removeOwnFile(metaPath, metaIdentity);
  };
}

function readEnterpriseReportRow(db: Database.Database, reportId: string): ReportArtifactRow | undefined {
  return db.prepare<unknown[], ReportArtifactRow>(`
    SELECT *
    FROM report_artifacts
    WHERE id = ?
      AND (expires_at IS NULL OR expires_at > ?)
  `).get(reportId, Date.now());
}

function enterpriseReportRecord(row: ReportArtifactRow): ReportRecord {
  return {
    generatedAt: row.created_at,
    sessionId: row.session_id,
    runId: row.run_id,
    tenantId: row.tenant_id,
    workspaceId: row.workspace_id,
    ...(row.created_by ? { userId: row.created_by } : {}),
    visibility: row.visibility,
    expiresAt: row.expires_at,
    privateContext: decodePrivateContextColumn(row.private_context),
  };
}

function loadEnterpriseReport(reportId: string): PersistedReport | null {
  return withEnterpriseReportDb((db) => {
    const row = readEnterpriseReportRow(db, reportId);
    const html = row ? readContentOfRecord(row.local_path, row.content_hash) : null;
    return row && html !== null ? { ...enterpriseReportRecord(row), html: upgradeLegacyReportHtml(html) } : null;
  });
}

function loadEnterpriseReportRecord(reportId: string): ReportRecord | null {
  return withEnterpriseReportDb((db) => {
    const row = readEnterpriseReportRow(db, reportId);
    return row ? enterpriseReportRecord(row) : null;
  });
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
  return res.sendFile(assetPath, {dotfiles: 'allow'}, error => {
    if (!error || res.headersSent) return;
    res.status(404).type('text/plain').send('Mermaid report asset is unavailable');
  });
});

interface ReportStoreAccess {
  /** Writes the report; returns the withdrawal of this write, for a later store's failure. */
  persist(reportId: string, entry: PersistedReport): () => void;
  /**
   * Removes the report's content, then its record. Throws on failure, keeping the record so a
   * retry can finish; the content may already be gone.
   */
  remove(reportId: string): boolean;
  /** The report, when its content is the record's own and it has not expired. */
  load(reportId: string): PersistedReport | null;
  /** The record alone, without reading content. */
  loadRecord(reportId: string): ReportRecord | null;
}

const ENTERPRISE_REPORT_STORE: ReportStoreAccess = {
  persist: persistEnterpriseReport,
  remove: deleteEnterpriseReport,
  load: loadEnterpriseReport,
  loadRecord: loadEnterpriseReportRecord,
};

const LEGACY_REPORT_STORE: ReportStoreAccess = {
  persist: persistLegacyReport,
  remove: deleteLegacyReport,
  load: loadLegacyReport,
  loadRecord: loadLegacyReportRecord,
};

/** The store readers use; the migration phase decides it. */
function readAuthorityStore(): ReportStoreAccess {
  return enterpriseReportStoreEnabled() ? ENTERPRISE_REPORT_STORE : LEGACY_REPORT_STORE;
}

/**
 * Enabled report stores in commit order. Readers use only the read-authority
 * store, and it comes last: a write makes a report readable at one point, once
 * every other store holds it, and a deletion removes the other copies first,
 * so a failed deletion never leaves a copy that only a later phase would read.
 */
function reportStoresInCommitOrder(): ReportStoreAccess[] {
  const authority = readAuthorityStore();
  const enabled = [
    ...(enterpriseReportDbWritesEnabled() ? [ENTERPRISE_REPORT_STORE] : []),
    ...(legacyReportWritesEnabled() ? [LEGACY_REPORT_STORE] : []),
  ];
  return [...enabled.filter(store => store !== authority), ...enabled.filter(store => store === authority)];
}

/**
 * Retention is a policy of the report, not of one store: every store and the
 * cache record the same expiry. Only the enterprise database holds policies.
 */
function resolveReportExpiresAt(entry: PersistedReport): PersistedReport['expiresAt'] {
  if (!enterpriseReportDbWritesEnabled() || !entry.tenantId || !entry.workspaceId) return entry.expiresAt;
  const scope = {
    tenantId: entry.tenantId,
    workspaceId: entry.workspaceId,
    ...(entry.userId ? { userId: entry.userId } : {}),
  };
  return withEnterpriseReportDb((db) =>
    resolveEnterpriseRetentionExpiresAt(db, scope, 'report', entry.generatedAt || Date.now()));
}

/**
 * Save a generated report. Reports are write-once: an id is claimed exactly
 * once in every enabled store, so no reader can pair a report's content with
 * the audience of a different write. The report lands in every enabled store
 * or in none; a failure is thrown to the caller after the stores already
 * written are withdrawn.
 */
export function persistReport(reportId: string, entry: PersistedReport): void {
  const safeReportId = assertSafeReportSegment(reportId, 'report id');
  const report: PersistedReport = { ...entry, expiresAt: resolveReportExpiresAt(entry) };
  const withdrawals: Array<() => void> = [];
  try {
    for (const store of reportStoresInCommitOrder()) withdrawals.unshift(store.persist(safeReportId, report));
  } catch (error) {
    for (const withdraw of withdrawals) releaseQuietly(safeReportId, withdraw);
    throw error;
  }
  reportStore.set(safeReportId, report);
}

/** Load a report from disk if not in memory cache. */
function loadReportFromDisk(reportId: string): PersistedReport | null {
  if (!isSafeReportSegment(reportId)) return null;
  try {
    const report = readAuthorityStore().load(reportId);
    // Cache in memory for subsequent access
    if (report) reportStore.set(reportId, report);
    return report;
  } catch {
    return null;
  }
}

/**
 * The stored record alone. Deletion is authorized on the record, so a report
 * whose content cannot be served (a partial write left by a crash) can still
 * be removed by whoever may delete it.
 */
function loadReportRecordFromDisk(reportId: string): ReportRecord | null {
  if (!isSafeReportSegment(reportId)) return null;
  try {
    return readAuthorityStore().loadRecord(reportId);
  } catch {
    return null;
  }
}

interface LegacyReportRecord {
  record: ReportRecord;
  contentHash?: unknown;
  /** The metadata exists but cannot be read, so no content can be shown to be its own. */
  unreadable?: true;
}

/**
 * A legacy report's record and the content hash it claims; the content itself
 * is not read. Unreadable metadata (a crash during its write) still yields an
 * ownerless record, so the report remains deletable and ages out.
 */
function readLegacyReportRecord(reportId: string): LegacyReportRecord | null {
  const metaPath = legacyReportMetaPath(reportId);
  if (!fs.existsSync(metaPath)) {
    // Content saved before metadata files existed.
    return fs.existsSync(legacyReportHtmlPath(reportId))
      ? { record: { generatedAt: Date.now(), sessionId: '', privateContext: 'unknown' } }
      : null;
  }
  let meta;
  try {
    meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
  } catch {
    return {
      record: { generatedAt: fs.statSync(metaPath).mtimeMs, sessionId: '', privateContext: 'unknown' },
      unreadable: true,
    };
  }
  return {
    record: {
      generatedAt: meta.generatedAt || Date.now(),
      sessionId: meta.sessionId || '',
      ...(meta.runId ? { runId: meta.runId } : {}),
      ...(meta.traceId ? { traceId: meta.traceId } : {}),
      ...(meta.visibility ? { visibility: meta.visibility } : {}),
      ...(typeof meta.expiresAt === 'number' ? { expiresAt: meta.expiresAt } : {}),
      tenantId: meta.tenantId,
      workspaceId: meta.workspaceId,
      userId: meta.userId,
      ownerUserId: meta.ownerUserId,
      privateContext: decodePrivateContextJson(meta.privateContext),
    },
    contentHash: meta.contentHash,
  };
}

function loadLegacyReport(reportId: string): PersistedReport | null {
  const stored = readLegacyReportRecord(reportId);
  if (!stored || stored.unreadable || isReportExpired(stored.record)) return null;
  const html = readContentOfRecord(legacyReportHtmlPath(reportId), stored.contentHash);
  return html === null ? null : { ...stored.record, html: upgradeLegacyReportHtml(html) };
}

function loadLegacyReportRecord(reportId: string): ReportRecord | null {
  const stored = readLegacyReportRecord(reportId);
  return stored && !isReportExpired(stored.record) ? stored.record : null;
}

/** Content first and the claiming metadata last: a failure leaves the record to retry from. */
function deleteLegacyReport(reportId: string): boolean {
  if (!isSafeReportSegment(reportId)) return false;
  const htmlPath = legacyReportHtmlPath(reportId);
  const metaPath = legacyReportMetaPath(reportId);
  const existed = fs.existsSync(htmlPath) || fs.existsSync(metaPath);
  fs.rmSync(htmlPath, { force: true });
  fs.rmSync(metaPath, { force: true });
  return existed;
}

/** Content first and the row last: a failure leaves the record to retry from. */
function deleteEnterpriseReport(reportId: string): boolean {
  if (!isSafeReportSegment(reportId)) return false;
  return withEnterpriseReportDb((db) => {
    const row = db.prepare<unknown[], ReportArtifactRow>(
      'SELECT * FROM report_artifacts WHERE id = ?',
    ).get(reportId);
    if (!row) return false;
    removeEnterpriseReportFiles(row);
    unpublishReportRow(db, reportId, row.local_path);
    return true;
  });
}

/** Throws when a store cannot remove the report's content; the read-authority copy goes last. */
function deletePersistedReport(reportId: string): boolean {
  let deleted = false;
  for (const store of reportStoresInCommitOrder()) {
    deleted = store.remove(reportId) || deleted;
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
      const dir = reportsDir();
      const files = fs.readdirSync(dir);
      for (const file of files) {
        if (!file.endsWith('.meta.json')) continue;
        const reportId = file.replace('.meta.json', '');
        try {
          const stored = readLegacyReportRecord(reportId);
          if (stored && now - stored.record.generatedAt > maxAge) deleteLegacyReport(reportId);
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
    const report = reportStore.get(reportId) || loadReportRecordFromDisk(reportId);
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
