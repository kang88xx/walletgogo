import { NextResponse } from 'next/server';
import { getStore } from '@/lib/store';
import { sanitizeRules } from '@/lib/rules/types';

export const runtime = 'nodejs';

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  if (!id) {
    return NextResponse.json({ error: 'id가 필요합니다.' }, { status: 400 });
  }
  const store = getStore();
  await store.removeAddress(id);
  return NextResponse.json({ ok: true });
}

/** Update an address's alert rule config. Body: { rules: AlertRuleConfig }. */
export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  if (!id) {
    return NextResponse.json({ error: 'id가 필요합니다.' }, { status: 400 });
  }
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: '잘못된 JSON 본문입니다.' }, { status: 400 });
  }
  const rules = sanitizeRules((body as { rules?: unknown })?.rules);
  const store = getStore();
  const updated = await store.updateAddressRules(id, rules);
  if (!updated) {
    return NextResponse.json({ error: '주소를 찾을 수 없습니다.' }, { status: 404 });
  }
  return NextResponse.json({ address: updated });
}
