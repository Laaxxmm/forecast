/**
 * VCFO Company Resolver — Ported from TallyVision server.js (lines 233-304)
 * Resolves company IDs from geographic filters, group membership, and request params.
 * All table names use vcfo_ prefix for Vision's unified tenant DB.
 */

import { DbHelper } from '../../db/connection.js';

/** Build SQL placeholder string for an array of IDs: [1,2,3] → "?,?,?" */
export function idPh(ids: number[]): string {
  return ids.map(() => '?').join(',');
}

/**
 * Resolve company IDs from geographic filters.
 * Any omitted/empty filter is treated as "All" for that dimension.
 */
export function resolveCompanyIds(
  db: DbHelper,
  state?: string,
  city?: string,
  location?: string,
  type?: string,
  allowedIds?: number[] | null
): number[] {
  let q = 'SELECT id FROM vcfo_companies WHERE is_active = 1';
  const params: any[] = [];
  if (allowedIds?.length) {
    q += ` AND id IN (${allowedIds.map(() => '?').join(',')})`;
    params.push(...allowedIds);
  }
  if (state)    { q += ' AND state = ?';       params.push(state); }
  if (city)     { q += ' AND city = ?';        params.push(city); }
  if (location) { q += ' AND location = ?';    params.push(location); }
  if (type && type !== 'All') { q += ' AND entity_type = ?'; params.push(type); }
  return db.all(q, ...params).map((r: any) => r.id);
}

/**
 * Resolve active company IDs belonging to a group.
 */
export function resolveGroupMemberIds(db: DbHelper, groupId: number): number[] | null {
  const rows = db.all(
    `SELECT cgm.company_id FROM vcfo_company_group_members cgm
     JOIN vcfo_companies c ON c.id = cgm.company_id
     WHERE cgm.group_id = ? AND c.is_active = 1`,
    groupId
  );
  return rows.length ? rows.map((r: any) => r.company_id) : null;
}

/**
 * Extract array of company IDs from a request.
 * Priority: groupId (+ optional geo intersection) > companyIds (CSV) > companyId > geographic filters
 * Returns null if no usable filter found.
 */
export function resolveIds(db: DbHelper, query: any): number[] | null {
  const { groupId, companyId, companyIds, state, city, location, type } = query;

  let ids: number[] | null = null;
  if (groupId) {
    const groupMemberIds = resolveGroupMemberIds(db, Number(groupId));
    if (!groupMemberIds) return null;
    const hasActiveGeoFilter = (state && state !== '') || (city && city !== '') ||
      (location && location !== '') || (type && type !== 'All' && type !== '');
    if (hasActiveGeoFilter) {
      const filtered = resolveCompanyIds(db, state || '', city || '', location || '', type || 'All', groupMemberIds);
      ids = filtered.length ? filtered : [-1];
    } else {
      ids = groupMemberIds;
    }
  } else if (companyIds) {
    ids = String(companyIds).split(',').map(Number).filter(Boolean);
  } else if (companyId) {
    ids = [Number(companyId)];
  } else if (state !== undefined || city !== undefined || location !== undefined || type !== undefined) {
    const resolved = resolveCompanyIds(db, state || '', city || '', location || '', type || 'All');
    ids = resolved.length ? resolved : null;
  }

  return ids;
}

/**
 * Build a human-readable filter label from geo query params
 */
export function buildFilterLabel(query: any): string {
  const parts: string[] = [];
  if (query.state) parts.push(query.state);
  if (query.city) parts.push(query.city);
  if (query.location) parts.push(query.location);
  if (query.type && query.type !== 'All') parts.push(query.type);
  return parts.join(' › ');
}

// ── Date helpers ──

export function startOfMonth(dateStr: string): string {
  const d = new Date(dateStr + 'T00:00:00');
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`;
}

export function endOfMonth(dateStr: string): string {
  const d = new Date(dateStr + 'T00:00:00');
  const last = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(last).padStart(2, '0')}`;
}

export function subtractMonth(dateStr: string, n: number): string {
  const [y, m] = dateStr.split('-').map(Number);
  let nm = m - n;
  let ny = y;
  while (nm < 1) { nm += 12; ny--; }
  while (nm > 12) { nm -= 12; ny++; }
  return `${ny}-${String(nm).padStart(2, '0')}-01`;
}

export function subtractYear(dateStr: string, n: number): string {
  const [y, m, d] = dateStr.split('-');
  return `${Number(y) - n}-${m}-${d}`;
}

export function getYTDStart(dateStr: string): string {
  const d = new Date(dateStr + 'T00:00:00');
  const m = d.getMonth(); // 0-based
  const y = m >= 3 ? d.getFullYear() : d.getFullYear() - 1; // FY starts April
  return `${y}-04-01`;
}

export function monthLabel(dateStr: string): string {
  const d = new Date(dateStr + 'T00:00:00');
  return d.toLocaleDateString('en-IN', { month: 'short', year: 'numeric' });
}

/** Get VCFO app setting */
export function getSetting(db: DbHelper, key: string): string | null {
  const row: any = db.get('SELECT value FROM vcfo_app_settings WHERE key = ?', key);
  return row ? row.value : null;
}

/** Set VCFO app setting */
export function setSetting(db: DbHelper, key: string, value: string): void {
  db.run('INSERT OR REPLACE INTO vcfo_app_settings (key, value, updated_at) VALUES (?, ?, ?)',
    key, value, new Date().toISOString());
}

/** Format number as INR */
export function fmtINR(num: number): string {
  if (num == null || isNaN(num)) return '₹0';
  const abs = Math.abs(num);
  const sign = num < 0 ? '-' : '';
  if (abs >= 10000000) return `${sign}₹${(abs / 10000000).toFixed(2)} Cr`;
  if (abs >= 100000) return `${sign}₹${(abs / 100000).toFixed(2)} L`;
  if (abs >= 1000) return `${sign}₹${(abs / 1000).toFixed(1)} K`;
  return `${sign}₹${abs.toFixed(0)}`;
}

export function fmtLakhs(num: number): string {
  if (num == null || isNaN(num)) return '0';
  return (num / 100000).toFixed(2);
}
