// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

// Whether user-facing Skill text names heat or a frequency cap as a cause.
// The runtime answers in Chinese by default, so both languages are read, word
// by word: a word stands for a cause unless what it modifies says otherwise
// (a deferral, a negated judgement, an undetermined marker, or a reference to
// evidence such as 限频证据). causeWordingEvidence.ts decides which texts need
// evidence and whether a Skill reads it.

/**
 * Wording that names a thermal cause or mechanism. A bare 温度 is a
 * measurement label, not a cause; 设备温度 / 温度过高 point at heat as the
 * explanation.
 */
const THERMAL_CAUSE = /温控|热控|过热|发热|高温|热节流|热降频|热限频|散热|设备温度|温度过高|温度升高|冷却后|thermal/gi;
/**
 * Wording that names a frequency cap: "throttle", 限频, 降频 and 热节流 read
 * as one to any reader, whether or not heat is said to set it. Inside an
 * identifier (min_throttle_ns) it is a name. 频率上限 is not on the list: it
 * names the mechanism, and the Skills list it as one possible source of a
 * frequency observation (可能来自负载、调速器或频率上限); an observed step-down
 * is 频率下调, which says nothing about a cap.
 */
const FREQUENCY_CAP = /throttl[a-z]*|限频|降频|热节流/gi;
/**
 * The cap as a mechanism: 频率上限 asserts a cap only where its clause
 * attributes something to it (频率上限导致卡顿); listed as one possible source
 * of an observation it asserts nothing. Bare 节流 is not on either list: 请求节流
 * and 事件节流 limit a request or event rate, not a clock.
 */
const FREQUENCY_CAP_MECHANISM = /频率上限|频率封顶/g;

/**
 * Markers that defer a thermal word close after them: a negation, an open
 * question, a condition or an instruction to verify (不是温控, 是否为温控,
 * 如果是温控导致, 不能说明温控, 先确认限频与触发方).
 * A thermal word stands by default. A deferral reaches only DEFERRAL_REACH
 * characters and no connective, so 如果频率突降说明温控限频,
 * 不是负载而是温控导致 and 没有负载突增的情况下温控降频 assert heat. After the
 * cause it no longer governs: 温控导致卡顿还需优化代码 still asserts heat.
 * One clause, not one sentence: "是温控导致，不是负载" names heat in its first
 * clause.
 *
 * Missing data is not a deferral either. A thermal word names no cause when it
 * is the evidence that is missing (无散热设备数据, 缺少 thermal 限频轨道), which
 * EVIDENCE_REFERENCE recognises; anywhere else heat stands, including a denied
 * absence such as 这不代表设备没有发生热控.
 */
const DEFERRAL = /不是|不能|不说明|尚未|是否|如果|若(?!干)|先确认|需确认|需要确认|请确认|核实/g;
const DEFERRAL_REACH = 4;
/**
 * A connective between a deferral and the thermal word ends the deferral's
 * reach. One right at the start of the reach is the deferral's own phrase:
 * 不能说明温控, 如果可能是温控导致.
 */
const CONNECTIVE = /而|但|则|因此|所以|因为|即|便|故|且|说明|表明|证明|可见|可能是|就是|应是|实为/;
/**
 * A negated judgement covers its object: 不能据此判定限频或温控,
 * 仅凭频率变化无法判断是否温控. A connective after the verb starts a new
 * proposition (不能判断负载因此是温控).
 */
const NEGATED_JUDGEMENT = /(?:不能|无法|不足以|难以|不可)[^，,]{0,4}?(?:判定|判断|确认|确定|证明|说明|认定|断定|表明|归因)/g;
/** Refusing to rule heat out leaves it standing as a cause: 不能排除温控. */
const DOUBLE_NEGATION = /^(?:排除|否认)/;
/** A deferral that is itself denied: 不意味着不是温控. */
const DENIED_DEFERRAL = /(?:不代表|不意味着|不等于|不表示|并非)[^，,]{0,8}$/;
/** A prohibition on attributing the cause: 不要把性能下降归因于温控, 不得当作限频原因. */
const PROHIBITED_ATTRIBUTION = /(?:不要|不应|不得|避免|切勿|勿)(?:把|将)?[^，,]{0,12}(?:归因于|归咎于|归结为|认定为|判断为|视为|当作)$/;
/**
 * Markers that leave the cause undetermined wherever they sit in its part of
 * the clause: 限频与否未判定, 热控风险仍需温度和直接限频证据. A 仍需/还需 that
 * asks for something other than evidence (还需优化代码) leaves the cause
 * standing, and a contrast ends the part a marker covers: in
 * 温控导致卡顿但触发方未确认 the cause stands and the trigger is undetermined.
 */
const UNDETERMINED = /未判定|未核验|未确认|不判定|与否|后才能|(?:仍需|还需|需结合)[^，,]*(?:证据|事件|确认|判断)/;
/**
 * A condition on reading thermal or limit evidence (确认由温控触发后，…; 只有限频证据存在时才…)
 * governs the clauses after it in the same sentence. A condition on anything
 * else (若频率持续下降, 确认后台负载正常) does not: the cause after it is still
 * asserted.
 */
const EVIDENCE_CONDITION = /确认[^，,]*(?:证据|温控|限频|触发|温度)[^，,]*后|只有[^，,]*(?:证据|限频|温度)[^，,]*才/;

/**
 * A thermal word naming a source of evidence rather than a cause: 温控证据,
 * 散热设备数据, thermal 限频轨道, 热控守护进程. Only a closed set of modifiers
 * may stand between them, and 设备 only right after the thermal word (散热设备),
 * since elsewhere it is what heat acts on (温控让设备降频). It stays a cause
 * when the clause goes on to attribute something to it (温控事件导致卡顿).
 */
const EVIDENCE_REFERENCE = /^\s*(?:限频|档位|状态)?\s*(?:证据|数据|轨道|事件|传感器|守护进程)/;
/**
 * The English counterpart: a thermal or throttle word that only names the
 * component or record it belongs to. The rest of its clause, parentheticals
 * aside, must be a bare noun phrase of such nouns (thermal HAL service process,
 * thermal zone worker thread, thermal-named track or slice, throttling naming);
 * anything said of it (Thermal zone overheated, Thermal HAL is responsible for
 * latency) makes it a cause again.
 */
const ENGLISH_COMPONENT = '(?:hal|zones?|services?|daemons?|managers?|engines?|stacks?|drivers?|components?|extensions?|frameworks?|sensors?|tracks?|counters?|slices?|named|naming|process(?:es)?|threads?|workers?)';
const ENGLISH_COMPONENT_PHRASE = new RegExp(`^[\\s-]*${ENGLISH_COMPONENT}(?:\\s+(?:or|and)?\\s*${ENGLISH_COMPONENT})*\\s*$`, 'i');
const ATTRIBUTION = /导致|引起|造成|所致|使得|拖慢|降低了|限制了/;
/** English negation right before the word: not thermal mitigation, non-thermal reasons, no throttling. */
const ENGLISH_NEGATION = /\b(?:not|no|non|without)[\s-]+(?:an?\s+|the\s+)?$/i;

/** Sentence and clause boundaries; brackets are neither, so a parenthetical stays with its clause. */
const SENTENCE_BOUNDARY = /[。；;]/;
const CLAUSE_BOUNDARY = /[，,：:]/;

/** Contrasts that split a clause into propositions an undetermined marker covers separately. */
const CONTRAST = /但是?|然而|不过|而/g;

/** The part of `clause` around the word at `at`, between the contrasts on either side of it. */
function segmentAround(clause: string, at: number): string {
  let start = 0;
  let end = clause.length;
  for (const contrast of clause.matchAll(CONTRAST)) {
    if (contrast.index! + contrast[0].length <= at) start = contrast.index! + contrast[0].length;
    else if (contrast.index! > at) { end = contrast.index!; break; }
  }
  return clause.slice(start, end);
}

/** Whether the text before a thermal word in its clause defers it. */
function defersCause(before: string): boolean {
  if (PROHIBITED_ATTRIBUTION.test(before)) return true;
  if ([...before.matchAll(NEGATED_JUDGEMENT)].some(judgement =>
    !CONNECTIVE.test(before.slice(judgement.index! + judgement[0].length)))) return true;
  return [...before.matchAll(DEFERRAL)].some(deferral => {
    const between = before.slice(deferral.index! + deferral[0].length);
    if (between.length > DEFERRAL_REACH || DOUBLE_NEGATION.test(between)) return false;
    if (CONNECTIVE.test(between.slice(1))) return false;
    return !DENIED_DEFERRAL.test(before.slice(0, deferral.index));
  });
}

/**
 * Whether a clause names the cause `words` stand for: some word in it is
 * neither deferred nor a source of evidence, and, for a word that names a
 * mechanism only when blamed (`attributedOnly`), has something attributed to it.
 */
function clauseNamesCause(clause: string, words: RegExp, attributedOnly = false): boolean {
  return [...clause.matchAll(words)].some(match => {
    const after = clause.slice(match.index! + match[0].length);
    if (UNDETERMINED.test(segmentAround(clause, match.index!))) return false;
    if (attributedOnly && !ATTRIBUTION.test(after)) return false;
    // An ASCII word inside an identifier or a path (thermal/cdev_update, thermal_zone,
    // ${throttle_events.data.length}) is a name, and so is one touching a wildcard in a
    // pattern written as data (*thermal-engine*): a clause of one whitespace-free run,
    // which **CPU throttled** is not.
    const before = clause.slice(0, match.index);
    const ascii = /^[a-z]/i.test(match[0]);
    const pattern = (/[*%]$/.test(before) || /^[*%]/.test(after)) && !/\s/.test(clause.trim());
    const inName = ascii && (/[\w/]$/.test(before) || /^[\w/]/.test(after) || pattern);
    const coolingDevice = match[0] === '散热' && after.startsWith('设备');
    if (ascii && (ENGLISH_COMPONENT_PHRASE.test(after.replace(/\([^)]*\)/g, ' ')) || ENGLISH_NEGATION.test(before))) return false;
    if ((inName || coolingDevice || EVIDENCE_REFERENCE.test(after)) && !ATTRIBUTION.test(after)) return false;
    return !defersCause(before);
  });
}

/**
 * Whether some clause of `text` names the cause `words` stand for without
 * deferring it. An evidence condition covers the clauses that follow it in its
 * sentence, never those before it.
 */
function namesCause(text: string, words: RegExp, attributedOnly = false): boolean {
  for (const sentence of text.split(SENTENCE_BOUNDARY)) {
    for (const clause of sentence.split(CLAUSE_BOUNDARY)) {
      if (EVIDENCE_CONDITION.test(clause)) break;
      if (clauseNamesCause(clause, words, attributedOnly)) return true;
    }
  }
  return false;
}

/** Whether `text` names heat as a cause. */
export function namesThermalCause(text: string): boolean {
  return namesCause(text, THERMAL_CAUSE);
}

/** Whether `text` names a frequency cap (throttle, 限频, 降频), which only limit evidence can show. */
export function namesFrequencyCap(text: string): boolean {
  return namesCause(text, FREQUENCY_CAP) || namesCause(text, FREQUENCY_CAP_MECHANISM, true);
}
