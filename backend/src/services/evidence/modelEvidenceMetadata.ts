// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)

import {projectEvidenceCaptureMetadataForModel, type EvidenceTableWitness} from './evidenceCapture';
import {investigationMetricBindingForModel} from './investigationEvidenceLedger';

/** Three independent availability facts, never a proof or collection verdict. */
export interface ModelEvidenceMetadata {
  columnUnits?: Readonly<Record<string, string>>;
  modelEvidence: {
    /** Full backing capture, not the current page or complete query/population coverage. */
    captureRows: 'available' | 'empty' | 'unavailable';
    /** At least one safe issued unit; columns absent from columnUnits remain unknown. */
    columnUnits: 'available' | 'unknown';
    /** A private binding with nonempty metrics; does not imply any metric was observed. */
    registeredMetricBinding: 'present' | 'absent' | 'unknown';
  };
}

/** Fresh projection from live witnesses. Input/serialized metadata never supplies these facts. */
export function projectModelEvidenceMetadata(data: unknown, witness?: EvidenceTableWitness): ModelEvidenceMetadata {
  try {
    const {captureRows, columnUnits} = projectEvidenceCaptureMetadataForModel(data, witness);
    return {
      ...(columnUnits ? {columnUnits} : {}),
      modelEvidence: {captureRows, columnUnits: columnUnits ? 'available' : 'unknown',
        registeredMetricBinding: captureRows === 'unavailable' ? 'unknown' : investigationMetricBindingForModel(witness)},
    };
  } catch {
    // Only metadata errors are contained here; callers retain query/auth failure semantics.
    return {modelEvidence: {captureRows: 'unavailable', columnUnits: 'unknown', registeredMetricBinding: 'unknown'}};
  }
}
