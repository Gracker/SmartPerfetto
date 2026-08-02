// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import fs from 'fs';
import path from 'path';
import yaml from 'js-yaml';
import { generateRenderingPipelineDetectionSkill } from '../services/renderingPipelineDetectionSkillGenerator';
import type { SkillDefinition, SkillStep } from '../services/skillEngine/types';

const OUTPUT_PATH = path.resolve(
  __dirname,
  '../../skills/atomic/rendering_pipeline_detection.skill.yaml'
);

const GENERATED_HEADER = `# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2024-2026 Gracker (Chris)
# This file is part of SmartPerfetto. See LICENSE for details.
# GENERATED FILE: run npm run generate:pipeline-detection; do not edit by hand.

`;

export type PortableRenderingPipelineDetectionSkill = SkillDefinition & {
  tier: 'S';
};

function isPortableStep(step: SkillStep): boolean {
  return step.type === 'atomic';
}

export async function buildPortableRenderingPipelineDetectionSkill(): Promise<PortableRenderingPipelineDetectionSkill> {
  const generated = await generateRenderingPipelineDetectionSkill();
  const steps = (generated.steps || []).filter(isPortableStep);
  const portableOutputFields = generated.output?.fields?.filter(
    (field) => field.name !== 'pipeline_bundle'
  );

  return {
    name: generated.name,
    version: generated.version,
    type: generated.type,
    category: generated.category,
    tier: 'S',
    meta: generated.meta,
    triggers: generated.triggers,
    prerequisites: generated.prerequisites,
    inputs: generated.inputs,
    steps,
    output: {
      ...generated.output,
      fields: portableOutputFields,
    },
  };
}

export function serializePortableRenderingPipelineDetectionSkill(
  skill: PortableRenderingPipelineDetectionSkill
): string {
  const serialized = GENERATED_HEADER + yaml.dump(skill, {
    noRefs: true,
    lineWidth: -1,
    quoteStyle: 'double',
  });
  return serialized.replace(/[ \t]+$/gm, '');
}

async function main(): Promise<void> {
  const check = process.argv.slice(2).includes('--check');
  const unknown = process.argv.slice(2).filter((argument) => argument !== '--check');
  if (unknown.length > 0) throw new Error(`Unknown arguments: ${unknown.join(', ')}`);

  const skill = await buildPortableRenderingPipelineDetectionSkill();
  const expected = serializePortableRenderingPipelineDetectionSkill(skill);
  if (check) {
    const committed = fs.existsSync(OUTPUT_PATH) ? fs.readFileSync(OUTPUT_PATH, 'utf8') : '';
    if (committed !== expected) {
      throw new Error(`Generated detector drift: ${OUTPUT_PATH}`);
    }
    console.log('Rendering pipeline detector is up to date.');
    return;
  }
  fs.writeFileSync(OUTPUT_PATH, expected);
  console.log(`Generated ${OUTPUT_PATH}`);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
