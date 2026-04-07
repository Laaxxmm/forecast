import { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import { DbHelper } from '../db/connection.js';

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
  clientSlug?: string;
  clientId?: number;
  clientName?: string;
  expiresAt: number;
}

// Simple token store (in-memory, survives for the lifetime of the process)
const tokenStore = new Map<string, TokenData>();

export function createToken(user: {
  id: number;
  username: string;
  display_name: string;
  role: string;
  userType: 'super_admin' | 'client_user';
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

export function requireAuth(req: Request, res: Response, next: NextFunction) {
  // Try Bearer token first (production cross-origin)
  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith('Bearer ')) {
    const token = authHeader.slice(7);
    const data = getTokenData(token);
    if (data) {
      // Attach user + tenant info to request
      req.session.userId = data.userId;
      req.session.username = data.username;
      req.session.displayName = data.displayName;
      req.session.role = data.role;
      req.userType = data.userType;
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
