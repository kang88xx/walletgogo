import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { DEFAULT_RULES } from '@/lib/rules/types';
import type {
  AddAddressInput,
  Snapshot,
  Store,
  WatchedAddress,
} from './types';

interface PersistShape {
  addresses: WatchedAddress[];
  /** addressId -> latest snapshot */
  snapshots: Record<string, Snapshot>;
}

const EMPTY: PersistShape = { addresses: [], snapshots: {} };

function defaultDataFile(): string {
  return process.env.WALLET_GOGO_DATA_FILE || join(process.cwd(), '.data', 'wallet-gogo.json');
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
      };
    } catch (err) {
      // Missing file on first run is expected; anything else we surface.
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        cache = { ...EMPTY, addresses: [], snapshots: {} };
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
  };
}
