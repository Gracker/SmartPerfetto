import fs from 'fs';
import path from 'path';
import yaml from 'js-yaml';
import { describe, expect, it } from '@jest/globals';

function listSkillTargets(skillsDir: string, kind: 'atomic' | 'composite'): string[] {
  const dir = path.join(skillsDir, kind);
  if (!fs.existsSync(dir)) return [];

  return fs
    .readdirSync(dir)
    .filter((file) => file.endsWith('.skill.yaml') || file.endsWith('.skill.yml'))
    .map((file) => `${kind}/${file.replace(/\.skill\.ya?ml$/i, '')}`);
}

describe('vendor startup overrides', () => {
  it('should extend existing base skills and keep vendor metadata aligned', () => {
    const skillsDir = path.resolve(__dirname, '../../skills');
    const vendorsDir = path.join(skillsDir, 'vendors');
    const knownTargets = new Set<string>([
      ...listSkillTargets(skillsDir, 'atomic'),
      ...listSkillTargets(skillsDir, 'composite'),
    ]);

    expect(fs.existsSync(vendorsDir)).toBe(true);

    const vendorDirs = fs
      .readdirSync(vendorsDir)
      .map((name) => path.join(vendorsDir, name))
      .filter((fullPath) => fs.statSync(fullPath).isDirectory());

    expect(vendorDirs.length).toBeGreaterThan(0);

    for (const vendorPath of vendorDirs) {
      const vendorId = path.basename(vendorPath);
      const overridePath = path.join(vendorPath, 'startup.override.yaml');
      expect(fs.existsSync(overridePath)).toBe(true);

      const content = fs.readFileSync(overridePath, 'utf-8');
      const parsed = yaml.load(content) as any;

      expect(typeof parsed.extends).toBe('string');
      expect(knownTargets.has(parsed.extends)).toBe(true);

      if (parsed?.meta?.vendor) {
        expect(String(parsed.meta.vendor)).toBe(vendorId);
      }
    }
  });
});
