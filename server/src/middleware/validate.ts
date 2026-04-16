/**
 * Lightweight input validation helpers.
 * No external dependencies — keeps the bundle small.
 */

/** Coerce to integer, return null if invalid */
export function toInt(val: any): number | null {
  if (val === undefined || val === null || val === '') return null;
  const n = Number(val);
  return Number.isInteger(n) ? n : null;
}

/** Require integer from value, throw 400-friendly message if invalid */
export function requireInt(val: any, fieldName: string): number {
  const n = toInt(val);
  if (n === null) throw new ValidationError(`${fieldName} must be a valid integer`);
  return n;
}

/** Require non-empty trimmed string with max length */
export function requireString(val: any, fieldName: string, maxLen = 500): string {
  if (typeof val !== 'string' || val.trim().length === 0) {
    throw new ValidationError(`${fieldName} is required`);
  }
  const trimmed = val.trim();
  if (trimmed.length > maxLen) {
    throw new ValidationError(`${fieldName} must not exceed ${maxLen} characters`);
  }
  return trimmed;
}

/** Optional string with max length (returns undefined if empty/missing) */
export function optionalString(val: any, fieldName: string, maxLen = 500): string | undefined {
  if (val === undefined || val === null || val === '') return undefined;
  if (typeof val !== 'string') throw new ValidationError(`${fieldName} must be a string`);
  const trimmed = val.trim();
  if (trimmed.length > maxLen) {
    throw new ValidationError(`${fieldName} must not exceed ${maxLen} characters`);
  }
  return trimmed.length > 0 ? trimmed : undefined;
}

/** Require a finite number (for amounts, percentages, etc.) */
export function requireNumber(val: any, fieldName: string): number {
  const n = Number(val);
  if (!Number.isFinite(n)) throw new ValidationError(`${fieldName} must be a valid number`);
  return n;
}

/** Optional number */
export function optionalNumber(val: any, fieldName: string): number | undefined {
  if (val === undefined || val === null || val === '') return undefined;
  return requireNumber(val, fieldName);
}

/** Validate month format YYYY-MM */
export function requireMonth(val: any, fieldName: string): string {
  const s = requireString(val, fieldName, 7);
  if (!/^\d{4}-\d{2}$/.test(s)) throw new ValidationError(`${fieldName} must be in YYYY-MM format`);
  return s;
}

/** Custom validation error that routes can catch and return 400 */
export class ValidationError extends Error {
  status = 400;
  constructor(message: string) {
    super(message);
    this.name = 'ValidationError';
  }
}

/** Express error-handling middleware for validation errors */
import type { Request, Response, NextFunction } from 'express';
export function validationErrorHandler(err: any, _req: Request, res: Response, next: NextFunction) {
  if (err instanceof ValidationError) {
    return res.status(400).json({ error: err.message });
  }
  next(err);
}
