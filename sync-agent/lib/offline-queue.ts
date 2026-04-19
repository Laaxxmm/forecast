// ─────────────────────────────────────────────────────────────────────────────
// OfflineQueue — disk-backed FIFO for ingest batches that failed on a
// transient error (server unreachable, 5xx). The main process drains this
// queue at the start of each sync run, BEFORE fresh extraction.
//
// Design notes:
//   • The server side of /api/ingest/batch is idempotent (INSERT OR IGNORE /
//     REPLACE on natural keys), so replaying a queued batch is safe even
//     after a fresh extract has already pushed the same rows.
//   • The queue is bounded. Over cap → oldest items are evicted. This
//     prevents a week-long outage from growing the file without limit.
//   • Items carry an `attempts` counter. After maxAttempts failed flushes
//     we drop the item with a warning — something is structurally wrong
//     with the payload (poisoned data, auth revoked, etc.) and replaying
//     it forever would hammer the server.
//   • Corruption-safe load: if the file is unreadable / malformed, we
//     start with an empty queue. A failed sync shouldn't brick the agent.
// ─────────────────────────────────────────────────────────────────────────────

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { IngestBatchPayload } from './api-client';

export interface OfflineQueueItem {
  payload: IngestBatchPayload;
  /** ISO timestamp of when this item was first queued. */
  enqueuedAt: string;
  /** How many times we've tried to flush this item (starts at 0). */
  attempts: number;
  /** Most recent error message from a failed flush, if any. */
  lastError?: string;
}

export interface OfflineQueueOptions {
  /** Max items to keep. Oldest is evicted on overflow. Default: 50. */
  maxItems?: number;
  /** Max flush attempts per item before dead-lettering. Default: 5. */
  maxAttempts?: number;
}

export class OfflineQueue {
  private items: OfflineQueueItem[] = [];
  private readonly filePath: string;
  private readonly maxItems: number;
  private readonly maxAttempts: number;

  constructor(filePath: string, opts: OfflineQueueOptions = {}) {
    this.filePath = filePath;
    this.maxItems = Math.max(1, opts.maxItems ?? 50);
    this.maxAttempts = Math.max(1, opts.maxAttempts ?? 5);
    this.load();
  }

  /** Reload from disk. Errors (missing file, bad JSON) → empty queue. */
  load(): void {
    try {
      const raw = fs.readFileSync(this.filePath, 'utf8');
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) { this.items = []; return; }
      // Defensive filter: drop items that aren't shaped like OfflineQueueItem.
      this.items = parsed.filter(
        (it: any) =>
          it && typeof it === 'object'
          && it.payload
          && typeof it.enqueuedAt === 'string'
          && typeof it.attempts === 'number',
      );
    } catch {
      this.items = [];
    }
  }

  private save(): void {
    try {
      const dir = path.dirname(this.filePath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(this.filePath, JSON.stringify(this.items, null, 2), 'utf8');
    } catch {
      // Swallow — disk errors shouldn't fail the sync. The next enqueue/
      // dequeue will retry persistence. Worst case: queue is in-memory
      // only until the next successful save.
    }
  }

  size(): number {
    return this.items.length;
  }

  /** Shallow copy of the items (for UI / diagnostics). */
  snapshot(): OfflineQueueItem[] {
    return this.items.map((it) => ({ ...it }));
  }

  /**
   * Append a fresh payload. If the queue is at cap, the oldest item is
   * evicted and its payload identifier logged to the returned info.
   */
  enqueue(payload: IngestBatchPayload): { evicted: OfflineQueueItem | null } {
    const item: OfflineQueueItem = {
      payload,
      enqueuedAt: new Date().toISOString(),
      attempts: 0,
    };
    this.items.push(item);
    let evicted: OfflineQueueItem | null = null;
    while (this.items.length > this.maxItems) {
      const dropped = this.items.shift();
      if (dropped) evicted = dropped;
    }
    this.save();
    return { evicted };
  }

  /** Peek at the oldest queued item (doesn't mutate). */
  peek(): OfflineQueueItem | undefined {
    return this.items[0];
  }

  /**
   * Remove the oldest item (call after a successful flush).
   * Returns the popped item, or undefined if queue was empty.
   */
  pop(): OfflineQueueItem | undefined {
    const head = this.items.shift();
    if (head !== undefined) this.save();
    return head;
  }

  /**
   * Mark the oldest item as having failed one more time. If it has now
   * reached maxAttempts, it is DROPPED (dead-lettered) and the returned
   * `dropped` is true. Otherwise the counter is bumped and the item
   * stays at the head of the queue for the next drain attempt.
   */
  recordFailure(errorMessage: string): { dropped: boolean; item: OfflineQueueItem | undefined } {
    const head = this.items[0];
    if (!head) return { dropped: false, item: undefined };
    head.attempts += 1;
    head.lastError = errorMessage;
    if (head.attempts >= this.maxAttempts) {
      this.items.shift();
      this.save();
      return { dropped: true, item: head };
    }
    this.save();
    return { dropped: false, item: head };
  }

  /** Drop every queued item. Used by config reset / cursor-reset flows. */
  clear(): number {
    const n = this.items.length;
    this.items = [];
    this.save();
    return n;
  }
}

/**
 * Classify whether a thrown error from ApiClient.ingestBatch should be
 * retried (network / 5xx) or dropped (4xx / auth / bad request).
 *
 * ApiClient.ingestBatch throws with messages like:
 *   "Server rejected ingest/batch vouchers (503): <body>"
 *   "Server rejected ingest/batch vouchers (400): Bad Request"
 *   native fetch errors: "fetch failed", "ECONNREFUSED", etc.
 */
export function isRetryableError(err: unknown): boolean {
  const msg = (err instanceof Error ? err.message : String(err)) || '';
  // HTTP status code in the message? Treat 5xx + 408/425/429 as retryable.
  const statusMatch = /\((\d{3})\)/.exec(msg);
  if (statusMatch) {
    const code = parseInt(statusMatch[1], 10);
    if (code >= 500 && code < 600) return true;
    if (code === 408 || code === 425 || code === 429) return true;
    return false; // 4xx other than above → client error, don't retry
  }
  // No status code → likely a network-level failure (DNS, refused, timeout).
  // Be permissive: retry anything that doesn't look like a shape error.
  if (/^(Invalid |Expected |Missing |Unknown kind)/i.test(msg)) return false;
  return true;
}
