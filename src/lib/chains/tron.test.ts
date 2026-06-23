import { describe, expect, it } from 'vitest';
import { buildTrc20Meta, resolveTrc20Balances } from './tron';

const USDT = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';
const JST = 'TCFLL5dx5ZJdKnWuesXxi1VPwjLVmWZZy9';

describe('buildTrc20Meta', () => {
  it('maps contract address to symbol + decimals from transfers', () => {
    const meta = buildTrc20Meta([
      { token_info: { address: USDT, symbol: 'USDT', decimals: 6 } },
      { token_info: { address: JST, symbol: 'JST', decimals: 18 } },
      { token_info: { address: USDT, symbol: 'USDT', decimals: 6 } }, // dup
    ]);
    expect(meta.get(USDT)).toEqual({ symbol: 'USDT', decimals: 6 });
    expect(meta.get(JST)).toEqual({ symbol: 'JST', decimals: 18 });
    expect(meta.size).toBe(2);
  });

  it('falls back to contract + 6 decimals when fields missing', () => {
    const meta = buildTrc20Meta([{ token_info: { address: USDT } }]);
    expect(meta.get(USDT)).toEqual({ symbol: USDT, decimals: 6 });
  });

  it('skips rows without a contract address', () => {
    expect(buildTrc20Meta([{ token_info: { symbol: 'X' } }, {}]).size).toBe(0);
  });
});

describe('resolveTrc20Balances', () => {
  it('labels balances with resolved symbol + correct decimals', () => {
    const meta = buildTrc20Meta([
      { token_info: { address: JST, symbol: 'JST', decimals: 18 } },
    ]);
    // 1500000 raw at 6 dp (USDT, unknown) and 2e18 raw at 18 dp (JST)
    const out = resolveTrc20Balances(
      [{ [USDT]: '1500000' }, { [JST]: '2000000000000000000' }],
      meta,
    );
    const usdt = out.find((b) => b.asset === USDT);
    const jst = out.find((b) => b.asset === 'JST');
    expect(usdt?.amount).toBeCloseTo(1.5, 9); // unknown -> 6dp fallback
    expect(jst?.amount).toBeCloseTo(2, 9); // resolved -> 18dp
  });

  it('omits zero balances', () => {
    expect(resolveTrc20Balances([{ [USDT]: '0' }], new Map())).toHaveLength(0);
  });

  it('uses contract as label and 6dp when meta is missing', () => {
    const out = resolveTrc20Balances([{ [USDT]: '1000000' }], new Map());
    expect(out[0]).toMatchObject({ asset: USDT });
    expect(out[0].amount).toBeCloseTo(1, 9);
  });
});
