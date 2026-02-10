import fs from 'fs';
import path from 'path';
import yaml from 'js-yaml';
import type { SceneTemplateRecord } from './sceneTypes';
import {
  parseSceneTemplatePatchesFromConfig,
  SceneTemplateConfigLayer,
  SceneTemplatePatch,
} from './sceneTemplateValidator';

const SCENE_TEMPLATE_CONFIG_ENV = 'SMARTPERFETTO_CONCLUSION_SCENE_TEMPLATE_PATH';
const SCENE_TEMPLATE_BASE_CONFIG_ENV = 'SMARTPERFETTO_CONCLUSION_SCENE_TEMPLATE_BASE_PATH';
const SCENE_TEMPLATE_OVERRIDE_CONFIG_ENV = 'SMARTPERFETTO_CONCLUSION_SCENE_TEMPLATE_OVERRIDE_PATH';

const BASE_TEMPLATE_FILE = 'conclusion_scene_templates.base.yaml';
const OVERRIDE_TEMPLATE_FILE = 'conclusion_scene_templates.yaml';

export interface SceneTemplateStoreDiagnostics {
  sourceFiles: string[];
  warnings: string[];
  templateCount: number;
}

const FALLBACK_SCENE_TEMPLATES: SceneTemplateRecord[] = [
  {
    id: 'jank',
    sceneName: '卡顿/掉帧',
    aspectHints: ['jank', 'scroll', 'frame', 'fps'],
    keywords: ['卡顿', '掉帧', '滑动', 'frame', 'jank'],
    focusLines: ['- 聚焦帧预算违约链路：主线程 -> RenderThread -> SF/HWC。'],
    outputRequirementTemplates: [
      '- 若结论包含主线程长耗时/长 slice，必须继续回答“{{deep_reason_label}}”。',
      '- 每个“{{deep_reason_label}}”必须绑定至少 1 个数值证据。',
    ],
    nextStepLine: '- “下一步”优先给出口径对齐、聚类下钻、同窗验证动作。',
    requireTopClusters: true,
  },
  {
    id: 'startup',
    sceneName: '启动性能',
    aspectHints: ['startup', 'launch'],
    keywords: ['启动', 'launch', 'startup', 'ttid', 'ttfd'],
    focusLines: ['- 聚焦启动链路：进程创建 -> 初始化 -> 首帧可见 -> 可交互。'],
    outputRequirementTemplates: ['- 启动场景至少给出 1 个阶段耗时或启动指标（TTID/TTFD）。'],
    nextStepLine: '- “下一步”优先对最慢启动阶段下钻。',
    requireTopClusters: false,
  },
  {
    id: 'generic',
    sceneName: '通用性能',
    aspectHints: [],
    keywords: [],
    focusLines: ['- 先用人话说明“现象 -> 直接证据 -> 影响”，再给根因与优化方向。'],
    outputRequirementTemplates: ['- 结论必须绑定明确证据，避免抽象术语堆砌。'],
    nextStepLine: '- “下一步”给出 1-2 个最高信息增益动作，并与当前证据直接对应。',
    requireTopClusters: false,
  },
];

let templateCache: SceneTemplateRecord[] | null = null;
let diagnosticsCache: SceneTemplateStoreDiagnostics = {
  sourceFiles: [],
  warnings: [],
  templateCount: 0,
};

function resolveAbsolutePath(rawPath: string): string {
  return path.isAbsolute(rawPath) ? rawPath : path.resolve(process.cwd(), rawPath);
}

function resolveDefaultConfigPath(fileName: string): string | null {
  const candidates = [
    path.resolve(__dirname, '../../../skills/config', fileName),
    path.resolve(__dirname, '../../../../skills/config', fileName),
    path.resolve(process.cwd(), 'skills/config', fileName),
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function resolveConfiguredPath(envKey: string, defaultFileName: string): string | null {
  const envValue = String(process.env[envKey] || '').trim();
  if (envValue) return resolveAbsolutePath(envValue);
  return resolveDefaultConfigPath(defaultFileName);
}

function loadSceneTemplatePatchesFromFile(
  configPath: string,
  layer: SceneTemplateConfigLayer,
  warnings: string[],
  sourceFiles: string[]
): SceneTemplatePatch[] {
  if (!configPath || !fs.existsSync(configPath)) return [];
  sourceFiles.push(configPath);

  try {
    const raw = fs.readFileSync(configPath, 'utf-8');
    const parsed = yaml.load(raw);
    return parseSceneTemplatePatchesFromConfig(
      parsed,
      {
        filePath: configPath,
        layer,
      },
      warnings
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    warnings.push(`[${layer}] ${configPath}: failed to parse YAML (${message})`);
    return [];
  }
}

function fallbackTemplateForPatch(id: string): SceneTemplateRecord {
  const generic = FALLBACK_SCENE_TEMPLATES.find(item => item.id === 'generic')!;
  return {
    ...generic,
    id,
    sceneName: id,
  };
}

function applySceneTemplatePatch(
  templateMap: Map<string, SceneTemplateRecord>,
  patch: SceneTemplatePatch
): void {
  const base = templateMap.get(patch.id) || fallbackTemplateForPatch(patch.id);
  const merged: SceneTemplateRecord = {
    ...base,
    ...(patch.sceneName !== undefined ? { sceneName: patch.sceneName } : {}),
    ...(patch.aspectHints !== undefined ? { aspectHints: patch.aspectHints } : {}),
    ...(patch.keywords !== undefined ? { keywords: patch.keywords } : {}),
    ...(patch.focusLines !== undefined ? { focusLines: patch.focusLines } : {}),
    ...(patch.outputRequirementTemplates !== undefined ? { outputRequirementTemplates: patch.outputRequirementTemplates } : {}),
    ...(patch.nextStepLine !== undefined ? { nextStepLine: patch.nextStepLine } : {}),
    ...(patch.requireTopClusters !== undefined ? { requireTopClusters: patch.requireTopClusters } : {}),
  };

  if (!merged.sceneName) merged.sceneName = base.sceneName || patch.id;
  if (!Array.isArray(merged.outputRequirementTemplates) || merged.outputRequirementTemplates.length === 0) {
    merged.outputRequirementTemplates = base.outputRequirementTemplates;
  }
  if (!merged.nextStepLine) merged.nextStepLine = base.nextStepLine;

  templateMap.set(patch.id, merged);
}

function buildDefaultTemplateMap(): Map<string, SceneTemplateRecord> {
  const map = new Map<string, SceneTemplateRecord>();
  for (const template of FALLBACK_SCENE_TEMPLATES) {
    map.set(template.id, { ...template });
  }
  return map;
}

function dedupeStringArray(values: string[]): string[] {
  return Array.from(new Set(values));
}

function flushWarnings(warnings: string[]): void {
  for (const warning of warnings) {
    console.warn(`[SceneTemplateStore] ${warning}`);
  }
}

function updateDiagnostics(
  sourceFiles: string[],
  warnings: string[],
  templateCount: number
): void {
  diagnosticsCache = {
    sourceFiles: dedupeStringArray(sourceFiles),
    warnings: [...warnings],
    templateCount,
  };
}

function loadTemplates(): SceneTemplateRecord[] {
  const templateMap = buildDefaultTemplateMap();
  const sourceFiles: string[] = [];
  const warnings: string[] = [];
  const singleConfigPath = String(process.env[SCENE_TEMPLATE_CONFIG_ENV] || '').trim();

  if (singleConfigPath) {
    const patches = loadSceneTemplatePatchesFromFile(
      resolveAbsolutePath(singleConfigPath),
      'single',
      warnings,
      sourceFiles
    );
    for (const patch of patches) applySceneTemplatePatch(templateMap, patch);
    const templates = Array.from(templateMap.values());
    updateDiagnostics(sourceFiles, warnings, templates.length);
    flushWarnings(warnings);
    return templates;
  }

  const baseConfigPath = resolveConfiguredPath(SCENE_TEMPLATE_BASE_CONFIG_ENV, BASE_TEMPLATE_FILE);
  const overrideConfigPath = resolveConfiguredPath(SCENE_TEMPLATE_OVERRIDE_CONFIG_ENV, OVERRIDE_TEMPLATE_FILE);

  if (baseConfigPath) {
    const basePatches = loadSceneTemplatePatchesFromFile(baseConfigPath, 'base', warnings, sourceFiles);
    for (const patch of basePatches) applySceneTemplatePatch(templateMap, patch);
  }

  if (overrideConfigPath) {
    const overridePatches = loadSceneTemplatePatchesFromFile(
      overrideConfigPath,
      'override',
      warnings,
      sourceFiles
    );
    for (const patch of overridePatches) applySceneTemplatePatch(templateMap, patch);
  }

  if (!templateMap.has('generic')) {
    templateMap.set('generic', fallbackTemplateForPatch('generic'));
  }

  const templates = Array.from(templateMap.values());
  updateDiagnostics(sourceFiles, warnings, templates.length);
  flushWarnings(warnings);
  return templates;
}

export function getSceneTemplates(): SceneTemplateRecord[] {
  if (templateCache) return templateCache;
  templateCache = loadTemplates();
  return templateCache;
}

export function getSceneTemplateStoreDiagnostics(): SceneTemplateStoreDiagnostics {
  if (!templateCache) {
    templateCache = loadTemplates();
  }
  return {
    sourceFiles: [...diagnosticsCache.sourceFiles],
    warnings: [...diagnosticsCache.warnings],
    templateCount: diagnosticsCache.templateCount,
  };
}

export function resetSceneTemplateStoreCacheForTests(): void {
  templateCache = null;
  diagnosticsCache = {
    sourceFiles: [],
    warnings: [],
    templateCount: 0,
  };
}
