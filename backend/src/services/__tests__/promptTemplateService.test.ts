import { describe, it, expect } from '@jest/globals';
import { PromptTemplateService } from '../promptTemplateService';

describe('PromptTemplateService', () => {
  const service = PromptTemplateService.getInstance();

  it('enforces evidence and uncertainty contract in analysis summary template', () => {
    const prompt = service.formatTemplate('analysis-summary', {
      question: 'Why is startup slow?',
      context: 'context',
      schema: 'schema',
    });

    expect(prompt).toContain('table[field]=value');
    expect(prompt).toContain('unable_to_determine');
    expect(prompt).toContain('Missing Data');
    expect(prompt).toContain('Action Items (owner, priority: P0/P1/P2');
    expect(service.getTemperature('analysis-summary')).toBe(0.2);
  });

  it('requires broader Android performance dimensions in trace-analysis-system template', () => {
    const prompt = service.formatTemplate('trace-analysis-system', {
      question: 'Analyze jank root cause',
      schema: 'schema',
    });

    expect(prompt).toContain('GPU/Render');
    expect(prompt).toContain('Binder contention');
    expect(prompt).toContain('GC/Memory pressure');
    expect(prompt).toContain('Thermal/Power');
    expect(prompt).toContain('Final response format');
    expect(prompt).toContain('Action items (owner/priority/verification)');
    expect(service.getTemperature('trace-analysis-system')).toBe(0.2);
  });
});
