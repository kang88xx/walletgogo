import { NextResponse } from 'next/server';
import { getStore } from '@/lib/store';

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
