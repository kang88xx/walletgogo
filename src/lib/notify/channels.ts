import type { StoredAlert } from '@/lib/store/types';
import {
  formatAlertsText,
  formatDiscordPayload,
} from './format';
import type { NotifyChannel } from './types';

/** Console channel — opt-in via NOTIFY_CONSOLE=1 (off by default to avoid log noise). */
export function consoleChannel(): NotifyChannel {
  return {
    name: 'console',
    enabled() {
      return process.env.NOTIFY_CONSOLE === '1' || process.env.NOTIFY_CONSOLE === 'true';
    },
    async send(alerts: StoredAlert[]): Promise<boolean> {
      if (alerts.length === 0) return true;
      console.log(`[notify]\n${formatAlertsText(alerts)}`);
      return true;
    },
  };
}

/** Telegram Bot API channel — requires TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID. */
export function telegramChannel(): NotifyChannel {
  return {
    name: 'telegram',
    enabled() {
      return Boolean(
        process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID,
      );
    },
    async send(alerts: StoredAlert[]): Promise<boolean> {
      if (alerts.length === 0) return true;
      const token = process.env.TELEGRAM_BOT_TOKEN;
      const chatId = process.env.TELEGRAM_CHAT_ID;
      if (!token || !chatId) return false;
      try {
        const res = await fetch(
          `https://api.telegram.org/bot${token}/sendMessage`,
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              chat_id: chatId,
              text: formatAlertsText(alerts),
              disable_web_page_preview: true,
            }),
          },
        );
        return res.ok;
      } catch {
        return false;
      }
    },
  };
}

/**
 * Validate a Discord webhook URL: https + an official Discord host. Prevents a
 * misconfigured/injected env from turning the notifier into an SSRF that POSTs
 * alert contents (which name watched addresses) to an arbitrary host.
 */
export function isValidDiscordWebhook(raw: string | undefined): boolean {
  if (!raw) return false;
  try {
    const u = new URL(raw);
    return (
      u.protocol === 'https:' &&
      (u.hostname === 'discord.com' ||
        u.hostname === 'discordapp.com' ||
        u.hostname === 'canary.discord.com' ||
        u.hostname === 'ptb.discord.com')
    );
  } catch {
    return false;
  }
}

/** Discord webhook channel — requires a valid https DISCORD_WEBHOOK_URL. */
export function discordChannel(): NotifyChannel {
  return {
    name: 'discord',
    enabled() {
      return isValidDiscordWebhook(process.env.DISCORD_WEBHOOK_URL);
    },
    async send(alerts: StoredAlert[]): Promise<boolean> {
      if (alerts.length === 0) return true;
      const url = process.env.DISCORD_WEBHOOK_URL;
      if (!isValidDiscordWebhook(url) || !url) return false;
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(formatDiscordPayload(alerts)),
        });
        return res.ok;
      } catch {
        return false;
      }
    },
  };
}

export function allChannels(): NotifyChannel[] {
  return [telegramChannel(), discordChannel(), consoleChannel()];
}
