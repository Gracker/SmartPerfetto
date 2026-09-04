/**
 * CI Type Sync Check Script
 *
 * This script verifies that the generated frontend types are in sync with
 * the backend data contract. It regenerates the types to a temp location
 * and compares with the existing generated file.
 *
 * Exit codes:
 * - 0: Types are in sync
 * - 1: Types are out of sync (regeneration needed)
 * - 2: Error occurred during check
 *
 * Usage:
 *   npm run check:types
 *   npx tsx scripts/checkTypesSync.ts
 *
 * In CI:
 *   npm run check:types || (echo "Types out of sync! Run: npm run generate:frontend-types" && exit 1)
 */

import * as fs from 'fs';
import * as path from 'path';
import {
  conclusionContractFragment,
  externalIssueReportingFragment,
  identityContractFragment,
  verbatimContractFragment,
} from './frontendContractFragments';

// Paths
const projectRoot = path.resolve(__dirname, '../..');
const backendContractPath = path.join(projectRoot, 'backend/src/types/dataContract.ts');
const conclusionContractPath = path.join(projectRoot, 'backend/src/agent/core/conclusionContract.ts');
const evidenceContractPath = path.join(projectRoot, 'backend/src/types/evidenceContract.ts');
const claimVerificationPath = path.join(projectRoot, 'backend/src/types/claimVerification.ts');
const identityContractPath = path.join(projectRoot, 'backend/src/types/identityContract.ts');
const externalIssueReportingPath = path.join(
  projectRoot,
  'backend/src/types/externalIssueReporting.ts',
);
const frontendTypesPath = path.join(
  projectRoot,
  'perfetto/ui/src/plugins/com.smartperfetto.AIAssistant/generated/data_contract.types.ts'
);

/**
 * Extract string values from a const array definition
 * (Same logic as generateFrontendTypes.ts)
 */
function extractConstArrayValues(content: string, constName: string): string[] {
  const regex = new RegExp(`export const ${constName} = \\[([\\s\\S]*?)\\] as const`, 'm');
  const match = content.match(regex);
  if (!match) return [];

  const arrayContent = match[1];
  const values: string[] = [];

  const withoutComments = arrayContent
    .split('\n')
    .map(line => line.split('//')[0])
    .join(' ');

  const stringRegex = /'([^']+)'/g;
  let stringMatch;
  while ((stringMatch = stringRegex.exec(withoutComments)) !== null) {
    const value = stringMatch[1].trim();
    if (value && !values.includes(value)) {
      values.push(value);
    }
  }

  return values;
}

/**
 * Normalize content for comparison by removing:
 * - Timestamp lines (@generated)
 * - Trailing whitespace
 * - Multiple blank lines
 */
function normalizeForComparison(content: string): string {
  return content
    // Remove @generated timestamp line
    .replace(/@generated \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/g, '@generated TIMESTAMP')
    // Normalize line endings
    .replace(/\r\n/g, '\n')
    // Remove trailing whitespace
    .split('\n')
    .map(line => line.trimEnd())
    .join('\n')
    // Collapse multiple blank lines
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Generate the expected frontend types content
 * (Same logic as generateFrontendTypes.ts, but with fixed timestamp)
 */
function generateExpectedContent(backendContent: string): string {
  const columnTypes = extractConstArrayValues(backendContent, 'VALID_COLUMN_TYPES');
  const columnFormats = extractConstArrayValues(backendContent, 'VALID_COLUMN_FORMATS');
  const clickActions = extractConstArrayValues(backendContent, 'VALID_CLICK_ACTIONS');
  const displayLayers = extractConstArrayValues(backendContent, 'VALID_DISPLAY_LAYERS');
  const displayLevels = extractConstArrayValues(backendContent, 'VALID_DISPLAY_LEVELS');
  const displayFormats = extractConstArrayValues(backendContent, 'VALID_DISPLAY_FORMATS');

  // This should generate the same structure as generateFrontendTypes.ts
  // For CI checking, we only need to verify the type definitions match
  const parts: string[] = [];

  parts.push(`/**
 * SmartPerfetto Data Contract Types (Frontend)
 *
 * AUTO-GENERATED from backend/src/types/dataContract.ts
 * DO NOT EDIT MANUALLY - Changes will be overwritten
 *
 * To regenerate: npm run generate:frontend-types
 *
 * @module dataContract.types
 * @version 2.0.0 - DataEnvelope refactoring
 * @generated TIMESTAMP
 */
`);

  // Extract type union strings for comparison
  const expectedTypes = {
    columnTypes: columnTypes.map(t => `'${t}'`).join(' | '),
    columnFormats: columnFormats.map(t => `'${t}'`).join(' | '),
    clickActions: clickActions.map(t => `'${t}'`).join(' | '),
    displayLayers: displayLayers.map(t => `'${t}'`).join(' | '),
    displayLevels: displayLevels.map(t => `'${t}'`).join(' | '),
    displayFormats: displayFormats.map(t => `'${t}'`).join(' | '),
  };

  return JSON.stringify(expectedTypes);
}

/**
 * Extract type definitions from frontend file for comparison
 */
function extractTypeDefinitions(content: string): string {
  // Extract union type values
  const typePatterns = [
    { name: 'columnTypes', regex: /export type ColumnType =\s*([\s\S]*?);/ },
    { name: 'columnFormats', regex: /export type ColumnFormat =\s*([\s\S]*?);/ },
    { name: 'clickActions', regex: /export type ClickAction =\s*([\s\S]*?);/ },
    { name: 'displayLayers', regex: /export type DisplayLayer =\s*([\s\S]*?);/ },
    { name: 'displayLevels', regex: /export type DisplayLevel =\s*([\s\S]*?);/ },
    { name: 'displayFormats', regex: /export type DisplayFormat =\s*([\s\S]*?);/ },
  ];

  const extractedTypes: Record<string, string> = {};

  for (const { name, regex } of typePatterns) {
    const match = content.match(regex);
    if (match) {
      // Normalize the type union
      const typeUnion = match[1]
        .split('\n')
        .map(line => line.trim())
        .filter(line => line.startsWith("| '"))
        .map(line => line.replace(/^\| /, '').trim())
        .join(' | ');
      extractedTypes[name] = typeUnion;
    }
  }

  return JSON.stringify(extractedTypes);
}

interface ConclusionContractSyncExpectation {
  hasConclusionContractInterface: boolean;
  hasMetadataSceneId: boolean;
  hasMetadataClusterPolicy: boolean;
  analysisCompletedUsesConclusionContract: boolean;
}

interface AnalysisQualitySyncExpectation {
  hasClaimSupportType: boolean;
  hasClaimVerificationType: boolean;
  hasIdentityResolutionType: boolean;
  dataEnvelopeMetaHasIdentitySidecar: boolean;
  dataEnvelopeMetaHasArtifactIds: boolean;
  dataEnvelopeMetaHasIdentityStatus: boolean;
  dataEnvelopeMetaHasProcessIdentityWarning: boolean;
  analysisCompletedHasClaimSupport: boolean;
  analysisCompletedHasVerifier: boolean;
  analysisCompletedHasIdentityResolutions: boolean;
  analysisCompletedHasTerminationReason: boolean;
  analysisCompletedHasTerminationMessage: boolean;
  analysisCompletedHasTerminalRunStatus: boolean;
  claimReferencesHaveArtifactIds: boolean;
}

function extractConclusionContractExpectations(content: string): ConclusionContractSyncExpectation {
  const metadataBlockMatch = content.match(/export interface ConclusionContractMetadata\s*\{([\s\S]*?)\n\}/m);
  const metadataBlock = metadataBlockMatch ? metadataBlockMatch[1] : '';

  return {
    hasConclusionContractInterface: /export interface ConclusionContract\s*\{/.test(content),
    hasMetadataSceneId: /\bsceneId\s*\?:\s*string\s*;/.test(metadataBlock),
    hasMetadataClusterPolicy: /\bclusterPolicy\s*\?:\s*ConclusionContractClusterPolicy\s*;/.test(metadataBlock),
    analysisCompletedUsesConclusionContract: /\bconclusionContract\s*\?:\s*ConclusionContract\s*;/.test(content),
  };
}

function buildExpectedConclusionContractSync(
  backendContractContent: string,
  conclusionContractContent: string
): ConclusionContractSyncExpectation {
  return {
    hasConclusionContractInterface: /export interface ConclusionContract\s*\{/.test(conclusionContractContent),
    hasMetadataSceneId: /\bsceneId\s*\?:\s*string\s*;/.test(conclusionContractContent),
    hasMetadataClusterPolicy: /\bclusterPolicy\s*\?:\s*ConclusionContractClusterPolicy\s*;/.test(conclusionContractContent),
    analysisCompletedUsesConclusionContract:
      /\bconclusionContract\s*\?:\s*import\('\.\.\/agent\/core\/conclusionContract'\)\.ConclusionContract\s*;/.test(backendContractContent),
  };
}


function findOutOfSyncContractFragments(frontendContent: string, fragments: Array<{ name: string; content: string }>): string[] {
  const normalizedFrontend = normalizeForComparison(frontendContent);
  return fragments
    .filter(fragment => !normalizedFrontend.includes(normalizeForComparison(fragment.content)))
    .map(fragment => fragment.name);
}

function extractAnalysisQualityExpectations(content: string): AnalysisQualitySyncExpectation {
  const dataEnvelopeMetaMatch = content.match(/export interface DataEnvelopeMeta\s*\{([\s\S]*?)\n\}/m);
  const dataEnvelopeMetaBlock = dataEnvelopeMetaMatch ? dataEnvelopeMetaMatch[1] : '';
  const analysisCompletedMatch = content.match(/export interface AnalysisCompletedEvent\s*\{([\s\S]*?)\n\}/m);
  const analysisCompletedBlock = analysisCompletedMatch ? analysisCompletedMatch[1] : '';
  const claimRefMatch = content.match(/export interface ConclusionContractClaimReference\s*\{([\s\S]*?)\n\}/m);
  const claimRefBlock = claimRefMatch ? claimRefMatch[1] : '';
  return {
    hasClaimSupportType: /\bexport interface ClaimSupportV1\s*\{/.test(content),
    hasClaimVerificationType: /\bexport interface ClaimVerificationResult\s*\{/.test(content),
    hasIdentityResolutionType: /\bexport interface IdentityResolutionV1\s*\{/.test(content),
    dataEnvelopeMetaHasIdentitySidecar:
      /\bidentityRefId\s*\?:\s*string\s*;/.test(dataEnvelopeMetaBlock) &&
      /\bidentityResolution\s*\?:\s*IdentityResolutionV1\s*;/.test(dataEnvelopeMetaBlock),
    dataEnvelopeMetaHasArtifactIds:
      /\bartifactId\s*\?:\s*string\s*;/.test(dataEnvelopeMetaBlock) &&
      /\bsourceArtifactId\s*\?:\s*string\s*;/.test(dataEnvelopeMetaBlock),
    dataEnvelopeMetaHasIdentityStatus:
      /\bidentityStatus\s*\?:\s*IdentityResolutionStatus\s*;/.test(dataEnvelopeMetaBlock) &&
      /\bidentityWarnings\s*\?:\s*string\[\]\s*;/.test(dataEnvelopeMetaBlock),
    dataEnvelopeMetaHasProcessIdentityWarning:
      /\bprocessIdentityWarning\s*\?:\s*string\s*;/.test(dataEnvelopeMetaBlock),
    analysisCompletedHasClaimSupport: /\bclaimSupport\s*\?:\s*ClaimSupportV1\[\]\s*;/.test(analysisCompletedBlock),
    analysisCompletedHasVerifier: /\bclaimVerificationResult\s*\?:\s*ClaimVerificationResult\s*;/.test(analysisCompletedBlock),
    analysisCompletedHasIdentityResolutions: /\bidentityResolutions\s*\?:\s*IdentityResolutionV1\[\]\s*;/.test(analysisCompletedBlock),
    analysisCompletedHasTerminationReason: /\bterminationReason\s*\?:\s*string\s*;/.test(analysisCompletedBlock),
    analysisCompletedHasTerminationMessage: /\bterminationMessage\s*\?:\s*string\s*;/.test(analysisCompletedBlock),
    analysisCompletedHasTerminalRunStatus: /\bterminalRunStatus\s*\?:\s*'completed'\s*\|\s*'quota_exceeded'\s*;/.test(analysisCompletedBlock),
    claimReferencesHaveArtifactIds:
      /\bartifactId\s*\?:\s*string\s*;/.test(claimRefBlock) &&
      /\bsourceArtifactId\s*\?:\s*string\s*;/.test(claimRefBlock),
  };
}

/**
 * Main check function
 */
async function checkTypesSync(): Promise<boolean> {
  console.log('🔍 Checking frontend types sync with backend...\n');

  // Check if files exist
  if (!fs.existsSync(backendContractPath)) {
    console.error(`❌ Backend contract file not found: ${backendContractPath}`);
    process.exit(2);
  }

  if (!fs.existsSync(frontendTypesPath)) {
    console.error(`❌ Frontend types file not found: ${frontendTypesPath}`);
    console.error('\n👉 Run: npm run generate:frontend-types');
    process.exit(1);
  }

  if (!fs.existsSync(conclusionContractPath)) {
    console.error(`❌ Conclusion contract file not found: ${conclusionContractPath}`);
    process.exit(2);
  }
  for (const filePath of [
    evidenceContractPath,
    claimVerificationPath,
    identityContractPath,
    externalIssueReportingPath,
  ]) {
    if (!fs.existsSync(filePath)) {
      console.error(`❌ Analysis quality contract file not found: ${filePath}`);
      process.exit(2);
    }
  }

  // Read files
  const backendContent = fs.readFileSync(backendContractPath, 'utf-8');
  const conclusionContractContent = fs.readFileSync(conclusionContractPath, 'utf-8');
  const evidenceContractContent = fs.readFileSync(evidenceContractPath, 'utf-8');
  const claimVerificationContent = fs.readFileSync(claimVerificationPath, 'utf-8');
  const identityContractContent = fs.readFileSync(identityContractPath, 'utf-8');
  const externalIssueReportingContent = fs.readFileSync(
    externalIssueReportingPath,
    'utf-8',
  );
  const frontendContent = fs.readFileSync(frontendTypesPath, 'utf-8');

  // Extract and compare type definitions
  const expectedTypes = generateExpectedContent(backendContent);
  const actualTypes = extractTypeDefinitions(frontendContent);

  if (expectedTypes !== actualTypes) {
    console.log('❌ Types are OUT OF SYNC!\n');

    // Show differences
    const expected = JSON.parse(expectedTypes);
    const actual = JSON.parse(actualTypes);

    console.log('Differences found:');
    for (const key of Object.keys(expected)) {
      if (expected[key] !== actual[key]) {
        console.log(`\n  ${key}:`);
        console.log(`    Expected: ${expected[key]}`);
        console.log(`    Actual:   ${actual[key] || '(missing)'}`);
      }
    }

    console.log('\n👉 Run: npm run generate:frontend-types');
    return false;
  }

  const expectedConclusionSync = buildExpectedConclusionContractSync(
    backendContent,
    conclusionContractContent
  );
  const actualConclusionSync = extractConclusionContractExpectations(frontendContent);
  const mismatchedConclusionKeys = Object.keys(expectedConclusionSync).filter((key) => {
    const typedKey = key as keyof ConclusionContractSyncExpectation;
    return expectedConclusionSync[typedKey] !== actualConclusionSync[typedKey];
  });

  if (mismatchedConclusionKeys.length > 0) {
    console.log('❌ ConclusionContract typing is OUT OF SYNC!\n');
    for (const key of mismatchedConclusionKeys) {
      const typedKey = key as keyof ConclusionContractSyncExpectation;
      console.log(`  ${key}: expected=${expectedConclusionSync[typedKey]} actual=${actualConclusionSync[typedKey]}`);
    }
    console.log('\n👉 Run: npm run generate:frontend-types');
    return false;
  }

  const actualAnalysisQualitySync = extractAnalysisQualityExpectations(frontendContent);
  const mismatchedAnalysisQualityKeys = Object.keys(actualAnalysisQualitySync).filter((key) => {
    const typedKey = key as keyof AnalysisQualitySyncExpectation;
    return actualAnalysisQualitySync[typedKey] !== true;
  });
  if (mismatchedAnalysisQualityKeys.length > 0) {
    console.log('❌ Analysis quality contract typing is OUT OF SYNC!\n');
    for (const key of mismatchedAnalysisQualityKeys) {
      const typedKey = key as keyof AnalysisQualitySyncExpectation;
      console.log(`  ${key}: actual=${actualAnalysisQualitySync[typedKey]}`);
    }
    console.log('\n👉 Run: npm run generate:frontend-types');
    return false;
  }

  // Same transforms the generator applies, imported rather than restated: a
  // private copy here once expected `SourceUseDecisionV1` that the generator
  // deliberately rewrites, so the check could never pass.
  const outOfSyncFragments = findOutOfSyncContractFragments(frontendContent, [
    { name: 'conclusionContract.ts', content: conclusionContractFragment(conclusionContractContent) },
    { name: 'evidenceContract.ts', content: verbatimContractFragment(evidenceContractContent) },
    { name: 'claimVerification.ts', content: verbatimContractFragment(claimVerificationContent) },
    { name: 'identityContract.ts', content: identityContractFragment(identityContractContent) },
    {
      name: 'externalIssueReporting.ts',
      content: externalIssueReportingFragment(externalIssueReportingContent),
    },
  ]);
  if (outOfSyncFragments.length > 0) {
    console.log('❌ Analysis quality contract source fragments are OUT OF SYNC!\n');
    for (const name of outOfSyncFragments) {
      console.log(`  ${name}: generated frontend fragment does not match backend source`);
    }
    console.log('\n👉 Run: npm run generate:frontend-types');
    return false;
  }

  // Additional check: verify file was generated (not manually edited)
  const hasAutoGenComment = frontendContent.includes('AUTO-GENERATED from backend/src/types/dataContract.ts');
  if (!hasAutoGenComment) {
    console.log('⚠️  Warning: Frontend types file may have been manually edited.');
    console.log('   The file should contain the AUTO-GENERATED comment.\n');
  }

  console.log('✅ Frontend types are in sync with backend!\n');

  // Print summary
  const types = JSON.parse(expectedTypes);
  console.log('Type summary:');
  console.log(`  ColumnType: ${types.columnTypes.split(' | ').length} values`);
  console.log(`  ColumnFormat: ${types.columnFormats.split(' | ').length} values`);
  console.log(`  ClickAction: ${types.clickActions.split(' | ').length} values`);
  console.log(`  DisplayLayer: ${types.displayLayers.split(' | ').length} values`);
  console.log(`  DisplayLevel: ${types.displayLevels.split(' | ').length} values`);
  console.log(`  DisplayFormat: ${types.displayFormats.split(' | ').length} values`);
  console.log('  ConclusionContract: synced (sceneId/clusterPolicy + analysis_completed reference)');
  console.log('  AnalysisQualityContracts: synced (Evidence/Verifier/Identity + SSE fields)');
  console.log('  ExternalIssueReporting: synced (Opportunity/Review/Draft + attestation)');

  return true;
}

// Run check
checkTypesSync()
  .then(inSync => {
    process.exit(inSync ? 0 : 1);
  })
  .catch(err => {
    console.error('❌ Error during type check:', err);
    process.exit(2);
  });
