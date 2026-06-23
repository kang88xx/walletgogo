import { CHAINS } from '@/lib/chains';
import type { NormalizedTx, TxDirection } from '@/lib/chains/types';
import { evaluate } from '@/lib/rules/engine';
import { getNotifier, type Notifier } from '@/lib/notify';
import type { Snapshot, Store, WatchedAddress } from '@/lib/store/types';
import type { ParsedActivity } from './parse';

const MAX_SEEN_HASHES = 500;

/** Address equality, case-insensitive for EVM where addresses are hex. */
export function addressesMatch(
  a: string,
  b: string,
  chainId: WatchedAddress['chainId'],
): boolean {
  if (!a || !b) return false;
  if (CHAINS[chainId]?.family === 'evm') return a.toLowerCase() === b.toLowerCase();
  return a === b;
}

function directionFor(
  activity: ParsedActivity,
  watched: string,
  chainId: WatchedAddress['chainId'],
): TxDirection {
  const isFrom = addressesMatch(activity.from, watched, chainId);
  const isTo = activity.to ? addressesMatch(activity.to, watched, chainId) : false;
  if (isFrom && isTo) return 'self';
  if (isFrom) return 'out';
  return 'in';
}

function toNormalizedTx(
  activity: ParsedActivity,
  address: WatchedAddress,
): NormalizedTx {
  return {
    hash: activity.hash,
    from: activity.from,
    to: activity.to,
    direction: directionFor(activity, address.address, address.chainId),
    asset: activity.asset,
    amount: activity.amount,
    type: activity.isToken ? 'token' : 'native',
    timestamp: activity.timestamp,
  };
}

export interface WebhookProcessResult {
  matchedAddresses: number;
  newAlerts: number;
}

/**
 * Process parsed webhook activities: match each to watched addresses, run the
 * rule engine in real time, persist deduped alerts, update the seen-hash
 * snapshot so polling won't double-alert, and notify. A never-polled address
 * gets a synthetic baseline so its first webhook event still alerts.
 */
export async function processWebhookActivities(
  store: Store,
  activities: ParsedActivity[],
  notifier: Notifier = getNotifier(),
): Promise<WebhookProcessResult> {
  if (activities.length === 0) return { matchedAddresses: 0, newAlerts: 0 };

  const addresses = await store.listAddresses();
  const firedAt = Math.floor(Date.now() / 1000);
  let matchedAddresses = 0;
  let newAlertCount = 0;

  for (const address of addresses) {
    const relevant = activities.filter(
      (a) =>
        a.chainId === address.chainId &&
        (addressesMatch(a.from, address.address, address.chainId) ||
          (a.to ? addressesMatch(a.to, address.address, address.chainId) : false)),
    );
    if (relevant.length === 0) continue;
    matchedAddresses++;

    const txs = relevant.map((a) => toNormalizedTx(a, address));
    const stored = await store.getSnapshot(address.id);
    // Synthetic baseline so a first-ever event still evaluates (webhooks are
    // inherently "new" events, unlike a first poll that just sets a baseline).
    const prev: Snapshot =
      stored ?? {
        addressId: address.id,
        checkedAt: 0,
        balances: {},
        seenTxHashes: [],
        lastTs: 0,
      };

    const alerts = evaluate({ address, prev, balances: [], txs });
    // Store-level dedup (by dedupKey) is the cross-delivery / webhook-vs-poll
    // guard, so it holds even when we don't persist a snapshot below.
    const inserted = await store.appendAlerts(alerts, firedAt);
    newAlertCount += inserted.length;

    // Atomically record the seen hashes onto the CURRENT snapshot so a poll
    // running concurrently can't be clobbered. Critically, we do NOT fabricate
    // a snapshot for a never-polled address: persisting empty balances would
    // make the first poll diff every balance from 0 and flood balance_change.
    // For those addresses the next poll establishes the real baseline; store
    // dedupKey still prevents re-alerting the webhook tx.
    // Notify BEFORE the snapshot write. If the write later fails and the
    // provider retries, appendAlerts dedups the already-stored alert — so
    // notifying first ensures the user isn't silently skipped on retry.
    if (inserted.length > 0) {
      try {
        await notifier.dispatch(inserted);
      } catch {
        // notifier is failure-isolated; belt-and-braces
      }
    }

    const hashes = txs.map((t) => t.hash);
    const maxTs = txs.reduce((m, t) => Math.max(m, t.timestamp), 0);
    await store.updateSnapshot(address.id, (cur) => {
      if (!cur) return null; // never polled — leave the baseline to the poller
      const seenTxHashes = Array.from(
        new Set([...hashes, ...cur.seenTxHashes]),
      ).slice(0, MAX_SEEN_HASHES);
      return {
        ...cur,
        seenTxHashes,
        lastTs: Math.max(cur.lastTs, maxTs),
      };
    });
  }

  return { matchedAddresses, newAlerts: newAlertCount };
}
