/** Per-process abuse protection; deployments with multiple APIs need a shared limiter. */
export function fixedWindowLimiter(maxBuckets = 10_000) {
  const windows = new Map<string, { count: number; resetAt: number }>();
  let nextSweep = 0;
  return (key: string, maximum: number, now: number): number => {
    if (now >= nextSweep) {
      for (const [id, window] of windows) if (window.resetAt <= now) windows.delete(id);
      nextSweep = now + 1_000;
    }
    let window = windows.get(key);
    if (!window || window.resetAt <= now) {
      // Never evict a live window: rotating identities must not reset another limit.
      if (!window && windows.size >= maxBuckets) return 60;
      window = { count: 0, resetAt: now + 60_000 };
      windows.set(key, window);
    }
    window.count = Math.min(window.count + 1, maximum + 1);
    return window.count > maximum ? Math.ceil((window.resetAt - now) / 1_000) : 0;
  };
}
