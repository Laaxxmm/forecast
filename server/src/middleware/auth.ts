import { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';

declare module 'express-session' {
  interface SessionData {
    userId: number;
    username: string;
    displayName: string;
    role: string;
  }
}

// Simple token store (in-memory, survives for the lifetime of the process)
const tokenStore = new Map<string, { userId: number; username: string; displayName: string; role: string; expiresAt: number }>();

export function createToken(user: { id: number; username: string; display_name: string; role: string }): string {
  const token = crypto.randomBytes(32).toString('hex');
  tokenStore.set(token, {
    userId: user.id,
    username: user.username,
    displayName: user.display_name,
    role: user.role,
    expiresAt: Date.now() + 24 * 60 * 60 * 1000, // 24 hours
  });
  return token;
}

export function removeToken(token: string) {
  tokenStore.delete(token);
}

export function getTokenData(token: string) {
  const data = tokenStore.get(token);
  if (data && data.expiresAt > Date.now()) return data;
  return null;
}

export function requireAuth(req: Request, res: Response, next: NextFunction) {
  // Try session first (local dev)
  if (req.session?.userId) {
    return next();
  }

  // Try Bearer token (production cross-origin)
  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith('Bearer ')) {
    const token = authHeader.slice(7);
    const data = tokenStore.get(token);
    if (data && data.expiresAt > Date.now()) {
      // Attach user info to request session for downstream use
      req.session.userId = data.userId;
      req.session.username = data.username;
      req.session.displayName = data.displayName;
      req.session.role = data.role;
      return next();
    }
  }

  res.status(401).json({ error: 'Authentication required' });
}
