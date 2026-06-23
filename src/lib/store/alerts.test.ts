import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Alert } from '@/lib/rules/types';
import { createFileStore } from './file-store';
import type { Store } from './types';

let dir: string;
let store: Store;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'wg-alerts-'));
  store = createFileStore(join(dir, 'data.json'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

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

describe('alert persistence + dedup', () => {
  it('stores each dedupKey once across runs', async () => {
    const first = await store.appendAlerts([alert('k1'), alert('k2')], 100);
    expect(first).toHaveLength(2);

    // Same events observed again on a later run — must not duplicate.
    const second = await store.appendAlerts([alert('k1'), alert('k2')], 200);
    expect(second).toHaveLength(0);

    const all = await store.listAlerts();
    expect(all).toHaveLength(2);
  });

  it('returns only newly-inserted alerts', async () => {
    await store.appendAlerts([alert('k1')], 100);
    const inserted = await store.appendAlerts([alert('k1'), alert('k3')], 200);
    expect(inserted.map((a) => a.dedupKey)).toEqual(['k3']);
  });

  it('keeps newest-first ordering and assigns ids + firedAt', async () => {
    await store.appendAlerts([alert('old')], 100);
    await store.appendAlerts([alert('new')], 200);
    const all = await store.listAlerts();
    expect(all[0].dedupKey).toBe('new');
    expect(all[0].id).toBeTruthy();
    expect(all[0].firedAt).toBe(200);
    expect(all[0].read).toBe(false);
  });

  it('marks alerts read (by id and all)', async () => {
    const [a] = await store.appendAlerts([alert('k1'), alert('k2')], 100);
    await store.markAlertsRead([a.id]);
    let all = await store.listAlerts();
    expect(all.find((x) => x.id === a.id)?.read).toBe(true);
    expect(all.filter((x) => x.read)).toHaveLength(1);

    await store.markAlertsRead();
    all = await store.listAlerts();
    expect(all.every((x) => x.read)).toBe(true);
  });

  it('persists alerts across store re-open', async () => {
    await store.appendAlerts([alert('k1')], 100);
    const reopened = createFileStore(join(dir, 'data.json'));
    expect(await reopened.listAlerts()).toHaveLength(1);
  });
});

describe('updateSnapshot (atomic merge)', () => {
  it('creates via merge and re-reads current on the next call', async () => {
    await store.updateSnapshot('a1', (prev) => {
      expect(prev).toBeNull();
      return { addressId: 'a1', checkedAt: 1, balances: { ETH: 5 }, seenTxHashes: ['h1'], lastTs: 10 };
    });
    await store.updateSnapshot('a1', (prev) => {
      expect(prev?.seenTxHashes).toEqual(['h1']);
      return {
        ...prev!,
        seenTxHashes: Array.from(new Set(['h2', ...prev!.seenTxHashes])),
      };
    });
    const snap = await store.getSnapshot('a1');
    expect(snap?.seenTxHashes).toEqual(['h2', 'h1']);
    expect(snap?.balances).toEqual({ ETH: 5 }); // balances preserved
  });

  it('returning null is a no-op', async () => {
    await store.updateSnapshot('missing', () => null);
    expect(await store.getSnapshot('missing')).toBeNull();
  });
});

describe('updateAddressRules', () => {
  it('patches rules and returns the updated address; null when missing', async () => {
    const a = await store.addAddress({
      label: 'X',
      address: '0xabc',
      chainId: 'ethereum',
    });
    const updated = await store.updateAddressRules(a.id, {
      balanceChange: false,
      largeWithdrawal: { enabled: true, threshold: 42 },
      newTransaction: true,
      approval: true,
    });
    expect(updated?.rules.largeWithdrawal.threshold).toBe(42);
    expect(updated?.rules.balanceChange).toBe(false);

    expect(await store.updateAddressRules('missing', updated!.rules)).toBeNull();
  });
});
