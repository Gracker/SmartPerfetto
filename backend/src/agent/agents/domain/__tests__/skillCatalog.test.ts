import { describe, it, expect, beforeAll } from '@jest/globals';
import { ensureSkillRegistryInitialized, skillRegistry } from '../../../../services/skillEngine/skillLoader';
import {
  ANR_SKILLS,
  BINDER_SKILLS,
  CPU_SKILLS,
  FRAME_SKILLS,
  INTERACTION_SKILLS,
  MEMORY_SKILLS,
  STARTUP_SKILLS,
  SYSTEM_SKILLS,
} from '../skillCatalog';

const ALL_AGENT_SKILLS = [
  ...FRAME_SKILLS,
  ...CPU_SKILLS,
  ...MEMORY_SKILLS,
  ...BINDER_SKILLS,
  ...STARTUP_SKILLS,
  ...INTERACTION_SKILLS,
  ...ANR_SKILLS,
  ...SYSTEM_SKILLS,
];

describe('domain skill catalog', () => {
  beforeAll(async () => {
    await ensureSkillRegistryInitialized();
  });

  it('maps every declared skillId to an existing YAML skill definition', () => {
    const missing = ALL_AGENT_SKILLS
      .map(def => def.skillId)
      .filter(skillId => !skillRegistry.getSkill(skillId));

    expect(missing).toEqual([]);
  });

  it('uses unique tool names to avoid agent tool collisions', () => {
    const toolNames = ALL_AGENT_SKILLS.map(def => def.toolName);
    const duplicates = toolNames.filter((name, index) => toolNames.indexOf(name) !== index);
    expect(duplicates).toEqual([]);
  });
});
