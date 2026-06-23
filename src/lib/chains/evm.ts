import {
  type BalanceSnapshot,
  type ChainAdapter,
  ChainError,
  type ChainId,
  type GetTxOptions,
  type NormalizedTx,
  type TxDirection,
  type TxType,
} from './types';

interface EvmChainMeta {
  /** Etherscan V2 numeric chain id. */
  etherscanChainId: number;
  nativeSymbol: string;
  /** Env var name for an optional custom JSON-RPC endpoint. */
  rpcEnv: string;
  /** Fallback public RPC if no env override is supplied. */
  defaultRpc: string;
}

const EVM_CHAINS: Record<string, EvmChainMeta> = {
  ethereum: {
    etherscanChainId: 1,
    nativeSymbol: 'ETH',
    rpcEnv: 'ETHEREUM_RPC_URL',
    defaultRpc: 'https://eth.llamarpc.com',
  },
  bsc: {
    etherscanChainId: 56,
    nativeSymbol: 'BNB',
    rpcEnv: 'BSC_RPC_URL',
    defaultRpc: 'https://bsc-dataseed.binance.org',
  },
  polygon: {
    etherscanChainId: 137,
    nativeSymbol: 'MATIC',
    rpcEnv: 'POLYGON_RPC_URL',
    defaultRpc: 'https://polygon-rpc.com',
  },
  arbitrum: {
    etherscanChainId: 42161,
    nativeSymbol: 'ETH',
    rpcEnv: 'ARBITRUM_RPC_URL',
    defaultRpc: 'https://arb1.arbitrum.io/rpc',
  },
  optimism: {
    etherscanChainId: 10,
    nativeSymbol: 'ETH',
    rpcEnv: 'OPTIMISM_RPC_URL',
    defaultRpc: 'https://mainnet.optimism.io',
  },
  base: {
    etherscanChainId: 8453,
    nativeSymbol: 'ETH',
    rpcEnv: 'BASE_RPC_URL',
    defaultRpc: 'https://mainnet.base.org',
  },
};

const EVM_ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;

// ERC20 approve(address,uint256) and ERC721/1155 setApprovalForAll(address,bool).
const APPROVE_METHOD_ID = '0x095ea7b3';
const SET_APPROVAL_FOR_ALL_METHOD_ID = '0xa22cb465';

const WEI_PER_ETH = 1e18;

/** Convert a (possibly hex) wei string into human units, tolerating big values. */
function weiToUnits(weiHex: string): number {
  try {
    const wei = weiHex.startsWith('0x') ? BigInt(weiHex) : BigInt(weiHex);
    // Number() loses precision past 2^53 but is fine for display/threshold use.
    return Number(wei) / WEI_PER_ETH;
  } catch {
    return 0;
  }
}

function rawToUnits(raw: string, decimals: number): number {
  try {
    const value = BigInt(raw);
    const divisor = 10 ** decimals;
    return Number(value) / divisor;
  } catch {
    return 0;
  }
}

async function jsonRpc<T>(
  chainId: ChainId,
  rpcUrl: string,
  method: string,
  params: unknown[],
): Promise<T> {
  let res: Response;
  try {
    res = await fetch(rpcUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    });
  } catch (err) {
    throw new ChainError(chainId, `RPC request failed (${method})`, err);
  }
  if (!res.ok) {
    throw new ChainError(chainId, `RPC HTTP ${res.status} (${method})`);
  }
  const body = (await res.json()) as { result?: T; error?: { message: string } };
  if (body.error) {
    throw new ChainError(chainId, `RPC error: ${body.error.message}`);
  }
  return body.result as T;
}

interface EtherscanTxRow {
  hash: string;
  from: string;
  to: string;
  value: string;
  timeStamp: string;
  blockNumber: string;
  input?: string;
  tokenSymbol?: string;
  tokenDecimal?: string;
  contractAddress?: string;
}

async function etherscanList(
  chainId: ChainId,
  meta: EvmChainMeta,
  address: string,
  action: 'txlist' | 'tokentx',
  apiKey: string,
): Promise<EtherscanTxRow[]> {
  const url = new URL('https://api.etherscan.io/v2/api');
  url.searchParams.set('chainid', String(meta.etherscanChainId));
  url.searchParams.set('module', 'account');
  url.searchParams.set('action', action);
  url.searchParams.set('address', address);
  url.searchParams.set('startblock', '0');
  url.searchParams.set('endblock', '99999999');
  url.searchParams.set('page', '1');
  url.searchParams.set('offset', '50');
  url.searchParams.set('sort', 'desc');
  url.searchParams.set('apikey', apiKey);

  let res: Response;
  try {
    res = await fetch(url, { headers: { accept: 'application/json' } });
  } catch (err) {
    throw new ChainError(chainId, `Etherscan request failed (${action})`, err);
  }
  if (!res.ok) {
    throw new ChainError(chainId, `Etherscan HTTP ${res.status} (${action})`);
  }
  const body = (await res.json()) as {
    status: string;
    message: string;
    result: EtherscanTxRow[] | string;
  };
  // status "0" with "No transactions found" is a normal empty result.
  if (body.status !== '1') {
    if (typeof body.result === 'string' && /no transactions/i.test(body.result)) {
      return [];
    }
    if (Array.isArray(body.result)) return body.result;
    return [];
  }
  return Array.isArray(body.result) ? body.result : [];
}

function directionOf(from: string, to: string | null, watched: string): TxDirection {
  const f = from.toLowerCase();
  const t = (to ?? '').toLowerCase();
  const w = watched.toLowerCase();
  if (f === w && t === w) return 'self';
  if (f === w) return 'out';
  return 'in';
}

export function createEvmAdapter(chainId: ChainId): ChainAdapter {
  const meta = EVM_CHAINS[chainId];
  if (!meta) {
    throw new Error(`createEvmAdapter: ${chainId} is not an EVM chain`);
  }

  const rpcUrl = process.env[meta.rpcEnv] || meta.defaultRpc;

  return {
    family: 'evm',

    validateAddress(address: string): boolean {
      return EVM_ADDRESS_RE.test(address);
    },

    async getBalance(address: string): Promise<BalanceSnapshot[]> {
      const hex = await jsonRpc<string>(chainId, rpcUrl, 'eth_getBalance', [
        address,
        'latest',
      ]);
      return [{ asset: meta.nativeSymbol, amount: weiToUnits(hex) }];
    },

    async getRecentTransactions(
      address: string,
      opts: GetTxOptions,
    ): Promise<NormalizedTx[]> {
      const apiKey = process.env.ETHERSCAN_API_KEY;
      if (!apiKey) {
        // Degrade gracefully: balance-based rules still work without history.
        console.warn(
          `[evm:${chainId}] ETHERSCAN_API_KEY not set — skipping transaction history.`,
        );
        return [];
      }

      const [native, tokens] = await Promise.all([
        etherscanList(chainId, meta, address, 'txlist', apiKey),
        etherscanList(chainId, meta, address, 'tokentx', apiKey),
      ]);

      const out: NormalizedTx[] = [];

      for (const row of native) {
        const input = (row.input ?? '').toLowerCase();
        let type: TxType = 'native';
        let amount = weiToUnits(row.value);
        // An approval is a method call carrying no native value; flag it so the
        // approval rule can fire (drainer defense).
        if (input.startsWith(APPROVE_METHOD_ID)) {
          type = 'approval';
          amount = 0;
        } else if (input.startsWith(SET_APPROVAL_FOR_ALL_METHOD_ID)) {
          type = 'nft_approval';
          amount = 0;
        }
        out.push({
          hash: row.hash,
          from: row.from,
          to: row.to || null,
          direction: directionOf(row.from, row.to, address),
          asset: meta.nativeSymbol,
          amount,
          type,
          timestamp: parseInt(row.timeStamp, 10) || 0,
          blockNumber: parseInt(row.blockNumber, 10) || undefined,
        });
      }

      for (const row of tokens) {
        const decimals = parseInt(row.tokenDecimal ?? '18', 10) || 18;
        out.push({
          hash: row.hash,
          from: row.from,
          to: row.to || null,
          direction: directionOf(row.from, row.to, address),
          asset: row.tokenSymbol || row.contractAddress || 'TOKEN',
          amount: rawToUnits(row.value, decimals),
          type: 'token',
          timestamp: parseInt(row.timeStamp, 10) || 0,
          blockNumber: parseInt(row.blockNumber, 10) || undefined,
        });
      }

      const since = opts.sinceTs ?? 0;
      const filtered = out
        .filter((tx) => tx.timestamp >= since)
        .sort((a, b) => b.timestamp - a.timestamp);

      return typeof opts.limit === 'number'
        ? filtered.slice(0, opts.limit)
        : filtered;
    },
  };
}
