// ─────────────────────────────────────────────────────────────────────────────
// ApiClient — HTTP client the agent uses to talk to the VCFO server.
// Thin wrapper around fetch so the main process can swap transports later
// (retry, exponential backoff, offline queue) without touching callers.
// ─────────────────────────────────────────────────────────────────────────────

import type { TallyStatus } from './types';
import type {
  CompanyRow,
  LedgerRow,
  VoucherRow,
  GroupRow,
  StockSummaryRow,
} from './tally/extractors';

export interface IngestPingPayload {
  clientSlug: string;
  agentVersion: string;
  tally: TallyStatus;
}

export interface IngestPingResponse {
  ok: boolean;
  rowsAccepted?: number;
  message?: string;
}

export type IngestKind =
  | 'companies'
  | 'ledgers'
  | 'vouchers'
  | 'groups'
  | 'stockSummary';

export interface IngestBatchPayload {
  kind: IngestKind;
  /** Required for every kind except 'companies'. */
  companyName?: string;
  rows:
    | CompanyRow[]
    | LedgerRow[]
    | VoucherRow[]
    | GroupRow[]
    | StockSummaryRow[];
  /**
   * Slice 3 multi-client tagging. Filled in by the sync loop (or by the
   * queue drainer) so replayed payloads can be routed back to the correct
   * per-client ApiClient (one agent install syncs several tenants in the
   * same tick). Not sent over the wire — stripped before fetch in
   * ApiClient.ingestBatch.
   */
  clientSlug?: string;
}

export interface IngestBatchResponse {
  ok: boolean;
  kind: IngestKind;
  companyName?: string;
  rowsReceived: number;
  rowsAccepted: number;
  serverTime: string;
}

export class ApiClient {
  constructor(private readonly baseUrl: string, private readonly apiKey: string) {}

  private url(path: string): string {
    const base = this.baseUrl.replace(/\/+$/, '');
    const suffix = path.startsWith('/') ? path : `/${path}`;
    return `${base}${suffix}`;
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = {
      'Content-Type': 'application/json',
      'User-Agent': 'vcfo-sync-agent/0.2.0',
    };
    if (this.apiKey) h['Authorization'] = `Bearer ${this.apiKey}`;
    return h;
  }

  /** Lightweight reachability probe — hits the main app's health endpoint. */
  async ping(): Promise<boolean> {
    try {
      // Post-cutover: no more /vcfo/api/status (TallyVision retired). The
      // ingest/ping round-trip below is the real reachability test; this
      // simpler probe just confirms the server is up and reachable.
      const res = await fetch(this.url('/api/ingest/ping'), {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify({ agentVersion: '0.2.0', probe: true }),
      });
      // 401 means reachable but not yet authed, which is still "online".
      return res.ok || res.status === 401;
    } catch {
      return false;
    }
  }

  /** Milestone 1 handshake: tells the server this agent is alive. */
  async ingestPing(payload: IngestPingPayload): Promise<IngestPingResponse> {
    // Post-cutover path: /api/ingest/ping (was /vcfo/api/ingest/ping).
    const res = await fetch(this.url('/api/ingest/ping'), {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Server rejected ingest/ping (${res.status}): ${text.slice(0, 200)}`);
    }
    return (await res.json()) as IngestPingResponse;
  }

  /**
   * Push a batch of masters or vouchers. Idempotent on the server side —
   * re-pushing the same window collapses via UNIQUE constraints.
   *
   * The `clientSlug` field on the payload is agent-internal routing only and
   * is stripped before serialization — the server identifies the tenant from
   * the Bearer key on the Authorization header.
   */
  async ingestBatch(payload: IngestBatchPayload): Promise<IngestBatchResponse> {
    const { clientSlug: _unused, ...wire } = payload;
    void _unused;
    // Post-cutover path: /api/ingest/batch (was /vcfo/api/ingest/batch).
    const res = await fetch(this.url('/api/ingest/batch'), {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(wire),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Server rejected ingest/batch ${payload.kind} (${res.status}): ${text.slice(0, 200)}`);
    }
    return (await res.json()) as IngestBatchResponse;
  }
}
