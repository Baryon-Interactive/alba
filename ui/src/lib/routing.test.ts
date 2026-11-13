import { describe, expect, it } from 'vitest';
import { ratePercent } from './routing.ts';

describe('routing helpers', () => {
  it('says nothing about a rate before it exists', () => {
    expect(ratePercent(undefined)).toBeUndefined();
    expect(ratePercent(0.667)).toBe('67%');
  });
});
