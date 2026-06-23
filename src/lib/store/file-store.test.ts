import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createFileStore } from './file-store';
import type { Store } from './types';

let dir: string;
let store: Store;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'wg-store-'));
  store = createFileStore(join(dir, 'data.json'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('file store — addresses', () => {
  it('starts empty', async () => {
    expect(await store.listAddresses()).toEqual([]);
  });

  it('adds and lists an address with defaults applied', async () => {
    const added = await store.addAddress({
      label: 'Cold',
      address: '0xabc',
      chainId: 'ethereum',
    });
    expect(added.id).toBeTruthy();
    expect(added.rules.balanceChange).toBe(true);

    const list = await store.listAddresses();
    expect(list).toHaveLength(1);
    expect(list[0].label).toBe('Cold');
  });

  it('removes an address and its snapshot', async () => {
    const a = await store.addAddress({
      label: 'X',
      address: '0xabc',
      chainId: 'ethereum',
    });
    await store.saveSnapshot({
      addressId: a.id,
      checkedAt: 1,
      balances: { ETH: 1 },
      seenTxHashes: [],
      lastTs: 0,
    });
    await store.removeAddress(a.id);
    expect(await store.listAddresses()).toEqual([]);
    expect(await store.getSnapshot(a.id)).toBeNull();
  });
});

describe('file store — snapshots', () => {
  it('round-trips a snapshot through disk', async () => {
    const a = await store.addAddress({
      label: 'X',
      address: '0xabc',
      chainId: 'ethereum',
    });
    const snapshot = {
      addressId: a.id,
      checkedAt: 42,
      balances: { ETH: 1.5, USDT: 100 },
      seenTxHashes: ['0x1', '0x2'],
      lastTs: 1700,
    };
    await store.saveSnapshot(snapshot);

    // Fresh store instance reading the same file proves persistence.
    const reopened = createFileStore(join(dir, 'data.json'));
    expect(await reopened.getSnapshot(a.id)).toEqual(snapshot);
  });

  it('returns null for an unknown snapshot', async () => {
    expect(await store.getSnapshot('nope')).toBeNull();
  });
});
