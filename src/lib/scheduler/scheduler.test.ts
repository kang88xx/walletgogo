import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  clampInterval,
  computeNextRun,
  DEFAULT_INTERVAL_SECONDS,
  MIN_INTERVAL_SECONDS,
  Scheduler,
  type RunSummary,
} from './scheduler';

function summary(over: Partial<RunSummary> = {}): RunSummary {
  return {
    checkedAt: 1000,
    addresses: 1,
    ok: 1,
    failed: 0,
    alerts: 0,
    newAlerts: 0,
    ...over,
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('clampInterval', () => {
  it('enforces the minimum floor', () => {
    expect(clampInterval(1)).toBe(MIN_INTERVAL_SECONDS);
    expect(clampInterval(0)).toBe(MIN_INTERVAL_SECONDS);
    expect(clampInterval(-50)).toBe(MIN_INTERVAL_SECONDS);
  });
  it('passes through values above the floor (floored to int)', () => {
    expect(clampInterval(90.7)).toBe(90);
  });
  it('falls back to default on non-finite input', () => {
    expect(clampInterval(NaN)).toBe(DEFAULT_INTERVAL_SECONDS);
  });
});

describe('computeNextRun', () => {
  it('is null before the first run', () => {
    expect(computeNextRun(null, 60)).toBeNull();
  });
  it('adds the interval to the last run', () => {
    expect(computeNextRun(1000, 60)).toBe(1060);
  });
});

describe('Scheduler — no overlap guard', () => {
  it('skips a tick while a run is already in flight', async () => {
    let calls = 0;
    let gate: Promise<void> = Promise.resolve();
    const run = vi.fn(async () => {
      calls++;
      await gate; // block only while gate is pending
      return summary();
    });

    const s = new Scheduler(run);

    // Hold run #1 open so the scheduler stays in flight.
    let release!: () => void;
    gate = new Promise<void>((r) => {
      release = r;
    });
    const first = s.tick(); // starts run #1, stays in flight
    const second = await s.tick(); // should be skipped
    expect(second).toBeNull();
    expect(calls).toBe(1);
    expect(s.status().inFlight).toBe(true);

    release();
    await first;
    expect(s.status().inFlight).toBe(false);

    // Once free, a new (non-blocking) tick runs.
    gate = Promise.resolve();
    await s.tick();
    expect(calls).toBe(2);
  });

  it('captures run errors into status without throwing', async () => {
    const run = vi.fn(async () => {
      throw new Error('rpc down');
    });
    const s = new Scheduler(run);
    const res = await s.tick();
    expect(res).toBeNull();
    expect(s.status().lastError).toBe('rpc down');
    expect(s.status().inFlight).toBe(false);
  });

  it('records the last run summary and derives nextRunAt when running', async () => {
    const run = vi.fn(async () => summary({ checkedAt: 5000, newAlerts: 2 }));
    const s = new Scheduler(run);
    s.start(30);
    await s.tick();
    const st = s.status();
    expect(st.running).toBe(true);
    expect(st.lastRunSummary?.newAlerts).toBe(2);
    expect(st.lastRunAt).toBe(5000);
    expect(st.nextRunAt).toBe(5030);
    s.stop();
    expect(s.status().running).toBe(false);
  });
});
