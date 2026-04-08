import { Request, Response, NextFunction } from 'express';
import { getPlatformHelper } from '../db/platform-connection.js';

// Extend Express Request with branch context
declare global {
  namespace Express {
    interface Request {
      branchId?: number | null;
      branchMode?: 'single' | 'specific' | 'consolidated';
      allowedBranchIds?: number[];
      isMultiBranch?: boolean;
    }
  }
}

/**
 * Middleware that resolves branch context for multi-branch clients.
 * Runs AFTER resolveTenant (requires req.clientId to be set).
 *
 * Reads X-Branch-Id header (or ?branch= query param):
 *   - absent or "all" → consolidated view (all branches user can access)
 *   - numeric id → specific branch
 *
 * For single-branch clients, sets branchMode='single' and skips all filtering.
 */
export async function resolveBranch(req: Request, res: Response, next: NextFunction) {
  try {
    const platformDb = await getPlatformHelper();

    // Check if client is multi-branch
    const client = platformDb.get(
      'SELECT is_multi_branch FROM clients WHERE id = ?',
      req.clientId
    );

    if (!client || !client.is_multi_branch) {
      // Single-branch client — no branch filtering needed
      req.isMultiBranch = false;
      req.branchMode = 'single';
      req.branchId = null;
      req.allowedBranchIds = [];
      return next();
    }

    req.isMultiBranch = true;

    // Determine which branches this user can access
    let allowedBranchIds: number[] = [];
    let canViewAllConsolidated = false;

    if (req.userType === 'super_admin' || req.session?.role === 'admin') {
      // Super admins and client admins can access all branches
      const allBranches = platformDb.all(
        'SELECT id FROM branches WHERE client_id = ? AND is_active = 1',
        req.clientId
      );
      allowedBranchIds = allBranches.map((b: any) => b.id);
      canViewAllConsolidated = true;
    } else {
      // Regular users — check user_branch_access
      const userId = req.session?.userId;
      if (userId) {
        const access = platformDb.all(
          `SELECT uba.branch_id, uba.can_view_consolidated, b.is_active
           FROM user_branch_access uba
           JOIN branches b ON uba.branch_id = b.id
           WHERE uba.user_id = ? AND b.client_id = ? AND b.is_active = 1`,
          userId, req.clientId
        );
        allowedBranchIds = access.map((a: any) => a.branch_id);
        canViewAllConsolidated = access.some((a: any) => a.can_view_consolidated);
      }
    }

    req.allowedBranchIds = allowedBranchIds;

    // Read branch selection from header or query
    const branchHeader = (req.headers['x-branch-id'] as string) || (req.query.branch as string);

    if (!branchHeader || branchHeader === 'all') {
      // Consolidated view
      if (canViewAllConsolidated && (req.userType === 'super_admin' || req.session?.role === 'admin')) {
        // Only admins/super_admins get all branches — regular users keep their assigned branches
        const allBranches = platformDb.all(
          'SELECT id FROM branches WHERE client_id = ? AND is_active = 1',
          req.clientId
        );
        req.allowedBranchIds = allBranches.map((b: any) => b.id);
      }
      req.branchMode = 'consolidated';
      req.branchId = null;
    } else {
      // Specific branch requested
      const branchId = parseInt(branchHeader);
      if (isNaN(branchId)) {
        return res.status(400).json({ error: 'Invalid branch ID' });
      }

      // Verify access
      if (!allowedBranchIds.includes(branchId)) {
        return res.status(403).json({ error: 'Access denied to this branch' });
      }

      req.branchMode = 'specific';
      req.branchId = branchId;
    }

    next();
  } catch (err: any) {
    console.error('[Branch Middleware] Error:', err.message);
    res.status(500).json({ error: 'Failed to resolve branch context' });
  }
}
