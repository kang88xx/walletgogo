import {
  type BalanceSnapshot,
  type ChainAdapter,
  ChainError,
  type GetTxOptions,
  type NormalizedTx,
} from './types';

const SOLANA_ADDRESS_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const LAMPORTS_PER_SOL = 1e9;
/** How many recent signatures to enrich with a getTransaction call per check. */
const ENRICH_CAP = 8;

/**
 * Net lamport delta for `address` in a transaction, from pre/post balances.
 * Returns null when the address isn't among the transaction's accounts.
 */
export function computeSolDelta(
  accountKeys: string[],
  preBalances: number[],
  postBalances: number[],
  address: string,
): number | null {
  const idx = accountKeys.indexOf(address);
  if (idx === -1) return null;
  const pre = preBalances[idx];
  const post = postBalances[idx];
  if (typeof pre !== 'number' || typeof post !== 'number') return null;
  return post - pre;
}

/** Map a lamport delta to a direction + positive SOL amount. */
export function deltaToDirection(deltaLamports: number): {
  direction: 'in' | 'out' | 'self';
  amount: number;
} {
  const amount = Math.abs(deltaLamports) / LAMPORTS_PER_SOL;
  if (deltaLamports > 0) return { direction: 'in', amount };
  if (deltaLamports < 0) return { direction: 'out', amount };
  return { direction: 'self', amount: 0 };
}

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

interface ParsedAccountKey {
  pubkey: string;
}

interface SolTransaction {
  meta: {
    preBalances?: number[];
    postBalances?: number[];
  } | null;
  transaction: {
    message: {
      // jsonParsed => array of {pubkey}; json => array of base58 strings
      accountKeys: Array<ParsedAccountKey | string>;
    };
  };
}

function normalizeAccountKeys(
  keys: Array<ParsedAccountKey | string>,
): string[] {
  return keys.map((k) => (typeof k === 'string' ? k : k.pubkey));
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
      const recent = sigs.filter((sig) => (sig.blockTime ?? 0) >= since);

      // Enrich the most-recent N signatures with real SOL amount + direction via
      // getTransaction (pre/post balance delta). Bounded to control RPC cost; any
      // failure falls back to the signature-only placeholder.
      const enrichable = new Set(recent.slice(0, ENRICH_CAP).map((s) => s.signature));

      const out = await Promise.all(
        recent.map(async (sig): Promise<NormalizedTx> => {
          const ts = sig.blockTime ?? 0;
          const placeholder: NormalizedTx = {
            hash: sig.signature,
            from: address,
            to: null,
            direction: 'self',
            asset: 'SOL',
            amount: 0,
            type: 'native',
            timestamp: ts,
            blockNumber: sig.slot,
          };
          if (!enrichable.has(sig.signature)) return placeholder;
          try {
            const txn = await solanaRpc<SolTransaction | null>('getTransaction', [
              sig.signature,
              { maxSupportedTransactionVersion: 0, encoding: 'jsonParsed' },
            ]);
            const pre = txn?.meta?.preBalances;
            const post = txn?.meta?.postBalances;
            if (!txn || !pre || !post) return placeholder;
            const keys = normalizeAccountKeys(txn.transaction.message.accountKeys);
            const delta = computeSolDelta(keys, pre, post, address);
            if (delta === null) return placeholder;
            const { direction, amount } = deltaToDirection(delta);
            return { ...placeholder, direction, amount };
          } catch {
            return placeholder;
          }
        }),
      );

      return out;
    },
  };
}
