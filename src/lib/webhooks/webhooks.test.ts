import { createHmac } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createFileStore } from '@/lib/store/file-store';
import type { Store } from '@/lib/store/types';
import { createNotifier } from '@/lib/notify';
import { parseAlchemy, parseHelius } from './parse';
import { addressesMatch, processWebhookActivities } from './process';
import { verifyAlchemySignature, verifyHeliusAuth } from './verify';

describe('verifyAlchemySignature', () => {
  const key = 'whsec_test';
  const body = '{"hello":"world"}';
  const sig = createHmac('sha256', key).update(body, 'utf8').digest('hex');

  it('accepts a valid HMAC signature', () => {
    expect(verifyAlchemySignature(body, sig, key)).toBe(true);
  });
  it('rejects a tampered body', () => {
    expect(verifyAlchemySignature(body + 'x', sig, key)).toBe(false);
  });
  it('rejects missing signature or key', () => {
    expect(verifyAlchemySignature(body, null, key)).toBe(false);
    expect(verifyAlchemySignature(body, sig, undefined)).toBe(false);
  });
});

describe('verifyHeliusAuth', () => {
  it('matches the configured secret in constant time', () => {
    expect(verifyHeliusAuth('s3cret', 's3cret')).toBe(true);
    expect(verifyHeliusAuth('nope', 's3cret')).toBe(false);
    expect(verifyHeliusAuth(null, 's3cret')).toBe(false);
  });
});

describe('parseAlchemy', () => {
  it('maps network + activity to chain-tagged transfers', () => {
    const out = parseAlchemy({
      createdAt: '2026-06-23T00:00:00.000Z',
      event: {
        network: 'ETH_MAINNET',
        activity: [
          {
            fromAddress: '0xAAA',
            toAddress: '0xBBB',
            hash: '0xhash1',
            value: 1.5,
            asset: 'ETH',
            category: 'external',
          },
        ],
      },
    });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      chainId: 'ethereum',
      hash: '0xhash1',
      asset: 'ETH',
      amount: 1.5,
      isToken: false,
    });
    expect(out[0].timestamp).toBeGreaterThan(0);
  });

  it('returns [] for unknown networks', () => {
    expect(parseAlchemy({ event: { network: 'WAT', activity: [] } })).toEqual([]);
  });
});

describe('parseHelius', () => {
  it('extracts native + token transfers from an enhanced tx array', () => {
    const out = parseHelius([
      {
        signature: 'sig1',
        timestamp: 1700,
        nativeTransfers: [
          { fromUserAccount: 'A', toUserAccount: 'B', amount: 2_000_000_000 },
        ],
        tokenTransfers: [
          { fromUserAccount: 'A', toUserAccount: 'B', tokenAmount: 5, symbol: 'USDC' },
        ],
      },
    ]);
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ chainId: 'solana', asset: 'SOL', amount: 2 });
    expect(out[1]).toMatchObject({ asset: 'USDC', amount: 5, isToken: true });
  });
});

describe('addressesMatch', () => {
  it('is case-insensitive for EVM, exact for others', () => {
    expect(addressesMatch('0xAbC', '0xabc', 'ethereum')).toBe(true);
    expect(addressesMatch('SoLAddr', 'soladdr', 'solana')).toBe(false);
    expect(addressesMatch('SoLAddr', 'SoLAddr', 'solana')).toBe(true);
  });
});

describe('processWebhookActivities', () => {
  let dir: string;
  let store: Store;
  const noopNotifier = createNotifier([]);

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'wg-wh-'));
    store = createFileStore(join(dir, 'data.json'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('alerts on a matched first-ever webhook event (synthetic baseline)', async () => {
    const a = await store.addAddress({
      label: 'V',
      address: '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045',
      chainId: 'ethereum',
    });
    const res = await processWebhookActivities(
      store,
      parseAlchemy({
        createdAt: '2026-06-23T00:00:00.000Z',
        event: {
          network: 'ETH_MAINNET',
          activity: [
            {
              fromAddress: '0xother',
              toAddress: a.address,
              hash: '0xincoming',
              value: 3,
              asset: 'ETH',
              category: 'external',
            },
          ],
        },
      }),
      noopNotifier,
    );
    expect(res.matchedAddresses).toBe(1);
    expect(res.newAlerts).toBeGreaterThanOrEqual(1);
    const alerts = await store.listAlerts();
    expect(alerts.some((x) => x.rule === 'new_transaction')).toBe(true);
  });

  it('does not re-alert the same hash on a second delivery (dedup)', async () => {
    const a = await store.addAddress({
      label: 'V',
      address: '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045',
      chainId: 'ethereum',
    });
    const payload = {
      createdAt: '2026-06-23T00:00:00.000Z',
      event: {
        network: 'ETH_MAINNET',
        activity: [
          {
            fromAddress: '0xother',
            toAddress: a.address,
            hash: '0xdup',
            value: 1,
            asset: 'ETH',
            category: 'external',
          },
        ],
      },
    };
    await processWebhookActivities(store, parseAlchemy(payload), noopNotifier);
    const second = await processWebhookActivities(store, parseAlchemy(payload), noopNotifier);
    expect(second.newAlerts).toBe(0);
  });

  it('does NOT fabricate a snapshot for a never-polled address (no balance flood)', async () => {
    const a = await store.addAddress({
      label: 'V',
      address: '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045',
      chainId: 'ethereum',
    });
    await processWebhookActivities(
      store,
      parseAlchemy({
        event: {
          network: 'ETH_MAINNET',
          activity: [
            { fromAddress: '0xother', toAddress: a.address, hash: '0xh', value: 1, asset: 'ETH' },
          ],
        },
      }),
      noopNotifier,
    );
    // No snapshot persisted -> the first poll still establishes a true baseline.
    expect(await store.getSnapshot(a.id)).toBeNull();
  });

  it('merges the webhook hash into an existing poll snapshot', async () => {
    const a = await store.addAddress({
      label: 'V',
      address: '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045',
      chainId: 'ethereum',
    });
    // Simulate a prior poll baseline with real balances.
    await store.saveSnapshot({
      addressId: a.id,
      checkedAt: 100,
      balances: { ETH: 9 },
      seenTxHashes: ['0xpoll'],
      lastTs: 100,
    });
    await processWebhookActivities(
      store,
      parseAlchemy({
        event: {
          network: 'ETH_MAINNET',
          activity: [
            { fromAddress: '0xother', toAddress: a.address, hash: '0xwebhook', value: 1, asset: 'ETH' },
          ],
        },
      }),
      noopNotifier,
    );
    const snap = await store.getSnapshot(a.id);
    expect(snap?.seenTxHashes).toContain('0xwebhook');
    expect(snap?.seenTxHashes).toContain('0xpoll');
    expect(snap?.balances).toEqual({ ETH: 9 }); // poll balances NOT clobbered
  });

  it('ignores activities for unwatched addresses', async () => {
    const res = await processWebhookActivities(
      store,
      parseAlchemy({
        event: {
          network: 'ETH_MAINNET',
          activity: [
            { fromAddress: '0xa', toAddress: '0xb', hash: '0xh', value: 1, asset: 'ETH' },
          ],
        },
      }),
      noopNotifier,
    );
    expect(res.matchedAddresses).toBe(0);
    expect(res.newAlerts).toBe(0);
  });
});
