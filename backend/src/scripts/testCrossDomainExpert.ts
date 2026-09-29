// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

/**
 * Test script for Cross-Domain Expert System
 *
 * Tests the hierarchical expert system with module skills.
 * Run with: npx ts-node src/scripts/testCrossDomainExpert.ts
 */

import { skillRegistry, ensureSkillRegistryInitialized } from '../services/skillEngine/skillLoader';
import {
  moduleCatalog,
  createPerformanceExpert,
  PerformanceExpert,
  CrossDomainInput,
  CrossDomainOutput,
  CrossDomainEvent,
} from '../agent/experts/crossDomain';

// Colors for console output
const colors = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  red: '\x1b[31m',
  cyan: '\x1b[36m',
};

function log(color: keyof typeof colors, message: string) {
  console.log(`${colors[color]}${message}${colors.reset}`);
}

function logSection(title: string) {
  console.log('\n' + '='.repeat(60));
  log('bright', title);
  console.log('='.repeat(60));
}

async function testSkillLoading() {
  logSection('Test 1: Skill Loading');

  try {
    // Load all skills
    await ensureSkillRegistryInitialized();

    // Check module skills
    const moduleSkills = skillRegistry.getAllModuleSkills();
    log('green', `✓ Loaded ${moduleSkills.length} module skills`);

    // List module skills by layer
    const layers = ['app', 'framework', 'kernel', 'hardware'];
    for (const layer of layers) {
      const skills = skillRegistry.findSkillsByLayer(layer as any);
      log('cyan', `  ${layer}: ${skills.map(s => s.name).join(', ') || 'none'}`);
    }

    // Check for specific module skills
    const expectedModules = [
      'scheduler_module',
      'binder_module',
      'surfaceflinger_module',
      'ams_module',
      'input_module',
      'art_module',
      'cpu_module',
      'gpu_module',
      'third_party_module',
    ];

    let missingCount = 0;
    for (const name of expectedModules) {
      const skill = skillRegistry.getSkill(name);
      if (skill) {
        log('green', `  ✓ Found ${name}`);
      } else {
        log('red', `  ✗ Missing ${name}`);
        missingCount++;
      }
    }

    if (missingCount === 0) {
      log('green', '\n✓ All expected module skills found');
    } else {
      log('yellow', `\n⚠ ${missingCount} module skills missing`);
    }

    return moduleSkills.length > 0;
  } catch (error: any) {
    log('red', `✗ Skill loading failed: ${error.message}`);
    return false;
  }
}

async function testModuleCatalog() {
  logSection('Test 2: Module Catalog');

  try {
    // Initialize module catalog
    await moduleCatalog.initialize();

    const modules = moduleCatalog.getAllModules();
    log('green', `✓ Catalog initialized with ${modules.length} modules`);

    // List modules by layer
    const layers = ['app', 'framework', 'kernel', 'hardware'] as const;
    for (const layer of layers) {
      const layerModules = moduleCatalog.getModulesByLayer(layer);
      log('cyan', `  ${layer}: ${layerModules.map(m => m.name).join(', ') || 'none'}`);
    }

    // Test capability lookup
    const capabilities = moduleCatalog.getAllCapabilities();
    log('green', `✓ Found ${capabilities.length} total capabilities`);

    // Sample capabilities
    const sampleCaps = capabilities.slice(0, 5);
    for (const cap of sampleCaps) {
      log('cyan', `  - ${cap.moduleId}: ${cap.capability.id}`);
    }

    // Test analysis type routing
    const analysisTypes = ['scrolling', 'startup', 'click', 'anr', 'memory'];
    log('blue', '\nAnalysis type routing:');
    for (const type of analysisTypes) {
      const modules = moduleCatalog.findModulesForAnalysis(type);
      log('cyan', `  ${type}: ${modules.join(', ')}`);
    }

    return modules.length > 0;
  } catch (error: any) {
    log('red', `✗ Module catalog test failed: ${error.message}`);
    return false;
  }
}

async function testPerformanceExpertCreation() {
  logSection('Test 3: PerformanceExpert Creation');

  try {
    const expert = createPerformanceExpert();
    log('green', `✓ PerformanceExpert created`);
    log('cyan', `  ID: ${expert.config.id}`);
    log('cyan', `  Domain: ${expert.config.domain}`);
    log('cyan', `  Entry modules: ${expert.config.entryModules.join(', ')}`);
    log('cyan', `  Max turns: ${expert.config.maxDialogueTurns}`);
    log('cyan', `  Confidence threshold: ${expert.config.confidenceThreshold}`);
    log('cyan', `  Handles intents: ${expert.config.handlesIntents.join(', ')}`);

    return true;
  } catch (error: any) {
    log('red', `✗ PerformanceExpert creation failed: ${error.message}`);
    return false;
  }
}

async function testDialogueInterface() {
  logSection('Test 4: Dialogue Interface Parsing');

  try {
    // Check that module skills have dialogue interface
    const moduleSkills = skillRegistry.getAllModuleSkills();

    let dialogueCount = 0;
    let capabilityCount = 0;
    let findingsCount = 0;
    let suggestionsCount = 0;

    for (const skill of moduleSkills) {
      if (skill.dialogue) {
        dialogueCount++;
        capabilityCount += skill.dialogue.capabilities?.length || 0;
        findingsCount += skill.dialogue.findingsSchema?.length || 0;
        suggestionsCount += skill.dialogue.suggestionsSchema?.length || 0;
      }
    }

    log('green', `✓ ${dialogueCount}/${moduleSkills.length} skills have dialogue interface`);
    log('cyan', `  Total capabilities: ${capabilityCount}`);
    log('cyan', `  Total findings schemas: ${findingsCount}`);
    log('cyan', `  Total suggestions schemas: ${suggestionsCount}`);

    // Sample dialogue interface
    const sampleSkill = moduleSkills.find(s => s.dialogue?.capabilities?.length);
    if (sampleSkill) {
      log('blue', `\nSample dialogue interface (${sampleSkill.name}):`);
      for (const cap of sampleSkill.dialogue!.capabilities!.slice(0, 2)) {
        log('cyan', `  Capability: ${cap.id}`);
        log('cyan', `    Question: ${cap.questionTemplate}`);
        log('cyan', `    Required: ${cap.requiredParams.join(', ')}`);
      }
    }

    return dialogueCount > 0;
  } catch (error: any) {
    log('red', `✗ Dialogue interface test failed: ${error.message}`);
    return false;
  }
}

async function testEventEmission() {
  logSection('Test 5: Event Emission');

  try {
    const expert = createPerformanceExpert();
    const events: CrossDomainEvent[] = [];

    expert.on('event', (event: CrossDomainEvent) => {
      events.push(event);
      log('cyan', `  Event: ${event.type} (turn ${event.turnNumber})`);
    });

    log('green', '✓ Event listener attached');
    log('yellow', '⚠ Full event test requires trace processor (skipped)');

    return true;
  } catch (error: any) {
    log('red', `✗ Event emission test failed: ${error.message}`);
    return false;
  }
}

async function testSkillStepsValidation() {
  logSection('Test 6: Module Skill Steps Validation');

  try {
    const moduleSkills = skillRegistry.getAllModuleSkills();
    let validCount = 0;
    let issues: string[] = [];

    for (const skill of moduleSkills) {
      let isValid = true;

      // Check steps exist
      if (!skill.steps || skill.steps.length === 0) {
        issues.push(`${skill.name}: no steps defined`);
        isValid = false;
      }

      // Check each step has required fields
      for (const step of skill.steps || []) {
        if (!step.id) {
          issues.push(`${skill.name}: step missing id`);
          isValid = false;
        }
        if (step.type === 'atomic' && !step.sql) {
          issues.push(`${skill.name}.${step.id}: atomic step missing sql`);
          isValid = false;
        }
      }

      // Check module metadata
      if (!skill.module) {
        issues.push(`${skill.name}: missing module metadata`);
        isValid = false;
      } else {
        if (!skill.module.layer) {
          issues.push(`${skill.name}: missing module.layer`);
          isValid = false;
        }
        if (!skill.module.component) {
          issues.push(`${skill.name}: missing module.component`);
          isValid = false;
        }
      }

      if (isValid) {
        validCount++;
        log('green', `  ✓ ${skill.name}`);
      }
    }

    if (issues.length > 0) {
      log('yellow', '\nIssues found:');
      for (const issue of issues) {
        log('yellow', `  - ${issue}`);
      }
    }

    log('green', `\n✓ ${validCount}/${moduleSkills.length} skills validated`);
    return validCount === moduleSkills.length;
  } catch (error: any) {
    log('red', `✗ Skill validation failed: ${error.message}`);
    return false;
  }
}

async function runAllTests() {
  console.log('\n');
  log('bright', '╔════════════════════════════════════════════════════════════╗');
  log('bright', '║       Cross-Domain Expert System Test Suite                ║');
  log('bright', '╚════════════════════════════════════════════════════════════╝');

  const results: { name: string; passed: boolean }[] = [];

  // Run tests
  results.push({ name: 'Skill Loading', passed: await testSkillLoading() });
  results.push({ name: 'Module Catalog', passed: await testModuleCatalog() });
  results.push({ name: 'PerformanceExpert Creation', passed: await testPerformanceExpertCreation() });
  results.push({ name: 'Dialogue Interface', passed: await testDialogueInterface() });
  results.push({ name: 'Event Emission', passed: await testEventEmission() });
  results.push({ name: 'Skill Steps Validation', passed: await testSkillStepsValidation() });

  // Summary
  logSection('Test Summary');

  const passed = results.filter(r => r.passed).length;
  const total = results.length;

  for (const result of results) {
    if (result.passed) {
      log('green', `  ✓ ${result.name}`);
    } else {
      log('red', `  ✗ ${result.name}`);
    }
  }

  console.log('\n' + '-'.repeat(40));
  if (passed === total) {
    log('green', `All tests passed! (${passed}/${total})`);
  } else {
    log('yellow', `${passed}/${total} tests passed`);
  }

  process.exit(passed === total ? 0 : 1);
}

// Run tests
runAllTests().catch((error) => {
  log('red', `Fatal error: ${error.message}`);
  process.exit(1);
});
