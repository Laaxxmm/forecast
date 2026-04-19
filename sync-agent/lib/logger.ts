// ─────────────────────────────────────────────────────────────────────────────
// Logger — append-only, size-rotating, NDJSON file log.
//
// Goals:
//   • One log file per agent install, capped to a few MB on disk, so we don't
//     bloat %APPDATA% on long-running installs.
//   • Structured lines (JSON per line) so grep / jq / future UI can parse.
//   • Resilient: a disk full or permission error must NEVER propagate to the
//     sync pipeline. Worst case we lose log lines; the sync keeps working.
//   • Simple API: logger.info("message", { ctx }).
//
// File layout at userData/logs/:
//   agent.log          ← active file (always appended to)
//   agent.log.1        ← most recent rotation
//   agent.log.2        ← ...
//   agent.log.5        ← oldest kept rotation (deleted when a 6th rotation fires)
//
// Rotation trigger: after each write, if the active file exceeds maxBytes,
// shift every rotated file down by one and rename the active file to .1.
// A new empty active file is created on the next write.
// ─────────────────────────────────────────────────────────────────────────────

import * as fs from 'node:fs';
import * as path from 'node:path';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LoggerOptions {
  /** Directory to write logs into. Created on first use if missing. */
  dir: string;
  /** Base filename (default: 'agent.log'). Rotations append '.1', '.2', ... */
  fileName?: string;
  /** Bytes at which to rotate the active file (default: 1_048_576 = 1 MB). */
  maxBytes?: number;
  /** Max rotated files to keep (default: 5). Oldest beyond this are deleted. */
  maxFiles?: number;
  /** Also mirror to console (default: true in dev / undefined in prod). */
  mirrorConsole?: boolean;
  /** Minimum level to record (default: 'info'). */
  minLevel?: LogLevel;
}

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

export class Logger {
  private readonly dir: string;
  private readonly fileName: string;
  private readonly maxBytes: number;
  private readonly maxFiles: number;
  private readonly mirrorConsole: boolean;
  private readonly minLevelN: number;

  constructor(opts: LoggerOptions) {
    this.dir = opts.dir;
    this.fileName = opts.fileName ?? 'agent.log';
    this.maxBytes = Math.max(64 * 1024, opts.maxBytes ?? 1_048_576);
    this.maxFiles = Math.max(1, opts.maxFiles ?? 5);
    this.mirrorConsole = opts.mirrorConsole ?? true;
    this.minLevelN = LEVEL_ORDER[opts.minLevel ?? 'info'];
  }

  /** Absolute path to the active log file. */
  activePath(): string {
    return path.join(this.dir, this.fileName);
  }

  /** Absolute path to a rotated file by index (1..maxFiles). */
  rotatedPath(i: number): string {
    return path.join(this.dir, `${this.fileName}.${i}`);
  }

  debug(msg: string, ctx?: Record<string, unknown>): void { this.write('debug', msg, ctx); }
  info (msg: string, ctx?: Record<string, unknown>): void { this.write('info',  msg, ctx); }
  warn (msg: string, ctx?: Record<string, unknown>): void { this.write('warn',  msg, ctx); }
  error(msg: string, ctx?: Record<string, unknown>): void { this.write('error', msg, ctx); }

  /**
   * Return up to `n` of the most-recent parseable log entries, newest-last.
   * Walks backward from the end of the file so malformed lines don't shrink
   * the result — if line N-1 is garbage, we fall further back to find a
   * valid one. Never throws; on any filesystem failure returns [].
   */
  tail(n: number): Array<Record<string, unknown>> {
    try {
      const raw = fs.readFileSync(this.activePath(), 'utf8');
      const lines = raw.split('\n').filter((l) => l.trim().length > 0);
      const collected: Array<Record<string, unknown>> = [];
      for (let i = lines.length - 1; i >= 0 && collected.length < n; i -= 1) {
        try { collected.push(JSON.parse(lines[i])); } catch { /* skip malformed */ }
      }
      return collected.reverse(); // newest-last
    } catch {
      return [];
    }
  }

  // ── Internals ────────────────────────────────────────────────────────────

  private write(level: LogLevel, msg: string, ctx?: Record<string, unknown>): void {
    if (LEVEL_ORDER[level] < this.minLevelN) return;

    // Shape: {ts, level, msg, ...ctx}. ctx last so message-level keys can't
    // overwrite our canonical fields, and ctx can include nested objects.
    const rec: Record<string, unknown> = {
      ts: new Date().toISOString(),
      level,
      msg,
      ...(ctx || {}),
    };

    let line: string;
    try {
      line = JSON.stringify(rec) + '\n';
    } catch {
      // Circular ref or BigInt in ctx — fall back to a safe stringify.
      line = JSON.stringify({
        ts: rec.ts, level, msg,
        ctxError: 'unserializable context',
      }) + '\n';
    }

    if (this.mirrorConsole) {
      // eslint-disable-next-line no-console
      const out = level === 'error' || level === 'warn' ? console.error : console.log;
      try { out.call(console, `[${level}]`, msg, ctx ?? ''); } catch { /* ignore */ }
    }

    try {
      if (!fs.existsSync(this.dir)) fs.mkdirSync(this.dir, { recursive: true });
      fs.appendFileSync(this.activePath(), line, 'utf8');
      this.maybeRotate();
    } catch {
      // Disk error — swallow. The sync must never fail because we couldn't
      // write a log line. Console mirror (above) is the fallback for dev.
    }
  }

  private maybeRotate(): void {
    let size = 0;
    try { size = fs.statSync(this.activePath()).size; } catch { return; }
    if (size < this.maxBytes) return;

    try {
      // Drop the oldest rotation that would fall off the end.
      const oldest = this.rotatedPath(this.maxFiles);
      if (fs.existsSync(oldest)) {
        try { fs.unlinkSync(oldest); } catch { /* ignore */ }
      }
      // Shift .N-1 → .N, .N-2 → .N-1, ..., .1 → .2
      for (let i = this.maxFiles - 1; i >= 1; i -= 1) {
        const src = this.rotatedPath(i);
        const dst = this.rotatedPath(i + 1);
        if (fs.existsSync(src)) {
          try { fs.renameSync(src, dst); } catch { /* ignore */ }
        }
      }
      // Finally, active → .1 and let the next write create a fresh active file.
      try { fs.renameSync(this.activePath(), this.rotatedPath(1)); } catch { /* ignore */ }
    } catch {
      // Rotation is best-effort. If it fails we'll just exceed maxBytes a bit.
    }
  }
}

/**
 * Stringify an Error (or anything) into a loggable shape. Keeps the message
 * + name + stack but avoids crashing on circular / non-error values.
 */
export function errCtx(err: unknown): Record<string, unknown> {
  if (err instanceof Error) {
    return { err: err.message, errName: err.name, stack: err.stack };
  }
  try {
    return { err: String(err) };
  } catch {
    return { err: '[unstringifiable]' };
  }
}
