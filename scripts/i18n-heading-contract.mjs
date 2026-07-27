// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import fs from 'node:fs';
import path from 'node:path';

export const PAIRED_HEADING_MARKER = '<!-- i18n-headings: paired -->';

export function headingLevels(source) {
  return source
    .split(/\r?\n/u)
    .filter(line => /^#{1,6}\s+/u.test(line))
    .map(line => line.match(/^#+/u)[0].length);
}

function walkMarkdown(directory) {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, {withFileTypes: true}).flatMap(entry => {
    const absolutePath = path.join(directory, entry.name);
    return entry.isDirectory()
      ? walkMarkdown(absolutePath)
      : entry.isFile() && entry.name.endsWith('.md')
        ? [absolutePath]
        : [];
  });
}

function counterpartFor(filePath) {
  return filePath.endsWith('.en.md')
    ? filePath.slice(0, -'.en.md'.length) + '.md'
    : filePath.slice(0, -'.md'.length) + '.en.md';
}

export function pairedHeadingErrors(repositoryRoot) {
  const docsRoot = path.join(repositoryRoot, 'docs');
  const markedFiles = walkMarkdown(docsRoot).filter(filePath =>
    fs.readFileSync(filePath, 'utf8').includes(PAIRED_HEADING_MARKER),
  );
  const seen = new Set();
  const errors = [];

  for (const filePath of markedFiles) {
    const counterpart = counterpartFor(filePath);
    const pairKey = [filePath, counterpart].sort().join('\0');
    if (seen.has(pairKey)) continue;
    seen.add(pairKey);

    const relativeFile = path.relative(repositoryRoot, filePath);
    const relativeCounterpart = path.relative(repositoryRoot, counterpart);
    if (!fs.existsSync(counterpart)) {
      errors.push(`${relativeFile} declares paired headings but ${relativeCounterpart} is missing`);
      continue;
    }

    const source = fs.readFileSync(filePath, 'utf8');
    const counterpartSource = fs.readFileSync(counterpart, 'utf8');
    if (!counterpartSource.includes(PAIRED_HEADING_MARKER)) {
      errors.push(
        `${relativeFile} declares paired headings but ${relativeCounterpart} does not`,
      );
      continue;
    }

    const levels = headingLevels(source);
    const counterpartLevels = headingLevels(counterpartSource);
    if (JSON.stringify(levels) !== JSON.stringify(counterpartLevels)) {
      errors.push(
        `${relativeFile} and ${relativeCounterpart} have different heading structures ` +
          `(${levels.length} vs ${counterpartLevels.length})`,
      );
    }
  }

  return errors;
}
