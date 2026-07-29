// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

/**
 * Protobuf encoder/decoder for trace_processor HTTP API
 *
 * This module provides utilities for encoding QueryArgs and decoding QueryResult
 * protobuf messages used by trace_processor_shell HTTP API.
 */

/**
 * Encode a varint (variable-length integer)
 */
export function encodeVarint(value: number): Buffer {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Invalid varint value: ${value}`);
  }

  const result: number[] = [];
  while (value > 127) {
    result.push((value % 128) | 0x80);
    value = Math.floor(value / 128);
  }
  result.push(value);
  return Buffer.from(result);
}

/**
 * Decode a varint from buffer at given offset
 * Returns [value, bytesRead]
 */
export function decodeVarint(buf: Buffer, offset: number): [number, number] {
  const [value, bytesRead] = decodeUnsignedVarintBigInt(buf, offset);

  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error('Varint exceeds JavaScript safe integer range');
  }

  return [Number(value), bytesRead];
}

function decodeUnsignedVarintBigInt(buf: Buffer, offset: number): [bigint, number] {
  let value = 0n;
  let shift = 0n;
  let bytesRead = 0;

  while (offset + bytesRead < buf.length) {
    const b = buf[offset + bytesRead];
    bytesRead++;
    value |= BigInt(b & 0x7f) << shift;

    if ((b & 0x80) === 0) {
      return [value, bytesRead];
    }

    shift += 7n;
    if (bytesRead >= 10) {
      throw new Error('Varint too long');
    }
  }

  throw new Error('Truncated varint');
}

function decodeInt64Varint(buf: Buffer, offset: number): [number, number] {
  const [raw, bytesRead] = decodeUnsignedVarintBigInt(buf, offset);
  const signed = raw >= (1n << 63n) ? raw - (1n << 64n) : raw;
  return [Number(signed), bytesRead];
}

/**
 * Encode a string field
 */
export function encodeStringField(fieldNum: number, str: string): Buffer {
  const strBuf = Buffer.from(str, 'utf8');
  const tag = (fieldNum << 3) | 2; // wire type 2 = length-delimited
  return Buffer.concat([
    Buffer.from([tag]),
    encodeVarint(strBuf.length),
    strBuf
  ]);
}

function encodeBytesField(fieldNum: number, bytes: Buffer): Buffer {
  const tag = (fieldNum << 3) | 2; // wire type 2 = length-delimited
  return Buffer.concat([
    Buffer.from([tag]),
    encodeVarint(bytes.length),
    bytes,
  ]);
}

function encodeVarintField(fieldNum: number, value: number): Buffer {
  const tag = (fieldNum << 3) | 0; // wire type 0 = varint
  return Buffer.concat([
    Buffer.from([tag]),
    encodeVarint(value),
  ]);
}

function encodePackedVarintField(fieldNum: number, values: number[]): Buffer {
  const packed = Buffer.concat(values.map(encodeVarint));
  return encodeBytesField(fieldNum, packed);
}

function encodeSignedInt64Varint(value: number): Buffer {
  if (!Number.isSafeInteger(value)) {
    throw new Error(`Invalid int64 varint value: ${value}`);
  }

  let raw = BigInt(value);
  if (raw < 0n) raw += 1n << 64n;

  const result: number[] = [];
  while (raw > 127n) {
    result.push(Number((raw & 0x7fn) | 0x80n));
    raw >>= 7n;
  }
  result.push(Number(raw));
  return Buffer.from(result);
}

function encodePackedSignedInt64Field(fieldNum: number, values: number[]): Buffer {
  const packed = Buffer.concat(values.map(encodeSignedInt64Varint));
  return encodeBytesField(fieldNum, packed);
}

function encodePackedDoubleField(fieldNum: number, values: number[]): Buffer {
  const packed = Buffer.alloc(values.length * 8);
  values.forEach((value, index) => packed.writeDoubleLE(value, index * 8));
  return encodeBytesField(fieldNum, packed);
}

/**
 * Encode QueryArgs protobuf message
 */
export function encodeQueryArgs(sql: string): Buffer {
  // QueryArgs message:
  //   optional string sql_query = 1;
  //   optional string tag = 3;
  return encodeStringField(1, sql);
}

export function decodeQueryArgsSql(buf: Buffer): string {
  let offset = 0;

  while (offset < buf.length) {
    const tag = buf[offset++];
    const fieldNum = tag >> 3;
    const wireType = tag & 0x07;

    if (wireType === 2) {
      const [len, bytesRead] = decodeVarint(buf, offset);
      offset += bytesRead;
      assertLengthDelimitedRange(buf, offset, len);
      if (fieldNum === 1) {
        return buf.slice(offset, offset + len).toString('utf8');
      }
      offset += len;
    } else {
      offset = skipUnknownField(buf, offset, wireType);
    }
  }

  return '';
}

/**
 * Cell types in QueryResult
 */
export enum CellType {
  CELL_INVALID = 0,
  CELL_NULL = 1,
  CELL_VARINT = 2,
  CELL_FLOAT64 = 3,
  CELL_STRING = 4,
  CELL_BLOB = 5,
}

/**
 * Parsed QueryResult
 */
export interface ParsedQueryResult {
  columnNames: string[];
  rows: any[][];
  error?: string;
  statementCount?: number;
  lastStatementSql?: string;
}

export interface EncodableQueryResult {
  columnNames: string[];
  rows: any[][];
  error?: string;
}

function encodeCellsBatch(rows: any[][]): Buffer {
  const cells: CellType[] = [];
  const varintCells: number[] = [];
  const float64Cells: number[] = [];
  const stringCells: string[] = [];
  const blobCells: Buffer[] = [];

  for (const row of rows) {
    for (const value of row) {
      if (value === null || value === undefined) {
        cells.push(CellType.CELL_NULL);
      } else if (Buffer.isBuffer(value)) {
        cells.push(CellType.CELL_BLOB);
        blobCells.push(value);
      } else if (value instanceof Uint8Array) {
        cells.push(CellType.CELL_BLOB);
        blobCells.push(Buffer.from(value));
      } else if (typeof value === 'number' && Number.isSafeInteger(value)) {
        cells.push(CellType.CELL_VARINT);
        varintCells.push(value);
      } else if (typeof value === 'number' && Number.isFinite(value)) {
        cells.push(CellType.CELL_FLOAT64);
        float64Cells.push(value);
      } else if (typeof value === 'boolean') {
        cells.push(CellType.CELL_VARINT);
        varintCells.push(value ? 1 : 0);
      } else {
        cells.push(CellType.CELL_STRING);
        stringCells.push(String(value));
      }
    }
  }

  const fields: Buffer[] = [
    encodePackedVarintField(1, cells),
  ];
  if (varintCells.length > 0) fields.push(encodePackedSignedInt64Field(2, varintCells));
  if (float64Cells.length > 0) fields.push(encodePackedDoubleField(3, float64Cells));
  for (const blob of blobCells) fields.push(encodeBytesField(4, blob));
  if (stringCells.length > 0) fields.push(encodeBytesField(5, Buffer.from(`${stringCells.join('\0')}\0`, 'utf8')));
  fields.push(encodeVarintField(6, 1));
  return Buffer.concat(fields);
}

export function encodeQueryResult(result: EncodableQueryResult): Buffer {
  const fields: Buffer[] = result.columnNames.map(column => encodeStringField(1, column));
  if (result.error) fields.push(encodeStringField(2, result.error));
  if (result.rows.length > 0) fields.push(encodeBytesField(3, encodeCellsBatch(result.rows)));
  return Buffer.concat(fields);
}

/**
 * Parse a packed varint array
 */
function parsePackedVarints(
  buf: Buffer,
  offset: number,
  length: number,
  decoder: (buf: Buffer, offset: number) => [number, number] = decodeVarint,
): number[] {
  const result: number[] = [];
  const end = offset + length;
  if (length < 0 || end > buf.length) {
    throw new Error('Invalid packed varint length');
  }

  while (offset < end) {
    const [value, bytesRead] = decoder(buf, offset);
    result.push(value);
    offset += bytesRead;
  }

  return result;
}

/**
 * Parse a packed double array
 */
function parsePackedDoubles(buf: Buffer, offset: number, length: number): number[] {
  const result: number[] = [];
  const end = offset + length;
  if (length < 0 || end > buf.length || length % 8 !== 0) {
    throw new Error('Invalid packed double length');
  }

  while (offset < end) {
    result.push(buf.readDoubleLE(offset));
    offset += 8;
  }

  return result;
}

function assertLengthDelimitedRange(buf: Buffer, offset: number, length: number): void {
  if (!Number.isSafeInteger(length) || length < 0 || offset + length > buf.length) {
    throw new Error('Invalid length-delimited field length');
  }
}

function skipUnknownField(buf: Buffer, offset: number, wireType: number): number {
  switch (wireType) {
    case 0: {
      const [, bytesRead] = decodeVarint(buf, offset);
      return offset + bytesRead;
    }
    case 1:
      if (offset + 8 > buf.length) throw new Error('Truncated fixed64 field');
      return offset + 8;
    case 2: {
      const [len, bytesRead] = decodeVarint(buf, offset);
      offset += bytesRead;
      assertLengthDelimitedRange(buf, offset, len);
      return offset + len;
    }
    case 5:
      if (offset + 4 > buf.length) throw new Error('Truncated fixed32 field');
      return offset + 4;
    default:
      throw new Error(`Unsupported protobuf wire type: ${wireType}`);
  }
}

/**
 * Parse CellsBatch message
 */
function parseCellsBatch(buf: Buffer, offset: number, length: number): {
  cells: CellType[];
  varintCells: number[];
  float64Cells: number[];
  stringCells: string[];
  blobCells: Buffer[];
  isLastBatch: boolean;
} {
  const end = offset + length;
  let cells: CellType[] = [];
  let varintCells: number[] = [];
  let float64Cells: number[] = [];
  let stringCellsRaw = '';
  const blobCells: Buffer[] = [];
  let isLastBatch = false;

  while (offset < end) {
    const tag = buf[offset++];
    const fieldNum = tag >> 3;
    const wireType = tag & 0x07;

    if (wireType === 2) { // length-delimited
      const [len, bytesRead] = decodeVarint(buf, offset);
      offset += bytesRead;
      assertLengthDelimitedRange(buf, offset, len);

      if (fieldNum === 1) { // cells (packed)
        cells = parsePackedVarints(buf, offset, len).map(v => v as CellType);
      } else if (fieldNum === 2) { // varint_cells (packed)
        varintCells = parsePackedVarints(buf, offset, len, decodeInt64Varint);
      } else if (fieldNum === 3) { // float64_cells (packed)
        float64Cells = parsePackedDoubles(buf, offset, len);
      } else if (fieldNum === 4) { // blob_cells
        blobCells.push(buf.slice(offset, offset + len));
      } else if (fieldNum === 5) { // string_cells
        stringCellsRaw = buf.slice(offset, offset + len).toString('utf8');
      }

      offset += len;
    } else if (wireType === 0) { // varint
      const [value, bytesRead] = decodeVarint(buf, offset);
      offset += bytesRead;

      if (fieldNum === 6) { // is_last_batch
        isLastBatch = value === 1;
      }
    } else {
      offset = skipUnknownField(buf, offset, wireType);
    }
  }

  // Split string cells by NUL terminator.
  // Each string is NUL-terminated, so split produces a trailing empty element which we remove.
  // IMPORTANT: Do NOT filter out empty strings — they are valid cell values (e.g. COALESCE(x, '')).
  // Filtering empties would shift all subsequent string indices.
  const stringCells = stringCellsRaw
    ? stringCellsRaw.split('\0').slice(0, -1)  // remove only the trailing empty from final NUL
    : [];

  return { cells, varintCells, float64Cells, stringCells, blobCells, isLastBatch };
}

/**
 * Decode QueryResult protobuf message
 */
export function decodeQueryResult(
  buf: Buffer,
  limits: {maxRows?: number} = {},
): ParsedQueryResult {
  const columnNames: string[] = [];
  let error: string | undefined;
  const batches: ReturnType<typeof parseCellsBatch>[] = [];
  let statementCount: number | undefined;
  let lastStatementSql: string | undefined;

  let offset = 0;

  while (offset < buf.length) {
    const tag = buf[offset++];
    const fieldNum = tag >> 3;
    const wireType = tag & 0x07;

    if (wireType === 2) { // length-delimited
      const [len, bytesRead] = decodeVarint(buf, offset);
      offset += bytesRead;
      assertLengthDelimitedRange(buf, offset, len);

      if (fieldNum === 1) { // column_names (repeated string)
        columnNames.push(buf.slice(offset, offset + len).toString('utf8'));
      } else if (fieldNum === 2) { // error
        error = buf.slice(offset, offset + len).toString('utf8');
      } else if (fieldNum === 3) { // batch (repeated CellsBatch)
        const batch = parseCellsBatch(buf, offset, len);
        batches.push(batch);
      } else if (fieldNum === 6) { // last_statement_sql
        lastStatementSql = buf.slice(offset, offset + len).toString('utf8');
      }

      offset += len;
    } else if (wireType === 0) { // varint
      const [value, bytesRead] = decodeVarint(buf, offset);
      offset += bytesRead;

      if (fieldNum === 4) { // statement_count
        statementCount = value;
      }
    } else {
      offset = skipUnknownField(buf, offset, wireType);
    }
  }

  // Build rows from batches
  const rows: any[][] = [];
  const numColumns = columnNames.length;

  if (numColumns > 0) {
    const encodedRowCount = batches.reduce(
      (total, batch) => total + Math.ceil(batch.cells.length / numColumns),
      0,
    );
    if (
      limits.maxRows !== undefined
      && (
        !Number.isSafeInteger(limits.maxRows)
        || limits.maxRows < 0
        || encodedRowCount > limits.maxRows
      )
    ) {
      throw new Error('trace_processor_row_budget_exceeded');
    }
    for (const batch of batches) {
      let varintIdx = 0;
      let float64Idx = 0;
      let stringIdx = 0;
      let blobIdx = 0;

      let currentRow: any[] = [];
      let colIdx = 0;

      for (const cellType of batch.cells) {
        let value: any = null;

        switch (cellType) {
          case CellType.CELL_NULL:
            value = null;
            break;
          case CellType.CELL_VARINT:
            value = batch.varintCells[varintIdx++] ?? null;
            break;
          case CellType.CELL_FLOAT64:
            value = batch.float64Cells[float64Idx++] ?? null;
            break;
          case CellType.CELL_STRING:
            value = batch.stringCells[stringIdx++] ?? null;
            break;
          case CellType.CELL_BLOB:
            value = batch.blobCells[blobIdx++] ?? null;
            break;
          default:
            value = null;
        }

        currentRow.push(value);
        colIdx++;

        if (colIdx >= numColumns) {
          rows.push(currentRow);
          currentRow = [];
          colIdx = 0;
        }
      }

      // Handle incomplete row (shouldn't happen normally)
      if (currentRow.length > 0) {
        while (currentRow.length < numColumns) {
          currentRow.push(null);
        }
        rows.push(currentRow);
      }
    }
  }

  return {
    columnNames,
    rows,
    error,
    statementCount,
    lastStatementSql,
  };
}
