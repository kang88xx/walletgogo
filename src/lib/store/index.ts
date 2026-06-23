import { createFileStore } from './file-store';
import type { Store } from './types';

export * from './types';
export { createFileStore } from './file-store';

// Cache a single Store on the global so it survives Next.js dev hot-reloads
// (each reload re-evaluates modules but keeps `globalThis`).
const globalForStore = globalThis as unknown as { __walletGogoStore?: Store };

export function getStore(): Store {
  if (!globalForStore.__walletGogoStore) {
    globalForStore.__walletGogoStore = createFileStore();
  }
  return globalForStore.__walletGogoStore;
}
