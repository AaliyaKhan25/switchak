import { makeAutoObservable } from 'mobx';

/** How long a chat New chat reused stands out, so the click visibly did something. */
export const REUSE_FLASH_MS = 1_500;

/**
 * The chat New chat just reused instead of making another: the same empty chat
 * is shown again, often the one already open, and without a sign the click
 * looks like it did nothing.
 */
export class ReuseFlash {
  roomId: string | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    makeAutoObservable<ReuseFlash, 'timer'>(this, { timer: false });
  }

  flash(roomId: string): void {
    this.roomId = roomId;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.clear(roomId), REUSE_FLASH_MS);
  }

  private clear(roomId: string): void {
    if (this.roomId === roomId) this.roomId = null;
    this.timer = null;
  }
}

export const reuseFlash = new ReuseFlash();
