import multer from 'multer';
import path from 'path';
import fs from 'fs';

const isProd = process.env.NODE_ENV === 'production';
const dataDir = process.env.DATA_DIR || (isProd ? '/data' : path.join(__dirname, '..', '..', '..'));
const uploadDir = path.join(dataDir, 'uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, uploadDir),
  filename: (_req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1e9);
    cb(null, uniqueSuffix + path.extname(file.originalname));
  },
});

export const upload = multer({
  storage,
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (ext === '.xlsx' || ext === '.xls' || ext === '.csv') {
      cb(null, true);
    } else {
      cb(new Error('Only Excel or CSV files (.xlsx, .xls, .csv) are allowed'));
    }
  },
  limits: { fileSize: 50 * 1024 * 1024 },
});

// ─── Logo upload ────────────────────────────────────────────────────
const logosDir = path.join(dataDir, 'logos');
const clientLogosDir = path.join(logosDir, 'clients');
if (!fs.existsSync(logosDir)) fs.mkdirSync(logosDir, { recursive: true });
if (!fs.existsSync(clientLogosDir)) fs.mkdirSync(clientLogosDir, { recursive: true });

const logoStorage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, logosDir),
  filename: (_req, file, cb) => {
    cb(null, `temp-${Date.now()}${path.extname(file.originalname).toLowerCase()}`);
  },
});

export const logoUpload = multer({
  storage: logoStorage,
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (['.png', '.jpg', '.jpeg', '.webp', '.ico'].includes(ext)) {
      cb(null, true);
    } else {
      cb(new Error('Only image files (PNG, JPG, WebP, ICO) are allowed'));
    }
  },
  limits: { fileSize: 5 * 1024 * 1024 },
});

export function getLogosDir(): string { return logosDir; }
export function getClientLogosDir(): string { return clientLogosDir; }

// ─── VCFO accounting-task files ──────────────────────────────────────────────
// Tenant-namespaced disk layout:
//   {DATA_DIR}/uploads/vcfo_accounting/<tenant-slug>/<timestamp-rand>.<ext>
// The namespace prevents a buggy task-id lookup from leaking files across
// tenants — the directory simply won't contain the other tenant's files.
const taskFilesDir = path.join(dataDir, 'uploads', 'vcfo_accounting');
if (!fs.existsSync(taskFilesDir)) fs.mkdirSync(taskFilesDir, { recursive: true });

const taskFileStorage = multer.diskStorage({
  destination: (req, _file, cb) => {
    const slug = (req as any).tenantSlug || '_unknown';
    const tenantDir = path.join(taskFilesDir, slug);
    if (!fs.existsSync(tenantDir)) fs.mkdirSync(tenantDir, { recursive: true });
    cb(null, tenantDir);
  },
  filename: (_req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1e9);
    cb(null, uniqueSuffix + path.extname(file.originalname).toLowerCase());
  },
});

export const taskFileUpload = multer({
  storage: taskFileStorage,
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    const allowed = ['.xlsx', '.xls', '.csv', '.pdf', '.png', '.jpg', '.jpeg', '.webp', '.docx', '.doc'];
    if (allowed.includes(ext)) {
      cb(null, true);
    } else {
      cb(new Error(`File type ${ext} not allowed. Allowed: ${allowed.join(', ')}`));
    }
  },
  limits: { fileSize: 25 * 1024 * 1024 },  // 25 MB
});

export function getTaskFilesDir(): string { return taskFilesDir; }
