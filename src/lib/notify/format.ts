import type { StoredAlert } from '@/lib/store/types';

const SEV_EMOJI: Record<string, string> = {
  info: 'ℹ️',
  warn: '⚠️',
  critical: '🚨',
};

/** One alert as a single human line (used by console + as a building block). */
export function formatAlertLine(a: StoredAlert): string {
  const emoji = SEV_EMOJI[a.severity] ?? '•';
  return `${emoji} [${a.severity.toUpperCase()}] ${a.title} — ${a.message}`;
}

/** Plain-text block for a batch (Telegram default / console). */
export function formatAlertsText(alerts: StoredAlert[]): string {
  const header =
    alerts.length === 1
      ? 'wallet-gogo · 새 알림 1건'
      : `wallet-gogo · 새 알림 ${alerts.length}건`;
  const body = alerts.map(formatAlertLine).join('\n');
  return `${header}\n${body}`;
}

/** Discord embeds — one per alert, colored by severity. */
export function formatDiscordPayload(alerts: StoredAlert[]): unknown {
  const color: Record<string, number> = {
    info: 0x546083, // navy steel
    warn: 0xefc540, // amber
    critical: 0xff5470, // red
  };
  return {
    username: 'wallet-gogo',
    embeds: alerts.slice(0, 10).map((a) => ({
      title: `${a.title}`,
      description: a.message,
      color: color[a.severity] ?? 0x091955,
      fields: [
        { name: 'Chain', value: a.chainId, inline: true },
        { name: 'Rule', value: a.rule, inline: true },
        { name: 'Address', value: a.address, inline: false },
      ],
    })),
  };
}
