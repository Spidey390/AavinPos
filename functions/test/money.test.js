import test from 'node:test';
import assert from 'node:assert/strict';
import { cents } from '../src/financial.js';

test('server currency conversion rejects invalid amounts without floating-point drift', () => {
  assert.equal(cents(2.55), 255);
  for (const value of [-1, 1.001, '25', NaN, Infinity, 1e10]) assert.throws(() => cents(value));
  assert.equal(cents(-25, true), -2500);
});
