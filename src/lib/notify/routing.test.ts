import { describe, expect, it } from 'vitest';
import type { StoredAlert } from '@/lib/store/types';
import type { AlertSeverity } from '@/lib/rules/types';
import { minSeverityFor, routeAlerts, SEVERITY_RANK } from './routing';

function sa(severity: AlertSeverity, id: string): StoredAlert {
  return {
    addressId: 'a1',
    address: '0xabc',
    chainId: 'ethereum',
    rule: 'new_transaction',
    severity,
    title: 't',
    message: 'm',
    dedupKey: id,
    id,
    firedAt: 1,
    read: false,
  };
}

const ALL: StoredAlert[] = [sa('info', 'i'), sa('warn', 'w'), sa('critical', 'c')];

describe('minSeverityFor', () => {
  it('defaults to info when unset', () => {
    expect(minSeverityFor('telegram', {})).toBe('info');
  });
  it('reads <CHANNEL>_MIN_SEVERITY (case-insensitive value)', () => {
    expect(minSeverityFor('telegram', { TELEGRAM_MIN_SEVERITY: 'critical' })).toBe(
      'critical',
    );
    expect(minSeverityFor('discord', { DISCORD_MIN_SEVERITY: 'WARN' })).toBe('warn');
  });
  it('falls back to info on an invalid value (no silent silencing)', () => {
    expect(minSeverityFor('console', { CONSOLE_MIN_SEVERITY: 'bogus' })).toBe('info');
  });
});

describe('routeAlerts', () => {
  it('passes everything at the default info threshold', () => {
    expect(routeAlerts('telegram', ALL, {})).toHaveLength(3);
  });
  it('filters to critical-only when configured', () => {
    const out = routeAlerts('telegram', ALL, { TELEGRAM_MIN_SEVERITY: 'critical' });
    expect(out.map((a) => a.severity)).toEqual(['critical']);
  });
  it('warn threshold keeps warn + critical', () => {
    const out = routeAlerts('discord', ALL, { DISCORD_MIN_SEVERITY: 'warn' });
    expect(out.map((a) => a.severity)).toEqual(['warn', 'critical']);
  });
  it('ranks severities monotonically', () => {
    expect(SEVERITY_RANK.info).toBeLessThan(SEVERITY_RANK.warn);
    expect(SEVERITY_RANK.warn).toBeLessThan(SEVERITY_RANK.critical);
  });
});
