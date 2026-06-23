/**
 * Reputation lookup for approval spenders/operators. Helps the approval rule
 * separate routine grants (a known DEX router) from suspicious ones (an unknown
 * or known-malicious contract — the classic drainer pattern).
 *
 * - Known-safe: a small bundled set of widely-used router/permit contracts.
 * - Malicious: operator-supplied blocklist via MALICIOUS_SPENDERS env
 *   (comma-separated addresses), merged with an optional bundled set.
 * - Everything else is "unknown" — alert and tell the user to verify.
 *
 * Addresses are compared case-insensitively (lowercased).
 */

export type SpenderReputation = 'safe' | 'malicious' | 'unknown';

/** Well-known, widely-used spender contracts (lowercased). */
export const KNOWN_SAFE_SPENDERS: ReadonlySet<string> = new Set([
  '0x1111111254eeb25477b68fb85ed929f73a960582', // 1inch v5 router
  '0x111111125421ca6dc452d289314280a0f8842a65', // 1inch v6 router
  '0x68b3465833fb72a70ecdf485e0e4c7bd8665fc45', // Uniswap universal router
  '0x7a250d5630b4cf539739df2c5dacb4c659f2488d', // Uniswap v2 router
  '0xe592427a0aece92de3edee1f18e0157c05861564', // Uniswap v3 router
  '0x3fc91a3afd70395cd496c647d5a6cc9d4b2b7fad', // Uniswap universal router 2
  '0x000000000022d473030f116ddee9f6b43ac78ba3', // Permit2
  '0xdef1c0ded9bec7f1a1670819833240f027b25eff', // 0x Exchange Proxy
]);

/** Bundled known-malicious set (kept empty by default; populated via env). */
export const BUNDLED_MALICIOUS_SPENDERS: ReadonlySet<string> = new Set([]);

function parseBlocklist(env: Record<string, string | undefined>): Set<string> {
  const raw = env.MALICIOUS_SPENDERS;
  const out = new Set<string>(BUNDLED_MALICIOUS_SPENDERS);
  if (raw) {
    for (const addr of raw.split(',')) {
      const a = addr.trim().toLowerCase();
      if (a) out.add(a);
    }
  }
  return out;
}

export function reputationOf(
  spender: string | undefined,
  env: Record<string, string | undefined> = process.env,
): SpenderReputation {
  if (!spender) return 'unknown';
  const s = spender.toLowerCase();
  if (parseBlocklist(env).has(s)) return 'malicious';
  if (KNOWN_SAFE_SPENDERS.has(s)) return 'safe';
  return 'unknown';
}
