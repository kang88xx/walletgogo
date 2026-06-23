import { createBitcoinAdapter } from './bitcoin';
import { createEvmAdapter } from './evm';
import { createSolanaAdapter } from './solana';
import { createTronAdapter } from './tron';
import type { ChainAdapter, ChainFamily, ChainId } from './types';

export interface ChainMeta {
  id: ChainId;
  label: string;
  family: ChainFamily;
  nativeSymbol: string;
}

export const CHAINS: Record<ChainId, ChainMeta> = {
  ethereum: { id: 'ethereum', label: 'Ethereum', family: 'evm', nativeSymbol: 'ETH' },
  bsc: { id: 'bsc', label: 'BNB Smart Chain', family: 'evm', nativeSymbol: 'BNB' },
  polygon: { id: 'polygon', label: 'Polygon', family: 'evm', nativeSymbol: 'MATIC' },
  arbitrum: { id: 'arbitrum', label: 'Arbitrum One', family: 'evm', nativeSymbol: 'ETH' },
  optimism: { id: 'optimism', label: 'Optimism', family: 'evm', nativeSymbol: 'ETH' },
  base: { id: 'base', label: 'Base', family: 'evm', nativeSymbol: 'ETH' },
  solana: { id: 'solana', label: 'Solana', family: 'solana', nativeSymbol: 'SOL' },
  bitcoin: { id: 'bitcoin', label: 'Bitcoin', family: 'bitcoin', nativeSymbol: 'BTC' },
  tron: { id: 'tron', label: 'Tron', family: 'tron', nativeSymbol: 'TRX' },
};

/** Ordered list for UI dropdowns. */
export const CHAIN_LIST: ChainMeta[] = Object.values(CHAINS);

export function isChainId(value: string): value is ChainId {
  return Object.prototype.hasOwnProperty.call(CHAINS, value);
}

// Adapters are stateless aside from env config, so we memoize one per chain.
const adapterCache = new Map<ChainId, ChainAdapter>();

export function getAdapter(chainId: ChainId): ChainAdapter {
  const cached = adapterCache.get(chainId);
  if (cached) return cached;

  const meta = CHAINS[chainId];
  let adapter: ChainAdapter;
  switch (meta.family) {
    case 'evm':
      adapter = createEvmAdapter(chainId);
      break;
    case 'solana':
      adapter = createSolanaAdapter();
      break;
    case 'bitcoin':
      adapter = createBitcoinAdapter();
      break;
    case 'tron':
      adapter = createTronAdapter();
      break;
  }

  adapterCache.set(chainId, adapter);
  return adapter;
}
