import { describe, expect, it } from 'vitest';
import type { Alert } from '@/lib/rules/types';
import {
  CLAIM_AND_APPEND_SCRIPT,
  createRedisStore,
  SNAPSHOT_CAS_SCRIPT,
  type RedisLike,
} from './redis-store';

/**
 * An in-memory RedisLike that mirrors the subset of Redis semantics the store
 * uses (hashes, lists, sets, NX/EX string keys). Values are stored as raw
 * strings — exercising `decode`'s JSON.parse path. A `deserialize` flag flips it
 * to return already-parsed objects, simulating @upstash/redis auto-deserialize.
 */
function makeRedis(opts: { deserialize?: boolean } = {}): RedisLike {
  const hashes = new Map<string, Map<string, string>>();
  const lists = new Map<string, string[]>();
  const sets = new Map<string, Set<string>>();
  const keys = new Map<string, { value: string; expireAt: number | null }>();

  const out = (v: string | undefined): unknown => {
    if (v === undefined) return null;
    if (!opts.deserialize) return v;
    try {
      return JSON.parse(v);
    } catch {
      return v;
    }
  };

  const live = (k: string): boolean => {
    const e = keys.get(k);
    if (!e) return false;
    if (e.expireAt !== null && Date.now() > e.expireAt) {
      keys.delete(k);
      return false;
    }
    return true;
  };

  return {
    async hget(key, field) {
      return out(hashes.get(key)?.get(field));
    },
    async hgetall(key) {
      const h = hashes.get(key);
      if (!h || h.size === 0) return null;
      const o: Record<string, unknown> = {};
      for (const [f, v] of h) o[f] = out(v);
      return o;
    },
    async hset(key, kv) {
      let h = hashes.get(key);
      if (!h) hashes.set(key, (h = new Map()));
      let added = 0;
      for (const [f, v] of Object.entries(kv)) {
        if (!h.has(f)) added++;
        h.set(f, v);
      }
      return added;
    },
    async hdel(key, ...fields) {
      const h = hashes.get(key);
      if (!h) return 0;
      let n = 0;
      for (const f of fields) if (h.delete(f)) n++;
      return n;
    },
    async lrange(key, start, stop) {
      const l = lists.get(key) ?? [];
      const len = l.length;
      const s = start < 0 ? Math.max(len + start, 0) : start;
      const e = stop < 0 ? len + stop : Math.min(stop, len - 1);
      const slice = e < s ? [] : l.slice(s, e + 1);
      return slice.map((v) => out(v));
    },
    async lpush(key, ...values) {
      let l = lists.get(key);
      if (!l) lists.set(key, (l = []));
      for (const v of values) l.unshift(v); // LPUSH a b => [b, a]
      return l.length;
    },
    async rpush(key, ...values) {
      let l = lists.get(key);
      if (!l) lists.set(key, (l = []));
      for (const v of values) l.push(v); // RPUSH appends to tail
      return l.length;
    },
    async lrem(key, _count, value) {
      const l = lists.get(key);
      if (!l) return 0;
      // count === 0 removes all occurrences (the only mode the store uses).
      const before = l.length;
      const kept = l.filter((v) => v !== value);
      lists.set(key, kept);
      return before - kept.length;
    },
    async ltrim(key, start, stop) {
      const l = lists.get(key) ?? [];
      const len = l.length;
      const s = start < 0 ? Math.max(len + start, 0) : start;
      const e = stop < 0 ? len + stop : Math.min(stop, len - 1);
      lists.set(key, e < s ? [] : l.slice(s, e + 1));
      return 'OK';
    },
    async sadd(key, ...members) {
      let set = sets.get(key);
      if (!set) sets.set(key, (set = new Set()));
      let added = 0;
      for (const m of members) {
        if (!set.has(m)) added++;
        set.add(m);
      }
      return added;
    },
    async smembers(key) {
      return [...(sets.get(key) ?? [])];
    },
    async del(...ks) {
      let n = 0;
      for (const k of ks) {
        if (hashes.delete(k)) n++;
        if (lists.delete(k)) n++;
        if (sets.delete(k)) n++;
        if (keys.delete(k)) n++;
      }
      return n;
    },
    async eval(script, evalKeys, args) {
      // Interpret the two scripts the store uses against the raw-string maps.
      if (script === SNAPSHOT_CAS_SCRIPT) {
        // Snapshot version CAS (compared as strings).
        const [snapKey, verKey] = evalKeys;
        const [field, expected, blob] = args;
        const cur = hashes.get(verKey)?.get(field) ?? '0';
        if (cur !== expected) return 0;
        let sh = hashes.get(snapKey);
        if (!sh) hashes.set(snapKey, (sh = new Map()));
        sh.set(field, blob);
        let vh = hashes.get(verKey);
        if (!vh) hashes.set(verKey, (vh = new Map()));
        vh.set(field, String(Number(expected) + 1));
        return 1;
      }
      if (script === CLAIM_AND_APPEND_SCRIPT) {
        // SET NX EX marker; if won, LPUSH the alert + LTRIM to cap.
        const [alertsKey, markerKey] = evalKeys;
        const [ttl, cap, json] = args;
        if (live(markerKey)) return 0;
        keys.set(markerKey, { value: '1', expireAt: Date.now() + Number(ttl) * 1000 });
        let l = lists.get(alertsKey);
        if (!l) lists.set(alertsKey, (l = []));
        l.unshift(json);
        const c = Number(cap);
        if (l.length > c) lists.set(alertsKey, l.slice(0, c));
        return 1;
      }
      throw new Error('mock eval: unknown script');
    },
  };
}

function alert(dedupKey: string, over: Partial<Alert> = {}): Alert {
  return {
    addressId: 'a1',
    address: '0xabc',
    chainId: 'ethereum',
    rule: 'new_transaction',
    severity: 'info',
    title: 't',
    message: 'm',
    dedupKey,
    ...over,
  };
}

describe('redis store — addresses', () => {
  it('adds, lists (insertion order), updates rules, removes', async () => {
    const store = createRedisStore(makeRedis());
    const a = await store.addAddress({ label: 'A', address: '0x1', chainId: 'ethereum' });
    const b = await store.addAddress({ label: 'B', address: '0x2', chainId: 'ethereum' });

    const list = await store.listAddresses();
    expect(list.map((x) => x.label)).toEqual(['A', 'B']);

    const updated = await store.updateAddressRules(a.id, {
      balanceChange: false,
      largeWithdrawal: { enabled: true, threshold: 42 },
      newTransaction: true,
      approval: true,
    });
    expect(updated?.rules.largeWithdrawal.threshold).toBe(42);
    expect(await store.updateAddressRules('missing', updated!.rules)).toBeNull();

    await store.removeAddress(b.id);
    expect((await store.listAddresses()).map((x) => x.label)).toEqual(['A']);
  });
});

describe('redis store — alert persistence + dedup', () => {
  it('stores each dedupKey once across runs', async () => {
    const store = createRedisStore(makeRedis());
    expect(await store.appendAlerts([alert('k1'), alert('k2')], 100)).toHaveLength(2);
    expect(await store.appendAlerts([alert('k1'), alert('k2')], 200)).toHaveLength(0);
    expect(await store.listAlerts()).toHaveLength(2);
  });

  it('returns only newly-inserted alerts', async () => {
    const store = createRedisStore(makeRedis());
    await store.appendAlerts([alert('k1')], 100);
    const inserted = await store.appendAlerts([alert('k1'), alert('k3')], 200);
    expect(inserted.map((a) => a.dedupKey)).toEqual(['k3']);
  });

  it('keeps newest-first ordering and assigns ids + firedAt', async () => {
    const store = createRedisStore(makeRedis());
    await store.appendAlerts([alert('old')], 100);
    await store.appendAlerts([alert('new')], 200);
    const all = await store.listAlerts();
    expect(all[0].dedupKey).toBe('new');
    expect(all[0].id).toBeTruthy();
    expect(all[0].firedAt).toBe(200);
    expect(all[0].read).toBe(false);
  });

  it('preserves order within a single multi-alert append', async () => {
    const store = createRedisStore(makeRedis());
    await store.appendAlerts([alert('first'), alert('second'), alert('third')], 100);
    expect((await store.listAlerts()).map((a) => a.dedupKey)).toEqual([
      'first',
      'second',
      'third',
    ]);
  });

  it('respects listAlerts limit', async () => {
    const store = createRedisStore(makeRedis());
    await store.appendAlerts([alert('a'), alert('b'), alert('c')], 100);
    expect(await store.listAlerts(2)).toHaveLength(2);
    expect(await store.listAlerts(0)).toHaveLength(0);
  });

  it('marks alerts read (by id and all)', async () => {
    const store = createRedisStore(makeRedis());
    const [a] = await store.appendAlerts([alert('k1'), alert('k2')], 100);
    await store.markAlertsRead([a.id]);
    let all = await store.listAlerts();
    expect(all.find((x) => x.id === a.id)?.read).toBe(true);
    expect(all.filter((x) => x.read)).toHaveLength(1);

    await store.markAlertsRead();
    all = await store.listAlerts();
    expect(all.every((x) => x.read)).toBe(true);
  });

  it('dedups concurrent appends of the same event (atomic SET NX, exactly-once)', async () => {
    const store = createRedisStore(makeRedis());
    // Two instances racing on the same event: only one may insert + notify.
    const [r1, r2] = await Promise.all([
      store.appendAlerts([alert('same')], 100),
      store.appendAlerts([alert('same')], 100),
    ]);
    expect(r1.length + r2.length).toBe(1);
    expect(await store.listAlerts()).toHaveLength(1);
  });
});

describe('redis store — snapshots', () => {
  it('updateSnapshot creates then re-reads current; null is a no-op', async () => {
    const store = createRedisStore(makeRedis());
    await store.updateSnapshot('a1', (prev) => {
      expect(prev).toBeNull();
      return { addressId: 'a1', checkedAt: 1, balances: { ETH: 5 }, seenTxHashes: ['h1'], lastTs: 10 };
    });
    await store.updateSnapshot('a1', (prev) => ({
      ...prev!,
      seenTxHashes: Array.from(new Set(['h2', ...prev!.seenTxHashes])),
    }));
    const snap = await store.getSnapshot('a1');
    expect(snap?.seenTxHashes).toEqual(['h2', 'h1']);
    expect(snap?.balances).toEqual({ ETH: 5 });

    await store.updateSnapshot('missing', () => null);
    expect(await store.getSnapshot('missing')).toBeNull();
  });

  it('serializes concurrent updateSnapshot via version CAS (no lost write)', async () => {
    const store = createRedisStore(makeRedis());
    await store.saveSnapshot({
      addressId: 'a1', checkedAt: 0, balances: {}, seenTxHashes: [], lastTs: 0,
    });
    // Two writers racing to union a distinct hash. The CAS makes the second
    // re-read the first's write, so neither hash is dropped.
    await Promise.all([
      store.updateSnapshot('a1', (p) => ({ ...p!, seenTxHashes: [...p!.seenTxHashes, 'A'] })),
      store.updateSnapshot('a1', (p) => ({ ...p!, seenTxHashes: [...p!.seenTxHashes, 'B'] })),
    ]);
    const snap = await store.getSnapshot('a1');
    expect([...(snap?.seenTxHashes ?? [])].sort()).toEqual(['A', 'B']);
  });

  it('saveSnapshot / getSnapshot round-trip', async () => {
    const store = createRedisStore(makeRedis());
    await store.saveSnapshot({
      addressId: 'a1', checkedAt: 7, balances: { ETH: 1.5 }, seenTxHashes: ['x'], lastTs: 9,
    });
    expect(await store.getSnapshot('a1')).toMatchObject({ checkedAt: 7, lastTs: 9 });
  });
});

describe('redis store — @upstash auto-deserialize tolerance', () => {
  it('works when the client returns already-parsed objects', async () => {
    const store = createRedisStore(makeRedis({ deserialize: true }));
    const a = await store.addAddress({ label: 'A', address: '0x1', chainId: 'ethereum' });
    expect((await store.listAddresses())[0].id).toBe(a.id);
    const [ins] = await store.appendAlerts([alert('k1')], 100);
    expect((await store.listAlerts())[0].dedupKey).toBe('k1');
    await store.markAlertsRead([ins.id]);
    expect((await store.listAlerts())[0].read).toBe(true);
    await store.updateSnapshot('a1', () => ({
      addressId: 'a1', checkedAt: 1, balances: {}, seenTxHashes: ['h'], lastTs: 1,
    }));
    expect((await store.getSnapshot('a1'))?.seenTxHashes).toEqual(['h']);
  });
});
