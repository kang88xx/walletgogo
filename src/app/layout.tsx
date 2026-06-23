import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'wallet-gogo · 멀티체인 지갑 모니터',
  description:
    'EVM·Solana·Bitcoin·Tron 주소의 잔액 변동과 트랜잭션을 감시하고 알림을 생성합니다. ARK Prefab v2.0 디자인 시스템 기반.',
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="ko">
      <body>{children}</body>
    </html>
  );
}
