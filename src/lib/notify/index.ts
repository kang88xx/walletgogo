import type { StoredAlert } from '@/lib/store/types';
import { allChannels } from './channels';
import { routeAlerts } from './routing';
import type { NotifyChannel, NotifyResult } from './types';

export type { NotifyChannel, NotifyResult } from './types';
export { allChannels } from './channels';
export { minSeverityFor, routeAlerts, SEVERITY_RANK } from './routing';

export interface Notifier {
  /** Names of channels that are currently configured. */
  enabledChannels(): string[];
  /** Fan out alerts to every enabled channel. Never throws. */
  dispatch(alerts: StoredAlert[]): Promise<NotifyResult[]>;
}

export function createNotifier(channels: NotifyChannel[] = allChannels()): Notifier {
  return {
    enabledChannels() {
      return channels.filter((c) => c.enabled()).map((c) => c.name);
    },

    async dispatch(alerts: StoredAlert[]): Promise<NotifyResult[]> {
      if (alerts.length === 0) return [];
      const active = channels.filter((c) => c.enabled());
      // Each channel is isolated: one failure never blocks the others. Alerts
      // are routed per channel by minimum severity, so a channel that filters
      // everything out is skipped rather than sent an empty batch.
      const results = await Promise.all(
        active.map(async (c): Promise<NotifyResult | null> => {
          const routed = routeAlerts(c.name, alerts);
          if (routed.length === 0) return null;
          try {
            const ok = await c.send(routed);
            return { channel: c.name, ok };
          } catch (err) {
            return {
              channel: c.name,
              ok: false,
              error: err instanceof Error ? err.message : String(err),
            };
          }
        }),
      );
      return results.filter((r): r is NotifyResult => r !== null);
    },
  };
}

// Cache one notifier on the global so config is read once per process and it
// survives Next dev hot-reloads.
const g = globalThis as unknown as { __walletGogoNotifier?: Notifier };

export function getNotifier(): Notifier {
  if (!g.__walletGogoNotifier) g.__walletGogoNotifier = createNotifier();
  return g.__walletGogoNotifier;
}
