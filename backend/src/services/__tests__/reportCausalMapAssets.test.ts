// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import { REPORT_CAUSAL_MAP_SCRIPT } from '../reportCausalMapAssets';

type FakeElement = {
  className: string;
  textContent: string;
  innerHTML: string;
  children: FakeElement[];
  style: {setProperty: ReturnType<typeof jest.fn>};
  appendChild: (child: FakeElement) => FakeElement;
  setAttribute: ReturnType<typeof jest.fn>;
};

function makeFakeElement(): FakeElement {
  const children: FakeElement[] = [];
  return {
    className: '',
    textContent: '',
    innerHTML: '',
    children,
    style: {setProperty: jest.fn()},
    appendChild(child: FakeElement) {
      children.push(child);
      return child;
    },
    setAttribute: jest.fn(),
  };
}

describe('REPORT_CAUSAL_MAP_SCRIPT', () => {
  test('is valid standalone browser script', () => {
    expect(() => new Function(REPORT_CAUSAL_MAP_SCRIPT)).not.toThrow();
  });

  test('renders supported causal flows without the Mermaid library', () => {
    const wrapper = makeFakeElement();
    const source = {
      ...makeFakeElement(),
      textContent: 'graph TB\nA[Input] --> B[Result]',
      closest: () => wrapper,
      parentElement: wrapper,
    };
    const document = {
      createElement: jest.fn(() => makeFakeElement()),
      querySelectorAll: jest.fn((selector: string) => selector === 'pre.mermaid' ? [source] : []),
    };
    const reportConsole = {error: jest.fn()};

    expect(() => new Function('document', 'console', REPORT_CAUSAL_MAP_SCRIPT)(document, reportConsole)).not.toThrow();
    expect(reportConsole.error).not.toHaveBeenCalled();
    expect(wrapper.children).toHaveLength(1);
    expect(wrapper.children[0].className).toBe('causal-map');
    expect(source.setAttribute).not.toHaveBeenCalledWith('data-render-mode', 'mermaid');
  });

  test('keeps supported causal flows on the native report renderer when Mermaid is available', async () => {
    const wrapper = makeFakeElement();
    const source = {
      ...makeFakeElement(),
      textContent: 'graph LR\nA[Input] --> B[Result]',
      closest: () => wrapper,
      parentElement: wrapper,
    };
    const document = {
      createElement: jest.fn(() => makeFakeElement()),
      querySelectorAll: jest.fn((selector: string) => selector === 'pre.mermaid' ? [source] : []),
    };
    const mermaid = {
      initialize: jest.fn(),
      run: jest.fn(async () => undefined),
    };

    new Function('document', 'console', 'mermaid', REPORT_CAUSAL_MAP_SCRIPT)(document, console, mermaid);
    await Promise.resolve();

    expect(wrapper.children).toHaveLength(1);
    expect(wrapper.children[0].className).toBe('causal-map');
    expect(source.setAttribute).not.toHaveBeenCalledWith('data-render-mode', 'mermaid');
    expect(mermaid.initialize).not.toHaveBeenCalled();
    expect(mermaid.run).not.toHaveBeenCalled();
  });
});
