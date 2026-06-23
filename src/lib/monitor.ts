import { getAdapter } from '@/lib/chains';
import { ChainError, type BalanceSnapshot, type NormalizedTx } from '@/lib/chains/types';
import { evaluate } from '@/lib/rules/engine';
import type { Alert } from '@/lib/rules/types';
import type { Snapshot, Store, WatchedAddress } from '@/lib/store/types';

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
  error?: string;
}

export interface CheckRunResult {
  checkedAt: number;
  results: AddressCheckResult[];
  alerts: Alert[];
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

    const [balances, txs] = await Promise.all([
      adapter.getBalance(address.address),
      adapter.getRecentTransactions(address.address, {
        sinceTs: prev?.lastTs,
        limit: TX_FETCH_LIMIT,
      }),
    ]);

    const alerts = evaluate({ address, prev, balances, txs });

    await store.saveSnapshot(
      buildSnapshot(address, checkedAt, balances, txs, prev),
    );

    return {
      ...base,
      ok: true,
      baseline: prev === null,
      alerts,
      balances,
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
export async function runCheck(store: Store): Promise<CheckRunResult> {
  const checkedAt = Math.floor(Date.now() / 1000);
  const addresses = await store.listAddresses();

  const results = await Promise.all(
    addresses.map((addr) => checkAddress(store, addr, checkedAt)),
  );

  const alerts = results.flatMap((r) => r.alerts);
  return { checkedAt, results, alerts };
}
