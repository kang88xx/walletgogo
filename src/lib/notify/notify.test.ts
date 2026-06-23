import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StoredAlert } from '@/lib/store/types';
import { createNotifier } from './index';
import {
  consoleChannel,
  discordChannel,
  telegramChannel,
} from './channels';
import type { NotifyChannel } from './types';

function sa(over: Partial<StoredAlert> = {}): StoredAlert {
  return {
    addressId: 'a1',
    address: '0xabc',
    chainId: 'ethereum',
    rule: 'approval',
    severity: 'critical',
    title: 'Approval',
    message: 'spender X',
    dedupKey: 'k1',
    id: 'id1',
    firedAt: 100,
    read: false,
    ...over,
  };
}

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  delete process.env.TELEGRAM_BOT_TOKEN;
  delete process.env.TELEGRAM_CHAT_ID;
  delete process.env.DISCORD_WEBHOOK_URL;
  delete process.env.NOTIFY_CONSOLE;
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  vi.restoreAllMocks();
});

describe('channel enablement from env', () => {
  it('telegram requires both token and chat id', () => {
    expect(telegramChannel().enabled()).toBe(false);
    process.env.TELEGRAM_BOT_TOKEN = 't';
    expect(telegramChannel().enabled()).toBe(false);
    process.env.TELEGRAM_CHAT_ID = 'c';
    expect(telegramChannel().enabled()).toBe(true);
  });

  it('discord requires a valid https discord webhook url (SSRF guard)', () => {
    expect(discordChannel().enabled()).toBe(false);
    process.env.DISCORD_WEBHOOK_URL = 'http://evil.internal/x'; // not https/discord
    expect(discordChannel().enabled()).toBe(false);
    process.env.DISCORD_WEBHOOK_URL = 'https://attacker.com/api/webhooks/1/abc';
    expect(discordChannel().enabled()).toBe(false);
    process.env.DISCORD_WEBHOOK_URL = 'https://discord.com/api/webhooks/123/abc';
    expect(discordChannel().enabled()).toBe(true);
  });

  it('console is opt-in', () => {
    expect(consoleChannel().enabled()).toBe(false);
    process.env.NOTIFY_CONSOLE = '1';
    expect(consoleChannel().enabled()).toBe(true);
  });
});

describe('notifier fan-out', () => {
  it('is a no-op (no channels) when nothing is configured', async () => {
    const notifier = createNotifier();
    expect(notifier.enabledChannels()).toEqual([]);
    expect(await notifier.dispatch([sa()])).toEqual([]);
  });

  it('dispatches only to enabled channels', async () => {
    const calls: string[] = [];
    const mk = (name: string, on: boolean): NotifyChannel => ({
      name,
      enabled: () => on,
      send: async () => {
        calls.push(name);
        return true;
      },
    });
    const notifier = createNotifier([mk('on', true), mk('off', false)]);
    const res = await notifier.dispatch([sa()]);
    expect(calls).toEqual(['on']);
    expect(res).toEqual([{ channel: 'on', ok: true }]);
  });

  it('isolates a throwing channel from siblings', async () => {
    const good: NotifyChannel = {
      name: 'good',
      enabled: () => true,
      send: async () => true,
    };
    const bad: NotifyChannel = {
      name: 'bad',
      enabled: () => true,
      send: async () => {
        throw new Error('boom');
      },
    };
    const res = await createNotifier([bad, good]).dispatch([sa()]);
    expect(res.find((r) => r.channel === 'good')?.ok).toBe(true);
    expect(res.find((r) => r.channel === 'bad')?.ok).toBe(false);
    expect(res.find((r) => r.channel === 'bad')?.error).toContain('boom');
  });

  it('returns empty for an empty alert batch', async () => {
    const notifier = createNotifier([
      { name: 'x', enabled: () => true, send: async () => true },
    ]);
    expect(await notifier.dispatch([])).toEqual([]);
  });
});
