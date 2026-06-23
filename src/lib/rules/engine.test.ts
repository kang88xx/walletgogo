import { describe, expect, it } from 'vitest';
import type { BalanceSnapshot, NormalizedTx } from '@/lib/chains/types';
import type { Snapshot, WatchedAddress } from '@/lib/store/types';
import { DEFAULT_RULES } from './types';
import { evaluate } from './engine';

function addr(overrides: Partial<WatchedAddress> = {}): WatchedAddress {
  return {
    id: 'a1',
    label: 'Test',
    address: '0xabc',
    chainId: 'ethereum',
    rules: structuredClone(DEFAULT_RULES),
    createdAt: 0,
    ...overrides,
  };
}

function snap(overrides: Partial<Snapshot> = {}): Snapshot {
  return {
    addressId: 'a1',
    checkedAt: 100,
    balances: {},
    seenTxHashes: [],
    lastTs: 0,
    ...overrides,
  };
}

function tx(overrides: Partial<NormalizedTx> = {}): NormalizedTx {
  return {
    hash: '0xhash',
    from: '0xfrom',
    to: '0xto',
    direction: 'in',
    asset: 'ETH',
    amount: 1,
    type: 'native',
    timestamp: 200,
    ...overrides,
  };
}

const noBalances: BalanceSnapshot[] = [];

describe('evaluate — baseline', () => {
  it('emits nothing on the first check (prev === null)', () => {
    const alerts = evaluate({
      address: addr(),
      prev: null,
      balances: [{ asset: 'ETH', amount: 5 }],
      txs: [tx({ hash: '0xnew' })],
    });
    expect(alerts).toEqual([]);
  });
});

describe('evaluate — balance_change', () => {
  it('fires when a balance differs from the snapshot', () => {
    const alerts = evaluate({
      address: addr(),
      prev: snap({ balances: { ETH: 5 } }),
      balances: [{ asset: 'ETH', amount: 6 }],
      txs: [],
    });
    const bc = alerts.filter((a) => a.rule === 'balance_change');
    expect(bc).toHaveLength(1);
    expect(bc[0].severity).toBe('info'); // increase
  });

  it('marks a decrease as warn', () => {
    const alerts = evaluate({
      address: addr(),
      prev: snap({ balances: { ETH: 5 } }),
      balances: [{ asset: 'ETH', amount: 4 }],
      txs: [],
    });
    expect(alerts.find((a) => a.rule === 'balance_change')?.severity).toBe('warn');
  });

  it('does not fire when balance is unchanged', () => {
    const alerts = evaluate({
      address: addr(),
      prev: snap({ balances: { ETH: 5 } }),
      balances: [{ asset: 'ETH', amount: 5 }],
      txs: [],
    });
    expect(alerts.filter((a) => a.rule === 'balance_change')).toHaveLength(0);
  });

  it('respects the balanceChange toggle', () => {
    const a = addr();
    a.rules.balanceChange = false;
    const alerts = evaluate({
      address: a,
      prev: snap({ balances: { ETH: 5 } }),
      balances: [{ asset: 'ETH', amount: 9 }],
      txs: [],
    });
    expect(alerts.filter((x) => x.rule === 'balance_change')).toHaveLength(0);
  });
});

describe('evaluate — large_withdrawal', () => {
  it('fires only above threshold and only on outgoing transfers', () => {
    const a = addr();
    a.rules.largeWithdrawal = { enabled: true, threshold: 10 };
    const prev = snap({ seenTxHashes: ['0xseen'] });

    const big = evaluate({
      address: a,
      prev,
      balances: noBalances,
      txs: [tx({ hash: '0xseen', direction: 'out', amount: 50 })],
    });
    expect(big.filter((x) => x.rule === 'large_withdrawal')).toHaveLength(1);
    expect(big.find((x) => x.rule === 'large_withdrawal')?.severity).toBe('critical');

    const below = evaluate({
      address: a,
      prev,
      balances: noBalances,
      txs: [tx({ hash: '0xseen', direction: 'out', amount: 5 })],
    });
    expect(below.filter((x) => x.rule === 'large_withdrawal')).toHaveLength(0);

    const incoming = evaluate({
      address: a,
      prev,
      balances: noBalances,
      txs: [tx({ hash: '0xseen', direction: 'in', amount: 50 })],
    });
    expect(incoming.filter((x) => x.rule === 'large_withdrawal')).toHaveLength(0);
  });
});

describe('evaluate — new_transaction', () => {
  it('fires only for unseen hashes', () => {
    const prev = snap({ seenTxHashes: ['0xseen'] });
    const alerts = evaluate({
      address: addr(),
      prev,
      balances: noBalances,
      txs: [tx({ hash: '0xseen' }), tx({ hash: '0xfresh' })],
    });
    const nt = alerts.filter((x) => x.rule === 'new_transaction');
    expect(nt).toHaveLength(1);
    expect(nt[0].tx?.hash).toBe('0xfresh');
  });
});

describe('evaluate — approval', () => {
  it('fires for approval and nft_approval types', () => {
    const prev = snap({ seenTxHashes: ['0xa', '0xb'] });
    const alerts = evaluate({
      address: addr(),
      prev,
      balances: noBalances,
      txs: [
        tx({ hash: '0xa', type: 'approval', amount: 0 }),
        tx({ hash: '0xb', type: 'nft_approval', amount: 0 }),
      ],
    });
    const ap = alerts.filter((x) => x.rule === 'approval');
    expect(ap).toHaveLength(2);
    expect(ap.every((x) => x.severity === 'critical')).toBe(true);
  });

  it('does not fire for plain native transfers', () => {
    const prev = snap({ seenTxHashes: ['0xa'] });
    const alerts = evaluate({
      address: addr(),
      prev,
      balances: noBalances,
      txs: [tx({ hash: '0xa', type: 'native' })],
    });
    expect(alerts.filter((x) => x.rule === 'approval')).toHaveLength(0);
  });
});
