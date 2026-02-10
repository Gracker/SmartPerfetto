export type SceneTemplateConfigLayer = 'single' | 'base' | 'override';

export interface SceneTemplateValidationContext {
  filePath: string;
  layer: SceneTemplateConfigLayer;
}

export interface SceneTemplatePatch {
  id: string;
  sceneName?: string;
  aspectHints?: string[];
  keywords?: string[];
  focusLines?: string[];
  outputRequirementTemplates?: string[];
  nextStepLine?: string;
  requireTopClusters?: boolean;
}

interface SceneTemplateYamlRecord {
  id?: unknown;
  scene_name?: unknown;
  sceneName?: unknown;
  aspect_hints?: unknown;
  aspectHints?: unknown;
  keywords?: unknown;
  focus_lines?: unknown;
  focusLines?: unknown;
  output_requirement_lines?: unknown;
  outputRequirementLines?: unknown;
  next_step_line?: unknown;
  nextStepLine?: unknown;
  require_top_clusters?: unknown;
  requireTopClusters?: unknown;
}

interface SceneTemplateYamlConfig {
  version?: unknown;
  scenes?: unknown;
}

const SUPPORTED_CONFIG_VERSION = 1;

const ALLOWED_SCENE_RECORD_KEYS = new Set<string>([
  'id',
  'scene_name',
  'sceneName',
  'aspect_hints',
  'aspectHints',
  'keywords',
  'focus_lines',
  'focusLines',
  'output_requirement_lines',
  'outputRequirementLines',
  'next_step_line',
  'nextStepLine',
  'require_top_clusters',
  'requireTopClusters',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function buildWarningPrefix(
  context: SceneTemplateValidationContext,
  sceneId?: string,
  index?: number
): string {
  const sceneTag = sceneId
    ? ` scene=${sceneId}`
    : (typeof index === 'number' ? ` scene_index=${index}` : '');
  return `[${context.layer}] ${context.filePath}${sceneTag}`;
}

function pushWarning(
  warnings: string[],
  context: SceneTemplateValidationContext,
  message: string,
  sceneId?: string,
  index?: number
): void {
  warnings.push(`${buildWarningPrefix(context, sceneId, index)}: ${message}`);
}

function firstDefined(
  source: SceneTemplateYamlRecord,
  keys: string[]
): unknown {
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(source, key)) {
      return (source as Record<string, unknown>)[key];
    }
  }
  return undefined;
}

function parseOptionalString(
  value: unknown,
  warnings: string[],
  context: SceneTemplateValidationContext,
  fieldName: string,
  sceneId: string,
  index: number
): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') {
    pushWarning(warnings, context, `${fieldName} must be a string`, sceneId, index);
    return undefined;
  }
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return trimmed;
}

function parseOptionalStringArray(
  value: unknown,
  warnings: string[],
  context: SceneTemplateValidationContext,
  fieldName: string,
  sceneId: string,
  index: number
): string[] | undefined {
  if (value === undefined || value === null) return undefined;

  if (!Array.isArray(value)) {
    pushWarning(warnings, context, `${fieldName} must be an array`, sceneId, index);
    return undefined;
  }

  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string' && typeof item !== 'number' && typeof item !== 'boolean') {
      pushWarning(warnings, context, `${fieldName} contains non-scalar item; ignored`, sceneId, index);
      continue;
    }
    const text = String(item).trim();
    if (text) out.push(text);
  }

  return out;
}

function parseOptionalBoolean(
  value: unknown,
  warnings: string[],
  context: SceneTemplateValidationContext,
  fieldName: string,
  sceneId: string,
  index: number
): boolean | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (['true', '1', 'yes', 'y', 'on'].includes(normalized)) return true;
    if (['false', '0', 'no', 'n', 'off'].includes(normalized)) return false;
  }
  pushWarning(warnings, context, `${fieldName} must be a boolean-like value`, sceneId, index);
  return undefined;
}

function parseSceneTemplatePatchRecord(
  value: unknown,
  warnings: string[],
  context: SceneTemplateValidationContext,
  index: number
): SceneTemplatePatch | null {
  if (!isRecord(value)) {
    pushWarning(warnings, context, 'scene entry must be an object', undefined, index);
    return null;
  }

  const source = value as SceneTemplateYamlRecord;
  const unknownKeys = Object.keys(value).filter(key => !ALLOWED_SCENE_RECORD_KEYS.has(key));
  if (unknownKeys.length > 0) {
    pushWarning(warnings, context, `unknown fields: ${unknownKeys.join(', ')}`, undefined, index);
  }

  const rawId = firstDefined(source, ['id']);
  if (typeof rawId !== 'string') {
    pushWarning(warnings, context, 'scene.id is required and must be a string', undefined, index);
    return null;
  }
  const id = rawId.trim();
  if (!id) {
    pushWarning(warnings, context, 'scene.id must not be empty', undefined, index);
    return null;
  }

  const patch: SceneTemplatePatch = { id };

  const sceneName = parseOptionalString(
    firstDefined(source, ['scene_name', 'sceneName']),
    warnings,
    context,
    'scene_name',
    id,
    index
  );
  if (sceneName !== undefined) patch.sceneName = sceneName;

  const aspectHints = parseOptionalStringArray(
    firstDefined(source, ['aspect_hints', 'aspectHints']),
    warnings,
    context,
    'aspect_hints',
    id,
    index
  );
  if (aspectHints !== undefined) patch.aspectHints = aspectHints;

  const keywords = parseOptionalStringArray(
    firstDefined(source, ['keywords']),
    warnings,
    context,
    'keywords',
    id,
    index
  );
  if (keywords !== undefined) patch.keywords = keywords;

  const focusLines = parseOptionalStringArray(
    firstDefined(source, ['focus_lines', 'focusLines']),
    warnings,
    context,
    'focus_lines',
    id,
    index
  );
  if (focusLines !== undefined) patch.focusLines = focusLines;

  const outputRequirementTemplates = parseOptionalStringArray(
    firstDefined(source, ['output_requirement_lines', 'outputRequirementLines']),
    warnings,
    context,
    'output_requirement_lines',
    id,
    index
  );
  if (outputRequirementTemplates !== undefined) {
    patch.outputRequirementTemplates = outputRequirementTemplates;
  }

  const nextStepLine = parseOptionalString(
    firstDefined(source, ['next_step_line', 'nextStepLine']),
    warnings,
    context,
    'next_step_line',
    id,
    index
  );
  if (nextStepLine !== undefined) patch.nextStepLine = nextStepLine;

  const requireTopClusters = parseOptionalBoolean(
    firstDefined(source, ['require_top_clusters', 'requireTopClusters']),
    warnings,
    context,
    'require_top_clusters',
    id,
    index
  );
  if (requireTopClusters !== undefined) patch.requireTopClusters = requireTopClusters;

  const hasExplicitField = Object.keys(patch).some(key => key !== 'id');
  if (!hasExplicitField) {
    pushWarning(
      warnings,
      context,
      'scene has no overridable fields; entry will keep existing defaults',
      id,
      index
    );
  }

  if (context.layer !== 'override' && patch.sceneName === undefined) {
    pushWarning(
      warnings,
      context,
      'scene_name is recommended for base/single config to improve readability',
      id,
      index
    );
  }

  return patch;
}

export function parseSceneTemplatePatchesFromConfig(
  rawConfig: unknown,
  context: SceneTemplateValidationContext,
  warnings: string[]
): SceneTemplatePatch[] {
  if (!isRecord(rawConfig)) {
    pushWarning(warnings, context, 'config root must be an object');
    return [];
  }

  const config = rawConfig as SceneTemplateYamlConfig;
  if (config.version !== undefined) {
    const parsedVersion = Number(config.version);
    if (!Number.isFinite(parsedVersion) || parsedVersion !== SUPPORTED_CONFIG_VERSION) {
      pushWarning(
        warnings,
        context,
        `unsupported version "${String(config.version)}", expected ${SUPPORTED_CONFIG_VERSION}`
      );
    }
  }

  if (!Array.isArray(config.scenes)) {
    pushWarning(warnings, context, 'scenes must be an array');
    return [];
  }

  const seen = new Set<string>();
  const patches: SceneTemplatePatch[] = [];
  for (let index = 0; index < config.scenes.length; index += 1) {
    const patch = parseSceneTemplatePatchRecord(config.scenes[index], warnings, context, index);
    if (!patch) continue;

    if (seen.has(patch.id)) {
      pushWarning(
        warnings,
        context,
        `duplicate scene id "${patch.id}" detected; later entry overrides earlier entry`,
        patch.id,
        index
      );
    }
    seen.add(patch.id);
    patches.push(patch);
  }

  return patches;
}
