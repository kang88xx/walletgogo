import { describe, expect, it } from 'vitest';
import { computeSolDelta, deltaToDirection } from './solana';

const ADDR = 'So11111111111111111111111111111111111111112';
const OTHER = '4Nd1mY7xMU1nQ3rXc7iZ8Yc2pK9b6Q1pK9b6Q1pK9b6';

describe('computeSolDelta', () => {
  it('computes a positive delta (incoming)', () => {
    const keys = [OTHER, ADDR];
    const delta = computeSolDelta(keys, [10e9, 1e9], [9e9, 2e9], ADDR);
    expect(delta).toBe(1e9); // +1 SOL
  });

  it('computes a negative delta (outgoing, fee payer)', () => {
    const keys = [ADDR, OTHER];
    const delta = computeSolDelta(keys, [5e9, 0], [3e9, 2e9], ADDR);
    expect(delta).toBe(-2e9);
  });

  it('returns null when the address is not in the account list', () => {
    expect(computeSolDelta([OTHER], [1e9], [1e9], ADDR)).toBeNull();
  });

  it('returns null when balances are missing for the index', () => {
    expect(computeSolDelta([ADDR], [], [], ADDR)).toBeNull();
  });
});

describe('deltaToDirection', () => {
  it('maps positive to in', () => {
    expect(deltaToDirection(2e9)).toEqual({ direction: 'in', amount: 2 });
  });
  it('maps negative to out with positive amount', () => {
    expect(deltaToDirection(-1.5e9)).toEqual({ direction: 'out', amount: 1.5 });
  });
  it('maps zero to self', () => {
    expect(deltaToDirection(0)).toEqual({ direction: 'self', amount: 0 });
  });
});
