import { getAdapter } from '@/lib/chains';
import { ChainError, type BalanceSnapshot, type NormalizedTx } from '@/lib/chains/types';
import { evaluate } from '@/lib/rules/engine';
import type { Alert } from '@/lib/rules/types';
import type {
  Snapshot,
  StoredAlert,
  Store,
  WatchedAddress,
} from '@/lib/store/types';
import { getNotifier, type Notifier } from '@/lib/notify';
import { getPriceProvider, type PriceProvider } from '@/lib/prices/coingecko';

/** Cap on tx hashes retained per snapshot so the JSON file can't grow forever. */
const MAX_SEEN_HASHES = 500;
/** How many recent transactions to pull per check. */
const TX_FETCH_LIMIT = 50;

export interface AddressCheckResult {
  addressId: string;
  label: string;
  address: string;
  chainId: WatchedAddress['chainId'];
  ok: boolean;
  /** Whether this was the baseline (first-ever) check — no alerts by design. */
  baseline: boolean;
  alerts: Alert[];
  balances: BalanceSnapshot[];
  /** Total USD value of this address's priced balances, when available. */
  usdTotal?: number;
  error?: string;
}

/**
 * Attach usdValue to balances and transactions in place-free copies, using a
 * single batched price lookup. Returns the priced copies plus the portfolio
 * USD total. Never throws — missing prices simply leave usdValue undefined.
 */
async function enrichWithUsd(
  prices: PriceProvider,
  balances: BalanceSnapshot[],
  txs: NormalizedTx[],
): Promise<{
  balances: BalanceSnapshot[];
  txs: NormalizedTx[];
  usdTotal: number | undefined;
}> {
  const symbols = new Set<string>();
  for (const b of balances) symbols.add(b.asset);
  for (const t of txs) symbols.add(t.asset);
  if (symbols.size === 0) return { balances, txs, usdTotal: undefined };

  let priceMap: Record<string, number | undefined> = {};
  try {
    priceMap = await prices.getPrices([...symbols]);
  } catch {
    // degrade to native-only
    return { balances, txs, usdTotal: undefined };
  }

  let usdTotal: number | undefined;
  const pricedBalances = balances.map((b) => {
    const p = priceMap[b.asset];
    if (typeof p === 'number') {
      const v = p * b.amount;
      usdTotal = (usdTotal ?? 0) + v;
      return { ...b, usdValue: v };
    }
    return b;
  });
  const pricedTxs = txs.map((t) => {
    const p = priceMap[t.asset];
    return typeof p === 'number' ? { ...t, usdValue: p * t.amount } : t;
  });

  return { balances: pricedBalances, txs: pricedTxs, usdTotal };
}

export interface CheckRunResult {
  checkedAt: number;
  results: AddressCheckResult[];
  /** All alerts produced this run (including ones already seen before). */
  alerts: Alert[];
  /** Alerts newly persisted this run (deduped) — the set worth notifying on. */
  newAlerts: StoredAlert[];
  /** Sum of all priced balances across addresses, when any price was available. */
  portfolioUsd?: number;
}

function buildSnapshot(
  address: WatchedAddress,
  checkedAt: number,
  balances: BalanceSnapshot[],
  txs: NormalizedTx[],
  prev: Snapshot | null,
): Snapshot {
  const balanceMap: Record<string, number> = {};
  for (const b of balances) balanceMap[b.asset] = b.amount;

  // Merge previously-seen hashes with the freshly observed ones, newest first,
  // then cap. Keeping prior hashes prevents an old tx that scrolls back into the
  // API window from re-alerting as "new".
  const freshHashes = txs.map((t) => t.hash);
  const merged = [...freshHashes, ...(prev?.seenTxHashes ?? [])];
  const seenTxHashes = Array.from(new Set(merged)).slice(0, MAX_SEEN_HASHES);

  const latestTs = txs.reduce((max, t) => Math.max(max, t.timestamp), prev?.lastTs ?? 0);

  return {
    addressId: address.id,
    checkedAt,
    balances: balanceMap,
    seenTxHashes,
    lastTs: latestTs,
  };
}

/** Run one address: fetch state, evaluate rules against the prior snapshot, persist. */
export async function checkAddress(
  store: Store,
  address: WatchedAddress,
  checkedAt: number,
  prices: PriceProvider = getPriceProvider(),
): Promise<AddressCheckResult> {
  const base = {
    addressId: address.id,
    label: address.label,
    address: address.address,
    chainId: address.chainId,
  };

  try {
    const adapter = getAdapter(address.chainId);
    const prev = await store.getSnapshot(address.id);

    const [rawBalances, rawTxs] = await Promise.all([
      adapter.getBalance(address.address),
      adapter.getRecentTransactions(address.address, {
        sinceTs: prev?.lastTs,
        limit: TX_FETCH_LIMIT,
      }),
    ]);

    // Enrich with USD so balance display, portfolio totals, and USD-denominated
    // withdrawal thresholds all work. Degrades to native-only on price failure.
    const { balances, txs, usdTotal } = await enrichWithUsd(
      prices,
      rawBalances,
      rawTxs,
    );

    const alerts = evaluate({ address, prev, balances, txs });

    // Write atomically and union seen hashes with whatever a concurrent webhook
    // may have added since we read `prev`, so neither writer drops the other's
    // hashes. Fresh balances from this poll are authoritative.
    await store.updateSnapshot(address.id, (cur) => {
      const base = buildSnapshot(address, checkedAt, balances, txs, prev);
      const seenTxHashes = Array.from(
        new Set([...base.seenTxHashes, ...(cur?.seenTxHashes ?? [])]),
      ).slice(0, MAX_SEEN_HASHES);
      return {
        ...base,
        seenTxHashes,
        lastTs: Math.max(base.lastTs, cur?.lastTs ?? 0),
      };
    });

    return {
      ...base,
      ok: true,
      baseline: prev === null,
      alerts,
      balances,
      usdTotal,
    };
  } catch (err) {
    const message =
      err instanceof ChainError
        ? err.message
        : err instanceof Error
          ? err.message
          : String(err);
    return { ...base, ok: false, baseline: false, alerts: [], balances: [], error: message };
  }
}

/**
 * Check every watched address. Failures are isolated per-address (a single
 * failing chain never aborts the run), and all addresses are checked
 * concurrently.
 */
export async function runCheck(
  store: Store,
  notifier: Notifier = getNotifier(),
): Promise<CheckRunResult> {
  const checkedAt = Math.floor(Date.now() / 1000);
  const addresses = await store.listAddresses();

  const results = await Promise.all(
    addresses.map((addr) => checkAddress(store, addr, checkedAt)),
  );

  const alerts = results.flatMap((r) => r.alerts);
  // Persist only newly-seen alerts (deduped by dedupKey) so history doesn't
  // bloat and downstream notifiers fire exactly once per real event.
  const newAlerts = await store.appendAlerts(alerts, checkedAt);
  // Notify on exactly the newly-persisted alerts. Never let delivery failures
  // surface into the run result.
  if (newAlerts.length > 0) {
    try {
      await notifier.dispatch(newAlerts);
    } catch {
      // notifier.dispatch is already failure-isolated; this is belt-and-braces.
    }
  }
  const priced = results.filter((r) => typeof r.usdTotal === 'number');
  const portfolioUsd = priced.length
    ? priced.reduce((sum, r) => sum + (r.usdTotal ?? 0), 0)
    : undefined;

  return { checkedAt, results, alerts, newAlerts, portfolioUsd };
}
