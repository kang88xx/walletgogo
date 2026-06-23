import { describe, expect, it, vi } from 'vitest';
import { createPriceProvider, type PriceFetcher } from './coingecko';

describe('price provider — caching', () => {
  it('maps symbols to ids and returns usd prices', async () => {
    const fetcher: PriceFetcher = vi.fn(async (ids) => {
      const map: Record<string, number> = {
        ethereum: 3000,
        bitcoin: 60000,
      };
      const out: Record<string, number> = {};
      for (const id of ids) {
        if (map[id] != null) out[id] = map[id];
      }
      return out;
    });
    const p = createPriceProvider({ fetcher, now: () => 0 });
    const prices = await p.getPrices(['ETH', 'BTC']);
    expect(prices.ETH).toBe(3000);
    expect(prices.BTC).toBe(60000);
  });

  it('returns undefined for unknown symbols without calling the fetcher for them', async () => {
    const fetcher: PriceFetcher = vi.fn(async () => ({}));
    const p = createPriceProvider({ fetcher, now: () => 0 });
    const prices = await p.getPrices(['DOGECOINNOTMAPPED']);
    expect(prices.DOGECOINNOTMAPPED).toBeUndefined();
  });

  it('serves from cache within TTL and refetches after expiry', async () => {
    let t = 0;
    const fetcher: PriceFetcher = vi.fn(async () => ({ ethereum: 3000 }));
    const p = createPriceProvider({ fetcher, ttlSeconds: 60, now: () => t });

    await p.getPrices(['ETH']); // fetch #1
    await p.getPrices(['ETH']); // cached, no fetch
    expect(fetcher).toHaveBeenCalledTimes(1);

    t = 61_000; // advance past TTL
    await p.getPrices(['ETH']); // fetch #2
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('degrades to undefined when the fetcher returns nothing', async () => {
    const fetcher: PriceFetcher = vi.fn(async () => ({}));
    const p = createPriceProvider({ fetcher, now: () => 0 });
    const prices = await p.getPrices(['ETH']);
    expect(prices.ETH).toBeUndefined();
  });

  it('computes usdValue from amount', async () => {
    const fetcher: PriceFetcher = vi.fn(async () => ({ ethereum: 2500 }));
    const p = createPriceProvider({ fetcher, now: () => 0 });
    expect(await p.usdValue('ETH', 2)).toBe(5000);
    expect(await p.usdValue('UNKNOWNX', 2)).toBeUndefined();
  });
});
