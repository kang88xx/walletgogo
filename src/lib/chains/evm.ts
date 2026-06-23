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

// ERC20 balanceOf(address) selector.
const BALANCE_OF_SELECTOR = '0x70a08231';
/** Cap how many token balanceOf calls we make per address per check. */
const MAX_TOKEN_BALANCE_QUERIES = 25;

export interface HeldToken {
  contract: string;
  symbol: string;
  decimals: number;
}

/**
 * From a list of ERC20 transfer rows (Etherscan tokentx), derive the unique set
 * of token contracts the address has interacted with, preserving recency order
 * (rows are desc by time) and capping the count.
 */
export function deriveHeldTokens(
  rows: Array<{
    contractAddress?: string;
    tokenSymbol?: string;
    tokenDecimal?: string;
  }>,
  cap: number = MAX_TOKEN_BALANCE_QUERIES,
): HeldToken[] {
  const seen = new Set<string>();
  const out: HeldToken[] = [];
  for (const row of rows) {
    const contract = row.contractAddress?.toLowerCase();
    if (!contract || seen.has(contract)) continue;
    seen.add(contract);
    out.push({
      contract,
      symbol: row.tokenSymbol || contract,
      decimals: parseInt(row.tokenDecimal ?? '18', 10) || 18,
    });
    if (out.length >= cap) break;
  }
  return out;
}

/** ABI-encode balanceOf(address): selector + 32-byte left-padded address. */
export function encodeBalanceOf(address: string): string {
  const clean = address.toLowerCase().replace(/^0x/, '');
  return BALANCE_OF_SELECTOR + clean.padStart(64, '0');
}

/** Decode a uint256 hex return value into human units. Empty/0x => 0. */
export function decodeUint256(hex: string, decimals: number): number {
  if (!hex || hex === '0x') return 0;
  try {
    const value = BigInt(hex);
    return Number(value) / 10 ** decimals;
  } catch {
    return 0;
  }
}

/**
 * Anything at or above 2^255 is treated as an effectively-unlimited allowance.
 * Covers MaxUint256 (the canonical "infinite approve") and the 2^255-ish values
 * some routers use, without false-positiving normal large approvals.
 */
const UNLIMITED_THRESHOLD = 2n ** 255n;

function addressFromWord(word: string): string {
  // last 20 bytes (40 hex chars) of a 32-byte ABI word
  return '0x' + word.slice(24).toLowerCase();
}

export interface ApproveDecode {
  spender: string;
  amount: bigint;
  unlimited: boolean;
}

/** Decode approve(address,uint256) calldata. Returns null if it doesn't fit. */
export function decodeApprove(input: string): ApproveDecode | null {
  const data = input.toLowerCase();
  if (!data.startsWith(APPROVE_METHOD_ID)) return null;
  const body = data.slice(APPROVE_METHOD_ID.length); // strip selector
  if (body.length < 128) return null; // need 2 words
  try {
    const spender = addressFromWord(body.slice(0, 64));
    const amount = BigInt('0x' + body.slice(64, 128));
    return { spender, amount, unlimited: amount >= UNLIMITED_THRESHOLD };
  } catch {
    return null;
  }
}

export interface SetApprovalForAllDecode {
  operator: string;
  approved: boolean;
}

/** Decode setApprovalForAll(address,bool) calldata. Returns null if malformed. */
export function decodeSetApprovalForAll(
  input: string,
): SetApprovalForAllDecode | null {
  const data = input.toLowerCase();
  if (!data.startsWith(SET_APPROVAL_FOR_ALL_METHOD_ID)) return null;
  const body = data.slice(SET_APPROVAL_FOR_ALL_METHOD_ID.length);
  if (body.length < 128) return null;
  try {
    const operator = addressFromWord(body.slice(0, 64));
    const approved = BigInt('0x' + body.slice(64, 128)) !== 0n;
    return { operator, approved };
  } catch {
    return null;
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
      const out: BalanceSnapshot[] = [
        { asset: meta.nativeSymbol, amount: weiToUnits(hex) },
      ];

      // Token balances need the address's token contract set, which we derive
      // from Etherscan tokentx history. Without an API key we degrade to
      // native-only rather than failing.
      const apiKey = process.env.ETHERSCAN_API_KEY;
      if (!apiKey) return out;

      try {
        const tokenRows = await etherscanList(
          chainId,
          meta,
          address,
          'tokentx',
          apiKey,
        );
        const held = deriveHeldTokens(tokenRows);
        // Query balanceOf per token; isolate failures so one bad token or RPC
        // hiccup never drops the whole balance call.
        const balances = await Promise.all(
          held.map(async (t): Promise<BalanceSnapshot | null> => {
            try {
              const data = encodeBalanceOf(address);
              const resHex = await jsonRpc<string>(chainId, rpcUrl, 'eth_call', [
                { to: t.contract, data },
                'latest',
              ]);
              const amount = decodeUint256(resHex, t.decimals);
              return amount > 0 ? { asset: t.symbol, amount } : null;
            } catch {
              return null;
            }
          }),
        );
        for (const b of balances) if (b) out.push(b);
      } catch {
        // tokentx fetch failed — keep native-only.
      }

      return out;
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
        let spender: string | undefined;
        let unlimited: boolean | undefined;
        // Approvals carry no native value but grant token/NFT control — the core
        // drainer vector. Decode the spender so the alert can name it, and flag
        // unlimited allowances as the highest-risk case.
        const approve = decodeApprove(input);
        const setAll = decodeSetApprovalForAll(input);
        if (approve) {
          type = 'approval';
          amount = 0;
          spender = approve.spender;
          unlimited = approve.unlimited;
        } else if (setAll) {
          type = 'nft_approval';
          amount = 0;
          spender = setAll.operator;
          // setApprovalForAll(operator, true) hands over the whole collection.
          unlimited = setAll.approved;
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
          spender,
          unlimited,
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
