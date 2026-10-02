// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)

/**
 * Wording that names a thermal cause or mechanism. A bare 温度 is a
 * measurement label, not a cause; 设备温度 / 温度过高 point at heat as the
 * explanation.
 */
export const THERMAL_CAUSE = /温控|热控|过热|发热|高温|热节流|热降频|热限频|散热|设备温度|温度过高|温度升高|冷却后|thermal/i;

/**
 * Markers that defer the cause when they come before the thermal word in its
 * clause: a negation, an open question, or a condition (是否温控, 不是温控证据,
 * 如果是温控). After the cause they no longer govern it: 温控导致卡顿还需优化代码
 * still asserts heat. One clause, not one sentence: "是温控导致，不是负载" still
 * names heat in its first clause.
 *
 * Accepted residuals: a clause that only refuses to rule heat out (不能排除温控)
 * reads as a deferral, and a condition and its consequence written without a
 * comma (如果频率突降说明温控限频) read as one deferred clause.
 */
const DEFERRAL_BEFORE = /不是|不能|不说明|尚未|是否|如果|若(?!干)/;
/** A contrast after the negation turns it into an assertion: 不是负载而是温控导致. */
const CONTRAST = /而是/;
/**
 * Markers that leave the cause undetermined wherever they sit: 限频与否未判定,
 * 热控风险仍需温度和直接限频证据. A 仍需/还需 that asks for something other
 * than evidence (还需优化代码) leaves the cause standing.
 */
const UNDETERMINED = /未判定|未核验|未确认|不判定|与否|后才能|(?:仍需|还需|需结合)[^，,]*(?:证据|事件|确认|判断)/;
/**
 * A condition on reading thermal or limit evidence (确认由温控触发后，…; 只有限频证据存在时才…)
 * governs the clauses after it in the same sentence. A condition on anything
 * else (若频率持续下降, 确认后台负载正常) does not: the cause after it is still
 * asserted.
 */
const EVIDENCE_CONDITION = /确认[^，,]*(?:证据|温控|限频|触发|温度)[^，,]*后|只有[^，,]*(?:证据|限频|温度)[^，,]*才/;

/** Sentence and clause boundaries; brackets are neither, so a parenthetical stays with its clause. */
const SENTENCE_BOUNDARY = /[。；;]/;
const CLAUSE_BOUNDARY = /[，,：:]/;

function defersCause(clause: string): boolean {
  if (UNDETERMINED.test(clause)) return true;
  const cause = clause.search(THERMAL_CAUSE);
  const deferral = clause.search(DEFERRAL_BEFORE);
  return deferral >= 0 && deferral < cause && !CONTRAST.test(clause.slice(deferral, cause));
}

/**
 * Whether some clause of `text` names a thermal cause without deferring it. An
 * evidence condition covers the clauses that follow it in its sentence, never
 * those before it.
 */
export function namesThermalCause(text: string): boolean {
  for (const sentence of text.split(SENTENCE_BOUNDARY)) {
    for (const clause of sentence.split(CLAUSE_BOUNDARY)) {
      if (EVIDENCE_CONDITION.test(clause)) break;
      if (THERMAL_CAUSE.test(clause) && !defersCause(clause)) return true;
    }
  }
  return false;
}
