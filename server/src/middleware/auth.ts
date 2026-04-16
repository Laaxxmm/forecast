import { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import { DbHelper } from '../db/connection.js';
import { getPlatformHelper } from '../db/platform-connection.js';

declare module 'express-session' {
  interface SessionData {
    userId: number;
    username: string;
    displayName: string;
    role: string;
  }
}

// Extend Express Request to carry tenant context
declare global {
  namespace Express {
    interface Request {
      tenantSlug?: string;
      tenantDb?: DbHelper;
      userType?: 'super_admin' | 'client_user';
      isOwner?: boolean;
      clientId?: number;
      clientName?: string;
    }
  }
}

export interface TokenData {
  userId: number;
  username: string;
  displayName: string;
  role: string;
  userType: 'super_admin' | 'client_user';
  isOwner?: boolean;
  clientSlug?: string;
  clientId?: number;
  clientName?: string;
  expiresAt: number;
}

// Simple token store (in-memory, survives for the lifetime of the process)
const tokenStore = new Map<string, TokenData>();

// Proactively clean up expired tokens every 15 minutes
const tokenCleanupInterval = setInterval(() => {
  const now = Date.now();
  for (const [token, data] of tokenStore) {
    if (data.expiresAt < now) tokenStore.delete(token);
  }
}, 15 * 60 * 1000);
tokenCleanupInterval.unref();

export function createToken(user: {
  id: number;
  username: string;
  display_name: string;
  role: string;
  userType: 'super_admin' | 'client_user';
  isOwner?: boolean;
  clientSlug?: string;
  clientId?: number;
  clientName?: string;
}): string {
  const token = crypto.randomBytes(32).toString('hex');
  tokenStore.set(token, {
    userId: user.id,
    username: user.username,
    displayName: user.display_name,
    role: user.role,
    userType: user.userType,
    isOwner: user.isOwner,
    clientSlug: user.clientSlug,
    clientId: user.clientId,
    clientName: user.clientName,
    expiresAt: Date.now() + 24 * 60 * 60 * 1000, // 24 hours
  });
  return token;
}

export function removeToken(token: string) {
  tokenStore.delete(token);
}

export function getTokenData(token: string): TokenData | null {
  const data = tokenStore.get(token);
  if (data && data.expiresAt > Date.now()) return data;
  if (data) tokenStore.delete(token); // Clean up expired
  return null;
}

export async function requireAuth(req: Request, res: Response, next: NextFunction) {
  // Try Bearer token first (production cross-origin)
  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith('Bearer ')) {
    const token = authHeader.slice(7);
    const data = getTokenData(token);
    if (data) {
      // Re-validate that the user is still active
      const platformDb = await getPlatformHelper();
      if (data.userType === 'super_admin') {
        const user = platformDb.get('SELECT is_active FROM team_members WHERE id = ?', data.userId);
        if (!user?.is_active) {
          tokenStore.delete(token);
          return res.status(401).json({ error: 'Account has been deactivated' });
        }
      } else {
        const user = platformDb.get('SELECT is_active FROM client_users WHERE id = ?', data.userId);
        if (!user?.is_active) {
          tokenStore.delete(token);
          return res.status(401).json({ error: 'Account has been deactivated' });
        }
      }

      // Attach user + tenant info to request
      req.session.userId = data.userId;
      req.session.username = data.username;
      req.session.displayName = data.displayName;
      req.session.role = data.role;
      req.userType = data.userType;
      req.isOwner = data.isOwner;
      req.clientId = data.clientId;
      req.tenantSlug = data.clientSlug;
      req.clientName = data.clientName;
      return next();
    }
  }

  // Try session (local dev)
  if (req.session?.userId) {
    return next();
  }

  res.status(401).json({ error: 'Authentication required' });
}

export function requireSuperAdmin(req: Request, res: Response, next: NextFunction) {
  if (req.userType !== 'super_admin') {
    return res.status(403).json({ error: 'Super admin access required' });
  }
  next();
}

export function requireAdmin(req: Request, res: Response, next: NextFunction) {
  // Super admins always have access
  if (req.userType === 'super_admin') {
    return next();
  }

  // Client users must have admin role
  if (req.session?.role === 'admin') {
    return next();
  }

  return res.status(403).json({ error: 'Admin access required' });
}

/**
 * Middleware factory: require a specific module to be enabled for the client.
 * Super admins bypass module checks.
 */
export function requireModule(moduleKey: string) {
  return async (req: Request, res: Response, next: NextFunction) => {
    if (req.userType === 'super_admin') return next();

    const clientId = req.clientId;
    if (!clientId) return res.status(400).json({ error: 'Client context required' });

    const platformDb = await getPlatformHelper();
    const mod = platformDb.get(
      'SELECT is_enabled FROM client_modules WHERE client_id = ? AND module_key = ?',
      [clientId, moduleKey]
    );

    if (!mod?.is_enabled) {
      return res.status(403).json({ error: `Module "${moduleKey}" is not enabled for this client` });
    }

    next();
  };
}

/**
 * Middleware factory: require a specific integration to be enabled for the client.
 * Super admins bypass integration checks.
 */
export function requireIntegration(integrationKey: string) {
  return async (req: Request, res: Response, next: NextFunction) => {
    if (req.userType === 'super_admin') return next();

    const clientId = req.clientId;
    if (!clientId) return res.status(400).json({ error: 'Client context required' });

    const platformDb = await getPlatformHelper();
    const integration = platformDb.get(
      'SELECT is_enabled FROM client_integrations WHERE client_id = ? AND integration_key = ?',
      [clientId, integrationKey]
    );

    if (!integration?.is_enabled) {
      return res.status(403).json({ error: `Integration "${integrationKey}" is not enabled for this client` });
    }

    next();
  };
}

/**
 * Validate password meets minimum complexity requirements.
 * Returns null if valid, or an error message string if invalid.
 */
export function validatePassword(password: string): string | null {
  if (!password || password.length < 8) {
    return 'Password must be at least 8 characters long';
  }
  if (password.length > 128) {
    return 'Password must not exceed 128 characters';
  }
  if (!/[a-zA-Z]/.test(password)) {
    return 'Password must contain at least one letter';
  }
  if (!/[0-9]/.test(password)) {
    return 'Password must contain at least one number';
  }
  return null;
}
