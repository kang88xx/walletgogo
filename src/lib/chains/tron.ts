import {
  type BalanceSnapshot,
  type ChainAdapter,
  ChainError,
  type GetTxOptions,
  type NormalizedTx,
  type TxDirection,
  type TxType,
} from './types';

// Tron base58 addresses start with 'T' and are 34 chars long.
const TRON_ADDRESS_RE = /^T[1-9A-HJ-NP-Za-km-z]{33}$/;
const SUN_PER_TRX = 1e6;
const API_BASE = 'https://api.trongrid.io';

function headers(): Record<string, string> {
  const h: Record<string, string> = { accept: 'application/json' };
  const key = process.env.TRON_PRO_API_KEY;
  if (key) h['TRON-PRO-API-KEY'] = key;
  return h;
}

async function getJson<T>(path: string): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, { headers: headers() });
  } catch (err) {
    throw new ChainError('tron', `TronGrid request failed (${path})`, err);
  }
  if (!res.ok) {
    throw new ChainError('tron', `TronGrid HTTP ${res.status} (${path})`);
  }
  return (await res.json()) as T;
}

interface TronAccount {
  balance?: number;
  trc20?: Array<Record<string, string>>;
}

interface TronAccountResp {
  data?: TronAccount[];
}

interface Trc20Transfer {
  transaction_id: string;
  from: string;
  to: string;
  value: string;
  block_timestamp: number;
  token_info?: { symbol?: string; decimals?: number };
}

interface NativeTxContract {
  type?: string;
  parameter?: {
    value?: {
      owner_address?: string;
      to_address?: string;
      amount?: number;
      contract_address?: string;
    };
  };
}

interface NativeTx {
  txID: string;
  block_timestamp: number;
  raw_data?: { contract?: NativeTxContract[] };
}

interface ListResp<T> {
  data?: T[];
}

function rawToUnits(raw: string, decimals: number): number {
  try {
    return Number(BigInt(raw)) / 10 ** decimals;
  } catch {
    return 0;
  }
}

function directionOf(from: string, to: string, watched: string): TxDirection {
  if (from === watched && to === watched) return 'self';
  if (from === watched) return 'out';
  return 'in';
}

export function createTronAdapter(): ChainAdapter {
  return {
    family: 'tron',

    validateAddress(address: string): boolean {
      return TRON_ADDRESS_RE.test(address);
    },

    async getBalance(address: string): Promise<BalanceSnapshot[]> {
      const resp = await getJson<TronAccountResp>(`/v1/accounts/${address}`);
      const account = resp.data?.[0];
      const out: BalanceSnapshot[] = [
        { asset: 'TRX', amount: (account?.balance ?? 0) / SUN_PER_TRX },
      ];

      // TRC20 balances arrive as an array of { contractAddress: rawBalance } maps.
      // We don't have decimals/symbol here, so report under the contract address.
      // TODO: resolve symbol + decimals per contract for nicer balance labels.
      if (Array.isArray(account?.trc20)) {
        for (const entry of account!.trc20) {
          for (const [contract, raw] of Object.entries(entry)) {
            const amount = rawToUnits(raw, 6); // assume 6 decimals (most TRC20)
            if (amount > 0) out.push({ asset: contract, amount });
          }
        }
      }
      return out;
    },

    async getRecentTransactions(
      address: string,
      opts: GetTxOptions,
    ): Promise<NormalizedTx[]> {
      const limit = opts.limit ?? 50;
      const sinceMs = (opts.sinceTs ?? 0) * 1000;

      const [native, trc20] = await Promise.all([
        getJson<ListResp<NativeTx>>(
          `/v1/accounts/${address}/transactions?limit=${limit}`,
        ),
        getJson<ListResp<Trc20Transfer>>(
          `/v1/accounts/${address}/transactions/trc20?limit=${limit}`,
        ),
      ]);

      const out: NormalizedTx[] = [];

      for (const tx of native.data ?? []) {
        if (tx.block_timestamp < sinceMs) continue;
        const contract = tx.raw_data?.contract?.[0];
        const v = contract?.parameter?.value;
        const type = contract?.type;
        // TriggerSmartContract with no native amount is typically an approval or
        // token interaction; flag approve() best-effort.
        // TODO: decode contract data to distinguish approve() precisely.
        let txType: TxType = 'native';
        let amount = (v?.amount ?? 0) / SUN_PER_TRX;
        if (type === 'TriggerSmartContract' && !v?.amount) {
          txType = 'approval';
          amount = 0;
        }
        const from = v?.owner_address ?? '';
        const to = v?.to_address ?? v?.contract_address ?? '';
        out.push({
          hash: tx.txID,
          from,
          to: to || null,
          direction: directionOf(from, to, address),
          asset: 'TRX',
          amount,
          type: txType,
          timestamp: Math.floor(tx.block_timestamp / 1000),
        });
      }

      for (const t of trc20.data ?? []) {
        if (t.block_timestamp < sinceMs) continue;
        const decimals = t.token_info?.decimals ?? 6;
        out.push({
          hash: t.transaction_id,
          from: t.from,
          to: t.to || null,
          direction: directionOf(t.from, t.to, address),
          asset: t.token_info?.symbol || 'TRC20',
          amount: rawToUnits(t.value, decimals),
          type: 'token',
          timestamp: Math.floor(t.block_timestamp / 1000),
        });
      }

      out.sort((a, b) => b.timestamp - a.timestamp);
      return out.slice(0, limit);
    },
  };
}
