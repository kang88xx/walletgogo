import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { Alert, AlertRuleConfig } from '@/lib/rules/types';
import { DEFAULT_RULES } from '@/lib/rules/types';
import type {
  AddAddressInput,
  Snapshot,
  StoredAlert,
  Store,
  WatchedAddress,
} from './types';

/** Hard cap on persisted alert history so the JSON file stays bounded. */
const ALERT_CAP = 1000;

interface PersistShape {
  addresses: WatchedAddress[];
  /** addressId -> latest snapshot */
  snapshots: Record<string, Snapshot>;
  /** Persisted alert history, newest-first. */
  alerts: StoredAlert[];
}

const EMPTY: PersistShape = { addresses: [], snapshots: {}, alerts: [] };

function defaultDataFile(): string {
  if (process.env.WALLET_GOGO_DATA_FILE) return process.env.WALLET_GOGO_DATA_FILE;
  // On Vercel/serverless only /tmp is writable (and ephemeral). For durable
  // storage, point WALLET_GOGO_DATA_FILE at a real volume or swap the Store.
  if (process.env.VERCEL) return '/tmp/wallet-gogo.json';
  return join(process.cwd(), '.data', 'wallet-gogo.json');
}

/**
 * A small JSON-file-backed Store. State is loaded once and held in memory, then
 * flushed to disk after every mutation. Writes are serialized through a single
 * promise chain so concurrent API requests can't interleave a read-modify-write
 * and clobber each other.
 *
 * This is intentionally dependency-free (no DB). It's the right default for a
 * local/self-hosted monitor; swap in a real Store implementation later by
 * keeping the same interface.
 */
export function createFileStore(dataFile: string = defaultDataFile()): Store {
  let cache: PersistShape | null = null;
  // Serializes all disk access; every public method awaits the prior op first.
  let chain: Promise<unknown> = Promise.resolve();

  async function load(): Promise<PersistShape> {
    if (cache) return cache;
    try {
      const raw = await readFile(dataFile, 'utf8');
      const parsed = JSON.parse(raw) as Partial<PersistShape>;
      cache = {
        addresses: Array.isArray(parsed.addresses) ? parsed.addresses : [],
        snapshots:
          parsed.snapshots && typeof parsed.snapshots === 'object'
            ? parsed.snapshots
            : {},
        alerts: Array.isArray(parsed.alerts) ? parsed.alerts : [],
      };
    } catch (err) {
      // Missing file on first run is expected; anything else we surface.
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        cache = { addresses: [], snapshots: {}, alerts: [] };
      } else {
        throw err;
      }
    }
    return cache;
  }

  async function flush(): Promise<void> {
    const data = cache ?? EMPTY;
    await mkdir(dirname(dataFile), { recursive: true });
    await writeFile(dataFile, JSON.stringify(data, null, 2), 'utf8');
  }

  // Run `fn` after any in-flight operation, keeping the chain alive on error.
  function enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const next = chain.then(fn, fn);
    chain = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  return {
    listAddresses(): Promise<WatchedAddress[]> {
      return enqueue(async () => {
        const data = await load();
        return [...data.addresses];
      });
    },

    addAddress(input: AddAddressInput): Promise<WatchedAddress> {
      return enqueue(async () => {
        const data = await load();
        const entry: WatchedAddress = {
          id: randomUUID(),
          label: input.label,
          address: input.address,
          chainId: input.chainId,
          rules: input.rules ?? DEFAULT_RULES,
          createdAt: Math.floor(Date.now() / 1000),
        };
        data.addresses.push(entry);
        await flush();
        return entry;
      });
    },

    removeAddress(id: string): Promise<void> {
      return enqueue(async () => {
        const data = await load();
        data.addresses = data.addresses.filter((a) => a.id !== id);
        delete data.snapshots[id];
        await flush();
      });
    },

    updateAddressRules(
      id: string,
      rules: AlertRuleConfig,
    ): Promise<WatchedAddress | null> {
      return enqueue(async () => {
        const data = await load();
        const entry = data.addresses.find((a) => a.id === id);
        if (!entry) return null;
        entry.rules = rules;
        await flush();
        return entry;
      });
    },

    getSnapshot(addressId: string): Promise<Snapshot | null> {
      return enqueue(async () => {
        const data = await load();
        return data.snapshots[addressId] ?? null;
      });
    },

    saveSnapshot(snapshot: Snapshot): Promise<void> {
      return enqueue(async () => {
        const data = await load();
        data.snapshots[snapshot.addressId] = snapshot;
        await flush();
      });
    },

    updateSnapshot(
      addressId: string,
      merge: (prev: Snapshot | null) => Snapshot | null,
    ): Promise<void> {
      return enqueue(async () => {
        const data = await load();
        const next = merge(data.snapshots[addressId] ?? null);
        if (next === null) return; // no-op
        data.snapshots[addressId] = next;
        await flush();
      });
    },

    listAlerts(limit?: number): Promise<StoredAlert[]> {
      return enqueue(async () => {
        const data = await load();
        return typeof limit === 'number'
          ? data.alerts.slice(0, limit)
          : [...data.alerts];
      });
    },

    appendAlerts(alerts: Alert[], firedAt: number): Promise<StoredAlert[]> {
      return enqueue(async () => {
        const data = await load();
        const seen = new Set(data.alerts.map((a) => a.dedupKey));
        const inserted: StoredAlert[] = [];
        for (const alert of alerts) {
          if (seen.has(alert.dedupKey)) continue;
          seen.add(alert.dedupKey);
          inserted.push({ ...alert, id: randomUUID(), firedAt, read: false });
        }
        if (inserted.length > 0) {
          // newest-first, then cap
          data.alerts = [...inserted, ...data.alerts].slice(0, ALERT_CAP);
          await flush();
        }
        return inserted;
      });
    },

    markAlertsRead(ids?: string[]): Promise<void> {
      return enqueue(async () => {
        const data = await load();
        const idSet = ids ? new Set(ids) : null;
        for (const alert of data.alerts) {
          if (!idSet || idSet.has(alert.id)) alert.read = true;
        }
        await flush();
      });
    },
  };
}
