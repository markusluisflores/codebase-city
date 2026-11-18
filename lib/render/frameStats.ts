/** Rolling frame-time statistics for the dev-only counter. */
export interface FrameSummary {
  frames: number;
  fps: number;
  /** Mean frame time in milliseconds. */
  meanMs: number;
  /** 99th-percentile frame time in milliseconds (the slowest 1% of frames). */
  p99Ms: number;
  worstMs: number;
}

export class FrameStats {
  private readonly times: number[] = [];

  constructor(private readonly capacity = 600) {}

  push(ms: number): void {
    if (!Number.isFinite(ms) || ms < 0) return;
    this.times.push(ms);
    if (this.times.length > this.capacity) this.times.shift();
  }

  reset(): void {
    this.times.length = 0;
  }

  summary(): FrameSummary {
    const n = this.times.length;
    if (n === 0) return { frames: 0, fps: 0, meanMs: 0, p99Ms: 0, worstMs: 0 };
    const sorted = [...this.times].sort((a, b) => a - b);
    const mean = this.times.reduce((s, t) => s + t, 0) / n;
    return {
      frames: n,
      fps: mean > 0 ? 1000 / mean : 0,
      meanMs: mean,
      p99Ms: sorted[Math.min(n - 1, Math.floor(n * 0.99))]!,
      worstMs: sorted[n - 1]!,
    };
  }
}
