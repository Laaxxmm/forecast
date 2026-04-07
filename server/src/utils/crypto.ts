import crypto from 'crypto';

const ALGORITHM = 'aes-256-gcm';
const SECRET = process.env.SESSION_SECRET || 'magna-tracker-secret-2025';

function deriveKey(): Buffer {
  return crypto.scryptSync(SECRET, 'magna-tracker-salt', 32);
}

export function encrypt(plaintext: string): string {
  const key = deriveKey();
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  let encrypted = cipher.update(plaintext, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  const tag = cipher.getAuthTag().toString('hex');
  return `${iv.toString('hex')}:${tag}:${encrypted}`;
}

export function decrypt(ciphertext: string): string {
  const [ivHex, tagHex, encrypted] = ciphertext.split(':');
  const key = deriveKey();
  const iv = Buffer.from(ivHex, 'hex');
  const tag = Buffer.from(tagHex, 'hex');
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);
  let decrypted = decipher.update(encrypted, 'hex', 'utf8');
  decrypted += decipher.final('utf8');
  return decrypted;
}
