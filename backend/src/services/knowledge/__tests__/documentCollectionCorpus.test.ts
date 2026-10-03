// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {afterEach, beforeEach, describe, expect, it} from '@jest/globals';

import {
  convertDocumentCollectionFile,
  createDocumentCollectionGate,
  readDocumentCollection,
  type DocumentCollectionDocument,
} from '../documentCollectionCorpus';

// Placeholder credentials the detector withholds (see secretPatterns.test.ts):
// a keyed literal and an internal URL. Neither is a real secret.
const KEYED = 'password = "hunter2long"';
const INTERNAL_URL = 'https://ci.corp/build/42';
const R = '[REDACTED_SECRET]';

function convert(relativePath: string, raw: string): DocumentCollectionDocument {
  const document = convertDocumentCollectionFile(relativePath, raw);
  if (!document) throw new Error('expected a document');
  return document;
}

function sectionSummary(document: DocumentCollectionDocument) {
  return document.sections.map(section => ({
    heading: section.heading,
    headingPath: section.headingPath,
    lines: [section.startLine, section.endLine],
  }));
}

function allText(document: DocumentCollectionDocument): string {
  return [
    document.title,
    ...document.sections.flatMap(section => [
      section.heading,
      ...section.headingPath,
      section.body,
      ...section.chunks.map(chunk => chunk.body),
    ]),
  ].join('\n');
}

describe('document conversion', () => {
  it('reads Markdown headings, frontmatter title and CRLF line numbers', () => {
    const document = convert('guide/render.md', [
      '---',
      'title: Render Guide',
      '---',
      '',
      '# Intro',
      'text one',
      '',
      '## Threads',
      '```',
      '# not a heading',
      '',
      'code',
      '```',
      '',
      'Setext Title',
      '============',
      'after',
    ].join('\r\n'));

    expect(document.title).toBe('Render Guide');
    expect(sectionSummary(document)).toEqual([
      {heading: 'Intro', headingPath: ['Intro'], lines: [5, 6]},
      {heading: 'Threads', headingPath: ['Intro', 'Threads'], lines: [8, 13]},
      {heading: 'Setext Title', headingPath: ['Setext Title'], lines: [15, 17]},
    ]);
    expect(document.sections[1]!.chunks).toHaveLength(1);
    expect(document.sections[1]!.chunks[0]!.body).toContain('# not a heading');
  });

  it('keeps a frontmatter offset and lone carriage returns in line numbers', () => {
    const document = convert('notes.mdx', '---\rtitle: X\r---\r\r# Head\rbody\r');
    expect(sectionSummary(document)).toEqual([{heading: 'Head', headingPath: ['Head'], lines: [5, 6]}]);
  });

  it('strips HTML tags, decodes entities and maps multi-line elements to source lines', () => {
    const document = convert('site/page.html', [
      '<html><head><title>Page &amp; Title</title>',
      '<script>var hidden = 1;</script></head><body>',
      '<h1>Top</h1>',
      '<p>first &lt;para&gt;</p>',
      '<h2',
      '  class="x">Two',
      'lines</h2><p>second</p>',
      '<!-- a comment -->',
      '</body></html>',
    ].join('\n'));

    expect(document.title).toBe('Page & Title');
    expect(sectionSummary(document)).toEqual([
      {heading: 'Top', headingPath: ['Top'], lines: [3, 4]},
      {heading: 'Two lines', headingPath: ['Top', 'Two lines'], lines: [6, 7]},
    ]);
    expect(allText(document)).toContain('first <para>');
    expect(allText(document)).not.toContain('hidden');
    expect(allText(document)).not.toContain('comment');
  });

  it('reads reST adornment levels in order of appearance and AsciiDoc levels by marker', () => {
    const rst = convert('a.rst', [
      '=====',
      'Title',
      '=====',
      '',
      'Intro',
      '',
      'Part A',
      '------',
      'text a',
      '',
      'Part B',
      '------',
      'text b',
    ].join('\n'));
    expect(sectionSummary(rst)).toEqual([
      {heading: 'Title', headingPath: ['Title'], lines: [1, 5]},
      {heading: 'Part A', headingPath: ['Title', 'Part A'], lines: [7, 9]},
      {heading: 'Part B', headingPath: ['Title', 'Part B'], lines: [11, 13]},
    ]);

    const adoc = convert('b.adoc', ['= Doc', '', '== Part', '----', '== inside listing', '----', 'text'].join('\n'));
    expect(adoc.title).toBe('Doc');
    expect(sectionSummary(adoc)).toEqual([
      {heading: 'Doc', headingPath: ['Doc'], lines: [1, 1]},
      {heading: 'Part', headingPath: ['Doc', 'Part'], lines: [3, 7]},
    ]);
  });

  it('keeps duplicate headings as separate sections and treats plain text as one section', () => {
    const document = convert('dup.md', '# Notes\na\n\n# Notes\nb\n');
    expect(sectionSummary(document)).toEqual([
      {heading: 'Notes', headingPath: ['Notes'], lines: [1, 2]},
      {heading: 'Notes', headingPath: ['Notes'], lines: [4, 5]},
    ]);
    const text = convert('readme.txt', 'plain line one\n# not a heading in text\n');
    expect(text.title).toBe('readme');
    expect(sectionSummary(text)).toEqual([{heading: '', headingPath: [], lines: [1, 2]}]);
  });

  it('returns nothing for a document without text', () => {
    expect(convertDocumentCollectionFile('empty.md', '---\ntitle: Only\n---\n\n  \n')).toBeUndefined();
    expect(convertDocumentCollectionFile('empty.html', '<html><body><p> </p></body></html>')).toBeUndefined();
  });
});

describe('redaction before chunking', () => {
  it('redacts the raw file, the converted text, titles and heading paths before any chunk is cut', () => {
    const markdown = convert('cred.md', [
      '---',
      `title: Build ${INTERNAL_URL}`,
      '---',
      `# Deploy ${INTERNAL_URL}`,
      KEYED,
      '',
      'password =',
      '  "hunter2long"',
    ].join('\n'));
    // HTML hides the key and value from the raw pass; only the converted text joins them.
    const html = convert('cred.html', '<h1>Login</h1><p>password = &quot;hunter2long&quot;</p>');
    for (const document of [markdown, html]) {
      expect(allText(document)).not.toContain('hunter2long');
      expect(allText(document)).not.toContain('ci.corp');
      expect(allText(document)).toContain(R);
    }
    expect(markdown.title).toBe(`Build ${R}`);
    expect(markdown.sections[0]!.headingPath).toEqual([`Deploy ${R}`]);
    // Redaction keeps line breaks, so the multi-line value keeps its lines.
    expect(sectionSummary(markdown)).toEqual([
      {heading: `Deploy ${R}`, headingPath: [`Deploy ${R}`], lines: [4, 8]},
    ]);
  });
});

describe('chunking', () => {
  const paragraph = (index: number) => `Paragraph ${index} ${'word '.repeat(60).trim()}`;

  it('cuts long sections at paragraph boundaries with a bounded line overlap', () => {
    const body = Array.from({length: 12}, (_, index) => paragraph(index)).join('\n\n');
    const document = convert('long.md', `# Long\n\n${body}\n`);
    const chunks = document.sections[0]!.chunks;
    expect(chunks.length).toBeGreaterThan(2);
    for (const chunk of chunks) expect(chunk.body.length).toBeLessThanOrEqual(1_200 + 150 + 2);
    for (let index = 1; index < chunks.length; index += 1) {
      const previousLines = chunks[index - 1]!.body.split('\n');
      const lastLine = previousLines[previousLines.length - 1]!;
      if (lastLine.length < 150) expect(chunks[index]!.body.startsWith(lastLine)).toBe(true);
      expect(chunks[index]!.startLine).toBeLessThanOrEqual(chunks[index]!.endLine);
    }
    expect(chunks.map(chunk => chunk.ordinal)).toEqual(chunks.map((_, index) => index));
  });

  it('keeps a fenced block whole up to twice the chunk size and splits a larger one at line boundaries', () => {
    const fenced = (lines: number) => ['```', ...Array.from({length: lines}, (_, index) =>
      `line ${index} alpha beta gamma delta epsilon zeta theta`), '```'].join('\n');
    const whole = convert('code.md', `# Code\n\nintro\n\n${fenced(40)}\n`);
    const fenceChunk = whole.sections[0]!.chunks.find(chunk => chunk.body.includes('line 0 '));
    expect(fenceChunk?.body).toContain('line 39 ');
    expect(fenceChunk!.body.length).toBeGreaterThan(1_200);

    const split = convert('big.md', `# Big\n\n${fenced(120)}\n`);
    const chunks = split.sections[0]!.chunks;
    expect(chunks.length).toBeGreaterThan(3);
    for (const chunk of chunks) {
      expect(chunk.body.length).toBeLessThanOrEqual(1_200 + 150 + 2);
      for (const line of chunk.body.split('\n')) {
        if (line.startsWith('line ')) expect(line).toMatch(/^line \d+ alpha beta gamma delta epsilon zeta theta$/);
      }
    }
  });

  it('gives each length slice of a long converted HTML line the source lines of its own characters', () => {
    // A heading is one converted line whatever source lines it spans; this one
    // spans three of about 900 characters each, so its 1,200-character slices
    // begin on lines 1, 2 and 3. A redaction inside line 2 keeps the slices
    // around it exact.
    const document = convert('long-heading.html', [
      `<h1>${'alpha '.repeat(150)}`,
      `${'beta '.repeat(90)} ${KEYED} ${'beta '.repeat(85)}`,
      `${'gamma '.repeat(150)}</h1>`,
    ].join('\n'));
    const chunks = document.sections[0]!.chunks;
    expect(allText(document)).not.toContain('hunter2long');
    expect(chunks.map(chunk => [chunk.startLine, chunk.endLine])).toEqual([[1, 2], [2, 3], [3, 3]]);
    expect(sectionSummary(document)[0]!.lines).toEqual([1, 3]);
  });

  it('cuts an overlong single line by length and keeps its line range', () => {
    const document = convert('one-line.txt', `${'lorem ipsum '.repeat(250)}\n`);
    const chunks = document.sections[0]!.chunks;
    expect(chunks.length).toBe(3);
    expect(chunks.every(chunk => chunk.startLine === 1 && chunk.endLine === 1)).toBe(true);
  });
});

describe('reading a previewed collection', () => {
  let tmpDir: string;
  const originalRoots = process.env.SMARTPERFETTO_KNOWLEDGE_ROOTS;

  beforeEach(() => {
    tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'document-collection-corpus-')));
    process.env.SMARTPERFETTO_KNOWLEDGE_ROOTS = tmpDir;
  });

  afterEach(() => {
    if (originalRoots === undefined) delete process.env.SMARTPERFETTO_KNOWLEDGE_ROOTS;
    else process.env.SMARTPERFETTO_KNOWLEDGE_ROOTS = originalRoots;
    fs.rmSync(tmpDir, {recursive: true, force: true});
  });

  function write(relativePath: string, content: string | Buffer): void {
    const filePath = path.join(tmpDir, relativePath);
    fs.mkdirSync(path.dirname(filePath), {recursive: true});
    fs.writeFileSync(filePath, content);
  }

  it('counts skip reasons and fingerprints indexed documents by path and content', async () => {
    write('a.md', '# A\nalpha\n');
    write('nested/b.html', '<h1>B</h1><p>beta</p>');
    write('blank.txt', '   \n');
    write('image.png', 'not a document');
    write('large.md', `# L\n${'z'.repeat(210 * 1024)}`);
    write('.env.md', 'excluded by name');
    const gate = createDocumentCollectionGate();
    const preview = await gate.preview(tmpDir);
    const summary = await readDocumentCollection(preview, gate.getSourceReadLimits());

    expect(summary).toEqual(expect.objectContaining({
      documentCount: 2,
      skipped: {extension_not_allowed: 1, file_too_large: 1, excluded: 1, empty_text: 1},
    }));
    const again = await readDocumentCollection(await gate.preview(tmpDir), gate.getSourceReadLimits());
    expect(again.contentFingerprint).toBe(summary.contentFingerprint);
    write('a.md', '# A\nchanged\n');
    const changed = await readDocumentCollection(await gate.preview(tmpDir), gate.getSourceReadLimits());
    expect(changed.contentFingerprint).not.toBe(summary.contentFingerprint);
  });

  it('reports a collection with nothing indexable as zero documents', async () => {
    write('blank.md', '\n\n');
    write('data.json', '{}');
    const gate = createDocumentCollectionGate();
    const summary = await readDocumentCollection(await gate.preview(tmpDir), gate.getSourceReadLimits());
    expect(summary.documentCount).toBe(0);
    expect(summary.skipped).toEqual({empty_text: 1, extension_not_allowed: 1});
  });

  it('skips a file replaced or grown after the preview instead of reading it', async () => {
    write('a.md', '# A\nalpha\n');
    write('b.md', '# B\nbeta\n');
    write('c.md', '# C\ngamma\n');
    write('outside-target.md', '# Elsewhere\n');
    const gate = createDocumentCollectionGate();
    const preview = await gate.preview(tmpDir);
    fs.rmSync(path.join(tmpDir, 'b.md'));
    fs.symlinkSync(path.join(tmpDir, 'outside-target.md'), path.join(tmpDir, 'b.md'));
    fs.appendFileSync(path.join(tmpDir, 'c.md'), 'w'.repeat(210 * 1024));
    const documents: string[] = [];
    const summary = await readDocumentCollection(preview, gate.getSourceReadLimits(), {
      onBatch: batch => documents.push(...batch.map(document => document.relativePath)),
    });
    expect(documents).toEqual(['a.md', 'outside-target.md']);
    expect(summary.skipped).toEqual({read_failed: 1, file_too_large: 1});
  });

  it('yields between batches and stops when the batch hook throws', async () => {
    for (let index = 0; index < 70; index += 1) write(`doc-${String(index).padStart(2, '0')}.md`, `# D${index}\nbody\n`);
    const gate = createDocumentCollectionGate();
    const preview = await gate.preview(tmpDir);
    const batches: number[] = [];
    await readDocumentCollection(preview, gate.getSourceReadLimits(), {
      onBatch: batch => batches.push(batch.length),
    });
    expect(batches).toEqual([32, 32, 6]);

    let calls = 0;
    await expect(readDocumentCollection(preview, gate.getSourceReadLimits(), {
      beforeBatch: () => {
        calls += 1;
        if (calls === 2) throw new Error('lease_lost_for_test');
      },
    })).rejects.toThrow('lease_lost_for_test');
  });
});
