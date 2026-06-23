import type { BalanceSnapshot, NormalizedTx } from '@/lib/chains/types';
import type { Snapshot, WatchedAddress } from '@/lib/store/types';
import type { Alert } from './types';

export interface EvaluateInput {
  address: WatchedAddress;
  /** Previous snapshot, or null on the very first check for this address. */
  prev: Snapshot | null;
  balances: BalanceSnapshot[];
  txs: NormalizedTx[];
}

function fmt(n: number): string {
  // Trim noisy floating point while keeping small balances readable.
  if (n === 0) return '0';
  if (Math.abs(n) < 0.0001) return n.toExponential(2);
  return Number(n.toFixed(6)).toString();
}

/**
 * Pure rule evaluation: given the latest on-chain state and the previous
 * snapshot, decide which alerts should fire. No I/O happens here.
 *
 * BASELINE BEHAVIOR: on the first check (prev === null) we emit NOTHING. The
 * first run only establishes a baseline snapshot — otherwise we'd dump the
 * entire transaction history and every existing balance as "new", flooding the
 * user. All rules begin firing from the second check onward.
 */
export function evaluate({ address, prev, balances, txs }: EvaluateInput): Alert[] {
  if (prev === null) return [];

  const alerts: Alert[] = [];
  const rules = address.rules;

  const base = {
    addressId: address.id,
    address: address.address,
    chainId: address.chainId,
  };

  // --- balance_change -------------------------------------------------------
  if (rules.balanceChange) {
    for (const bal of balances) {
      const old = prev.balances[bal.asset] ?? 0;
      if (bal.amount !== old) {
        const delta = bal.amount - old;
        alerts.push({
          ...base,
          dedupKey: `${address.id}:balance_change:${bal.asset}:${bal.amount}`,
          rule: 'balance_change',
          severity: delta < 0 ? 'warn' : 'info',
          title: `잔액 변동: ${bal.asset}`,
          message: `${bal.asset} 잔액이 ${fmt(old)} → ${fmt(bal.amount)} (${
            delta >= 0 ? '+' : ''
          }${fmt(delta)}) 변경되었습니다.`,
        });
      }
    }
  }

  // --- new_transaction / large_withdrawal / approval ------------------------
  const seen = new Set(prev.seenTxHashes);
  for (const tx of txs) {
    const isNew = !seen.has(tx.hash);

    if (rules.newTransaction && isNew) {
      alerts.push({
        ...base,
        dedupKey: `${address.id}:new_transaction:${tx.hash}`,
        rule: 'new_transaction',
        severity: 'info',
        title: '새 트랜잭션 감지',
        message: `새 트랜잭션 ${tx.hash.slice(0, 12)}… (${tx.direction}, ${fmt(
          tx.amount,
        )} ${tx.asset})`,
        tx,
      });
    }

    if (rules.largeWithdrawal.enabled && tx.direction === 'out') {
      const { threshold, usdThreshold } = rules.largeWithdrawal;
      const overNative = tx.amount > threshold;
      const overUsd =
        typeof usdThreshold === 'number' &&
        typeof tx.usdValue === 'number' &&
        tx.usdValue > usdThreshold;
      if (overNative || overUsd) {
        const usdPart =
          typeof tx.usdValue === 'number' ? ` (≈$${fmt(tx.usdValue)})` : '';
        const trigger = overUsd
          ? `USD 임계값 $${fmt(usdThreshold!)} 초과`
          : `임계값 ${fmt(threshold)} ${tx.asset} 초과`;
        alerts.push({
          ...base,
          dedupKey: `${address.id}:large_withdrawal:${tx.hash}`,
          rule: 'large_withdrawal',
          severity: 'critical',
          title: '대규모 출금 감지',
          message: `${fmt(tx.amount)} ${tx.asset}${usdPart} 출금 (${trigger}) — ${tx.hash.slice(
            0,
            12,
          )}…`,
          tx,
        });
      }
    }

    if (rules.approval && (tx.type === 'approval' || tx.type === 'nft_approval')) {
      const isNft = tx.type === 'nft_approval';
      const spenderPart = tx.spender
        ? ` spender ${tx.spender.slice(0, 10)}…${tx.spender.slice(-6)}`
        : '';
      const unlimitedPart = tx.unlimited
        ? isNft
          ? ' — 전체 컬렉션 위임(setApprovalForAll)!'
          : ' — 무제한(unlimited) 승인!'
        : '';
      alerts.push({
        ...base,
        dedupKey: `${address.id}:approval:${tx.hash}`,
        rule: 'approval',
        severity: 'critical',
        title: tx.unlimited
          ? isNft
            ? '⚠️ NFT 전체 위임 감지'
            : '⚠️ 무제한 토큰 승인 감지'
          : isNft
            ? 'NFT 승인 감지'
            : '토큰 승인 감지',
        message: `승인(approval) 트랜잭션 감지${unlimitedPart}${spenderPart}. 드레이너 위험을 확인하세요 — ${tx.hash.slice(
          0,
          12,
        )}…`,
        tx,
      });
    }
  }

  return alerts;
}
