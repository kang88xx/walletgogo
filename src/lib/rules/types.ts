import type { ChainId, NormalizedTx } from '@/lib/chains/types';

export interface AlertRuleConfig {
  /** Alert when any native/token balance differs from the last snapshot. */
  balanceChange: boolean;
  /** Alert on outgoing transfers above a per-address threshold. */
  largeWithdrawal: { enabled: boolean; threshold: number };
  /** Alert when a never-before-seen transaction hash appears. */
  newTransaction: boolean;
  /** Alert when an ERC20/NFT approval (or chain equivalent) is detected. */
  approval: boolean;
}

export const DEFAULT_RULES: AlertRuleConfig = {
  balanceChange: true,
  largeWithdrawal: { enabled: true, threshold: 1 },
  newTransaction: true,
  approval: true,
};

export type RuleType =
  | 'balance_change'
  | 'large_withdrawal'
  | 'new_transaction'
  | 'approval';

export type AlertSeverity = 'info' | 'warn' | 'critical';

export interface Alert {
  addressId: string;
  address: string;
  chainId: ChainId;
  rule: RuleType;
  severity: AlertSeverity;
  title: string;
  message: string;
  tx?: NormalizedTx;
  /**
   * Deterministic identity for an alert *event*. Two runs that observe the same
   * underlying event (same tx + rule, or same balance state) produce the same
   * key, so persistence and notification can dedup. Set by the rule engine.
   */
  dedupKey: string;
}
