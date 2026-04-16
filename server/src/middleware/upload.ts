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
    if (['.png', '.jpg', '.jpeg', '.svg', '.webp', '.ico'].includes(ext)) {
      cb(null, true);
    } else {
      cb(new Error('Only image files (PNG, JPG, SVG, WebP, ICO) are allowed'));
    }
  },
  limits: { fileSize: 5 * 1024 * 1024 },
});

export function getLogosDir(): string { return logosDir; }
export function getClientLogosDir(): string { return clientLogosDir; }
