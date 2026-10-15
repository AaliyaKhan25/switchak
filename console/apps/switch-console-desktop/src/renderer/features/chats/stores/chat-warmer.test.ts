import { describe, expect, it, vi } from 'vitest';
import { createChatWarmer, WARM_INTERVAL_MS } from './chat-warmer';

vi.mock('@renderer/utils/logger', () => ({ log: { warn: vi.fn() } }));

describe('createChatWarmer', () => {
  it('asks once per chat per interval, and not while an ask is under way', async () => {
    let clock = 0;
    let finish!: () => void;
    const warm = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        })
    );
    const warmChat = createChatWarmer(warm, () => clock);

    const first = warmChat('s', 'a', 'room');
    void warmChat('s', 'a', 'room');
    clock = WARM_INTERVAL_MS + 1;
    void warmChat('s', 'a', 'room');
    expect(warm).toHaveBeenCalledTimes(1);
    finish();
    await first;

    clock = WARM_INTERVAL_MS - 1;
    await warmChat('s', 'a', 'room');
    expect(warm).toHaveBeenCalledTimes(1);
    void warmChat('s', 'a', 'other-room');
    expect(warm).toHaveBeenCalledTimes(2);
    finish();

    clock = WARM_INTERVAL_MS;
    void warmChat('s', 'a', 'room');
    expect(warm).toHaveBeenCalledTimes(3);
    finish();
  });

  it('swallows a failed ask and asks again after the interval', async () => {
    let clock = 0;
    const warm = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue(undefined);
    const warmChat = createChatWarmer(warm, () => clock);
    await warmChat('s', 'a', 'room');
    await warmChat('s', 'a', 'room');
    expect(warm).toHaveBeenCalledTimes(1);
    clock = WARM_INTERVAL_MS;
    await warmChat('s', 'a', 'room');
    expect(warm).toHaveBeenCalledTimes(2);
  });
});
