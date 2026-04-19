// ─────────────────────────────────────────────────────────────────────────────
// Notifier — thin wrapper around Electron's Notification API with per-channel
// cooldown + user opt-out.
//
// Rationale:
//   • Silence beats spam. The agent syncs every 5 min by default; notifying
//     on every success would be miserable. We only notify on transitions
//     the user can act on: "sync failed", "sync restored", "queue dropped
//     a payload after N retries".
//   • Cooldown is per channel (e.g. "sync_fail") so a burst of failures
//     produces ONE notification, not ten.
//   • A `click` handler lets the user reopen the tray window from the
//     notification bubble to see the log detail.
//   • The enabled check is injected as a function so config changes at
//     runtime (user toggling "notifications" in settings) don't require
//     reconstructing the Notifier.
//
// IMPORTANT: this module is imported from `electron/main.ts`. We import
// Electron lazily so unit / smoke tests can exercise the cooldown + state
// logic without running inside an Electron host.
// ─────────────────────────────────────────────────────────────────────────────

export interface NotifyOptions {
  /** Treat as critical / urgent (shows longer, louder where supported). */
  urgent?: boolean;
  /** Override the channel cooldown for this single fire. */
  bypassCooldown?: boolean;
  /** Extra context logged alongside notify.fired / notify.skip events. */
  logCtx?: Record<string, unknown>;
}

export type LogFn = (msg: string, ctx?: Record<string, unknown>) => void;

export interface NotifierOptions {
  /** Default cooldown between fires per channel (default 15 min). */
  cooldownMs?: number;
  /** Called when the user clicks the OS notification (e.g. show window). */
  onClick?: () => void;
  /** Optional Electron Notification constructor — defaults to require('electron').Notification. */
  NotificationCtor?: any;
  /** Optional predicate — defaults to `Notification.isSupported()`. */
  isSupported?: () => boolean;
}

export class Notifier {
  private readonly lastFired = new Map<string, number>();
  private readonly cooldownMs: number;
  private readonly enabled: () => boolean;
  private readonly onClick?: () => void;
  private readonly NotificationCtor: any;
  private readonly isSupported: () => boolean;
  private log: LogFn = () => { /* no-op until wired up */ };

  constructor(enabled: () => boolean, opts: NotifierOptions = {}) {
    this.enabled = enabled;
    this.cooldownMs = Math.max(0, opts.cooldownMs ?? 15 * 60 * 1000);
    this.onClick = opts.onClick;
    // Lazy Electron import so tests can inject a mock.
    if (opts.NotificationCtor) {
      this.NotificationCtor = opts.NotificationCtor;
      this.isSupported = opts.isSupported ?? (() => true);
    } else {
      try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const electron = require('electron');
        this.NotificationCtor = electron.Notification;
        this.isSupported = () => Boolean(electron.Notification?.isSupported?.());
      } catch {
        this.NotificationCtor = null;
        this.isSupported = () => false;
      }
    }
  }

  /** Attach a logger callback so fire/skip events land in the rolling log. */
  setLogger(fn: LogFn): void { this.log = fn; }

  /**
   * Force the next notification on a given channel to fire regardless of
   * the cooldown. Typically used right after the user toggles notifications
   * back on, so the first interesting event isn't swallowed by the history.
   */
  resetCooldown(channel?: string): void {
    if (channel) this.lastFired.delete(channel);
    else this.lastFired.clear();
  }

  /**
   * Attempt to fire a notification on `channel`. Returns true if shown,
   * false if suppressed (disabled, unsupported, cooldown, platform error).
   * Never throws.
   */
  fire(channel: string, title: string, body: string, opts: NotifyOptions = {}): boolean {
    if (!this.enabled()) {
      this.log('notify.skip', { channel, reason: 'disabled', ...(opts.logCtx || {}) });
      return false;
    }
    if (!this.isSupported()) {
      this.log('notify.skip', { channel, reason: 'unsupported', ...(opts.logCtx || {}) });
      return false;
    }
    const now = Date.now();
    const last = this.lastFired.get(channel) ?? 0;
    const sinceMs = now - last;
    if (!opts.bypassCooldown && sinceMs < this.cooldownMs) {
      this.log('notify.skip', {
        channel, reason: 'cooldown', sinceMs, cooldownMs: this.cooldownMs,
        ...(opts.logCtx || {}),
      });
      return false;
    }
    try {
      const n = new this.NotificationCtor({
        title,
        body,
        urgency: opts.urgent ? 'critical' : 'normal',
        silent: false,
      });
      if (this.onClick) {
        try { n.on('click', this.onClick); } catch { /* older electron — ignore */ }
      }
      n.show();
      this.lastFired.set(channel, now);
      this.log('notify.fired', {
        channel, title, urgent: Boolean(opts.urgent), ...(opts.logCtx || {}),
      });
      return true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.log('notify.error', { channel, error: msg, ...(opts.logCtx || {}) });
      return false;
    }
  }
}
