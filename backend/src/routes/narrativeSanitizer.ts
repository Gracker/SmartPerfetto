/**
 * Sanitizes assistant narrative text for end users.
 * Keeps human-readable reasoning but removes internal evidence IDs.
 */
import { LEGACY_TO_PLAIN_PHRASE_RULES } from '../utils/analysisNarrative';

const EVIDENCE_ID_RE = /\bev_[0-9a-f]{12}\b/gi;

type PhraseRule = {
  pattern: RegExp;
  replacement: string;
};

type AnnotationRule = {
  term: string;
  plainMeaning: string;
};

const PHRASE_RULES: PhraseRule[] = [
  ...LEGACY_TO_PLAIN_PHRASE_RULES,
  {
    pattern: /(?<!显示系统处理不过来（)SF消费端背压/g,
    replacement: '显示系统处理不过来（SF消费端背压）',
  },
  {
    pattern: /SF\/消费端放大信号存在/g,
    replacement: '显示系统侧存在放大效应',
  },
  {
    pattern: /(?<!线程更多跑在小核上（)核心摆放偏小核/g,
    replacement: '线程更多跑在小核上（核心摆放偏小核）',
  },
  {
    pattern: /(?<!应用没赶上当前刷新周期（)APP 截止超时/g,
    replacement: '应用没赶上当前刷新周期（APP 截止超时）',
  },
];

const ANNOTATION_RULES: AnnotationRule[] = [
  { term: '阻塞等待', plainMeaning: '线程等待锁/IO/Binder' },
  { term: '调度延迟', plainMeaning: '线程排队等CPU' },
  { term: '频率不足', plainMeaning: 'CPU频率偏低' },
];

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function annotateTerm(text: string, rule: AnnotationRule): string {
  const term = escapeRegExp(rule.term);
  const plainMeaning = escapeRegExp(rule.plainMeaning);
  const pattern = new RegExp(`${term}(?!（${plainMeaning}）)`, 'g');
  return text.replace(pattern, `${rule.term}（${rule.plainMeaning}）`);
}

function humanizeNarrativeTerms(text: string): string {
  let out = text;

  for (const rule of PHRASE_RULES) {
    out = out.replace(rule.pattern, rule.replacement);
  }

  for (const rule of ANNOTATION_RULES) {
    out = annotateTerm(out, rule);
  }

  return out;
}

export function sanitizeNarrativeForClient(narrative: string): string {
  let out = String(narrative || '');
  if (!out.trim()) return out;

  // Hide internal evidence index line from user-facing output.
  out = out.replace(/^\s*-\s*证据索引（自动补全）:.*$/gim, '');

  // Remove compact "(ev_xxx|ev_yyy)" groups first to avoid leftover wrappers.
  out = out.replace(
    /[（(]\s*ev_[0-9a-f]{12}(?:\s*[|｜]\s*ev_[0-9a-f]{12})*\s*[）)]/gi,
    ''
  );

  // Remove any remaining standalone evidence IDs.
  out = out.replace(EVIDENCE_ID_RE, '');

  // Remove empty JSON evidence field after evidence-id stripping.
  out = out.replace(/,\s*"evidence"\s*:\s*""/g, '');
  out = out.replace(/"evidence"\s*:\s*"",\s*/g, '');

  // Remove connector-only placeholders left inside parentheses after ID removal.
  // Example: "（ vs ）", "( | )", "（ / ）"
  out = out.replace(/[（(]\s*(?:vs|VS)\s*[）)]/g, '');
  out = out.replace(/[（(]\s*(?:[|｜/:,+-]\s*)+[）)]/g, '');

  // Replace jargon-heavy wording with plain-language phrasing.
  out = humanizeNarrativeTerms(out);

  // Cleanup artifacts introduced by ID removal.
  out = out.replace(/[（(]\s*[）)]/g, '');
  out = out.replace(/[ \t]+$/gm, '');
  out = out.replace(/[ \t]{2,}/g, ' ');
  out = out.replace(/\n{3,}/g, '\n\n');

  return out.trim();
}
