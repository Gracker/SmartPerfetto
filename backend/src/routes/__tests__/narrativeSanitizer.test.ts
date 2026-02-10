import { sanitizeNarrativeForClient } from '../narrativeSanitizer';

describe('narrativeSanitizer', () => {
  test('removes internal ev_ ids while keeping evidence text', () => {
    const input = `## 证据链（对应上述结论）
- C1: 规则裁决=混合型（APP 触发 + SF 放大） （ev_5f64858c9de6|ev_0a31195bb6f3）
- C2: 责任分布样本 SF=25 (100.0%)，APP=0 (0.0%) （ev_eb7fcff0ba20）
- 证据索引（自动补全）: (ev_111111111111) [frame_agent] analyze_scrolling`;

    const output = sanitizeNarrativeForClient(input);

    expect(output).toContain('## 证据链（对应上述结论）');
    expect(output).toContain('- C1: 规则裁决=混合型（APP 触发 + SF 放大）');
    expect(output).toContain('- C2: 责任分布样本 SF=25 (100.0%)，APP=0 (0.0%)');
    expect(output).not.toContain('ev_5f64858c9de6');
    expect(output).not.toContain('ev_0a31195bb6f3');
    expect(output).not.toContain('证据索引（自动补全）');
  });

  test('keeps plain narrative unchanged when no internal ids exist', () => {
    const input = `## 结论（按可能性排序）
1. 这是混合型掉帧。

## 下一步（最高信息增益）
- 扩大样本量验证。`;

    expect(sanitizeNarrativeForClient(input)).toBe(input);
  });

  test('removes empty evidence field and connector-only placeholders after id stripping', () => {
    const input = `**evidence_chain:**
- {"conclusion":"C1","evidence":"ev_111111111111","data":"逐帧根因统计显示主线程耗时操作占65%（41/63帧）"}
- 区间1掉帧数数据不一致（ev_aaaaaaaaaaaa vs ev_bbbbbbbbbbbb）`;

    const output = sanitizeNarrativeForClient(input);

    expect(output).toContain('{"conclusion":"C1","data":"逐帧根因统计显示主线程耗时操作占65%（41/63帧）"}');
    expect(output).not.toContain('"evidence":""');
    expect(output).not.toContain('（ vs ）');
    expect(output).not.toContain('ev_111111111111');
    expect(output).not.toContain('ev_aaaaaaaaaaaa');
    expect(output).not.toContain('ev_bbbbbbbbbbbb');
  });

  test('humanizes jargon-heavy mechanism terms for client narrative', () => {
    const input = `## 结论（按可能性排序）
- 触发因子: 主线程耗时操作（65%）
- 供给约束: 阻塞等待（57.1%）
- 放大路径: SF消费端背压（100%）`;

    const output = sanitizeNarrativeForClient(input);

    expect(output).toContain('直接原因');
    expect(output).toContain('资源问题');
    expect(output).toContain('放大因素');
    expect(output).not.toContain('触发因子');
    expect(output).not.toContain('供给约束');
    expect(output).not.toContain('放大路径');
    expect(output).toContain('阻塞等待（线程等待锁/IO/Binder）');
    expect(output).toContain('显示系统处理不过来（SF消费端背压）');
  });

  test('is idempotent for already-humanized jargon phrases', () => {
    const input = '放大因素: 显示系统处理不过来（SF消费端背压）';

    const once = sanitizeNarrativeForClient(input);
    const twice = sanitizeNarrativeForClient(once);

    expect(twice).toBe(once);
  });
});
