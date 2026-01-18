/**
 * Skill Type Generator
 *
 * 从 Skill YAML 文件生成 TypeScript 类型和 Zod 验证 Schema。
 * 实现单一数据源：YAML 是权威定义，代码是消费者。
 *
 * 用法: npx ts-node scripts/generate-skill-types.ts
 */

import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';

// ============================================================================
// Types
// ============================================================================

interface OutputSchemaField {
  type: 'string' | 'number' | 'boolean' | 'object' | 'array';
  description?: string;
  optional?: boolean;
  items?: Record<string, OutputSchemaField>; // For array items
  properties?: Record<string, OutputSchemaField>; // For nested objects
}

interface OutputSchema {
  type: 'array' | 'object';
  items?: Record<string, OutputSchemaField>;
  properties?: Record<string, OutputSchemaField>;
}

interface SkillStep {
  id: string;
  type: string;
  name?: string;
  save_as?: string;
  output_schema?: OutputSchema;
  optional?: boolean;
}

interface SkillDefinition {
  name: string;
  version?: string;
  type: string;
  steps?: SkillStep[];
}

// ============================================================================
// Helpers
// ============================================================================

function toPascalCase(str: string): string {
  return str
    .split(/[_\-\s]+/)
    .map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join('');
}

function toCamelCase(str: string): string {
  const pascal = toPascalCase(str);
  return pascal.charAt(0).toLowerCase() + pascal.slice(1);
}

function mapTypeToTS(type: string): string {
  switch (type) {
    case 'string': return 'string';
    case 'number': return 'number';
    case 'boolean': return 'boolean';
    case 'object': return 'Record<string, unknown>';
    case 'array': return 'unknown[]';
    default: return 'unknown';
  }
}

function mapTypeToZod(type: string): string {
  switch (type) {
    case 'string': return 'z.string()';
    case 'number': return 'z.number()';
    case 'boolean': return 'z.boolean()';
    case 'object': return 'z.record(z.unknown())';
    case 'array': return 'z.array(z.unknown())';
    default: return 'z.unknown()';
  }
}

// ============================================================================
// Code Generation
// ============================================================================

function generateInterfaceFromSchema(
  name: string,
  schema: OutputSchema
): { interface: string; zodSchema: string } {
  const interfaceName = toPascalCase(name) + 'Item';
  const schemaName = interfaceName + 'Schema';

  const fields = schema.items || schema.properties || {};
  const fieldEntries = Object.entries(fields);

  if (fieldEntries.length === 0) {
    return {
      interface: `export type ${interfaceName} = Record<string, unknown>;`,
      zodSchema: `export const ${schemaName} = z.record(z.unknown());`,
    };
  }

  // Generate TypeScript interface
  const interfaceFields = fieldEntries
    .map(([fieldName, fieldDef]) => {
      const tsType = mapTypeToTS(fieldDef.type);
      const optional = fieldDef.optional ? '?' : '';
      const comment = fieldDef.description ? `  /** ${fieldDef.description} */\n` : '';
      return `${comment}  ${fieldName}${optional}: ${tsType};`;
    })
    .join('\n');

  const interfaceCode = `export interface ${interfaceName} {\n${interfaceFields}\n}`;

  // Generate Zod schema
  const zodFields = fieldEntries
    .map(([fieldName, fieldDef]) => {
      let zodType = mapTypeToZod(fieldDef.type);
      if (fieldDef.optional) {
        zodType += '.optional()';
      }
      return `  ${fieldName}: ${zodType},`;
    })
    .join('\n');

  const zodSchemaCode = `export const ${schemaName} = z.object({\n${zodFields}\n});`;

  return {
    interface: interfaceCode,
    zodSchema: zodSchemaCode,
  };
}

function generateSkillTypes(skill: SkillDefinition): string {
  const skillName = toPascalCase(skill.name);
  const lines: string[] = [];

  // Header
  lines.push(`/**`);
  lines.push(` * Auto-generated types for skill: ${skill.name}`);
  lines.push(` * DO NOT EDIT - Generated from ${skill.name}.skill.yaml`);
  lines.push(` */`);
  lines.push('');
  lines.push(`import { z } from 'zod';`);
  lines.push('');

  // Track steps with output_schema
  const stepsWithSchema: Array<{
    stepId: string;
    saveAs: string;
    interfaceName: string;
    schemaName: string;
    optional: boolean;
  }> = [];

  // Generate types for each step with output_schema
  if (skill.steps) {
    for (const step of skill.steps) {
      if (!step.output_schema) continue;

      const saveAs = step.save_as || step.id;
      const generated = generateInterfaceFromSchema(saveAs, step.output_schema);

      lines.push(`// ===== ${step.id} =====`);
      lines.push(generated.interface);
      lines.push('');
      lines.push(generated.zodSchema);
      lines.push('');

      stepsWithSchema.push({
        stepId: step.id,
        saveAs,
        interfaceName: toPascalCase(saveAs) + 'Item',
        schemaName: toPascalCase(saveAs) + 'ItemSchema',
        optional: step.optional || false,
      });
    }
  }

  // Generate combined result type
  if (stepsWithSchema.length > 0) {
    lines.push(`// ===== Combined Result =====`);

    // TypeScript interface
    const resultFields = stepsWithSchema
      .map(s => {
        const optional = s.optional ? '?' : '';
        return `  ${s.saveAs}${optional}: ${s.interfaceName}[];`;
      })
      .join('\n');

    lines.push(`export interface ${skillName}Result {`);
    lines.push(resultFields);
    lines.push(`}`);
    lines.push('');

    // Zod schema
    const zodResultFields = stepsWithSchema
      .map(s => {
        let zodType = `z.array(${s.schemaName})`;
        if (s.optional) {
          zodType += '.optional()';
        }
        return `  ${s.saveAs}: ${zodType},`;
      })
      .join('\n');

    lines.push(`export const ${skillName}ResultSchema = z.object({`);
    lines.push(zodResultFields);
    lines.push(`});`);
    lines.push('');

    // Export step schema lookup
    lines.push(`// Step schema lookup for runtime validation`);
    lines.push(`export const ${skillName}StepSchemas: Record<string, z.ZodSchema> = {`);
    for (const s of stepsWithSchema) {
      lines.push(`  '${s.saveAs}': z.array(${s.schemaName}),`);
    }
    lines.push(`};`);
  }

  return lines.join('\n');
}

// ============================================================================
// Main
// ============================================================================

async function main() {
  // Script is in backend/scripts/, so go up two levels for project root
  const projectRoot = path.resolve(__dirname, '../..');
  const skillsDir = path.join(projectRoot, 'backend', 'skills');
  const outputDir = path.join(projectRoot, 'shared', 'types', 'generated');

  // Ensure output directory exists
  fs.mkdirSync(outputDir, { recursive: true });

  // Find all skill YAML files
  const skillFiles: string[] = [];

  function findSkillFiles(dir: string) {
    if (!fs.existsSync(dir)) return;

    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        findSkillFiles(fullPath);
      } else if (entry.name.endsWith('.skill.yaml')) {
        skillFiles.push(fullPath);
      }
    }
  }

  findSkillFiles(skillsDir);

  console.log(`Found ${skillFiles.length} skill files`);

  const indexExports: string[] = [];
  let generatedCount = 0;

  for (const skillFile of skillFiles) {
    try {
      const content = fs.readFileSync(skillFile, 'utf-8');
      const skill = yaml.load(content) as SkillDefinition;

      if (!skill || !skill.name) {
        console.warn(`Skipping ${skillFile}: no name defined`);
        continue;
      }

      // Check if any step has output_schema
      const hasSchema = skill.steps?.some(s => s.output_schema);
      if (!hasSchema) {
        console.log(`Skipping ${skill.name}: no output_schema defined`);
        continue;
      }

      // Generate types
      const typeCode = generateSkillTypes(skill);
      const outputFile = path.join(outputDir, `${skill.name}.types.ts`);

      fs.writeFileSync(outputFile, typeCode);
      console.log(`Generated: ${skill.name}.types.ts`);

      indexExports.push(`export * from './${skill.name}.types';`);
      generatedCount++;
    } catch (error) {
      console.error(`Error processing ${skillFile}:`, error);
    }
  }

  // Generate index.ts (preserving manual exports)
  if (indexExports.length > 0) {
    const indexPath = path.join(outputDir, 'index.ts');

    // Read existing manual exports if index.ts exists
    let manualExports: string[] = [];
    if (fs.existsSync(indexPath)) {
      const existingContent = fs.readFileSync(indexPath, 'utf-8');
      // Extract exports that are marked as manual (after "// Manually defined" comment)
      const manualSection = existingContent.split('// Manually defined')[1];
      if (manualSection) {
        const manualMatches = manualSection.match(/export \* from ['"]\.\/[^'"]+['"]/g);
        if (manualMatches) {
          manualExports = manualMatches;
        }
      }
    }

    const indexContent = [
      '/**',
      ' * Skill Types Index',
      ' *',
      ' * Auto-generated types (from YAML output_schema):',
      ...indexExports.map(e => ` *   - ${e.match(/\.\/([^']+)/)?.[1] || e}`),
      ' *',
      ...(manualExports.length > 0 ? [
        ' * Manually defined types (for transformed formats):',
        ...manualExports.map(e => ` *   - ${e.match(/\.\/([^']+)/)?.[1] || e}`),
      ] : []),
      ' */',
      '',
      '// Auto-generated from YAML',
      ...indexExports,
      ...(manualExports.length > 0 ? [
        '',
        '// Manually defined for transformed formats',
        ...manualExports,
      ] : []),
      '',
    ].join('\n');

    fs.writeFileSync(indexPath, indexContent);
    console.log(`Generated: index.ts (preserved ${manualExports.length} manual exports)`);
  }

  console.log(`\nDone! Generated types for ${generatedCount} skills.`);

  if (generatedCount === 0) {
    console.log('\nNote: No skills have output_schema defined yet.');
    console.log('Add output_schema to skill steps to generate types.');
  }
}

main().catch(console.error);
