# Prompt Engineering Standard Operating Procedure

## Overview

SmartPerfetto uses a centralized prompt engineering system to generate AI-powered SQL queries and analysis summaries. The `PromptTemplateService` manages all prompt templates, ensuring consistent, optimized prompts for different analysis scenarios.

## Architecture

### Core Components

1. **PromptTemplateService** (`/backend/src/services/promptTemplateService.ts`)
   - Singleton service for managing prompt templates
   - Provides template retrieval and formatting
   - Handles variable substitution

2. **PROMPTS Configuration** (`/backend/src/config/prompts.ts`)
   - Centralized prompt definitions
   - Categorized by use case (SQL generation, analysis, error recovery)
   - Optimized for Perfetto trace analysis

3. **Template Variables**
   - Dynamic placeholder system
   - Supports schema, question, context, SQL, error, explanation, examples, and custom variables
   - Type-safe variable substitution

## Prompt Categories

### 1. SQL Generation Prompts

#### Basic SQL Generation
**Purpose**: Generate simple Perfetto SQL queries

**Template**: `PROMPTS.SQL_GENERATION.basic`

**Variables**:
- `{query}`: User's natural language question

**Example**:
```typescript
PROMPTS.SQL_GENERATION.basic
  .replace('{query}', 'Show me startup times')

// Output:
// Generate a Perfetto SQL query for: Show me startup times
//
// Rules:
// - Use ONLY existing Perfetto tables
// - Return ONLY the SQL query
// - Convert timestamps: ts / 1e6 for milliseconds
```

**Use Cases**:
- Simple table queries
- Basic filtering and aggregation
- Quick exploratory analysis

#### Context-Aware SQL Generation
**Purpose**: Generate SQL with additional context

**Template**: `PROMPTS.SQL_GENERATION.withContext`

**Variables**:
- `{query}`: User's question
- `{package}`: Target package name
- `{timeRange}`: Analysis time range

**Example**:
```typescript
PROMPTS.SQL_GENERATION.withContext
  .replace('{query}', 'Analyze memory usage')
  .replace('{package}', 'com.example.app')
  .replace('{timeRange}', '0-10s')

// Output:
// Generate a Perfetto SQL query for: Analyze memory usage
//
// Context:
// - Package: com.example.app
// - Time Range: 0-10s
//
// Rules:
// - Use ONLY existing Perfetto tables
// - Return ONLY the SQL query
```

**Use Cases**:
- Package-specific analysis
- Time-bounded queries
- Multi-variable filtering

#### Schema-Guided SQL Generation
**Purpose**: Generate SQL with full schema awareness

**Template**: `PROMPTS.SQL_GENERATION.withSchema`

**Variables**:
- `{query}`: User's question
- `{schema}`: Database schema (tables and columns)

**Example**:
```typescript
const schema = `
- process: pid, name, uid
- thread: tid, name, upid
- slice: id, ts, dur, name, track_id
`;

PROMPTS.SQL_GENERATION.withSchema
  .replace('{query}', 'Find slow functions')
  .replace('{schema}', schema)

// Output:
// Generate a Perfetto SQL query for: Find slow functions
//
// Available Schema:
// - process: pid, name, uid
// - thread: tid, name, upid
// - slice: id, ts, dur, name, track_id
//
// Rules:
// - Use ONLY the tables listed above
// - Return ONLY the SQL query
```

**Use Cases**:
- Complex multi-table queries
- JOIN operations
- Accurate column name selection

### 2. Analysis Prompts

#### Basic Analysis Summary
**Purpose**: Generate concise performance summaries

**Template**: `PROMPTS.ANALYSIS_SUMMARY.basic`

**Variables**:
- `{results}`: SQL query results (JSON/table)

**Structure**:
```
Summarize the analysis results:
{results}

Include:
1. Key findings
2. Performance impact
3. Recommendations
```

**Use Cases**:
- Quick overview
- Single-metric analysis
- Simple trend identification

#### Detailed Analysis Summary
**Purpose**: Generate comprehensive performance reports

**Template**: `PROMPTS.ANALYSIS_SUMMARY.detailed`

**Variables**:
- `{results}`: Query results
- `{schema}`: Optional schema context

**Structure**:
```
Provide a detailed performance analysis:
{results}

Include:
1. Executive Summary
2. Detailed Findings
3. Root Cause Analysis
4. Recommendations
5. SQL queries for further investigation
```

**Use Cases**:
- Multi-metric analysis
- Performance regression investigations
- Root cause analysis
- Performance reports

### 3. Error Recovery Prompts

#### Syntax Error Fix
**Purpose**: Fix SQL syntax errors

**Template**: `PROMPTS.ERROR_FIX.syntax`

**Variables**:
- `{sql}`: Failed SQL query
- `{error}`: Error message from trace processor

**Example**:
```typescript
PROMPTS.ERROR_FIX.syntax
  .replace('{sql}', 'SELECT * FROM procss')
  .replace('{error}', "No such table: procss")

// Output:
// Fix this SQL syntax error:
// SELECT * FROM procss
// Error: No such table: procss
```

**Strategy**:
1. Identify error type (table, column, syntax)
2. Suggest correction based on schema
3. Explain the fix
4. Provide corrected query

**Common Fixes**:
- Table name typos
- Column name corrections
- Missing JOIN conditions
- Invalid syntax

#### No Results Adjustment
**Purpose**: Adjust queries that return empty results

**Template**: `PROMPTS.ERROR_FIX.noResults`

**Variables**:
- `{sql}`: Query that returned 0 rows

**Example**:
```typescript
PROMPTS.ERROR_FIX.noResults
  .replace('{sql}', 'SELECT * FROM slice WHERE name = "NonExistent"')

// Output:
// This query returned no results:
// SELECT * FROM slice WHERE name = "NonExistent"
//
// Suggest an alternative approach.
```

**Strategy**:
1. Analyze WHERE conditions
2. Suggest relaxing filters
3. Try different tables
4. Use LIKE instead of =
5. Remove package/time filters
6. Check for data availability

## Built-in Templates

### sql-generation
**Temperature**: 0.3 (low randomness)

**System Prompt**:
```
You are a Perfetto SQL expert. Generate accurate SQL queries to analyze trace data.

IMPORTANT RULES:
1. ONLY use tables listed in the schema below
2. All timestamps are in NANOSECONDS - convert to ms with /1e6 or seconds with /1e9
3. Use proper JOIN conditions with foreign keys (track_id, utid, upid)
4. Use thread_track for thread tracks, not track directly

[Schema included]

{schema}

Example queries:
{examples}

Respond with the SQL query wrapped in ```sql ... ``` code blocks,
followed by a brief explanation.
```

**User Prompt**: `{question}`

**Use Cases**:
- Primary SQL generation endpoint
- AI-powered query generation
- Multi-step analysis

### sql-fix
**Temperature**: 0.2 (very low randomness)

**System Prompt**:
```
You are a Perfetto SQL expert. Your task is to fix SQL queries that failed to execute.

[SQL EXECUTION ERROR]

[syntax prompt from PROMPTS.ERROR_FIX.syntax]

Please FIX the SQL query and try again. Common issues:
- Wrong column names (check schema)
- Wrong table names (check schema)
- Syntax errors
- Type mismatches

Generate ONE corrected SQL query wrapped in ```sql ... ``` code blocks.
```

**User Prompt**: Empty (uses error context from system prompt)

**Use Cases**:
- Syntax error correction
- Runtime error fixing
- Iterative query refinement

### sql-adjust
**Temperature**: 0.4 (moderate randomness)

**System Prompt**:
```
You are a Perfetto SQL expert. Your task is to adjust SQL queries that returned no results.

[QUERY RESULT - 0 ROWS]

[noResults prompt from PROMPTS.ERROR_FIX.noResults]

This means:
- Your WHERE conditions are too restrictive
- The data doesn't exist in this trace
- You're looking in the wrong place

Please ADJUST your approach and try a different query.
```

**User Prompt**: "Generate a revised SQL query to find the relevant data."

**Use Cases**:
- Empty result handling
- Query optimization
- Alternative data sources

### analysis-summary
**Temperature**: 0.5 (balanced creativity)

**System Prompt**:
```
You are a Perfetto trace analysis expert. Provide a clear, comprehensive answer
to the user based on the query results.

[detailed prompt from PROMPTS.ANALYSIS_SUMMARY.detailed]

{schema}

Focus on providing actionable insights with specific numbers and data points.
```

**User Prompt**:
```
User Question: "{question}"

{context}

Provide a final answer that directly addresses the user's question.
Include specific numbers and data points when relevant.
```

**Use Cases**:
- Result interpretation
- Performance insights
- Recommendation generation

### trace-analysis-system
**Temperature**: 0.3 (low randomness)

**System Prompt**:
```
You are an expert Perfetto trace analyst. Your job is to answer user questions
by querying the trace database.

**CRITICAL RULES - READ CAREFULLY:**

1. SQL Execution Flow:
   - Generate ONLY ONE SQL query at a time
   - Wrap SQL in ```sql ... ``` code blocks
   - Wait for results before generating another query
   - Each query will be executed and results sent back to you

2. When you get SQL results:
   - Analyze the data
   - If you need MORE information, run ONE more SQL query
   - If you have ENOUGH information, provide your final answer

3. Error Handling:
   - If SQL has syntax error, FIX IT and try again
   - If query returns 0 rows, ADJUST your approach

4. Final Answer:
   - When you have enough data, provide a COMPLETE answer
   - Include specific numbers, timestamps, percentages
   - Be thorough but concise

{schema}

**Important Schema Notes:**
- thread table uses "upid" (not "pid") to reference process
- Timestamps are in NANOSECONDS (divide by 1_000_000_000 for seconds)
- Durations are also in NANOSECONDS

**Common Analysis Patterns:**
- Startup: Look for process.start_ts, then slice table for activity
- CPU: Check sched table for thread states, counter table for frequency
- Memory: Check counter table for memory stats
- ANR: Check instant table for "android_anr" events
```

**User Prompt**: `{question}`

**Use Cases**:
- Multi-step analysis conversations
- Interactive exploration
- Complex investigations requiring multiple queries

## Adding New Prompts

### Step 1: Define Prompt Structure
Decide on:
- Purpose and use case
- Required variables
- Temperature setting
- Output format expectations

### Step 2: Add to PROMPTS Configuration
In `/backend/src/config/prompts.ts`:

```typescript
export const PROMPTS = {
  // ... existing prompts

  YOUR_CATEGORY: {
    yourPrompt: `
Your prompt template here with {variables}.

Multi-line strings supported.

Include clear instructions and examples.
    `,
  },
};
```

### Step 3: Add Template to Service (Optional)
If using as a named template, in `/backend/src/services/promptTemplateService.ts`:

```typescript
private initializeDefaultTemplates(): void {
  this.addTemplate({
    name: 'your-template-name',
    system: PROMPTS.YOUR_CATEGORY.yourPrompt
      .replace('{variable}', 'value'),
    user: 'User message template with {variables}',
    temperature: 0.3,
  });
}
```

### Step 4: Use in Code
```typescript
const service = PromptTemplateService.getInstance();

// Format with variables
const prompt = service.formatTemplate('your-template-name', {
  schema: dbSchema,
  question: userQuestion,
  examples: exampleQueries,
});

// Get temperature
const temp = service.getTemperature('your-template-name');
```

## Prompt Best Practices

### Structure
1. **Clear role definition** - "You are a Perfetto SQL expert..."
2. **Explicit rules** - Numbered lists work best
3. **Examples** - Show expected output format
4. **Constraints** - What NOT to do

### Variables
1. **Use consistent naming** - `{schema}`, `{question}`, `{sql}`, `{context}`, `{explanation}`
2. **Document variables** - List required vs optional
3. **Provide defaults** - Handle missing variables gracefully
4. **Type safety** - Use TypeScript interfaces

**Available Template Variables:**
- `{schema}`: Database schema (tables and columns)
- `{question}`: User's natural language question
- `{context}`: Additional context (query results, analysis history, previous steps)
- `{sql}`: SQL query (for error fixing or adjustment)
- `{error}`: Error message from trace processor
- `{explanation}`: SQL explanation or analysis summary
- `{examples}`: Example queries or patterns
- Custom variables: Any key-value pair needed for specific templates

### Temperature Settings
- **0.0-0.2**: Highly deterministic (error fixing, SQL generation)
- **0.3-0.4**: Low variability (query adjustment, exploration)
- **0.5-0.7**: Balanced (analysis, summaries)
- **0.8-1.0**: High creativity (rarely used for SQL)

### Perfetto-Specific Guidelines
1. **Timestamp units** - Always mention nanoseconds
2. **Table relationships** - Emphasize JOIN keys
3. **Column naming** - Warn about common pitfalls (upid vs pid)
4. **Schema awareness** - Include schema when available

## Testing Prompts

### Unit Testing
```typescript
describe('PromptTemplateService', () => {
  it('should format template with variables', () => {
    const service = PromptTemplateService.getInstance();
    const prompt = service.formatTemplate('sql-generation', {
      question: 'Show startups',
      schema: 'android_startups',
    });

    expect(prompt).toContain('Show startups');
    expect(prompt).toContain('android_startups');
  });
});
```

### Integration Testing
```typescript
it('should generate valid SQL from prompt', async () => {
  const prompt = service.formatTemplate('sql-generation', {
    question: 'Analyze startup time',
    schema: traceSchema,
  });

  const response = await aiService.generate(prompt);
  const sql = extractSqlFromResponse(response);

  await traceProcessor.query(traceId, sql);
  expect(result.error).toBeUndefined();
});
```

### Manual Testing
1. Test with various question phrasings
2. Verify SQL correctness in Perfetto UI
3. Check error handling with invalid inputs
4. Validate output format consistency

## Common Patterns

### Multi-Turn Conversation
```typescript
// Initial query
const prompt1 = service.formatTemplate('trace-analysis-system', {
  question: 'Why is my app slow to start?',
  schema: traceSchema,
});

// Execute SQL
const sql1 = await aiService.generate(prompt1);
const result1 = await traceProcessor.query(traceId, sql1);

// Follow-up if needed
const prompt2 = service.formatTemplate('sql-adjust', {
  sql: sql1,
  error: 'No results',
});

const sql2 = await aiService.generate(prompt2);
```

### Error Recovery Loop
```typescript
async function executeWithRetry(traceId: string, question: string) {
  let sql = await generateSql(question);
  let attempts = 0;

  while (attempts < 3) {
    const result = await traceProcessor.query(traceId, sql);

    if (result.error) {
      // Syntax error - use sql-fix template
      const prompt = service.formatTemplate('sql-fix', {
        sql,
        error: result.error,
      });
      sql = await aiService.generate(prompt);
      attempts++;
    } else if (result.rows.length === 0) {
      // No results - use sql-adjust template
      const prompt = service.formatTemplate('sql-adjust', {
        sql,
      });
      sql = await aiService.generate(prompt);
      attempts++;
    } else {
      // Success!
      return result;
    }
  }

  throw new Error('Failed to generate valid SQL after 3 attempts');
}
```

### Dynamic Schema Injection
```typescript
const schema = await fetchTraceSchema(traceId);

const prompt = service.formatTemplate('sql-generation', {
  question: userQuestion,
  schema: schema.tables.map(t =>
    `- ${t.name}: ${t.columns.join(', ')}`
  ).join('\n'),
  examples: getExamplesForQuestion(userQuestion),
});
```

## Troubleshooting

### Poor SQL Quality
1. **Add schema** - Use `withSchema` variant
2. **Include examples** - Show similar successful queries
3. **Lower temperature** - Reduce randomness
4. **Strengthen instructions** - Be more explicit about rules

### Inconsistent Output Format
1. **Use code blocks** - Explicitly request ```sql ... ``` format
2. **Add examples** - Show expected output
3. **Post-process** - Parse and validate AI response
4. **Use lower temperature** - Reduce variability

### Repetitive Errors
1. **Check prompt template** - Look for unclear instructions
2. **Review examples** - Ensure they're accurate
3. **Adjust rules** - Make constraints more explicit
4. **Add validation** - Check generated SQL before execution

### Variable Substitution Failures
1. **Verify placeholder names** - Must match `{variable}` format
2. **Check variable values** - Ensure undefined values are handled
3. **Use defaults** - Provide fallback values
4. **Test formatTemplate** - Unit test variable replacement

## Performance Optimization

### Caching
```typescript
const promptCache = new Map<string, string>();

function getCachedPrompt(templateName: string, vars: TemplateVariables): string {
  const cacheKey = `${templateName}-${JSON.stringify(vars)}`;
  if (!promptCache.has(cacheKey)) {
    promptCache.set(cacheKey,
      service.formatTemplate(templateName, vars)
    );
  }
  return promptCache.get(cacheKey)!;
}
```

### Prompt Compression
- Remove redundant instructions
- Use concise examples
- Minimize schema size (include only relevant tables)
- Cache formatted prompts for repeated use

### Batch Processing
```typescript
// Generate multiple prompts in parallel
const prompts = questions.map(q =>
  service.formatTemplate('sql-generation', { question: q })
);

const responses = await Promise.all(
  prompts.map(p => aiService.generate(p))
);
```

## File Locations

- **Service**: `/backend/src/services/promptTemplateService.ts`
- **Configuration**: `/backend/src/config/prompts.ts`
- **Types**: Within `promptTemplateService.ts`
- **This SOP**: `/docs/sops/promptEngineering.md`

## References

- **Prompt Engineering Guide**: https://platform.openai.com/docs/guides/prompt-engineering
- **Temperature Settings**: https://docs.anthropic.com/claude/docs/prompt-engineering#temperature
- **Perfetto SQL Reference**: https://perfetto.dev/docs/analysis/sql-queries
- **AI Best Practices**: https://github.com/f/awesome-chatgpt-prompts
