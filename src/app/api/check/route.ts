import { NextResponse } from 'next/server';
import { runCheck } from '@/lib/monitor';
import { getStore } from '@/lib/store';

export const runtime = 'nodejs';
// Each check fans out to external RPC/explorer APIs; never serve a cached result.
export const dynamic = 'force-dynamic';

export async function POST() {
  const store = getStore();
  const result = await runCheck(store);
  return NextResponse.json(result);
}
