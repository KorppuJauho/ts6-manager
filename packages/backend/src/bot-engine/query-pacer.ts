/**
 * TeamSpeak 6's ServerQuery flood limit, as its defaults ship:
 * serverinstance_serverquery_flood_commands=10 per flood_time=3 s. It is
 * counted per IP across every query connection — each SSH session and the
 * manager's WebQuery calls alike — and going over it earns error 524, then a
 * serverquery_ban_time=600 s ban that drops every new SSH handshake.
 *
 * The SSH sessions get half of that budget so the WebQuery side, which the
 * UI drives and nothing paces, keeps room.
 */
export const SSH_COMMANDS_PER_WINDOW = 5;
export const FLOOD_WINDOW_MS = 3000;

/**
 * Spaces the ServerQuery commands of every SSH session to one server so that
 * together they stay under the flood limit. Registering a session's events
 * is seven commands and a command listener's five; opened together, as a
 * restart does, they alone used to exceed ten in a second.
 */
export class QueryPacer {
  private sentAt: number[] = [];
  private turn: Promise<void> = Promise.resolve();

  constructor(
    private readonly maxCommands: number = SSH_COMMANDS_PER_WINDOW,
    private readonly windowMs: number = FLOOD_WINDOW_MS,
  ) {}

  /** Resolves when one more command may be sent; callers are served in order. */
  take(): Promise<void> {
    const slot = this.turn.then(() => this.waitForSlot());
    this.turn = slot;
    return slot;
  }

  private async waitForSlot(): Promise<void> {
    for (;;) {
      const now = Date.now();
      this.sentAt = this.sentAt.filter((t) => now - t < this.windowMs);
      if (this.sentAt.length < this.maxCommands) {
        this.sentAt.push(now);
        return;
      }
      await new Promise((r) => setTimeout(r, this.windowMs - (now - this.sentAt[0])));
    }
  }
}
