import {
  buildTriadStatement,
  LEGACY_TO_PLAIN_PHRASE_RULES,
  parseTriadParts,
  stripTriadPrefix,
  TRIAD_LABELS,
} from '../analysisNarrative';

describe('analysisNarrative', () => {
  test('buildTriadStatement uses unified labels', () => {
    const text = buildTriadStatement({
      trigger: '主线程长耗时',
      supply: '频率不足',
      amplification: 'SF 消费端背压',
    });

    expect(text).toBe(
      `${TRIAD_LABELS.trigger}: 主线程长耗时；${TRIAD_LABELS.supply}: 频率不足；${TRIAD_LABELS.amplification}: SF 消费端背压`
    );
  });

  test('parseTriadParts supports legacy and new labels', () => {
    const legacy = '触发因子: A；供给约束: B；放大路径: C';
    const modern = '直接原因: A；资源问题: B；放大因素: C';

    expect(parseTriadParts(legacy)).toEqual({
      trigger: 'A',
      supply: 'B',
      amplification: 'C',
    });
    expect(parseTriadParts(modern)).toEqual({
      trigger: 'A',
      supply: 'B',
      amplification: 'C',
    });
  });

  test('legacy phrase rewrite rules convert jargon to plain terms', () => {
    const input = '触发因子（直接原因）: X；供给约束: Y；放大路径: Z；负载主导（供给约束弱）';
    const output = LEGACY_TO_PLAIN_PHRASE_RULES.reduce(
      (acc, rule) => acc.replace(rule.pattern, rule.replacement),
      input
    );
    expect(output).toContain('直接原因: X');
    expect(output).toContain('资源问题: Y');
    expect(output).toContain('放大因素: Z');
    expect(output).toContain('负载主导（资源问题弱）');
  });

  test('stripTriadPrefix removes triad prefixes while keeping content', () => {
    expect(stripTriadPrefix('触发因子: 主线程长耗时')).toBe('主线程长耗时');
    expect(stripTriadPrefix('资源问题: 调度延迟')).toBe('调度延迟');
    expect(stripTriadPrefix('放大路径: SF 背压')).toBe('SF 背压');
  });
});
