# wallet-gogo

멀티체인 지갑 모니터. EVM · Solana · Bitcoin · Tron 주소의 잔액 변동과 트랜잭션을
감시하고, 대규모 출금과 승인(approval) 같은 위험 신호를 알립니다. UI는 ARK Prefab
v2.0 디자인 시스템(네이비 코어 · 앰버 액센트 · Pretendard/Geist Mono)을 따릅니다.

## 스택

- Next.js 15 (App Router) · React 19 · TypeScript
- 외부 의존성 없는 JSON 파일 스토어 (`.data/`)
- 체인 어댑터: Etherscan V2 + JSON-RPC(EVM), mempool.space(BTC), Solana RPC, TronGrid

## 구조

```
src/lib/chains/   체인별 어댑터 + 레지스트리 (공통 ChainAdapter 인터페이스)
src/lib/rules/    순수 알림 평가 엔진 (balance_change · large_withdrawal · new_transaction · approval)
src/lib/store/    Store 인터페이스 + 파일 기반 구현
src/lib/monitor.ts  오케스트레이터 (주소별 fetch → evaluate → 스냅샷 저장, 에러 격리)
src/app/          대시보드 UI + API 라우트 (/api/addresses, /api/check)
```

## 시작

```bash
npm install
cp .env.example .env   # API 키 / RPC 엔드포인트 채우기 (선택)
npm run dev            # http://localhost:3000
```

`ETHERSCAN_API_KEY`가 있어야 EVM 트랜잭션 히스토리가 동작합니다(없으면 잔액 기반
룰만 동작, graceful degrade). 안정적인 점검을 위해 `.env`에 신뢰할 수 있는 RPC
엔드포인트(`ETHEREUM_RPC_URL` 등) 설정을 권장합니다.

## 동작

첫 점검은 기준선 스냅샷만 저장합니다. 알림은 두 번째 점검부터 발생합니다 — 그래야
전체 히스토리와 기존 잔액이 "신규"로 쏟아지지 않습니다.

## 검증

```bash
npm run typecheck
npm run build
```
