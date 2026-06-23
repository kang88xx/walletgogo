import type { ChainId } from '@/lib/chains/types';
import type { Alert, AlertRuleConfig } from '@/lib/rules/types';

export interface WatchedAddress {
  id: string;
  label: string;
  address: string;
  chainId: ChainId;
  rules: AlertRuleConfig;
  createdAt: number;
}

export interface Snapshot {
  addressId: string;
  /** Unix seconds when this snapshot was taken. */
  checkedAt: number;
  /** asset symbol -> human-unit amount. */
  balances: Record<string, number>;
  /** Transaction hashes seen so far (capped, most recent kept). */
  seenTxHashes: string[];
  /** Timestamp (unix seconds) of the most recent tx observed. */
  lastTs: number;
}

export interface AddAddressInput {
  label: string;
  address: string;
  chainId: ChainId;
  rules?: AlertRuleConfig;
}

/** An alert that has been persisted to history. */
export interface StoredAlert extends Alert {
  /** Random unique id for this stored row. */
  id: string;
  /** Unix seconds when first persisted. */
  firedAt: number;
  /** Whether the user has acknowledged it. */
  read: boolean;
}

export interface Store {
  listAddresses(): Promise<WatchedAddress[]>;
  addAddress(input: AddAddressInput): Promise<WatchedAddress>;
  removeAddress(id: string): Promise<void>;
  /** Patch an address's rule config. Returns the updated address, or null if missing. */
  updateAddressRules(
    id: string,
    rules: AlertRuleConfig,
  ): Promise<WatchedAddress | null>;
  getSnapshot(addressId: string): Promise<Snapshot | null>;
  saveSnapshot(snapshot: Snapshot): Promise<void>;
  /**
   * Atomically read-modify-write a snapshot in a single critical section so
   * concurrent writers (poll + webhook) can't clobber each other. `merge`
   * receives the current snapshot (or null) and returns the next one, or null
   * to leave it unchanged.
   */
  updateSnapshot(
    addressId: string,
    merge: (prev: Snapshot | null) => Snapshot | null,
  ): Promise<void>;
  /** Most-recent-first persisted alerts (optionally limited). */
  listAlerts(limit?: number): Promise<StoredAlert[]>;
  /**
   * Persist alerts whose dedupKey is not already stored. Returns only the
   * alerts that were newly inserted (so callers can notify exactly once).
   */
  appendAlerts(alerts: Alert[], firedAt: number): Promise<StoredAlert[]>;
  /** Mark specific alert ids (or all, when ids omitted) as read. */
  markAlertsRead(ids?: string[]): Promise<void>;
}
