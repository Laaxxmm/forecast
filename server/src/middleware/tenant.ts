import { Request, Response, NextFunction } from 'express';
import { getClientHelper } from '../db/connection.js';
import { getPlatformHelper } from '../db/platform-connection.js';

/**
 * Middleware that resolves the tenant (client) DB based on auth context.
 *
 * - Client users: automatically use their assigned client DB
 * - Super admins: must specify client via X-Client-Slug header or ?client= query param
 *
 * Attaches `req.tenantDb` and `req.tenantSlug` for downstream route handlers.
 */
export async function resolveTenant(req: Request, res: Response, next: NextFunction) {
  try {
    let slug: string | undefined;

    if (req.userType === 'client_user') {
      // Client user: use their assigned client
      slug = req.tenantSlug;
    } else if (req.userType === 'super_admin') {
      // Super admin: get client from header or query
      slug = (req.headers['x-client-slug'] as string) || (req.query.client as string) || req.tenantSlug;
    }

    if (!slug) {
      return res.status(400).json({
        error: 'Client context required. Set X-Client-Slug header or ?client= query parameter.',
      });
    }

    // Validate slug format to prevent path traversal
    if (!/^[a-z0-9-]+$/.test(slug)) {
      return res.status(400).json({ error: 'Invalid client slug format' });
    }

    // Validate client exists and is active
    const platformDb = await getPlatformHelper();
    const client = platformDb.get(
      'SELECT id, slug, name, is_active FROM clients WHERE slug = ?',
      slug
    );

    if (!client) {
      return res.status(404).json({ error: `Client "${slug}" not found` });
    }

    if (!client.is_active) {
      return res.status(403).json({ error: `Client "${slug}" is deactivated` });
    }

    // Load the client's database
    req.tenantSlug = slug;
    req.clientId = client.id;
    req.clientName = client.name;
    req.tenantDb = await getClientHelper(slug);

    next();
  } catch (err: any) {
    console.error('[Tenant Middleware] Error:', err.message);
    res.status(500).json({ error: 'Failed to resolve client context' });
  }
}
