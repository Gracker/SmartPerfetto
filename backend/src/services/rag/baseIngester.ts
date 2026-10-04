// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {createHash} from 'crypto';
import * as path from 'path';

import type {RagChunk} from '../../types/sparkContracts';

export interface SourceChunk {
  text: string;
  startLine: number;
  endLine: number;
  symbol?: string;
}

export function estimateTokenCount(text: string): number {
  return Math.max(1, Math.round(text.length / 4));
}

export function stableChunkId(parts: readonly unknown[], length = 16): string {
  return createHash('sha256')
    .update(parts.map(part => String(part)).join('|'))
    .digest('hex')
    .slice(0, length);
}

export function languageForPath(relativePath: string): NonNullable<RagChunk['language']> {
  const ext = path.extname(relativePath);
  if (ext === '.kt' || ext === '.kts') return 'kotlin';
  if (ext === '.java') return 'java';
  if (ext === '.c') return 'c';
  if (ext === '.cc' || ext === '.cpp' || ext === '.cxx' || ext === '.h' || ext === '.hpp') return 'cpp';
  if (ext === '.rs') return 'rust';
  if (ext === '.go') return 'go';
  if (ext === '.py') return 'py';
  return 'unknown';
}

export function detectSourceSymbol(line: string): string | undefined {
  const classMatch = line.match(/\b(?:class|object|interface|enum\s+class|struct)\s+([A-Za-z_][A-Za-z0-9_]*)/);
  if (classMatch?.[1]) return classMatch[1];
  const kotlinFun = line.match(/\bfun\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/);
  if (kotlinFun?.[1]) return kotlinFun[1];
  const cLikeFunction = line.match(/\b(?:[A-Za-z_][A-Za-z0-9_:<>~*&\s]+)\s+([A-Za-z_~][A-Za-z0-9_:~]*)\s*\([^;]*\)\s*(?:const\s*)?(?:noexcept\s*)?(?:override\s*)?\{/);
  if (cLikeFunction?.[1]) return cLikeFunction[1].split('::').pop();
  const javaMethod = line.match(/\b(?:public|private|protected|internal|static|final|suspend|override|\s)+[A-Za-z0-9_<>,.?[\]\s]+\s+([A-Za-z_][A-Za-z0-9_]*)\s*\([^;]*\)\s*\{/);
  return javaMethod?.[1];
}

export function chunkSourceBySymbols(content: string, maxChars: number): SourceChunk[] {
  const normalized = content.replace(/\r\n?/g, '\n');
  if (normalized.trim().length === 0) return [];
  const lines = normalized.split('\n');
  const boundaries = new Set<number>([0]);
  for (let i = 0; i < lines.length; i++) {
    if (detectSourceSymbol(lines[i])) boundaries.add(i);
  }
  boundaries.add(lines.length);
  const sorted = Array.from(boundaries).sort((a, b) => a - b);
  const sections: SourceChunk[] = [];
  for (let i = 0; i < sorted.length - 1; i++) {
    const start = sorted[i];
    const end = sorted[i + 1];
    if (end <= start) continue;
    const text = lines.slice(start, end).join('\n').trim();
    if (!text) continue;
    sections.push({
      text,
      startLine: start + 1,
      endLine: end,
      symbol: detectSourceSymbol(lines[start]),
    });
  }

  const out: SourceChunk[] = [];
  for (const section of sections) {
    if (section.text.length <= maxChars * 2) {
      out.push(section);
      continue;
    }
    const sectionLines = section.text.split('\n');
    let startLine = section.startLine;
    let buf: string[] = [];
    let bufChars = 0;
    for (const line of sectionLines) {
      if (bufChars === 0 && line.length > maxChars) {
        let cursor = 0;
        while (cursor < line.length) {
          const piece = line.slice(cursor, cursor + maxChars);
          out.push({
            text: piece,
            startLine,
            endLine: startLine,
            symbol: section.symbol,
          });
          cursor += maxChars;
        }
        startLine += 1;
        continue;
      }
      if (bufChars > 0 && bufChars + line.length + 1 > maxChars) {
        out.push({
          text: buf.join('\n'),
          startLine,
          endLine: startLine + buf.length - 1,
          symbol: section.symbol,
        });
        startLine += buf.length;
        buf = [];
        bufChars = 0;
      }
      buf.push(line);
      bufChars += line.length + 1;
    }
    if (buf.length > 0) {
      out.push({
        text: buf.join('\n'),
        startLine,
        endLine: startLine + buf.length - 1,
        symbol: section.symbol,
      });
    }
  }
  return out;
}
