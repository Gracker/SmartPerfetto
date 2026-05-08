# SmartPerfetto Data Contract Design

[English](DATA_CONTRACT_DESIGN.en.md) | [中文](DATA_CONTRACT_DESIGN.md)

## Problem Statement

The data flow historically had several contract risks:

1. Type definitions were scattered between backend `DisplayResult` / `LayeredResult` and frontend `SqlQueryResult`.
2. Frontend rendering depended on hardcoded field names.
3. Event naming was inconsistent.
4. YAML display configuration lacked enough runtime validation.
5. Adding new data types required edits in too many places.

## Data Flow

```text
Skill YAML
  -> SkillLoader
  -> SkillExecutor
  -> SSE Stream
  -> Frontend

AI Service
  -> AI Response
  -> Normalizer
  -> Frontend
  -> HTML Report
```

## Design Goals

1. Single source of truth for shared data shapes.
2. Schema-driven type generation and runtime validation.
3. Backward compatibility for incremental field additions.
4. Self-describing data so the frontend does not need hardcoded column behavior.

## Universal Data Envelope

All structured result data should travel inside a DataEnvelope:

```typescript
interface DataEnvelope<T = any> {
  meta: {
    type: DataType;
    version: string;
    source: DataSource;
    timestamp: number;
    skillId?: string;
    sessionId?: string;
  };
  data: T;
  display: {
    layer: DisplayLayer;
    format: DisplayFormat;
    title: string;
    columns?: ColumnDefinition[];
    metadataFields?: string[];
    highlights?: HighlightRule[];
    expandable?: boolean;
  };
}
```

## Contract Rule

When adding new display behavior, update the shared schema and the frontend renderer together. Avoid encoding semantic behavior only in raw data field names.
