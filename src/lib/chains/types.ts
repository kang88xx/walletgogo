export type ChainFamily = 'evm' | 'solana' | 'bitcoin' | 'tron';

export type ChainId =
  | 'ethereum'
  | 'bsc'
  | 'polygon'
  | 'arbitrum'
  | 'optimism'
  | 'base'
  | 'solana'
  | 'bitcoin'
  | 'tron';

/** Direction of a transfer relative to the watched address. */
export type TxDirection = 'in' | 'out' | 'self';

/** Kind of on-chain movement we care about for alerting. */
export type TxType = 'native' | 'token' | 'approval' | 'nft_approval';

/**
 * A chain-agnostic representation of a single transaction (or transfer).
 * Adapters are responsible for collapsing chain-specific shapes into this.
 */
export interface NormalizedTx {
  hash: string;
  from: string;
  to: string | null;
  direction: TxDirection;
  /** Human-readable asset symbol, e.g. "ETH", "USDT", "BTC". */
  asset: string;
  /** Amount in human units (already divided by the asset's decimals). */
  amount: number;
  type: TxType;
  /** Unix timestamp in seconds. */
  timestamp: number;
  blockNumber?: number;
}

export interface BalanceSnapshot {
  asset: string;
  amount: number;
}

export interface GetTxOptions {
  /** Only return transactions at or after this unix timestamp (best effort). */
  sinceTs?: number;
  /** Maximum number of transactions to return. */
  limit?: number;
}

/**
 * Common surface every chain adapter must implement. The monitor only ever
 * talks to adapters through this interface so new chains can be added without
 * touching the rule engine or orchestrator.
 */
export interface ChainAdapter {
  family: ChainFamily;
  validateAddress(address: string): boolean;
  getBalance(address: string): Promise<BalanceSnapshot[]>;
  getRecentTransactions(
    address: string,
    opts: GetTxOptions,
  ): Promise<NormalizedTx[]>;
}

/**
 * Typed error thrown by adapters when an external call fails. The monitor
 * catches these per-address so a single failing chain never aborts a run.
 */
export class ChainError extends Error {
  readonly chainId: ChainId;
  readonly cause?: unknown;

  constructor(chainId: ChainId, message: string, cause?: unknown) {
    super(message);
    this.name = 'ChainError';
    this.chainId = chainId;
    this.cause = cause;
  }
}
