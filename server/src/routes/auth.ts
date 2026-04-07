import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { getHelper } from '../db/connection.js';
import { createToken, removeToken } from '../middleware/auth.js';

const router = Router();

router.post('/login', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password required' });
  }

  const db = await getHelper();
  const user = db.get('SELECT * FROM users WHERE username = ?', username);
  if (!user) return res.status(401).json({ error: 'Invalid credentials' });

  const valid = await bcrypt.compare(password, user.password_hash);
  if (!valid) return res.status(401).json({ error: 'Invalid credentials' });

  // Set session (local dev)
  req.session.userId = user.id;
  req.session.username = user.username;
  req.session.displayName = user.display_name;
  req.session.role = user.role;

  // Create token (production cross-origin)
  const token = createToken(user);

  res.json({ id: user.id, username: user.username, displayName: user.display_name, role: user.role, token });
});

router.post('/logout', (req, res) => {
  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith('Bearer ')) {
    removeToken(authHeader.slice(7));
  }
  req.session.destroy(() => res.json({ ok: true }));
});

router.get('/me', (req, res) => {
  // Check session (local dev)
  if (req.session?.userId) {
    return res.json({ id: req.session.userId, username: req.session.username, displayName: req.session.displayName, role: req.session.role });
  }

  // Check Bearer token (production cross-origin)
  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith('Bearer ')) {
    const token = authHeader.slice(7);
    // Import tokenStore check inline
    const { getTokenData } = require('../middleware/auth.js');
    const data = getTokenData(token);
    if (data) {
      return res.json({ id: data.userId, username: data.username, displayName: data.displayName, role: data.role });
    }
  }

  res.status(401).json({ error: 'Not authenticated' });
});

export default router;
