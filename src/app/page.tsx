'use client';

import { useCallback, useEffect, useState } from 'react';
import { CHAIN_LIST } from '@/lib/chains';
import type { ChainId } from '@/lib/chains/types';
import type { CheckRunResult } from '@/lib/monitor';
import type { Alert } from '@/lib/rules/types';
import type { WatchedAddress } from '@/lib/store/types';

const CHAIN_LABEL: Record<string, string> = Object.fromEntries(
  CHAIN_LIST.map((c) => [c.id, c.label]),
);

function shorten(addr: string): string {
  return addr.length > 18 ? `${addr.slice(0, 8)}…${addr.slice(-6)}` : addr;
}

function fmtAmount(n: number): string {
  if (n === 0) return '0';
  if (Math.abs(n) < 0.0001) return n.toExponential(2);
  return Number(n.toFixed(6)).toString();
}

export default function Home() {
  const [addresses, setAddresses] = useState<WatchedAddress[]>([]);
  const [loading, setLoading] = useState(true);

  const [label, setLabel] = useState('');
  const [address, setAddress] = useState('');
  const [chainId, setChainId] = useState<ChainId>('ethereum');
  const [adding, setAdding] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const [checking, setChecking] = useState(false);
  const [run, setRun] = useState<CheckRunResult | null>(null);
  const [checkError, setCheckError] = useState<string | null>(null);

  const loadAddresses = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/addresses');
      const data = await res.json();
      setAddresses(data.addresses ?? []);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadAddresses();
  }, [loadAddresses]);

  async function handleAdd(e: React.FormEvent) {
    e.preventDefault();
    setFormError(null);
    setAdding(true);
    try {
      const res = await fetch('/api/addresses', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ label, address, chainId }),
      });
      const data = await res.json();
      if (!res.ok) {
        setFormError(data.error ?? '주소를 추가하지 못했습니다.');
        return;
      }
      setLabel('');
      setAddress('');
      await loadAddresses();
    } catch {
      setFormError('네트워크 오류로 주소를 추가하지 못했습니다.');
    } finally {
      setAdding(false);
    }
  }

  async function handleRemove(id: string) {
    await fetch(`/api/addresses/${id}`, { method: 'DELETE' });
    await loadAddresses();
  }

  async function handleCheck() {
    setChecking(true);
    setCheckError(null);
    try {
      const res = await fetch('/api/check', { method: 'POST' });
      const data = await res.json();
      if (!res.ok) {
        setCheckError(data.error ?? '점검에 실패했습니다.');
        return;
      }
      setRun(data as CheckRunResult);
    } catch {
      setCheckError('네트워크 오류로 점검에 실패했습니다.');
    } finally {
      setChecking(false);
    }
  }

  const totalAlerts = run?.alerts.length ?? 0;
  const okCount = run?.results.filter((r) => r.ok).length ?? 0;
  const failCount = run?.results.filter((r) => !r.ok).length ?? 0;

  return (
    <>
      <header className="rail">
        <div className="left">
          <span className="dot" />
          WALLET-GOGO · MONITOR
        </div>
        <div className="center">MULTI-CHAIN · BALANCE · TX · ALERTS</div>
        <div className="right">EVM · SOL · BTC · TRON</div>
      </header>

      <main className="shell">
        {/* Hero / statement */}
        <section className="hero">
          <div className="eyebrow">System · v2.0 · On-chain Watch</div>
          <h1>멀티체인 지갑을 감시합니다</h1>
          <p className="lede">
            EVM · Solana · Bitcoin · Tron 주소의 잔액 변동과 트랜잭션을 추적하고,
            대규모 출금과 승인(approval) 같은 위험 신호를 골라냅니다. 첫 점검은
            기준선만 저장하고, 알림은 두 번째 점검부터 발생합니다.
          </p>
          <div className="meta-row">
            <span className="pill amber">Approval Watch</span>
            <span className="pill">Large Withdrawal</span>
            <span className="pill">Balance Delta</span>
            <span className="pill">New Transaction</span>
          </div>
        </section>

        {/* 01 — Add address */}
        <section className="section">
          <div className="section-head">
            <span className="numeral">01</span>
            <div className="titles">
              <div className="eyebrow">Watchlist · Add</div>
              <h2>주소 추가</h2>
            </div>
            <div className="right-tag">EVM · SOL · BTC · TRON</div>
          </div>

          <div className="card">
            <form onSubmit={handleAdd}>
              <div className="form-row">
                <div className="field">
                  <label htmlFor="label">Label</label>
                  <input
                    id="label"
                    value={label}
                    onChange={(e) => setLabel(e.target.value)}
                    placeholder="콜드 월렛"
                    required
                  />
                </div>
                <div className="field grow">
                  <label htmlFor="address">Address</label>
                  <input
                    id="address"
                    value={address}
                    onChange={(e) => setAddress(e.target.value)}
                    placeholder="0x… / bc1… / T… / Solana 주소"
                    required
                  />
                </div>
                <div className="field">
                  <label htmlFor="chain">Chain</label>
                  <select
                    id="chain"
                    value={chainId}
                    onChange={(e) => setChainId(e.target.value as ChainId)}
                  >
                    {CHAIN_LIST.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.label}
                      </option>
                    ))}
                  </select>
                </div>
                <button type="submit" disabled={adding}>
                  {adding ? '추가 중…' : '추가'}
                </button>
              </div>
              {formError && <div className="error">{formError}</div>}
            </form>
          </div>
        </section>

        {/* 02 — Watchlist */}
        <section className="section">
          <div className="section-head">
            <span className="numeral">02</span>
            <div className="titles">
              <div className="eyebrow">Watchlist · Addresses</div>
              <h2>감시 중인 주소</h2>
            </div>
            <div className="right-tag">{addresses.length} TRACKED</div>
          </div>

          {loading ? (
            <p className="empty">불러오는 중…</p>
          ) : addresses.length === 0 ? (
            <p className="empty">
              아직 감시 중인 주소가 없습니다. 위에서 첫 주소를 추가하세요.
            </p>
          ) : (
            <ul className="addr-list">
              {addresses.map((a) => (
                <li key={a.id} className="addr-item">
                  <div className="addr-main">
                    <span className="addr-label">{a.label}</span>
                    <span className="tag">
                      {CHAIN_LABEL[a.chainId] ?? a.chainId}
                    </span>
                    <span className="addr-addr">{shorten(a.address)}</span>
                  </div>
                  <button
                    className="danger"
                    onClick={() => handleRemove(a.id)}
                    aria-label={`${a.label} 삭제`}
                  >
                    삭제
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>

        {/* 03 — Check */}
        <section className="section">
          <div className="section-head">
            <span className="numeral">03</span>
            <div className="titles">
              <div className="eyebrow">Run · Snapshot & Evaluate</div>
              <h2>점검 결과</h2>
            </div>
            <div className="right-tag">On-demand</div>
          </div>

          <div className="toolbar">
            {run && (
              <div className="stat-grid" style={{ flex: 1 }}>
                <div className="stat">
                  <div className="figure">{totalAlerts}</div>
                  <div className="stat-label">Alerts</div>
                </div>
                <div className="stat">
                  <div className="figure">{okCount}</div>
                  <div className="stat-label">OK</div>
                </div>
                <div className="stat">
                  <div className="figure">{failCount}</div>
                  <div className="stat-label">Failed</div>
                </div>
              </div>
            )}
            {!run && <div className="spacer" />}
            <button
              onClick={handleCheck}
              disabled={checking || addresses.length === 0}
            >
              {checking ? '점검 중…' : '지금 점검'}
            </button>
          </div>

          {checkError && <div className="error">{checkError}</div>}

          {!run && !checkError && (
            <div className="card">
              <p className="empty" style={{ padding: 0 }}>
                “지금 점검”을 눌러 모든 주소의 최신 상태를 가져옵니다. 첫 점검은
                기준선만 저장하며, 알림은 두 번째 점검부터 발생합니다.
              </p>
            </div>
          )}

          {run && (
            <>
              {totalAlerts === 0 ? (
                <div className="card">
                  <p className="empty" style={{ padding: 0 }}>
                    새 알림이 없습니다. 모든 주소가 조용합니다.
                  </p>
                </div>
              ) : (
                <div className="alerts">
                  {run.alerts.map((alert, i) => (
                    <AlertCard key={i} alert={alert} />
                  ))}
                </div>
              )}

              <div className="results">
                {run.results.map((r) => (
                  <div className="result-line" key={r.addressId}>
                    <span className={`r-status ${r.ok ? 'ok' : 'fail'}`} />
                    <span className="r-label">{r.label}</span>
                    <span className="r-detail">
                      {r.ok
                        ? r.baseline
                          ? '기준선 저장됨'
                          : `${r.alerts.length} alerts · ${
                              r.balances
                                .map((b) => `${fmtAmount(b.amount)} ${b.asset}`)
                                .join(' · ') || 'no balance'
                            }`
                        : `오류: ${r.error}`}
                    </span>
                  </div>
                ))}
              </div>
            </>
          )}
        </section>
      </main>
    </>
  );
}

function AlertCard({ alert }: { alert: Alert }) {
  return (
    <div className={`alert ${alert.severity}`}>
      <div className="alert-title">
        <span className={`sev-badge ${alert.severity}`}>{alert.severity}</span>
        {alert.title}
      </div>
      <div className="alert-msg">{alert.message}</div>
      <div className="alert-meta">
        {CHAIN_LABEL[alert.chainId] ?? alert.chainId} · {shorten(alert.address)}
        {alert.tx ? ` · ${alert.tx.hash.slice(0, 16)}…` : ''}
      </div>
    </div>
  );
}
