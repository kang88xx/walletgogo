import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Verify an Alchemy webhook signature: HMAC-SHA256 of the raw request body with
 * the webhook's signing key, compared in constant time against the
 * `x-alchemy-signature` header. Returns false on any mismatch or missing input.
 */
export function verifyAlchemySignature(
  rawBody: string,
  signature: string | null,
  signingKey: string | undefined,
): boolean {
  if (!signature || !signingKey) return false;
  const digest = createHmac('sha256', signingKey).update(rawBody, 'utf8').digest('hex');
  const a = Buffer.from(digest);
  const b = Buffer.from(signature);
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

/**
 * Verify a Helius webhook: Helius echoes the Authorization header you configured
 * on the webhook. Constant-time compare against the expected secret.
 */
export function verifyHeliusAuth(
  authHeader: string | null,
  expected: string | undefined,
): boolean {
  if (!authHeader || !expected) return false;
  const a = Buffer.from(authHeader);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(a, b);
  } catch {
    return false;
  }
}
