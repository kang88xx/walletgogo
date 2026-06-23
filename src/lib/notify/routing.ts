import type { AlertSeverity } from '@/lib/rules/types';
import type { StoredAlert } from '@/lib/store/types';

/** Ordered severity ranks for threshold comparisons. */
export const SEVERITY_RANK: Record<AlertSeverity, number> = {
  info: 0,
  warn: 1,
  critical: 2,
};

const VALID = new Set(['info', 'warn', 'critical']);

/**
 * Per-channel minimum severity, read from `<CHANNEL>_MIN_SEVERITY` env
 * (e.g. TELEGRAM_MIN_SEVERITY=critical). Defaults to 'info' (everything).
 * Unknown values fall back to the default so a typo can't silence a channel.
 */
export function minSeverityFor(
  channelName: string,
  env: Record<string, string | undefined> = process.env,
): AlertSeverity {
  const raw = env[`${channelName.toUpperCase()}_MIN_SEVERITY`]?.toLowerCase();
  return raw && VALID.has(raw) ? (raw as AlertSeverity) : 'info';
}

/** Keep only alerts at or above the channel's minimum severity. */
export function routeAlerts(
  channelName: string,
  alerts: StoredAlert[],
  env: Record<string, string | undefined> = process.env,
): StoredAlert[] {
  const min = SEVERITY_RANK[minSeverityFor(channelName, env)];
  return alerts.filter((a) => SEVERITY_RANK[a.severity] >= min);
}
