/**
 * TallyVision - SSO token mint/verify (shared with Magna_Tracker)
 *
 * Magna_Tracker owns authentication. When a user clicks VCFO Portal, the
 * Magna_Tracker frontend asks its backend for a short-lived HMAC-signed
 * token encoding the active client's slug + the user's identity. The
 * browser redirects to `/vcfo/sso?token=<jwt>`; TallyVision's `/sso`
 * handler verifies the signature here, seeds its own session, and sends
 * the user on to `/vcfo/`.
 *
 * Format: `<base64url(payload JSON)>.<base64url(HMAC-SHA256)>`
 *   - simpler than full JWT; we don't need alg negotiation because both
 *     signer and verifier live in the same process.
 *
 * Trust: same Node process, so the HMAC secret is kept in module state.
 * When VCFO_SSO_SECRET isn't set we generate a random secret at boot so
 * dev works without config; tokens minted by one restart won't verify
 * after the next restart (60s expiry makes this a non-issue).
 */

const crypto = require('crypto');

const DEFAULT_TTL_SECONDS = 60;

// Shared in-process secret. Magna_Tracker and TallyVision both require
// this module — they share the same `SECRET` value because Node caches
// module exports by resolved path.
const SECRET = process.env.VCFO_SSO_SECRET || crypto.randomBytes(32).toString('hex');

function base64urlEncode(buf) {
    return Buffer.from(buf)
        .toString('base64')
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/, '');
}

function base64urlDecode(str) {
    const pad = str.length % 4;
    const padded = str.replace(/-/g, '+').replace(/_/g, '/') + (pad ? '='.repeat(4 - pad) : '');
    return Buffer.from(padded, 'base64');
}

/**
 * @param {object} payload - must include at least `slug`. Caller may add
 *   `userId`, `username`, `displayName`, `userType`, `role`, `isOwner`,
 *   `companyIds`, `features`.
 * @param {number} [ttlSec=60]
 */
function sign(payload, ttlSec = DEFAULT_TTL_SECONDS) {
    if (!payload || typeof payload !== 'object') throw new Error('payload required');
    const now = Math.floor(Date.now() / 1000);
    const body = { ...payload, iat: now, exp: now + ttlSec };
    const enc = base64urlEncode(JSON.stringify(body));
    const sig = crypto.createHmac('sha256', SECRET).update(enc).digest();
    return enc + '.' + base64urlEncode(sig);
}

/**
 * Returns the decoded payload on success, or null if the token is
 * malformed, mis-signed, or expired. Never throws.
 */
function verify(token) {
    if (typeof token !== 'string') return null;
    const dot = token.indexOf('.');
    if (dot <= 0 || dot === token.length - 1) return null;
    const enc = token.slice(0, dot);
    const sigEnc = token.slice(dot + 1);

    const expected = crypto.createHmac('sha256', SECRET).update(enc).digest();
    let got;
    try { got = base64urlDecode(sigEnc); } catch { return null; }
    if (expected.length !== got.length) return null;
    if (!crypto.timingSafeEqual(expected, got)) return null;

    let body;
    try { body = JSON.parse(base64urlDecode(enc).toString('utf8')); } catch { return null; }
    if (!body || typeof body !== 'object') return null;
    if (typeof body.exp !== 'number' || body.exp < Math.floor(Date.now() / 1000)) return null;
    if (!body.slug || typeof body.slug !== 'string') return null;

    return body;
}

module.exports = { sign, verify, DEFAULT_TTL_SECONDS };
