import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cachedProbe } from './cachedProbe.js';

describe('cachedProbe', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('reuses the last result for calls within the TTL, without re-running the probe', async () => {
    const probe = vi.fn().mockResolvedValue(true);
    const wrapped = cachedProbe(probe, 5_000);

    expect(await wrapped()).toBe(true);
    vi.advanceTimersByTime(4_999);
    expect(await wrapped()).toBe(true);
    expect(probe).toHaveBeenCalledTimes(1);
  });

  it('re-runs the probe once the TTL has elapsed', async () => {
    const probe = vi.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    const wrapped = cachedProbe(probe, 5_000);

    expect(await wrapped()).toBe(true);
    vi.advanceTimersByTime(5_000);
    expect(await wrapped()).toBe(false);
    expect(probe).toHaveBeenCalledTimes(2);
  });

  it('coalesces concurrent calls into a single in-flight probe invocation', async () => {
    let resolveProbe!: (value: boolean) => void;
    const probe = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          resolveProbe = resolve;
        }),
    );
    const wrapped = cachedProbe(probe, 5_000);

    const first = wrapped();
    const second = wrapped();
    const third = wrapped();
    resolveProbe(true);

    expect(await Promise.all([first, second, third])).toEqual([true, true, true]);
    expect(probe).toHaveBeenCalledTimes(1);
  });

  it('caches a rejected probe as false rather than retrying on every call until the TTL elapses', async () => {
    const probe = vi.fn().mockRejectedValueOnce(new Error('connection refused'));
    const wrapped = cachedProbe(probe, 5_000);

    expect(await wrapped()).toBe(false);
    expect(await wrapped()).toBe(false);
    expect(probe).toHaveBeenCalledTimes(1);
  });
});
