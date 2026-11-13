// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import { describe, it, expect, jest } from '@jest/globals';
import Database from 'better-sqlite3';
import fs from 'fs';
import yaml from 'js-yaml';
import path from 'path';
import { generateRenderingPipelineDetectionSkill } from '../services/renderingPipelineDetectionSkillGenerator';
import { pipelineSkillLoader, renderingTypeSource } from '../services/pipelineSkillLoader';
import {
  buildPortableRenderingPipelineDetectionSkill,
  serializePortableRenderingPipelineDetectionSkill,
} from '../scripts/materializeRenderingPipelineDetectionSkill';

describe('rendering_pipeline_detection generator', () => {
  it('generates determine_pipeline SQL from pipeline YAML detection config', async () => {
    const skill = await generateRenderingPipelineDetectionSkill();

    expect(skill.name).toBe('rendering_pipeline_detection');
    expect(skill.type).toBe('composite');
    expect(skill.prerequisites?.modules).toEqual([
      'slices.with_context',
      'android.frames.timeline',
    ]);

    const scoreStep = skill.steps?.find((s) => s.id === 'score_pipelines') as any;
    expect(scoreStep).toBeTruthy();
    expect(typeof scoreStep.sql).toBe('string');
    expect(scoreStep.save_as).toBe('pipeline_scores');

    const determineStep = skill.steps?.find((s) => s.id === 'determine_pipeline') as any;
    expect(determineStep).toBeTruthy();
    expect(typeof determineStep.sql).toBe('string');
    expect(skill.steps?.findIndex((s) => s.id === 'score_pipelines')).toBeLessThan(
      skill.steps?.findIndex((s) => s.id === 'determine_pipeline') ?? -1
    );
    expect(determineStep.save_as).toBe('pipeline_result');

    // A representative signal name from pipeline YAML that must appear in generated SQL.
    // This ensures YAML detection is the single source of truth for scoring configuration.
    expect(scoreStep.sql).toContain('has_blast_buffer_queue');
    expect(scoreStep.sql).toContain('ANDROID_VIEW_STANDARD_BLAST');
    expect(scoreStep.sql).toContain('signal_defs');
    expect(scoreStep.sql).not.toContain('COALESCE((SELECT SUM(');
    expect(Buffer.byteLength(scoreStep.sql, 'utf8')).toBeLessThan(45_000);
    expect(Buffer.byteLength(determineStep.sql, 'utf8')).toBeLessThan(10_000);
    expect(determineStep.sql).toContain('SELECT * FROM ${pipeline_scores}');
    expect(determineStep.sql).toContain('candidate_list AS');
    expect(determineStep.sql).toContain("GROUP BY 'all_candidates'");
    expect(determineStep.sql).toContain('SELECT pipeline_id, rendering_type_id, score, rank');
    expect(determineStep.sql).toContain('ORDER BY rank ASC');

    // Non-primary / feature-only pipelines should not win primary selection.
    // Keep these checks stable to prevent regressions where a backend/impl-detail pipeline
    // becomes the primary pipeline by accident.
    expect(determineStep.sql).toContain('ANDROID_PIP_FREEFORM');
    expect(determineStep.sql).toContain('ANDROID_VIEW_MULTI_WINDOW');
    expect(determineStep.sql).toContain('ANGLE_GLES_VULKAN');

    const activeStep = skill.steps?.find((s) => s.id === 'active_rendering_processes') as any;
    expect(activeStep).toBeTruthy();
    expect(typeof activeStep.sql).toBe('string');

    // Active process detection should work across HWUI/SurfaceView/OpenGL/Vulkan/Flutter.
    expect(activeStep.sql).toContain('DrawFrame');
    expect(activeStep.sql).toContain('eglSwapBuffers');
    expect(activeStep.sql).toContain('vkQueuePresentKHR');

    const rhythmStep = skill.steps?.find((s) => s.id === 'extra_rhythm_signals') as any;
    expect(rhythmStep).toBeTruthy();
    expect(rhythmStep.sql).toContain("THEN 'camera_request_activity'");
    expect(rhythmStep.sql).not.toContain('camera_sensor_trigger');

    const layerSignalsStep = skill.steps?.find((s) => s.id === 'layer_signals') as any;
    expect(layerSignalsStep).toBeTruthy();
    expect(layerSignalsStep.sql).toContain('android_frames_layers');

    const pipelineBundleStep = skill.steps?.find((s) => s.id === 'pipeline_bundle') as any;
    expect(pipelineBundleStep).toBeTruthy();
    expect(pipelineBundleStep.type).toBe('pipeline');
    expect(pipelineBundleStep.pipeline_source).toBe('pipeline_result');
    expect(pipelineBundleStep.active_processes_source).toBe('active_rendering_processes');
  });

  it('derives type ranking, feature roles, scopes, and defaults from the catalog', async () => {
    const skill = await generateRenderingPipelineDetectionSkill();
    const scoreStep = skill.steps?.find((step) => step.id === 'score_pipelines') as any;
    const determineStep = skill.steps?.find((step) => step.id === 'determine_pipeline') as any;
    const catalog = pipelineSkillLoader.getCatalog();

    expect(determineStep.sql).toContain('pipeline_metadata');
    expect(determineStep.sql).toContain('primary_rendering_type_id');
    expect(determineStep.sql).toContain('rendering_type_candidates_list');
    expect(determineStep.sql).toContain('pipeline_related_rendering_types');
    expect(determineStep.sql).toContain('related_rendering_type_candidates_list');
    expect(determineStep.sql).toContain(
      "('ANDROID_VIEW_MULTI_WINDOW', 'S06_MULTI_WINDOW')",
    );
    expect(determineStep.sql).toContain(
      "('VIDEO_OVERLAY_HWC', 'S12_VIDEO_OVERLAY_HWC')",
    );
    expect(determineStep.sql).toContain('S10_FLUTTER');
    expect(determineStep.sql).toContain('FLUTTER_SURFACEVIEW_IMPELLER');

    for (const [pipelineId, entry] of Object.entries(catalog.pipelines)) {
      expect(determineStep.sql).toContain(pipelineId);
      expect(determineStep.sql).toContain(renderingTypeSource(entry.teaching_type_id));
      if (entry.classification_role === 'feature') {
        expect(entry.primary_eligible).toBe(false);
        expect(entry.feature_visible).toBe(true);
      }
      if (entry.signal_scope === 'global') {
        expect(scoreStep.sql).toContain(`'${pipelineId}'`);
      }
    }

    const source = fs.readFileSync(
      path.resolve(__dirname, '../services/renderingPipelineDetectionSkillGenerator.ts'),
      'utf8',
    );
    expect(source).not.toMatch(/NON_PRIMARY_PIPELINE_IDS|GLOBAL_SCOPE_PIPELINE_IDS|FEATURE_PIPELINE_IDS/);
    expect(source).not.toContain(['S01 §4', '特征分型'].join(' '));
  });

  it('keeps the committed portable detector byte-identical to the runtime projection', async () => {
    const portable = await buildPortableRenderingPipelineDetectionSkill();
    const serialized = serializePortableRenderingPipelineDetectionSkill(portable);
    const committed = fs.readFileSync(
      path.resolve(__dirname, '../../skills/atomic/rendering_pipeline_detection.skill.yaml'),
      'utf8',
    );

    expect(portable.steps?.some((step) => step.id === 'pipeline_bundle')).toBe(false);
    expect(portable.steps?.some((step) => step.id === 'determine_pipeline')).toBe(true);
    expect(serialized).not.toMatch(/[ \t]+$/m);
    expect(serialized).toBe(committed);
  });

  it('requires Flutter UI and SurfaceTexture identities before TextureView signals can score Flutter', async () => {
    const skill = await generateRenderingPipelineDetectionSkill();
    const scoreStep = skill.steps?.find((step) => step.id === 'score_pipelines') as any;
    const scoreSql = String(scoreStep.sql).split('${package}').join('com.example.texture');
    const db = new Database(':memory:');
    const getFlutterTextureScore = () => (db.prepare(scoreSql).all() as Array<{
      pipeline_id: string;
      required_ok: number;
      score: number;
    }>).find((row) => row.pipeline_id === 'FLUTTER_TEXTUREVIEW');

    try {
      db.exec(`
        CREATE TABLE process(upid INTEGER PRIMARY KEY, name TEXT);
        CREATE TABLE thread(utid INTEGER PRIMARY KEY, upid INTEGER, name TEXT);
        CREATE TABLE thread_track(id INTEGER PRIMARY KEY, utid INTEGER);
        CREATE TABLE slice(track_id INTEGER, ts INTEGER, dur INTEGER, name TEXT);

        INSERT INTO process VALUES (1, 'com.example.texture');
        INSERT INTO thread VALUES
          (10, 1, 'RenderThread'),
          (11, 1, 'main');
        INSERT INTO thread_track VALUES
          (100, 10),
          (101, 11);
        INSERT INTO slice VALUES
          (100, 100, 10, 'DrawFrame 1'),
          (100, 200, 10, 'DrawFrame 2'),
          (100, 300, 10, 'DrawFrame 3'),
          (100, 400, 10, 'DrawFrame 4'),
          (100, 500, 10, 'DrawFrame 5'),
          (100, 600, 10, 'DrawFrame 6'),
          (100, 700, 10, 'SurfaceTexture::updateTexImage'),
          (101, 800, 10, 'onFrameAvailable');
      `);

      expect(getFlutterTextureScore())
        .toMatchObject({required_ok: 0, score: 0});

      db.exec(`INSERT INTO thread VALUES (12, 1, '1.ui')`);
      const flutter = getFlutterTextureScore();
      expect(flutter?.required_ok).toBe(1);
      expect(flutter?.score).toBeGreaterThan(0);

      db.exec(`
        UPDATE slice
        SET name = 'updateTexImage'
        WHERE name = 'SurfaceTexture::updateTexImage'
      `);
      expect(getFlutterTextureScore())
        .toMatchObject({required_ok: 0, score: 0});
    } finally {
      db.close();
    }
  });

  it('does not call a generic Gecko compositor Chromium without Chromium identity', () => {
    const webviewSkill = yaml.load(
      fs.readFileSync(
        path.resolve(__dirname, '../../skills/composite/webview_drawfunctor_jank_chain.skill.yaml'),
        'utf8',
      ),
    ) as any;
    const summaryStep = webviewSkill.steps?.find(
      (step: any) => step.id === 'drawfunctor_signal_summary',
    );
    const overlapStep = webviewSkill.steps?.find(
      (step: any) => step.id === 'drawfunctor_frame_overlap',
    );
    expect(summaryStep).toBeDefined();
    expect(overlapStep).toBeDefined();

    const beginMarker = '-- WEBVIEW_CHROMIUM_SCOPE_CTES_BEGIN';
    const endMarker = '-- WEBVIEW_CHROMIUM_SCOPE_CTES_END';
    const extractIdentityCtes = (sql: string) => {
      const start = sql.indexOf(beginMarker);
      const end = sql.indexOf(endMarker, start);
      expect(start).toBeGreaterThanOrEqual(0);
      expect(end).toBeGreaterThan(start);
      return sql.slice(start + beginMarker.length, end).trim().replace(/,\s*$/, '');
    };

    const summaryCtes = extractIdentityCtes(String(summaryStep.sql));
    extractIdentityCtes(String(overlapStep.sql));
    expect(String(summaryStep.sql)).not.toContain(`),\n      ${endMarker}\n      SELECT`);

    const db = new Database(':memory:');
    try {
      db.exec(`
        CREATE TABLE process(upid INTEGER PRIMARY KEY, name TEXT);
        CREATE TABLE thread(utid INTEGER PRIMARY KEY, upid INTEGER, name TEXT);
        CREATE TABLE thread_track(id INTEGER PRIMARY KEY, utid INTEGER);
        CREATE TABLE slice(
          id INTEGER PRIMARY KEY,
          track_id INTEGER,
          ts INTEGER,
          dur INTEGER,
          name TEXT
        );

        INSERT INTO process VALUES
          (1, 'com.example.engine'),
          (2, 'com.example.engine:gpu'),
          (4, 'com.android.webview:sandboxed_process0');
        INSERT INTO thread VALUES
          (10, 1, 'Gecko'),
          (20, 2, 'Compositor'),
          (40, 4, 'CrRendererMain');
        INSERT INTO thread_track VALUES
          (100, 10),
          (200, 20),
          (400, 40);
        INSERT INTO slice VALUES
          (1, 100, 100, 10, 'GeckoMain'),
          (2, 200, 110, 20, 'Contending for pthread mutex'),
          (4, 400, 120, 40, 'Blink::UnrelatedFrame');
      `);

      const query = `
        WITH
        input AS (
          SELECT 'com.example.engine' AS target_process, 0 AS start_ts, 1000 AS end_ts
        ),
        ${summaryCtes}
        SELECT phase, process_name, thread_name
        FROM webview_slices
        ORDER BY process_name, thread_name
      `;
      expect(db.prepare(query).all()).toEqual([]);

      db.exec(`
        INSERT INTO process VALUES (3, 'com.example.engine:renderer');
        INSERT INTO thread VALUES (30, 3, 'CrRendererMain');
        INSERT INTO thread_track VALUES (300, 30);
        INSERT INTO slice VALUES (3, 300, 120, 30, 'Blink::BeginMainFrame');
      `);
      expect(db.prepare(query).all()).toEqual([
        {
          phase: 'chromium_compositor',
          process_name: 'com.example.engine:gpu',
          thread_name: 'Compositor',
        },
        {
          phase: 'chromium_render_main',
          process_name: 'com.example.engine:renderer',
          thread_name: 'CrRendererMain',
        },
      ]);
    } finally {
      db.close();
    }
  });
});

describe('article-verified rendering event variants', () => {
  const createFixture = () => {
    const db = new Database(':memory:');
    db.exec(`
      CREATE TABLE process(upid INTEGER PRIMARY KEY, name TEXT);
      CREATE TABLE thread(utid INTEGER PRIMARY KEY, upid INTEGER, name TEXT);
      CREATE TABLE thread_track(id INTEGER PRIMARY KEY, utid INTEGER);
      CREATE TABLE slice(id INTEGER PRIMARY KEY, track_id INTEGER, ts INTEGER, dur INTEGER, name TEXT);
      INSERT INTO process VALUES (1, 'com.example.render');
      INSERT INTO thread VALUES (10, 1, 'RenderThread');
      INSERT INTO thread_track VALUES (100, 10);
    `);
    return db;
  };

  const loadSql = (file: string, stepId: string): string => {
    const skill = yaml.load(fs.readFileSync(path.resolve(__dirname, '../../skills', file), 'utf8')) as {
      steps: Array<{id: string; sql: string}>;
    };
    const step = skill.steps.find((candidate) => candidate.id === stepId);
    expect(step).toBeDefined();
    return step!.sql;
  };

  const extractCtes = (sql: string, begin: string, end: string): string => {
    const start = sql.indexOf(begin);
    const finish = sql.indexOf(end, start);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(finish).toBeGreaterThan(start);
    return sql.slice(start + begin.length, finish).trim().replace(/,\s*$/, '');
  };

  const scoreSql = async (): Promise<string> => {
    const skill = await generateRenderingPipelineDetectionSkill();
    const step = skill.steps?.find((candidate) => candidate.id === 'score_pipelines') as {sql: string};
    return step.sql.split('${package}').join('com.example.render');
  };

  it('scores legacy and current WebView draw names without counting sync/init/reparent as draw evidence', async () => {
    const sql = await scoreSql();
    const db = createFixture();
    const drawSignals = () => db.prepare(sql.replace('SELECT * FROM scores', `
      SELECT signal_name, cnt FROM signal_counts
      WHERE pipeline_id = 'WEBVIEW_GL_FUNCTOR' AND signal_type = 's'
        AND signal_name = 'has_draw_gl'
        AND cnt > 0
    `)).all();
    const webviewScore = () => (db.prepare(sql).all() as Array<{
      pipeline_id: string; required_ok: number; excluded: number;
      total_weight: number; matched_weight: number; score: number;
    }>).find((candidate) => candidate.pipeline_id === 'WEBVIEW_GL_FUNCTOR');
    try {
      let versionScore: ReturnType<typeof webviewScore>;
      for (const name of ['DrawGL', 'DrawFn_DrawGL', 'DrawFn_DrawVk', 'DrawFunctor', 'AwDrawFnImpl::DrawVk', 'WebViewFunctor::drawGl', 'WebViewFunctor::drawVk']) {
        db.prepare('INSERT INTO slice VALUES (1, 100, 100, 10, ?)').run(name);
        expect(drawSignals()).toEqual([{signal_name: 'has_draw_gl', cnt: 1}]);
        const currentScore = webviewScore();
        expect(currentScore).toMatchObject({required_ok: 1, total_weight: 60, matched_weight: 35});
        expect(currentScore?.score).toBeGreaterThanOrEqual(0.3);
        if (versionScore) expect(currentScore).toEqual(versionScore);
        versionScore = currentScore;
        db.exec('DELETE FROM slice');
      }
      db.exec(`INSERT INTO thread VALUES (12, 1, 'CrRendererMain')`);
      for (const name of ['DrawFn_OnSync', 'DrawFn_PostDrawVk', 'DrawFn_PostDrawGL', 'WebViewFunctor::sync', 'WebViewFunctor::postDrawVk', 'WebViewFunctor::initVk', 'WebViewFunctor::reparentSurfaceControl']) {
        db.prepare('INSERT INTO slice VALUES (1, 100, 100, 10, ?)').run(name);
        expect(drawSignals()).toEqual([]);
        expect(webviewScore()).toMatchObject({required_ok: 0, score: 0});
        db.exec('DELETE FROM slice');
      }
      db.exec(`
        INSERT INTO thread VALUES (11, 1, 'VizCompositorThread');
        INSERT INTO slice VALUES (1, 100, 100, 10, 'WebViewFunctor::drawVk');
      `);
      const row = (db.prepare(sql).all() as Array<{pipeline_id: string; excluded: number; score: number}>)
        .find((candidate) => candidate.pipeline_id === 'WEBVIEW_GL_FUNCTOR');
      expect(row?.excluded).toBe(0);
      expect(row?.score).toBeGreaterThan(0);
    } finally {
      db.close();
    }
  });

  it('counts each recorded slice name once across overlapping aliases for required/scoring/exclude rules', async () => {
    await scoreSql();
    const pipeline = structuredClone(pipelineSkillLoader.getPipeline('WEBVIEW_GL_FUNCTOR')!);
    pipeline.detection = {
      required_signals: [{slice_patterns: ['Draw*', '*GL'], min_count: 2}],
      scoring_signals: [{signal: 'draw_alias', slice_patterns: ['Draw*', '*GL'], weight: 25, min_count: 2}],
      exclude_if: [{slice_patterns: ['On*', '*Sync']}],
    };
    const readPipelines = jest.spyOn(pipelineSkillLoader, 'getAllPipelines').mockReturnValue([pipeline]);
    const db = createFixture();
    try {
      const sql = await scoreSql();
      const score = () => (db.prepare(sql).all() as Array<Record<string, unknown>>)[0];
      const counts = () => db.prepare(sql.replace('SELECT * FROM scores', `
        SELECT signal_type, cnt FROM signal_counts ORDER BY signal_type
      `)).all();
      db.exec(`INSERT INTO slice VALUES (1, 100, 100, 10, 'DrawGL')`);
      expect(counts()).toEqual([
        {signal_type: 'e', cnt: 0}, {signal_type: 'r', cnt: 1}, {signal_type: 's', cnt: 1},
      ]);
      expect(score()).toMatchObject({required_ok: 0, total_weight: 25, matched_weight: 0, score: 0});

      // Both actual names have count 1; their distinct counts must still add up.
      db.exec(`INSERT INTO slice VALUES (2, 100, 120, 10, 'DrawVk')`);
      expect(counts()).toEqual([
        {signal_type: 'e', cnt: 0}, {signal_type: 'r', cnt: 2}, {signal_type: 's', cnt: 2},
      ]);
      expect(score()).toMatchObject({required_ok: 1, total_weight: 25, matched_weight: 25, score: 1});
      const aliasScore = score();

      pipeline.detection = {
        required_signals: [{slice_pattern: 'Draw*', min_count: 2}],
        scoring_signals: [{signal: 'draw_alias', slice_pattern: 'Draw*', weight: 25, min_count: 2}],
        exclude_if: [{slice_patterns: ['On*', '*Sync']}],
      };
      const singlePatternSql = await scoreSql();
      expect((db.prepare(singlePatternSql).all() as Array<Record<string, unknown>>)[0]).toEqual(aliasScore);

      db.exec(`INSERT INTO slice VALUES (3, 100, 140, 10, 'OnSync')`);
      expect(counts()).toEqual([
        {signal_type: 'e', cnt: 1}, {signal_type: 'r', cnt: 2}, {signal_type: 's', cnt: 2},
      ]);
      expect(score()).toMatchObject({excluded: 1, score: 0});
    } finally {
      readPipelines.mockRestore();
      db.close();
    }
  });

  it('keeps WebView functor phases distinct and removes nested draw-wrapper duration duplication', () => {
    const db = createFixture();
    try {
      db.exec(`
        INSERT INTO slice VALUES
          (1, 100, 100, 40, 'DrawFunctor'),
          (2, 100, 105, 25, 'DrawFn_DrawVk'),
          (3, 100, 150, 10, 'DrawFn_OnSync'),
          (4, 100, 170, 10, 'DrawFn_PostDrawVk'),
          (5, 100, 200, 30, 'WebViewFunctor::drawVk'),
          (6, 100, 240, 10, 'WebViewFunctor::sync'),
          (7, 100, 260, 10, 'WebViewFunctor::postDrawVk'),
          (8, 100, 280, 10, 'WebViewFunctor::initVk'),
          (9, 100, 300, 10, 'WebViewFunctor::reparentSurfaceControl'),
          (10, 100, 330, 10, 'WebViewFunctor::drawGl');
      `);
      for (const stepId of ['drawfunctor_signal_summary', 'drawfunctor_frame_overlap']) {
        const sql = loadSql('composite/webview_drawfunctor_jank_chain.skill.yaml', stepId);
        const ctes = extractCtes(sql, '-- WEBVIEW_CHROMIUM_SCOPE_CTES_BEGIN', '-- WEBVIEW_CHROMIUM_SCOPE_CTES_END');
        const rows = db.prepare(`
          WITH input AS (SELECT 'com.example.render' AS target_process, 0 AS start_ts, 1000 AS end_ts),
          ${ctes}
          SELECT phase, COUNT(*) AS calls, SUM(dur) AS total_dur
          FROM webview_slices GROUP BY phase ORDER BY phase
        `).all();
        expect(rows).toEqual([
          {phase: 'host_renderthread_functor', calls: 3, total_dur: 80},
          {phase: 'host_renderthread_functor_post_draw', calls: 2, total_dur: 20},
          {phase: 'host_renderthread_functor_sync', calls: 2, total_dur: 20},
        ]);
      }
    } finally {
      db.close();
    }
  });

  it('requires Fabric or a legacy shadow queue rather than assigning an RN architecture from JS thread names', async () => {
    const sql = await scoreSql();
    const db = createFixture();
    const score = (id: string) => (db.prepare(sql).all() as Array<{
      pipeline_id: string; required_ok: number; excluded: number; score: number;
    }>).find((candidate) => candidate.pipeline_id === id);
    try {
      for (const [js, native] of [['mqt_js', 'mqt_native_modules'], ['mqt_v_js', 'mqt_v_native']]) {
        db.prepare('INSERT INTO thread VALUES (11, 1, ?)').run(js);
        db.prepare('INSERT INTO thread VALUES (12, 1, ?)').run(native);
        expect(score('RN_NEW_ARCH_HWUI')).toMatchObject({required_ok: 0, score: 0});
        expect(score('RN_OLD_ARCH_HWUI')).toMatchObject({required_ok: 0, score: 0});
        db.exec(`INSERT INTO slice VALUES (1, 100, 100, 10, 'FabricUIManager::dispatchMountItems')`);
        expect(score('RN_NEW_ARCH_HWUI')?.score).toBeGreaterThan(0);
        expect(score('RN_OLD_ARCH_HWUI')?.score).toBe(0);
        expect(score('RN_SKIA_RENDERER')?.excluded).toBe(0);
        db.exec(`DELETE FROM slice; INSERT INTO thread VALUES (13, 1, 'mqt_shadow_queue')`);
        expect(score('RN_OLD_ARCH_HWUI')?.score).toBeGreaterThan(0);
        expect(score('RN_NEW_ARCH_HWUI')?.score).toBe(0);
        db.exec('DELETE FROM thread WHERE utid IN (11, 12, 13)');
      }
    } finally {
      db.close();
    }
  });

  it('collects modern RN JS/native context without turning thread names or Commit into Mount evidence', () => {
    const db = createFixture();
    try {
      db.exec(`
        INSERT INTO thread VALUES (11, 1, 'mqt_v_js'), (12, 1, 'mqt_v_native');
        INSERT INTO thread_track VALUES (101, 11), (102, 12);
        INSERT INTO slice VALUES (1, 101, 100, 10, 'business'), (2, 102, 120, 10, 'native_work');
      `);
      const sql = loadSql('atomic/rn_fabric_render_jank.skill.yaml', 'fabric_frame_overlap');
      const start = sql.indexOf('fabric_processes AS (');
      const ctes = sql.slice(start, sql.indexOf('frames AS (', start)).trim().replace(/,\s*$/, '');
      const query = `WITH input AS (SELECT 'com.example.render' AS target_process, 0 AS start_ts, 1000 AS end_ts),
        ${ctes} SELECT phase FROM fabric_slices ORDER BY ts`;
      expect(db.prepare(query).all()).toEqual([]);
      db.exec(`INSERT INTO slice VALUES (3, 100, 140, 10, 'FabricCommit'), (4, 100, 160, 10, 'FabricMount')`);
      expect(db.prepare(query).all()).toEqual([
        {phase: 'javascript'}, {phase: 'native_modules'},
        {phase: 'shadow_tree_commit'}, {phase: 'fabric_mounting'},
      ]);

      const bridge = loadSql('atomic/rn_bridge_to_frame_jank.skill.yaml', 'rn_bridge_frame_overlap');
      const bridgeStart = bridge.indexOf('rn_slices AS (');
      const bridgeCtes = bridge.slice(bridgeStart, bridge.indexOf('frames AS (', bridgeStart)).trim().replace(/,\s*$/, '');
      expect(db.prepare(`WITH input AS (SELECT 'com.example.render' AS target_process, 0 AS start_ts, 1000 AS end_ts),
        ${bridgeCtes} SELECT phase FROM rn_slices ORDER BY ts`).all())
        .toEqual([{phase: 'javascript'}, {phase: 'native_modules'}]);
    } finally {
      db.close();
    }
  });

  it('recognizes Chrome Viz comm truncation only with browser identity in the same app process family', async () => {
    const sql = await scoreSql();
    const db = createFixture();
    const score = () => (db.prepare(sql).all() as Array<{pipeline_id: string; required_ok: number; score: number}>)
      .find((candidate) => candidate.pipeline_id === 'CHROME_BROWSER_VIZ');
    try {
      db.exec(`
        INSERT INTO process VALUES (2, 'com.example.render:privileged_process0'), (3, 'com.other.browser');
        INSERT INTO thread VALUES (11, 1, 'CrBrowserMain'), (12, 2, 'VizCompositorTh');
      `);
      expect(score()?.required_ok).toBe(1);
      expect(score()?.score).toBeGreaterThan(0);
      db.exec(`UPDATE thread SET name = 'main' WHERE utid = 11`);
      expect(score()).toMatchObject({required_ok: 0, score: 0});
      db.exec(`UPDATE thread SET name = 'CrBrowserMain' WHERE utid = 11; UPDATE thread SET upid = 3 WHERE utid = 12`);
      expect(score()).toMatchObject({required_ok: 0, score: 0});
    } finally {
      db.close();
    }
  });
});
