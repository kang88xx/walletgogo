import { NextResponse } from 'next/server';
import { getAdapter, isChainId } from '@/lib/chains';
import { getStore } from '@/lib/store';

export const runtime = 'nodejs';

export async function GET() {
  const store = getStore();
  const addresses = await store.listAddresses();
  return NextResponse.json({ addresses });
}

export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: '잘못된 JSON 본문입니다.' }, { status: 400 });
  }

  const { label, address, chainId } = (body ?? {}) as Record<string, unknown>;

  if (typeof label !== 'string' || label.trim() === '') {
    return NextResponse.json({ error: '라벨을 입력하세요.' }, { status: 400 });
  }
  if (typeof address !== 'string' || address.trim() === '') {
    return NextResponse.json({ error: '주소를 입력하세요.' }, { status: 400 });
  }
  if (typeof chainId !== 'string' || !isChainId(chainId)) {
    return NextResponse.json({ error: '지원하지 않는 체인입니다.' }, { status: 400 });
  }

  const trimmed = address.trim();
  if (!getAdapter(chainId).validateAddress(trimmed)) {
    return NextResponse.json(
      { error: `${chainId} 체인 형식에 맞지 않는 주소입니다.` },
      { status: 400 },
    );
  }

  const store = getStore();
  const entry = await store.addAddress({
    label: label.trim(),
    address: trimmed,
    chainId,
  });
  return NextResponse.json({ address: entry }, { status: 201 });
}
