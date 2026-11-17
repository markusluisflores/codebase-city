import { describe, expect, it } from 'vitest';
import { FrameStats } from '@/lib/render/frameStats';

describe('FrameStats', () => {
  it('is all zero when empty', () => {
    expect(new FrameStats().summary()).toEqual({
      frames: 0,
      fps: 0,
      meanMs: 0,
      p99Ms: 0,
      worstMs: 0,
    });
  });

  it('reports fps from the mean frame time and the worst frame', () => {
    const s = new FrameStats();
    for (let i = 0; i < 99; i++) s.push(10);
    s.push(50);
    const r = s.summary();
    expect(r.frames).toBe(100);
    expect(r.meanMs).toBeCloseTo(10.4);
    expect(r.fps).toBeCloseTo(1000 / 10.4);
    expect(r.worstMs).toBe(50);
    expect(r.p99Ms).toBe(50);
  });

  it('keeps only the newest frames and ignores bad values', () => {
    const s = new FrameStats(3);
    [1, 2, 3, 4, Number.NaN, -1].forEach((t) => s.push(t));
    expect(s.summary().frames).toBe(3);
    expect(s.summary().worstMs).toBe(4);
  });
});
