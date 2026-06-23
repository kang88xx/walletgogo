/**
 * USD price provider backed by CoinGecko's free API, with an in-memory TTL
 * cache. Designed to never throw into the monitor: any failure resolves to
 * `undefined` for the affected symbols so balance/threshold logic degrades to
 * native-only.
 */

/** Map of asset symbol -> CoinGecko coin id for assets we can price by symbol. */
export const SYMBOL_TO_ID: Record<string, string> = {
  ETH: 'ethereum',
  WETH: 'weth',
  BNB: 'binancecoin',
  MATIC: 'matic-network',
  POL: 'matic-network',
  SOL: 'solana',
  BTC: 'bitcoin',
  TRX: 'tron',
  // Common stablecoins / blue chips priced by symbol (best effort).
  USDT: 'tether',
  USDC: 'usd-coin',
  DAI: 'dai',
  WBTC: 'wrapped-bitcoin',
  ARB: 'arbitrum',
  OP: 'optimism',
  LINK: 'chainlink',
  UNI: 'uniswap',
};

export type PriceFetcher = (ids: string[]) => Promise<Record<string, number>>;

/** Default fetcher: CoinGecko /simple/price. Returns {} on any failure. */
export const coingeckoFetcher: PriceFetcher = async (ids) => {
  if (ids.length === 0) return {};
  try {
    const base =
      process.env.COINGECKO_API_BASE || 'https://api.coingecko.com/api/v3';
    const url = new URL(`${base}/simple/price`);
    url.searchParams.set('ids', ids.join(','));
    url.searchParams.set('vs_currencies', 'usd');
    const headers: Record<string, string> = { accept: 'application/json' };
    const key = process.env.COINGECKO_API_KEY;
    if (key) headers['x-cg-demo-api-key'] = key;

    const res = await fetch(url, { headers });
    if (!res.ok) return {};
    const body = (await res.json()) as Record<string, { usd?: number }>;
    const out: Record<string, number> = {};
    for (const [id, val] of Object.entries(body)) {
      if (typeof val?.usd === 'number') out[id] = val.usd;
    }
    return out;
  } catch {
    return {};
  }
};

interface CacheEntry {
  usd: number;
  at: number; // ms
}

export interface PriceProvider {
  /** USD price per symbol; undefined when unknown/unavailable. */
  getPrices(symbols: string[]): Promise<Record<string, number | undefined>>;
  /** Convenience: USD value of an amount of one asset, or undefined. */
  usdValue(symbol: string, amount: number): Promise<number | undefined>;
}

export interface PriceProviderOptions {
  ttlSeconds?: number;
  fetcher?: PriceFetcher;
  now?: () => number;
  symbolToId?: Record<string, string>;
}

export function createPriceProvider(
  opts: PriceProviderOptions = {},
): PriceProvider {
  const ttlMs = (opts.ttlSeconds ?? 60) * 1000;
  const fetcher = opts.fetcher ?? coingeckoFetcher;
  const now = opts.now ?? Date.now;
  const symbolToId = opts.symbolToId ?? SYMBOL_TO_ID;
  const cache = new Map<string, CacheEntry>(); // keyed by coin id

  async function getPrices(
    symbols: string[],
  ): Promise<Record<string, number | undefined>> {
    const result: Record<string, number | undefined> = {};
    const idsToFetch = new Set<string>();
    const symbolIds: Array<{ symbol: string; id: string | undefined }> = [];

    for (const raw of symbols) {
      const symbol = raw.toUpperCase();
      const id = symbolToId[symbol];
      symbolIds.push({ symbol: raw, id });
      if (!id) {
        result[raw] = undefined;
        continue;
      }
      const cached = cache.get(id);
      if (cached && now() - cached.at < ttlMs) {
        result[raw] = cached.usd;
      } else {
        idsToFetch.add(id);
      }
    }

    if (idsToFetch.size > 0) {
      const fetched = await fetcher([...idsToFetch]);
      const at = now();
      for (const [id, usd] of Object.entries(fetched)) {
        cache.set(id, { usd, at });
      }
      // Fill in any symbol that maps to a freshly-fetched id.
      for (const { symbol, id } of symbolIds) {
        if (id && result[symbol] === undefined) {
          const c = cache.get(id);
          result[symbol] = c ? c.usd : undefined;
        }
      }
    }

    return result;
  }

  async function usdValue(
    symbol: string,
    amount: number,
  ): Promise<number | undefined> {
    const prices = await getPrices([symbol]);
    const p = prices[symbol];
    return typeof p === 'number' ? p * amount : undefined;
  }

  return { getPrices, usdValue };
}

// Process-wide singleton (TTL cache shared across requests + dev reloads).
const g = globalThis as unknown as { __walletGogoPrices?: PriceProvider };

export function getPriceProvider(): PriceProvider {
  if (!g.__walletGogoPrices) g.__walletGogoPrices = createPriceProvider();
  return g.__walletGogoPrices;
}
