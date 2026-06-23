import { NextResponse } from 'next/server';
import { getStore } from '@/lib/store';
import { parseAlchemy, parseHelius, type ParsedActivity } from '@/lib/webhooks/parse';
import { processWebhookActivities } from '@/lib/webhooks/process';
import { verifyAlchemySignature, verifyHeliusAuth } from '@/lib/webhooks/verify';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Real-time push endpoint for Alchemy Address Activity and Helius enhanced-tx
 * webhooks. Verifies the provider signature/secret, parses the payload, and
 * runs matched transfers through the same rule engine + notifier as polling.
 */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ provider: string }> },
) {
  const { provider } = await params;
  const raw = await req.text();

  let activities: ParsedActivity[];
  if (provider === 'alchemy') {
    const ok = verifyAlchemySignature(
      raw,
      req.headers.get('x-alchemy-signature'),
      process.env.ALCHEMY_WEBHOOK_SIGNING_KEY,
    );
    if (!ok) {
      return NextResponse.json({ error: 'invalid signature' }, { status: 401 });
    }
    activities = parseAlchemy(safeJson(raw));
  } else if (provider === 'helius') {
    const ok = verifyHeliusAuth(
      req.headers.get('authorization'),
      process.env.HELIUS_WEBHOOK_SECRET,
    );
    if (!ok) {
      return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
    }
    activities = parseHelius(safeJson(raw));
  } else {
    return NextResponse.json(
      { error: `unknown provider '${provider}'` },
      { status: 404 },
    );
  }

  // Never let an internal error escape as an unhandled 500 — providers retry on
  // non-2xx, and the alerts (if any) are already deduped in the store.
  try {
    const result = await processWebhookActivities(getStore(), activities);
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    console.error('[webhook] processing failed:', err);
    return NextResponse.json({ ok: false, error: 'processing failed' }, { status: 200 });
  }
}

function safeJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
