import { describe, expect, it } from 'vitest';
import { DEFAULT_RULES, sanitizeRules } from './types';

describe('sanitizeRules', () => {
  it('returns defaults for empty / non-object input', () => {
    expect(sanitizeRules(undefined)).toEqual(DEFAULT_RULES);
    expect(sanitizeRules(null)).toEqual(DEFAULT_RULES);
    expect(sanitizeRules('nope')).toEqual(DEFAULT_RULES);
  });

  it('respects valid boolean toggles', () => {
    const r = sanitizeRules({
      balanceChange: false,
      newTransaction: false,
      approval: false,
      largeWithdrawal: { enabled: false, threshold: 5 },
    });
    expect(r.balanceChange).toBe(false);
    expect(r.newTransaction).toBe(false);
    expect(r.approval).toBe(false);
    expect(r.largeWithdrawal).toEqual({ enabled: false, threshold: 5 });
  });

  it('coerces invalid threshold to default and drops bad usdThreshold', () => {
    const r = sanitizeRules({
      largeWithdrawal: { enabled: true, threshold: -3, usdThreshold: 0 },
    });
    expect(r.largeWithdrawal.threshold).toBe(
      DEFAULT_RULES.largeWithdrawal.threshold,
    );
    expect(r.largeWithdrawal.usdThreshold).toBeUndefined();
  });

  it('keeps a positive usdThreshold', () => {
    const r = sanitizeRules({
      largeWithdrawal: { enabled: true, threshold: 1, usdThreshold: 10000 },
    });
    expect(r.largeWithdrawal.usdThreshold).toBe(10000);
  });

  it('ignores unknown extra keys', () => {
    const r = sanitizeRules({ balanceChange: true, evil: 'x' } as unknown);
    expect(r).not.toHaveProperty('evil');
  });
});
