import {
  type BalanceSnapshot,
  type ChainAdapter,
  ChainError,
  type GetTxOptions,
  type NormalizedTx,
} from './types';

const SOLANA_ADDRESS_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const LAMPORTS_PER_SOL = 1e9;

function rpcUrl(): string {
  return process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';
}

async function solanaRpc<T>(method: string, params: unknown[]): Promise<T> {
  let res: Response;
  try {
    res = await fetch(rpcUrl(), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    });
  } catch (err) {
    throw new ChainError('solana', `RPC request failed (${method})`, err);
  }
  if (!res.ok) {
    throw new ChainError('solana', `RPC HTTP ${res.status} (${method})`);
  }
  const body = (await res.json()) as { result?: T; error?: { message: string } };
  if (body.error) {
    throw new ChainError('solana', `RPC error: ${body.error.message}`);
  }
  return body.result as T;
}

interface SignatureInfo {
  signature: string;
  blockTime: number | null;
  slot: number;
}

export function createSolanaAdapter(): ChainAdapter {
  return {
    family: 'solana',

    validateAddress(address: string): boolean {
      return SOLANA_ADDRESS_RE.test(address);
    },

    async getBalance(address: string): Promise<BalanceSnapshot[]> {
      const result = await solanaRpc<{ value: number }>('getBalance', [address]);
      return [{ asset: 'SOL', amount: (result?.value ?? 0) / LAMPORTS_PER_SOL }];
    },

    async getRecentTransactions(
      address: string,
      opts: GetTxOptions,
    ): Promise<NormalizedTx[]> {
      const limit = opts.limit ?? 50;
      const sigs = await solanaRpc<SignatureInfo[]>('getSignaturesForAddress', [
        address,
        { limit },
      ]);

      const since = opts.sinceTs ?? 0;
      const out: NormalizedTx[] = [];
      for (const sig of sigs) {
        const ts = sig.blockTime ?? 0;
        if (ts < since) continue;
        // NOTE: getSignaturesForAddress only returns signatures + blockTime, not
        // balance deltas or counterparties. Resolving real amount/direction would
        // require a follow-up getTransaction call per signature (expensive). For
        // now we emit signature-only entries: the new_transaction rule still works
        // because it keys off the hash. amount=0 and direction='self' are
        // placeholders.
        // TODO: enrich via getTransaction to derive amount + in/out direction.
        out.push({
          hash: sig.signature,
          from: address,
          to: null,
          direction: 'self',
          asset: 'SOL',
          amount: 0,
          type: 'native',
          timestamp: ts,
          blockNumber: sig.slot,
        });
      }
      return out;
    },
  };
}
