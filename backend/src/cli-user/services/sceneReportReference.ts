// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)

import * as fs from 'fs';
import * as path from 'path';
import {z} from 'zod';
import type {AnalysisResult} from '../../agent/core/orchestratorTypes';
import {analysisDeliveryFingerprint} from '../../types/analysisDelivery';
import {localize, type OutputLanguage} from '../../agentv3/outputLanguage';
import type {SessionPaths} from '../io/paths';

export type CliSceneReportReference = NonNullable<AnalysisResult['sceneReport']>;
const id = z.string().min(1).max(256);
const fingerprint = z.string().regex(/^[a-f0-9]{64}$/);
const integer = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const referenceSchema = z.object({schemaVersion: z.literal('scene_report_ref@1'),
  reportId: z.string().regex(/^[A-Za-z0-9_-]{1,256}$/), traceId: id, sessionId: id, runId: id,
  revision: integer, expiresAt: integer.min(1), manifestSha256: fingerprint}).strict();
const reasons = ['scene_report_missing', 'scene_reference_mismatched', 'scene_reference_invalid',
  'scene_reference_missing', 'scene_report_expired'] as const;
const bundleSchema = z.object({schemaVersion: z.literal('cli_scene_report@1'),
  binding: z.object({sessionId: id, traceId: id, turn: integer.min(1), runId: id.nullable(), revision: integer.nullable(),
    conclusionFingerprint: fingerprint, turnMarkdownFingerprint: fingerprint}).strict(),
  status: z.enum(['available', 'none', 'unavailable']), reference: referenceSchema.nullable(),
  referenceFingerprint: fingerprint.nullable(), unavailableReason: z.enum(reasons).optional()}).strict();
export type CliSceneReportBundle = z.infer<typeof bundleSchema>;
export type LoadedCliSceneReport = {status: 'none'} | {status: 'available'; reference: CliSceneReportReference} |
  {status: 'unavailable'; reason: typeof reasons[number]; reference?: CliSceneReportReference};
export interface CliSceneReportMetadata {
  sceneReport?: CliSceneReportReference;
  sceneReportStatus?: 'partial' | 'unavailable';
  sceneReportUnavailableReason?: typeof reasons[number];
}
export function latestCliSceneReportPath(sp: SessionPaths): string {return path.join(sp.dir, 'scene-report.json');}
export function turnCliSceneReportPath(sp: SessionPaths, turn: number): string {
  if (!Number.isSafeInteger(turn) || turn < 1) throw new Error('invalid_cli_scene_turn');
  return path.join(sp.turnsDir, `${String(turn).padStart(3, '0')}.scene-report.json`);
}

/** A historical locator only. No timeline/evidence payload enters the model transcript. */
export function buildCliSceneReportBundle(input: {sessionId: string; turn: number; traceId: string;
  conclusion: string; turnMarkdown: string; result: AnalysisResult}): CliSceneReportBundle {
  const {sceneReport, sceneTimeline, completion} = input.result;
  const binding: CliSceneReportBundle['binding'] = {sessionId: input.sessionId, traceId: input.traceId, turn: input.turn, runId: null, revision: null,
    conclusionFingerprint: analysisDeliveryFingerprint(input.conclusion), turnMarkdownFingerprint: analysisDeliveryFingerprint(input.turnMarkdown)};
  const base = {schemaVersion: 'cli_scene_report@1' as const, binding, reference: null, referenceFingerprint: null};
  if (sceneReport === undefined && sceneTimeline === undefined) return {...base, status: 'none'};
  if (!sceneReport) return {...base, status: 'unavailable', unavailableReason: 'scene_report_missing'};
  const parsed = referenceSchema.safeParse(sceneReport);
  if (!parsed.success) return {...base, status: 'unavailable', unavailableReason: 'scene_reference_invalid'};
  const reference = parsed.data;
  if (!sceneTimeline || sceneTimeline.status !== 'partial' || input.result.sessionId !== input.sessionId ||
      reference.sessionId !== input.sessionId || reference.traceId !== input.traceId ||
      reference.sessionId !== sceneTimeline.sessionId || reference.traceId !== sceneTimeline.traceId ||
      reference.runId !== sceneTimeline.runId || reference.revision !== sceneTimeline.revision ||
      (completion !== undefined && (completion.runId !== reference.runId || completion.conclusionFingerprint !== binding.conclusionFingerprint))) {
    return {...base, status: 'unavailable', unavailableReason: 'scene_reference_mismatched'};
  }
  return {...base, status: 'available', binding: {...binding, runId: reference.runId, revision: reference.revision},
    reference, referenceFingerprint: analysisDeliveryFingerprint(reference)};
}
export function loadedCliSceneReport(bundle: CliSceneReportBundle, now = Date.now()): LoadedCliSceneReport {
  if (bundle.status === 'none') return {status: 'none'};
  if (bundle.status === 'unavailable') return {status: 'unavailable', reason: bundle.unavailableReason || 'scene_reference_invalid'};
  if (!bundle.reference) return {status: 'unavailable', reason: 'scene_reference_invalid'};
  return bundle.reference.expiresAt <= now
    ? {status: 'unavailable', reason: 'scene_report_expired', reference: bundle.reference}
    : {status: 'available', reference: bundle.reference};
}
export function cliSceneReportMetadata(loaded: LoadedCliSceneReport): CliSceneReportMetadata {
  if (loaded.status === 'none') return {};
  return {...(loaded.reference ? {sceneReport: loaded.reference} : {}),
    sceneReportStatus: loaded.status === 'available' ? 'partial' : 'unavailable',
    ...(loaded.status === 'unavailable' ? {sceneReportUnavailableReason: loaded.reason} : {})};
}
export function sceneReportDetailsApiPath(reference: CliSceneReportReference): string {
  return `/api/agent/v1/scene-reconstruct/report/${encodeURIComponent(reference.reportId)}`;
}
export function renderCliSceneReport(loaded: LoadedCliSceneReport, language: OutputLanguage): string {
  if (loaded.status === 'none') return '';
  if (loaded.status === 'unavailable') return localize(language,
    loaded.reason === 'scene_report_expired' ? '场景报告不可用：历史引用已过期。' : '场景报告不可用：历史引用缺失、损坏或与本轮结果不匹配。',
    loaded.reason === 'scene_report_expired' ? 'Scene report unavailable: the historical reference has expired.' :
      'Scene report unavailable: the historical reference is missing, invalid, or does not match this turn.');
  return localize(language, `场景还原：部分结果；报告 ${loaded.reference.reportId}。\n详情需后端授权：${sceneReportDetailsApiPath(loaded.reference)}`,
    `Scene reconstruction: partial result; report ${loaded.reference.reportId}.\nDetails require backend authorization: ${sceneReportDetailsApiPath(loaded.reference)}`);
}

interface LoadSceneReportInput {sp: SessionPaths; sessionId: string; traceId?: string; turn: number; turnMarkdown: string; conclusion?: string; latest?: boolean}
function readBundle(input: LoadSceneReportInput): CliSceneReportBundle | undefined {
  const location = input.latest ? latestCliSceneReportPath(input.sp) : turnCliSceneReportPath(input.sp, input.turn);
  try {
    const stat = fs.lstatSync(location);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 65_536) return undefined;
    const parsed = bundleSchema.safeParse(JSON.parse(fs.readFileSync(location, 'utf8')));
    if (!parsed.success) return undefined;
    const bundle = parsed.data, {binding, reference} = bundle;
    if (binding.sessionId !== input.sessionId || binding.turn !== input.turn ||
        (input.traceId !== undefined && input.traceId !== binding.traceId) ||
        binding.turnMarkdownFingerprint !== analysisDeliveryFingerprint(input.turnMarkdown) ||
        (input.conclusion !== undefined && binding.conclusionFingerprint !== analysisDeliveryFingerprint(input.conclusion))) return undefined;
    if (bundle.status === 'available') {
      if (!reference || binding.runId !== reference.runId || binding.revision !== reference.revision ||
          reference.sessionId !== binding.sessionId || reference.traceId !== binding.traceId ||
          bundle.referenceFingerprint !== analysisDeliveryFingerprint(reference) || bundle.unavailableReason) return undefined;
    } else if (reference !== null || bundle.referenceFingerprint !== null || binding.runId !== null || binding.revision !== null ||
        (bundle.status === 'none' ? bundle.unavailableReason !== undefined : bundle.unavailableReason === undefined)) return undefined;
    return bundle;
  } catch {return undefined;}
}
export function loadCliSceneReport(input: LoadSceneReportInput): LoadedCliSceneReport {
  if (!Number.isSafeInteger(input.turn) || input.turn < 1) return {status: 'none'};
  const location = input.latest ? latestCliSceneReportPath(input.sp) : turnCliSceneReportPath(input.sp, input.turn);
  if (!fs.existsSync(location)) {
    return input.latest && fs.existsSync(turnCliSceneReportPath(input.sp, input.turn))
      ? {status: 'unavailable', reason: 'scene_reference_missing'} : {status: 'none'};
  }
  const bundle = readBundle(input);
  if (bundle && input.latest) {
    const perTurn = readBundle({...input, latest: false});
    if (!perTurn || analysisDeliveryFingerprint(bundle) !== analysisDeliveryFingerprint(perTurn)) {
      return {status: 'unavailable', reason: 'scene_reference_mismatched'};
    }
  }
  return bundle ? loadedCliSceneReport(bundle) : {status: 'unavailable', reason: 'scene_reference_mismatched'};
}
