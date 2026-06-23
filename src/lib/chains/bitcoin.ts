import {
  type BalanceSnapshot,
  type ChainAdapter,
  ChainError,
  type GetTxOptions,
  type NormalizedTx,
  type TxDirection,
} from './types';

// Legacy P2PKH/P2SH (1.../3...) and bech32/bech32m (bc1...). Basic shape check.
const BTC_ADDRESS_RE =
  /^(1[a-km-zA-HJ-NP-Z1-9]{25,34}|3[a-km-zA-HJ-NP-Z1-9]{25,34}|bc1[a-z0-9]{11,71})$/;

const SATS_PER_BTC = 1e8;
const API_BASE = 'https://mempool.space/api';

interface MempoolAddressStats {
  funded_txo_sum: number;
  spent_txo_sum: number;
}

interface MempoolAddressInfo {
  address: string;
  chain_stats: MempoolAddressStats;
  mempool_stats: MempoolAddressStats;
}

interface MempoolVin {
  prevout: { scriptpubkey_address?: string; value: number } | null;
}

interface MempoolVout {
  scriptpubkey_address?: string;
  value: number;
}

interface MempoolTx {
  txid: string;
  status: { confirmed: boolean; block_time?: number };
  vin: MempoolVin[];
  vout: MempoolVout[];
}

async function getJson<T>(path: string): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, { headers: { accept: 'application/json' } });
  } catch (err) {
    throw new ChainError('bitcoin', `mempool.space request failed (${path})`, err);
  }
  if (!res.ok) {
    throw new ChainError('bitcoin', `mempool.space HTTP ${res.status} (${path})`);
  }
  return (await res.json()) as T;
}

export function createBitcoinAdapter(): ChainAdapter {
  return {
    family: 'bitcoin',

    validateAddress(address: string): boolean {
      return BTC_ADDRESS_RE.test(address);
    },

    async getBalance(address: string): Promise<BalanceSnapshot[]> {
      const info = await getJson<MempoolAddressInfo>(`/address/${address}`);
      const funded =
        info.chain_stats.funded_txo_sum + info.mempool_stats.funded_txo_sum;
      const spent =
        info.chain_stats.spent_txo_sum + info.mempool_stats.spent_txo_sum;
      const sats = funded - spent;
      return [{ asset: 'BTC', amount: sats / SATS_PER_BTC }];
    },

    async getRecentTransactions(
      address: string,
      opts: GetTxOptions,
    ): Promise<NormalizedTx[]> {
      const txs = await getJson<MempoolTx[]>(`/address/${address}/txs`);
      const since = opts.sinceTs ?? 0;
      const out: NormalizedTx[] = [];

      for (const tx of txs) {
        const ts = tx.status.block_time ?? 0;
        if (ts < since) continue;

        // Net value to this address = (vout to us) - (vin from us), in sats.
        let received = 0;
        for (const vout of tx.vout) {
          if (vout.scriptpubkey_address === address) received += vout.value;
        }
        let sent = 0;
        for (const vin of tx.vin) {
          if (vin.prevout?.scriptpubkey_address === address) {
            sent += vin.prevout.value;
          }
        }
        const net = received - sent; // positive => incoming, negative => outgoing
        let direction: TxDirection;
        if (net > 0) direction = 'in';
        else if (net < 0) direction = 'out';
        else direction = 'self';

        out.push({
          hash: tx.txid,
          from: direction === 'out' ? address : '',
          to: direction === 'in' ? address : null,
          direction,
          asset: 'BTC',
          amount: Math.abs(net) / SATS_PER_BTC,
          type: 'native',
          timestamp: ts,
        });
      }

      out.sort((a, b) => b.timestamp - a.timestamp);
      return typeof opts.limit === 'number' ? out.slice(0, opts.limit) : out;
    },
  };
}
