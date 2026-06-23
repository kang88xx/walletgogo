import type { ChainId } from '@/lib/chains/types';

/**
 * A chain-tagged transfer extracted from a provider webhook, before it is
 * matched to a watched address and normalized into a NormalizedTx.
 */
export interface ParsedActivity {
  chainId: ChainId;
  hash: string;
  from: string;
  to: string | null;
  asset: string;
  amount: number;
  /** Unix seconds. */
  timestamp: number;
  isToken: boolean;
}

/** Map Alchemy network ids to our chain ids. */
const ALCHEMY_NETWORK_TO_CHAIN: Record<string, ChainId> = {
  ETH_MAINNET: 'ethereum',
  MATIC_MAINNET: 'polygon',
  POLYGON_MAINNET: 'polygon',
  ARB_MAINNET: 'arbitrum',
  OPT_MAINNET: 'optimism',
  BASE_MAINNET: 'base',
  BNB_MAINNET: 'bsc',
};

interface AlchemyActivity {
  fromAddress?: string;
  toAddress?: string;
  hash?: string;
  value?: number;
  asset?: string;
  category?: string;
  blockNum?: string;
  rawContract?: { rawValue?: string; address?: string; decimals?: number };
}

interface AlchemyBody {
  event?: { network?: string; activity?: AlchemyActivity[] };
  createdAt?: string;
}

function tsFromIso(iso: string | undefined): number {
  if (!iso) return 0;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : 0;
}

/** Parse an Alchemy Address Activity webhook payload into activities. */
export function parseAlchemy(body: unknown, nowSeconds = 0): ParsedActivity[] {
  const b = body as AlchemyBody;
  const network = b?.event?.network ?? '';
  const chainId = ALCHEMY_NETWORK_TO_CHAIN[network];
  if (!chainId || !Array.isArray(b?.event?.activity)) return [];
  const ts = tsFromIso(b.createdAt) || nowSeconds;

  const out: ParsedActivity[] = [];
  for (const a of b.event!.activity!) {
    if (!a.hash) continue;
    const isToken = a.category === 'token' || a.category === 'erc20';
    out.push({
      chainId,
      hash: a.hash,
      from: a.fromAddress ?? '',
      to: a.toAddress ?? null,
      asset: a.asset || 'ETH',
      amount: typeof a.value === 'number' ? a.value : 0,
      timestamp: ts,
      isToken,
    });
  }
  return out;
}

interface HeliusNativeTransfer {
  fromUserAccount?: string;
  toUserAccount?: string;
  amount?: number; // lamports
}

interface HeliusTokenTransfer {
  fromUserAccount?: string;
  toUserAccount?: string;
  tokenAmount?: number;
  mint?: string;
  symbol?: string;
}

interface HeliusTx {
  signature?: string;
  timestamp?: number; // unix seconds
  nativeTransfers?: HeliusNativeTransfer[];
  tokenTransfers?: HeliusTokenTransfer[];
}

const LAMPORTS_PER_SOL = 1e9;

/** Parse a Helius enhanced-transaction webhook payload (array) into activities. */
export function parseHelius(body: unknown): ParsedActivity[] {
  const txs = Array.isArray(body) ? (body as HeliusTx[]) : [];
  const out: ParsedActivity[] = [];
  for (const tx of txs) {
    if (!tx.signature) continue;
    const ts = typeof tx.timestamp === 'number' ? tx.timestamp : 0;
    for (const n of tx.nativeTransfers ?? []) {
      out.push({
        chainId: 'solana',
        hash: tx.signature,
        from: n.fromUserAccount ?? '',
        to: n.toUserAccount ?? null,
        asset: 'SOL',
        amount: (n.amount ?? 0) / LAMPORTS_PER_SOL,
        timestamp: ts,
        isToken: false,
      });
    }
    for (const t of tx.tokenTransfers ?? []) {
      out.push({
        chainId: 'solana',
        hash: tx.signature,
        from: t.fromUserAccount ?? '',
        to: t.toUserAccount ?? null,
        asset: t.symbol || t.mint || 'SPL',
        amount: typeof t.tokenAmount === 'number' ? t.tokenAmount : 0,
        timestamp: ts,
        isToken: true,
      });
    }
  }
  return out;
}
