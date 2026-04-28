// ─────────────────────────────────────────────────────────────────────────────
// Client-side role helpers.
//
// Single source of truth for "can this user do X?" on the client. Every page
// that needs to render read-only mode, hide buttons, or gate a route should
// import from here rather than re-reading `localStorage.getItem('user_role')`
// inline — that way when we add a new role we only have to touch this file.
//
// IMPORTANT: these are UX helpers only. The server enforces every gate via
// requireRole / canWriteForecast / canWriteVcfo / canApproveAccountingTask
// middleware — the localStorage values here can be tampered with, and that's
// fine because a tampered value just changes the UI, not the server's rules.
// ─────────────────────────────────────────────────────────────────────────────

export type ClientRole = 'admin' | 'operational_head' | 'accountant' | 'user';
export type UserType = 'super_admin' | 'client_user';

export const CLIENT_ROLE_LABELS: Record<ClientRole, string> = {
  admin: 'Admin',
  operational_head: 'Operational Head',
  accountant: 'Accountant',
  user: 'Regular User',
};

export function getUserRole(): string {
  if (typeof window === 'undefined') return '';
  return localStorage.getItem('user_role') || '';
}

export function getUserType(): string {
  if (typeof window === 'undefined') return '';
  return localStorage.getItem('user_type') || '';
}

export function isSuperAdmin(): boolean {
  return getUserType() === 'super_admin';
}

export function isClientAdmin(): boolean {
  // Tenant admin (CFO). Does NOT include super_admin — use isSuperAdmin() or
  // canApproveAccountingTask() if that's what you mean.
  return getUserRole() === 'admin';
}

// ── Forecast gates ─────────────────────────────────────────────────────────

export function canWriteForecast(): boolean {
  if (isSuperAdmin()) return true;
  const r = getUserRole();
  return r === 'admin' || r === 'operational_head';
}

export function canSeeForecast(): boolean {
  // Every authenticated user can see forecast data (at minimum read-only).
  // Module-level access is gated separately by the `forecast_ops` module key.
  return true;
}

// ── VCFO gates ─────────────────────────────────────────────────────────────

export function canSeeVcfo(): boolean {
  if (isSuperAdmin()) return true;
  const r = getUserRole();
  // operational_head and 'user' have no VCFO visibility at all.
  return r === 'admin' || r === 'accountant';
}

export function canWriteVcfo(): boolean {
  if (isSuperAdmin()) return true;
  const r = getUserRole();
  return r === 'admin' || r === 'accountant';
}

/**
 * Maker-checker: only admin (CFO) / super_admin can approve or reject
 * accounting tasks. Accountants are the "maker" — they submit for approval.
 */
export function canApproveAccountingTask(): boolean {
  if (isSuperAdmin()) return true;
  return getUserRole() === 'admin';
}

// ── Revenue Sharing gate ───────────────────────────────────────────────────

/**
 * Revenue Sharing rules drive doctor payouts — only admin (CFO/owner) can
 * edit them. Operational heads, accountants, and regular users see the
 * config in read-only mode. Server enforces the same via
 * requireRole('admin') on all mutation routes in revenue-sharing.ts.
 */
export function canEditRevenueSharing(): boolean {
  if (isSuperAdmin()) return true;
  return getUserRole() === 'admin';
}

// ── Destructive actions ────────────────────────────────────────────────────

/**
 * Wiping the synced Tally snapshot (DELETE /api/vcfo/data) stays admin-only
 * even for accountants. The server also enforces this.
 */
export function canWipeVcfoData(): boolean {
  if (isSuperAdmin()) return true;
  return getUserRole() === 'admin';
}
