// In-process request metrics.
//
// A lightweight ring buffer of recent request latencies plus running
// counters, read by the /health endpoint so an operator sees liveness
// detail without a round-trip to the logging backend.
//
// This is process-local: each Cloud Run instance reports its own slice.
// Cross-instance aggregation is the dashboard's job (Stream 2C.3), not
// this module's. The ring buffer is bounded, so memory is constant.

const LATENCY_RING_SIZE = 500;

export interface LatencyStats {
  count: number;
  p50_ms: number | null;
  p95_ms: number | null;
  p99_ms: number | null;
  max_ms: number | null;
}

export interface MetricsSnapshot {
  started_at: string;
  uptime_s: number;
  total_requests: number;
  total_errors: number;
  error_rate: number;
  last_successful_call: string | null;
  latency: LatencyStats;
  tool_calls: Record<string, number>;
}

class Metrics {
  private readonly startedAtMs = Date.now();
  private totalRequests = 0;
  private totalErrors = 0;
  private lastSuccessfulCallMs: number | null = null;
  private readonly latencies: number[] = [];
  private latencyCursor = 0;
  private readonly toolCalls = new Map<string, number>();

  /** Record one completed /mcp request. `ok` is false for a 5xx. */
  recordRequest(latencyMs: number, ok: boolean): void {
    this.totalRequests += 1;
    if (ok) {
      this.lastSuccessfulCallMs = Date.now();
    } else {
      this.totalErrors += 1;
    }
    if (this.latencies.length < LATENCY_RING_SIZE) {
      this.latencies.push(latencyMs);
    } else {
      this.latencies[this.latencyCursor] = latencyMs;
      this.latencyCursor = (this.latencyCursor + 1) % LATENCY_RING_SIZE;
    }
  }

  /** Record one tool invocation, keyed by tool name. */
  recordToolCall(tool: string): void {
    this.toolCalls.set(tool, (this.toolCalls.get(tool) ?? 0) + 1);
  }

  snapshot(): MetricsSnapshot {
    const now = Date.now();
    return {
      started_at: new Date(this.startedAtMs).toISOString(),
      uptime_s: Math.round((now - this.startedAtMs) / 1000),
      total_requests: this.totalRequests,
      total_errors: this.totalErrors,
      error_rate:
        this.totalRequests === 0
          ? 0
          : Number((this.totalErrors / this.totalRequests).toFixed(4)),
      last_successful_call:
        this.lastSuccessfulCallMs === null
          ? null
          : new Date(this.lastSuccessfulCallMs).toISOString(),
      latency: this.latencyStats(),
      tool_calls: Object.fromEntries(this.toolCalls),
    };
  }

  private latencyStats(): LatencyStats {
    const sorted = [...this.latencies].sort((a, b) => a - b);
    const n = sorted.length;
    const pct = (p: number): number | null => {
      if (n === 0) return null;
      const idx = Math.min(n - 1, Math.floor((p / 100) * n));
      return sorted[idx] ?? null;
    };
    return {
      count: n,
      p50_ms: pct(50),
      p95_ms: pct(95),
      p99_ms: pct(99),
      max_ms: n === 0 ? null : (sorted[n - 1] ?? null),
    };
  }

  /** Test seam. Not used by production code. */
  reset(): void {
    this.totalRequests = 0;
    this.totalErrors = 0;
    this.lastSuccessfulCallMs = null;
    this.latencies.length = 0;
    this.latencyCursor = 0;
    this.toolCalls.clear();
  }
}

export const metrics = new Metrics();
