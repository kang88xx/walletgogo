# wallet-gogo

프로덕션급 멀티체인 지갑 모니터. EVM · Solana · Bitcoin · Tron 주소의 잔액과
트랜잭션을 **자동으로 감시**하고, 대규모 출금과 **무제한 승인(approval)** 같은
드레이너 위험을 골라내 **Telegram · Discord**로 알립니다. UI는 ARK Prefab v2.0
디자인 시스템(네이비 코어 · 앰버 액센트 · Pretendard/Geist Mono)을 따릅니다.

## 핵심 기능

- **자동 폴링 스케줄러** — 설정 가능한 간격으로 모든 주소를 주기 점검 (서버 사이드,
  실행 겹침 방지, 오류 격리). UI 또는 `POLL_INTERVAL_SECONDS`로 제어.
- **알림 전송** — Telegram 봇, Discord 웹훅, 콘솔. env로 켜며 미설정 시 무시. 알림은
  dedup으로 이벤트당 한 번만 발송. **채널별 최소 심각도 라우팅**(예: Telegram은
  critical만, Discord는 전부).
- **실시간 webhook** — Alchemy(EVM) · Helius(Solana) 푸시를 받아 폴링과 동일한 룰
  엔진으로 즉시 평가·알림. 서명/시크릿 검증 후 처리.
- **Approval spender 평판** — 알려진 안전 라우터(Uniswap·1inch·Permit2·0x)는 warn으로
  완화, `MALICIOUS_SPENDERS` 블록리스트는 악성 critical로 강조.
- **알림 히스토리** — 발생한 알림을 저장(상한 1000), 타임라인 UI에서 읽음 처리.
- **USD 가치 평가** — CoinGecko 가격(TTL 캐시)으로 잔액·포트폴리오를 USD로. 대규모
  출금 임계값을 USD로도 설정 가능.
- **ERC20 토큰 잔액** — EVM에서 보유 토큰을 추론해 `balanceOf` 조회, 포트폴리오
  총가치 반영.
- **드레이너/Approval 방어** — `approve()`의 spender 디코딩, 무제한 승인과
  `setApprovalForAll` 전체 위임을 별도 critical로 강조.
- **Solana enrichment** — `getTransaction` pre/post 잔액 델타로 실제 금액·방향 보강.
- **주소별 룰 편집** — 규칙 토글과 임계값(네이티브/USD)을 주소마다 조정.

## 알림 규칙

| 규칙 | 발동 조건 |
|------|-----------|
| `balance_change` | 직전 스냅샷 대비 잔액 변동 (증가=info, 감소=warn) |
| `large_withdrawal` | 출금이 네이티브 임계값 **또는** USD 임계값 초과 (critical) |
| `new_transaction` | 처음 보는 트랜잭션 해시 (info) |
| `approval` | approve/setApprovalForAll 감지, 무제한·전체위임은 강조 (critical) |

첫 점검은 기준선 스냅샷만 저장합니다. 알림은 **두 번째 점검부터** 발생합니다.

## 스택

- Next.js 15 (App Router) · React 19 · TypeScript
- 외부 의존성 없는 JSON 파일 스토어 (`.data/`)
- vitest 단위 테스트 (66+)
- 체인: Etherscan V2 + JSON-RPC(EVM: Ethereum·BSC·Polygon·Arbitrum·Optimism·Base·
  **Xphere**), mempool.space(BTC), Solana RPC, TronGrid
  - Xphere(chain id 20250217, XP)는 Etherscan 미인덱싱이라 네이티브 잔액·잔액변동만
    지원하고 트랜잭션 기반 규칙은 degrade됩니다.
- 가격: CoinGecko

## 구조

```
src/lib/chains/      체인 어댑터 + 레지스트리 (공통 ChainAdapter 인터페이스)
src/lib/rules/       순수 알림 평가 엔진 + dedupKey + sanitizeRules
src/lib/store/       Store 인터페이스 + 파일 구현 (주소·스냅샷·알림 히스토리)
src/lib/prices/      CoinGecko USD 가격 (TTL 캐시)
src/lib/notify/      pluggable 알림 채널 + 채널별 심각도 라우팅
src/lib/scheduler/   백그라운드 폴링 스케줄러
src/lib/security/    approval spender 평판 (안전 라우터 / 블록리스트)
src/lib/webhooks/    실시간 webhook 검증·파싱·처리 (Alchemy·Helius)
src/lib/monitor.ts   오케스트레이터 (fetch → USD 보강 → evaluate → 영속 → 알림)
src/app/             대시보드 UI + API (/addresses, /check, /alerts, /scheduler, /webhooks/[provider])
```

## 시작

```bash
npm install
cp .env.example .env   # API 키 / RPC / 알림 채널 채우기 (전부 선택)
npm run dev            # http://localhost:3000
```

자동 모니터링은 UI의 "자동 모니터링" 섹션에서 시작하거나, `POLL_INTERVAL_SECONDS`를
설정하면 서버 기동 시 자동 시작합니다. 안정적 점검을 위해 `.env`에 신뢰할 수 있는
RPC(`ETHEREUM_RPC_URL` 등)와 `ETHERSCAN_API_KEY` 설정을 권장합니다.

## 환경 변수

| 변수 | 용도 |
|------|------|
| `ETHERSCAN_API_KEY` | EVM 트랜잭션 히스토리 + 토큰 잔액 (없으면 네이티브만) |
| `*_RPC_URL` | 체인별 커스텀 RPC (미설정 시 공개 RPC) |
| `SOLANA_RPC_URL` | Solana RPC (enrichment 레이트리밋 대비) |
| `TRON_PRO_API_KEY` | TronGrid 레이트리밋 상향 |
| `COINGECKO_API_KEY` / `COINGECKO_API_BASE` | 가격 API 키 / 베이스 |
| `POLL_INTERVAL_SECONDS` | 스케줄러 자동 시작 간격(초, 최소 15) |
| `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID` | Telegram 알림 |
| `DISCORD_WEBHOOK_URL` | Discord 알림 (https discord.com 호스트 검증) |
| `NOTIFY_CONSOLE` | `1`이면 콘솔로 알림 출력 |
| `{TELEGRAM,DISCORD,CONSOLE}_MIN_SEVERITY` | 채널별 최소 심각도 (info\|warn\|critical) |
| `MALICIOUS_SPENDERS` | 악성 spender 블록리스트 (쉼표 구분) |
| `ALCHEMY_WEBHOOK_SIGNING_KEY` | Alchemy 웹훅 서명 검증 → `POST /api/webhooks/alchemy` |
| `HELIUS_WEBHOOK_SECRET` | Helius 웹훅 시크릿 → `POST /api/webhooks/helius` |
| `WALLET_GOGO_DATA_FILE` | 스토어 파일 경로 (기본 `./.data/wallet-gogo.json`) |

## 검증

```bash
npm test          # vitest
npm run typecheck  # tsc --noEmit
npm run build      # next build
```
