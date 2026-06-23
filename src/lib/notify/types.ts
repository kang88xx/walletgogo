import type { StoredAlert } from '@/lib/store/types';

/**
 * A delivery channel. Implementations must never throw out of `send` — a failing
 * channel must not abort a monitor run or block sibling channels.
 */
export interface NotifyChannel {
  readonly name: string;
  /** Whether this channel is configured (env present). */
  enabled(): boolean;
  /** Deliver a batch of newly-fired alerts. Returns false on failure. */
  send(alerts: StoredAlert[]): Promise<boolean>;
}

export interface NotifyResult {
  channel: string;
  ok: boolean;
  error?: string;
}
