import type { ChainId } from '@/lib/chains/types';
import type { AlertRuleConfig } from '@/lib/rules/types';

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

export interface Store {
  listAddresses(): Promise<WatchedAddress[]>;
  addAddress(input: AddAddressInput): Promise<WatchedAddress>;
  removeAddress(id: string): Promise<void>;
  getSnapshot(addressId: string): Promise<Snapshot | null>;
  saveSnapshot(snapshot: Snapshot): Promise<void>;
}
