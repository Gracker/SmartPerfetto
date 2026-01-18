/**
 * Sync Types to Frontend
 *
 * 将 shared/types/generated/ 复制到前端目录。
 * Perfetto UI 构建系统不支持外部路径引用，需要复制文件。
 *
 * 用法: npx ts-node scripts/sync-types-to-frontend.ts
 */

import * as fs from 'fs';
import * as path from 'path';

// Script is in backend/scripts/, so go up two levels for project root
const projectRoot = path.resolve(__dirname, '../..');
const sourceDir = path.join(projectRoot, 'shared', 'types', 'generated');
const targetDir = path.join(
  projectRoot,
  'perfetto',
  'ui',
  'src',
  'plugins',
  'com.smartperfetto.AIAssistant',
  'generated'
);

function copyDir(src: string, dest: string) {
  // Create destination directory
  fs.mkdirSync(dest, { recursive: true });

  // Read source directory
  if (!fs.existsSync(src)) {
    console.log(`Source directory does not exist: ${src}`);
    console.log('Run generate-skill-types.ts first.');
    return;
  }

  const entries = fs.readdirSync(src, { withFileTypes: true });

  let copiedCount = 0;

  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);

    if (entry.isDirectory()) {
      copyDir(srcPath, destPath);
    } else if (entry.name.endsWith('.ts')) {
      // Read and modify content for frontend compatibility
      let content = fs.readFileSync(srcPath, 'utf-8');

      // Add a note about the source
      if (!content.includes('Synced from shared/types/generated')) {
        content = content.replace(
          'DO NOT EDIT',
          'DO NOT EDIT - Synced from shared/types/generated'
        );
      }

      fs.writeFileSync(destPath, content);
      copiedCount++;
      console.log(`Copied: ${entry.name}`);
    }
  }

  console.log(`\nSynced ${copiedCount} files to frontend.`);
}

// Check if zod needs to be mentioned
function checkZodDependency() {
  const frontendPackageJson = path.join(
    projectRoot,
    'perfetto',
    'ui',
    'package.json'
  );

  if (fs.existsSync(frontendPackageJson)) {
    const pkg = JSON.parse(fs.readFileSync(frontendPackageJson, 'utf-8'));
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };

    if (!deps['zod']) {
      console.log('\n⚠️  Note: zod is not in frontend dependencies.');
      console.log('   You may need to add it or use a local copy.');
    }
  }
}

console.log('Syncing types to frontend...');
console.log(`Source: ${sourceDir}`);
console.log(`Target: ${targetDir}`);
console.log('');

copyDir(sourceDir, targetDir);
checkZodDependency();
