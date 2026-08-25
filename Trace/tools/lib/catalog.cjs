// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)

const fs = require('node:fs');
const path = require('node:path');
const Ajv2020 = require('ajv/dist/2020');

const {sha256File} = require('./hash.cjs');
const {SUPPORTED_SIGNAL_TYPES} = require('./generator.cjs');
const {skillSqlContract} = require('./skill-sql-contract.cjs');
const yaml = require('js-yaml');

const CASE_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const HASH_PATTERN = /^[a-f0-9]{64}$/;

function listFilesRecursive(root, predicate) {
  if (!fs.existsSync(root)) return [];
  const result = [];
  const stack = [root];
  while (stack.length > 0) {
    const current = stack.pop();
    for (const entry of fs.readdirSync(current, {withFileTypes: true})) {
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(absolute);
      } else if (entry.isFile() && predicate(absolute)) {
        result.push(absolute);
      }
    }
  }
  return result.sort();
}

function parseScalarField(content, field) {
  const pattern = new RegExp(`^${field}:\\s*["']?([^"'\\s#]+)`, 'm');
  return content.match(pattern)?.[1] ?? null;
}

function discoverCoverageTargets(repoRoot) {
  const skillsRoot = path.join(repoRoot, 'backend', 'skills');
  const strategiesRoot = path.join(repoRoot, 'backend', 'strategies');
  const skills = listFilesRecursive(
    skillsRoot,
    (filePath) =>
      filePath.endsWith('.skill.yaml') &&
      !filePath.split(path.sep).includes('_template') &&
      !path.basename(filePath).startsWith('_'),
  ).map((filePath) => {
    const name = parseScalarField(fs.readFileSync(filePath, 'utf8'), 'name');
    if (!name || name.includes('{{') || name.includes('${')) {
      throw new Error(`Skill has no concrete name: ${path.relative(repoRoot, filePath)}`);
    }
    return name;
  });
  const strategies = listFilesRecursive(
    strategiesRoot,
    (filePath) => filePath.endsWith('.strategy.md'),
  ).map((filePath) => {
    const scene = parseScalarField(fs.readFileSync(filePath, 'utf8'), 'scene');
    if (!scene) {
      throw new Error(`Strategy has no scene: ${path.relative(repoRoot, filePath)}`);
    }
    return scene;
  });
  return {
    skills: [...new Set(skills)].sort(),
    strategies: [...new Set(strategies)].sort(),
  };
}

function discoverSkillContracts(repoRoot) {
  const skillsRoot = path.join(repoRoot, 'backend', 'skills');
  const contracts = new Map();
  for (const filePath of listFilesRecursive(
    skillsRoot,
    (candidate) =>
      candidate.endsWith('.skill.yaml') &&
      !candidate.split(path.sep).includes('_template') &&
      !path.basename(candidate).startsWith('_'),
  )) {
    const definition = yaml.load(fs.readFileSync(filePath, 'utf8'));
    if (!definition?.name) continue;
    contracts.set(definition.name, {
      ...skillSqlContract(definition),
      definition,
      source_file: path.relative(repoRoot, filePath).split(path.sep).join('/'),
    });
  }
  return contracts;
}

function runtimePerfettoRevision(repoRoot) {
  const pinPath = path.join(repoRoot, 'scripts/trace-processor-pin.env');
  if (!fs.existsSync(pinPath)) return null;
  return fs.readFileSync(pinPath, 'utf8').match(/^PERFETTO_VERSION=([^\s#]+)$/m)?.[1] ?? null;
}

function loadSqlSourceTruth(repoRoot, issues) {
  const docsPath = path.join(repoRoot, 'backend/data/perfettoSqlDocs.json');
  const runtimeRevision = runtimePerfettoRevision(repoRoot);
  let docs = null;
  try {
    docs = JSON.parse(fs.readFileSync(docsPath, 'utf8'));
  } catch (error) {
    issues.push(issue('perfetto-sql-source-index-invalid', docsPath, error.message));
  }
  if (!runtimeRevision) {
    issues.push(issue(
      'perfetto-runtime-pin-missing',
      path.join(repoRoot, 'scripts/trace-processor-pin.env'),
      'PERFETTO_VERSION is required for SQL source provenance',
    ));
  }
  if (docs?.generatedFrom !== runtimeRevision) {
    issues.push(issue(
      'perfetto-sql-source-revision-mismatch',
      docsPath,
      `Perfetto SQL docs revision ${docs?.generatedFrom ?? '(missing)'} does not match runtime ${runtimeRevision ?? '(missing)'}`,
    ));
  }
  const modules = new Map();
  for (const moduleDoc of Array.isArray(docs?.modules) ? docs.modules : []) {
    if (typeof moduleDoc?.module !== 'string') continue;
    modules.set(moduleDoc.module, moduleDoc);
  }
  return {runtimeRevision, docsPath, modules};
}

function resolveModuleSources(moduleNames, sourceTruth, sourceFile, issues) {
  return moduleNames.map((moduleName) => {
    const moduleDoc = sourceTruth.modules.get(moduleName);
    if (!moduleDoc || typeof moduleDoc.sourcePath !== 'string' || moduleDoc.sourcePath.trim() === '') {
      issues.push(issue(
        'unknown-perfetto-sql-module-source',
        sourceFile,
        `Perfetto SQL module ${moduleName} has no source path at runtime revision ${sourceTruth.runtimeRevision ?? '(missing)'}`,
      ));
      return {name: moduleName, source_path: null};
    }
    return {name: moduleName, source_path: moduleDoc.sourcePath};
  });
}

function discoverPortableSqlContracts(repoRoot, sourceTruth, issues) {
  const packageRoot = path.join(repoRoot, 'backend/sql/smartperfetto');
  const manifestPath = path.join(packageRoot, 'PACKAGE.json');
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch (error) {
    issues.push(issue('portable-sql-package-invalid', manifestPath, error.message));
    return new Map();
  }
  const contracts = new Map();
  for (const symbol of Array.isArray(manifest?.symbols) ? manifest.symbols : []) {
    const sourcePath = path.resolve(packageRoot, String(symbol.module ?? ''));
    const packagePrefix = `${path.resolve(packageRoot)}${path.sep}`;
    if (!sourcePath.startsWith(packagePrefix) || !fs.existsSync(sourcePath)) {
      issues.push(issue(
        'portable-sql-source-missing',
        manifestPath,
        `Portable SQL ${symbol.name ?? '(unnamed)'} has invalid module ${symbol.module ?? '(missing)'}`,
      ));
      continue;
    }
    const sourceFile = path.relative(repoRoot, sourcePath).split(path.sep).join('/');
    const modules = resolveModuleSources(
      Array.isArray(symbol.dependencies) ? symbol.dependencies : [],
      sourceTruth,
      sourceFile,
      issues,
    );
    contracts.set(symbol.name, {
      target: symbol.name,
      source_file: sourceFile,
      sql_name: symbol.sqlName ?? String(symbol.name).replace(/\./g, '_'),
      source_sha256: sha256File(sourcePath),
      modules,
    });
  }
  return contracts;
}

function sameStringSet(actual, expected) {
  if (!Array.isArray(actual)) return false;
  return JSON.stringify([...new Set(actual)].sort()) === JSON.stringify([...new Set(expected)].sort());
}

function caseManifestPaths(repoRoot) {
  const traceRoot = path.join(repoRoot, 'Trace');
  return ['real', 'constructed'].flatMap((kind) =>
    listFilesRecursive(
      path.join(traceRoot, kind),
      (filePath) =>
        path.basename(filePath) === 'case.json' &&
        !path.relative(traceRoot, filePath).split(path.sep).includes('.private'),
    ),
  );
}

function loadCatalog(repoRoot) {
  const cases = caseManifestPaths(repoRoot).map((manifestPath) => {
    let manifest;
    try {
      manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    } catch (error) {
      throw new Error(`Cannot parse ${path.relative(repoRoot, manifestPath)}: ${error.message}`);
    }
    return {
      ...manifest,
      case_dir: path.dirname(manifestPath),
      manifest_path: manifestPath,
    };
  });
  return {cases: cases.sort((a, b) => String(a.id).localeCompare(String(b.id)))};
}

function isSafeCasePath(caseDir, relativePath) {
  if (typeof relativePath !== 'string' || relativePath.length === 0 || path.isAbsolute(relativePath)) {
    return false;
  }
  const resolved = path.resolve(caseDir, relativePath);
  const prefix = `${path.resolve(caseDir)}${path.sep}`;
  return resolved.startsWith(prefix);
}

function issue(code, manifestPath, message) {
  return {code, file: manifestPath, message};
}

function loadPublicationExceptions(repoRoot, validateSchema, formatSchemaErrors, issues) {
  const ledgerPath = path.join(repoRoot, 'Trace/governance/legacy-publication-exceptions.json');
  if (!fs.existsSync(ledgerPath)) return {ledgerPath, exceptions: new Map()};

  let ledger;
  try {
    ledger = JSON.parse(fs.readFileSync(ledgerPath, 'utf8'));
  } catch (error) {
    issues.push(issue('publication-exception-ledger-invalid', ledgerPath, error.message));
    return {ledgerPath, exceptions: new Map()};
  }
  if (!validateSchema(ledger)) {
    issues.push(issue(
      'publication-exception-ledger-invalid',
      ledgerPath,
      formatSchemaErrors(validateSchema.errors),
    ));
  }

  const exceptions = new Map();
  for (const exception of ledger.exceptions ?? []) {
    if (exceptions.has(exception.case_id)) {
      issues.push(issue(
        'duplicate-publication-exception',
        ledgerPath,
        `case ${exception.case_id} has more than one legacy publication exception`,
      ));
      continue;
    }
    exceptions.set(exception.case_id, exception);
  }
  return {ledgerPath, exceptions};
}

function validateRequiredShape(entry, issues) {
  const file = entry.manifest_path;
  if (entry.schema_version !== 1) issues.push(issue('invalid-schema-version', file, 'schema_version must be 1'));
  if (!CASE_ID_PATTERN.test(String(entry.id ?? ''))) issues.push(issue('invalid-case-id', file, 'id must be kebab-case'));
  if (!['real', 'constructed'].includes(entry.kind)) issues.push(issue('invalid-kind', file, 'kind must be real or constructed'));
  for (const field of ['title', 'description', 'scene']) {
    if (typeof entry[field] !== 'string' || entry[field].trim() === '') {
      issues.push(issue('missing-field', file, `${field} must be a non-empty string`));
    }
  }
  if (!entry.trace || !HASH_PATTERN.test(String(entry.trace.sha256 ?? ''))) {
    issues.push(issue('invalid-trace', file, 'trace.sha256 must be a lowercase SHA-256'));
  }
  if (!entry.analysis || !Array.isArray(entry.analysis.results) || !Array.isArray(entry.analysis.logs)) {
    issues.push(issue('invalid-analysis', file, 'analysis.results and analysis.logs must be arrays'));
  }
  if (!entry.coverage || !Array.isArray(entry.coverage.skills) || !Array.isArray(entry.coverage.strategies) || !Array.isArray(entry.coverage.expectations)) {
    issues.push(issue('invalid-coverage', file, 'coverage skills, strategies, and expectations must be arrays'));
  }
  if (entry.kind === 'constructed' && !entry.construction) {
    issues.push(issue('missing-construction', file, 'constructed cases require construction'));
  }
  const expectedParent = path.basename(path.dirname(entry.case_dir));
  if (entry.kind && expectedParent !== entry.kind) {
    issues.push(issue('kind-directory-mismatch', file, `kind ${entry.kind} is stored under ${expectedParent}`));
  }
}

function validatePathsAndHashes(entry, issues) {
  const paths = [
    entry.trace?.file,
    ...(entry.analysis?.results ?? []),
    ...(entry.analysis?.logs ?? []),
    ...(entry.kind === 'constructed' ? [entry.construction?.scenario_file] : []),
  ].filter((value) => value !== undefined);
  for (const relativePath of paths) {
    if (!isSafeCasePath(entry.case_dir, relativePath)) {
      issues.push(issue('unsafe-path', entry.manifest_path, `path escapes case directory: ${relativePath}`));
      continue;
    }
    const absolute = path.resolve(entry.case_dir, relativePath);
    if (!fs.existsSync(absolute) || !fs.statSync(absolute).isFile()) {
      issues.push(issue('missing-file', entry.manifest_path, `missing case file: ${relativePath}`));
    }
  }
  if (isSafeCasePath(entry.case_dir, entry.trace?.file)) {
    const tracePath = path.resolve(entry.case_dir, entry.trace.file);
    if (fs.existsSync(tracePath) && HASH_PATTERN.test(String(entry.trace.sha256 ?? ''))) {
      const actual = sha256File(tracePath);
      if (actual !== entry.trace.sha256) {
        issues.push(issue('hash-mismatch', entry.manifest_path, `trace hash is ${actual}, manifest has ${entry.trace.sha256}`));
      }
    }
  }
}

function validatePublication(entry, publicationExceptions, issues) {
  const source = entry.source ?? {};
  if (source.publication === 'private') {
    issues.push(issue('tracked-private-case', entry.manifest_path, 'private cases belong under ignored Trace/real/.private'));
  }
  if (source.publication === 'public') {
    for (const field of ['license', 'consent']) {
      if (typeof source[field] !== 'string' || source[field].trim() === '') {
        issues.push(issue('incomplete-publication-review', entry.manifest_path, `public case requires source.${field}`));
      }
    }
    for (const field of ['privacy_review', 'sanitization_review']) {
      if (!['approved', 'not-applicable'].includes(source[field])) {
        issues.push(issue('incomplete-publication-review', entry.manifest_path, `public case requires completed source.${field}`));
      }
    }
  }
  if (source.publication === 'legacy-tracked') {
    const exception = publicationExceptions.get(entry.id);
    if (!exception) {
      issues.push(issue(
        'missing-publication-exception',
        entry.manifest_path,
        'legacy-tracked cases require a bounded entry in Trace/governance/legacy-publication-exceptions.json',
      ));
      return;
    }
    const reviewDeadline = Date.parse(`${exception.review_by}T23:59:59.999Z`);
    if (!Number.isFinite(reviewDeadline) || reviewDeadline < Date.now()) {
      issues.push(issue(
        'expired-publication-exception',
        entry.manifest_path,
        `legacy publication exception expired on ${exception.review_by}`,
      ));
    }
  }
}

function validateNoLegacyTraceReferences(repoRoot, issues) {
  const ignoredSegments = new Set(['.git', '.omo', '.worktrees', 'dist', 'node_modules', 'perfetto', 'Trace']);
  const ignoredFiles = new Set([
    path.join(repoRoot, '.claude', 'settings.local.json'),
  ]);
  const ignoredPrefixes = [
    path.join(repoRoot, '.claude', 'worktrees'),
    path.join(repoRoot, 'docs', 'archive'),
    path.join(repoRoot, 'docs', 'superpowers'),
    path.join(repoRoot, 'backend', 'logs'),
    path.join(repoRoot, 'backend', 'test-output'),
    path.join(repoRoot, 'backend', 'uploads'),
    path.join(repoRoot, 'logs'),
    path.join(repoRoot, 'output'),
    path.join(repoRoot, 'test-output'),
  ];
  const textExtensions = new Set([
    '.cjs', '.js', '.json', '.md', '.mjs', '.sh', '.ts', '.tsx', '.yaml', '.yml',
  ]);
  const files = listFilesRecursive(repoRoot, (filePath) => {
    if (ignoredFiles.has(filePath)) return false;
    const relativeSegments = path.relative(repoRoot, filePath).split(path.sep);
    if (relativeSegments.some((segment) => ignoredSegments.has(segment))) return false;
    if (ignoredPrefixes.some((prefix) => filePath.startsWith(`${prefix}${path.sep}`))) return false;
    return textExtensions.has(path.extname(filePath));
  });
  for (const filePath of files) {
    let source;
    try {
      source = fs.readFileSync(filePath, 'utf8');
    } catch (error) {
      // Runtime artifacts may disappear between enumeration and read. Only
      // tolerate that expected race; permission and I/O failures must remain
      // visible to the governance gate.
      if (error && error.code === 'ENOENT') continue;
      throw error;
    }
    if (/test-traces(?:\/|["'])/.test(source)) {
      issues.push(issue(
        'legacy-trace-reference',
        filePath,
        `maintained source must resolve Trace/catalog.json instead of test-traces: ${path.relative(repoRoot, filePath)}`,
      ));
    }
  }
}

function validateCatalog(repoRoot) {
  const catalog = loadCatalog(repoRoot);
  const targets = discoverCoverageTargets(repoRoot);
  const skillContracts = discoverSkillContracts(repoRoot);
  const issues = [];
  const sourceTruth = loadSqlSourceTruth(repoRoot, issues);
  const portableSqlContracts = discoverPortableSqlContracts(repoRoot, sourceTruth, issues);
  const ids = new Map();
  const baseIds = new Set(catalog.cases.filter((entry) => entry.kind === 'real').map((entry) => entry.id));
  const covered = {skills: new Set(), strategies: new Set()};
  const quality = {
    semantic: new Set(),
    execution: new Set(),
    graceful_empty: new Set(),
    unavailable: new Set(),
    negative: new Set(),
    deferred: new Set(),
    definition: new Set(),
  };
  const evidenceTiers = {R1: new Set(), R2: new Set(), R3: new Set()};
  const sqlSourceCoverage = {
    runtime_revision: sourceTruth.runtimeRevision,
    skills: [...skillContracts.entries()].map(([target, contract]) => ({
      target,
      source_file: contract.source_file,
      modules: resolveModuleSources(
        contract.declaredModules,
        sourceTruth,
        contract.source_file,
        issues,
      ),
      steps: contract.sqlSourceSteps.map((step) => ({
        id: step.id,
        sha256: step.sha256,
        required_columns: step.requiredColumns,
      })),
    })),
    portable: [...portableSqlContracts.values()],
  };
  const ajv = new Ajv2020({allErrors: true, strict: false, validateFormats: false});
  const caseSchema = JSON.parse(fs.readFileSync(path.join(repoRoot, 'Trace/schema/case.schema.json'), 'utf8'));
  const scenarioSchema = JSON.parse(fs.readFileSync(path.join(repoRoot, 'Trace/schema/scenario.schema.json'), 'utf8'));
  const publicationExceptionSchema = JSON.parse(fs.readFileSync(
    path.join(repoRoot, 'Trace/schema/legacy-publication-exceptions.schema.json'),
    'utf8',
  ));
  const validateCaseSchema = ajv.compile(caseSchema);
  const validateScenarioSchema = ajv.compile(scenarioSchema);
  const validatePublicationExceptionSchema = ajv.compile(publicationExceptionSchema);
  const publicationLedger = loadPublicationExceptions(
    repoRoot,
    validatePublicationExceptionSchema,
    (errors) => ajv.errorsText(errors, {separator: '; '}),
    issues,
  );
  const usedPublicationExceptions = new Set();
  const schemaSignalTypes = new Set(
    scenarioSchema.properties.signals.items.properties.type.enum,
  );
  for (const signalType of new Set([...schemaSignalTypes, ...SUPPORTED_SIGNAL_TYPES])) {
    if (!schemaSignalTypes.has(signalType) || !SUPPORTED_SIGNAL_TYPES.has(signalType)) {
      issues.push(issue(
        'scenario-signal-contract-drift',
        path.join(repoRoot, 'Trace/schema/scenario.schema.json'),
        `signal type differs between schema and generator: ${signalType}`,
      ));
    }
  }

  for (const entry of catalog.cases) {
    const rawEntry = JSON.parse(fs.readFileSync(entry.manifest_path, 'utf8'));
    if (!validateCaseSchema(rawEntry)) {
      issues.push(issue(
        'case-schema-invalid',
        entry.manifest_path,
        ajv.errorsText(validateCaseSchema.errors, {separator: '; '}),
      ));
    }
    if (entry.kind === 'constructed' && entry.construction?.scenario_file) {
      const scenarioPath = path.join(entry.case_dir, entry.construction.scenario_file);
      try {
        const scenario = JSON.parse(fs.readFileSync(scenarioPath, 'utf8'));
        if (!validateScenarioSchema(scenario)) {
          issues.push(issue(
            'scenario-schema-invalid',
            scenarioPath,
            ajv.errorsText(validateScenarioSchema.errors, {separator: '; '}),
          ));
        }
      } catch (error) {
        issues.push(issue('scenario-schema-invalid', scenarioPath, error.message));
      }
    }
    validateRequiredShape(entry, issues);
    validatePathsAndHashes(entry, issues);
    validatePublication(entry, publicationLedger.exceptions, issues);
    const evidenceTier = entry.source?.evidence_tier;
    const allowedEvidenceTiers = entry.kind === 'constructed' ? ['R3'] : ['R1', 'R2'];
    if (!allowedEvidenceTiers.includes(evidenceTier)) {
      issues.push(issue(
        'case-evidence-tier-mismatch',
        entry.manifest_path,
        `${entry.kind} case ${entry.id} requires evidence tier ${allowedEvidenceTiers.join(' or ')}, got ${evidenceTier ?? '(missing)'}`,
      ));
    } else {
      evidenceTiers[evidenceTier].add(entry.id);
    }
    if (entry.source?.publication === 'legacy-tracked' && publicationLedger.exceptions.has(entry.id)) {
      usedPublicationExceptions.add(entry.id);
    }
    if (ids.has(entry.id)) {
      issues.push(issue('duplicate-case-id', entry.manifest_path, `case id also used by ${ids.get(entry.id)}`));
    } else {
      ids.set(entry.id, entry.manifest_path);
    }
    if (entry.kind === 'constructed' && entry.construction && !baseIds.has(entry.construction.base_case_id)) {
      issues.push(issue('missing-base-case', entry.manifest_path, `unknown base case ${entry.construction.base_case_id}`));
    }
    if (
      entry.kind === 'constructed'
      && entry.construction?.runtime_revision !== sourceTruth.runtimeRevision
    ) {
      issues.push(issue(
        'constructed-runtime-revision-mismatch',
        entry.manifest_path,
        `constructed case ${entry.id} runtime ${entry.construction?.runtime_revision ?? '(missing)'} does not match ${sourceTruth.runtimeRevision ?? '(missing)'}`,
      ));
    }

    const expectationTargets = new Set((entry.coverage?.expectations ?? []).map((item) => `${item.type}:${item.target}`));
    for (const expectation of entry.coverage?.expectations ?? []) {
      if (expectation.type === 'sql') {
        const portableContract = portableSqlContracts.get(expectation.target);
        if (!portableContract) {
          issues.push(issue(
            'unknown-portable-sql-target',
            entry.manifest_path,
            `SQL expectation ${expectation.target} is not declared in backend/sql/smartperfetto/PACKAGE.json`,
          ));
          continue;
        }
        if (
          expectation.source_file !== portableContract.source_file
          || expectation.source_sha256 !== portableContract.source_sha256
        ) {
          issues.push(issue(
            'portable-sql-source-mismatch',
            entry.manifest_path,
            `SQL expectation ${expectation.target} must use ${portableContract.source_file}@${portableContract.source_sha256}`,
          ));
        }
        if (typeof expectation.query !== 'string' || expectation.query.trim() === '') {
          issues.push(issue(
            'portable-sql-query-missing',
            entry.manifest_path,
            `SQL expectation ${expectation.target} requires a result query`,
          ));
        } else if (!new RegExp(`\\b${portableContract.sql_name}\\b`).test(expectation.query)) {
          issues.push(issue(
            'portable-sql-query-target-mismatch',
            entry.manifest_path,
            `SQL expectation ${expectation.target} query must read ${portableContract.sql_name}`,
          ));
        }
        if (expectation.mode === 'semantic') {
          if (!Array.isArray(expectation.required_columns) || expectation.required_columns.length === 0) {
            issues.push(issue(
              'semantic-expectation-without-columns',
              entry.manifest_path,
              `SQL ${expectation.target} requires source-level result columns`,
            ));
          }
          if (!Array.isArray(expectation.assertions) || expectation.assertions.length === 0) {
            issues.push(issue(
              'semantic-expectation-without-assertions',
              entry.manifest_path,
              `SQL ${expectation.target} requires at least one value assertion`,
            ));
          }
        } else if (expectation.mode === 'negative') {
          if (typeof expectation.expected_empty_reason !== 'string' || expectation.expected_empty_reason.trim() === '') {
            issues.push(issue(
              'negative-expectation-without-reason',
              entry.manifest_path,
              `SQL ${expectation.target} requires expected_empty_reason`,
            ));
          }
        } else {
          issues.push(issue(
            'invalid-portable-sql-expectation-mode',
            entry.manifest_path,
            `SQL ${expectation.target} must use semantic or negative mode`,
          ));
        }
        continue;
      }
      if (expectation.type !== 'skill') continue;
      const mode = expectation.mode;
      if (!Object.hasOwn(quality, mode)) {
        issues.push(issue('invalid-expectation-mode', entry.manifest_path, `Skill ${expectation.target} has invalid mode ${mode}`));
        continue;
      }
      quality[mode].add(expectation.target);
      if (
        (mode === 'semantic' || mode === 'execution')
        && expectation.min_rows !== undefined
        && expectation.min_rows < 1
      ) {
        issues.push(issue(
          'positive-expectation-allows-empty',
          entry.manifest_path,
          `Skill ${expectation.target} positive coverage cannot allow ${expectation.min_rows} rows`,
        ));
      }
      if (mode !== 'definition') {
        if (!Array.isArray(expectation.required_steps) || expectation.required_steps.length === 0 || !expectation.semantic_step) {
          issues.push(issue('incomplete-execution-expectation', entry.manifest_path, `Skill ${expectation.target} requires steps and semantic_step`));
        }
      }
      const contract = skillContracts.get(expectation.target);
      if (!contract) {
        issues.push(issue('missing-skill-contract', entry.manifest_path, `Skill ${expectation.target} has no source contract`));
      } else {
        if (expectation.source_file !== contract.source_file) {
          issues.push(issue(
            'skill-source-mismatch',
            entry.manifest_path,
            `Skill ${expectation.target} source_file must be ${contract.source_file}`,
          ));
        }
        const executable = contract.hasRootSql || contract.steps.length > 0;
        if (contract.hasRootSql && contract.hasStepSql) {
          issues.push(issue(
            'ambiguous-root-and-step-sql',
            entry.manifest_path,
            `Skill ${expectation.target} declares both root SQL and step SQL; the runtime contract must choose one execution model`,
          ));
        }
        if (mode === 'definition' && executable) {
          issues.push(issue(
            'sql-skill-definition-only',
            entry.manifest_path,
            `Skill ${expectation.target} has executable SQL/steps but is marked definition-only`,
          ));
        }
        if (mode !== 'definition') {
          if (!sameStringSet(expectation.required_sql_steps, contract.sqlIds)) {
            issues.push(issue(
              'sql-inventory-mismatch',
              entry.manifest_path,
              `Skill ${expectation.target} required_sql_steps must exactly match source SQL: ${contract.sqlIds.join(', ') || '(none)'}`,
            ));
          }
          if (!sameStringSet(expectation.forced_sql_steps ?? [], contract.forcedSqlStepIds)) {
            issues.push(issue(
              'forced-sql-inventory-mismatch',
              entry.manifest_path,
              `Skill ${expectation.target} forced_sql_steps must exactly match conditional read-only SQL: ${contract.forcedSqlStepIds.join(', ') || '(none)'}`,
            ));
          }
          const isolatedProbeIds = (expectation.isolated_sql_probes ?? []).map((item) => item.step);
          const unknownIsolatedProbes = isolatedProbeIds.filter((id) =>
            !contract.conditionOnlySqlStepIds.includes(id));
          if (unknownIsolatedProbes.length > 0) {
            issues.push(issue(
              'unknown-isolated-sql-probe',
              entry.manifest_path,
              `Skill ${expectation.target} has isolated probes outside conditional non-read-only SQL: ${unknownIsolatedProbes.join(', ')}`,
            ));
          }
          const duplicateIsolatedProbes = isolatedProbeIds.filter((id, index) =>
            isolatedProbeIds.indexOf(id) !== index);
          if (duplicateIsolatedProbes.length > 0) {
            issues.push(issue(
              'duplicate-isolated-sql-probe',
              entry.manifest_path,
              `Skill ${expectation.target} repeats isolated probes: ${[...new Set(duplicateIsolatedProbes)].join(', ')}`,
            ));
          }
          const conditionSkipIds = (expectation.expected_condition_skips ?? []).map((item) => item.step);
          const expectedConditionOnlyIds = contract.conditionOnlySqlStepIds
            .filter((id) => !isolatedProbeIds.includes(id));
          if (!sameStringSet(conditionSkipIds, expectedConditionOnlyIds)) {
            issues.push(issue(
              'condition-skip-inventory-mismatch',
              entry.manifest_path,
              `Skill ${expectation.target} expected_condition_skips must exactly match conditional SQL without an isolated probe: ${expectedConditionOnlyIds.join(', ') || '(none)'}`,
            ));
          }
          const requiredStepIds = new Set(expectation.required_steps ?? []);
          if (contract.hasRootSql && !requiredStepIds.has('root')) {
            issues.push(issue('missing-root-sql-step', entry.manifest_path, `Skill ${expectation.target} must execute root SQL`));
          }
          for (const topLevelIndex of new Set(
            contract.sqlIds.length === 0
              ? contract.steps.map((_, index) => index)
              : contract.sqlSteps.map((step) => step.topLevelIndex),
          )) {
            const stepId = contract.steps[topLevelIndex]?.id;
            if (stepId && !requiredStepIds.has(stepId)) {
              issues.push(issue(
                'missing-sql-execution-step',
                entry.manifest_path,
                `Skill ${expectation.target} required_steps omits SQL workflow step ${stepId}`,
              ));
            }
          }
          const unavailableIds = (expectation.expected_unavailable_sql_steps ?? []).map((item) => item.step);
          const unknownUnavailable = unavailableIds.filter((id) => !contract.sqlIds.includes(id));
          if (unknownUnavailable.length > 0) {
            issues.push(issue(
              'unknown-unavailable-sql-step',
              entry.manifest_path,
              `Skill ${expectation.target} declares unknown unavailable SQL: ${unknownUnavailable.join(', ')}`,
            ));
          }
          if (mode === 'semantic') {
            const sourceStep = contract.sqlSourceSteps.find((step) => step.id === expectation.semantic_step);
            if (
              sourceStep?.requiredColumns.length > 0
              && !sameStringSet(expectation.required_columns, sourceStep.requiredColumns)
            ) {
              issues.push(issue(
                'semantic-column-source-mismatch',
                entry.manifest_path,
                `Skill ${expectation.target} columns must match ${expectation.semantic_step}: ${sourceStep.requiredColumns.join(', ')}`,
              ));
            }
          }
        }
      }
      if (mode === 'semantic' && (!Array.isArray(expectation.required_columns) || expectation.required_columns.length === 0)) {
        issues.push(issue(
          'semantic-expectation-without-columns',
          entry.manifest_path,
          `Skill ${expectation.target} requires source-level result columns for semantic coverage`,
        ));
      }
      if (mode === 'negative' && (
        typeof expectation.expected_empty_reason !== 'string'
        || expectation.expected_empty_reason.trim() === ''
      )) {
        issues.push(issue(
          'negative-expectation-without-reason',
          entry.manifest_path,
          `Skill ${expectation.target} requires expected_empty_reason`,
        ));
      }
      if (mode === 'graceful_empty' || mode === 'unavailable' || mode === 'deferred') {
        if (typeof expectation.limitation_reason !== 'string' || expectation.limitation_reason.trim() === '') {
          issues.push(issue('missing-limitation-reason', entry.manifest_path, `Skill ${expectation.target} requires limitation_reason`));
        }
      }
      if (mode === 'unavailable' && (typeof expectation.expected_error !== 'string' || expectation.expected_error.trim() === '')) {
        issues.push(issue('missing-expected-error', entry.manifest_path, `Skill ${expectation.target} requires expected_error`));
      }
    }
    for (const skill of entry.coverage?.skills ?? []) {
      covered.skills.add(skill);
      if (!expectationTargets.has(`skill:${skill}`)) {
        issues.push(issue('coverage-without-expectation', entry.manifest_path, `Skill ${skill} has no executable expectation`));
      }
    }
    for (const strategy of entry.coverage?.strategies ?? []) {
      covered.strategies.add(strategy);
      if (!expectationTargets.has(`strategy:${strategy}`)) {
        issues.push(issue('coverage-without-expectation', entry.manifest_path, `Strategy ${strategy} has no executable expectation`));
      }
    }
  }
  for (const caseId of publicationLedger.exceptions.keys()) {
    if (!usedPublicationExceptions.has(caseId)) {
      issues.push(issue(
        'stale-publication-exception',
        publicationLedger.ledgerPath,
        `case ${caseId} is not a tracked legacy publication`,
      ));
    }
  }
  validateNoLegacyTraceReferences(repoRoot, issues);

  for (const [skillId, contract] of skillContracts) {
    if (contract.sqlIds.length === 0) continue;
    if (!quality.semantic.has(skillId) && !quality.deferred.has(skillId)) {
      issues.push(issue(
        'sql-skill-without-positive-or-deferred-coverage',
        contract.source_file,
        `SQL Skill ${skillId} must have source-column-backed semantic coverage or an explicit deferred contract`,
      ));
    }
  }

  const coverage = {
    missing: {
      skills: targets.skills.filter((id) => !covered.skills.has(id)),
      strategies: targets.strategies.filter((id) => !covered.strategies.has(id)),
    },
    stale: {
      skills: [...covered.skills].filter((id) => !targets.skills.includes(id)).sort(),
      strategies: [...covered.strategies].filter((id) => !targets.strategies.includes(id)).sort(),
    },
    covered: {
      skills: [...covered.skills].filter((id) => targets.skills.includes(id)).sort(),
      strategies: [...covered.strategies].filter((id) => targets.strategies.includes(id)).sort(),
    },
    quality: Object.fromEntries(
      Object.entries(quality).map(([mode, ids]) => [mode, [...ids].filter((id) => targets.skills.includes(id)).sort()]),
    ),
    positive: {
      sql_skills: targets.skills.filter((id) =>
        (skillContracts.get(id)?.sqlIds.length ?? 0) > 0 && quality.semantic.has(id)),
      composition_skills: targets.skills.filter((id) =>
        (skillContracts.get(id)?.sqlIds.length ?? 0) === 0 && quality.execution.has(id)),
    },
    deferred: {
      skills: targets.skills.filter((id) => quality.deferred.has(id) && !quality.semantic.has(id)),
    },
    evidence_tiers: Object.fromEntries(
      Object.entries(evidenceTiers).map(([tier, ids]) => [tier, [...ids].sort()]),
    ),
    sql_sources: sqlSourceCoverage,
  };
  for (const category of ['skills', 'strategies']) {
    for (const id of coverage.missing[category]) {
      issues.push(issue('missing-coverage', null, `${category.slice(0, -1)} ${id} has no case`));
    }
    for (const id of coverage.stale[category]) {
      issues.push(issue('stale-coverage', null, `${category.slice(0, -1)} ${id} no longer exists`));
    }
  }

  return {ok: issues.length === 0, issues, coverage, catalog};
}

function resolveCaseTrace(repoRoot, selector) {
  const catalog = loadCatalog(repoRoot);
  const matches = catalog.cases.filter(
    (entry) => entry.id === selector || (entry.aliases ?? []).includes(selector),
  );
  if (matches.length === 0) throw new Error(`Unknown trace case: ${selector}`);
  if (matches.length > 1) throw new Error(`Ambiguous trace case selector: ${selector}`);
  const entry = matches[0];
  return path.resolve(entry.case_dir, entry.trace.file);
}

module.exports = {
  discoverCoverageTargets,
  loadCatalog,
  resolveCaseTrace,
  validateCatalog,
};
