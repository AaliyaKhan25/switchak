import { afterEach, describe, expect, it, vi } from 'vitest';
import { REUSE_FLASH_MS, ReuseFlash } from './reuse-flash';

afterEach(() => vi.useRealTimers());

describe('ReuseFlash', () => {
  it('marks the reused chat for a moment, the latest one only', () => {
    vi.useFakeTimers();
    const flash = new ReuseFlash();
    flash.flash('r1');
    expect(flash.roomId).toBe('r1');
    vi.advanceTimersByTime(REUSE_FLASH_MS / 2);
    flash.flash('r2');
    vi.advanceTimersByTime(REUSE_FLASH_MS / 2);
    expect(flash.roomId).toBe('r2');
    vi.advanceTimersByTime(REUSE_FLASH_MS);
    expect(flash.roomId).toBeNull();
  });
});
