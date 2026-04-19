// ─────────────────────────────────────────────────────────────────────────────
// Lightweight registry holding helpers that the TallyVision sub-app exposes on
// its Express app object as `app._vcfo`. The main server stashes them here
// right after mounting `/vcfo`; route handlers pull them back out when they
// need to mint/list/revoke agent-keys without going through the sub-app's
// admin-only HTTP routes.
//
// Why not import directly? TallyVision is a CommonJS module loaded via
// `createRequire`, and its helpers aren't listed in its `module.exports`
// (it exports the Express app). We expose them out-of-band and shuttle them
// through this bridge so route files stay free of sub-app path concerns.
// ─────────────────────────────────────────────────────────────────────────────

export interface AgentKeyCreation {
  id: number;
  plaintext: string;
  prefix: string;
  clientSlug: string;
  label: string;
}

export interface AgentKeyListEntry {
  id: number;
  key_prefix: string;
  client_slug: string;
  label: string;
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
}

export interface VcfoBridge {
  createAgentKey(clientSlug: string, label?: string): AgentKeyCreation;
  listAgentKeys(): AgentKeyListEntry[];
  revokeAgentKey(id: number): boolean;
}

let bridge: VcfoBridge | null = null;

export function setVcfoBridge(b: VcfoBridge | null | undefined): void {
  bridge = b ?? null;
}

export function getVcfoBridge(): VcfoBridge | null {
  return bridge;
}
