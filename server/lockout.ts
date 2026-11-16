import { readFileSync, renameSync, writeFileSync } from 'node:fs';

const FIRST_WAIT = 60_000,
  MAX_WAIT = 3_600_000;

// Sign-in failures: the 5th starts a one-minute wait and each later one doubles it, up to an hour.
export class Lockout {
  private failures = 0;
  private retryAt = 0;
  constructor(
    private readonly file?: string,
    private readonly now: () => number = Date.now,
  ) {
    if (!file) return;
    try {
      const saved = JSON.parse(readFileSync(file, 'utf8'));
      if (
        Number.isInteger(saved?.failures) &&
        saved.failures >= 0 &&
        Number.isFinite(saved.retryAt)
      ) {
        this.failures = saved.failures;
        // A clock set back must not leave the owner locked out for longer than an hour.
        this.retryAt = Math.min(saved.retryAt, this.now() + MAX_WAIT);
      }
    } catch {
      // Missing or damaged: start clean.
    }
  }
  waitMs() {
    const now = this.now();
    // A clock stepped back during a wait: cut the end time too, so the wait still ends.
    if (this.retryAt - now > MAX_WAIT) this.retryAt = now + MAX_WAIT;
    return Math.max(0, this.retryAt - now);
  }
  fail() {
    this.failures++;
    if (this.failures >= 5)
      this.retryAt = this.now() + Math.min(MAX_WAIT, FIRST_WAIT * 2 ** (this.failures - 5));
    this.save();
  }
  succeed() {
    this.failures = 0;
    this.retryAt = 0;
    this.save();
  }
  private save() {
    if (!this.file) return;
    try {
      const temp = `${this.file}.tmp`;
      writeFileSync(temp, JSON.stringify({ failures: this.failures, retryAt: this.retryAt }), {
        mode: 0o600,
      });
      renameSync(temp, this.file);
    } catch {
      // The state stays in memory; a full disk must not turn into a sign-in error.
    }
  }
}
