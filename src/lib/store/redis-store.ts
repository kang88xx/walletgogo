import { randomUUID } from 'node:crypto';
import type { Alert, AlertRuleConfig } from '@/lib/rules/types';
import { DEFAULT_RULES } from '@/lib/rules/types';
import type {
  AddAddressInput,
  Snapshot,
  StoredAlert,
  Store,
  WatchedAddress,
} from './types';

/** Hard cap on persisted alert history (mirrors the file store). */
const ALERT_CAP = 1000;
/**
 * Dedup window for alert notifications. A dedupKey claimed within this window is
 * never re-notified. Far longer than the file store's "last 1000 alerts" window
 * and bounded (per-key TTL) so the markers can't accumulate forever. 30 days.
 */
const ALERT_SEEN_TTL_SECONDS = 60 * 60 * 24 * 30;
/** Optimistic-concurrency retry budget for updateSnapshot's version CAS. */
const SNAPSHOT_CAS_ATTEMPTS = 8;

/** Redis key namespace. Keep everything under one prefix for easy ops. */
const K = {
  addresses: 'wg:addresses', // hash: id -> WatchedAddress
  addrOrder: 'wg:addr_order', // list: address ids in insertion order
  snapshots: 'wg:snapshots', // hash: addressId -> Snapshot
  snapVer: 'wg:snap_ver', // hash: addressId -> integer version (for CAS)
  alerts: 'wg:alerts', // list: StoredAlert JSON (newest-first, capped)
  alertsRead: 'wg:alerts_read', // set: ids of acknowledged alerts
  alertSeen: (dedupKey: string) => `wg:alert_seen:${dedupKey}`, // SET NX EX marker
};

// NOTE: both Lua scripts below touch keys that hash to different slots
// (e.g. wg:alerts + wg:alert_seen:<key>). That is safe on Upstash, which is a
// single logical keyspace with no cluster slot enforcement — the only target
// this store is wired for. A self-hosted Redis Cluster would reject these
// multi-key EVALs with CROSSSLOT.

/**
 * Compare-and-set a snapshot by its integer version. Comparing the version
 * (not the JSON blob) sidesteps @upstash/redis auto-deserialization, which would
 * otherwise make the stored bytes impossible to match on. Returns 1 on success,
 * 0 if another writer advanced the version first (caller re-reads and retries).
 */
export const SNAPSHOT_CAS_SCRIPT = `
local cur = redis.call('HGET', KEYS[2], ARGV[1])
if cur == false then cur = '0' end
if cur == ARGV[2] then
  redis.call('HSET', KEYS[1], ARGV[1], ARGV[3])
  redis.call('HSET', KEYS[2], ARGV[1], tostring(tonumber(ARGV[2]) + 1))
  return 1
end
return 0
`;

/**
 * Atomically claim a dedupKey marker and, only if won, persist the alert to
 * history (LPUSH newest-first, then trim to cap). Doing claim + persist in one
 * script means a crash can never split them: there's no marker without its
 * alert (the round-2 fix), and no duplicate history row from a losing writer
 * (so `listAlerts` stays dedup-free and can read a bounded range). Returns 1 if
 * this caller won the claim (and should notify), 0 if already claimed.
 * KEYS[1]=alerts list, KEYS[2]=dedup marker. ARGV[1]=ttl, ARGV[2]=cap, ARGV[3]=alert JSON.
 */
export const CLAIM_AND_APPEND_SCRIPT = `
local won = redis.call('SET', KEYS[2], '1', 'NX', 'EX', tonumber(ARGV[1]))
if not won then return 0 end
redis.call('LPUSH', KEYS[1], ARGV[3])
redis.call('LTRIM', KEYS[1], 0, tonumber(ARGV[2]) - 1)
return 1
`;

/**
 * The slice of a Redis client we depend on. Declaring it locally (instead of
 * importing `@upstash/redis` types) keeps the store decoupled and trivially
 * mockable in tests. The shape matches `@upstash/redis`'s method signatures, so
 * a real `Redis` instance satisfies it structurally (verified by tsc where
 * `getStore()` passes `new Redis(...)` straight into `createRedisStore`).
 */
export interface RedisLike {
  hget(key: string, field: string): Promise<unknown>;
  hgetall(key: string): Promise<Record<string, unknown> | null>;
  hset(key: string, kv: Record<string, string>): Promise<number>;
  hdel(key: string, ...fields: string[]): Promise<number>;
  lrange(key: string, start: number, stop: number): Promise<unknown[]>;
  lpush(key: string, ...values: string[]): Promise<number>;
  rpush(key: string, ...values: string[]): Promise<number>;
  lrem(key: string, count: number, value: string): Promise<number>;
  ltrim(key: string, start: number, stop: number): Promise<string>;
  sadd(key: string, ...members: string[]): Promise<number>;
  smembers(key: string): Promise<unknown[]>;
  del(...keys: string[]): Promise<number>;
  eval(script: string, keys: string[], args: string[]): Promise<unknown>;
}

/**
 * `@upstash/redis` auto-deserializes values that look like JSON, so a stored
 * string may come back as an already-parsed object. This helper tolerates both
 * (real client returns objects, the test mock returns raw strings).
 */
function decode<T>(value: unknown): T | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') {
    try {
      return JSON.parse(value) as T;
    } catch {
      return null;
    }
  }
  return value as T;
}

const encode = (value: unknown): string => JSON.stringify(value);

const asId = (value: unknown): string =>
  typeof value === 'string' ? value : String(value);

/**
 * A Redis-backed Store for durable serverless deployment (Vercel + Upstash).
 *
 * The file store serializes writes through a single in-process promise chain,
 * which is useless across independent serverless instances (the cron sweep and
 * a webhook handler can run concurrently in different lambdas). Rather than
 * emulate a mutex over stateless HTTP — `SET NX PX` locks can't be released
 * safely once their TTL lapses — this implementation leans on atomic Redis
 * primitives where correctness actually matters:
 *
 *  - Snapshots use an optimistic version CAS (`SNAPSHOT_CAS_SCRIPT`) so the
 *    read-merge-write that unions `seenTxHashes` is atomic. A lost update here
 *    would drop a tx hash, and because the rule engine gates first-fire on
 *    `seenTxHashes` membership, a tx that subsequently ages out of the explorer
 *    window would be a *silently missed* alert — so this must not race.
 *  - Alert notification dedup uses a per-dedupKey `SET NX EX` marker, so exactly
 *    one writer ever "wins" a given event and notifies for it, across instances.
 *    History is written *before* the marker is claimed, so a crash can never
 *    leave a marker without its alert (at-least-once history, at-most-once
 *    notify). `listAlerts` dedups history by dedupKey to hide rare duplicates.
 *  - Alert read-state is a set of ids (`SADD`), immune to list-index shifts.
 *
 * Keeps the same Store interface as the file store; `getStore()` selects this
 * implementation when Upstash env vars are present.
 */
export function createRedisStore(redis: RedisLike): Store {
  async function loadAddresses(): Promise<WatchedAddress[]> {
    const all = await redis.hgetall(K.addresses);
    if (!all) return [];
    const byId = new Map<string, WatchedAddress>();
    for (const v of Object.values(all)) {
      const a = decode<WatchedAddress>(v);
      if (a) byId.set(a.id, a);
    }
    // HGETALL field order is unspecified; the parallel order list gives the
    // exact insertion order (createdAt is second-granular and can tie).
    const order = (await redis.lrange(K.addrOrder, 0, -1))
      .map(asId)
      .filter((id) => byId.has(id));
    const ordered = order.map((id) => byId.get(id)!);
    const seen = new Set(order);
    // Defensive: include addresses missing from the order list (e.g. a partial
    // write that set the hash but not the list) at the end so nothing vanishes.
    for (const a of byId.values()) {
      if (!seen.has(a.id)) ordered.push(a);
    }
    return ordered;
  }

  async function loadAlertList(limit?: number): Promise<StoredAlert[]> {
    if (typeof limit === 'number' && limit <= 0) return [];
    // History holds one row per dedupKey (claim+persist is atomic), so a bounded
    // LRANGE is correct — no full-scan/read-dedup needed.
    const stop = typeof limit === 'number' ? limit - 1 : -1;
    const [raw, readMembers] = await Promise.all([
      redis.lrange(K.alerts, 0, stop),
      redis.smembers(K.alertsRead),
    ]);
    const read = new Set(readMembers.map(asId));
    return raw
      .map((v) => decode<StoredAlert>(v))
      .filter((a): a is StoredAlert => a !== null)
      .map((a) => ({ ...a, read: read.has(a.id) }));
  }

  return {
    listAddresses(): Promise<WatchedAddress[]> {
      return loadAddresses();
    },

    async addAddress(input: AddAddressInput): Promise<WatchedAddress> {
      const entry: WatchedAddress = {
        id: randomUUID(),
        label: input.label,
        address: input.address,
        chainId: input.chainId,
        rules: input.rules ?? DEFAULT_RULES,
        createdAt: Math.floor(Date.now() / 1000),
      };
      await redis.hset(K.addresses, { [entry.id]: encode(entry) });
      await redis.rpush(K.addrOrder, entry.id);
      return entry;
    },

    async removeAddress(id: string): Promise<void> {
      await redis.hdel(K.addresses, id);
      await redis.lrem(K.addrOrder, 0, id);
      await redis.hdel(K.snapshots, id);
      await redis.hdel(K.snapVer, id);
    },

    async updateAddressRules(
      id: string,
      rules: AlertRuleConfig,
    ): Promise<WatchedAddress | null> {
      const cur = decode<WatchedAddress>(await redis.hget(K.addresses, id));
      if (!cur) return null;
      const next: WatchedAddress = { ...cur, rules };
      await redis.hset(K.addresses, { [id]: encode(next) });
      return next;
    },

    async getSnapshot(addressId: string): Promise<Snapshot | null> {
      return decode<Snapshot>(await redis.hget(K.snapshots, addressId));
    },

    async saveSnapshot(snapshot: Snapshot): Promise<void> {
      await redis.hset(K.snapshots, {
        [snapshot.addressId]: encode(snapshot),
      });
    },

    async updateSnapshot(
      addressId: string,
      merge: (prev: Snapshot | null) => Snapshot | null,
    ): Promise<void> {
      // Optimistic version CAS: read snapshot + version, merge, then atomically
      // write only if the version is unchanged. On contention re-read (so the
      // merge unions the other writer's hashes) and retry. This keeps the
      // seenTxHashes union lossless across concurrent poll/webhook writers.
      for (let attempt = 0; attempt < SNAPSHOT_CAS_ATTEMPTS; attempt++) {
        const [blobRaw, verRaw] = await Promise.all([
          redis.hget(K.snapshots, addressId),
          redis.hget(K.snapVer, addressId),
        ]);
        const prev = decode<Snapshot>(blobRaw);
        const next = merge(prev);
        if (next === null) return; // no-op
        const expected = verRaw === null || verRaw === undefined ? '0' : asId(verRaw);
        const ok = await redis.eval(
          SNAPSHOT_CAS_SCRIPT,
          [K.snapshots, K.snapVer],
          [addressId, expected, encode(next)],
        );
        if (ok === 1 || ok === '1') return;
      }
      // Extremely unlikely (8 lost races on one address). Fall back to a plain
      // write so the run still makes progress; the next poll reconciles state.
      const next = merge(decode<Snapshot>(await redis.hget(K.snapshots, addressId)));
      if (next !== null) {
        await redis.hset(K.snapshots, { [addressId]: encode(next) });
      }
    },

    listAlerts(limit?: number): Promise<StoredAlert[]> {
      return loadAlertList(limit);
    },

    async appendAlerts(alerts: Alert[], firedAt: number): Promise<StoredAlert[]> {
      if (alerts.length === 0) return [];
      const stored: StoredAlert[] = alerts.map((a) => ({
        ...a,
        id: randomUUID(),
        firedAt,
        read: false,
      }));
      // Claim + persist each alert atomically (CLAIM_AND_APPEND_SCRIPT). Only the
      // winner of a dedupKey persists its row and is returned for notification —
      // so history holds no duplicates and an event notifies at most once across
      // instances, with no crash window between claiming and persisting.
      // Process newest-last so stored[0] (newest) lands at the list head.
      const winners: StoredAlert[] = [];
      for (let i = stored.length - 1; i >= 0; i--) {
        const s = stored[i];
        const won = await redis.eval(
          CLAIM_AND_APPEND_SCRIPT,
          [K.alerts, K.alertSeen(s.dedupKey)],
          [String(ALERT_SEEN_TTL_SECONDS), String(ALERT_CAP), encode(s)],
        );
        if (won === 1 || won === '1') winners.push(s);
      }
      return winners.reverse(); // restore newest-first order
    },

    async markAlertsRead(ids?: string[]): Promise<void> {
      // Read-state is a set of ids — adding is atomic and index-independent, so
      // it can't corrupt history the way an in-place LSET-by-index could.
      let targets = ids;
      if (!targets) {
        const raw = await redis.lrange(K.alerts, 0, -1);
        targets = raw
          .map((v) => decode<StoredAlert>(v))
          .filter((a): a is StoredAlert => a !== null)
          .map((a) => a.id);
      }
      if (targets.length === 0) return;
      await redis.sadd(K.alertsRead, ...targets);
    },
  };
}
