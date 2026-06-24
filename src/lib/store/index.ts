import { Redis } from '@upstash/redis';
import { createFileStore } from './file-store';
import { createRedisStore } from './redis-store';
import type { Store } from './types';

export * from './types';
export { createFileStore } from './file-store';
export { createRedisStore } from './redis-store';

// Cache a single Store on the global so it survives Next.js dev hot-reloads
// (each reload re-evaluates modules but keeps `globalThis`).
const globalForStore = globalThis as unknown as { __walletGogoStore?: Store };

/**
 * Upstash exposes credentials under either its native names or the Vercel KV
 * marketplace aliases. Support both so the integration works however it's wired.
 */
function redisEnv(): { url: string; token: string } | null {
  const url = process.env.UPSTASH_REDIS_REST_URL ?? process.env.KV_REST_API_URL;
  const token =
    process.env.UPSTASH_REDIS_REST_TOKEN ?? process.env.KV_REST_API_TOKEN;
  return url && token ? { url, token } : null;
}

function createStore(): Store {
  const creds = redisEnv();
  if (creds) {
    return createRedisStore(new Redis({ url: creds.url, token: creds.token }));
  }
  return createFileStore();
}

export function getStore(): Store {
  if (!globalForStore.__walletGogoStore) {
    globalForStore.__walletGogoStore = createStore();
  }
  return globalForStore.__walletGogoStore;
}
