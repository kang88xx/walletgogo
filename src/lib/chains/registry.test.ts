import { describe, expect, it } from 'vitest';
import { CHAINS, getAdapter, isChainId } from './index';

describe('chain registry', () => {
  it('recognizes Xphere as a supported EVM chain', () => {
    expect(isChainId('xphere')).toBe(true);
    expect(CHAINS.xphere).toMatchObject({
      id: 'xphere',
      family: 'evm',
      nativeSymbol: 'XP',
    });
  });

  it('builds an EVM adapter for Xphere that validates 0x addresses', () => {
    const adapter = getAdapter('xphere');
    expect(adapter.family).toBe('evm');
    expect(
      adapter.validateAddress('0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045'),
    ).toBe(true);
    expect(adapter.validateAddress('not-an-address')).toBe(false);
  });

  it('rejects unknown chain ids', () => {
    expect(isChainId('dogechain')).toBe(false);
  });
});
