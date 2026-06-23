import { NextResponse } from 'next/server';
import { clampInterval, getScheduler } from '@/lib/scheduler/scheduler';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  return NextResponse.json(getScheduler().status());
}

/** Body: { action: 'start' | 'stop' | 'runNow', intervalSeconds?: number } */
export async function POST(req: Request) {
  let body: { action?: string; intervalSeconds?: number } = {};
  try {
    body = await req.json();
  } catch {
    // default below
  }
  const scheduler = getScheduler();

  switch (body.action) {
    case 'start':
      scheduler.start(
        body.intervalSeconds ? clampInterval(body.intervalSeconds) : undefined,
      );
      break;
    case 'stop':
      scheduler.stop();
      break;
    case 'runNow':
      await scheduler.tick();
      break;
    default:
      return NextResponse.json(
        { error: "action must be 'start', 'stop', or 'runNow'." },
        { status: 400 },
      );
  }

  return NextResponse.json(scheduler.status());
}
