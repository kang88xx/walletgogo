import { describe, expect, it } from 'vitest';
import { KNOWN_SAFE_SPENDERS, reputationOf } from './spender-reputation';

const SAFE = [...KNOWN_SAFE_SPENDERS][0];
const EVIL = '0xdeadbeef00000000000000000000000000000000';

describe('reputationOf', () => {
  it('returns unknown for an undefined or unlisted spender', () => {
    expect(reputationOf(undefined, {})).toBe('unknown');
    expect(reputationOf('0xabc0000000000000000000000000000000000000', {})).toBe(
      'unknown',
    );
  });

  it('recognizes a bundled known-safe router (case-insensitive)', () => {
    expect(reputationOf(SAFE, {})).toBe('safe');
    expect(reputationOf(SAFE.toUpperCase(), {})).toBe('safe');
  });

  it('flags an env-blocklisted spender as malicious', () => {
    expect(reputationOf(EVIL, { MALICIOUS_SPENDERS: EVIL })).toBe('malicious');
    // case + whitespace tolerant, comma-separated
    expect(
      reputationOf(EVIL, { MALICIOUS_SPENDERS: ` foo, ${EVIL.toUpperCase()} ` }),
    ).toBe('malicious');
  });

  it('malicious blocklist overrides safe status', () => {
    expect(reputationOf(SAFE, { MALICIOUS_SPENDERS: SAFE })).toBe('malicious');
  });
});
