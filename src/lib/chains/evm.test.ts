import { describe, expect, it } from 'vitest';
import {
  classifyApprovalCall,
  decodeApprove,
  decodeSetApprovalForAll,
  decodeUint256,
  deriveHeldTokens,
  encodeBalanceOf,
} from './evm';

describe('encodeBalanceOf', () => {
  it('builds selector + 32-byte left-padded address', () => {
    const data = encodeBalanceOf('0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045');
    expect(data.startsWith('0x70a08231')).toBe(true);
    // selector(8) + 64 hex chars + 0x
    expect(data).toHaveLength(2 + 8 + 64);
    expect(data.endsWith('d8da6bf26964af9d7eed9e03e53415d37aa96045')).toBe(true);
    // left-pad zeros between selector and address
    expect(data).toContain('70a08231000000000000000000000000');
  });
});

describe('decodeUint256', () => {
  it('decodes a hex balance with decimals', () => {
    // 1500000 (1.5 with 6 decimals like USDC)
    expect(decodeUint256('0x16e360', 6)).toBeCloseTo(1.5, 9);
  });
  it('treats empty / 0x as zero', () => {
    expect(decodeUint256('0x', 18)).toBe(0);
    expect(decodeUint256('', 18)).toBe(0);
  });
  it('handles 18-decimal whole token', () => {
    expect(decodeUint256('0x0de0b6b3a7640000', 18)).toBeCloseTo(1, 9); // 1e18
  });
});

describe('deriveHeldTokens', () => {
  it('dedups contracts, keeps first (most recent) occurrence, parses decimals', () => {
    const rows = [
      { contractAddress: '0xAAA', tokenSymbol: 'USDC', tokenDecimal: '6' },
      { contractAddress: '0xaaa', tokenSymbol: 'USDC', tokenDecimal: '6' }, // dup (case)
      { contractAddress: '0xBBB', tokenSymbol: 'DAI', tokenDecimal: '18' },
      { contractAddress: undefined, tokenSymbol: 'X' }, // skipped
    ];
    const held = deriveHeldTokens(rows);
    expect(held.map((h) => h.contract)).toEqual(['0xaaa', '0xbbb']);
    expect(held[0]).toMatchObject({ symbol: 'USDC', decimals: 6 });
    expect(held[1]).toMatchObject({ symbol: 'DAI', decimals: 18 });
  });

  it('falls back to contract as symbol and 18 decimals when missing', () => {
    const held = deriveHeldTokens([{ contractAddress: '0xCCC' }]);
    expect(held[0]).toMatchObject({ contract: '0xccc', symbol: '0xccc', decimals: 18 });
  });

  it('caps the number of tokens', () => {
    const rows = Array.from({ length: 50 }, (_, i) => ({
      contractAddress: `0x${i.toString(16).padStart(40, '0')}`,
      tokenSymbol: `T${i}`,
      tokenDecimal: '18',
    }));
    expect(deriveHeldTokens(rows, 25)).toHaveLength(25);
  });
});

// approve(spender, amount) selector 0x095ea7b3
const SPENDER = '1111111254eeb25477b68fb85ed929f73a960582'; // 1inch router (example)
const word = (hex: string) => hex.padStart(64, '0');
const MAX_UINT256 = 'f'.repeat(64);

describe('decodeApprove', () => {
  it('decodes spender and a finite amount', () => {
    const input = '0x095ea7b3' + word(SPENDER) + word('64'); // amount = 100 wei
    const d = decodeApprove(input)!;
    expect(d.spender).toBe('0x' + SPENDER);
    expect(d.amount).toBe(100n);
    expect(d.unlimited).toBe(false);
  });

  it('flags MaxUint256 as unlimited', () => {
    const input = '0x095ea7b3' + word(SPENDER) + MAX_UINT256;
    const d = decodeApprove(input)!;
    expect(d.unlimited).toBe(true);
  });

  it('returns null for non-approve calldata or truncated input', () => {
    expect(decodeApprove('0xdeadbeef' + word(SPENDER) + word('1'))).toBeNull();
    expect(decodeApprove('0x095ea7b3' + word(SPENDER))).toBeNull(); // missing amount word
  });
});

describe('decodeSetApprovalForAll', () => {
  it('decodes operator and approved=true', () => {
    const input = '0xa22cb465' + word(SPENDER) + word('1');
    const d = decodeSetApprovalForAll(input)!;
    expect(d.operator).toBe('0x' + SPENDER);
    expect(d.approved).toBe(true);
  });

  it('decodes approved=false (revoke)', () => {
    const input = '0xa22cb465' + word(SPENDER) + word('0');
    expect(decodeSetApprovalForAll(input)!.approved).toBe(false);
  });

  it('returns null for unrelated calldata', () => {
    expect(decodeSetApprovalForAll('0x095ea7b3' + word(SPENDER) + word('1'))).toBeNull();
  });
});

describe('classifyApprovalCall (grant vs revoke)', () => {
  it('classifies a positive approve as an approval grant', () => {
    const c = classifyApprovalCall('0x095ea7b3' + word(SPENDER) + word('64'))!;
    expect(c).toMatchObject({ type: 'approval', unlimited: false });
    expect(c.spender).toBe('0x' + SPENDER);
  });

  it('flags MaxUint256 approve as unlimited', () => {
    const c = classifyApprovalCall('0x095ea7b3' + word(SPENDER) + MAX_UINT256)!;
    expect(c.unlimited).toBe(true);
  });

  it('treats approve(spender, 0) as a revoke (null, no alert)', () => {
    expect(classifyApprovalCall('0x095ea7b3' + word(SPENDER) + word('0'))).toBeNull();
  });

  it('classifies setApprovalForAll(op, true) as nft_approval grant (unlimited)', () => {
    const c = classifyApprovalCall('0xa22cb465' + word(SPENDER) + word('1'))!;
    expect(c).toMatchObject({ type: 'nft_approval', unlimited: true });
    expect(c.spender).toBe('0x' + SPENDER);
  });

  it('treats setApprovalForAll(op, false) as a revoke (null, no alert)', () => {
    expect(classifyApprovalCall('0xa22cb465' + word(SPENDER) + word('0'))).toBeNull();
  });

  it('returns null for non-approval calldata', () => {
    expect(classifyApprovalCall('0xdeadbeef' + word(SPENDER) + word('1'))).toBeNull();
  });
});
