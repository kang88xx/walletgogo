'use client';

import { useCallback, useEffect, useState } from 'react';
import { CHAIN_LIST } from '@/lib/chains';
import type { ChainId } from '@/lib/chains/types';
import type { CheckRunResult } from '@/lib/monitor';
import type { SchedulerStatus } from '@/lib/scheduler/scheduler';
import type { AlertRuleConfig } from '@/lib/rules/types';
import type { StoredAlert, WatchedAddress } from '@/lib/store/types';

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

function fmtUsd(n: number | undefined): string {
  if (typeof n !== 'number') return '—';
  return `$${n.toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
}

function fmtTime(unixSeconds: number): string {
  const d = new Date(unixSeconds * 1000);
  return d.toLocaleString();
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

  const [alerts, setAlerts] = useState<StoredAlert[]>([]);
  const [sched, setSched] = useState<SchedulerStatus | null>(null);
  const [interval, setIntervalSecs] = useState(60);

  const loadAddresses = useCallback(async () => {
    const res = await fetch('/api/addresses');
    const data = await res.json();
    setAddresses(data.addresses ?? []);
  }, []);

  const loadAlerts = useCallback(async () => {
    const res = await fetch('/api/alerts?limit=50');
    const data = await res.json();
    setAlerts(data.alerts ?? []);
  }, []);

  const loadSched = useCallback(async () => {
    const res = await fetch('/api/scheduler');
    const data = (await res.json()) as SchedulerStatus;
    setSched(data);
    if (data.intervalSeconds) setIntervalSecs(data.intervalSeconds);
  }, []);

  useEffect(() => {
    void (async () => {
      setLoading(true);
      try {
        await Promise.all([loadAddresses(), loadAlerts(), loadSched()]);
      } finally {
        setLoading(false);
      }
    })();
  }, [loadAddresses, loadAlerts, loadSched]);

  // Light client polling so the UI reflects background scheduler runs.
  useEffect(() => {
    const t = window.setInterval(() => {
      void loadAlerts();
      void loadSched();
    }, 15000);
    return () => window.clearInterval(t);
  }, [loadAlerts, loadSched]);

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

  async function handleSaveRules(id: string, rules: AlertRuleConfig) {
    const res = await fetch(`/api/addresses/${id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ rules }),
    });
    if (res.ok) await loadAddresses();
    return res.ok;
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
      await loadAlerts();
    } catch {
      setCheckError('네트워크 오류로 점검에 실패했습니다.');
    } finally {
      setChecking(false);
    }
  }

  async function schedulerAction(action: 'start' | 'stop' | 'runNow') {
    await fetch('/api/scheduler', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action, intervalSeconds: interval }),
    });
    await Promise.all([loadSched(), loadAlerts()]);
  }

  async function markAllRead() {
    await fetch('/api/alerts', { method: 'PATCH', body: JSON.stringify({}) });
    await loadAlerts();
  }

  const totalAlerts = run?.alerts.length ?? 0;
  const okCount = run?.results.filter((r) => r.ok).length ?? 0;
  const failCount = run?.results.filter((r) => !r.ok).length ?? 0;
  const unread = alerts.filter((a) => !a.read).length;
  const portfolio = run?.portfolioUsd;

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
        <section className="hero">
          <div className="eyebrow">System · v2.0 · On-chain Watch</div>
          <h1>멀티체인 지갑을 감시합니다</h1>
          <p className="lede">
            EVM · Solana · Bitcoin · Tron 주소의 잔액·트랜잭션을 자동으로 추적하고,
            대규모 출금과 무제한 승인(approval) 같은 드레이너 위험을 골라내 Telegram
            · Discord로 알립니다.
          </p>
          {typeof portfolio === 'number' && (
            <p className="portfolio" style={{ marginTop: 24 }}>
              추적 포트폴리오 가치 <b>{fmtUsd(portfolio)}</b>
            </p>
          )}
          <div className="meta-row">
            <span className="pill amber">Approval / Drainer Watch</span>
            <span className="pill">Large Withdrawal (USD)</span>
            <span className="pill">Balance Delta</span>
            <span className="pill">Auto Polling</span>
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

        {/* 02 — Scheduler */}
        <section className="section">
          <div className="section-head">
            <span className="numeral">02</span>
            <div className="titles">
              <div className="eyebrow">Automation · Polling</div>
              <h2>자동 모니터링</h2>
            </div>
            <div className="right-tag">Server-side</div>
          </div>
          <div className="card">
            <div className="sched">
              <div className="state">
                <span className={`dot ${sched?.running ? 'on' : 'off'}`} />
                {sched?.running ? '실행 중' : '중지됨'}
              </div>
              <div className="kv">
                간격 <b>{sched?.intervalSeconds ?? interval}s</b>
              </div>
              <div className="kv">
                마지막 실행{' '}
                <b>{sched?.lastRunAt ? fmtTime(sched.lastRunAt) : '없음'}</b>
              </div>
              <div className="kv">
                다음 실행{' '}
                <b>{sched?.nextRunAt ? fmtTime(sched.nextRunAt) : '—'}</b>
              </div>
              {sched?.lastRunSummary && (
                <div className="kv">
                  최근 결과{' '}
                  <b>
                    {sched.lastRunSummary.ok}/{sched.lastRunSummary.addresses} OK ·
                    {' '}
                    {sched.lastRunSummary.newAlerts} 신규알림
                  </b>
                </div>
              )}
              {sched?.lastError && (
                <div className="kv" style={{ color: '#c0395a' }}>
                  오류 <b style={{ color: '#c0395a' }}>{sched.lastError}</b>
                </div>
              )}
              <div className="controls">
                <input
                  type="number"
                  min={15}
                  value={interval}
                  onChange={(e) => setIntervalSecs(Number(e.target.value))}
                  aria-label="폴링 간격(초)"
                />
                {sched?.running ? (
                  <>
                    <button className="ghost" onClick={() => schedulerAction('start')}>
                      간격 적용
                    </button>
                    <button className="ghost" onClick={() => schedulerAction('stop')}>
                      중지
                    </button>
                  </>
                ) : (
                  <button onClick={() => schedulerAction('start')}>시작</button>
                )}
              </div>
            </div>
          </div>
        </section>

        {/* 03 — Watchlist */}
        <section className="section">
          <div className="section-head">
            <span className="numeral">03</span>
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
            <div className="addr-list">
              {addresses.map((a) => (
                <AddressRow
                  key={a.id}
                  address={a}
                  usdTotal={
                    run?.results.find((r) => r.addressId === a.id)?.usdTotal
                  }
                  onRemove={() => handleRemove(a.id)}
                  onSave={(rules) => handleSaveRules(a.id, rules)}
                />
              ))}
            </div>
          )}
        </section>

        {/* 04 — Check */}
        <section className="section">
          <div className="section-head">
            <span className="numeral">04</span>
            <div className="titles">
              <div className="eyebrow">Run · Snapshot & Evaluate</div>
              <h2>점검 결과</h2>
            </div>
            <div className="right-tag">On-demand</div>
          </div>
          <div className="toolbar">
            {run ? (
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
                <div className="stat">
                  <div className="figure">
                    {typeof portfolio === 'number' ? fmtUsd(portfolio) : '—'}
                  </div>
                  <div className="stat-label">Portfolio</div>
                </div>
              </div>
            ) : (
              <div className="spacer" />
            )}
            <button
              onClick={handleCheck}
              disabled={checking || addresses.length === 0}
            >
              {checking ? '점검 중…' : '지금 점검'}
            </button>
          </div>

          {checkError && <div className="error">{checkError}</div>}

          {run && (
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
                              .map(
                                (b) =>
                                  `${fmtAmount(b.amount)} ${b.asset}${
                                    typeof b.usdValue === 'number'
                                      ? ` (${fmtUsd(b.usdValue)})`
                                      : ''
                                  }`,
                              )
                              .join(' · ') || 'no balance'
                          }`
                      : `오류: ${r.error}`}
                  </span>
                </div>
              ))}
            </div>
          )}
        </section>

        {/* 05 — Alerts timeline */}
        <section className="section">
          <div className="section-head">
            <span className="numeral">05</span>
            <div className="titles">
              <div className="eyebrow">History · Alert Timeline</div>
              <h2>알림 기록</h2>
            </div>
            <div className="right-tag">{unread} UNREAD</div>
          </div>
          <div className="toolbar">
            <span className="muted">
              저장된 알림 {alerts.length}건 · 읽지 않음 {unread}건
            </span>
            <div className="spacer" />
            <button
              className="ghost"
              onClick={markAllRead}
              disabled={unread === 0}
            >
              모두 읽음
            </button>
          </div>
          {alerts.length === 0 ? (
            <div className="card">
              <p className="empty" style={{ padding: 0 }}>
                아직 발생한 알림이 없습니다. 점검 또는 자동 모니터링이 위험 신호를
                감지하면 여기에 쌓입니다.
              </p>
            </div>
          ) : (
            <div className="timeline">
              {alerts.map((a) => (
                <AlertTimelineItem key={a.id} alert={a} />
              ))}
            </div>
          )}
        </section>
      </main>
    </>
  );
}

function AddressRow({
  address,
  usdTotal,
  onRemove,
  onSave,
}: {
  address: WatchedAddress;
  usdTotal?: number;
  onRemove: () => void;
  onSave: (rules: AlertRuleConfig) => Promise<boolean>;
}) {
  const [open, setOpen] = useState(false);
  const [rules, setRules] = useState<AlertRuleConfig>(address.rules);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  async function save() {
    setSaving(true);
    setSaved(false);
    const ok = await onSave(rules);
    setSaving(false);
    if (ok) {
      setSaved(true);
      window.setTimeout(() => setSaved(false), 2000);
    }
  }

  return (
    <div className="addr-item" style={{ flexDirection: 'column', alignItems: 'stretch' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16 }}>
        <div className="addr-main">
          <span className="addr-label">{address.label}</span>
          <span className="tag">{CHAIN_LABEL[address.chainId] ?? address.chainId}</span>
          <span className="addr-addr">{shorten(address.address)}</span>
        </div>
        <div className="addr-actions">
          {typeof usdTotal === 'number' && (
            <span className="addr-usd">{fmtUsd(usdTotal)}</span>
          )}
          <button className="ghost" onClick={() => setOpen((o) => !o)}>
            {open ? '규칙 닫기' : '규칙 편집'}
          </button>
          <button className="danger" onClick={onRemove} aria-label={`${address.label} 삭제`}>
            삭제
          </button>
        </div>
      </div>

      {open && (
        <div className="rule-editor">
          <div className="toggle-row">
            <label className="toggle">
              <input
                type="checkbox"
                checked={rules.balanceChange}
                onChange={(e) =>
                  setRules({ ...rules, balanceChange: e.target.checked })
                }
              />
              잔액 변동
            </label>
            <label className="toggle">
              <input
                type="checkbox"
                checked={rules.newTransaction}
                onChange={(e) =>
                  setRules({ ...rules, newTransaction: e.target.checked })
                }
              />
              새 트랜잭션
            </label>
            <label className="toggle">
              <input
                type="checkbox"
                checked={rules.approval}
                onChange={(e) =>
                  setRules({ ...rules, approval: e.target.checked })
                }
              />
              승인(approval)
            </label>
            <label className="toggle">
              <input
                type="checkbox"
                checked={rules.largeWithdrawal.enabled}
                onChange={(e) =>
                  setRules({
                    ...rules,
                    largeWithdrawal: {
                      ...rules.largeWithdrawal,
                      enabled: e.target.checked,
                    },
                  })
                }
              />
              대규모 출금
            </label>
          </div>

          {rules.largeWithdrawal.enabled && (
            <div className="threshold-row">
              <div className="field">
                <label>네이티브 임계값</label>
                <input
                  type="number"
                  min={0}
                  step="any"
                  value={rules.largeWithdrawal.threshold}
                  onChange={(e) =>
                    setRules({
                      ...rules,
                      largeWithdrawal: {
                        ...rules.largeWithdrawal,
                        threshold: Number(e.target.value),
                      },
                    })
                  }
                />
              </div>
              <div className="field">
                <label>USD 임계값 (선택)</label>
                <input
                  type="number"
                  min={0}
                  step="any"
                  placeholder="예: 10000"
                  value={rules.largeWithdrawal.usdThreshold ?? ''}
                  onChange={(e) => {
                    const v = e.target.value;
                    setRules({
                      ...rules,
                      largeWithdrawal: {
                        ...rules.largeWithdrawal,
                        usdThreshold: v === '' ? undefined : Number(v),
                      },
                    });
                  }}
                />
              </div>
            </div>
          )}

          <div className="actions">
            <button onClick={save} disabled={saving}>
              {saving ? '저장 중…' : '규칙 저장'}
            </button>
            {saved && <span className="saved-tick">✓ 저장됨</span>}
          </div>
        </div>
      )}
    </div>
  );
}

function AlertTimelineItem({ alert }: { alert: StoredAlert }) {
  return (
    <div className={`tl-item ${alert.read ? '' : 'unread'}`}>
      <div className="tl-rail">
        <span className={`tl-dot ${alert.severity}`} />
      </div>
      <div className="tl-body">
        <div className="tl-head">
          <span className={`sev-badge ${alert.severity}`}>{alert.severity}</span>
          <span className="tl-title">{alert.title}</span>
          <span className="tl-time">{fmtTime(alert.firedAt)}</span>
        </div>
        <div className="tl-msg">{alert.message}</div>
        <div className="tl-meta">
          {CHAIN_LABEL[alert.chainId] ?? alert.chainId} · {shorten(alert.address)}
          {alert.tx ? ` · ${alert.tx.hash.slice(0, 16)}…` : ''}
        </div>
      </div>
    </div>
  );
}
