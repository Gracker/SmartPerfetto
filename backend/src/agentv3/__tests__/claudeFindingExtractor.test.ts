/**
 * claudeFindingExtractor unit tests
 *
 * Tests finding extraction from free-text, including:
 * - Basic [SEVERITY] pattern matching
 * - Code block stripping (Mermaid, SQL, etc.)
 * - Evidence extraction (根因推理链 format)
 */

import { describe, it, expect } from '@jest/globals';
import { extractFindingsFromText } from '../claudeFindingExtractor';

describe('extractFindingsFromText', () => {
  it('should extract basic findings with severity markers', () => {
    const text = `
**[HIGH] 主线程 CPU 负载过高**
描述：主线程 Running 占 63%
证据：Q1=62.8%

**[MEDIUM] GC 压力**
描述：后台 GC 影响轻微
`;
    const findings = extractFindingsFromText(text);
    expect(findings).toHaveLength(2);
    expect(findings[0].severity).toBe('high');
    expect(findings[0].title).toContain('CPU 负载');
    expect(findings[1].severity).toBe('medium');
  });

  it('should NOT extract findings from Mermaid code blocks', () => {
    const text = `
**[HIGH] 真实发现 — CPU 瓶颈**
描述：主线程超时

\`\`\`mermaid
graph TD
    A["启动"] --> B["[HIGH] 超时 15ms\\nfreq_ramp_slow 47%"]
    B --> C["[MEDIUM] 短帧超时\\nlock_binder_wait"]
    style B fill:#ff6b6b,color:#fff
\`\`\`

**[LOW] GC 压力较小**
描述：GC 影响可忽略
`;
    const findings = extractFindingsFromText(text);
    // Should only find 2 real findings, not the [HIGH] and [MEDIUM] inside Mermaid
    expect(findings).toHaveLength(2);
    expect(findings[0].severity).toBe('high');
    expect(findings[0].title).toContain('CPU 瓶颈');
    expect(findings[1].severity).toBe('low');
    expect(findings[1].title).toContain('GC');
  });

  it('should NOT extract findings from SQL code blocks', () => {
    const text = `
**[CRITICAL] 阻塞严重**
描述：主线程被 Binder 阻塞

\`\`\`sql
SELECT '[HIGH] this is not a finding' FROM slice WHERE dur > 100000
\`\`\`
`;
    const findings = extractFindingsFromText(text);
    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe('critical');
  });

  it('should extract evidence from 根因推理链 format', () => {
    const text = `
**[HIGH] freq_ramp_slow — 代表帧 Frame 38**
根因推理链：
  ① 症状：帧耗时 18.57ms
  ② 机制：CPU 大核从 787MHz 爬升
  ③ 根源：CustomScroll_doFrameLoad
建议：设置 uclamp.min
`;
    const findings = extractFindingsFromText(text);
    expect(findings).toHaveLength(1);
    expect(findings[0].evidence).toBeDefined();
    expect(findings[0].evidence?.length).toBeGreaterThan(0);
  });

  it('should handle empty text', () => {
    expect(extractFindingsFromText('')).toHaveLength(0);
    expect(extractFindingsFromText(undefined as any)).toHaveLength(0);
  });
});
