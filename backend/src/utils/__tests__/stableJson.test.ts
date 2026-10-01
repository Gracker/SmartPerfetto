// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {describe, expect, it} from '@jest/globals';

import {stableJsonValue, stableStringify} from '../stableJson';

// JSON.parse (and js-yaml) create an own data property named __proto__; an
// object literal or assignment would set the prototype instead.
const withProto = (inner: string) =>
  JSON.parse(`{"b":1,"__proto__":${inner},"a":[{"__proto__":{"deep":${inner}}}]}`);

describe('stableStringify', () => {
  it('sorts keys and drops undefined members', () => {
    expect(stableStringify({b: 1, a: {d: undefined, c: [2, undefined]}}))
      .toBe('{"a":{"c":[2,null]},"b":1}');
  });

  it('keeps an own __proto__ key as data, nested and inside arrays', () => {
    expect(stableStringify(withProto('{"y":2,"x":1}')))
      .toBe('{"__proto__":{"x":1,"y":2},"a":[{"__proto__":{"deep":{"x":1,"y":2}}}],"b":1}');
  });

  it('changes its output when content under __proto__ changes', () => {
    expect(stableStringify(withProto('{"x":1}'))).not.toBe(stableStringify(withProto('{"x":2}')));
    expect(stableStringify(withProto('"text"'))).not.toBe(stableStringify(withProto('"other"')));
  });

  it('never sets the prototype of the canonical value', () => {
    const value = stableJsonValue(withProto('{"x":1}')) as Record<string, unknown>;
    expect(Object.getPrototypeOf(value)).toBe(Object.prototype);
    expect(Object.prototype.hasOwnProperty.call(value, '__proto__')).toBe(true);
  });
});
