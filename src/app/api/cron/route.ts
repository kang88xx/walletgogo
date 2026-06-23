import { NextResponse } from 'next/server';
import { runCheck } from '@/lib/monitor';
import { getStore } from '@/lib/store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// Allow a full polling sweep across external RPCs/explorers.
export const maxDuration = 60;

/**
 * Serverless polling entrypoint. Vercel Cron invokes this on a schedule (see
 * vercel.json) with `Authorization: Bearer ${CRON_SECRET}`. This replaces the
 * always-on setInterval scheduler, which can't run on serverless. Webhooks
 * (/api/webhooks/*) remain the lowest-latency path; cron is the periodic sweep.
 */
export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const auth = req.headers.get('authorization');
    if (auth !== `Bearer ${secret}`) {
      return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
    }
  }
  const result = await runCheck(getStore());
  return NextResponse.json({
    ok: true,
    checkedAt: result.checkedAt,
    addresses: result.results.length,
    newAlerts: result.newAlerts.length,
  });
}
