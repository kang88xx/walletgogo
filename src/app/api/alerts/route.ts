import { NextResponse } from 'next/server';
import { getStore } from '@/lib/store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const url = new URL(req.url);
  const limitParam = url.searchParams.get('limit');
  const limit = limitParam ? Math.max(1, Math.min(500, Number(limitParam))) : 100;
  const store = getStore();
  const alerts = await store.listAlerts(Number.isFinite(limit) ? limit : 100);
  return NextResponse.json({ alerts });
}

/** Mark alerts read. Body: { ids?: string[] } — omit ids to mark all read. */
export async function PATCH(req: Request) {
  let body: unknown = {};
  try {
    body = await req.json();
  } catch {
    // empty body is allowed — marks all read
  }
  const ids = (body as { ids?: unknown }).ids;
  const idList = Array.isArray(ids) ? ids.filter((x): x is string => typeof x === 'string') : undefined;
  const store = getStore();
  await store.markAlertsRead(idList);
  return NextResponse.json({ ok: true });
}
