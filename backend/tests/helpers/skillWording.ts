// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)

/**
 * Wording that names a thermal cause or mechanism. A bare 温度 is a
 * measurement label, not a cause; 设备温度 / 温度过高 point at heat as the
 * explanation.
 */
export const THERMAL_CAUSE = /温控|热控|过热|发热|高温|热节流|热降频|热限频|散热|设备温度|温度过高|温度升高|冷却后|thermal/i;

/**
 * Negations that defer a frequency cause to the limit evidence, or leave a
 * limit's trigger open: they name no cause.
 */
export const LIMIT_DEFERRALS: readonly string[] = [
  '不是限频或温控证据',
  '不能据此判定限频或温控',
  '不能说明温控或限频',
  '不判定限频或温控',
  '不说明是否由温控触发',
  '由温控还是功耗/厂商策略触发尚未',
];

/** Whether `text` names a thermal cause once the deferral negations are removed. */
export function namesThermalCause(text: string): boolean {
  return THERMAL_CAUSE.test(LIMIT_DEFERRALS.reduce((rest, deferral) => rest.split(deferral).join(''), text));
}
