import { runCheck, type CheckRunResult } from '@/lib/monitor';
import { getStore } from '@/lib/store';

/** Floor on the poll interval to avoid hammering external APIs / rate limits. */
export const MIN_INTERVAL_SECONDS = 15;
export const DEFAULT_INTERVAL_SECONDS = 60;

export function clampInterval(seconds: number): number {
  if (!Number.isFinite(seconds)) return DEFAULT_INTERVAL_SECONDS;
  return Math.max(MIN_INTERVAL_SECONDS, Math.floor(seconds));
}

export function computeNextRun(
  lastRunAt: number | null,
  intervalSeconds: number,
): number | null {
  if (lastRunAt == null) return null;
  return lastRunAt + intervalSeconds;
}

export interface RunSummary {
  checkedAt: number;
  addresses: number;
  ok: number;
  failed: number;
  alerts: number;
  newAlerts: number;
}

export interface SchedulerStatus {
  running: boolean;
  intervalSeconds: number;
  lastRunAt: number | null;
  nextRunAt: number | null;
  lastRunSummary: RunSummary | null;
  lastError: string | null;
  inFlight: boolean;
}

function summarize(result: CheckRunResult): RunSummary {
  return {
    checkedAt: result.checkedAt,
    addresses: result.results.length,
    ok: result.results.filter((r) => r.ok).length,
    failed: result.results.filter((r) => !r.ok).length,
    alerts: result.alerts.length,
    newAlerts: result.newAlerts.length,
  };
}

export type RunFn = () => Promise<RunSummary>;

const defaultRun: RunFn = async () => summarize(await runCheck(getStore()));

/**
 * A single-instance polling scheduler. One run never overlaps another (a tick
 * fired while a run is in flight is skipped), and a run's failure is captured
 * into status without stopping the loop.
 */
export class Scheduler {
  private timer: ReturnType<typeof setInterval> | null = null;
  private intervalSeconds = DEFAULT_INTERVAL_SECONDS;
  private inFlight = false;
  private lastRunAt: number | null = null;
  private lastRunSummary: RunSummary | null = null;
  private lastError: string | null = null;

  constructor(private readonly run: RunFn = defaultRun) {}

  /** Start (or restart with a new interval). Idempotent for the same interval. */
  start(intervalSeconds: number = this.intervalSeconds): void {
    const next = clampInterval(intervalSeconds);
    if (this.timer && next === this.intervalSeconds) return;
    this.intervalSeconds = next;
    if (this.timer) clearInterval(this.timer);
    this.timer = setInterval(() => {
      void this.tick();
    }, this.intervalSeconds * 1000);
    // setInterval keeps the event loop alive; in a server that's fine, but we
    // don't want it to block process exit in tooling contexts.
    if (typeof this.timer === 'object' && this.timer && 'unref' in this.timer) {
      (this.timer as { unref?: () => void }).unref?.();
    }
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Run one cycle now, respecting the no-overlap guard. */
  async tick(): Promise<RunSummary | null> {
    if (this.inFlight) return null; // skip — a run is already in progress
    this.inFlight = true;
    try {
      const summary = await this.run();
      this.lastRunSummary = summary;
      this.lastRunAt = summary.checkedAt;
      this.lastError = null;
      return summary;
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err);
      return null;
    } finally {
      this.inFlight = false;
    }
  }

  status(): SchedulerStatus {
    return {
      running: this.timer !== null,
      intervalSeconds: this.intervalSeconds,
      lastRunAt: this.lastRunAt,
      nextRunAt: this.timer
        ? computeNextRun(this.lastRunAt, this.intervalSeconds)
        : null,
      lastRunSummary: this.lastRunSummary,
      lastError: this.lastError,
      inFlight: this.inFlight,
    };
  }
}

// Global singleton so the scheduler survives Next dev hot-reloads and is shared
// across API routes.
const g = globalThis as unknown as { __walletGogoScheduler?: Scheduler };

export function getScheduler(): Scheduler {
  if (!g.__walletGogoScheduler) {
    g.__walletGogoScheduler = new Scheduler();
    // Auto-start when an interval is configured via env (opt-in monitoring).
    // Skip on Vercel/serverless: setInterval can't survive between invocations
    // there — Vercel Cron (/api/cron) is the polling mechanism instead.
    const envInterval = process.env.POLL_INTERVAL_SECONDS;
    if (envInterval && !process.env.VERCEL) {
      g.__walletGogoScheduler.start(clampInterval(Number(envInterval)));
    }
  }
  return g.__walletGogoScheduler;
}
